//! Agent director runtime: runs the user's own coding CLI (Claude Code / Codex)
//! headless against the video MCP server and streams its events to the UI.
//!
//! Only the video tool surface is exposed: Claude runs `--restricted --tools ""`
//! with just the video-creator MCP server; Codex runs in a read-only sandbox.
//! Writes and paid generation are gated by the MCP server's approval channel
//! (mcp/approval.mjs), answered from the UI via `agent_decide_approval`.
//!
//! The CLI lookup mirrors webcode-ai-studio (`login_shell_path`): GUI apps
//! launched from Finder/Dock only get launchd's minimal PATH, so nvm/Homebrew
//! installs have to be recovered from the user's login shell.
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;
use tokio::sync::oneshot;

use super::node_env::{effective_path, which};

const SERVER_NAME: &str = "video-creator";
/// Client-side MCP tool timeout. Must exceed the server's approval wait (15 min,
/// mcp/approval.mjs) and long renders; Codex otherwise gives up after 300s.
const TOOL_TIMEOUT_SECS: u64 = 3600;

const DIRECTOR_PROMPT: &str = "You are the director of a short video in WebClaw Video Creator. \
Plan the video yourself and produce it only through the video-creator MCP tools. \
Start with video_project_status and video_brand_profile_get, follow the Brand DNA (voice, tone, visual style, captions). \
Keep every file in the given project. Typical flow: write scenes -> video_scenes_save -> video_tts_synthesize per scene -> video_render. \
If a tool is declined by the user, do not retry it unchanged. \
Finish with a short summary in the user's language listing the produced files.";

static RUNS: OnceLock<Mutex<HashMap<String, oneshot::Sender<()>>>> = OnceLock::new();
static RUN_COUNTER: AtomicU64 = AtomicU64::new(0);

