use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::Manager;
use tokio::process::Command;

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AssetCandidate {
    #[serde(rename = "type")]
    asset_type: String,
    local_path: String,
    thumb: Option<String>,
    duration: Option<f64>,
    w: Option<u32>,
    h: Option<u32>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FetchAssetsResult {
    query: String,
    candidates: Vec<AssetCandidate>,
}

#[tauri::command]
pub async fn fetch_assets(
    app: tauri::AppHandle,
    query: String,
    count: u8,
    orientation: String,
    api_key: String,
    project_dir: Option<String>,
) -> Result<FetchAssetsResult, String> {
    if query.trim().is_empty() {
        return Err("素材关键词不能为空".to_string());
    }
    if api_key.trim().is_empty() {
        return Err("请先在设置里填写 Pexels API Key".to_string());
    }

    let app_project_dir = resolve_project_dir(&app)?;
    let asset_root = project_dir
        .map(PathBuf::from)
        .unwrap_or_else(|| app_project_dir.join(".video-work"))
        .join("assets");
    let script_path = app_project_dir.join("scripts").join("fetch-assets.mjs");
    let output = Command::new("node")
        .current_dir(&app_project_dir)
        .arg(script_path)
        .arg("--query")
        .arg(query)
        .arg("--count")
        .arg(count.to_string())
        .arg("--orientation")
        .arg(orientation)
        .arg("--apiKey")
        .arg(api_key)
        .arg("--projectDir")
        .arg(asset_root)
        .output()
        .await
        .map_err(|error| format!("failed to spawn Pexels fetcher: {error}"))?;

    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).to_string());
    }

    serde_json::from_slice(&output.stdout)
        .map_err(|error| format!("invalid Pexels JSON output: {error}"))
}

fn resolve_project_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    if let Some(manifest_dir) = option_env!("CARGO_MANIFEST_DIR") {
        if let Some(parent) = PathBuf::from(manifest_dir).parent() {
            return Ok(parent.to_path_buf());
        }
    }
    match app.path().resolve("", tauri::path::BaseDirectory::Resource) {
        Ok(path) => Ok(path),
        Err(_) => std::env::current_dir()
            .map_err(|error| format!("failed to resolve project directory: {error}")),
    }
}
