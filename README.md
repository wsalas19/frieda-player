<div align="center">

# 🎵 Media Widget

**A featherweight, floating now-playing widget for Windows.**

Native SMTC integration · Rust + Tauri 2 · no Electron, no bloat

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Tauri](https://img.shields.io/badge/Tauri-2.x-orange.svg)](https://tauri.app)
[![Platform](https://img.shields.io/badge/Platform-Windows-informational.svg)](#roadmap)

<!-- TODO: add a screenshot at docs/screenshot.png once you're happy with the look
<img src="docs/screenshot.png" width="420" alt="Media Widget floating over the desktop"> -->

</div>

---

## What is this?

Media Widget is a small frameless card that lives on your desktop and mirrors
whatever is playing through the Windows System Media Transport Controls
(SMTC) — the same feed behind the Windows media flyout. If your player
integrates with Windows' native media keys, the widget can see and control it:
**Spotify, Tidal, Edge, Chrome, Apple Music,foobar2000** and friends.

It is a visualizer/controller, not a player: the widget reads metadata,
artwork and timeline, and sends play/pause/skip back through the OS. It never
touches audio itself.

## Features

- **Frameless floating card** — transparent, draggable, always-on-top by default
- **Live metadata** — artwork, title, artist · album, and a smoothly animated
  progress bar
- **Hover controls** — previous / play-pause / next with instant feedback
  (optimistic UI + pending spinner), plus a click-to-seek bar that appears
  along the bottom edge on hover
- **System tray resident** — right-click for Show/Hide, Always on Top,
  Run at Startup, Check for Updates, and Quit
- **Sips resources** — the backend polls SMTC at 1 Hz while playing and
  throttles to every 5 s when idle; state is only sent to the UI when it
  actually changes, and the progress bar interpolates locally between ticks
- **Truly native read path** — Windows.Media.Control via the `windows` crate,
  no polling of window titles or media key hooks

## Install

Grab the latest installer from [Releases](https://github.com/wsalas19/wmp-project/releases)
(once published — this repo is in private development for now):

- `Media Widget_x.y.z_x64-setup.exe` (NSIS, recommended)
- `Media Widget_x.y.z_x64_en-US.msi`

Or build from source (below).

## How it works

```
┌──────────────────────────── Tauri 2 ────────────────────────────┐
│                                                                  │
│  Rust backend (src-tauri/src)          React UI (src/)           │
│  ┌──────────────────────────┐          ┌──────────────────────┐  │
│  │ media.rs                 │ media-   │ App.tsx              │  │
│  │  SMTC event loop (MTA)   │ state    │  card · progress ·   │  │
│  │  artwork → base64        │ event    │  hover controls      │  │
│  │  state diffing           │ ───────▶ │  local interpolation │  │
│  │  control channel  ◀──────│──────────│  control action      │  │
│  └──────────────────────────┘ invoke   └──────────────────────┘  │
│  lib.rs: tray menu · autostart · window toggling                 │
└──────────────────────────────────────────────────────────────────┘
```

| Piece | Where |
| --- | --- |
| SMTC event loop, artwork decoding, transport controls | `src-tauri/src/media.rs` |
| Tray menu, autostart, window management | `src-tauri/src/lib.rs` |
| Widget UI (drag region, controls, progress) | `src/App.tsx` |

The IPC surface is three messages: a `media-state` event (backend → frontend,
lightweight metadata/timeline JSON), a `media-art` event (backend → frontend,
fired only when the artwork bytes change, so the base64 payload never rides
along with position ticks), and a `control` command (frontend → backend,
`play_pause | next | prev | seek:<ms>`).

A few implementation notes worth knowing if you're hacking on it:

- The media thread initializes WinRT as **multithreaded (MTA)** — blocking
  `IAsyncOperation::get()` on an STA thread without a message pump deadlocks.
- The loop is **event-driven, not polling**: handlers on SMTC's
  `MediaPropertiesChanged` / `PlaybackInfoChanged` / `TimelinePropertiesChanged`
  (plus `CurrentSessionChanged` on the manager) push a refresh message into the
  same mpsc channel the UI's control actions use, so any change — including a
  click — wakes the loop instantly. A 5s `recv_timeout` fallback just re-syncs
  the position for the frontend's interpolator.
- **Artwork staleness**: some providers (Tidal notably) keep serving the
  *previous* track's artwork stream for seconds after the metadata event fires,
  and the title settles before the art does — so no fixed delay works. Instead,
  a read whose bytes are identical to the previous track's art is treated as
  stale and retried every second until the bytes differ (capped at 5 retries to
  tolerate back-to-back tracks that legitimately share artwork) — except when
  the new track is on the *same album*, in which case the lingering stream is
  by definition the correct art and is reused immediately. Reads that fail
  outright are also retried, so the already-playing track renders correctly on
  app start (the frontend also fetches the last known state on mount via
  `get_state`, covering startup with a session already active).

## Development

Prerequisites: **Node.js 18+**, **Rust** (rustup, `stable-x86_64-pc-windows-msvc`),
and **VS Build Tools** with the "Desktop development with C++" workload.

```bash
npm install        # frontend deps
npm run tauri dev  # hot-reload dev session
```

Release build (installs land in `src-tauri/target/release/bundle/`):

```bash
npm run tauri build
```

## Roadmap

- [x] Windows SMTC backend (metadata, artwork, controls, tray, autostart)
- [ ] Packaging polish: custom app/tray icon, code signing, auto-update channel
- [ ] **Phase 2 — Linux:** swap the media backend for MPRIS behind the existing
      `#[cfg(target_os)]` seam (`src-tauri/src/media.rs`), WebKitGTK frontend,
      `.AppImage`/`.deb` artifacts
- [ ] CI to build Windows + Linux artifacts on tag

## Contributing

Issues and PRs are welcome once the repo goes public. Keep the backend seam
(`media.rs`) OS-conditional — that's what keeps the Linux port cheap.

## License

[MIT](LICENSE) © 2026 wsalas19
