use base64::{engine::general_purpose, Engine as _};
use hmac::{Hmac, Mac};
use rand::RngCore;
use serde_json::{json, Value};
use sha2::Sha512;
use std::fs;
use std::path::PathBuf;

/// In-memory settings, mirroring the Electron `data` object and
/// `settings.json` schema exactly.
pub struct Settings {
    pub path: PathBuf,
    pub data: Value,
    /// Environment variables passed to `docker compose`, rebuilt by `write_env`.
    pub env: Vec<(String, String)>,
}

impl Settings {
    pub fn load(config_dir: PathBuf) -> Self {
        let path = config_dir.join("settings.json");
        let data = fs::read_to_string(&path)
            .ok()
            .and_then(|s| serde_json::from_str::<Value>(&s).ok())
            .unwrap_or_else(|| default_settings(&config_dir));
        let mut settings = Settings {
            path,
            data,
            env: vec![],
        };
        settings.write_env();
        settings
    }

    pub fn write_data(&self) {
        if let Some(parent) = self.path.parent() {
            let _ = fs::create_dir_all(parent);
        }
        if let Ok(json) = serde_json::to_string_pretty(&self.data) {
            let _ = fs::write(&self.path, json);
        }
    }

    pub fn get(&self, key: &str) -> String {
        match self.data.get(key) {
            Some(Value::String(s)) => s.clone(),
            Some(Value::Null) | None => String::new(),
            Some(v) => v.to_string(),
        }
    }

    pub fn flag(&self, key: &str) -> bool {
        self.data.get(key).and_then(Value::as_bool).unwrap_or(false)
    }

    pub fn update(&mut self, value: &Value) {
        if let (Some(data), Some(patch)) = (self.data.as_object_mut(), value.as_object()) {
            for (k, v) in patch {
                data.insert(k.clone(), v.clone());
            }
        }
        self.write_env();
        self.write_data();
    }

    pub fn patch(&mut self, name: &str, value: Value) {
        if let Some(data) = self.data.as_object_mut() {
            data.insert(name.to_string(), value);
        }
        self.write_env();
        self.write_data();
    }

    #[allow(dead_code)]
    pub fn entry_url(&self) -> String {
        format!("http://localhost:{}", self.get("clientPort"))
    }

    #[allow(dead_code)]
    pub fn server_health_check(&self) -> String {
        format!(
            "http://localhost:{}/management/health/readiness",
            self.get("serverPort")
        )
    }

    /// Port of the Electron `writeEnv()`: computes the env vars used by
    /// `docker compose`, generating a fresh HMAC key each time.
    pub fn write_env(&mut self) {
        let mut key_bytes = [0u8; 128]; // 1024-bit hmac key
        rand::thread_rng().fill_bytes(&mut key_bytes);
        let key = general_purpose::STANDARD.encode(key_bytes);
        let default_role = {
            let r = self.get("serverDefaultRole");
            if r.is_empty() {
                "ROLE_ANONYMOUS".to_string()
            } else {
                r
            }
        };
        let prefetch = matches!(default_role.as_str(), "ROLE_VIEWER" | "ROLE_ANONYMOUS");
        let token = get_token("+user", &key);
        self.env = vec![
            ("JASPER_LOCALE".into(), self.get("locale")),
            ("JASPER_SERVER_PROFILES".into(), self.get("serverProfiles")),
            ("JASPER_SERVER_DEFAULT_ROLE".into(), default_role),
            ("JASPER_PREFETCH".into(), prefetch.to_string()),
            ("JASPER_SERVER_VERSION".into(), self.get("serverVersion")),
            ("JASPER_SERVER_PULL".into(), pull(self.flag("pullServer"))),
            ("JASPER_SERVER_PORT".into(), self.get("serverPort")),
            ("JASPER_SERVER_HEAP".into(), self.get("serverRam")),
            ("JASPER_SERVER_KEY".into(), key.clone()),
            ("JASPER_CLIENT_VERSION".into(), self.get("clientVersion")),
            ("JASPER_CLIENT_PULL".into(), pull(self.flag("pullClient"))),
            ("JASPER_CLIENT_PORT".into(), self.get("clientPort")),
            ("JASPER_CLIENT_TITLE".into(), self.get("clientTitle")),
            ("JASPER_CLIENT_TOKEN".into(), token.clone()),
            (
                "JASPER_DATABASE_VERSION".into(),
                self.get("databaseVersion"),
            ),
            (
                "JASPER_DATABASE_PULL".into(),
                pull(self.flag("pullDatabase")),
            ),
            ("JASPER_DATABASE_PASSWORD".into(), self.get("dbPassword")),
            ("JASPER_DATA_DIR".into(), self.get("dataDir")),
            ("JASPER_STORAGE_DIR".into(), self.get("storageDir")),
            ("JASPER_SSH_VERSION".into(), self.get("sshVersion")),
            ("JASPER_SSH_PULL".into(), pull(self.flag("pullSsh"))),
            ("JASPER_SSH_PORT".into(), self.get("sshPort")),
            ("JASPER_SSH_TOKEN".into(), token),
            ("CLOUDFLARE_TOKEN".into(), self.get("cfToken")),
            ("NGROK_URL".into(), self.get("ngrokUrl")),
            ("NGROK_TOKEN".into(), self.get("ngrokToken")),
        ];
    }
}

