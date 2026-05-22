use std::path::{Path, PathBuf};
use tauri::Manager;
use tokio::process::Command;

#[tauri::command]
pub async fn generate_tts(
    app: tauri::AppHandle,
    text: String,
    voice: String,
    output: String,
    engine: String,
) -> Result<f64, String> {
    let project_dir = project_dir(&app)?;
    let output_path = normalize_output_path(&project_dir, &output);
    let script_path = project_dir.join("scripts").join("tts.mjs");
    let output = Command::new("node")
        .current_dir(&project_dir)
        .arg(script_path)
        .arg("--text")
        .arg(text)
        .arg("--voice")
        .arg(voice)
        .arg("--output")
        .arg(output_path)
        .arg("--engine")
        .arg(engine)
        .output()
        .await
        .map_err(|error| format!("failed to spawn TTS script: {error}"))?;

    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).to_string());
    }

    let value: serde_json::Value = serde_json::from_slice(&output.stdout)
        .map_err(|error| format!("invalid TTS JSON output: {error}"))?;
    value["duration"]
        .as_f64()
        .ok_or_else(|| "TTS output did not include duration".to_string())
}

fn normalize_output_path(project_dir: &Path, output: &str) -> PathBuf {
    let path = PathBuf::from(output);
    if path.is_absolute() {
        path
    } else {
        project_dir.join(".video-work").join(path)
    }
}

fn project_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
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
