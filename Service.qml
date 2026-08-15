import QtQuick
import Quickshell
import Quickshell.Io

Item {
  id: root

  property var settings: ({})

  property bool installed: false
  property bool daemonAvailable: false
  property string ownership: "unavailable"
  property string daemonVersion: ""
  property string status: "unknown"
  property string statusText: "Connecting…"
  property string lastError: ""
  property string actionStatus: ""
  property var profiles: []
  property string selectedProfileId: ""
  property var modes: []
  property string currentMode: ""
  property var groups: []

  property int _desired: -1
  property int _nextRequestId: 1
  property int _pendingRequests: 0
  property bool _destroying: false

  readonly property bool backendActive: status === "started" || status === "starting" || status === "stopping"
  readonly property bool active: _desired === -1 ? backendActive : _desired === 1
  readonly property bool transitioning: status === "starting" || status === "stopping"
  readonly property bool busy: _pendingRequests > 0 || transitioning
  readonly property bool controlledElsewhere: ownership === "other"
  readonly property string backendPath: localPath(Qt.resolvedUrl("backend.mjs"))
  readonly property int refreshIntervalSec: intSetting("refreshIntervalSec", 15, 5, 300)

  function setting(name, fallback) {
    var value = settings ? settings[name] : undefined
    return value === undefined || value === null ? fallback : value
  }

  function intSetting(name, fallback, min, max) {
    var value = parseInt(String(setting(name, fallback)), 10)
    if (!isFinite(value)) value = fallback
    return Math.max(min, Math.min(max, value))
  }

  function localPath(url) {
    var value = String(url || "")
    if (value.indexOf("file://") === 0) value = value.substring(7)
    try { return decodeURIComponent(value) } catch (error) { return value }
  }

  function selectedProfileName() {
    for (var i = 0; i < profiles.length; i++) {
      if (String(profiles[i].id || "") === selectedProfileId)
        return String(profiles[i].name || "")
    }
    return ""
  }

  function send(action, values) {
    if (!backendProcess.running) {
      lastError = "sing-box plugin backend is not running"
      return false
    }
    var request = { id: _nextRequestId++, action: action }
    var extra = values || {}
    for (var key in extra) request[key] = extra[key]
    _pendingRequests += 1
    backendProcess.write(JSON.stringify(request) + "\n")
    return true
  }

  function refresh() {
    send("refresh")
  }

  function toggleService() {
    if (!installed || busy) return
    _desired = active ? 0 : 1
    actionStatus = _desired === 1 ? "Starting sing-box…" : "Stopping sing-box…"
    actionStatusTimer.restart()
    if (!send("toggle")) _desired = -1
  }

  function selectProfile(profileId) {
    var value = String(profileId || "")
    if (value === "" || value === selectedProfileId || busy) return
    selectedProfileId = value
    actionStatus = "Switching profile…"
    actionStatusTimer.restart()
    send("setProfile", { profileId: value })
  }

  function setMode(mode) {
    var value = String(mode || "")
    if (value === "" || value === currentMode || busy) return
    currentMode = value
    actionStatus = "Switching mode…"
    actionStatusTimer.restart()
    send("setMode", { mode: value })
  }

  function selectOutbound(groupTag, outboundTag) {
    if (!groupTag || !outboundTag || busy) return
    actionStatus = "Switching outbound…"
    actionStatusTimer.restart()
    send("selectOutbound", {
      groupTag: String(groupTag),
      outboundTag: String(outboundTag)
    })
  }

  function urlTest(outboundTag) {
    if (!outboundTag || busy) return
    actionStatus = "Testing latency…"
    actionStatusTimer.restart()
    send("urlTest", { outboundTag: String(outboundTag) })
  }

  function closeAllConnections() {
    if (!active || busy) return
    actionStatus = "Closing connections…"
    actionStatusTimer.restart()
    send("closeAllConnections")
  }

  function takeOver() {
    if (!controlledElsewhere || busy) return
    actionStatus = "Taking control…"
    actionStatusTimer.restart()
    send("takeOver")
  }

  function applyState(message) {
    installed = message.installed === true
    daemonAvailable = message.daemonAvailable === true
    ownership = String(message.ownership || "unavailable")
    daemonVersion = String(message.daemonVersion || "")
    status = String(message.status || "unknown")
    statusText = String(message.statusText || "")
    profiles = message.profiles instanceof Array ? message.profiles : []
    selectedProfileId = String(message.selectedProfileId || "")
    modes = message.modes instanceof Array ? message.modes : []
    currentMode = String(message.currentMode || "")
    groups = message.groups instanceof Array ? message.groups : []
    lastError = String(message.lastError || "")

    if (_desired !== -1 && backendActive === (_desired === 1)) _desired = -1
  }

  function handleLine(data) {
    var line = String(data || "").trim()
    if (line === "") return
    var message
    try {
      message = JSON.parse(line)
    } catch (error) {
      lastError = "Invalid backend response"
      return
    }

    if (message.type === "state") {
      applyState(message)
      return
    }
    if (message.type === "result") {
      _pendingRequests = Math.max(0, _pendingRequests - 1)
      if (message.ok === true) {
        lastError = ""
        actionStatus = ""
      } else {
        _desired = -1
        lastError = String(message.error || "sing-box action failed")
        actionStatus = ""
      }
    }
  }

  function handleBackendError(data) {
    var text = String(data || "").trim()
    if (text === "" || text.indexOf("ExperimentalWarning") !== -1) return
    if (lastError === "") lastError = text.replace(/\s+/g, " ").substring(0, 220)
  }

  Component.onCompleted: backendProcess.running = true
  Component.onDestruction: {
    _destroying = true
    backendProcess.running = false
  }

  Timer {
    interval: root.refreshIntervalSec * 1000
    repeat: true
    running: true
    onTriggered: root.refresh()
  }

  Timer {
    id: restartTimer
    interval: 2000
    repeat: false
    onTriggered: if (!root._destroying && !backendProcess.running) backendProcess.running = true
  }

  Timer {
    id: actionStatusTimer
    interval: 3000
    repeat: false
    onTriggered: root.actionStatus = ""
  }

  Process {
    id: backendProcess
    command: ["node", root.backendPath, "serve"]
    stdinEnabled: true
    stdout: SplitParser { onRead: function(data) { root.handleLine(data) } }
    stderr: SplitParser { onRead: function(data) { root.handleBackendError(data) } }
    onExited: function(exitCode) {
      if (root._destroying) return
      root._pendingRequests = 0
      root._desired = -1
      root.daemonAvailable = false
      root.status = "unknown"
      root.statusText = "Plugin backend stopped"
      if (exitCode !== 0 && root.lastError === "") root.lastError = "sing-box plugin backend exited"
      restartTimer.restart()
    }
  }
}
