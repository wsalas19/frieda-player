use serde::Serialize;
use std::ffi::c_void;
use std::sync::mpsc::{self, Sender};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter};

#[derive(Serialize, Clone, Default, PartialEq)]
pub struct MediaState {
    pub available: bool,
    pub title: String,
    pub artist: String,
    pub album: String,
    pub position_ms: u64,
    pub duration_ms: u64,
    pub playing: bool,
}

/// Startup snapshot: last known state + artwork, so the UI can sync on mount
/// even if events fired before its listener existed.
#[derive(Serialize, Clone)]
pub struct Snapshot {
    pub state: MediaState,
    pub art: Option<String>,
}

/// What wakes the backend loop: SMTC change events, or a UI control action.
enum Msg {
    Refresh,
    Control(String),
}

static CONTROL_TX: Mutex<Option<Sender<Msg>>> = Mutex::new(None);
// Last emitted state, so the UI can sync on mount (startup with an
// already-playing/paused session fires before the frontend listener exists).
static LAST_STATE: Mutex<Option<MediaState>> = Mutex::new(None);
static LAST_ART: Mutex<Option<String>> = Mutex::new(None);

pub fn current_state() -> Option<Snapshot> {
    let state = LAST_STATE.lock().unwrap().clone()?;
    Some(Snapshot {
        state,
        art: LAST_ART.lock().unwrap().clone(),
    })
}

pub fn send_control(action: &str) {
    if let Some(tx) = CONTROL_TX.lock().unwrap().as_ref() {
        let _ = tx.send(Msg::Control(action.to_string()));
    }
}

pub fn spawn(app: AppHandle) {
    std::thread::spawn(move || backend_loop(app));
}

