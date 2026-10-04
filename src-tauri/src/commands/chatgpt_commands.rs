//! ChatGPT connection (OpenAI Secure Tunnel): runs `mcp/chatgpt-bridge.mjs`, which
//! serves the video MCP tools on http://127.0.0.1:32159/mcp and supervises OpenAI's
//! tunnel-client. Modeled on webcode-ai-studio's openai_tunnel, but fully separate:
//! own port (never AI Studio's 32149), own state dir, own processes.
//!
//! State dir: <app config dir>/chatgpt — config.json (0600, holds the API key),
//! status.json (written by the bridge, no secrets), bridge.log.
//! The UI only ever receives `ChatgptConfigView` (key redacted).
//!
//! Lifetime: the bridge's stdin is a pipe held here. Stopping (or the app dying,
//! even by SIGKILL) closes it and the bridge shuts tunnel-client down itself.
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;
use tauri::{AppHandle, Manager};
use tokio::process::{Child, ChildStdin};

use super::agent_commands::{project_dir, video_work_dir};
use super::node_env::node_command;

/// Video Creator's fixed MCP port. Must stay different from AI Studio's 32149.
pub const MCP_PORT: u16 = 32159;
/// Bridge exit code for "port already in use" (mcp/chatgpt-bridge.mjs).
const EXIT_PORT_IN_USE: i32 = 3;

struct Bridge {
    child: Child,
    stdin: Option<ChildStdin>,
}

static BRIDGE: OnceLock<Mutex<Option<Bridge>>> = OnceLock::new();

fn bridge() -> &'static Mutex<Option<Bridge>> {
    BRIDGE.get_or_init(|| Mutex::new(None))
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct ChatgptConfig {
    tunnel_id: String,
    api_key: String,
    auto_start: bool,
    /// "auto" | "ask" — remote calls always pass the approval gate; this is only its strictness.
    approval: String,
}

impl Default for ChatgptConfig {
    fn default() -> Self {
        Self { tunnel_id: String::new(), api_key: String::new(), auto_start: false, approval: "ask".to_string() }
    }
}

#[derive(Debug, Serialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ChatgptConfigView {
    tunnel_id: String,
    has_api_key: bool,
    api_key_hint: String,
    auto_start: bool,
    approval: String,
}

