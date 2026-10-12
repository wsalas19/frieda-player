# Manual Test Scenarios

Targeted checks for the robustness/tooling changes. Run `npm run tauri dev`
first unless a scenario says otherwise. "Card" = the widget window.

## 1. Mutex poisoning recovery

A poisoned lock must no longer take the app down.

1. Start the app, play a track so the media loop is active.
2. Trigger a panic inside the media thread (temporarily add a `panic!()` on a
   branch, or attach a debugger and force one) while the app is running.
3. **Expected:** the panic is contained; if the lock was held, later state
   reads still work instead of cascading panics. Remove the temporary panic.

> Hard to exercise by hand — the point is that `.lock().unwrap()` is gone from
> `media.rs`/`lib.rs` (see `src-tauri/src/util.rs`). A code review of
> `util::lock` usage is sufficient if you can't force a panic.

## 2. Debug instrumentation is not shipped

1. `npm run tauri dev`, change tracks, watch the console.
2. **Expected:** `[wmp:props] title=… artist=…` lines appear (debug build).
3. `npm run tauri build`, run the built app, change tracks.
4. **Expected:** no `[wmp:props]` lines in release.

## 3. Artwork settle / stale-art retry (no timer threads)

1. Play a track, then rapidly hit Next several times.
2. **Expected:** artwork always ends up matching the *current* track — never
   one track behind — after settling. Same-album skips reuse the art instantly.
3. Leave it playing a few minutes; watch for stalls.
4. **Expected:** progress bar keeps moving, controls stay responsive. (The
   delayed re-reads now ride the loop's `recv_timeout` instead of spawning a
   thread each time.)

## 4. Update confirmation flow

Needs a newer release published than the running build.

1. Right-click the tray → **Check for Updates**.
2. **Expected (update exists):** the card shows "Update vX.Y.Z is available."
   with **Update & Restart** / **Later**. Nothing downloads yet.
3. Click **Later**.
4. **Expected:** banner disappears; app keeps running; no restart.
5. Check again, click **Update & Restart**.
6. **Expected:** toast "Downloading update — the app will restart."; the
   installer runs and relaunches the app.
7. Run the same check when already current.
8. **Expected:** toast "You are on the latest version."

## 5. Volume fallback notice

1. Play from an app that has **not** created an audio session yet (or a player
   that exposes none).
2. Move the volume slider on the card.
3. **Expected:** a short toast "System volume (no app session)" appears for
   ~2s, and the system master volume changes.
4. Keep dragging the slider for several seconds.
5. **Expected:** the toast does **not** reappear or persist — it shows once per
   session and does not block the controls.
6. Play from Spotify/Chrome (which do have sessions) and move the slider.
7. **Expected:** only that app's mixer entry moves; no fallback toast.

## 6. Marquee re-measure

1. Play a track with a very long title, then a short one, then a long one.
2. **Expected:** long text drifts out and back; short text stays put. Resizing
   the card (dev tools / CSS) re-measures rather than clipping.

## 7. Clean unmount (no React warnings)

1. In dev, open the webview dev tools console.
2. Quit from the tray while a toast is visible.
3. **Expected:** no "state update on an unmounted component" warnings; the
   toast timer is cleared.

## 8. Accessibility labels

1. Focus the card and tab through the controls, or inspect with an
   accessibility tool (e.g. Accessibility Insights).
2. **Expected:** Previous track / Play|Pause / Next track / Copy card as image
   buttons and the Volume/Seek sliders expose names and values.

## 9. Version single-source

1. Bump `version` in `package.json` only.
2. `npm run tauri build`.
3. **Expected:** artifacts in `src-tauri/target/release/bundle/` are named with
   the new version (the Tauri config reads `../package.json`). `Cargo.toml`'s
   `version` stays in step manually — check it before release.

## 10. Tooling & CI

From the repo root:

```bash
npm run lint          # no errors (complexity budget is a warning)
npm run format:check  # "All matched files use Prettier code style!"
npm test              # 4 tests pass
npm run build         # tsc + vite build succeed
```

In `src-tauri/`:

```bash
cargo fmt --all -- --check
cargo clippy --all-targets
cargo test
```

Push a branch / open a PR and confirm the **CI** workflow runs both the
`frontend` and `backend` jobs.

## 11. Renamed crate

1. `npm run tauri build` (or `cargo build` in `src-tauri/`).
2. **Expected:** builds clean; the binary/crate is `frieda-player`
   (`frieda_player_lib` for the lib). No references to `wmp-project` remain.

## 12. Volume does not regress the progress bar

1. Play a track and let it run a few seconds so the bar has advanced.
2. Drag the volume slider (and/or press ↑/↓).
3. **Expected:** the progress bar keeps advancing; it does **not** jump
   backwards. Repeat several times mid-song — the bar stays in sync with the
   audio.
4. Leave it alone and let the track play to the end.
5. **Expected:** the bar reaches the end at the same time as the audio, and the
   next track starts at ~0:00 (not carrying the previous offset).
6. Seek, then immediately adjust volume.
7. **Expected:** the seek sticks and the bar continues smoothly from the new
   position.