fn runs() -> &'static Mutex<HashMap<String, oneshot::Sender<()>>> {
    RUNS.get_or_init(|| Mutex::new(HashMap::new()))
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AgentCliInfo {
    id: String,
    label: String,
    available: bool,
    path: Option<String>,
    version: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentStartParams {
    task: String,
    /// "auto" | "claude_code" | "codex"
    cli: Option<String>,
    model: Option<String>,
    /// "auto" | "ask" (see mcp/approval.mjs)
    approval: Option<String>,
    project: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentRunInfo {
    run_id: String,
    cli: String,
    project: String,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct AgentEventPayload {
    run_id: String,
    /// "stdout" (one JSON line from the CLI) | "stderr" | "exit"
    stream: String,
    line: Option<String>,
    code: Option<i32>,
}

#[tauri::command]
pub async fn agent_detect_clis() -> Result<Vec<AgentCliInfo>, String> {
    let mut result = Vec::new();
    for (id, label, binary) in [("claude_code", "Claude Code", "claude"), ("codex", "Codex", "codex")] {
        let path = which(binary);
        let version = match &path {
            Some(path) => cli_version(path).await,
            None => None,
        };
        result.push(AgentCliInfo {
            id: id.to_string(),
            label: label.to_string(),
            available: path.is_some() && version.is_some(),
            path: path.map(|path| path.to_string_lossy().to_string()),
            version,
        });
    }
    Ok(result)
}

#[tauri::command]
pub async fn agent_start(app: AppHandle, params: AgentStartParams) -> Result<AgentRunInfo, String> {
    let task = params.task.trim().to_string();
    if task.is_empty() {
        return Err("请输入要制作的视频任务".to_string());
    }
    let project = params.project.trim().to_string();
    if !is_safe_id(&project) {
        return Err("项目名只能包含字母、数字、点、下划线和短横线".to_string());
    }
    let cli = match params.cli.as_deref().unwrap_or("auto") {
        "auto" => {
            if which("claude").is_some() {
                "claude_code"
            } else if which("codex").is_some() {
                "codex"
            } else {
                return Err("未检测到 Claude Code 或 Codex CLI，请先安装并登录其中一个".to_string());
            }
        }
        "claude_code" => "claude_code",
        "codex" => "codex",
        other => return Err(format!("不支持的 CLI：{other}")),
    };
    let approval = match params.approval.as_deref().unwrap_or("auto") {
        "ask" => "ask",
        _ => "auto",
    };

    let app_root = project_dir(&app)?;
    let workspace = video_work_dir(&app)?;
    let run_id = format!(
        "{}-{}",
        SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0),
        RUN_COUNTER.fetch_add(1, Ordering::Relaxed)
    );
    let run_dir = workspace.join(".agent").join("runs").join(&run_id);
    let approval_dir = run_dir.join("approvals");
    tokio::fs::create_dir_all(&approval_dir)
        .await
        .map_err(|error| format!("failed to create run directory: {error}"))?;

    let node = which("node").ok_or("未找到 node，无法启动视频工具（MCP server）")?;
    let server = app_root.join("mcp").join("server.mjs");
    let mcp_env = json!({
        "VIDEO_CREATOR_WORKSPACE": workspace.to_string_lossy(),
        "VIDEO_CREATOR_APPROVAL_DIR": approval_dir.to_string_lossy(),
        "VIDEO_CREATOR_APPROVAL": approval,
        "PATH": effective_path(),
    });
    let instructions = format!("{DIRECTOR_PROMPT} Project id: \"{project}\".");

    let (binary, args) = if cli == "claude_code" {
        let mcp_config = run_dir.join("mcp.json");
        let config = json!({
            "mcpServers": {
                SERVER_NAME: {
                    "type": "stdio",
                    "command": node.to_string_lossy(),
                    "args": [server.to_string_lossy()],
                    "env": mcp_env,
                }
            }
        });
        tokio::fs::write(&mcp_config, serde_json::to_vec_pretty(&config).unwrap_or_default())
            .await
            .map_err(|error| format!("failed to write MCP config: {error}"))?;
        let mut args = vec![
            "-p".to_string(),
            task.clone(),
            "--output-format".to_string(),
            "stream-json".to_string(),
            "--verbose".to_string(),
            // No built-in tools and no user/project settings: only the video tools exist.
            "--restricted".to_string(),
            "--tools".to_string(),
            String::new(),
            "--strict-mcp-config".to_string(),
            "--mcp-config".to_string(),
            mcp_config.to_string_lossy().to_string(),
            "--allowedTools".to_string(),
            format!("mcp__{SERVER_NAME}"),
            "--append-system-prompt".to_string(),
            instructions,
        ];
        if let Some(model) = params.model.as_deref().map(str::trim).filter(|m| !m.is_empty()) {
            args.push("--model".to_string());
            args.push(model.to_string());
        }
        (which("claude").ok_or("未找到 claude CLI")?, args)
    } else {
        let env_table = mcp_env
            .as_object()
            .map(|map| {
                map.iter()
                    .map(|(key, value)| format!("{key}={}", toml_string(value.as_str().unwrap_or_default())))
                    .collect::<Vec<_>>()
                    .join(", ")
            })
            .unwrap_or_default();
        let mut args = vec![
            "exec".to_string(),
            "--json".to_string(),
            "--sandbox".to_string(),
            "read-only".to_string(),
            "--skip-git-repo-check".to_string(),
            "-c".to_string(),
            format!("mcp_servers.{SERVER_NAME}.command={}", toml_string(&node.to_string_lossy())),
            "-c".to_string(),
            format!("mcp_servers.{SERVER_NAME}.args=[{}]", toml_string(&server.to_string_lossy())),
            "-c".to_string(),
            format!("mcp_servers.{SERVER_NAME}.env={{{env_table}}}"),
            "-c".to_string(),
            format!("mcp_servers.{SERVER_NAME}.tool_timeout_sec={TOOL_TIMEOUT_SECS}"),
        ];
        if let Some(model) = params.model.as_deref().map(str::trim).filter(|m| !m.is_empty()) {
            args.push("-m".to_string());
            args.push(model.to_string());
        }
        args.push(format!("{instructions}\n\nTask:\n{task}"));
        (which("codex").ok_or("未找到 codex CLI")?, args)
    };

    let mut child = Command::new(&binary)
        .args(&args)
        .current_dir(&app_root)
        .env("PATH", effective_path())
        // Never hand our own (or a parent app's) Tauri dev config to the agent's children.
        .env_remove("TAURI_CONFIG")
        // Claude Code's MCP tool timeout (ms); Codex gets tool_timeout_sec above.
        .env("MCP_TOOL_TIMEOUT", (TOOL_TIMEOUT_SECS * 1000).to_string())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|error| format!("无法启动 {}: {error}", binary.display()))?;

    let stdout = child.stdout.take().ok_or("CLI stdout unavailable")?;
    let stderr = child.stderr.take().ok_or("CLI stderr unavailable")?;
    let (stop_tx, stop_rx) = oneshot::channel::<()>();
    runs().lock().map_err(|_| "run registry poisoned")?.insert(run_id.clone(), stop_tx);

    spawn_line_forwarder(app.clone(), run_id.clone(), "stdout", stdout);
    spawn_line_forwarder(app.clone(), run_id.clone(), "stderr", stderr);
    let exit_app = app.clone();
    let exit_run_id = run_id.clone();
    tauri::async_runtime::spawn(async move {
        let code = tokio::select! {
            status = child.wait() => status.ok().and_then(|status| status.code()),
            _ = stop_rx => {
                let _ = child.kill().await;
                Some(-1)
            }
        };
        if let Ok(mut map) = runs().lock() {
            map.remove(&exit_run_id);
        }
        // Let the line forwarders flush the last events before announcing the exit.
        tokio::time::sleep(Duration::from_millis(150)).await;
        let _ = exit_app.emit(
            "agent_event",
            AgentEventPayload { run_id: exit_run_id, stream: "exit".to_string(), line: None, code },
        );
    });

    Ok(AgentRunInfo { run_id, cli: cli.to_string(), project })
}

#[tauri::command]
pub async fn agent_stop(run_id: String) -> Result<bool, String> {
    let sender = runs().lock().map_err(|_| "run registry poisoned")?.remove(&run_id);
    Ok(sender.map(|sender| sender.send(()).is_ok()).unwrap_or(false))
}

#[tauri::command]
pub async fn agent_pending_approvals(app: AppHandle, run_id: String) -> Result<Vec<Value>, String> {
    let dir = approvals_dir(&app, &run_id)?;
    let mut pending = Vec::new();
    let Ok(mut entries) = tokio::fs::read_dir(&dir).await else {
        return Ok(pending);
    };
    while let Ok(Some(entry)) = entries.next_entry().await {
        let name = entry.file_name().to_string_lossy().to_string();
        let Some(id) = name.strip_suffix(".request.json") else {
            continue;
        };
        if dir.join(format!("{id}.decision.json")).exists() {
            continue;
        }
        if let Ok(contents) = tokio::fs::read_to_string(entry.path()).await {
            if let Ok(value) = serde_json::from_str::<Value>(&contents) {
                pending.push(value);
            }
        }
    }
    Ok(pending)
}

#[tauri::command]
pub async fn agent_decide_approval(
    app: AppHandle,
    run_id: String,
    approval_id: String,
    allow: bool,
    note: Option<String>,
) -> Result<(), String> {
    if !is_safe_id(&approval_id) {
        return Err("invalid approval id".to_string());
    }
    let dir = approvals_dir(&app, &run_id)?;
    if !dir.join(format!("{approval_id}.request.json")).exists() {
        return Err("该确认请求已失效".to_string());
    }
    let decision = json!({ "allow": allow, "note": note.unwrap_or_default() });
    // Write then rename so the MCP server never reads a half-written decision.
    let staging = dir.join(format!("{approval_id}.decision.tmp"));
    tokio::fs::write(&staging, decision.to_string())
        .await
        .map_err(|error| format!("failed to write decision: {error}"))?;
    tokio::fs::rename(&staging, dir.join(format!("{approval_id}.decision.json")))
        .await
        .map_err(|error| format!("failed to write decision: {error}"))
}

#[tauri::command]
pub async fn agent_list_projects(app: AppHandle) -> Result<Value, String> {
    let projects_dir = video_work_dir(&app)?.join("projects");
    let mut projects = Vec::new();
    let Ok(mut entries) = tokio::fs::read_dir(&projects_dir).await else {
        return Ok(Value::Array(projects));
    };
    while let Ok(Some(entry)) = entries.next_entry().await {
        let Ok(file_type) = entry.file_type().await else {
            continue;
        };
        if !file_type.is_dir() {
            continue;
        }
        let id = entry.file_name().to_string_lossy().to_string();
        if !is_safe_id(&id) {
            continue;
        }
        let dir = entry.path();
        let scenes = tokio::fs::read_to_string(dir.join("scenes.json"))
            .await
            .ok()
            .and_then(|contents| serde_json::from_str::<Value>(&contents).ok())
            .and_then(|value| value.as_array().cloned());
        let scene_count = scenes.as_ref().map_or(0, Vec::len);
        let voiced_count = scenes
            .as_ref()
            .map(|items| {
                items
                    .iter()
                    .filter(|scene| scene.get("audio").is_some_and(|audio| !audio.is_null()))
                    .count()
            })
            .unwrap_or(0);
        let total_duration = scenes
            .as_ref()
            .map(|items| {
                items
                    .iter()
                    .filter_map(|scene| scene.get("duration").and_then(Value::as_f64))
                    .sum::<f64>()
            })
            .unwrap_or(0.0);
        let mut modified_ms = tokio::fs::metadata(dir.join("scenes.json"))
            .await
            .ok()
            .and_then(|meta| meta.modified().ok())
            .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
            .map(|duration| duration.as_millis() as u64)
            .unwrap_or(0);
        let mut render_count = 0usize;
        if let Ok(mut renders) = tokio::fs::read_dir(dir.join("renders")).await {
            while let Ok(Some(render)) = renders.next_entry().await {
                let path = render.path();
                let is_video = path
                    .extension()
                    .and_then(|ext| ext.to_str())
                    .map(|ext| matches!(ext.to_ascii_lowercase().as_str(), "mp4" | "mov" | "webm"))
                    .unwrap_or(false);
                if is_video {
                    render_count += 1;
                    if let Ok(meta) = render.metadata().await {
                        if let Some(ms) = meta
                            .modified()
                            .ok()
                            .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
                            .map(|duration| duration.as_millis() as u64)
                        {
                            modified_ms = modified_ms.max(ms);
                        }
                    }
                }
            }
        }
        projects.push(json!({
            "id": id,
            "modifiedMs": modified_ms,
            "sceneCount": scene_count,
            "voicedCount": voiced_count,
            "totalDuration": total_duration,
            "renderCount": render_count,
        }));
    }
    projects.sort_by_key(|project| std::cmp::Reverse(project["modifiedMs"].as_u64().unwrap_or(0)));
    Ok(Value::Array(projects))
}

#[tauri::command]
pub async fn agent_project_save_scenes(
    app: AppHandle,
    project: String,
    scenes: Value,
) -> Result<Value, String> {
    if !is_safe_id(&project) {
        return Err("invalid project id".to_string());
    }
    if !scenes.is_array() {
        return Err("scenes must be an array".to_string());
    }
    let dir = video_work_dir(&app)?.join("projects").join(&project);
    tokio::fs::create_dir_all(&dir)
        .await
        .map_err(|error| format!("failed to create project directory: {error}"))?;
    let path = dir.join("scenes.json");
    let staging = dir.join("scenes.json.tmp");
    let contents = serde_json::to_vec_pretty(&scenes)
        .map_err(|error| format!("failed to serialize scenes: {error}"))?;
    tokio::fs::write(&staging, contents)
        .await
        .map_err(|error| format!("failed to stage scenes: {error}"))?;
    tokio::fs::rename(&staging, &path)
        .await
        .map_err(|error| format!("failed to save scenes: {error}"))?;
    let modified_ms = tokio::fs::metadata(&path)
        .await
        .ok()
        .and_then(|meta| meta.modified().ok())
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0);
    Ok(json!({ "project": project, "path": path.to_string_lossy(), "modifiedMs": modified_ms }))
}