fn pull(always: bool) -> String {
    if always {
        "always".into()
    } else {
        "missing".into()
    }
}

/// Port of the Electron `getToken()`: signs an HS512 JWT with the
/// base64-decoded secret.
pub fn get_token(user_tag: &str, secret: &str) -> String {
    let header = r#"{"alg":"HS512","typ":"JWT"}"#;
    let payload = format!(r#"{{"aud":"","sub":"{user_tag}","auth":"ROLE_ADMIN"}}"#);
    let body = format!(
        "{}.{}",
        general_purpose::URL_SAFE_NO_PAD.encode(header),
        general_purpose::URL_SAFE_NO_PAD.encode(payload)
    );
    let key = general_purpose::STANDARD.decode(secret).unwrap_or_default();
    let mut mac = Hmac::<Sha512>::new_from_slice(&key).expect("HMAC can take key of any size");
    mac.update(body.as_bytes());
    let digest = general_purpose::URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes());
    format!("{body}.{digest}")
}

fn default_settings(config_dir: &std::path::Path) -> Value {
    let locale = sys_locale::get_locale()
        .map(|l| l.split(['-', '_']).next().unwrap_or("en").to_string())
        .unwrap_or_else(|| "en".to_string());
    json!({
        "locale": locale,
        "autoUpdate": true,
        "serverVersion": "v1.3",
        "pullServer": true,
        "serverPort": "8081",
        "serverProfiles": "prod,jwt,storage,scripts,proxy,file-cache",
        "serverDefaultRole": "ROLE_ANONYMOUS",
        "serverRam": "1g",
        "clientVersion": "v1.3",
        "pullClient": true,
        "clientPort": "8082",
        "clientTitle": "Jasper",
        "databaseVersion": "18",
        "pullDatabase": true,
        "dataDir": config_dir.join("data").to_string_lossy(),
        "storageDir": config_dir.join("storage").to_string_lossy(),
        "sshVersion": "v1.1",
        "pullSsh": true,
        "sshPort": "8022",
        "cfToken": "",
        "ngrokUrl": "",
        "ngrokToken": "",
        "showLogsOnStart": false,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn token_matches_electron_implementation() {
        // Reference digest generated with the Electron getToken() (Node crypto).
        let header = general_purpose::URL_SAFE_NO_PAD.encode(r#"{"alg":"HS512","typ":"JWT"}"#);
        let payload = general_purpose::URL_SAFE_NO_PAD
            .encode(r#"{"aud":"","sub":"+user","auth":"ROLE_ADMIN"}"#);
        let digest = "I_zeVDrRZOKiG-QRHm0kMw7UP_kbzuTwU06OBcAxeMtI9lreRAaCF-98ICg-GbLFPIgIrcKbmSd-uHehTxdGig";
        assert_eq!(
            get_token("+user", "c2VjcmV0LWtleS1mb3ItdGVzdGluZy1vbmx5"),
            format!("{header}.{payload}.{digest}")
        );
    }
}