#[cfg(target_os = "windows")]
fn backend_loop(app: AppHandle) {
    use windows::Media::Control::{
        GlobalSystemMediaTransportControlsSession as Session,
        GlobalSystemMediaTransportControlsSessionManager as SessionManager,
        GlobalSystemMediaTransportControlsSessionPlaybackStatus,
    };
    use windows::Win32::System::WinRT::RoInitialize;
    use windows::Win32::System::WinRT::RO_INIT_MULTITHREADED;

    unsafe {
        // MTA is required: blocking IAsyncOperation::get() on an STA thread
        // deadlocks because completion callbacks need a message pump we don't run.
        // S_FALSE (already initialized) comes back as Err; ignore it.
        let _ = RoInitialize(RO_INIT_MULTITHREADED);
    }

    let (tx, rx) = mpsc::channel::<Msg>();
    *CONTROL_TX.lock().unwrap() = Some(tx.clone());

    // RequestAsync can fail right after login; retry until it succeeds.
    let manager = loop {
        match SessionManager::RequestAsync() {
            Ok(op) => match op.get() {
                Ok(m) => {
                    eprintln!("[wmp] SMTC manager acquired");
                    break m;
                }
                Err(e) => {
                    eprintln!("[wmp] RequestAsync get failed: {e}");
                    std::thread::sleep(Duration::from_secs(2));
                }
            },
            Err(e) => {
                eprintln!("[wmp] RequestAsync failed: {e}");
                std::thread::sleep(Duration::from_secs(2));
            }
        }
    };

    // Event-driven: any change wakes the loop instantly, no polling.
    if let Err(e) = manager.CurrentSessionChanged(&wake_handler(tx.clone())) {
        eprintln!("[wmp] CurrentSessionChanged bind failed: {e}");
    }

    let mut last = MediaState::default();
    // Current artwork bytes, emitted separately from the lightweight state.
    let mut last_art: Option<String> = None;
    // Some(track key) = art is current for that track; None = track changed,
    // art cleared, waiting for SMTC to settle before re-reading.
    let mut last_art_key: Option<String> = None;
    // Previous track's art bytes: SMTC keeps serving the OLD artwork stream
    // for a while after a track change; identical bytes mean a stale read.
    let mut prev_art: Option<String> = None;
    let mut stale_reads: u32 = 0;
    // Session whose change events we're currently subscribed to.
    let mut bound: Option<Session> = None;

    // ponytail: 5s re-sync instead of the old 1s poll; the frontend
    // interpolates position in between, so events carry all real changes.
    loop {
        let mut state = MediaState::default();
        let mut art = last_art.clone();

        // Rebind change events whenever the active session changes (this also
        // covers the very first session appearing).
        let current = manager.GetCurrentSession().ok();
        if session_key(current.as_ref()) != session_key(bound.as_ref()) {
            if let Some(s) = &current {
                bind_session(s, &tx);
            }
            bound = current.clone();
        }

        if let Some(session) = &current {
            let props = session
                .TryGetMediaPropertiesAsync()
                .and_then(|op| op.get());
            if let Err(e) = &props {
                eprintln!("[wmp] TryGetMediaPropertiesAsync error: {e}");
            }
            if let Ok(props) = props {
                state.available = true;
                state.title = props.Title().unwrap_or_default().to_string();
                state.artist = props.Artist().unwrap_or_default().to_string();
                state.album = props.AlbumTitle().unwrap_or_default().to_string();

                // SMTC hands out the PREVIOUS track's thumbnail stream for a
                // short moment after the metadata event fires, so reading art
                // in the same tick as a track change yields stale bytes (art
                // lags one track behind). On a track change: clear art, then
                // self-wake and read once the provider has settled.
                let art_key = format!("{}|{}|{}", state.title, state.artist, state.album);
                match &last_art_key {
                    None => {
                        // Settled (or startup): attempt the read, retry soon on failure.
                        if let Some(a) = read_thumbnail(&props) {
                            // Byte-identical to the previous track's art = SMTC
                            // is still serving the old stream; retry until it
                            // swaps. ponytail: cap of 5 guards back-to-back
                            // tracks that legitimately share artwork — after
                            // ~5s of retries we accept the read.
                            if prev_art.as_ref() == Some(&a) && stale_reads < 5 {
                                stale_reads += 1;
                                wake_later(&tx, Duration::from_secs(1));
                            } else {
                                stale_reads = 0;
                                last_art_key = Some(art_key);
                                art = Some(a);
                            }
                        } else {
                            wake_later(&tx, Duration::from_secs(1));
                        }
                    }
                    Some(key) if *key != art_key => {
                        if !state.album.is_empty() && state.album == last.album {
                            // Same album → the "stale" stream SMTC is still
                            // serving IS the correct artwork; reuse it.
                            last_art_key = Some(art_key);
                        } else {
                            // Track changed: keep the old bytes for staleness
                            // detection, clear art from the UI, read once settled.
                            prev_art = art.take();
                            stale_reads = 0;
                            last_art_key = None;
                            wake_later(&tx, Duration::from_millis(500));
                        }
                    }
                    Some(_) => {}
                }
            }
            if let Ok(info) = session.GetPlaybackInfo() {
                state.playing = matches!(
                    info.PlaybackStatus().ok(),
                    Some(GlobalSystemMediaTransportControlsSessionPlaybackStatus::Playing)
                        | Some(GlobalSystemMediaTransportControlsSessionPlaybackStatus::Changing)
                );
            }
            if let Ok(tl) = session.GetTimelineProperties() {
                state.position_ms = tl.Position().map(|t| t.Duration as u64 / 10_000).unwrap_or(0);
                state.duration_ms = tl.EndTime().map(|t| t.Duration as u64 / 10_000).unwrap_or(0);
            }
        }

        // Art travels in its own tiny-diff event: it only fires when the bytes
        // actually change, so the frequent position/metadata ticks never carry
        // the (large) base64 payload.
        if art != last_art {
            last_art = art.clone();
            *LAST_ART.lock().unwrap() = last_art.clone();
            let _ = app.emit("media-art", &art);
        }
        if state != last {
            last = state.clone();
            *LAST_STATE.lock().unwrap() = Some(state.clone());
            let _ = app.emit("media-state", &state);
        }

        // Block until an SMTC event fires, a control arrives, or the 5s
        // position re-sync is due. Controls trigger an immediate re-read.
        match rx.recv_timeout(Duration::from_secs(5)) {
            Ok(Msg::Control(action)) => {
                if let Some(session) = &current {
                    apply_control(session, &action);
                    while let Ok(Msg::Control(extra)) = rx.try_recv() {
                        apply_control(session, &extra);
                    }
                }
            }
            Ok(Msg::Refresh) | Err(_) => {}
        }
    }
}

