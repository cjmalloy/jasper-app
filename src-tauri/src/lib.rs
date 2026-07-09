mod docker;
mod settings;
mod state;
mod windows;

use serde_json::Value;
use std::sync::atomic::Ordering;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager, RunEvent, State, WindowEvent};
use tauri_plugin_dialog::{DialogExt, MessageDialogKind};
use tauri_plugin_opener::OpenerExt;

use state::AppState;

/// `fetch-settings`: returns the settings JSON (with the app version), and
/// emits `update-settings` to the settings window like Electron did.
#[tauri::command]
fn fetch_settings(app: AppHandle, state: State<AppState>) -> Value {
    let data = {
        let mut settings = state.settings.lock().unwrap();
        settings.data["appVersion"] = Value::String(app.package_info().version.to_string());
        settings.data.clone()
    };
    let _ = app.emit_to("settings", "update-settings", data.clone());
    data
}

/// `settings-value`: port of Electron `updateSettings()` — merge, persist,
/// then hard-restart the docker compose stack.
#[tauri::command]
fn settings_value(app: AppHandle, state: State<AppState>, settings: Value) {
    state.settings.lock().unwrap().update(&settings);
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.hide();
    }
    state.first_load.store(false, Ordering::Relaxed);
    tauri::async_runtime::spawn(async move {
        let _ = docker::dc(&app, "down").await;
        start_server(&app);
        show_loading(&app);
    });
}

/// `settings-patch`: port of Electron `patchSettings()`.
#[tauri::command]
fn settings_patch(state: State<AppState>, patch: Value) {
    let (Some(name), Some(value)) = (
        patch.get("name").and_then(Value::as_str),
        patch.get("value"),
    ) else {
        return;
    };
    state.settings.lock().unwrap().patch(name, value.clone());
}

/// `command`: runs the named docker compose action (up/down/pull/restart/...)
/// and notifies the settings window with `finished` when done.
#[tauri::command]
fn command(app: AppHandle, value: String) {
    docker::notify(&app, value);
}

/// `open-dir`: opens a path with the system file manager.
#[tauri::command]
fn open_dir(app: AppHandle, path: String) {
    let _ = app.opener().open_path(path, None::<&str>);
}

fn show_window(app: &AppHandle, label: &str) {
    if let Some(win) = app.get_webview_window(label) {
        let _ = win.show();
        let _ = win.set_focus();
    }
}

fn show_loading(app: &AppHandle) {
    show_window(app, "loading");
}

fn show_logs_window(app: &AppHandle) {
    show_window(app, "logs");
}

fn show_settings_window(app: &AppHandle) {
    show_window(app, "settings");
    let data = {
        let state = app.state::<AppState>();
        let mut settings = state.settings.lock().unwrap();
        settings.data["appVersion"] = Value::String(app.package_info().version.to_string());
        settings.data.clone()
    };
    let _ = app.emit_to("settings", "update-settings", data);
}

/// Port of the Electron `startServer()`: spawns `docker compose up` and shows
/// error dialogs if docker compose is missing or docker is not running.
fn start_server(app: &AppHandle) {
    {
        let state = app.state::<AppState>();
        let show_logs = state.settings.lock().unwrap().flag("showLogsOnStart");
        if show_logs {
            show_logs_window(app);
        }
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        match docker::dc(&app, "up").await {
            Err(err) => {
                app.dialog()
                    .message(format!(
                        "This application requires Docker Compose to be installed.\n\
                         Download it at https://www.docker.com/products/docker-desktop/\n\n{err}"
                    ))
                    .kind(MessageDialogKind::Error)
                    .title("Docker Compose Missing")
                    .blocking_show();
                shutdown(&app);
            }
            Ok(status) => {
                if status.code() == Some(1) {
                    app.dialog()
                        .message(
                            "This application requires Docker to be running.\n\
                             Start Docker and try again.\n",
                        )
                        .kind(MessageDialogKind::Error)
                        .title("Docker Not Running")
                        .show(|_| {});
                } else if let Some(code) = status.code() {
                    println!("docker process exited with code {code}");
                } else {
                    println!("docker process terminated by signal");
                }
            }
        }
    });
}

