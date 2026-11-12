# DSH Task Monitor

[English](README.md) | [简体中文](README.zh-CN.md)

A Windows floating task monitor for [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness). It shows live session progress in a fully transparent floating ball and a compact task panel, so you can keep an eye on long-running agent work without switching back to DSH.

The project follows the hybrid design documented in [docs/solution.zh-CN.md](docs/solution.zh-CN.md):

```text
DSH Host bridge plugin ──loopback HTTP/SSE──┐
                                            ├──> Rust MonitorCore ──> ball + panel
DSH projection cache  ──read-only adapter────┘
```

## Features

- **Fully transparent 72×72 ball** — only a progress ring, count/status text and an attention dot are painted; the desktop shows through.
- **High-contrast ball text** — dark glyphs with a light outline stay readable on both light and dark wallpapers.
- **Task panel** — waiting, running, failed and recently completed sessions, with Todo progress, current step, elapsed time, background jobs, goal and context pressure.
- **Ball ↔ panel switching** — click the ball to open the panel, `◎` to return to the ball, `✕` to hide to the tray. Global hotkey `Ctrl+Alt+Shift+M` and the tray icon restore the panel.
- **Two data channels**
  - **Plugin bridge (live)**: a DSH Host plugin folds session events and exposes a token-protected, loopback-only snapshot/SSE endpoint.
  - **File adapter (zero install)**: reads DSH's projection cache, so the monitor works with an unmodified DSH installation.
- **Windows integration** — always-on-top, skip taskbar, drag to move, snap to work-area edges, single instance, system tray.
- **Privacy first** — no conversation text, tool output or credentials are sent; only titles, Todo text, paths, command labels and counters.

## Requirements

| Component | Requirement |
|---|---|
| OS | Windows 10/11 x64 |
| WebView2 | Bundled with Windows 11; install the Evergreen Runtime on Windows 10 |
| Node.js | 20+ |
| pnpm | 9+ |
| Rust | Stable toolchain with the MSVC target |
| MSVC | Visual Studio Build Tools with the C++ workload |
| DSH | Desktop 0.2.x (tested with `0.2.2-rc.1`) |

## Quick start

### One-click start (Windows)

Double-click [`start.bat`](start.bat), or run:

```powershell
.\start.bat            # launch the release build
.\start.bat -Rebuild   # rebuild first, then launch
.\start.bat -Dev       # Vite + Tauri development mode
```

The launcher starts `target/release/dsh-task-monitor.exe`. If that file does not exist yet, it builds the release executable first (Rust and pnpm required). If the monitor is already running, launching again opens the panel instead of starting a second instance.

### Manual start

```powershell
pnpm install
pnpm --filter @dsh-monitor/desktop tauri dev
```

If `cargo` is not on `PATH`, set your Rust environment first, for example:

```powershell
$env:CARGO_HOME = "$env:USERPROFILE\.cargo"
$env:RUSTUP_HOME = "$env:USERPROFILE\.rustup"
$env:PATH = "$env:CARGO_HOME\bin;$env:PATH"
```

Frontend-only development:

```powershell
pnpm --filter @dsh-monitor/desktop dev
```

Helper scripts:

```powershell
.\scripts\run-desktop.ps1          # tauri dev
.\scripts\run-desktop.ps1 -Build   # tauri build
```

## Build

```powershell
pnpm --filter @dsh-monitor/desktop tauri build
```

Artifacts:

- `apps/desktop/src-tauri/target/release/dsh-task-monitor.exe`
- `apps/desktop/src-tauri/target/release/bundle/nsis/` (installer, when bundling is enabled)

The release build is currently unsigned. Windows SmartScreen may warn on first launch.

## Install the DSH bridge plugin (optional, enables live mode)

The plugin lives in `apps/plugin` and is installed from the local checkout — no private registry is required.

```powershell
# Install into the desktop profile as a local link.
dsh plugin --profile desktop add "link:$((Resolve-Path .)\apps\plugin)"
```

