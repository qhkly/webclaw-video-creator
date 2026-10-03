use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter, Manager, Runtime};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, BufReader};
use super::node_env::node_command;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct CutterProgress {
    task: String,
    percent: u8,
    message: String,
}

const PROVIDERS: [&str; 4] = ["auto", "openai", "whisper-cpp", "silence"];
const OUTPUT_EXTENSIONS: [&str; 4] = ["mp4", "mov", "m4v", "webm"];

/// Allow the WebView to stream exactly this user-picked file via the asset protocol (for preview).
#[tauri::command]
pub fn allow_media_preview<R: Runtime>(
    app: AppHandle<R>,
    video_path: String,
) -> Result<String, String> {
    let path = validate_input_file(&video_path)?;
    app.asset_protocol_scope()
        .allow_file(&path)
        .map_err(|error| format!("failed to allow preview: {error}"))?;
    Ok(path.to_string_lossy().to_string())
}

/// Transcribe a local video through scripts/transcribe.mjs (OpenAI-compatible / whisper.cpp / silence fallback).
#[tauri::command]
pub async fn transcribe_video<R: Runtime>(
    app: AppHandle<R>,
    video_path: String,
    provider: String,
    options_json: String,
) -> Result<serde_json::Value, String> {
    let input = validate_input_file(&video_path)?;
    if !PROVIDERS.contains(&provider.as_str()) {
        return Err(format!("unknown transcription provider: {provider}"));
    }
    serde_json::from_str::<serde_json::Map<String, serde_json::Value>>(&options_json)
        .map_err(|error| format!("invalid transcription options: {error}"))?;
    let work_dir = app
        .path()
        .app_cache_dir()
        .map_err(|error| format!("failed to resolve cache directory: {error}"))?
        .join("cutter");
    let done = run_sidecar(
        &app,
        "transcribe",
        "transcribe.mjs",
        vec![
            "--input".into(),
            input.to_string_lossy().to_string(),
            "--provider".into(),
            provider,
            "--workDir".into(),
            work_dir.to_string_lossy().to_string(),
        ],
        // Options may hold an API key: pass via env rather than argv so it doesn't show up in `ps`.
        vec![("WEBCLAW_ASR_OPTIONS", options_json)],
    )
    .await?;
    done.get("transcript")
        .cloned()
        .ok_or_else(|| "transcriber returned no transcript".to_string())
}

/// Cut the source video down to `ranges_json` (source-time keep ranges) and encode it with FFmpeg.
#[tauri::command]
pub async fn export_cut<R: Runtime>(
    app: AppHandle<R>,
    video_path: String,
    ranges_json: String,
    output_path: String,
) -> Result<String, String> {
    let input = validate_input_file(&video_path)?;
    let output = validate_output_path(&output_path, &input)?;
    let ranges = validate_ranges(&ranges_json)?;
    let done = run_sidecar(
        &app,
        "export",
        "cut-export.mjs",
        vec![
            "--input".into(),
            input.to_string_lossy().to_string(),
            "--ranges".into(),
            ranges,
            "--output".into(),
            output.to_string_lossy().to_string(),
        ],
        vec![],
    )
    .await?;
    Ok(done["output"]
        .as_str()
        .map(str::to_string)
        .unwrap_or_else(|| output.to_string_lossy().to_string()))
}

/// The source must be an existing regular file given as an absolute path (never an ffmpeg option).
fn validate_input_file(raw: &str) -> Result<PathBuf, String> {
    let path = PathBuf::from(raw);
    if !path.is_absolute() {
        return Err(format!("video path must be absolute: {raw}"));
    }
    let canonical = path
        .canonicalize()
        .map_err(|error| format!("video not found: {raw} ({error})"))?;
    if !canonical.is_file() {
        return Err(format!("not a file: {raw}"));
    }
    Ok(canonical)
}

/// The output must be an absolute video path in an existing directory and must not be the source.
fn validate_output_path(raw: &str, input: &Path) -> Result<PathBuf, String> {
    let path = PathBuf::from(raw);
    if !path.is_absolute() {
        return Err(format!("output path must be absolute: {raw}"));
    }
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .map(str::to_ascii_lowercase)
        .unwrap_or_default();
    if !OUTPUT_EXTENSIONS.contains(&extension.as_str()) {
        return Err(format!("unsupported output format: .{extension}"));
    }
    let parent = path
        .parent()
        .filter(|parent| parent.is_dir())
        .ok_or_else(|| format!("output directory does not exist: {raw}"))?;
    let file_name = path
        .file_name()
        .ok_or_else(|| format!("invalid output path: {raw}"))?;
    let canonical = parent
        .canonicalize()
        .map_err(|error| format!("invalid output directory: {error}"))?
        .join(file_name);
    if canonical == input {
        return Err("output must not overwrite the source video".to_string());
    }
    Ok(canonical)
}

#[derive(Debug, Deserialize, Serialize)]
struct KeepRange {
    start: f64,
    end: f64,
}

