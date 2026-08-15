import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
import Quickshell
import Quickshell.Io
import qs.Commons
import qs.Ui

Panel {
  id: root
  moduleName: "sing-box"
  ipcTarget: "sing-box"
  manageIpc: false

  property string expandedGroupTag: ""
  property string hoverKind: ""
  property string hoverKey: ""

  readonly property color foreground: bar ? bar.foreground : Color.foreground
  readonly property color urgent: bar ? bar.urgent : Color.urgent
  readonly property color dim: Qt.darker(foreground, 1.55)
  readonly property string fontFamily: bar ? bar.fontFamily : Style.font.family
  readonly property color hoverFill: bar ? Style.hoverFillFor(bar.foreground, Color.accent) : "transparent"
  readonly property color selectedFill: bar ? Style.selectedFillFor(bar.foreground, Color.accent) : "transparent"
  readonly property string profileName: singbox.selectedProfileName()
  readonly property string heroMeta: {
    if (!singbox.installed) return "CLIENT NOT INSTALLED"
    if (singbox.controlledElsewhere) return "CONTROLLED BY SING-BOX APP"
    if (singbox.actionStatus !== "") return singbox.actionStatus
    return singbox.statusText || "UNKNOWN"
  }
  readonly property color iconColor: singbox.active ? foreground : dim
  readonly property string toggleHint: singbox.active ? "Turn sing-box off" : "Turn sing-box on"

  function setHover(kind, key) {
    hoverKind = kind
    hoverKey = String(key || "")
  }

  function clearHover(kind, key) {
    if (hoverKind === kind && hoverKey === String(key || "")) {
      hoverKind = ""
      hoverKey = ""
    }
  }

  function modeLabel(mode) {
    var value = String(mode || "")
    if (value === "") return ""
    return value.charAt(0).toUpperCase() + value.substring(1)
  }

  function openClient() {
    root.close()
    Quickshell.execDetached(["uwsm-app", "--", "/opt/sing-box/sing-box"])
  }

  function scrollBy(delta) {
    if (!panelFlick) return
    var maximum = Math.max(0, panelFlick.contentHeight - panelFlick.height)
    panelFlick.contentY = Math.max(0, Math.min(maximum, panelFlick.contentY + delta * Style.space(42)))
  }

  implicitWidth: button.implicitWidth
  implicitHeight: button.implicitHeight

  onOpenedChanged: if (opened) {
    if (panelFlick) panelFlick.contentY = 0
    expandedGroupTag = ""
    hoverKind = ""
    hoverKey = ""
    singbox.refresh()
    Qt.callLater(function() { if (keyCatcher) keyCatcher.forceActiveFocus() })
  }

  Service {
    id: singbox
    settings: root.settings
  }

  IpcHandler {
    target: root.ipcTarget
    function open(): void { root.open() }
    function close(): void { root.close() }
    function show(): void { root.open() }
    function hide(): void { root.close() }
    function toggle(): void { root.toggle() }
    function refresh(): string { singbox.refresh(); return "ok" }
    function toggleService(): string { singbox.toggleService(); return "ok" }
    function status(): string { return singbox.statusText }
  }

  BarIconButton {
    id: button
    anchors.fill: parent
    bar: root.bar
    text: "󰖂"
    active: singbox.active
    onPressed: function(buttonCode) {
      if (buttonCode === Qt.RightButton) singbox.toggleService()
      else if (buttonCode === Qt.MiddleButton) root.openClient()
      else root.toggle()
    }

    PanelToolTip {
      visible: button.containsMouse
      text: "sing-box · " + (singbox.statusText || "Unknown")
      fontFamily: root.fontFamily
    }
  }

  KeyboardPanel {
    id: panel
    anchorItem: button
    owner: root
    bar: root.bar
    open: root.opened
    focusTarget: keyCatcher
    contentWidth: panel.fittedContentWidth(Style.space(420))
    contentHeight: panel.fittedContentHeight(contentColumn.implicitHeight, Style.space(620))

    PanelKeyCatcher {
      id: keyCatcher
      anchors.fill: parent
      onMoveRequested: function(dx, dy) { if (dy !== 0) root.scrollBy(dy) }
      onCloseRequested: root.close()
      onTabRequested: function(direction) { root.switchPanel(direction) }
      onTextKey: function(text) {
        if (text === "t" || text === "T") singbox.toggleService()
        else if (text === "r" || text === "R") singbox.refresh()
        else if (text === "o" || text === "O") root.openClient()
        else if (text === "c" || text === "C") singbox.closeAllConnections()
      }

      Flickable {
        id: panelFlick
        anchors.fill: parent
        contentWidth: width
        contentHeight: contentColumn.implicitHeight
        clip: true
        boundsBehavior: Flickable.StopAtBounds
        flickableDirection: Flickable.VerticalFlick
        interactive: contentHeight > height
        ScrollBar.vertical: ScrollBar { policy: ScrollBar.AsNeeded }

        Column {
          id: contentColumn
          width: panelFlick.width
          spacing: Style.space(12)

          Item {
            id: heroHeader
            width: parent.width
            implicitHeight: hero.implicitHeight

            PanelHero {
              id: hero
              width: parent.width
              title: "sing-box"
              meta: root.heroMeta
              detail: root.profileName
              foreground: root.foreground
              fontFamily: root.fontFamily
              iconOpacity: singbox.active ? 1.0 : 0.5
              iconComponent: Component {
                Text {
                  text: "󰖂"
                  color: root.iconColor
                  font.family: root.fontFamily
                  font.pixelSize: Style.font.display
                }
              }
              trailingControl: Component {
                ToggleSwitch {
                  id: serviceSwitch
                  visible: singbox.installed && singbox.profiles.length > 0
                  checked: singbox.active
                  busy: singbox.busy
                  foreground: hero.foreground
                  onToggled: singbox.toggleService()

                  PanelToolTip {
                    visible: serviceSwitch.containsMouse
                    text: root.toggleHint
                    fontFamily: hero.fontFamily
                  }
                }
              }
            }
          }

          Text {
            visible: singbox.lastError !== ""
            width: parent.width
            text: singbox.lastError
            color: root.urgent
            font.family: root.fontFamily
            font.pixelSize: Style.font.bodySmall
            wrapMode: Text.WordWrap
          }

          CursorSurface {
            visible: !singbox.installed
            width: parent.width
            implicitHeight: missingText.implicitHeight + Style.space(28)
            foreground: root.foreground
            bordered: true

            Text {
              id: missingText
              anchors.left: parent.left
              anchors.right: parent.right
              anchors.verticalCenter: parent.verticalCenter
              anchors.margins: Style.space(12)
              text: "The official sing-box Linux client was not found in /opt/sing-box."
              color: root.dim
              font.family: root.fontFamily
              font.pixelSize: Style.font.body
              wrapMode: Text.WordWrap
            }
          }

          CursorSurface {
            id: ownershipNotice
            visible: singbox.controlledElsewhere
            width: parent.width
            implicitHeight: ownershipRow.implicitHeight + Style.space(20)
            foreground: root.foreground
            hasCursor: root.hoverKind === "ownership"
            bordered: true

            MouseArea {
              anchors.fill: parent
              hoverEnabled: true
              cursorShape: singbox.busy ? Qt.ArrowCursor : Qt.PointingHandCursor
              enabled: !singbox.busy
              onEntered: root.setHover("ownership", "take-over")
              onExited: root.clearHover("ownership", "take-over")
              onClicked: singbox.takeOver()
            }

            RowLayout {
              id: ownershipRow
              anchors.left: parent.left
              anchors.right: parent.right
              anchors.verticalCenter: parent.verticalCenter
              anchors.leftMargin: Style.space(12)
              anchors.rightMargin: Style.space(12)
              spacing: Style.space(10)

              Text {
                text: "󰒃"
                color: root.dim
                font.family: root.fontFamily
                font.pixelSize: Style.font.heading
              }
              ColumnLayout {
                Layout.fillWidth: true
                spacing: Style.space(1)
                Text {
                  Layout.fillWidth: true
                  text: "Controlled by the sing-box app"
                  color: root.foreground
                  font.family: root.fontFamily
                  font.pixelSize: Style.font.body
                  font.bold: true
                  elide: Text.ElideRight
                }
                Text {
                  Layout.fillWidth: true
                  text: "Click to let this plugin take control"
                  color: root.dim
                  font.family: root.fontFamily
                  font.pixelSize: Style.font.caption
                  elide: Text.ElideRight
                }
              }
              Text {
                text: "󰁔"
                color: root.dim
                font.family: root.fontFamily
                font.pixelSize: Style.font.body
              }
            }
          }

          PanelSeparator {
            visible: singbox.profiles.length > 0
            foreground: root.foreground
          }

          Column {
            visible: singbox.profiles.length > 0
            width: parent.width
            spacing: Style.space(8)

            PanelSectionHeader {
              text: "PROFILES"
              foreground: root.foreground
              fontFamily: root.fontFamily
            }

            Column {
              width: parent.width
              spacing: Style.space(5)
              Repeater {
                model: singbox.profiles
                ProfileRow {
                  required property var modelData
                  width: parent.width
                  profile: modelData
                }
              }
            }
          }

          PanelSeparator {
            visible: singbox.active && singbox.modes.length > 0
            foreground: root.foreground
          }

          Column {
            visible: singbox.active && singbox.modes.length > 0
            width: parent.width
            spacing: Style.space(8)

            PanelSectionHeader {
              text: "MODE"
              foreground: root.foreground
              fontFamily: root.fontFamily
            }

            Row {
              id: modeRow
              width: parent.width
              spacing: Style.space(6)
              Repeater {
                model: singbox.modes
                ModePill {
                  required property var modelData
                  width: Math.max(Style.space(82), (modeRow.width - modeRow.spacing * Math.max(0, singbox.modes.length - 1)) / Math.max(1, singbox.modes.length))
                  mode: String(modelData || "")
                }
              }
            }
          }

          PanelSeparator {
            visible: singbox.active && singbox.groups.length > 0
            foreground: root.foreground
          }

          Column {
            visible: singbox.active && singbox.groups.length > 0
            width: parent.width
            spacing: Style.space(8)

            RowLayout {
              width: parent.width
              PanelSectionHeader {
                text: "GROUPS"
                foreground: root.foreground
                fontFamily: root.fontFamily
                Layout.fillWidth: true
              }
              PanelActionButton {
                iconText: "󰑐"
                tooltipText: "Close all connections"
                foreground: root.foreground
                fontFamily: root.fontFamily
                enabled: !singbox.busy
                onClicked: singbox.closeAllConnections()
              }
            }

            Column {
              width: parent.width
              spacing: Style.space(5)
              Repeater {
                model: singbox.groups
                GroupBlock {
                  required property var modelData
                  width: parent.width
                  group: modelData
                }
              }
            }
          }

          PanelSeparator {
            foreground: root.foreground
          }

          RowLayout {
            width: parent.width
            spacing: Style.space(8)

            Text {
              Layout.fillWidth: true
              text: singbox.daemonVersion !== "" ? "daemon " + singbox.daemonVersion : ""
              color: root.dim
              font.family: root.fontFamily
              font.pixelSize: Style.font.caption
              elide: Text.ElideRight
            }
            PanelActionButton {
              iconText: "󰑐"
              tooltipText: "Refresh"
              foreground: root.foreground
              fontFamily: root.fontFamily
              onClicked: singbox.refresh()
            }
            PanelActionButton {
              iconText: "󰏌"
              tooltipText: "Open sing-box"
              foreground: root.foreground
              fontFamily: root.fontFamily
              onClicked: root.openClient()
            }
          }
        }
      }
    }
  }

  component ProfileRow: CursorSurface {
    id: profileRow
    property var profile: null
    readonly property string profileId: profile ? String(profile.id || "") : ""
    readonly property bool selected: profileId !== "" && profileId === singbox.selectedProfileId

    current: selected
    hasCursor: root.hoverKind === "profile" && root.hoverKey === profileId
    foreground: root.foreground
    fill: root.hoverFill
    currentFill: root.selectedFill
    implicitHeight: profileContent.implicitHeight + Style.space(18)

    MouseArea {
      anchors.fill: parent
      hoverEnabled: true
      enabled: !singbox.busy
      cursorShape: enabled ? Qt.PointingHandCursor : Qt.ArrowCursor
      onEntered: root.setHover("profile", profileRow.profileId)
      onExited: root.clearHover("profile", profileRow.profileId)
      onClicked: singbox.selectProfile(profileRow.profileId)
    }

    RowLayout {
      id: profileContent
      anchors.left: parent.left
      anchors.right: parent.right
      anchors.verticalCenter: parent.verticalCenter
      anchors.leftMargin: Style.space(10)
      anchors.rightMargin: Style.space(10)
      spacing: Style.space(9)

      Text {
        text: profileRow.selected ? "󰄬" : "󰈙"
        color: profileRow.selected ? root.foreground : root.dim
        font.family: root.fontFamily
        font.pixelSize: Style.font.body
        width: Style.space(22)
        horizontalAlignment: Text.AlignHCenter
      }
      ColumnLayout {
        Layout.fillWidth: true
        spacing: Style.space(1)
        Text {
          Layout.fillWidth: true
          text: profileRow.profile ? String(profileRow.profile.name || "Unnamed profile") : "Unnamed profile"
          color: root.foreground
          font.family: root.fontFamily
          font.pixelSize: Style.font.body
          font.bold: profileRow.selected
          elide: Text.ElideRight
        }
        Text {
          Layout.fillWidth: true
          text: profileRow.profile ? String(profileRow.profile.type || "local") : ""
          color: root.dim
          font.family: root.fontFamily
          font.pixelSize: Style.font.caption
          elide: Text.ElideRight
        }
      }
    }
  }

  component ModePill: CursorSurface {
    id: modePill
    property string mode: ""
    readonly property bool selected: mode === singbox.currentMode

    current: selected
    hasCursor: root.hoverKind === "mode" && root.hoverKey === mode
    foreground: root.foreground
    fill: root.hoverFill
    currentFill: root.selectedFill
    implicitHeight: Style.space(38)
    bordered: true

    Text {
      anchors.centerIn: parent
      text: root.modeLabel(modePill.mode)
      color: root.foreground
      font.family: root.fontFamily
      font.pixelSize: Style.font.bodySmall
      font.bold: modePill.selected
    }
    MouseArea {
      anchors.fill: parent
      hoverEnabled: true
      enabled: !singbox.busy
      cursorShape: enabled ? Qt.PointingHandCursor : Qt.ArrowCursor
      onEntered: root.setHover("mode", modePill.mode)
      onExited: root.clearHover("mode", modePill.mode)
      onClicked: singbox.setMode(modePill.mode)
    }
  }

  component GroupBlock: Column {
    id: groupBlock
    property var group: null
    readonly property string groupTag: group ? String(group.tag || "") : ""
    readonly property bool expanded: groupTag !== "" && root.expandedGroupTag === groupTag
    width: parent ? parent.width : implicitWidth
    spacing: Style.space(4)

    CursorSurface {
      id: groupHeader
      width: parent.width
      hasCursor: root.hoverKind === "group" && root.hoverKey === groupBlock.groupTag
      current: groupBlock.expanded
      foreground: root.foreground
      fill: root.hoverFill
      currentFill: root.selectedFill
      implicitHeight: groupHeaderContent.implicitHeight + Style.space(18)

      MouseArea {
        anchors.fill: parent
        hoverEnabled: true
        cursorShape: Qt.PointingHandCursor
        onEntered: root.setHover("group", groupBlock.groupTag)
        onExited: root.clearHover("group", groupBlock.groupTag)
        onClicked: root.expandedGroupTag = groupBlock.expanded ? "" : groupBlock.groupTag
      }

      RowLayout {
        id: groupHeaderContent
        anchors.left: parent.left
        anchors.right: parent.right
        anchors.verticalCenter: parent.verticalCenter
        anchors.leftMargin: Style.space(10)
        anchors.rightMargin: Style.space(8)
        spacing: Style.space(8)

        Text {
          text: groupBlock.expanded ? "󰅀" : "󰅂"
          color: root.dim
          font.family: root.fontFamily
          font.pixelSize: Style.font.bodySmall
          width: Style.space(18)
          horizontalAlignment: Text.AlignHCenter
        }
        ColumnLayout {
          Layout.fillWidth: true
          spacing: Style.space(1)
          Text {
            Layout.fillWidth: true
            text: groupBlock.groupTag
            color: root.foreground
            font.family: root.fontFamily
            font.pixelSize: Style.font.body
            font.bold: groupBlock.expanded
            elide: Text.ElideRight
          }
          Text {
            Layout.fillWidth: true
            text: groupBlock.group ? String(groupBlock.group.selected || "") : ""
            color: root.dim
            font.family: root.fontFamily
            font.pixelSize: Style.font.caption
            elide: Text.ElideRight
          }
        }
        PanelActionButton {
          iconText: "󱑂"
          tooltipText: "Test group latency"
          foreground: root.foreground
          fontFamily: root.fontFamily
          enabled: !singbox.busy
          onClicked: singbox.urlTest(groupBlock.groupTag)
        }
      }
    }

    Column {
      visible: groupBlock.expanded
      width: parent.width
      leftPadding: Style.space(18)
      spacing: Style.space(3)

      Repeater {
        model: groupBlock.group && groupBlock.group.items ? groupBlock.group.items : []
        NodeRow {
          required property var modelData
          width: parent.width - parent.leftPadding
          groupTag: groupBlock.groupTag
          node: modelData
          selectedTag: groupBlock.group ? String(groupBlock.group.selected || "") : ""
        }
      }
    }
  }

  component NodeRow: CursorSurface {
    id: nodeRow
    property string groupTag: ""
    property var node: null
    property string selectedTag: ""
    readonly property string nodeTag: node ? String(node.tag || "") : ""
    readonly property string nodeKey: groupTag + "\n" + nodeTag
    readonly property bool selected: nodeTag !== "" && nodeTag === selectedTag
    readonly property int delay: node ? Number(node.urlTestDelay || 0) : 0

    current: selected
    hasCursor: root.hoverKind === "node" && root.hoverKey === nodeKey
    foreground: root.foreground
    fill: root.hoverFill
    currentFill: root.selectedFill
    implicitHeight: Style.space(42)

    MouseArea {
      anchors.fill: parent
      hoverEnabled: true
      enabled: !singbox.busy
      cursorShape: enabled ? Qt.PointingHandCursor : Qt.ArrowCursor
      onEntered: root.setHover("node", nodeRow.nodeKey)
      onExited: root.clearHover("node", nodeRow.nodeKey)
      onClicked: singbox.selectOutbound(nodeRow.groupTag, nodeRow.nodeTag)
    }

    RowLayout {
      anchors.fill: parent
      anchors.leftMargin: Style.space(10)
      anchors.rightMargin: Style.space(10)
      spacing: Style.space(8)

      Text {
        text: nodeRow.selected ? "󰄬" : ""
        color: root.foreground
        font.family: root.fontFamily
        font.pixelSize: Style.font.bodySmall
        width: Style.space(16)
      }
      Text {
        Layout.fillWidth: true
        text: nodeRow.nodeTag
        color: root.foreground
        font.family: root.fontFamily
        font.pixelSize: Style.font.bodySmall
        font.bold: nodeRow.selected
        elide: Text.ElideRight
      }
      Text {
        visible: nodeRow.delay > 0
        text: nodeRow.delay + " ms"
        color: nodeRow.delay < 250 ? root.dim : root.urgent
        font.family: root.fontFamily
        font.pixelSize: Style.font.caption
      }
    }
  }
}
