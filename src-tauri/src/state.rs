use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::sync::Mutex;

use crate::settings::Settings;

pub struct AppState {
    pub settings: Mutex<Settings>,
    /// Path to the bundled docker-compose.yaml.
    pub server_config: PathBuf,
    /// Set once the main window has navigated to the jasper-ui entry URL.
    pub first_load: AtomicBool,
    /// Set when quitting for real (skips the hide-on-close behaviour).
    pub force_quitting: AtomicBool,
    /// Set while `docker compose down` is running during shutdown.
    pub shutting_down: AtomicBool,
}
