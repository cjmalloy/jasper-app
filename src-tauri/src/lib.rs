use serde::{Deserialize, Serialize};
use std::process::{Child, Command};
use std::sync::{Arc, Mutex};
use tauri::{
    AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder,
};
use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;

mod settings;
use settings::Settings;

// State to hold docker process and settings
struct AppState {
    docker_process: Arc<Mutex<Option<Child>>>,
    settings: Arc<Mutex<Settings>>,
}

#[derive(Clone, Serialize, Deserialize)]
struct ImageTags {
    server: Vec<String>,
    client: Vec<String>,
    database: Vec<String>,
    ssh: Vec<String>,
}

#[tauri::command]
async fn fetch_settings(state: State<'_, AppState>) -> Result<Settings, String> {
    let settings = state.settings.lock().unwrap();
    Ok(settings.clone())
}

#[tauri::command]
async fn save_settings(
    new_settings: Settings,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<(), String> {
    {
        let mut settings = state.settings.lock().unwrap();
        *settings = new_settings.clone();
        settings.save().map_err(|e| e.to_string())?;
    }
    
    // Restart docker compose
    stop_docker_compose(&state).await?;
    start_docker_compose(&state, &app).await?;
    
    Ok(())
}

#[tauri::command]
async fn patch_settings(
    name: String,
    value: serde_json::Value,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let mut settings = state.settings.lock().unwrap();
    settings.patch(&name, value);
    settings.save().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
async fn open_dir(path: String) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        Command::new("explorer")
            .arg(&path)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "macos")]
    {
        Command::new("open")
            .arg(&path)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "linux")]
    {
        Command::new("xdg-open")
            .arg(&path)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
async fn docker_command(
    command: String,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<(), String> {
    match command.as_str() {
        "restart" => {
            stop_docker_compose(&state).await?;
            start_docker_compose(&state, &app).await?;
        }
        "pull" | "down" | "up" | "pause" | "unpause" => {
            run_docker_command(&command, &state).await?;
        }
        _ => return Err(format!("Unknown command: {}", command)),
    }
    
    // Notify settings window that command finished
    if let Some(window) = app.get_webview_window("settings") {
        let _ = window.emit("finished", command);
    }
    
    Ok(())
}

#[tauri::command]
async fn get_image_tags() -> Result<ImageTags, String> {
    let mut tags = ImageTags {
        server: vec![],
        client: vec![],
        database: vec!["11".to_string(), "12".to_string(), "13".to_string(), 
                       "14".to_string(), "15".to_string(), "16".to_string(), "17".to_string()],
        ssh: vec![],
    };
    
    // TODO: Implement actual Docker registry API calls
    // For now, return some common versions
    tags.server = vec!["latest".to_string(), "v1.3".to_string(), "v1".to_string()];
    tags.client = vec!["latest".to_string(), "v1.3".to_string(), "v1".to_string()];
    tags.ssh = vec!["latest".to_string(), "v1.1".to_string(), "v1".to_string()];
    
    Ok(tags)
}

async fn run_docker_command(command: &str, state: &State<'_, AppState>) -> Result<(), String> {
    let settings = state.settings.lock().unwrap();
    let docker_compose_path = settings.get_docker_compose_path();
    
    let mut cmd = Command::new("docker");
    cmd.arg("compose")
        .arg("-f")
        .arg(docker_compose_path);
    
    if !settings.cf_token.is_empty() {
        cmd.arg("--profile").arg("cf");
    }
    if !settings.ngrok_token.is_empty() {
        cmd.arg("--profile").arg("ngrok");
    }
    
    // Set environment variables for docker-compose
    for (key, value) in settings.get_env_vars() {
        cmd.env(key, value);
    }
    
    cmd.arg(command);
    
    let output = cmd.output().map_err(|e| e.to_string())?;
    
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).to_string());
    }
    
    Ok(())
}

async fn start_docker_compose(state: &State<'_, AppState>, _app: &AppHandle) -> Result<(), String> {
    let settings = state.settings.lock().unwrap().clone();
    drop(settings);
    
    run_docker_command("up", state).await?;
    
    Ok(())
}

async fn stop_docker_compose(state: &State<'_, AppState>) -> Result<(), String> {
    // Stop existing docker process if any
    {
        let mut docker_process = state.docker_process.lock().unwrap();
        if let Some(mut child) = docker_process.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
    
    run_docker_command("down", state).await?;
    
    Ok(())
}

fn create_tray(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let show = MenuItem::with_id(app, "show", "Show Window", true, None::<&str>)?;
    let logs = MenuItem::with_id(app, "logs", "Show Logs", true, None::<&str>)?;
    let settings = MenuItem::with_id(app, "settings", "Settings", true, None::<&str>)?;
    
    let menu = Menu::with_items(app, &[&show, &logs, &settings, &quit])?;
    
    let _ = TrayIconBuilder::with_id("main")
        .icon(app.default_window_icon().unwrap().clone())
        .menu(&menu)
        .on_menu_event(move |app, event| {
            match event.id.as_ref() {
                "quit" => {
                    app.exit(0);
                }
                "show" => {
                    if let Some(window) = app.get_webview_window("main") {
                        let _ = window.show();
                        let _ = window.set_focus();
                    }
                }
                "logs" => {
                    if let Some(window) = app.get_webview_window("logs") {
                        let _ = window.show();
                        let _ = window.set_focus();
                    } else {
                        let _ = create_logs_window(app);
                    }
                }
                "settings" => {
                    if let Some(window) = app.get_webview_window("settings") {
                        let _ = window.show();
                        let _ = window.set_focus();
                    } else {
                        let _ = create_settings_window(app);
                    }
                }
                _ => {}
            }
        })
        .build(app)?;
    
    Ok(())
}

fn create_settings_window(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    WebviewWindowBuilder::new(app, "settings", WebviewUrl::App("settings.html".into()))
        .title("Jasper Settings")
        .inner_size(540.0, 620.0)
        .resizable(true)
        .build()?;
    
    Ok(())
}

fn create_logs_window(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    WebviewWindowBuilder::new(app, "logs", WebviewUrl::App("logs.html".into()))
        .title("Jasper Logs")
        .inner_size(800.0, 600.0)
        .resizable(true)
        .build()?;
    
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            
            // Load settings
            let settings = Settings::load(app.handle())?;
            
            let state = AppState {
                docker_process: Arc::new(Mutex::new(None)),
                settings: Arc::new(Mutex::new(settings)),
            };
            
            app.manage(state);
            
            // Create system tray
            create_tray(app.handle())?;
            
            // Start docker compose in background
            let app_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let state = app_handle.state::<AppState>();
                let _ = start_docker_compose(&state, &app_handle).await;
            });
            
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            fetch_settings,
            save_settings,
            patch_settings,
            open_dir,
            docker_command,
            get_image_tags
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
