//! Per-app volume, with the system master volume as a fallback.
//!
//! SMTC has no volume API, so this goes straight to WASAPI. The hard part is
//! not setting the volume (one call) but *finding* the media app's audio
//! sessions: SMTC only tells us the app's AUMID (`Spotify.exe`,
//! `Microsoft.ZuneMusic_8wekyb3d8bbwe!Microsoft.ZuneMusic`), and audio
//! sessions only give us a PID. We bridge the two by resolving each session's
//! process back to an AUMID (packaged apps) or by comparing process image
//! basenames (plain desktop apps, where the AUMID is often just `Spotify.exe`
//! or `Chrome`).
//!
//! The backend thread is already MTA via `RoInitialize`, which is the same
//! internal call as `CoInitializeEx(MULTITHREADED)` — COM works here with no
//! extra init.

#[cfg(target_os = "windows")]
mod imp {
    use windows::core::{Interface, GUID, PWSTR};
    use windows::Win32::Foundation::{CloseHandle, WIN32_ERROR};
    use windows::Win32::Media::Audio::Endpoints::IAudioEndpointVolume;
    use windows::Win32::Media::Audio::{
        eMultimedia, eRender, IAudioSessionControl2, IAudioSessionManager2, IMMDeviceEnumerator,
        ISimpleAudioVolume, MMDeviceEnumerator,
    };
    use windows::Win32::Storage::Packaging::Appx::GetApplicationUserModelId;
    use windows::Win32::System::Com::{CoCreateInstance, CLSCTX_ALL};
    use windows::Win32::System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
        PROCESS_QUERY_LIMITED_INFORMATION,
    };

    /// Process image basename without extension and lowercased, or "".
    fn proc_name(pid: u32) -> String {
        unsafe {
            let Ok(h) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) else {
                return String::new();
            };
            let mut buf = [0u16; 260];
            let mut len = buf.len() as u32;
            let ok = QueryFullProcessImageNameW(
                h,
                PROCESS_NAME_WIN32,
                PWSTR(buf.as_mut_ptr()),
                &mut len,
            )
            .is_ok();
            let _ = CloseHandle(h);
            if !ok {
                return String::new();
            }
            let full = String::from_utf16_lossy(&buf[..len as usize]);
            base(&full)
        }
    }

    /// `C:\…\Spotify.exe` → `spotify`
    pub(super) fn base(path: &str) -> String {
        path.rsplit(['\\', '/'])
            .next()
            .unwrap_or("")
            .trim_end_matches(".exe")
            .to_ascii_lowercase()
    }

    /// The AUMID the OS has assigned to a process, or "" for plain desktop
    /// apps that never got one (`APPMODEL_ERROR_NO_APPLICATION`).
    fn proc_aumid(pid: u32) -> String {
        unsafe {
            let Ok(h) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) else {
                return String::new();
            };
            let mut buf = [0u16; 260];
            let mut len = buf.len() as u32;
            let rc: WIN32_ERROR = GetApplicationUserModelId(h, &mut len, Some(PWSTR(buf.as_mut_ptr())));
            let _ = CloseHandle(h);
            if rc.is_err() {
                return String::new();
            }
            String::from_utf16_lossy(&buf[..len.saturating_sub(1) as usize])
        }
    }

    /// Does this audio session's process belong to the SMTC source app?
    fn matches(pid: u32, aumid: &str) -> bool {
        if pid == 0 {
            return false;
        }
        let aumid = aumid.to_ascii_lowercase();
        if aumid.is_empty() {
            return false;
        }
        let own = proc_aumid(pid).to_ascii_lowercase();
        if !own.is_empty() {
            return own == aumid;
        }
        // Plain desktop app: compare names. The AUMID is usually the exe name
        // (`Spotify.exe`) or a bare app name (`Chrome`), matching the image
        // basename once the extension is stripped.
        let name = proc_name(pid);
        !name.is_empty() && (name == base(&aumid) || name == aumid)
    }

    /// Every audio session on the default output device that belongs to `aumid`.
    fn sessions(aumid: &str) -> Vec<ISimpleAudioVolume> {
        let mut found = Vec::new();
        unsafe {
            let Ok(enumerator) =
                CoCreateInstance::<_, IMMDeviceEnumerator>(&MMDeviceEnumerator, None, CLSCTX_ALL)
            else {
                return found;
            };
            let Ok(device) = enumerator.GetDefaultAudioEndpoint(eRender, eMultimedia) else {
                return found;
            };
            let Ok(manager) = device.Activate::<IAudioSessionManager2>(CLSCTX_ALL, None) else {
                return found;
            };
            let Ok(list) = manager.GetSessionEnumerator() else {
                return found;
            };
            let Ok(count) = list.GetCount() else {
                return found;
            };
            for i in 0..count {
                let Ok(control) = list.GetSession(i) else { continue };
                let Ok(control2) = control.cast::<IAudioSessionControl2>() else {
                    continue;
                };
                let Ok(pid) = control2.GetProcessId() else { continue };
                if !matches(pid, aumid) {
                    continue;
                }
                if let Ok(volume) = control.cast::<ISimpleAudioVolume>() {
                    found.push(volume);
                }
            }
        }
        found
    }

    fn endpoint() -> Option<IAudioEndpointVolume> {
        unsafe {
            let enumerator =
                CoCreateInstance::<_, IMMDeviceEnumerator>(&MMDeviceEnumerator, None, CLSCTX_ALL)
                    .ok()?;
            let device = enumerator.GetDefaultAudioEndpoint(eRender, eMultimedia).ok()?;
            device.Activate::<IAudioEndpointVolume>(CLSCTX_ALL, None).ok()
        }
    }

    /// Both volume setters take an optional GUID* event context we don't use.
    const NO_EVENT_CONTEXT: *const GUID = std::ptr::null();

    /// Current volume of the app's sessions, else the system master volume.
    pub fn get(aumid: &str) -> Option<f32> {
        unsafe {
            for s in sessions(aumid) {
                if let Ok(v) = s.GetMasterVolume() {
                    return Some(v);
                }
            }
            endpoint()?.GetMasterVolumeLevelScalar().ok()
        }
    }

    /// Sets every session of the app; falls back to the system volume when the
    /// app has no session yet (some apps only create one once they make sound).
    pub fn set(aumid: &str, level: f32) -> bool {
        let level = level.clamp(0.0, 1.0);
        let ours = sessions(aumid);
        if ours.is_empty() {
            return unsafe {
                endpoint().is_some_and(|e| e.SetMasterVolumeLevelScalar(level, NO_EVENT_CONTEXT).is_ok())
            };
        }
        ours.iter().all(|s| unsafe { s.SetMasterVolume(level, NO_EVENT_CONTEXT).is_ok() })
    }
}

#[cfg(target_os = "windows")]
pub use imp::{get, set};

// ponytail: no Linux/macOS mixer; the MPRIS port (Phase 2) will need its own.
#[cfg(not(target_os = "windows"))]
pub fn get(_aumid: &str) -> Option<f32> {
    None
}

#[cfg(not(target_os = "windows"))]
pub fn set(_aumid: &str, _level: f32) -> bool {
    false
}

#[cfg(all(test, target_os = "windows"))]
mod tests {
    use super::*;

    #[test]
    fn base_strips_dir_and_extension() {
        assert_eq!(imp::base(r"C:\Users\x\AppData\Local\Spotify.exe"), "spotify");
        assert_eq!(imp::base("Chrome"), "chrome");
        assert_eq!(imp::base(""), "");
    }
}
