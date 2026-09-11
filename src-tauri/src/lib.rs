mod media;

use tauri::{
    menu::{CheckMenuItem, Menu, MenuItem, Submenu},
    tray::TrayIconBuilder,
    Manager,
};

#[tauri::command]
fn control(action: String) {
    media::send_control(&action);
}

#[tauri::command]
fn get_state() -> Option<media::Snapshot> {
    media::current_state()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .invoke_handler(tauri::generate_handler![control, get_state])
        .setup(|app| {
            let show = MenuItem::with_id(app, "show", "Show / Hide Widget", true, None::<&str>)?;
            let on_top = CheckMenuItem::with_id(app, "on_top", "Always on Top", true, true, None::<&str>)?;
            let autostart = CheckMenuItem::with_id(app, "autostart", "Run at Startup", true, false, None::<&str>)?;
            let updates = MenuItem::with_id(app, "updates", "Check for Updates", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let settings = Submenu::with_id(app, "settings", "Settings", true)?;
            settings.append(&on_top)?;
            settings.append(&autostart)?;
            let menu = Menu::with_items(app, &[&show, &settings, &updates, &quit])?;

            let on_top = on_top.clone();
            let autostart = autostart.clone();
            TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("Media Widget")
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
                    "updates" => {
                        use tauri::Emitter;
                        let _ = app.emit("check-updates", ());
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
