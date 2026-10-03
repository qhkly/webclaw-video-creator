//! Runtime PATH for child processes (node sidecars, coding CLIs).
//!
//! GUI apps launched from Finder/Dock only get launchd's minimal PATH, so
//! nvm/Homebrew installs of `node`, `claude` and `codex` have to be recovered
//! from the user's login shell. Every command that spawns `node` goes through
//! `node_command()` so the Cutter, TTS, render and Agent paths resolve the same
//! binary.
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::OnceLock;
use tokio::process::Command;

/// `node` resolved via `effective_path()` (falls back to plain `node`), with that PATH exported to the child.
pub fn node_command() -> Command {
    let mut command = Command::new(which("node").unwrap_or_else(|| PathBuf::from("node")));
    command.env("PATH", effective_path());
    command
}

pub fn which(binary: &str) -> Option<PathBuf> {
    let names: Vec<String> = if cfg!(windows) {
        vec![format!("{binary}.cmd"), format!("{binary}.exe"), binary.to_string()]
    } else {
        vec![binary.to_string()]
    };
    std::env::split_paths(&effective_path())
        .flat_map(|dir| names.iter().map(move |name| dir.join(name)))
        .find(|candidate| candidate.is_file())
}

/// Login-shell PATH, then well-known install dirs, then the inherited PATH.
pub fn effective_path() -> String {
    static CACHE: OnceLock<String> = OnceLock::new();
    CACHE
        .get_or_init(|| {
            let mut dirs: Vec<PathBuf> = Vec::new();
            if let Some(login) = login_shell_path() {
                dirs.extend(std::env::split_paths(&login));
            }
            if let Some(home) = std::env::var_os("HOME").map(PathBuf::from) {
                dirs.push(home.join(".ai-studio").join("npm-global").join("bin"));
                dirs.push(home.join(".local").join("bin"));
                dirs.push(home.join(".npm-global").join("bin"));
                dirs.push(home.join(".volta").join("bin"));
                if let Ok(entries) = std::fs::read_dir(home.join(".nvm").join("versions").join("node")) {
                    let mut versions: Vec<PathBuf> = entries.flatten().map(|entry| entry.path().join("bin")).collect();
                    versions.sort_by_key(|path| std::cmp::Reverse(version_key(path)));
                    dirs.extend(versions);
                }
            }
            dirs.push(PathBuf::from("/opt/homebrew/bin"));
            dirs.push(PathBuf::from("/usr/local/bin"));
            if let Some(current) = std::env::var_os("PATH") {
                dirs.extend(std::env::split_paths(&current));
            }
            let mut seen = std::collections::HashSet::new();
            dirs.retain(|dir| seen.insert(dir.clone()));
            std::env::join_paths(dirs)
                .map(|joined| joined.to_string_lossy().to_string())
                .unwrap_or_default()
        })
        .clone()
}

fn version_key(bin_dir: &Path) -> (u64, u64, u64) {
    let name = bin_dir
        .parent()
        .and_then(|dir| dir.file_name())
        .and_then(|name| name.to_str())
        .unwrap_or_default()
        .trim_start_matches('v')
        .to_string();
    let mut parts = name.split('.').map(|part| part.parse::<u64>().unwrap_or(0));
    (parts.next().unwrap_or(0), parts.next().unwrap_or(0), parts.next().unwrap_or(0))
}

fn login_shell_path() -> Option<String> {
    if cfg!(windows) {
        return None;
    }
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
    let output = std::process::Command::new(shell)
        .args(["-lc", "printf %s \"$PATH\""])
        .stdin(Stdio::null())
        .output()
        .ok()?;
    let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
    (output.status.success() && !path.is_empty()).then_some(path)
}