impl ChatgptConfig {
    fn view(&self) -> ChatgptConfigView {
        ChatgptConfigView {
            tunnel_id: self.tunnel_id.clone(),
            has_api_key: !self.api_key.is_empty(),
            api_key_hint: mask_secret(&self.api_key),
            auto_start: self.auto_start,
            approval: self.approval.clone(),
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatgptConfigInput {
    tunnel_id: String,
    /// None or empty keeps the stored key (the UI never receives it back).
    api_key: Option<String>,
    #[serde(default)]
    clear_api_key: bool,
    auto_start: bool,
    approval: String,
}

#[tauri::command]
pub async fn chatgpt_get_config(app: AppHandle) -> Result<ChatgptConfigView, String> {
    Ok(load_config(&state_dir(&app)?).view())
}

#[tauri::command]
pub async fn chatgpt_save_config(app: AppHandle, input: ChatgptConfigInput) -> Result<ChatgptConfigView, String> {
    let dir = state_dir(&app)?;
    let mut config = load_config(&dir);
    let next = apply_input(&mut config, input)?;
    write_config(&dir, &next)?;
    // A running bridge read the old config at start; restart so the change takes effect.
    if is_running() {
        stop_bridge().await;
        start_bridge(&app).await?;
    }
    Ok(next.view())
}

#[tauri::command]
pub async fn chatgpt_status(app: AppHandle) -> Result<Value, String> {
    let dir = state_dir(&app)?;
    let running = is_running();
    let last = std::fs::read_to_string(dir.join("status.json"))
        .ok()
        .and_then(|text| serde_json::from_str::<Value>(&text).ok());
    // status.json survives a crashed bridge; only trust it while our child is alive.
    let status = if running { last.clone() } else { None };
    let last_error = last
        .as_ref()
        .filter(|_| !running)
        .and_then(|value| {
            [value.get("error"), value.pointer("/tunnel/error")]
                .into_iter()
                .flatten()
                .find(|error| !error.is_null())
                .cloned()
        });
    Ok(json!({
        "running": running,
        "port": MCP_PORT,
        "mcpUrl": format!("http://127.0.0.1:{MCP_PORT}/mcp"),
        "status": status,
        "lastError": last_error,
        "config": load_config(&dir).view(),
        "logPath": dir.join("bridge.log").to_string_lossy(),
    }))
}

#[tauri::command]
pub async fn chatgpt_start(app: AppHandle) -> Result<(), String> {
    start_bridge(&app).await
}

#[tauri::command]
pub async fn chatgpt_stop() -> Result<(), String> {
    stop_bridge().await;
    Ok(())
}

/// Called from setup: start the connection when the user enabled auto start.
pub fn autostart(app: &AppHandle) {
    let Ok(dir) = state_dir(app) else {
        return;
    };
    if !load_config(&dir).auto_start {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(error) = start_bridge(&app).await {
            eprintln!("[chatgpt] auto start failed: {error}");
        }
    });
}

/// App exit: close the bridge's stdin so it stops tunnel-client on its own.
pub fn shutdown() {
    if let Ok(mut guard) = bridge().lock() {
        if let Some(mut running) = guard.take() {
            running.stdin.take();
        }
    }
}

fn is_running() -> bool {
    let Ok(mut guard) = bridge().lock() else {
        return false;
    };
    match guard.as_mut() {
        Some(running) => match running.child.try_wait() {
            Ok(None) => true,
            _ => {
                *guard = None;
                false
            }
        },
        None => false,
    }
}

async fn start_bridge(app: &AppHandle) -> Result<(), String> {
    if is_running() {
        return Ok(());
    }
    let dir = state_dir(app)?;
    std::fs::create_dir_all(&dir).map_err(|error| format!("failed to create {}: {error}", dir.display()))?;
    let script = project_dir(app)?.join("mcp").join("chatgpt-bridge.mjs");
    let workspace = video_work_dir(app)?;
    let log_path = dir.join("bridge.log");
    let log = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
        .map_err(|error| format!("failed to open {}: {error}", log_path.display()))?;
    let log_start = log.metadata().map(|meta| meta.len()).unwrap_or(0);
    let mut child = node_command()
        .arg(&script)
        .arg("--state-dir")
        .arg(&dir)
        .arg("--workspace")
        .arg(&workspace)
        .arg("--port")
        .arg(MCP_PORT.to_string())
        .arg("--parent-stdin")
        .env_remove("TAURI_CONFIG")
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::from(log))
        // Not kill_on_drop: a SIGKILLed bridge would orphan tunnel-client. Closing stdin lets it clean up.
        .kill_on_drop(false)
        .spawn()
        .map_err(|error| format!("无法启动 ChatGPT 连接服务: {error}"))?;
    let stdin = child.stdin.take();
    let pid = child.id();

    // Wait until the HTTP endpoint is listening (status.json from this pid) or the bridge exits.
    for _ in 0..50 {
        if let Ok(Some(status)) = child.try_wait() {
            let detail = log_tail(&log_path, log_start);
            return Err(if status.code() == Some(EXIT_PORT_IN_USE) {
                format!("端口 {MCP_PORT} 已被占用：{detail}")
            } else {
                format!("ChatGPT 连接服务启动失败：{detail}")
            });
        }
        let listening = std::fs::read_to_string(dir.join("status.json"))
            .ok()
            .and_then(|text| serde_json::from_str::<Value>(&text).ok())
            .filter(|value| value["pid"].as_u64() == pid.map(u64::from))
            .is_some_and(|value| value.pointer("/mcp/port").is_some_and(|port| !port.is_null()));
        if listening {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    *bridge().lock().map_err(|_| "bridge registry poisoned")? = Some(Bridge { child, stdin });
    Ok(())
}

async fn stop_bridge() {
    let taken = bridge().lock().ok().and_then(|mut guard| guard.take());
    let Some(mut running) = taken else {
        return;
    };
    running.stdin.take();
    if tokio::time::timeout(Duration::from_secs(8), running.child.wait()).await.is_err() {
        let _ = running.child.kill().await;
    }
}

fn apply_input(config: &mut ChatgptConfig, input: ChatgptConfigInput) -> Result<ChatgptConfig, String> {
    let tunnel_id = input.tunnel_id.trim().to_string();
    if !tunnel_id.is_empty() && !valid_tunnel_id(&tunnel_id) {
        return Err("Tunnel ID 格式不对：应为 tunnel_ 加 32 位小写十六进制".to_string());
    }
    config.tunnel_id = tunnel_id;
    if input.clear_api_key {
        config.api_key.clear();
    } else if let Some(key) = input.api_key.map(|key| key.trim().to_string()).filter(|key| !key.is_empty()) {
        config.api_key = key;
    }
    config.auto_start = input.auto_start;
    config.approval = if input.approval == "auto" { "auto" } else { "ask" }.to_string();
    Ok(config.clone())
}

pub fn valid_tunnel_id(value: &str) -> bool {
    value
        .strip_prefix("tunnel_")
        .is_some_and(|suffix| suffix.len() == 32 && suffix.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)))
}

/// Same shape as mcp/chatgpt-config.mjs maskSecret: "sk-…wxyz", "••••" for short keys, "" when unset.
pub fn mask_secret(secret: &str) -> String {
    if secret.is_empty() {
        return String::new();
    }
    let chars: Vec<char> = secret.chars().collect();
    if chars.len() < 12 {
        return "••••".to_string();
    }
    let prefix = if secret.starts_with("sk-") { "sk-" } else { "" };
    let tail: String = chars[chars.len() - 4..].iter().collect();
    format!("{prefix}…{tail}")
}

fn load_config(dir: &Path) -> ChatgptConfig {
    std::fs::read_to_string(dir.join("config.json"))
        .ok()
        .and_then(|text| serde_json::from_str::<ChatgptConfig>(&text).ok())
        .unwrap_or_default()
}

fn write_config(dir: &Path, config: &ChatgptConfig) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|error| format!("failed to create {}: {error}", dir.display()))?;
    let contents = serde_json::to_vec_pretty(config).map_err(|error| error.to_string())?;
    let staging = dir.join("config.json.tmp");
    write_private(&staging, &contents)?;
    std::fs::rename(&staging, dir.join("config.json")).map_err(|error| format!("failed to save config: {error}"))
}

