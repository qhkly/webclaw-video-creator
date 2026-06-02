use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct RenderProgress {
    percent: u8,
    message: String,
}

#[tauri::command]
pub async fn save_scenes_json(
    app: AppHandle,
    scenes: serde_json::Value,
    output_dir: String,
) -> Result<String, String> {
    let path = PathBuf::from(output_dir).join("scenes.json");
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|error| format!("failed to create output directory: {error}"))?;
    }
    let contents = serde_json::to_string_pretty(&scenes)
        .map_err(|error| format!("failed to serialize scenes: {error}"))?;
    tokio::fs::write(&path, contents)
        .await
        .map_err(|error| format!("failed to write scenes json: {error}"))?;
    let _ = app.emit(
        "render_progress",
        RenderProgress {
            percent: 2,
            message: "场景 JSON 已保存".to_string(),
        },
    );
    Ok(path.to_string_lossy().to_string())
}

#[tauri::command]
pub async fn render_video(
    app: AppHandle,
    scenes_json: String,
    output_dir: String,
    aspect: String,
    resolution: String,
    format: String,
) -> Result<String, String> {
    let project_dir = project_dir(&app)?;
    let script_path = project_dir.join("scripts").join("render.mjs");
    let mut child = Command::new("node")
        .current_dir(&project_dir)
        .arg(script_path)
        .arg("--scenes")
        .arg(scenes_json)
        .arg("--outputDir")
        .arg(&output_dir)
        .arg("--aspect")
        .arg(&aspect)
        .arg("--resolution")
        .arg(&resolution)
        .arg("--format")
        .arg(&format)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|error| format!("failed to spawn renderer: {error}"))?;

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "renderer stdout unavailable".to_string())?;
    let mut lines = BufReader::new(stdout).lines();
    let mut final_output = PathBuf::from(&output_dir).join("raw_video.mp4");

    while let Some(line) = lines
        .next_line()
        .await
        .map_err(|error| format!("failed reading renderer stdout: {error}"))?
    {
        if let Ok(value) = serde_json::from_str::<serde_json::Value>(&line) {
            if value["type"] == "progress" {
                let percent = value["percent"].as_u64().unwrap_or(0).min(100) as u8;
                let _ = app.emit(
                    "render_progress",
                    RenderProgress {
                        percent,
                        message: format!("Remotion 渲染中：{percent}%"),
                    },
                );
            } else if value["type"] == "done" {
                if let Some(output) = value["output"].as_str() {
                    final_output = PathBuf::from(output);
                }
            }
        }
    }

    let status = child
        .wait()
        .await
        .map_err(|error| format!("renderer wait failed: {error}"))?;
    if !status.success() {
        return Err(format!("renderer exited with status {status}"));
    }

    let _ = app.emit(
        "render_progress",
        RenderProgress {
            percent: 100,
            message: "视频渲染完成".to_string(),
        },
    );
    Ok(final_output.to_string_lossy().to_string())
}

fn project_dir(app: &AppHandle) -> Result<PathBuf, String> {
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
