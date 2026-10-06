// Plan limits for the Node side (render / cut export sidecars, MCP tools).
//
// The Rust app is the source of truth: it derives the limits from the store's
// machine-readable benefits (src-tauri/src/commands/account_commands.rs) and
//   - passes them to the sidecars it spawns as --maxHeight / --watermark, and
//   - writes them, with an expiry, to the entitlement file the MCP servers read
//     (VIDEO_CREATOR_ENTITLEMENT_FILE).
// Everything here fails closed: a missing argument, file, field or a stale file
// means the free plan. Contract: docs/account-membership.md.
import { readFile } from 'node:fs/promises';

export const FREE_LIMITS = Object.freeze({
  /** Short side of the exported frame, in pixels (the app's "720p" preset). */
  maxExportHeight: 720,
  watermark: true,
  aiDirector: false,
  aiCutCleanup: false,
  commercialUse: false,
});

export const MIN_EXPORT_HEIGHT = 720;
export const MAX_EXPORT_HEIGHT = 2160;

/** Render presets → short side in pixels (ASPECT_DIMENSIONS short side is 1080 at scale 1). */
export const RESOLUTION_HEIGHT = Object.freeze({ '720p': 720, '1080p': 1080, '4K': 2160 });

function clampHeight(value) {
  return Number.isInteger(value) ? Math.min(MAX_EXPORT_HEIGHT, Math.max(MIN_EXPORT_HEIGHT, value)) : FREE_LIMITS.maxExportHeight;
}

/** Field-by-field validation; anything unexpected falls back to the free value. */
export function sanitizeLimits(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return FREE_LIMITS;
  return {
    maxExportHeight: clampHeight(raw.maxExportHeight),
    watermark: raw.watermark !== false,
    aiDirector: raw.aiDirector === true,
    aiCutCleanup: raw.aiCutCleanup === true,
    commercialUse: raw.commercialUse === true,
  };
}

/** The entitlement file written by the app: `{ version: 1, limits, expiresAt: <epoch ms> }`. */
export async function readPlanFile(path, now = Date.now()) {
  if (!path) return FREE_LIMITS;
  try {
    const data = JSON.parse(await readFile(path, 'utf8'));
    if (data?.version !== 1 || typeof data.expiresAt !== 'number' || data.expiresAt <= now) return FREE_LIMITS;
    return sanitizeLimits(data.limits);
  } catch {
    return FREE_LIMITS;
  }
}

export function planFromEnv(env = process.env) {
  return readPlanFile(env.VIDEO_CREATOR_ENTITLEMENT_FILE);
}

/** Sidecar arguments: --maxHeight <px> --watermark 0|1. Missing → free. */
export function limitsFromArgs(args) {
  const height = Number(args.maxHeight);
  return {
    maxExportHeight: clampHeight(Number.isFinite(height) ? Math.trunc(height) : NaN),
    watermark: args.watermark !== '0',
  };
}

export function limitArgs(limits) {
  const safe = sanitizeLimits(limits);
  return ['--maxHeight', String(safe.maxExportHeight), '--watermark', safe.watermark ? '1' : '0'];
}

/** Highest render preset that is ≤ both the request and the plan limit. Unknown request → 1080p. */
export function clampResolution(requested, maxHeight) {
  const want = RESOLUTION_HEIGHT[requested] ?? RESOLUTION_HEIGHT['1080p'];
  const limit = Math.min(want, clampHeight(maxHeight));
  const fitting = Object.entries(RESOLUTION_HEIGHT).filter(([, height]) => height <= limit);
  return fitting.length ? fitting[fitting.length - 1][0] : '720p';
}

const even = (value) => Math.max(2, 2 * Math.round(value / 2));

/**
 * Output size for a source frame so that its short side is ≤ maxShortSide.
 * Never upscales; returns null when no scaling is needed.
 */
export function fitShortSide(width, height, maxShortSide) {
  if (!(width > 0 && height > 0)) throw new Error('无法读取视频分辨率，无法按套餐限制导出');
  const short = Math.min(width, height);
  if (short <= maxShortSide) return null;
  const factor = maxShortSide / short;
  return { width: even(width * factor), height: even(height * factor) };
}

/** Watermark asset: a transparent PNG of the product name (scripts/assets/watermark.png). */
export const WATERMARK_ASSET = { file: 'watermark.png', width: 1200, height: 150 };

/** Watermark box for a frame, bottom-right: 26% of a landscape/square frame's width, 42% of a portrait one's. */
export function watermarkBox(frameWidth, frameHeight) {
  const share = frameWidth >= frameHeight ? 0.26 : 0.42;
  const width = even(Math.max(120, frameWidth * share));
  const height = even((width * WATERMARK_ASSET.height) / WATERMARK_ASSET.width);
  const margin = Math.round(Math.min(frameWidth, frameHeight) * 0.03);
  return { width, height, x: frameWidth - width - margin, y: frameHeight - height - margin };
}
