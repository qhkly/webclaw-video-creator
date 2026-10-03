// Variables another app's `tauri dev` / cargo run leaks into child processes.
//
// When Video Creator is started from a shell that descends from a different
// Tauri app in dev mode (e.g. a Claude Code / Codex session spawned by WebCode
// AI Studio), the parent's `TAURI_CONFIG={"build":{"devUrl":...}}` is inherited.
// The Tauri CLI merges it into our config, so our window loads the *parent's*
// frontend — the "AI Studio home page inside Video Creator" bug.
//
// Release-signing and user-set variables (TAURI_SIGNING_*, TAURI_DEV_HOST, …)
// are intentionally kept.
const LEAKED_EXACT = new Set([
  'TAURI_CONFIG',
  'CARGO_MANIFEST_DIR',
  'CARGO_MANIFEST_PATH',
  'CARGO_PRIMARY_PACKAGE',
  'CARGO_CRATE_NAME',
  'CARGO_BIN_NAME',
]);
const LEAKED_PREFIXES = ['TAURI_ENV_', 'TAURI_ANDROID_', 'CARGO_PKG_'];

export function sanitizeTauriEnv(env) {
  const clean = {};
  const removed = [];
  for (const [key, value] of Object.entries(env)) {
    if (LEAKED_EXACT.has(key) || LEAKED_PREFIXES.some((prefix) => key.startsWith(prefix))) {
      removed.push(key);
    } else {
      clean[key] = value;
    }
  }
  return { env: clean, removed };
}
