#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import http2 from "node:http2";
import net from "node:net";
import readline from "node:readline";
import { DatabaseSync } from "node:sqlite";

const SOCKET_PATH = process.env.SING_BOX_SOCKET || "/run/sing-box.socket";
const CONFIG_HOME = process.env.SING_BOX_CONFIG_DIR
  || join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "sing-box");
const DATABASE_PATH = join(CONFIG_HOME, "settings.db");
const PROFILES_PATH = join(CONFIG_HOME, "profiles");
const CLIENT_BINARY = process.env.SING_BOX_CLIENT_BINARY || "/opt/sing-box/sing-box";

const OWNERSHIP = ["unspecified", "available", "caller", "other"];
const SERVICE_STATUS = ["idle", "starting", "started", "stopping", "fatal"];

function encodeVarint(value) {
  let next = BigInt(value);
  if (next < 0n) next = BigInt.asUintN(64, next);
  const bytes = [];
  do {
    let byte = Number(next & 0x7fn);
    next >>= 7n;
    if (next !== 0n) byte |= 0x80;
    bytes.push(byte);
  } while (next !== 0n);
  return Buffer.from(bytes);
}

function fieldKey(number, wireType) {
  return encodeVarint(BigInt(number * 8 + wireType));
}

function stringField(number, value) {
  const data = Buffer.from(String(value), "utf8");
  return Buffer.concat([fieldKey(number, 2), encodeVarint(data.length), data]);
}

function boolField(number, value) {
  return value ? Buffer.concat([fieldKey(number, 0), Buffer.from([1])]) : Buffer.alloc(0);
}

function intField(number, value) {
  return Buffer.concat([fieldKey(number, 0), encodeVarint(value)]);
}

function messageField(number, value) {
  return Buffer.concat([fieldKey(number, 2), encodeVarint(value.length), value]);
}

function concatFields(...fields) {
  return Buffer.concat(fields.filter((field) => field.length > 0));
}

function readVarint(buffer, start) {
  let value = 0n;
  let shift = 0n;
  let offset = start;
  while (offset < buffer.length && shift < 70n) {
    const byte = buffer[offset++];
    value |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return { value, offset };
    shift += 7n;
  }
  throw new Error("invalid protobuf varint");
}

function parseFields(buffer) {
  const fields = [];
  let offset = 0;
  while (offset < buffer.length) {
    const key = readVarint(buffer, offset);
    offset = key.offset;
    const number = Number(key.value >> 3n);
    const wireType = Number(key.value & 7n);
    if (number === 0) throw new Error("invalid protobuf field number");

    if (wireType === 0) {
      const decoded = readVarint(buffer, offset);
      offset = decoded.offset;
      fields.push({ number, wireType, value: decoded.value });
    } else if (wireType === 1) {
      if (offset + 8 > buffer.length) throw new Error("truncated protobuf fixed64");
      fields.push({ number, wireType, value: buffer.subarray(offset, offset + 8) });
      offset += 8;
    } else if (wireType === 2) {
      const decoded = readVarint(buffer, offset);
      const length = Number(decoded.value);
      offset = decoded.offset;
      if (length < 0 || offset + length > buffer.length) throw new Error("truncated protobuf bytes");
      fields.push({ number, wireType, value: buffer.subarray(offset, offset + length) });
      offset += length;
    } else if (wireType === 5) {
      if (offset + 4 > buffer.length) throw new Error("truncated protobuf fixed32");
      fields.push({ number, wireType, value: buffer.subarray(offset, offset + 4) });
      offset += 4;
    } else {
      throw new Error(`unsupported protobuf wire type: ${wireType}`);
    }
  }
  return fields;
}

function valuesFor(fields, number, wireType = undefined) {
  return fields
    .filter((field) => field.number === number && (wireType === undefined || field.wireType === wireType))
    .map((field) => field.value);
}

function firstString(fields, number, fallback = "") {
  const value = valuesFor(fields, number, 2)[0];
  return value === undefined ? fallback : value.toString("utf8");
}

