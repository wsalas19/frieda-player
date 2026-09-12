# Frieda Player — Technical Documentation

A technical reference for developers, regardless of stack. Explains what the
app does, how every piece works, and why the non-obvious decisions were made.

---

## 1. What the app is

Frieda Player is a **floating now-playing widget for Windows**. It is a small,
frameless, always-on-top card that mirrors whatever media is playing system
wide, and offers transport controls (prev / play-pause / next / seek) back to
that media.

It is **not a player**. It never touches audio, files, or playback state. It
is a *reader and remote* for the operating system's media infrastructure:

```
┌──────────────┐   SMTC (OS service)   ┌───────────────┐   UI   ┌───────────────┐
│ Spotify,     │ ────────────────────▶ │ Frieda Player │ ─────▶ │ your desktop  │
│ Tidal, Edge… │ ◀──────────────────── │  (this app)   │        │               │
└──────────────┘   transport commands  └───────────────┘        └───────────────┘
```

The OS bridge is **SMTC — System Media Transport Controls**, the same Windows
service that powers the volume-flyout media card. Any app that registers with
it (Spotify, Tidal, browsers, foobar2000…) exposes metadata, artwork, timeline
and accepts transport commands. Frieda reads that feed and writes controls
back to it.

### Stack

| Layer | Technology |
|---|---|
| Shell / windowing / IPC | Tauri 2 (Rust host + system webview) |
| Media backend | Rust, `windows` crate 0.61 (WinRT, `Media_Control`) |
| UI | React + TypeScript, Tailwind CSS |
| Bundle | NSIS / MSI via Tauri bundler |

Two processes matter: the **Rust host** (`src-tauri/`) which owns the window,
tray and SMTC connection, and the **webview** (`src/`) which renders the card.
They communicate over Tauri's IPC (see §4).

---

## 2. Repository layout

```
src-tauri/
  src/
    lib.rs      # Tauri setup: tray menu, autostart, window mgmt, command registry
    media.rs    # The entire media backend (the interesting file)
    main.rs     # Entry point, calls lib::run()
  tauri.conf.json  # Window config, bundle config, icon manifest
  icons/           # Generated icon set (npm run tauri icon <png>)
src/
  App.tsx       # The whole UI: card, progress, controls
  theme.ts      # Artwork-driven color grading + WCAG contrast math
docs/           # This documentation, icon sources
```

If you are porting to another OS, `media.rs` is the only file you touch — it
has `#[cfg(target_os = "...")]` seams (a Linux/MPRIS implementation is planned
and stubbed).

---

## 3. The media backend (`src-tauri/src/media.rs`)

### 3.1 WinRT fundamentals you need

- SMTC is a **WinRT** (Windows Runtime) API, consumed through the `windows`
  crate. The central object is
  `GlobalSystemMediaTransportControlsSessionManager` ("the manager"), which
  enumerates media **sessions** — one per media app.
- The backend thread initializes WinRT as **MTA (multithreaded apartment)**.
  This is mandatory: the code blocks on `IAsyncOperation::get()`, which on an
  STA thread deadlocks because WinRT completion callbacks need a message pump
  the thread doesn't run.
- WinRT calls through `windows` 0.61 are memory-safe; the only `unsafe` in the
  codebase is the single `RoInitialize` call.

### 3.2 Architecture: one thread, one channel, event-driven

The backend is a single OS thread running a loop, woken by messages on an
`mpsc` channel:

```rust
enum Msg {
    Refresh,          // "something changed, re-read SMTC state"
    Control(String),  // "user clicked something in the UI"
}
```

Producers of `Msg::Refresh`:
- `manager.CurrentSessionChanged` — the active media app changed
- `session.MediaPropertiesChanged` — track metadata changed
- `session.PlaybackInfoChanged` — play/pause state changed
- `session.TimelinePropertiesChanged` — position/seek happened
- delayed self-wakes (`wake_later`) used by the artwork state machine (§3.4)

Producers of `Msg::Control`: the UI, via the `control` Tauri command.

