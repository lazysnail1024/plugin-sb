# sing-box for Omarchy

An Omarchy Quattro bar plugin for the official sing-box Linux desktop client.
It turns the tray menu's everyday controls into a native Omarchy panel styled
after the built-in Network and Tailscale widgets.

## Features

- Start and stop the active sing-box profile.
- Select any profile stored by the official desktop client.
- Switch Clash mode (`rule`, `global`, `direct`, or modes exposed by the
  active profile).
- Browse every selectable group and choose its outbound.
- Run a URL test for a group and show node latency returned by sing-box.
- Close all active connections.
- Open the official sing-box application for profile editing and advanced
  settings.

Bar controls:

- Left click: open or close the panel.
- Right click: start or stop sing-box.
- Middle click: open the official sing-box application.

Inside the panel, `T` toggles the service, `R` refreshes profiles, `C` closes
connections, and `O` opens the official application. `Esc` closes the panel.

## Compatibility

The current implementation targets:

- Omarchy 4.0.0 / Quattro's `schemaVersion: 1` plugin API.
- The official sing-box Linux client whose daemon exposes
  `/run/sing-box.socket` (validated against 1.14.0-beta.14).
- Node.js 22.5 or newer, including the built-in `node:sqlite` module.

The plugin intentionally uses the official client's own profile database and
daemon gRPC API. It does not parse subscription files, rewrite proxy nodes, or
maintain a second source of configuration.

## Install from this checkout

Copy the repository into the user plugin directory, validate it, rescan, then
enable the widget on the right side of the bar:

```bash
mkdir -p ~/.config/omarchy/plugins/sing-box
git archive --format=tar HEAD | tar -x -C ~/.config/omarchy/plugins/sing-box
omarchy plugin validate ~/.config/omarchy/plugins/sing-box
omarchy-shell shell rescanPlugins
omarchy plugin enable sing-box --section right
```

Changes under `~/.config/omarchy/plugins/` hot-reload. To copy a newer checkout
over the installed development copy, repeat the `git archive` command and run:

```bash
omarchy-shell shell rescanPlugins
```

To remove it later:

```bash
omarchy plugin remove sing-box
```

## Controller ownership

The sing-box daemon allows one desktop controller at a time. The plugin claims
the daemon when no controller is present. If the official sing-box app already
owns it, the panel shows **Controlled by the sing-box app** and offers an
explicit take-control row. Using a service, profile, mode, or group control also
takes control as part of that user action.

Taking control does not stop the proxy or alter profile content. It only moves
the daemon's controller session to the plugin. The official app remains useful
for profile editing; if it takes control again, the plugin returns to the same
notice state.

## Design

```text
Panel.qml / Service.qml
        │ NDJSON over stdin/stdout
        ▼
    backend.mjs
      ├── reads profile names and selection from settings.db
      ├── keeps one HTTP/2 gRPC connection to /run/sing-box.socket
      └── subscribes to service, mode, group, selection, and latency state
```

Only profile IDs, display names, modes, group tags, outbound tags, and daemon
status are sent to QML. Remote profile URLs, secrets, and complete profile
content are never printed by the backend.

## Development checks

```bash
omarchy plugin validate .
qmllint -I /usr/share/omarchy/shell -I /usr/lib/qt6/qml Panel.qml Service.qml
node --check backend.mjs
node --test tests/backend.test.mjs
node backend.mjs once
```

`node backend.mjs once` is read-only. It prints the profiles and connection
state visible to the plugin, which is useful when diagnosing daemon socket or
ownership issues.