/// SMTC event handler that just wakes the backend loop; generic because each
/// WinRT event carries its own sender/args types (inferred at the call site).
#[cfg(target_os = "windows")]
fn wake_handler<T, A>(tx: Sender<Msg>) -> windows::Foundation::TypedEventHandler<T, A>
where
    T: windows::core::RuntimeType,
    A: windows::core::RuntimeType,
{
    windows::Foundation::TypedEventHandler::new(move |_, _| {
        let _ = tx.send(Msg::Refresh);
        Ok(())
    })
}

/// One-shot delayed refresh: lets SMTC settle before the next state read.
#[cfg(target_os = "windows")]
fn wake_later(tx: &Sender<Msg>, delay: Duration) {
    let tx = tx.clone();
    std::thread::spawn(move || {
        std::thread::sleep(delay);
        let _ = tx.send(Msg::Refresh);
    });
}

#[cfg(target_os = "windows")]
fn session_key(
    session: Option<&windows::Media::Control::GlobalSystemMediaTransportControlsSession>,
) -> Option<*mut c_void> {
    use windows::core::{Interface, IUnknown};
    session
        .and_then(|s| s.cast::<IUnknown>().ok())
        .map(|u| u.as_raw())
}

#[cfg(target_os = "windows")]
fn bind_session(
    session: &windows::Media::Control::GlobalSystemMediaTransportControlsSession,
    tx: &Sender<Msg>,
) {
    // Each SMTC event carries its own EventArgs type; every handler just
    // wakes the backend loop.
    for bind in [
        session.MediaPropertiesChanged(&wake_handler(tx.clone())),
        session.PlaybackInfoChanged(&wake_handler(tx.clone())),
        session.TimelinePropertiesChanged(&wake_handler(tx.clone())),
    ] {
        if let Err(e) = bind {
            eprintln!("[wmp] session event bind failed: {e}");
        }
    }
}

#[cfg(target_os = "windows")]
fn read_thumbnail(
    props: &windows::Media::Control::GlobalSystemMediaTransportControlsSessionMediaProperties,
) -> Option<String> {
    use base64::Engine;
    use windows::Storage::Streams::DataReader;

    let thumb = props.Thumbnail().ok()?;
    let stream = thumb.OpenReadAsync().ok()?.get().ok()?;
    let size = stream.Size().unwrap_or(0) as u32;
    if size == 0 {
        return None;
    }
    let reader = DataReader::CreateDataReader(&stream).ok()?;
    reader.LoadAsync(size).ok()?.get().ok()?;
    let mut bytes = vec![0u8; size as usize];
    reader.ReadBytes(&mut bytes).ok()?;
    let mime = if bytes.starts_with(&[0x89, b'P', b'N', b'G']) {
        "image/png"
    } else {
        "image/jpeg"
    };
    Some(format!(
        "data:{};base64,{}",
        mime,
        base64::engine::general_purpose::STANDARD.encode(bytes)
    ))
}

#[cfg(target_os = "windows")]
fn apply_control(
    session: &windows::Media::Control::GlobalSystemMediaTransportControlsSession,
    action: &str,
) {
    let result = match action {
        "play_pause" => session.TryTogglePlayPauseAsync().and_then(|op| op.get()),
        "next" => session.TrySkipNextAsync().and_then(|op| op.get()),
        "prev" => session.TrySkipPreviousAsync().and_then(|op| op.get()),
        // TimeSpan is in 100ns ticks.
        _ => match action.strip_prefix("seek:").and_then(|ms| ms.parse::<i64>().ok()) {
            Some(ms) => session
                .TryChangePlaybackPositionAsync(ms * 10_000)
                .and_then(|op| op.get()),
            None => return,
        },
    };
    if let Err(e) = result {
        eprintln!("control '{action}' failed: {e}");
    }
}

// Linux (MPRIS) implementation is a Phase 2 milestone; keep a stub so the
// frontend contract is already in place.
#[cfg(target_os = "linux")]
fn backend_loop(app: AppHandle) {
    let _ = app;
    unimplemented!("MPRIS backend arrives in Phase 2")
}