function firstInt(fields, number, fallback = 0) {
  const value = valuesFor(fields, number, 0)[0];
  return value === undefined ? fallback : Number(value);
}

function decodeDaemonInfo(buffer) {
  const fields = parseFields(buffer);
  const ownershipValue = firstInt(fields, 2, 0);
  return {
    version: firstString(fields, 1),
    ownership: OWNERSHIP[ownershipValue] || "unspecified"
  };
}

function decodeServiceStatus(buffer) {
  const fields = parseFields(buffer);
  const statusValue = firstInt(fields, 1, 0);
  return {
    status: SERVICE_STATUS[statusValue] || "idle",
    errorMessage: firstString(fields, 2)
  };
}

function decodeGroupItem(buffer) {
  const fields = parseFields(buffer);
  return {
    tag: firstString(fields, 1),
    type: firstString(fields, 2),
    urlTestTime: firstInt(fields, 3, 0),
    urlTestDelay: firstInt(fields, 4, 0)
  };
}

function decodeGroup(buffer) {
  const fields = parseFields(buffer);
  return {
    tag: firstString(fields, 1),
    type: firstString(fields, 2),
    selectable: firstInt(fields, 3, 0) !== 0,
    selected: firstString(fields, 4),
    expanded: firstInt(fields, 5, 0) !== 0,
    items: valuesFor(fields, 6, 2).map(decodeGroupItem)
  };
}

function decodeGroups(buffer) {
  return valuesFor(parseFields(buffer), 1, 2).map(decodeGroup);
}

function decodeClashModeStatus(buffer) {
  const fields = parseFields(buffer);
  return {
    modes: valuesFor(fields, 1, 2).map((value) => value.toString("utf8")),
    currentMode: firstString(fields, 2)
  };
}

function decodeClashMode(buffer) {
  return firstString(parseFields(buffer), 3);
}

function grpcFrame(message = Buffer.alloc(0)) {
  const header = Buffer.alloc(5);
  header.writeUInt8(0, 0);
  header.writeUInt32BE(message.length, 1);
  return Buffer.concat([header, message]);
}

class GrpcFrameDecoder {
  constructor() {
    this.buffer = Buffer.alloc(0);
  }

  push(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const messages = [];
    while (this.buffer.length >= 5) {
      if (this.buffer[0] !== 0) throw new Error("compressed gRPC responses are not supported");
      const length = this.buffer.readUInt32BE(1);
      if (this.buffer.length < length + 5) break;
      messages.push(this.buffer.subarray(5, length + 5));
      this.buffer = this.buffer.subarray(length + 5);
    }
    return messages;
  }
}

function grpcError(status, encodedMessage) {
  let message = encodedMessage || `gRPC status ${status}`;
  try {
    message = decodeURIComponent(message);
  } catch {
    // Keep the server's original message if it was not URI encoded.
  }
  const error = new Error(message);
  error.grpcStatus = Number(status);
  return error;
}

class GrpcClient {
  constructor(socketPath = SOCKET_PATH) {
    this.socketPath = socketPath;
    this.session = http2.connect("http://sing-box", {
      createConnection: () => net.connect({ path: this.socketPath })
    });
    this.closed = false;
    // A permanent listener prevents a post-handshake session error from
    // becoming an uncaught EventEmitter exception. The controller observes
    // the accompanying close event and owns reconnect/backoff.
    this.session.on("error", () => {});
    this.session.on("close", () => { this.closed = true; });
  }

  ready(timeoutMs = 3000) {
    if (this.session.connecting === false && this.session.closed === false) return Promise.resolve();
    return new Promise((resolveReady, rejectReady) => {
      const timer = setTimeout(() => rejectReady(new Error("timed out connecting to sing-box daemon")), timeoutMs);
      const cleanup = () => {
        clearTimeout(timer);
        this.session.off("connect", onConnect);
        this.session.off("error", onError);
      };
      const onConnect = () => { cleanup(); resolveReady(); };
      const onError = (error) => { cleanup(); rejectReady(error); };
      this.session.once("connect", onConnect);
      this.session.once("error", onError);
    });
  }

