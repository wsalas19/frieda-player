# Media Widget

A lightweight, frameless floating desktop widget that shows now-playing media
from the Windows System Media Transport Controls (SMTC) — works with Spotify,
browsers (Edge/Chrome), Apple Music, and any app that integrates with the
Windows media flyout.

Built with **Tauri 2** (Rust backend + React/TypeScript/Tailwind frontend).

## Features

- Frameless, transparent, draggable floating card (400×120), always-on-top by default
- Album artwork, title, artist · album, and a live progress bar
- Hover controls: previous / play-pause / next (SMTC transport commands)
- System tray icon with: Show/Hide, Settings (Always on Top, Run at Startup),
  Check for Updates, Quit
- Low footprint: the backend polls SMTC at 1 Hz while playing and throttles to
  every 5 s when idle; updates are only emitted on state changes; the frontend
  interpolates the progress bar locally between ticks
- Linux (MPRIS) is a Phase 2 goal — the backend is isolated in
  `src-tauri/src/media.rs` behind `#[cfg(target_os)]` for a clean swap

## Development

Prerequisites: Node.js 18+, Rust (rustup, MSVC toolchain), VS Build Tools
(C++ workload) on Windows.

```bash
npm install
npm run tauri dev
```

## Build

```bash
npm run tauri build
```

Artifacts land in `src-tauri/target/release/bundle/`:
- `nsis/Media Widget_0.1.0_x64-setup.exe`
- `msi/Media Widget_0.1.0_x64_en-US.msi`
- the raw binary is `src-tauri/target/release/wmp-project.exe`

## Architecture

| Piece | Where |
| --- | --- |
| SMTC polling loop, state diffing, artwork → base64, control channel | `src-tauri/src/media.rs` |
| Tray menu, autostart plugin, window toggling | `src-tauri/src/lib.rs` |
| Widget UI (drag region, hover controls, progress interpolation) | `src/App.tsx` |

Backend → frontend event: `media-state` (`MediaState` JSON).
Frontend → backend command: `control` with `action` = `play_pause | next | prev`.