Then restart DSH Desktop and enable **DSH Task Monitor bridge** under **Settings → Plugins**. The CLI only installs the package; the plugin manager owns bundle selection.

During development, `.\scripts\install-plugin.ps1` performs the same step.

The plugin writes a discovery file:

```text
%USERPROFILE%\.dsh\storages\task-monitor\bridges\<pid>-<profile>.json
```

The monitor reads this file, authenticates with the per-process token and fetches `/v1/snapshot` every 500 ms. The plugin also exposes `/v1/events` (SSE); direct SSE consumption in Rust is planned for M2. If the plugin is missing or disabled, the monitor falls back to the file adapter automatically.

## How it works

### Data sources

| Mode | Source | Latency | Notes |
|---|---|---|---|
| Plugin | DSH Host plugin over loopback HTTP | ~0.5 s | Full live events, jobs, subagents, actions |
| File | `storages/session_projcache/sessions/*.json` | ≤ 5 s / 200 events | Zero install, read-only, recent tasks |
| Offline | — | — | DSH not running or no DSH home found |

### Bridge security

- Binds only to `127.0.0.1` on an OS-assigned port.
- Requires `Authorization: Bearer <token>`; the token is created per process and stored in the discovery file.
- Rejects non-loopback `Host` headers and cross-site `Origin` headers.
- Never writes to DSH session logs or the projection cache.

## Configuration

The settings dialog is available from the panel gear button.

| Setting | Default | Description |
|---|---|---|
| DSH Home | auto | `DSH_HOME`, then `%USERPROFILE%\.dsh` |
| Source mode | auto | `auto`, `plugin`, or `file` |
| Stale threshold | 90 s | Running task is marked stale after no updates |
| Max tasks | 30 | Cards shown in the panel |
| Hide when idle | off | Hide the ball when nothing is running |
| Hotkey | `Ctrl+Alt+Shift+M` | Show/hide the panel |

Settings are stored in `%APPDATA%\com.dshmonitor.desktop\settings.json`.

## Project layout

```text
apps/desktop/              Tauri 2 + Vue 3 desktop app
  src/                     BallView, PanelView, TaskCard, SettingsDialog
  src-tauri/src/           Rust: core, model, settings, file/bridge sources
apps/plugin/               DSH Host bundle: event fold + loopback bridge
packages/protocol/         Shared TypeScript wire types
docs/                      Design and architecture documents
scripts/                   Launcher, icon generation, dev/build helpers
start.bat                  One-click Windows launcher
```

## Development and verification

```powershell
pnpm -r --if-present typecheck
pnpm -r --if-present test
cargo test --offline --manifest-path apps/desktop/src-tauri/Cargo.toml
cargo fmt --check --manifest-path apps/desktop/src-tauri/Cargo.toml
```

Current verification status:

- Vue/TypeScript typecheck: passing
- Plugin tests (reducer, store, bridge): 8/8 passing
- Rust unit tests: 2/2 passing
- Release build: passing
- Live bridge: verified with an isolated headless DSH Host
- File mode: verified against real DSH projection cache data

## Known limitations

- The Rust bridge client polls `/v1/snapshot` every 500 ms; the SSE endpoint is implemented but not yet consumed directly.
- File mode does not yet parse approvals or background jobs from the compressed session log; those require the plugin bridge.
- Window/ball positions are not persisted across restarts.
- No in-app DSH overlay (`shell.overlay`) yet.
- Windows only; no macOS or Linux support.
- No code signing or auto-update channel.

## Roadmap

1. Consume the bridge SSE stream directly in Rust.
2. Frame-aligned session log tailing for approvals and jobs in file mode.
3. Persist ball/panel positions and multi-monitor preferences.
4. Optional in-app overlay client plugin.
5. Signed NSIS/MSI installer and auto-update.

## Contributing

Issues and pull requests are welcome. Please keep the data channel read-only, avoid adding conversation content to the wire protocol, and run the checks above before opening a PR.

## License

[MIT](LICENSE)