  unary(path, message = Buffer.alloc(0), timeoutMs = 5000) {
    return new Promise((resolveUnary, rejectUnary) => {
      const decoder = new GrpcFrameDecoder();
      const messages = [];
      let settled = false;
      let grpcStatus = 0;
      let grpcMessage = "";
      const request = this.session.request({
        ":method": "POST",
        ":path": path,
        ":scheme": "http",
        ":authority": "sing-box",
        "content-type": "application/grpc+proto",
        "te": "trailers",
        "accept-language": process.env.LANG || "en"
      });
      const timer = setTimeout(() => finish(new Error(`gRPC request timed out: ${path}`)), timeoutMs);

      const finish = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) rejectUnary(error);
        else if (grpcStatus !== 0) rejectUnary(grpcError(grpcStatus, grpcMessage));
        else resolveUnary(messages[0] || Buffer.alloc(0));
      };

      request.on("response", (headers) => {
        const httpStatus = Number(headers[":status"] || 0);
        if (httpStatus !== 200) finish(new Error(`sing-box daemon returned HTTP ${httpStatus}`));
        if (headers["grpc-status"] !== undefined) grpcStatus = Number(headers["grpc-status"]);
        if (headers["grpc-message"] !== undefined) grpcMessage = String(headers["grpc-message"]);
      });
      request.on("trailers", (trailers) => {
        if (trailers["grpc-status"] !== undefined) grpcStatus = Number(trailers["grpc-status"]);
        if (trailers["grpc-message"] !== undefined) grpcMessage = String(trailers["grpc-message"]);
      });
      request.on("data", (chunk) => {
        try {
          messages.push(...decoder.push(chunk));
        } catch (error) {
          finish(error);
        }
      });
      request.on("error", finish);
      request.on("end", () => finish());
      request.end(grpcFrame(message));
    });
  }

  subscribe(path, message, onMessage) {
    const decoder = new GrpcFrameDecoder();
    let grpcStatus = 0;
    let grpcMessage = "";
    let resolveDone;
    let rejectDone;
    const done = new Promise((resolveStream, rejectStream) => {
      resolveDone = resolveStream;
      rejectDone = rejectStream;
    });
    const request = this.session.request({
      ":method": "POST",
      ":path": path,
      ":scheme": "http",
      ":authority": "sing-box",
      "content-type": "application/grpc+proto",
      "te": "trailers",
      "accept-language": process.env.LANG || "en"
    });

    request.on("response", (headers) => {
      const httpStatus = Number(headers[":status"] || 0);
      if (httpStatus !== 200) rejectDone(new Error(`sing-box daemon returned HTTP ${httpStatus}`));
      if (headers["grpc-status"] !== undefined) grpcStatus = Number(headers["grpc-status"]);
      if (headers["grpc-message"] !== undefined) grpcMessage = String(headers["grpc-message"]);
    });
    request.on("trailers", (trailers) => {
      if (trailers["grpc-status"] !== undefined) grpcStatus = Number(trailers["grpc-status"]);
      if (trailers["grpc-message"] !== undefined) grpcMessage = String(trailers["grpc-message"]);
    });
    request.on("data", (chunk) => {
      try {
        for (const response of decoder.push(chunk)) onMessage(response);
      } catch (error) {
        rejectDone(error);
      }
    });
    request.on("error", rejectDone);
    request.on("end", () => {
      if (grpcStatus !== 0) rejectDone(grpcError(grpcStatus, grpcMessage));
      else resolveDone();
    });
    request.end(grpcFrame(message));
    return {
      cancel: () => request.close(http2.constants.NGHTTP2_CANCEL),
      done
    };
  }

  first(path, message = Buffer.alloc(0), timeoutMs = 3000) {
    return new Promise((resolveFirst, rejectFirst) => {
      let settled = false;
      let stream;
      const timer = setTimeout(() => finish(new Error(`gRPC stream timed out: ${path}`)), timeoutMs);
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (stream) stream.cancel();
        if (error) rejectFirst(error);
        else resolveFirst(value);
      };
      stream = this.subscribe(path, message, (value) => finish(null, value));
      stream.done.catch((error) => {
        if (!settled && error.grpcStatus !== 1) finish(error);
      }).then(() => {
        if (!settled) finish(new Error(`gRPC stream ended without a message: ${path}`));
      });
    });
  }

  close() {
    if (!this.session.closed && !this.session.destroyed) this.session.close();
  }
}