**There is no polling.** The loop blocks on `rx.recv_timeout(5s)`; the timeout
exists only to periodically re-sync the playback position, because SMTC does
not emit an event every second during normal playback — the frontend
interpolates position locally between real updates (§5.2).

Loop iteration, in order:
1. Re-fetch `GetCurrentSession()`. If the session identity changed (compared
   by raw `IUnknown` pointer via `session_key()`), rebind the three session
   event handlers to the new session.
2. Read the session's media properties (title/artist/album),
   playback info (playing flag) and timeline (position/duration).
3. Run the artwork state machine (§3.4).
4. **Diff against last emitted state** and emit only what changed:
   - `media-state` — lightweight metadata/timeline JSON
   - `media-art` — the artwork data URL, only when the bytes changed
5. Block on the channel again.

The diffing matters: position ticks arrive often, artwork is large, and
nothing should travel over IPC unless it changed (see §6, pitfalls).

### 3.3 Transport controls

`apply_control` maps action strings to WinRT async calls:

| Action | SMTC call |
|---|---|
| `play_pause` | `TryTogglePlayPauseAsync` |
| `next` | `TrySkipNextAsync` |
| `prev` | `TrySkipPreviousAsync` |
| `seek:<ms>` | `TryChangePlaybackPositionAsync(ms * 10_000)` — TimeSpan is 100ns ticks |