/// Ranges must be a non-empty JSON array of finite, ordered `{start, end}` pairs.
fn validate_ranges(raw: &str) -> Result<String, String> {
    let ranges: Vec<KeepRange> =
        serde_json::from_str(raw).map_err(|error| format!("invalid ranges: {error}"))?;
    if ranges.is_empty() {
        return Err("no ranges to keep".to_string());
    }
    if let Some(bad) = ranges.iter().find(|range| {
        !range.start.is_finite()
            || !range.end.is_finite()
            || range.start < 0.0
            || range.end <= range.start
    }) {
        return Err(format!("invalid range: {bad:?}"));
    }
    serde_json::to_string(&ranges).map_err(|error| format!("invalid ranges: {error}"))
}

/// Spawn a Node sidecar that prints JSON lines ({type:"progress"} … {type:"done"}),
/// forward progress as `cutter_progress` events and return the final `done` payload.
async fn run_sidecar<R: Runtime>(
    app: &AppHandle<R>,
    task: &str,
    script: &str,
    args: Vec<String>,
    envs: Vec<(&str, String)>,
) -> Result<serde_json::Value, String> {
    let project_dir = project_dir(app)?;
    let mut child = node_command()
        .current_dir(&project_dir)
        .arg(project_dir.join("scripts").join(script))
        .args(args)
        .envs(envs)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|error| format!("failed to spawn {script} (is Node.js installed?): {error}"))?;

    let mut stderr = child
        .stderr
        .take()
        .ok_or_else(|| format!("{script} stderr unavailable"))?;
    let stderr_task = tokio::spawn(async move {
        let mut text = String::new();
        let _ = stderr.read_to_string(&mut text).await;
        text
    });

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| format!("{script} stdout unavailable"))?;
    let mut lines = BufReader::new(stdout).lines();
    let mut done: Option<serde_json::Value> = None;
    while let Some(line) = lines
        .next_line()
        .await
        .map_err(|error| format!("failed reading {script} output: {error}"))?
    {
        let Ok(value) = serde_json::from_str::<serde_json::Value>(&line) else {
            continue;
        };
        if value["type"] == "progress" {
            let _ = app.emit(
                "cutter_progress",
                CutterProgress {
                    task: task.to_string(),
                    percent: value["percent"].as_u64().unwrap_or(0).min(100) as u8,
                    message: value["message"].as_str().unwrap_or_default().to_string(),
                },
            );
        } else if value["type"] == "done" {
            done = Some(value);
        }
    }

    let status = child
        .wait()
        .await
        .map_err(|error| format!("{script} wait failed: {error}"))?;
    let stderr_text = stderr_task.await.unwrap_or_default();
    if !status.success() {
        return Err(
            sidecar_error(&stderr_text).unwrap_or_else(|| format!("{script} exited with {status}"))
        );
    }
    done.ok_or_else(|| {
        sidecar_error(&stderr_text).unwrap_or_else(|| format!("{script} produced no result"))
    })
}

/// Sidecars report failures as `{"error": "..."}` on stderr; surface that message when present.
fn sidecar_error(stderr: &str) -> Option<String> {
    stderr
        .lines()
        .rev()
        .find_map(|line| serde_json::from_str::<serde_json::Value>(line).ok())
        .and_then(|value| value["error"].as_str().map(str::to_string))
        .or_else(|| {
            let trimmed = stderr.trim();
            (!trimmed.is_empty()).then(|| trimmed.chars().take(800).collect())
        })
}

