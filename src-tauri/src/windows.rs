use serde_json::{json, Value};
use tauri::{AppHandle, LogicalPosition, LogicalSize, Manager, Window, WindowEvent};

use crate::state::AppState;

/// Maps a window label to the key holding its bounds in settings.json,
/// preserving the Electron schema: main/loading bounds live at the top level,
/// logs and settings windows under `logs` / `settings`.
fn config_key(label: &str) -> Option<&'static str> {
    match label {
        "main" | "loading" => None, // top level
        "logs" => Some("logs"),
        "settings" => Some("settings"),
        _ => None,
    }
}

fn bounds_config<'a>(data: &'a Value, label: &str) -> Option<&'a Value> {
    match config_key(label) {
        None if label == "main" || label == "loading" => Some(data),
        Some(key) => data.get(key),
        None => None,
    }
}

/// Restores persisted bounds for a window from settings.json.
pub fn restore_bounds(app: &AppHandle, window: &Window) {
    let state = app.state::<AppState>();
    let settings = state.settings.lock().unwrap();
    let Some(config) = bounds_config(&settings.data, window.label()) else {
        return;
    };
    if let Some(bounds) = config.get("bounds") {
        let width = bounds.get("width").and_then(Value::as_f64);
        let height = bounds.get("height").and_then(Value::as_f64);
        if let (Some(width), Some(height)) = (width, height) {
            let _ = window.set_size(LogicalSize::new(width, height));
        }
        let x = bounds.get("x").and_then(Value::as_f64);
        let y = bounds.get("y").and_then(Value::as_f64);
        if let (Some(x), Some(y)) = (x, y) {
            let _ = window.set_position(LogicalPosition::new(x, y));
        }
    }
    if config.get("maximized").and_then(Value::as_bool) == Some(true) {
        let _ = window.maximize();
    }
}

/// Tracks window move/resize/maximize into the in-memory settings, persisted
/// by `write_data` on shutdown or settings change (as in Electron).
pub fn track_bounds(window: &Window, event: &WindowEvent) {
    let update: Value = match event {
        WindowEvent::Resized(_) | WindowEvent::Moved(_) => {
            if window.is_minimized().unwrap_or(false) {
                return;
            }
            if window.is_maximized().unwrap_or(false) {
                json!({ "maximized": true })
            } else {
                let scale = window.scale_factor().unwrap_or(1.0);
                let size = match window.inner_size() {
                    Ok(s) => s.to_logical::<f64>(scale),
                    Err(_) => return,
                };
                let pos = match window.outer_position() {
                    Ok(p) => p.to_logical::<f64>(scale),
                    Err(_) => return,
                };
                json!({
                    "bounds": {
                        "x": pos.x,
                        "y": pos.y,
                        "width": size.width,
                        "height": size.height,
                    },
                    "maximized": false,
                })
            }
        }
        _ => return,
    };
    let state = window.state::<AppState>();
    let mut settings = state.settings.lock().unwrap();
    let label = window.label().to_string();
    let target = match config_key(&label) {
        None if label == "main" || label == "loading" => Some(&mut settings.data),
        Some(key) => {
            if settings.data.get(key).map(|v| v.is_object()) != Some(true) {
                settings.data[key] = json!({});
            }
            settings.data.get_mut(key)
        }
        None => None,
    };
    if let (Some(target), Some(update)) = (target, update.as_object()) {
        if let Some(obj) = target.as_object_mut() {
            for (k, v) in update {
                obj.insert(k.clone(), v.clone());
            }
        }
    }
}
