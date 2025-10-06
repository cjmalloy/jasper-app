use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};
use anyhow::Result;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub locale: String,
    pub auto_update: bool,
    pub server_version: String,
    pub pull_server: bool,
    pub server_port: String,
    pub server_profiles: String,
    pub server_default_role: String,
    pub server_ram: String,
    pub client_version: String,
    pub pull_client: bool,
    pub client_port: String,
    pub client_title: String,
    pub database_version: String,
    pub pull_database: bool,
    pub data_dir: PathBuf,
    pub storage_dir: PathBuf,
    pub ssh_version: String,
    pub pull_ssh: bool,
    pub ssh_port: String,
    pub cf_token: String,
    pub ngrok_url: String,
    pub ngrok_token: String,
    pub show_logs_on_start: bool,
    
    #[serde(skip)]
    settings_path: PathBuf,
}

impl Settings {
    pub fn load(app: &AppHandle) -> Result<Self> {
        let app_data = app.path().app_data_dir()?;
        fs::create_dir_all(&app_data)?;
        
        let settings_path = app_data.join("settings.json");
        
        if settings_path.exists() {
            let contents = fs::read_to_string(&settings_path)?;
            let mut settings: Settings = serde_json::from_str(&contents)?;
            settings.settings_path = settings_path;
            Ok(settings)
        } else {
            let user_data = app.path().app_data_dir()?;
            let default_settings = Settings {
                locale: "en".to_string(),
                auto_update: true,
                server_version: "v1.3".to_string(),
                pull_server: true,
                server_port: "8081".to_string(),
                server_profiles: "prod,jwt,storage,scripts,proxy,file-cache".to_string(),
                server_default_role: "ROLE_ANONYMOUS".to_string(),
                server_ram: "1g".to_string(),
                client_version: "v1.3".to_string(),
                pull_client: true,
                client_port: "8082".to_string(),
                client_title: "Jasper".to_string(),
                database_version: "16".to_string(),
                pull_database: true,
                data_dir: user_data.join("data"),
                storage_dir: user_data.join("storage"),
                ssh_version: "v1.1".to_string(),
                pull_ssh: true,
                ssh_port: "8022".to_string(),
                cf_token: String::new(),
                ngrok_url: String::new(),
                ngrok_token: String::new(),
                show_logs_on_start: false,
                settings_path,
            };
            default_settings.save()?;
            Ok(default_settings)
        }
    }
    
    pub fn save(&self) -> Result<()> {
        let json = serde_json::to_string_pretty(self)?;
        fs::write(&self.settings_path, json)?;
        Ok(())
    }
    
    pub fn patch(&mut self, name: &str, value: serde_json::Value) {
        match name {
            "autoUpdate" => {
                if let Some(v) = value.as_bool() {
                    self.auto_update = v;
                }
            }
            "showLogsOnStart" => {
                if let Some(v) = value.as_bool() {
                    self.show_logs_on_start = v;
                }
            }
            _ => {}
        }
    }
    
    pub fn get_docker_compose_path(&self) -> PathBuf {
        // In production, the docker-compose.yaml will be bundled with the app
        // Try to find it in the resource directory first, otherwise use current directory
        PathBuf::from("docker-compose.yaml")
    }
    
    pub fn get_env_vars(&self) -> Vec<(String, String)> {
        let key = generate_jwt_key();
        
        vec![
            ("JASPER_LOCALE".to_string(), self.locale.clone()),
            ("JASPER_SERVER_PROFILES".to_string(), self.server_profiles.clone()),
            ("JASPER_SERVER_DEFAULT_ROLE".to_string(), self.server_default_role.clone()),
            ("JASPER_PREFETCH".to_string(), 
                if self.server_default_role == "ROLE_VIEWER" || self.server_default_role == "ROLE_ANONYMOUS" {
                    "true".to_string()
                } else {
                    "false".to_string()
                }
            ),
            ("JASPER_SERVER_VERSION".to_string(), self.server_version.clone()),
            ("JASPER_SERVER_PULL".to_string(), if self.pull_server { "always".to_string() } else { "missing".to_string() }),
            ("JASPER_SERVER_PORT".to_string(), self.server_port.clone()),
            ("JASPER_SERVER_HEAP".to_string(), self.server_ram.clone()),
            ("JASPER_SERVER_KEY".to_string(), key.clone()),
            ("JASPER_CLIENT_VERSION".to_string(), self.client_version.clone()),
            ("JASPER_CLIENT_PULL".to_string(), if self.pull_client { "always".to_string() } else { "missing".to_string() }),
            ("JASPER_CLIENT_PORT".to_string(), self.client_port.clone()),
            ("JASPER_CLIENT_TITLE".to_string(), self.client_title.clone()),
            ("JASPER_CLIENT_TOKEN".to_string(), generate_token("+user", &key)),
            ("JASPER_DATABASE_VERSION".to_string(), self.database_version.clone()),
            ("JASPER_DATABASE_PULL".to_string(), if self.pull_database { "always".to_string() } else { "missing".to_string() }),
            ("JASPER_DATA_DIR".to_string(), self.data_dir.to_string_lossy().to_string()),
            ("JASPER_STORAGE_DIR".to_string(), self.storage_dir.to_string_lossy().to_string()),
            ("JASPER_SSH_VERSION".to_string(), self.ssh_version.clone()),
            ("JASPER_SSH_PULL".to_string(), if self.pull_ssh { "always".to_string() } else { "missing".to_string() }),
            ("JASPER_SSH_PORT".to_string(), self.ssh_port.clone()),
            ("JASPER_SSH_TOKEN".to_string(), generate_token("+user", &key)),
            ("CLOUDFLARE_TOKEN".to_string(), self.cf_token.clone()),
            ("NGROK_URL".to_string(), self.ngrok_url.clone()),
            ("NGROK_TOKEN".to_string(), self.ngrok_token.clone()),
        ]
    }
}

fn generate_jwt_key() -> String {
    use rand::Rng;
    use base64::Engine;
    let key: Vec<u8> = (0..128).map(|_| rand::thread_rng().gen()).collect();
    base64::engine::general_purpose::STANDARD.encode(&key)
}

fn generate_token(user_tag: &str, secret: &str) -> String {
    use hmac::{Hmac, Mac};
    use sha2::Sha512;
    use base64::Engine;
    
    let header = serde_json::json!({
        "alg": "HS512",
        "typ": "JWT"
    });
    
    let payload = serde_json::json!({
        "aud": "",
        "sub": user_tag,
        "auth": "ROLE_ADMIN"
    });
    
    let header_b64 = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(header.to_string());
    let payload_b64 = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(payload.to_string());
    let body = format!("{}.{}", header_b64, payload_b64);
    
    let secret_bytes = base64::engine::general_purpose::STANDARD.decode(secret).unwrap_or_default();
    let mut mac = Hmac::<Sha512>::new_from_slice(&secret_bytes).unwrap();
    mac.update(body.as_bytes());
    let signature = mac.finalize();
    let signature_b64 = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(signature.into_bytes());
    
    format!("{}.{}", body, signature_b64)
}