function readPreference(name, fallback) {
  if (!existsSync(DATABASE_PATH)) return fallback;
  const database = new DatabaseSync(DATABASE_PATH, { readOnly: true });
  try {
    const row = database.prepare("SELECT data FROM preferences WHERE name = ?").get(name);
    if (!row) return fallback;
    return JSON.parse(Buffer.from(row.data).toString("utf8"));
  } catch {
    return fallback;
  } finally {
    database.close();
  }
}

function writePreference(name, value) {
  const database = new DatabaseSync(DATABASE_PATH);
  try {
    database.prepare(`
      INSERT INTO preferences (name, data) VALUES (?, ?)
      ON CONFLICT(name) DO UPDATE SET data = excluded.data
    `).run(name, Buffer.from(JSON.stringify(value), "utf8"));
  } finally {
    database.close();
  }
}

function listProfiles() {
  if (!existsSync(DATABASE_PATH)) return { selectedId: "", profiles: [] };
  const database = new DatabaseSync(DATABASE_PATH, { readOnly: true });
  try {
    const profiles = database.prepare(
      "SELECT id, name, type FROM profiles ORDER BY item_order ASC"
    ).all().map((row) => ({ id: String(row.id), name: String(row.name), type: String(row.type) }));
    const row = database.prepare("SELECT data FROM preferences WHERE name = 'selected_profile_id'").get();
    let selectedId = "";
    if (row) {
      try { selectedId = String(JSON.parse(Buffer.from(row.data).toString("utf8")) || ""); } catch { /* ignored */ }
    }
    return { selectedId, profiles };
  } finally {
    database.close();
  }
}

function profileContent(profileId) {
  const safeId = String(profileId || "");
  if (safeId === "" || basename(safeId) !== safeId || safeId.includes("/") || safeId.includes("\\")) {
    throw new Error("invalid profile id");
  }
  const contentPath = join(PROFILES_PATH, `${safeId}.json`);
  if (!existsSync(contentPath)) throw new Error(`profile content not found: ${safeId}`);
  return readFileSync(contentPath, "utf8");
}

function startOptions() {
  const enabled = readPreference("oom_killer_enabled", false) === true;
  const killConnections = readPreference("oom_killer_kill_connections", false) === true;
  const limitMbValue = Number(readPreference("oom_memory_limit_mb", 50));
  const limitMb = Number.isFinite(limitMbValue) && limitMbValue > 0 ? Math.round(limitMbValue) : 50;
  return concatFields(
    boolField(1, enabled),
    boolField(2, !killConnections),
    intField(3, BigInt(limitMb) * 1024n * 1024n)
  );
}

function startServiceRequest(content) {
  return concatFields(stringField(1, content), messageField(2, startOptions()));
}

function isRunningStatus(status) {
  return status === "started" || status === "starting" || status === "stopping";
}

function cleanError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\s+/g, " ").trim().slice(0, 280);
}

class Controller {
  constructor(writeLine = (value) => process.stdout.write(`${JSON.stringify(value)}\n`)) {
    this.writeLine = writeLine;
    this.client = null;
    this.retryTimer = null;
    this.ownershipTimer = null;
    this.streams = [];
    this.connecting = false;
    this.actionChain = Promise.resolve();
    this.state = {
      type: "state",
      installed: existsSync(CLIENT_BINARY),
      daemonAvailable: false,
      ownership: "unavailable",
      daemonVersion: "",
      status: "unknown",
      statusText: "Connecting…",
      lastError: "",
      profiles: [],
      selectedProfileId: "",
      modes: [],
      currentMode: "",
      groups: []
    };
    this.refreshProfiles();
  }

