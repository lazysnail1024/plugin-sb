import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import http2 from "node:http2";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  GrpcClient,
  GrpcFrameDecoder,
  concatFields,
  decodeClashMode,
  decodeClashModeStatus,
  decodeDaemonInfo,
  decodeGroups,
  decodeServiceStatus,
  grpcFrame,
  intField,
  messageField,
  parseFields,
  stringField
} from "../backend.mjs";

test("protobuf reader decodes daemon and service state", () => {
  const daemon = concatFields(stringField(1, "1.14.0-beta.14"), intField(2, 2));
  assert.deepEqual(decodeDaemonInfo(daemon), {
    version: "1.14.0-beta.14",
    ownership: "caller"
  });

  const status = concatFields(intField(1, 4), stringField(2, "invalid config"));
  assert.deepEqual(decodeServiceStatus(status), {
    status: "fatal",
    errorMessage: "invalid config"
  });
});

test("protobuf reader decodes selectable groups and delays", () => {
  const firstItem = concatFields(
    stringField(1, "Tokyo 01"),
    stringField(2, "shadowsocks"),
    intField(4, 42)
  );
  const secondItem = concatFields(
    stringField(1, "direct"),
    stringField(2, "direct")
  );
  const group = concatFields(
    stringField(1, "Proxy"),
    stringField(2, "selector"),
    intField(3, 1),
    stringField(4, "Tokyo 01"),
    messageField(6, firstItem),
    messageField(6, secondItem)
  );
  const groups = decodeGroups(messageField(1, group));

  assert.equal(groups.length, 1);
  assert.equal(groups[0].tag, "Proxy");
  assert.equal(groups[0].selectable, true);
  assert.equal(groups[0].selected, "Tokyo 01");
  assert.deepEqual(groups[0].items.map((item) => [item.tag, item.urlTestDelay]), [
    ["Tokyo 01", 42],
    ["direct", 0]
  ]);
});

test("clash mode messages use the daemon field numbers", () => {
  const status = concatFields(
    stringField(1, "rule"),
    stringField(1, "global"),
    stringField(1, "direct"),
    stringField(2, "rule")
  );
  assert.deepEqual(decodeClashModeStatus(status), {
    modes: ["rule", "global", "direct"],
    currentMode: "rule"
  });
  assert.equal(decodeClashMode(stringField(3, "global")), "global");
});

test("gRPC frame decoder handles split and coalesced frames", () => {
  const first = grpcFrame(Buffer.from("first"));
  const second = grpcFrame(Buffer.from("second"));
  const decoder = new GrpcFrameDecoder();

  assert.deepEqual(decoder.push(first.subarray(0, 3)), []);
  assert.deepEqual(decoder.push(Buffer.concat([first.subarray(3), second])).map(String), [
    "first",
    "second"
  ]);
});

test("protobuf parser rejects truncated length-delimited fields", () => {
  assert.throws(() => parseFields(Buffer.from([0x0a, 0x04, 0x61])), /truncated protobuf bytes/);
});

test("gRPC client uses HTTP/2 over the daemon Unix socket", async (context) => {
  const socketPath = join(tmpdir(), `sing-box-plugin-test-${process.pid}.socket`);
  rmSync(socketPath, { force: true });

  const server = http2.createServer();
  context.after(() => {
    server.close();
    rmSync(socketPath, { force: true });
  });

  const requestSeen = new Promise((resolveRequest, rejectRequest) => {
    server.once("stream", (stream, headers) => {
      const decoder = new GrpcFrameDecoder();
      const messages = [];
      stream.on("data", (chunk) => messages.push(...decoder.push(chunk)));
      stream.on("error", rejectRequest);
      stream.on("end", () => {
        try {
          assert.equal(headers[":path"], "/desktop.DesktopService/GetDaemonInfo");
          assert.equal(messages.length, 1);
          assert.equal(messages[0].length, 0);
          stream.respond({
            ":status": 200,
            "content-type": "application/grpc+proto",
            "grpc-status": "0"
          });
          stream.end(grpcFrame(concatFields(stringField(1, "test-daemon"), intField(2, 2))));
          resolveRequest();
        } catch (error) {
          rejectRequest(error);
        }
      });
    });
  });

  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(socketPath, resolveListen);
  });

  const client = new GrpcClient(socketPath);
  context.after(() => client.close());
  await client.ready();
  const response = await client.unary("/desktop.DesktopService/GetDaemonInfo");
  await requestSeen;
  assert.deepEqual(decodeDaemonInfo(response), {
    version: "test-daemon",
    ownership: "caller"
  });
});
