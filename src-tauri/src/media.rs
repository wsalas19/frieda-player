use serde::Serialize;
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
    pub art: Option<String>, // data URL (base64 PNG/JPEG)
}

static CONTROL_TX: Mutex<Option<Sender<String>>> = Mutex::new(None);

pub fn send_control(action: &str) {
    if let Some(tx) = CONTROL_TX.lock().unwrap().as_ref() {
        let _ = tx.send(action.to_string());
    }
}

pub fn spawn(app: AppHandle) {
    std::thread::spawn(move || backend_loop(app));
}

#[cfg(target_os = "windows")]
fn backend_loop(app: AppHandle) {
    use windows::Media::Control::GlobalSystemMediaTransportControlsSessionManager as SessionManager;
    use windows::Win32::System::WinRT::RoInitialize;
    use windows::Win32::System::WinRT::RO_INIT_MULTITHREADED;

    unsafe {
        // MTA is required: blocking IAsyncOperation::get() on an STA thread
        // deadlocks because completion callbacks need a message pump we don't run.
        // S_FALSE (already initialized) comes back as Err; ignore it.
        let _ = RoInitialize(RO_INIT_MULTITHREADED);
    }

    let (tx, rx) = mpsc::channel::<String>();
    *CONTROL_TX.lock().unwrap() = Some(tx);

    // RequestAsync can fail right after login; retry until it succeeds.
    let manager = loop {
        let op = unsafe { SessionManager::RequestAsync() };
        match op {
            Ok(op) => match unsafe { op.get() } {
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

    let mut last = MediaState::default();
    let mut last_art_key = String::new();
    let mut idle_rounds: u32 = 0;

    loop {
        let mut state = MediaState::default();
        let mut current_session: Option<windows::Media::Control::GlobalSystemMediaTransportControlsSession> =
            None;
        let session = unsafe { manager.GetCurrentSession() };
        if let Err(e) = &session {
            eprintln!("[wmp] GetCurrentSession error: {e}");
        }
        if let Ok(session) = session {
            current_session = Some(session.clone());
            let props = unsafe { session.TryGetMediaPropertiesAsync() }
                .and_then(|op| unsafe { op.get() });
            if let Err(e) = &props {
                eprintln!("[wmp] TryGetMediaPropertiesAsync error: {e}");
            }
            if let Ok(props) = props {
                state.available = true;
                state.title = unsafe { props.Title() }.unwrap_or_default().to_string();
                state.artist = unsafe { props.Artist() }.unwrap_or_default().to_string();
                state.album = unsafe { props.AlbumTitle() }.unwrap_or_default().to_string();

                // Re-read artwork only when the track changes — but never cache a
                // failed read, so the currently-playing track's art is retried
                // every poll until it succeeds (fixes missing art at startup).
                let art_key = format!("{}|{}|{}", state.title, state.artist, state.album);
                if art_key != last_art_key || last.art.is_none() {
                    match read_thumbnail(&props) {
                        Some(art) => {
                            last_art_key = art_key;
                            last.art = Some(art.clone());
                            state.art = Some(art);
                        }
                        None => state.art = last.art.clone(),
                    }
                } else {
                    state.art = last.art.clone();
                }
            }
            if let Ok(info) = unsafe { session.GetPlaybackInfo() } {
                use windows::Media::Control::GlobalSystemMediaTransportControlsSessionPlaybackStatus;
                state.playing = matches!(
                    unsafe { info.PlaybackStatus() }.ok(),
                    Some(GlobalSystemMediaTransportControlsSessionPlaybackStatus::Playing)
                        | Some(GlobalSystemMediaTransportControlsSessionPlaybackStatus::Changing)
                );
            }
            if let Ok(tl) = unsafe { session.GetTimelineProperties() } {
                state.position_ms = unsafe { tl.Position() }.map(|t| t.Duration as u64 / 10_000).unwrap_or(0);
                state.duration_ms = unsafe { tl.EndTime() }.map(|t| t.Duration as u64 / 10_000).unwrap_or(0);
            }

            // Drain any controls queued while polling.
            while let Ok(action) = rx.try_recv() {
                apply_control(&session, &action);
            }
        }

        if state != last {
            last = state.clone();
            let _ = app.emit("media-state", &state);
        }

        // Throttle to 5s when nothing is playing, 1s otherwise (position ticking).
        if state.available && state.playing {
            idle_rounds = 0;
        } else {
            idle_rounds += 1;
        }
        let delay = if idle_rounds > 2 { 5 } else { 1 };

        // Sleep, but wake the instant a control arrives so clicks don't wait
        // for the next poll tick; then re-poll immediately for fast feedback.
        if let Ok(action) = rx.recv_timeout(Duration::from_secs(delay)) {
            if let Some(session) = &current_session {
                apply_control(session, &action);
                while let Ok(extra) = rx.try_recv() {
                    apply_control(session, &extra);
                }
            }
        }
    }
}

#[cfg(target_os = "windows")]
fn read_thumbnail(
    props: &windows::Media::Control::GlobalSystemMediaTransportControlsSessionMediaProperties,
) -> Option<String> {
    use base64::Engine;
    use windows::Storage::Streams::DataReader;

    let thumb = unsafe { props.Thumbnail() }.ok()?;
    let stream = unsafe { thumb.OpenReadAsync() }.ok()?.get().ok()?;
    let size = unsafe { stream.Size() }.unwrap_or(0) as u32;
    if size == 0 {
        return None;
    }
    let reader = unsafe { DataReader::CreateDataReader(&stream) }.ok()?;
    unsafe { reader.LoadAsync(size) }.ok()?.get().ok()?;
    let mut bytes = vec![0u8; size as usize];
    unsafe { reader.ReadBytes(&mut bytes) }.ok()?;
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
        "play_pause" => unsafe { session.TryTogglePlayPauseAsync() }.and_then(|op| unsafe { op.get() }),
        "next" => unsafe { session.TrySkipNextAsync() }.and_then(|op| unsafe { op.get() }),
        "prev" => unsafe { session.TrySkipPreviousAsync() }.and_then(|op| unsafe { op.get() }),
        _ => return,
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
