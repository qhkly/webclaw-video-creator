use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::Manager;

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct LlmSettings {
    provider: String,
    base_url: String,
    model: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DefaultSettings {
    voice: String,
    aspect: String,
    resolution: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CaptionSettings {
    enabled: bool,
    position: String,
    font_size: u16,
    active_color: String,
    inactive_color: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CreatorSettings {
    pexels_api_key: String,
    llm: LlmSettings,
    defaults: DefaultSettings,
    captions: CaptionSettings,
}

impl Default for CreatorSettings {
    fn default() -> Self {
        Self {
            pexels_api_key: String::new(),
            llm: LlmSettings {
                provider: "claude-cli".to_string(),
                base_url: String::new(),
                model: String::new(),
            },
            defaults: DefaultSettings {
                voice: "zh-CN-YunxiNeural".to_string(),
                aspect: "16:9".to_string(),
                resolution: "1080p".to_string(),
            },
            captions: CaptionSettings {
                enabled: true,
                position: "bottom".to_string(),
                font_size: 54,
                active_color: "#facc15".to_string(),
                inactive_color: "#ffffff".to_string(),
            },
        }
    }
}

#[tauri::command]
pub async fn get_settings(app: tauri::AppHandle) -> Result<CreatorSettings, String> {
    let path = settings_path(&app)?;
    if !path.exists() {
        return Ok(CreatorSettings::default());
    }
    let contents = tokio::fs::read_to_string(&path)
        .await
        .map_err(|error| format!("failed to read settings: {error}"))?;
    serde_json::from_str(&contents).map_err(|error| format!("failed to parse settings: {error}"))
}

#[tauri::command]
pub async fn save_settings(
    app: tauri::AppHandle,
    settings: CreatorSettings,
) -> Result<CreatorSettings, String> {
    let path = settings_path(&app)?;
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|error| format!("failed to create settings directory: {error}"))?;
    }
    let contents = serde_json::to_string_pretty(&settings)
        .map_err(|error| format!("failed to serialize settings: {error}"))?;
    tokio::fs::write(&path, contents)
        .await
        .map_err(|error| format!("failed to write settings: {error}"))?;
    Ok(settings)
}

fn settings_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_config_dir()
        .map(|path| path.join("settings.json"))
        .map_err(|error| format!("failed to resolve app config directory: {error}"))
}