/// Scenes and rendered files of one project, for the Agent page's result panel.
#[tauri::command]
pub async fn agent_project_snapshot(app: AppHandle, project: String) -> Result<Value, String> {
    if !is_safe_id(&project) {
        return Err("invalid project id".to_string());
    }
    let dir = video_work_dir(&app)?.join("projects").join(&project);
    let scenes = tokio::fs::read_to_string(dir.join("scenes.json"))
        .await
        .ok()
        .and_then(|contents| serde_json::from_str::<Value>(&contents).ok());
    let mut renders = Vec::new();
    if let Ok(mut entries) = tokio::fs::read_dir(dir.join("renders")).await {
        while let Ok(Some(entry)) = entries.next_entry().await {
            let path = entry.path();
            let is_video = path
                .extension()
                .and_then(|ext| ext.to_str())
                .map(|ext| matches!(ext.to_ascii_lowercase().as_str(), "mp4" | "mov" | "webm"))
                .unwrap_or(false);
            if !is_video {
                continue;
            }
            let meta = entry.metadata().await.ok();
            let modified = meta
                .as_ref()
                .and_then(|meta| meta.modified().ok())
                .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
                .map(|duration| duration.as_millis() as u64)
                .unwrap_or(0);
            renders.push(json!({
                "name": entry.file_name().to_string_lossy(),
                "path": path.to_string_lossy(),
                "size": meta.map(|meta| meta.len()).unwrap_or(0),
                "modifiedMs": modified,
            }));
        }
    }
    renders.sort_by_key(|render| std::cmp::Reverse(render["modifiedMs"].as_u64().unwrap_or(0)));
    Ok(json!({ "project": project, "dir": dir.to_string_lossy(), "scenes": scenes, "renders": renders }))
}