All are fire-and-forget from the UI's perspective: the provider fires
`TimelinePropertiesChanged`/`PlaybackInfoChanged` afterwards, which wakes the
loop and pushes the authoritative state back to the UI. If a provider rejects
a command (e.g. doesn't support seek), the next timeline tick snaps the UI
back to reality.

### 3.4 The artwork state machine (the hard part)

Naïve implementations are wrong because **providers lag their own artwork**.
Tidal (and others) keep serving the *previous* track's thumbnail stream for
seconds after the metadata event fires; the title settles before the art does.
Worse, an early read usually *succeeds* — with the wrong bytes. A fixed delay
cannot fix this (the lag varies; 2s was still too short in practice).

The working design is **detection, not timing**, built from three variables:

```
last_art_key: Option<String>  // Some(track key) = art is current
                              // None = track changed, awaiting settle
prev_art:     Option<String>  // previous track's art bytes, for comparison
stale_reads:  u32             // retry counter
```

Per iteration, given the new track's key `title|artist|album`:

1. **Track changed** (key differs, different album): keep the old bytes in
   `prev_art`, clear the UI's art (skeleton appears), self-wake in 500ms.
2. **Same album**: the lingering stream is *by definition* the correct
   artwork — reuse it immediately, no retry dance.
3. **Awaiting settle**: read the thumbnail.
   - Read **fails** → art not available yet; retry in 1s. (Failures are
     good: they return nothing rather than wrong bytes.)
   - Read **succeeds but bytes are identical to `prev_art`** → stale stream;
     retry in 1s, up to 5 times. The cap tolerates back-to-back tracks that
     legitimately share artwork (compilations) — after ~5s we accept.
   - Read succeeds with **different** bytes → correct art; emit.

Key insight, worth restating: *a failed read is safe, a successful early read
is the dangerous one.* Only byte-identity with the previous track's art proves
staleness.

Artwork decoding (`read_thumbnail`): `Thumbnail()` → `OpenReadAsync()` →
`Size` → `DataReader.LoadAsync/ReadBytes` → sniff PNG/JPEG magic bytes →
base64 `data:` URL.

---

## 4. IPC contract (backend ↔ UI)

Three messages. This is the entire surface — keeping it small is deliberate.

### `media-state` — Tauri event, backend → UI

```json
{
  "available": true,       // a media session exists
  "title": "Song", "artist": "Artist", "album": "Album",
  "position_ms": 61234, "duration_ms": 214000,
  "playing": true
}
```

Emitted only on change (diff vs. last emitted). Small payload by design —
position re-syncs must not drag megabytes with them.

### `media-art` — Tauri event, backend → UI

`string | null` — a base64 `data:image/png;base64,…` / JPEG URL, or `null`
when the artwork cleared (track change) or is unavailable. Emitted **only**
when the bytes change, so a track that keeps its album art causes zero
traffic.

### `control` — Tauri command, UI → backend

`invoke("control", { action })` where `action` is one of the transport
strings in §3.3. Also enqueued as `Msg::Control`, triggering an immediate
state re-read.

### `get_state` — Tauri command, UI → backend

Returns `{ state: MediaState, art: string | null } | null` — the last emitted
snapshot. The UI calls it once on mount: the backend may have emitted state
before the webview's listener existed (startup with a paused Tidal open), and
events are not replayed.

---

## 5. The frontend (`src/`)

### 5.1 `App.tsx`

Single component. Responsibilities:

- Renders the card: artwork, title/artist·album, progress bar, hover controls
  (prev / play-pause / next) and a click-to-seek bar that appears along the
  bottom edge on hover.
- Subscribes to `media-state` and `media-art`; calls `get_state` on mount.
- **Optimistic UI**: play/pause flips its icon and seek jumps the bar
  immediately, before the backend confirms. The next backend event
  reconciles. A 2s timer un-sticks the pending spinner if no event arrives.
- **Position interpolation**: SMTC doesn't emit every second, so a 250ms
  local timer advances the position between real backend updates
  (`position + (now - last_update)` while playing).

Window dragging works because most elements carry `data-tauri-drag-region`;
the hover overlay is `pointer-events-none` except the buttons and the seek
bar, so the card stays draggable *through* the overlay.

### 5.2 `theme.ts` — artwork color grading

On every artwork change, the UI re-grades the card:

1. **Extract**: draw the artwork to a 16×16 canvas, average the opaque
   pixels. Data-URL images don't taint the canvas, so this is pure frontend.
2. **Background**: neutral-900 tinted with ~12% of the extracted color,
   darkened until white text keeps ≥ 4.5:1 WCAG contrast (relative luminance
   capped at `1.05/4.5 − 0.05`). Emitted at 0.85 alpha to keep the frosted
   transparency over the desktop.
3. **Accent**: the art color, iteratively mixed toward white until it hits
   4.5:1 against the computed background (also satisfies the 3:1 non-text
   minimum for the progress bar); white fallback when unreachable.

All WCAG math is ~15 lines of plain functions (`luminance`, `contrast`,
`mix`). No dependency. Failure of any step falls back to the neutral theme.

---

## 6. Pitfalls we hit (so you don't again)

- **Blocking WinRT on STA** deadlocks silently. Initialize MTA
  (`RoInitialize(RO_INIT_MULTITHREADED)`); `S_FALSE` comes back as `Err`,
  ignore it.
- **Don't put the artwork in the state payload.** Position re-syncs are
  frequent; a base64 blob riding along every emit caused UI updates to be
  delayed/dropped until user interaction. Separate event, diffed on bytes.
- **SMTC artwork lags metadata** (§3.4). Never trust a thumbnail read in the
  same tick as a track change — and never fall back to "keep the old art",
  that's exactly how one-track-lag looks.
- **Session identity ≠ session object.** Rebind event handlers when the raw
  pointer (`session_key`) changes; the manager's "current session" is what
  you mirror, not a session you picked once.
- **Emit on diff only.** Every unchanged emit is webview work for nothing;
  every changed emit should be as small as the change is.

---

## 7. Building and debugging

```bash
npm install         # frontend deps
npm run tauri dev   # dev session with hot reload
npm run tauri build # installers in src-tauri/target/release/bundle/
npm run tauri icon <1024px.png>   # regenerate src-tauri/icons/
```

Debugging: the backend logs to stderr — visible in the terminal running
`tauri dev`. Genuine error paths (SMTC manager acquisition, event binding,
control failures) log with a `[wmp]` prefix; temporary debug logging in the
artwork machine has historically used `[wmp:art]` / `[wmp:emit]` and been
stripped once fixes were confirmed.

Windows only today; the `#[cfg(target_os = "linux")]` stub in `media.rs`
marks the MPRIS port's landing zone.