  emitState() {
    this.writeLine({ ...this.state, active: isRunningStatus(this.state.status) });
  }

  refreshProfiles() {
    try {
      const data = listProfiles();
      this.state.profiles = data.profiles;
      this.state.selectedProfileId = data.selectedId;
    } catch (error) {
      this.state.lastError = cleanError(error);
    }
  }

  scheduleRetry(delayMs = 3000) {
    if (this.retryTimer) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.connect();
    }, delayMs);
  }

  clearConnection() {
    for (const stream of this.streams) stream.cancel();
    this.streams = [];
    if (this.ownershipTimer) clearInterval(this.ownershipTimer);
    this.ownershipTimer = null;
    if (this.client) this.client.close();
    this.client = null;
  }

  async connect() {
    if (this.connecting || this.client) return;
    this.connecting = true;
    const client = new GrpcClient();
    try {
      await client.ready();
      this.client = client;
      client.session.once("close", () => {
        if (this.client !== client) return;
        this.clearConnection();
        this.state.daemonAvailable = false;
        this.state.ownership = "unavailable";
        this.state.status = "unknown";
        this.state.statusText = "sing-box daemon is unavailable";
        this.state.groups = [];
        this.state.modes = [];
        this.state.currentMode = "";
        this.emitState();
        this.scheduleRetry();
      });

      const info = decodeDaemonInfo(await client.unary("/desktop.DesktopService/GetDaemonInfo"));
      this.state.daemonAvailable = true;
      this.state.daemonVersion = info.version;
      this.state.ownership = info.ownership;
      this.state.lastError = "";

      if (info.ownership === "available") {
        await client.unary("/desktop.DesktopService/ClaimService");
        this.state.ownership = "caller";
      }

      if (this.state.ownership === "caller") {
        this.startSubscriptions();
        this.state.statusText = "Checking service…";
      } else if (this.state.ownership === "other") {
        this.state.status = "unknown";
        this.state.statusText = "Controlled by the sing-box app";
        this.startOwnershipPolling();
      }
      this.emitState();
    } catch (error) {
      client.close();
      if (this.client === client) this.client = null;
      this.state.daemonAvailable = false;
      this.state.ownership = "unavailable";
      this.state.status = "unknown";
      this.state.statusText = existsSync(SOCKET_PATH)
        ? "sing-box daemon is not running"
        : "sing-box daemon is not installed";
      this.state.lastError = cleanError(error);
      this.emitState();
      this.scheduleRetry();
    } finally {
      this.connecting = false;
    }
  }

  startOwnershipPolling() {
    if (this.ownershipTimer) return;
    this.ownershipTimer = setInterval(async () => {
      if (!this.client || this.state.ownership !== "other") return;
      try {
        const info = decodeDaemonInfo(await this.client.unary("/desktop.DesktopService/GetDaemonInfo"));
        if (info.ownership === "available") {
          await this.client.unary("/desktop.DesktopService/ClaimService");
          this.state.ownership = "caller";
          clearInterval(this.ownershipTimer);
          this.ownershipTimer = null;
          this.startSubscriptions();
          this.emitState();
        }
      } catch {
        // Session close/error handling owns reconnection.
      }
    }, 3000);
  }

  restartSubscription(factory, delayMs = 1500) {
    setTimeout(() => {
      if (this.client && this.state.ownership === "caller") factory();
    }, delayMs);
  }

  trackStream(stream, factory) {
    this.streams.push(stream);
    stream.done.catch((error) => {
      if (error.grpcStatus !== 1) this.state.lastError = cleanError(error);
    }).finally(() => {
      this.streams = this.streams.filter((candidate) => candidate !== stream);
      if (this.client && this.state.ownership === "caller") this.restartSubscription(factory);
    });
  }

  startSubscriptions() {
    if (!this.client || this.streams.length > 0) return;

    const subscribeStatus = () => {
      if (!this.client) return;
      const stream = this.client.subscribe(
        "/daemon.StartedService/SubscribeServiceStatus",
        Buffer.alloc(0),
        (message) => {
          const status = decodeServiceStatus(message);
          this.state.status = status.status;
          this.state.statusText = status.errorMessage || ({
            idle: "Disconnected",
            starting: "Starting…",
            started: "Connected",
            stopping: "Stopping…",
            fatal: "Service failed"
          }[status.status] || status.status);
          if (status.errorMessage) this.state.lastError = status.errorMessage;
          this.emitState();
        }
      );
      this.trackStream(stream, subscribeStatus);
    };

    const subscribeGroups = () => {
      if (!this.client) return;
      const stream = this.client.subscribe(
        "/daemon.StartedService/SubscribeGroups",
        Buffer.alloc(0),
        (message) => {
          this.state.groups = decodeGroups(message).filter((group) => group.selectable);
          this.emitState();
        }
      );
      this.trackStream(stream, subscribeGroups);
    };

    const subscribeMode = () => {
      if (!this.client) return;
      const stream = this.client.subscribe(
        "/daemon.StartedService/SubscribeClashMode",
        Buffer.alloc(0),
        (message) => {
          this.state.currentMode = decodeClashMode(message);
          this.emitState();
        }
      );
      this.trackStream(stream, subscribeMode);
    };

    subscribeStatus();
    subscribeGroups();
    subscribeMode();
    void this.client.unary("/daemon.StartedService/GetClashModeStatus")
      .then((message) => {
        const mode = decodeClashModeStatus(message);
        this.state.modes = mode.modes;
        this.state.currentMode = mode.currentMode;
        this.emitState();
      })
      .catch(() => { /* Modes are unavailable while the service is stopped. */ });
  }

  async ensureOwned(takeOver = false) {
    if (!this.client) {
      await this.connect();
      if (!this.client) throw new Error("sing-box daemon is unavailable");
    }
    const info = decodeDaemonInfo(await this.client.unary("/desktop.DesktopService/GetDaemonInfo"));
    if (info.ownership === "available") {
      await this.client.unary("/desktop.DesktopService/ClaimService");
    } else if (info.ownership === "other") {
      if (!takeOver) throw new Error("sing-box is controlled by another application");
      await this.client.unary("/desktop.DesktopService/TakeOverService");
    } else if (info.ownership !== "caller") {
      throw new Error("sing-box daemon ownership is unavailable");
    }
    this.state.ownership = "caller";
    if (this.ownershipTimer) clearInterval(this.ownershipTimer);
    this.ownershipTimer = null;
    this.startSubscriptions();
  }

  async refreshServiceStatusOnce() {
    if (!this.client) throw new Error("sing-box daemon is unavailable");
    const status = decodeServiceStatus(await this.client.first(
      "/daemon.StartedService/SubscribeServiceStatus"
    ));
    this.state.status = status.status;
    this.state.statusText = status.errorMessage || ({
      idle: "Disconnected",
      starting: "Starting…",
      started: "Connected",
      stopping: "Stopping…",
      fatal: "Service failed"
    }[status.status] || status.status);
    return status;
  }

  async startSelectedProfile() {
    this.refreshProfiles();
    if (!this.state.selectedProfileId) throw new Error("no sing-box profile is selected");
    const content = profileContent(this.state.selectedProfileId);
    await this.client.unary(
      "/desktop.DesktopService/StartService",
      startServiceRequest(content),
      15000
    );
  }

  async perform(command) {
    const action = String(command.action || "");
    if (action === "refresh") {
      this.refreshProfiles();
      this.emitState();
      return;
    }

    await this.ensureOwned(true);

    if (this.state.status === "unknown") {
      await this.refreshServiceStatusOnce();
    }

    if (action === "takeOver") {
      this.emitState();
      return;
    }
    if (action === "toggle") {
      if (isRunningStatus(this.state.status)) {
        await this.client.unary("/daemon.ManagedService/StopService", Buffer.alloc(0), 10000);
      } else {
        await this.startSelectedProfile();
      }
    } else if (action === "setProfile") {
      const profileId = String(command.profileId || "");
      const known = listProfiles().profiles.some((profile) => profile.id === profileId);
      if (!known) throw new Error("profile not found");
      const shouldReload = isRunningStatus(this.state.status);
      writePreference("selected_profile_id", profileId);
      this.refreshProfiles();
      if (shouldReload) await this.startSelectedProfile();
    } else if (action === "setMode") {
      const mode = String(command.mode || "");
      if (mode === "" || (this.state.modes.length > 0 && !this.state.modes.includes(mode))) {
        throw new Error("invalid clash mode");
      }
      await this.client.unary(
        "/daemon.StartedService/SetClashMode",
        stringField(3, mode)
      );
      this.state.currentMode = mode;
    } else if (action === "selectOutbound") {
      const groupTag = String(command.groupTag || "");
      const outboundTag = String(command.outboundTag || "");
      if (!groupTag || !outboundTag) throw new Error("group and outbound are required");
      await this.client.unary(
        "/daemon.StartedService/SelectOutbound",
        concatFields(stringField(1, groupTag), stringField(2, outboundTag))
      );
    } else if (action === "urlTest") {
      const outboundTag = String(command.outboundTag || "");
      if (!outboundTag) throw new Error("outbound is required");
      await this.client.unary(
        "/daemon.StartedService/URLTest",
        stringField(1, outboundTag),
        15000
      );
    } else if (action === "closeAllConnections") {
      await this.client.unary("/daemon.StartedService/CloseAllConnections");
    } else {
      throw new Error(`unknown action: ${action}`);
    }
    this.state.lastError = "";
    this.emitState();
  }

  dispatch(command) {
    const id = command.id === undefined ? null : command.id;
    this.actionChain = this.actionChain.then(async () => {
      try {
        await this.perform(command);
        this.writeLine({ type: "result", id, ok: true });
      } catch (error) {
        const message = cleanError(error);
        this.state.lastError = message;
        this.emitState();
        this.writeLine({ type: "result", id, ok: false, error: message });
      }
    });
  }

  start() {
    this.emitState();
    void this.connect();
  }

  stop() {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.clearConnection();
  }
}

