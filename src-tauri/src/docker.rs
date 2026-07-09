use std::process::Stdio;
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::{AsyncBufReadExt, AsyncRead, BufReader};
use tokio::process::Command;

use crate::state::AppState;

/// Port of the Electron `dc()`: spawns `docker compose -f <config> [profiles]
/// <command>`, streaming stdout/stderr line-by-line to the loading and logs
/// windows as `stream-logs` events. Resolves with the exit status.
pub async fn dc(app: &AppHandle, command: &str) -> std::io::Result<std::process::ExitStatus> {
    let (config, envs, profiles) = {
        let state = app.state::<AppState>();
        let settings = state.settings.lock().unwrap();
        let mut profiles: Vec<String> = vec![];
        if !settings.get("cfToken").is_empty() {
            profiles.extend(["--profile".into(), "cf".into()]);
        }
        if !settings.get("ngrokToken").is_empty() {
            profiles.extend(["--profile".into(), "ngrok".into()]);
        }
        (state.server_config.clone(), settings.env.clone(), profiles)
    };
    let mut cmd = Command::new("docker");
    cmd.arg("compose")
        .arg("-f")
        .arg(&config)
        .args(&profiles)
        .arg(command)
        .envs(envs)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    if !cfg!(windows) {
        let path = std::env::var("PATH").unwrap_or_default();
        cmd.env("PATH", format!("{path}:/usr/local/bin"));
    }
    let mut child = cmd.spawn()?;
    if let Some(stdout) = child.stdout.take() {
        stream_logs(app.clone(), stdout);
    }
    if let Some(stderr) = child.stderr.take() {
        stream_logs(app.clone(), stderr);
    }
    child.wait().await
}

/// Runs a docker compose command in the background, then notifies the
/// settings window with a `finished` event (Electron `notify()`).
pub fn notify(app: &AppHandle, command: String) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let _ = dc(&app, &command).await;
        let _ = app.emit_to("settings", "finished", command);
    });
}

fn stream_logs<R: AsyncRead + Unpin + Send + 'static>(app: AppHandle, reader: R) {
    tauri::async_runtime::spawn(async move {
        let mut lines = BufReader::new(reader).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let line = line.trim();
            if line.is_empty() {
                continue;
            }
            println!("{line}");
            let log = ansi_to_html::convert(line)
                .unwrap_or_else(|_| html_escape(line))
                .replace('\t', "&nbsp;&nbsp;&nbsp;&nbsp;")
                .replace("  ", " &nbsp;");
            let state = app.state::<AppState>();
            if !state.first_load.load(std::sync::atomic::Ordering::Relaxed) {
                let _ = app.emit_to("loading", "stream-logs", log.clone());
            }
            let _ = app.emit_to("logs", "stream-logs", log);
        }
    });
}

fn html_escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}
