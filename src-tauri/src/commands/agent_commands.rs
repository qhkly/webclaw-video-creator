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
    let workspace = app_root.join(".video-work");
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

/// Scenes and rendered files of one project, for the Agent page's result panel.
#[tauri::command]
pub async fn agent_project_snapshot(app: AppHandle, project: String) -> Result<Value, String> {
    if !is_safe_id(&project) {
        return Err("invalid project id".to_string());
    }
    let dir = project_dir(&app)?.join(".video-work").join("projects").join(&project);
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

/// The directory agent runs write into; the asset protocol may serve files from it for previews.
pub fn video_work_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(project_dir(app)?.join(".video-work"))
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