/// Port of the Electron `shutdown()`: persists settings, runs
/// `docker compose down`, then quits for real.
fn shutdown(app: &AppHandle) {
    let state = app.state::<AppState>();
    if state.shutting_down.swap(true, Ordering::SeqCst) {
        return;
    }
    state.settings.lock().unwrap().write_data();
    for label in ["main", "loading", "logs", "settings"] {
        if let Some(win) = app.get_webview_window(label) {
            let _ = win.hide();
        }
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let _ = docker::dc(&app, "down").await;
        app.state::<AppState>()
            .force_quitting
            .store(true, Ordering::SeqCst);
        app.exit(0);
    });
}

fn create_tray(app: &AppHandle) -> tauri::Result<()> {
    let menu = Menu::with_items(
        app,
        &[
            &MenuItem::with_id(app, "show", "Show Window", true, None::<&str>)?,
            &MenuItem::with_id(app, "logs", "Show Logs", true, None::<&str>)?,
            &MenuItem::with_id(app, "backups", "Show Backups", true, None::<&str>)?,
            &MenuItem::with_id(app, "settings", "Settings", true, None::<&str>)?,
            &MenuItem::with_id(app, "updates", "Check for Updates", true, None::<&str>)?,
            &MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?,
        ],
    )?;
    let tooltip = {
        let state = app.state::<AppState>();
        let settings = state.settings.lock().unwrap();
        settings.get("clientTitle")
    };
    TrayIconBuilder::with_id("tray")
        .icon(app.default_window_icon().unwrap().clone())
        .tooltip(tooltip)
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => {
                let first_load = app.state::<AppState>().first_load.load(Ordering::Relaxed);
                if first_load {
                    show_window(app, "main");
                } else {
                    show_loading(app);
                }
            }
            "logs" => show_logs_window(app),
            "backups" => {
                let dir = {
                    let state = app.state::<AppState>();
                    let settings = state.settings.lock().unwrap();
                    std::path::PathBuf::from(settings.get("storageDir")).join("default/backups")
                };
                let _ = app.opener().open_path(dir.to_string_lossy(), None::<&str>);
            }
            "settings" => show_settings_window(app),
            "updates" => {
                // Auto-update (tauri-plugin-updater) is wired up in a follow-up.
                println!("Jasper App Version: {}", app.package_info().version);
            }
            "quit" => shutdown(app),
            _ => {}
        })
        .build(app)?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            fetch_settings,
            settings_value,
            settings_patch,
            command,
            open_dir
        ])
        .setup(|app| {
            let config_dir = app.path().app_config_dir()?;
            let server_config = app
                .path()
                .resolve("docker-compose.yaml", tauri::path::BaseDirectory::Resource)?;
            app.manage(AppState {
                settings: std::sync::Mutex::new(settings::Settings::load(config_dir)),
                server_config,
                first_load: std::sync::atomic::AtomicBool::new(false),
                force_quitting: std::sync::atomic::AtomicBool::new(false),
                shutting_down: std::sync::atomic::AtomicBool::new(false),
            });
            let handle = app.handle();
            for window in handle.webview_windows().values() {
                windows::restore_bounds(handle, &window.as_ref().window_ref());
            }
            create_tray(handle)?;
            start_server(handle);
            show_loading(handle);
            Ok(())
        })
        .on_window_event(|window, event| match event {
            WindowEvent::CloseRequested { api, .. } => {
                let force = window
                    .state::<AppState>()
                    .force_quitting
                    .load(Ordering::SeqCst);
                if !force {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
            _ => windows::track_bounds(window, event),
        })
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        .run(|app, event| {
            if let RunEvent::ExitRequested { api, .. } = event {
                let state = app.state::<AppState>();
                if !state.force_quitting.load(Ordering::SeqCst) {
                    api.prevent_exit();
                    shutdown(app);
                }
            }
        });
}
