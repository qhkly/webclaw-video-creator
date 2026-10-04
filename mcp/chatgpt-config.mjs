// ChatGPT connection (OpenAI Secure Tunnel) settings, stored locally.
//
// Shape (also written by the Tauri app, src-tauri/src/commands/chatgpt_commands.rs):
//   { tunnelId, apiKey, autoStart, approval }
// The file lives in the app's own config dir with mode 0600. The API key never
// leaves this file except as an env var handed to tunnel-client; anything shown
// to the UI or written to logs goes through redactConfig / redactText.
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { APPROVAL_MODES } from './approval.mjs';

export const TUNNEL_ID_PATTERN = /^tunnel_[0-9a-f]{32}$/;

export const DEFAULT_CONFIG = Object.freeze({ tunnelId: '', apiKey: '', autoStart: false, approval: 'ask' });

export function validTunnelId(value) {
  return typeof value === 'string' && TUNNEL_ID_PATTERN.test(value);
}

/** Coerce anything read from disk into the canonical shape; unknown fields are dropped. */
export function normalizeConfig(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  return {
    tunnelId: typeof source.tunnelId === 'string' ? source.tunnelId.trim() : '',
    apiKey: typeof source.apiKey === 'string' ? source.apiKey.trim() : '',
    autoStart: source.autoStart === true,
    // Remote calls always go through the approval gate; only its strictness is configurable.
    approval: APPROVAL_MODES.includes(source.approval) ? source.approval : DEFAULT_CONFIG.approval,
  };
}

/** Missing or unreadable file -> defaults (the UI shows "not configured"). */
export async function loadConfig(path) {
  try {
    return normalizeConfig(JSON.parse(await readFile(path, 'utf8')));
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

/** Atomic write with owner-only permissions. */
export async function saveConfig(path, config) {
  const normalized = normalizeConfig(config);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const staging = `${path}.${process.pid}.tmp`;
  await writeFile(staging, `${JSON.stringify(normalized, null, 2)}\n`, { mode: 0o600 });
  await chmod(staging, 0o600);
  await rename(staging, path);
  return normalized;
}

/** What the UI / status file may see: never the key itself. */
export function redactConfig(config) {
  const normalized = normalizeConfig(config);
  return {
    tunnelId: normalized.tunnelId,
    hasApiKey: normalized.apiKey !== '',
    apiKeyHint: maskSecret(normalized.apiKey),
    autoStart: normalized.autoStart,
    approval: normalized.approval,
  };
}

/** "sk-…wxyz" for long keys, a fixed mask for short ones, "" when unset. */
export function maskSecret(secret) {
  if (typeof secret !== 'string' || secret === '') {
    return '';
  }
  if (secret.length < 12) {
    return '••••';
  }
  const prefix = secret.startsWith('sk-') ? 'sk-' : '';
  return `${prefix}…${secret.slice(-4)}`;
}

/** Scrub known secrets and anything shaped like an OpenAI key from a log line. */
export function redactText(text, secrets = []) {
  let output = String(text ?? '');
  for (const secret of secrets) {
    if (typeof secret === 'string' && secret.length >= 6) {
      output = output.split(secret).join('[redacted]');
    }
  }
  return output.replace(/\bsk-[A-Za-z0-9_-]{8,}/g, 'sk-[redacted]').replace(/(Bearer\s+)[A-Za-z0-9._~+/-]{8,}/gi, '$1[redacted]');
}