fn project_dir<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_relative_and_missing_inputs() {
        assert!(validate_input_file("relative.mp4").is_err());
        assert!(validate_input_file("-i.mp4").is_err());
        assert!(validate_input_file("/definitely/missing/video.mp4").is_err());
        assert!(validate_input_file(env!("CARGO_MANIFEST_DIR")).is_err());
    }

    #[test]
    fn output_must_be_video_in_existing_dir_and_not_source() {
        let input =
            validate_input_file(concat!(env!("CARGO_MANIFEST_DIR"), "/Cargo.toml")).unwrap();
        let dir = std::env::temp_dir();
        assert!(validate_output_path(&dir.join("out.mp4").to_string_lossy(), &input).is_ok());
        assert!(validate_output_path(&dir.join("out.txt").to_string_lossy(), &input).is_err());
        assert!(validate_output_path("out.mp4", &input).is_err());
        assert!(validate_output_path("/definitely/missing/out.mp4", &input).is_err());

        let source = dir.join("webclaw-cutter-source.mp4");
        std::fs::write(&source, b"x").unwrap();
        let source_input = validate_input_file(&source.to_string_lossy()).unwrap();
        assert!(validate_output_path(&source.to_string_lossy(), &source_input).is_err());
        let _ = std::fs::remove_file(source);
    }

    #[test]
    fn validates_ranges() {
        assert!(validate_ranges(r#"[{"start":0,"end":1.5},{"start":2,"end":3}]"#).is_ok());
        assert!(validate_ranges("[]").is_err());
        assert!(validate_ranges(r#"[{"start":2,"end":1}]"#).is_err());
        assert!(validate_ranges(r#"[{"start":-1,"end":1}]"#).is_err());
        assert!(validate_ranges("/etc/passwd").is_err());
    }

    #[test]
    fn surfaces_sidecar_json_errors() {
        assert_eq!(
            sidecar_error("noise\n{\"error\":\"boom\"}\n").as_deref(),
            Some("boom")
        );
        assert_eq!(
            sidecar_error("plain failure").as_deref(),
            Some("plain failure")
        );
        assert_eq!(sidecar_error("  "), None);
    }

    /// Real IPC smoke: frontend-shaped (camelCase) invoke payloads → commands → Node sidecars → FFmpeg.
    /// Needs `npm ci` (node + ffmpeg-static); run with `cargo test -- --ignored`.
    #[test]
    #[ignore]
    fn ipc_smoke_transcribe_and_export() {
        use tauri::ipc::{CallbackFn, InvokeBody};
        use tauri::test::{get_ipc_response, mock_builder, mock_context, noop_assets, INVOKE_KEY};
        use tauri::webview::InvokeRequest;

        let project = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .to_path_buf();
        let ffmpeg = project.join("node_modules/ffmpeg-static/ffmpeg");
        let dir = std::env::temp_dir().join(format!("webclaw-ipc-smoke-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let video = dir.join("source.mp4");
        let tone = "if(between(t,0,2)+between(t,3.5,5)+between(t,6,8),0.5*sin(440*2*PI*t),0)";
        let status = std::process::Command::new(&ffmpeg)
            .args([
                "-y",
                "-hide_banner",
                "-loglevel",
                "error",
                "-f",
                "lavfi",
                "-i",
            ])
            .arg("testsrc2=size=320x180:rate=25:duration=8")
            .args(["-f", "lavfi", "-i"])
            .arg(format!("aevalsrc='{tone}':s=16000:d=8"))
            .args([
                "-c:v",
                "libx264",
                "-pix_fmt",
                "yuv420p",
                "-c:a",
                "aac",
                "-shortest",
            ])
            .arg(&video)
            .status()
            .expect("ffmpeg-static missing; run npm ci");
        assert!(status.success());

        let mut context = mock_context(noop_assets());
        context.config_mut().identifier = "com.webclaw.cutter-ipc-smoke".into();
        let app = mock_builder()
            .invoke_handler(tauri::generate_handler![
                allow_media_preview,
                transcribe_video,
                export_cut
            ])
            .build(context)
            .unwrap();
        let webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .unwrap();
        let invoke = |cmd: &str, body: serde_json::Value| {
            get_ipc_response(
                &webview,
                InvokeRequest {
                    cmd: cmd.into(),
                    callback: CallbackFn(0),
                    error: CallbackFn(1),
                    url: "tauri://localhost".parse().unwrap(),
                    body: InvokeBody::Json(body),
                    headers: Default::default(),
                    invoke_key: INVOKE_KEY.to_string(),
                },
            )
            .map(|response| response.deserialize::<serde_json::Value>().unwrap())
        };
        let video_path = video.to_string_lossy().to_string();

        let allowed = invoke(
            "allow_media_preview",
            serde_json::json!({ "videoPath": video_path }),
        )
        .unwrap();
        assert!(allowed.as_str().unwrap().ends_with("source.mp4"));
        assert!(invoke(
            "allow_media_preview",
            serde_json::json!({ "videoPath": "relative.mp4" })
        )
        .is_err());

        let transcript = invoke(
            "transcribe_video",
            serde_json::json!({ "videoPath": video_path, "provider": "silence", "optionsJson": "{}" }),
        )
        .unwrap();
        let segments = transcript["segments"].as_array().unwrap();
        assert_eq!(transcript["provider"], "silence");
        assert_eq!(segments.len(), 3);
        assert!(invoke(
            "transcribe_video",
            serde_json::json!({ "videoPath": video_path, "provider": "rm -rf", "optionsJson": "{}" }),
        )
        .is_err());

        // Keep segments 1 and 3 (drop the middle one), as the UI would after a cut.
        let ranges = serde_json::json!([
            { "start": 0.0, "end": segments[0]["end"] },
            { "start": segments[2]["start"], "end": transcript["duration"] },
        ]);
        let output = dir.join("cut.mp4");
        let exported = invoke(
            "export_cut",
            serde_json::json!({
                "videoPath": video_path,
                "rangesJson": ranges.to_string(),
                "outputPath": output.to_string_lossy(),
            }),
        )
        .unwrap();
        assert!(exported.as_str().unwrap().ends_with("cut.mp4"));
        assert!(output.metadata().unwrap().len() > 1000);
        assert!(invoke(
            "export_cut",
            serde_json::json!({ "videoPath": video_path, "rangesJson": ranges.to_string(), "outputPath": video_path }),
        )
        .is_err());

        let probe = std::process::Command::new(&ffmpeg)
            .arg("-i")
            .arg(&output)
            .output()
            .unwrap();
        let info = String::from_utf8_lossy(&probe.stderr);
        assert!(
            info.contains("Video: h264") && info.contains("Audio: aac"),
            "{info}"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}