/// Stable persistent workspace shared by the UI, local agents and ChatGPT.
///
/// This must not live under the source checkout: in development that path changes
/// with the active git worktree, and in a packaged app the resource directory may
/// be read-only. Existing .video-work data is copied once into app data without
/// deleting the legacy directory.
pub fn video_work_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("failed to resolve app data directory: {error}"))?;
    let legacy = project_dir(app)?.join(".video-work");
    resolve_video_work_dir(&app_data, &legacy)
}

fn resolve_video_work_dir(app_data: &Path, legacy: &Path) -> Result<PathBuf, String> {
    let target = app_data.join("video-work");
    if target.exists() {
        return Ok(target);
    }
    std::fs::create_dir_all(app_data)
        .map_err(|error| format!("failed to create app data directory {}: {error}", app_data.display()))?;

    if legacy.is_dir() {
        migrate_legacy_video_work(legacy, &target)?;
        let marker = legacy.join(".migrated-to-app-data");
        let _ = std::fs::write(&marker, format!("{}\n", target.display()));
    } else {
        std::fs::create_dir_all(&target)
            .map_err(|error| format!("failed to create video workspace {}: {error}", target.display()))?;
    }
    Ok(target)
}

fn migrate_legacy_video_work(legacy: &Path, target: &Path) -> Result<(), String> {
    if target.exists() {
        return Ok(());
    }
    let parent = target.parent().ok_or_else(|| format!("video workspace has no parent: {}", target.display()))?;
    std::fs::create_dir_all(parent).map_err(|error| format!("failed to create {}: {error}", parent.display()))?;
    let staging = parent.join(format!(".video-work-migrating-{}", std::process::id()));
    if staging.exists() {
        std::fs::remove_dir_all(&staging)
            .map_err(|error| format!("failed to clear stale migration {}: {error}", staging.display()))?;
    }
    copy_dir_recursive(legacy, &staging)?;
    match std::fs::rename(&staging, target) {
        Ok(()) => Ok(()),
        Err(_error) if target.exists() => {
            let _ = std::fs::remove_dir_all(&staging);
            Ok(())
        }
        Err(error) => {
            let _ = std::fs::remove_dir_all(&staging);
            Err(format!(
                "failed to publish migrated video workspace {} -> {}: {error}",
                staging.display(),
                target.display()
            ))
        }
    }
}