async function serve() {
  const controller = new Controller();
  controller.start();
  const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  input.on("line", (line) => {
    const text = line.trim();
    if (!text) return;
    try {
      controller.dispatch(JSON.parse(text));
    } catch (error) {
      controller.writeLine({ type: "result", id: null, ok: false, error: cleanError(error) });
    }
  });
  const shutdown = () => {
    controller.stop();
    process.exit(0);
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

async function once() {
  const lines = [];
  const controller = new Controller((value) => lines.push(value));
  controller.start();
  await new Promise((resolveOnce) => setTimeout(resolveOnce, 800));
  controller.stop();
  const state = [...lines].reverse().find((line) => line.type === "state") || controller.state;
  const summary = {
    ...state,
    groups: (state.groups || []).map((group) => ({
      tag: group.tag,
      type: group.type,
      selected: group.selected,
      itemCount: Array.isArray(group.items) ? group.items.length : 0
    }))
  };
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

const isMain = process.argv[1]
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isMain) {
  const command = process.argv[2] || "serve";
  if (command === "serve") await serve();
  else if (command === "once") await once();
  else {
    process.stderr.write(`Unknown command: ${command}\n`);
    process.exitCode = 2;
  }
}

export {
  GrpcClient,
  GrpcFrameDecoder,
  concatFields,
  decodeClashMode,
  decodeClashModeStatus,
  decodeDaemonInfo,
  decodeGroup,
  decodeGroups,
  decodeServiceStatus,
  encodeVarint,
  grpcFrame,
  intField,
  messageField,
  parseFields,
  startServiceRequest,
  stringField
};