fn write_private(path: &Path, contents: &[u8]) -> Result<(), String> {
    use std::io::Write;
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
        options.mode(0o600);
        let mut file = options.open(path).map_err(|error| format!("failed to write {}: {error}", path.display()))?;
        // mode() only applies on create; enforce it for an existing file too.
        file.set_permissions(std::fs::Permissions::from_mode(0o600)).map_err(|error| error.to_string())?;
        return file.write_all(contents).map_err(|error| error.to_string());
    }
    #[cfg(not(unix))]
    {
        let mut file = options.open(path).map_err(|error| format!("failed to write {}: {error}", path.display()))?;
        file.write_all(contents).map_err(|error| error.to_string())
    }
}

/// Last non-empty line the bridge logged since `from` (it never logs secrets; see redactText).
fn log_tail(path: &Path, from: u64) -> String {
    let text = std::fs::read(path).ok().map(|bytes| String::from_utf8_lossy(&bytes[(from as usize).min(bytes.len())..]).to_string());
    text.and_then(|text| text.lines().rev().map(str::trim).find(|line| !line.is_empty()).map(str::to_string))
        .unwrap_or_else(|| "（无日志）".to_string())
}

fn state_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_config_dir()
        .map(|path| path.join("chatgpt"))
        .map_err(|error| format!("failed to resolve app config directory: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input(tunnel_id: &str, api_key: Option<&str>, clear: bool) -> ChatgptConfigInput {
        ChatgptConfigInput {
            tunnel_id: tunnel_id.to_string(),
            api_key: api_key.map(str::to_string),
            clear_api_key: clear,
            auto_start: true,
            approval: "weird".to_string(),
        }
    }

    #[test]
    fn port_is_not_ai_studio_port() {
        assert_eq!(MCP_PORT, 32159);
        assert_ne!(MCP_PORT, 32149);
    }

    #[test]
    fn view_never_contains_the_key() {
        let config = ChatgptConfig { api_key: "sk-proj-SECRETsecret9876".to_string(), ..Default::default() };
        let view = serde_json::to_string(&config.view()).unwrap();
        assert!(!view.contains("SECRET"), "{view}");
        assert!(view.contains("\"hasApiKey\":true"), "{view}");
        assert!(view.contains("sk-…9876"), "{view}");
        assert_eq!(mask_secret(""), "");
        assert_eq!(mask_secret("short"), "••••");
    }

    #[test]
    fn input_keeps_or_clears_the_stored_key_and_validates_tunnel_id() {
        let id = format!("tunnel_{}", "0f".repeat(16));
        let mut config = ChatgptConfig { api_key: "sk-old-key-123456".to_string(), ..Default::default() };
        let kept = apply_input(&mut config, input(&id, Some("  "), false)).unwrap();
        assert_eq!(kept.api_key, "sk-old-key-123456");
        assert_eq!(kept.approval, "ask");
        assert!(kept.auto_start);
        let replaced = apply_input(&mut config, input(&id, Some("sk-new-key-654321"), false)).unwrap();
        assert_eq!(replaced.api_key, "sk-new-key-654321");
        let cleared = apply_input(&mut config, input(&id, None, true)).unwrap();
        assert_eq!(cleared.api_key, "");
        assert!(apply_input(&mut config, input("tunnel_XYZ", None, false)).is_err());
        assert!(apply_input(&mut config, input("", None, false)).is_ok());
    }

    #[test]
    fn config_file_shape_matches_the_node_bridge() {
        let parsed: ChatgptConfig =
            serde_json::from_str(r#"{"tunnelId":"t","apiKey":"k","autoStart":true,"approval":"auto"}"#).unwrap();
        assert_eq!(parsed.tunnel_id, "t");
        assert_eq!(parsed.api_key, "k");
        assert!(parsed.auto_start);
        let defaults: ChatgptConfig = serde_json::from_str("{}").unwrap();
        assert_eq!(defaults, ChatgptConfig::default());
        let written = serde_json::to_value(&parsed).unwrap();
        for key in ["tunnelId", "apiKey", "autoStart", "approval"] {
            assert!(written.get(key).is_some(), "{key}");
        }
    }
}