fn copy_dir_recursive(source: &Path, target: &Path) -> Result<(), String> {
    std::fs::create_dir_all(target).map_err(|error| format!("failed to create {}: {error}", target.display()))?;
    let entries = std::fs::read_dir(source).map_err(|error| format!("failed to read {}: {error}", source.display()))?;
    for entry in entries {
        let entry = entry.map_err(|error| format!("failed to read entry under {}: {error}", source.display()))?;
        let from = entry.path();
        let to = target.join(entry.file_name());
        let file_type = entry.file_type().map_err(|error| format!("failed to inspect {}: {error}", from.display()))?;
        if file_type.is_dir() {
            copy_dir_recursive(&from, &to)?;
        } else if file_type.is_file() {
            std::fs::copy(&from, &to)
                .map_err(|error| format!("failed to copy {} -> {}: {error}", from.display(), to.display()))?;
        } else if file_type.is_symlink() {
            copy_symlink(&from, &to)?;
        }
    }
    Ok(())
}

#[cfg(unix)]
fn copy_symlink(source: &Path, target: &Path) -> Result<(), String> {
    use std::os::unix::fs::symlink;
    let link = std::fs::read_link(source).map_err(|error| format!("failed to read symlink {}: {error}", source.display()))?;
    symlink(&link, target).map_err(|error| format!("failed to copy symlink {} -> {}: {error}", source.display(), target.display()))
}

