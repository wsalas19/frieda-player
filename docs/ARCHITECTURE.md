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
| Settings | Tiny JSON file in the app data dir (`std::fs`, no plugin) |
| Updates | `tauri-plugin-updater`, signed, fed by GitHub Releases |
| Bundle | NSIS / MSI via Tauri bundler, CI-built on version tags |

Two processes matter: the **Rust host** (`src-tauri/`) which owns the window,
tray, SMTC connection and updater, and the **webview** (`src/`) which renders
the card. They communicate over Tauri's IPC (see §4).

---

## 2. Repository layout

```
src-tauri/
  src/
    lib.rs      # Tauri setup: tray menu, autostart, settings persistence,
                # updater wiring, command registry
    media.rs    # The entire media backend (the interesting file)
    main.rs     # Entry point, calls lib::run()
  tauri.conf.json  # Window config, bundle config, updater endpoint + pubkey
  capabilities/    # Webview permission grants (CSP lives in tauri.conf.json)
  icons/           # Generated icon set (npm run tauri icon <png>)
src/
  App.tsx       # The whole UI: card, progress, controls, toasts
  theme.ts      # Artwork-driven color grading + WCAG contrast math
docs/           # This documentation, logo, screenshots
.github/workflows/release.yml   # Builds installers on v* tags (tauri-action)
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
- **Manager acquisition is resilient**: `RequestAsync()` is retried 5× at 2s
  (the "right after login" race), then drops to a 30s slow-retry forever. If
  the SMTC service is disabled, the app launches into its empty state and
  keeps quietly trying — one wake per 30s, no hang.

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
- `manager.CurrentSessionChanged` — the active media app changed (also fires
  when the last session *ends*)
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
2. **No session at all** → clear the artwork state machine (art emits `null`,
   keys reset) so the empty state doesn't wear the last track's colorway.
3. Read the session's media properties (title/artist/album),
   playback info (playing flag) and timeline (position/duration).
4. Run the artwork state machine (§3.4).
5. **Diff against last emitted state** and emit only what changed:
   - `media-state` — lightweight metadata/timeline JSON
   - `media-art` — the artwork data URL, only when the bytes changed
6. Block on the channel again.

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

The core surface is three messages; settings and updates add small ones on
top. Keeping each message small and diffed is deliberate (see §6).

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
when the artwork cleared (track change, session ended) or is unavailable.
Emitted **only** when the bytes change, so a track that keeps its album art
causes zero traffic.

### `control` — Tauri command, UI → backend

`invoke("control", { action })` where `action` is one of the transport
strings in §3.3. Also enqueued as `Msg::Control`, triggering an immediate
state re-read.

### `get_state` — Tauri command, UI → backend

Returns `{ state: MediaState, art: string | null } | null` — the last emitted
snapshot. The UI calls it once on mount: the backend may have emitted state
before the webview's listener existed (startup with a paused Tidal open), and
events are not replayed.

### Dynamic Theme — preference sync

- `get_theme_pref` — command, UI → backend. Returns the persisted boolean;
  called once on mount.
- `theme-preference` — event, backend → UI (payload `boolean`). Emitted when
  the tray toggle flips. The UI bypasses color grading when false.

Persistence lives in `lib.rs`, deliberately not `tauri-plugin-store`: one
boolean, stored as `{"enable_theme": bool}` in `settings.json` in the app
data dir via `std::fs`. A corrupted file is logged and self-healed to
defaults on next read. Single source of truth is the Rust side — the UI never
reads the file.

### Update checks — `tauri-plugin-updater`

Tray **Check for Updates** → async task checks the configured endpoint
(`releases/latest/download/latest.json` on this repo) →

- update available: emit `check-updates` with the new version (UI toasts
  "Downloading…"), then `download_and_install` and restart the app;
- current: emit `check-updates` with `null` (UI toasts "latest version");
- check failed: emit `check-updates-error` (UI toasts an apology) and log.

Artifacts are signed at build time (`createUpdaterArtifacts: true`, minisign
keypair; the public key lives in `tauri.conf.json`, the private key only in
CI secrets). Two release rules keep this working:

1. **Never publish with the "prerelease" box checked** — GitHub's
   `/releases/latest/` URL excludes prereleases, so the endpoint 404s.
2. **Never reuse a version/tag** — installed apps compare versions, not
   commits.

---

## 5. The frontend (`src/`)

### 5.1 `App.tsx`

Single component. Responsibilities:

- Renders the card: artwork, title/artist·album, progress bar, hover controls
  (prev / play-pause / next) and a click-to-seek bar that appears along the
  bottom edge on hover; version tag; toast pop-up.
- Subscribes to `media-state` and `media-art`; calls `get_state` on mount;
  follows the Dynamic Theme preference (`get_theme_pref` +
  `theme-preference`) and update-check toasts.
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

On every artwork change (and only if the Dynamic Theme setting is on), the UI
re-grades the card, after Panic's iTunes 11 algorithm
([blog post](https://blog.panic.com/itunes-11-and-colors/),
[ColorArt](https://github.com/panicinc/ColorArt)):

1. **Extract**: load the artwork via `<img>.decode()` (CSP allows `data:` for
   images; `fetch()` on them would need a `connect-src` grant — using fetch
   here is what once silently disabled grading in packaged builds), draw to a
   64×64 canvas, and tally perimeter and interior pixels into 12-bit color
   buckets (`r>>4, g>>4, b>>4`). 64×64 (not 32) so thin features — album-title
   script text, a small vivid logo — survive downsampling.
2. **Background tint**: the dominant *perimeter* bucket is the frame color —
   unless it's colorless (black bars love winning the edge vote), in which
   case the most prominent chromatic edge bucket (≥ `EDGE_SHARE` of edge
   pixels, chroma ≥ `CHROMA_NEUTRAL`) tints instead; with no chromatic edge
   at all the card stays deliberately neutral. Weak tints (muted blues,
   dusty reds) are saturation-boosted — channel spread expanded around the
   midpoint to `CHROMA_TINT_TARGET` — before being blended 40% into
   neutral-900, then darkened until white text keeps ≥ 4.5:1 WCAG contrast
   (relative luminance capped at `1.05/4.5 − 0.05`). Emitted at 0.85 alpha
   to keep the frosted transparency over the desktop.
3. **Accent**: rank ALL interior buckets by `count × chroma^4`, take the
   winner, then lighten it toward white in hue-preserving steps until it
   passes 4.5:1 against the card. Ranking *before* contrast-filtering is
   load-bearing: against a near-black card, mid-luminance vivid colors fail
   4.5:1 while pale grays pass, so filtering first deletes exactly the colors
   worth showing. If the winning bucket is itself colorless (true B&W cover),
   fall back to the most common passing bucket. White as last resort.

All WCAG math is ~15 lines of plain functions (`luminance`, `contrast`,
`mix`); `chroma` is the max−min RGB spread. No dependency. The tuning knobs
(`CHROMA_NEUTRAL`, `EDGE_SHARE`, `CHROMA_TINT_TARGET`, the exponent, `SIZE`)
are constants at the top of the file with a `ponytail:` note — calibration
history lives in the git log. Failure of any step falls back to the neutral
theme.

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
  you mirror, not a session you picked once. And when the session *ends*,
  clear the art — otherwise the empty state wears the last track's colorway.
- **Emit on diff only.** Every unchanged emit is webview work for nothing;
  every changed emit should be as small as the change is.
- **CSP applies to `fetch()`, not `<img>`.** Grading silently died in
  packaged builds because `fetch("data:…")` needed a `connect-src` grant the
  CSP (rightly) didn't give. Load images via `<img>.decode()` instead of
  loosening the policy. Corollary: a `catch(() => {})` can hide a
  permissions problem — check the packaged build, not just dev.
- **Config changes don't hot-reload.** `tauri.conf.json` (CSP, window
  config) only applies on a full `tauri dev` restart. Dev/build
  discrepancies are usually a stale dev session, not a build bug.
- **GitHub `/releases/latest/` skips prereleases.** The updater endpoint
  404s for anything published with the prerelease box checked — publish
  betas as full releases with a `beta` tag instead.

---

## 7. Building, releasing, debugging

```bash
npm install         # frontend deps
npm run tauri dev   # dev session with hot reload (restart for conf changes!)
npm run tauri build # local installers in src-tauri/target/release/bundle/
npm run tauri icon <1024px.png>   # regenerate src-tauri/icons/
```

**Releasing** is tag-driven: bump the version in `tauri.conf.json` +
`Cargo.toml` (numeric only — WiX rejects semver prerelease segments; put
"beta" in the tag), commit, `git tag vX.Y.Z && git push --tags`. CI
(`tauri-action`) builds NSIS + MSI + signed updater artifacts into a **draft**
release; review, add notes, publish with the prerelease box unchecked (§4).

Debugging: the backend logs to stderr — visible in the terminal running
`tauri dev`. Genuine error paths (SMTC manager acquisition, event binding,
control failures, update checks, settings corruption) log with a `[wmp]`
prefix; temporary debug logging in the artwork machine has historically used
`[wmp:art]` / `[wmp:emit]` and been stripped once fixes were confirmed.

Windows only today; the `#[cfg(target_os = "linux")]` stub in `media.rs`
marks the MPRIS port's landing zone.
