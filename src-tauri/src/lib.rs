mod media;

use std::sync::Mutex;
use tauri::{
    menu::{CheckMenuItem, Menu, MenuItem, Submenu},
    tray::TrayIconBuilder,
    AppHandle, Manager,
};

// Dynamic-theme preference: one boolean, persisted as a tiny JSON file so the
// tray checkbox and the frontend agree across restarts. ponytail: std::fs
// instead of tauri-plugin-store; swap if real settings accumulate.
static THEME_ENABLED: Mutex<bool> = Mutex::new(true);

fn data_file(app: &AppHandle, name: &str) -> Option<std::path::PathBuf> {
    Some(app.path().app_data_dir().ok()?.join(name))
}

fn settings_path(app: &AppHandle) -> Option<std::path::PathBuf> {
    data_file(app, "settings.json")
}

fn load_theme_pref(app: &AppHandle) -> bool {
    let Some(path) = settings_path(app) else {
        return true;
    };
    let Ok(content) = std::fs::read_to_string(&path) else {
        return true; // missing: default; written on first toggle
    };
    match serde_json::from_str::<serde_json::Value>(&content)
        .ok()
        .and_then(|v| v.get("enable_theme").and_then(|b| b.as_bool()))
    {
        Some(enabled) => enabled,
        None => {
            // Corrupted: self-heal by overwriting with the default config.
            eprintln!("[wmp] settings.json corrupted; resetting to defaults");
            save_theme_pref(app, true);
            true
        }
    }
}

fn save_theme_pref(app: &AppHandle, enabled: bool) {
    if let Some(path) = settings_path(app) {
        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let _ = std::fs::write(
            path,
            serde_json::json!({ "enable_theme": enabled }).to_string(),
        );
    }
}

#[tauri::command]
fn control(action: String) {
    media::send_control(&action);
}

#[tauri::command]
fn get_state() -> Option<media::Snapshot> {
    media::current_state()
}

#[tauri::command]
fn get_theme_pref() -> bool {
    *THEME_ENABLED.lock().unwrap()
}

// User/community colorway additions, same JSON schema as the embedded file.
#[tauri::command]
fn read_user_colorways(app: AppHandle) -> Option<String> {
    let path = data_file(&app, "colorways.json")?;
    std::fs::read_to_string(path).ok()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            control,
            get_state,
            get_theme_pref,
            read_user_colorways
        ])
        .setup(|app| {
            let show = MenuItem::with_id(app, "show", "Show / Hide Widget", true, None::<&str>)?;
            let on_top = CheckMenuItem::with_id(app, "on_top", "Always on Top", true, true, None::<&str>)?;
            let autostart = CheckMenuItem::with_id(app, "autostart", "Run at Startup", true, false, None::<&str>)?;
            let theme_on = load_theme_pref(app.handle());
            *THEME_ENABLED.lock().unwrap() = theme_on;
            let dynamic_theme = CheckMenuItem::with_id(app, "dynamic_theme", "Dynamic Theme", true, theme_on, None::<&str>)?;
            let updates = MenuItem::with_id(app, "updates", "Check for Updates", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let settings = Submenu::with_id(app, "settings", "Settings", true)?;
            settings.append(&on_top)?;
            settings.append(&autostart)?;
            settings.append(&dynamic_theme)?;
            let menu = Menu::with_items(app, &[&show, &settings, &updates, &quit])?;

            let on_top = on_top.clone();
            let autostart = autostart.clone();
            let dynamic_theme = dynamic_theme.clone();
            TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("Frieda Player")
                .menu(&menu)
                .on_menu_event(move |app, event| match event.id.as_ref() {
                    "show" => {
                        if let Some(win) = app.get_webview_window("main") {
                            if win.is_visible().unwrap_or(false) {
                                let _ = win.hide();
                            } else {
                                let _ = win.show();
                                let _ = win.set_focus();
                            }
                        }
                    }
                    "on_top" => {
                        if let Some(win) = app.get_webview_window("main") {
                            let _ = win.set_always_on_top(on_top.is_checked().unwrap_or(true));
                        }
                    }
                    "autostart" => {
                        use tauri_plugin_autostart::ManagerExt;
                        let mgr = app.autolaunch();
                        if autostart.is_checked().unwrap_or(false) {
                            let _ = mgr.enable();
                        } else {
                            let _ = mgr.disable();
                        }
                    }
                    "dynamic_theme" => {
                        let enabled = dynamic_theme.is_checked().unwrap_or(true);
                        *THEME_ENABLED.lock().unwrap() = enabled;
                        save_theme_pref(app, enabled);
                        use tauri::Emitter;
                        let _ = app.emit("theme-preference", enabled);
                    }
                    "updates" => {
                        // Real updater check: emit Some(version) when an update
                        // exists (and install + restart), None when current.
                        let a = app.clone();
                        tauri::async_runtime::spawn(async move {
                            use tauri::Emitter;
                            use tauri_plugin_updater::UpdaterExt;
                            let updater = match a.updater() {
                                Ok(u) => u,
                                Err(e) => {
                                    eprintln!("[wmp] updater unavailable: {e}");
                                    return;
                                }
                            };
                            match updater.check().await {
                                Ok(Some(update)) => {
                                    let ver = update.version.clone();
                                    let _ = a.emit("check-updates", Some(ver));
                                    if let Err(e) =
                                        update.download_and_install(|_, _| {}, || {}).await
                                    {
                                        eprintln!("[wmp] update install failed: {e}");
                                        return;
                                    }
                                    a.restart();
                                }
                                Ok(None) => {
                                    let _ = a.emit("check-updates", None::<String>);
                                }
                                Err(e) => {
                                    eprintln!("[wmp] update check failed: {e}");
                                    use tauri::Emitter;
                                    let _ = a.emit("check-updates-error", ());
                                }
                            }
                        });
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .build(app)?;

            media::spawn(app.handle().clone());
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