#[cfg(windows)]
fn copy_symlink(source: &Path, target: &Path) -> Result<(), String> {
    use std::os::windows::fs::{symlink_dir, symlink_file};
    let link = std::fs::read_link(source).map_err(|error| format!("failed to read symlink {}: {error}", source.display()))?;
    let metadata = std::fs::metadata(source).map_err(|error| format!("failed to inspect symlink target {}: {error}", source.display()))?;
    if metadata.is_dir() {
        symlink_dir(&link, target)
    } else {
        symlink_file(&link, target)
    }
    .map_err(|error| format!("failed to copy symlink {} -> {}: {error}", source.display(), target.display()))
}

fn spawn_line_forwarder<R>(app: AppHandle, run_id: String, stream: &'static str, reader: R)
where
    R: tokio::io::AsyncRead + Unpin + Send + 'static,
{
    tauri::async_runtime::spawn(async move {
        let mut lines = BufReader::new(reader).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            if line.trim().is_empty() {
                continue;
            }
            let _ = app.emit(
                "agent_event",
                AgentEventPayload { run_id: run_id.clone(), stream: stream.to_string(), line: Some(line), code: None },
            );
        }
    });
}

fn approvals_dir(app: &AppHandle, run_id: &str) -> Result<PathBuf, String> {
    if !is_safe_id(run_id) {
        return Err("invalid run id".to_string());
    }
    Ok(video_work_dir(app)?.join(".agent").join("runs").join(run_id).join("approvals"))
}

fn is_safe_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && !value.starts_with('.')
        && value.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
}

fn toml_string(value: &str) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| "\"\"".to_string())
}

async fn cli_version(path: &Path) -> Option<String> {
    let output = tokio::time::timeout(
        Duration::from_secs(15),
        Command::new(path).arg("--version").env("PATH", effective_path()).stdin(Stdio::null()).output(),
    )
    .await
    .ok()?
    .ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout).trim().to_string();
    // `claude --version` prints "2.1.0 (Claude Code)"; the label is shown separately, so drop the suffix.
    let first = text.lines().next().unwrap_or_default();
    Some(first.split(" (").next().unwrap_or(first).trim().to_string())
}

pub fn project_dir(app: &AppHandle) -> Result<PathBuf, String> {
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
mod workspace_tests {
    use super::*;

    fn temp_root(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "webclaw-video-work-{label}-{}-{}",
            std::process::id(),
            SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()
        ))
    }

    #[test]
    fn migration_copies_legacy_without_deleting_it() {
        let root = temp_root("migrate");
        let app_data = root.join("app-data");
        let legacy = root.join("checkout").join(".video-work");
        std::fs::create_dir_all(legacy.join("projects/demo")).unwrap();
        std::fs::write(legacy.join("projects/demo/scenes.json"), b"legacy").unwrap();

        let target = resolve_video_work_dir(&app_data, &legacy).unwrap();
        assert_eq!(target, app_data.join("video-work"));
        assert_eq!(std::fs::read(target.join("projects/demo/scenes.json")).unwrap(), b"legacy");
        assert_eq!(std::fs::read(legacy.join("projects/demo/scenes.json")).unwrap(), b"legacy");
        assert!(legacy.join(".migrated-to-app-data").exists());

        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn existing_app_data_workspace_wins_without_merging_legacy() {
        let root = temp_root("existing");
        let app_data = root.join("app-data");
        let target = app_data.join("video-work");
        let legacy = root.join("checkout").join(".video-work");
        std::fs::create_dir_all(&target).unwrap();
        std::fs::create_dir_all(&legacy).unwrap();
        std::fs::write(target.join("new.txt"), b"new").unwrap();
        std::fs::write(legacy.join("old.txt"), b"old").unwrap();

        assert_eq!(resolve_video_work_dir(&app_data, &legacy).unwrap(), target);
        assert!(target.join("new.txt").exists());
        assert!(!target.join("old.txt").exists());
        assert!(legacy.join("old.txt").exists());

        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn fresh_workspace_is_created_under_app_data() {
        let root = temp_root("fresh");
        let app_data = root.join("app-data");
        let legacy = root.join("checkout").join(".video-work");

        let target = resolve_video_work_dir(&app_data, &legacy).unwrap();
        assert_eq!(target, app_data.join("video-work"));
        assert!(target.is_dir());

        let _ = std::fs::remove_dir_all(root);
    }
}
