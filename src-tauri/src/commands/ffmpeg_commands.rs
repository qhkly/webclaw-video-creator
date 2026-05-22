use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::Manager;
use tokio::process::Command;

#[derive(Debug, Serialize, Deserialize)]
pub struct AudioSegment {
    path: String,
    start_time: f64,
}

#[tauri::command]
pub async fn combine_audio_video(
    app: tauri::AppHandle,
    video_path: String,
    audio_segments: Vec<AudioSegment>,
    output_path: String,
) -> Result<String, String> {
    if audio_segments.is_empty() {
        return Ok(video_path);
    }

    let ffmpeg = find_ffmpeg(project_dir(&app)?).await?;
    let mut command = Command::new(ffmpeg);
    command.arg("-y").arg("-i").arg(&video_path);

    for segment in &audio_segments {
        command.arg("-itsoffset").arg(segment.start_time.to_string());
        command.arg("-i").arg(&segment.path);
    }

    command.arg("-map").arg("0:v:0");
    for index in 0..audio_segments.len() {
        command.arg("-map").arg(format!("{}:a:0", index + 1));
    }
    command
        .arg("-filter_complex")
        .arg(format!("amix=inputs={}:normalize=0[a]", audio_segments.len()))
        .arg("-map")
        .arg("[a]")
        .arg("-c:v")
        .arg("copy")
        .arg("-shortest")
        .arg(&output_path);

    let output = command
        .output()
        .await
        .map_err(|error| format!("failed to spawn ffmpeg: {error}"))?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).to_string());
    }
    Ok(output_path)
}

async fn find_ffmpeg(project_dir: PathBuf) -> Result<PathBuf, String> {
    let output = Command::new("node")
        .current_dir(project_dir)
        .arg("-e")
        .arg("console.log(require('ffmpeg-static'))")
        .output()
        .await
        .map_err(|error| format!("failed to resolve ffmpeg-static: {error}"))?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).to_string());
    }
    Ok(PathBuf::from(String::from_utf8_lossy(&output.stdout).trim()))
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
