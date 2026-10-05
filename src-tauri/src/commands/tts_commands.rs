use std::path::{Path, PathBuf};
use super::agent_commands::{project_dir, video_work_dir};
use super::node_env::node_command;

#[derive(Debug, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WordToken {
    text: String,
    start_ms: f64,
    duration_ms: f64,
}

#[derive(Debug, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TtsResult {
    output: String,
    duration: f64,
    words_path: Option<String>,
    words: Option<Vec<WordToken>>,
}

#[tauri::command]
pub async fn generate_tts(
    app: tauri::AppHandle,
    text: String,
    voice: String,
    output: String,
    engine: String,
    project: Option<String>,
) -> Result<TtsResult, String> {
    let project_dir = project_dir(&app)?;
    let workspace = video_work_dir(&app)?;
    let output_path = normalize_output_path(&workspace, project.as_deref(), &output)?;
    let script_path = project_dir.join("scripts").join("tts.mjs");
    let output = node_command()
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

    let value: TtsResult = serde_json::from_slice(&output.stdout)
        .map_err(|error| format!("invalid TTS JSON output: {error}"))?;
    Ok(value)
}

fn normalize_output_path(workspace: &Path, project: Option<&str>, output: &str) -> Result<PathBuf, String> {
    let path = PathBuf::from(output);
    if path.is_absolute() {
        return Ok(path);
    }
    let base = match project.map(str::trim).filter(|value| !value.is_empty()) {
        Some(project) => {
            if project.len() > 64 || project.starts_with('.') || !project.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-')) {
                return Err("invalid project id".to_string());
            }
            workspace.join("projects").join(project).join("audio")
        }
        None => workspace.join("audio"),
    };
    Ok(base.join(path))
}


#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn relative_tts_output_uses_stable_project_audio_directory() {
        let workspace = PathBuf::from("/app-data/video-work");
        assert_eq!(
            normalize_output_path(&workspace, Some("chatgpt-smoke"), "s1.mp3").unwrap(),
            workspace.join("projects/chatgpt-smoke/audio/s1.mp3")
        );
        assert_eq!(
            normalize_output_path(&workspace, None, "scratch.mp3").unwrap(),
            workspace.join("audio/scratch.mp3")
        );
    }

    #[test]
    fn tts_project_id_cannot_escape_workspace() {
        let workspace = PathBuf::from("/app-data/video-work");
        assert!(normalize_output_path(&workspace, Some("../escape"), "x.mp3").is_err());
        assert!(normalize_output_path(&workspace, Some(".hidden"), "x.mp3").is_err());
    }
}
