// Image generation through the user's own Codex/ChatGPT OAuth login
// (~/.codex/auth.json) via @openai-oauth/ai-sdk — no API key. Each call spends
// the account's image quota, so the tool using it is classed "paid".
//
// The model picks its own output size (it may differ from the request), so the
// raw image is kept as-is and a normalized copy is cover-cropped to a fixed
// canvas per aspect. That canvas is the asset size the video uses, independent
// of what the model returned and of the final render resolution (Remotion
// scales it).
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { run, ToolError } from './context.mjs';

export const OPENAI_OAUTH_IMAGE_MODEL = 'gpt-image-2';

/** Requested model size and normalized asset canvas for each video aspect. */
export const IMAGE_ASPECTS = {
  '16:9': { request: '1536x1024', width: 1920, height: 1080 },
  '9:16': { request: '1024x1536', width: 1080, height: 1920 },
  '1:1': { request: '1024x1024', width: 1080, height: 1080 },
};

/** Same lookup order as @openai-oauth/local: $CODEX_HOME/auth.json, then ~/.codex/auth.json. */
export function codexAuthCandidates(env = process.env, home = homedir()) {
  return [...new Set([env.CODEX_HOME && join(env.CODEX_HOME, 'auth.json'), join(home, '.codex', 'auth.json')].filter(Boolean))];
}

/**
 * Provider availability: a Codex OAuth login exists and the SDK can be loaded.
 * Only checks for token presence; never returns or logs credential contents.
 */
export async function checkOpenAIOAuthImage({ env = process.env, home = homedir(), loadSdk = loadOpenAIOAuthSdk } = {}) {
  let loggedIn = false;
  for (const path of codexAuthCandidates(env, home)) {
    try {
      const tokens = JSON.parse(await readFile(path, 'utf8'))?.tokens;
      if (tokens && (tokens.access_token || tokens.refresh_token)) {
        loggedIn = true;
        break;
      }
    } catch {
      // missing or unreadable: try the next location
    }
  }
  if (!loggedIn) {
    return { available: false, reason: 'no Codex OAuth login found (~/.codex/auth.json); run `codex login`' };
  }
  try {
    await loadSdk();
  } catch (error) {
    return { available: false, reason: `@openai-oauth/ai-sdk cannot be loaded: ${error.message}` };
  }
  return { available: true, model: OPENAI_OAUTH_IMAGE_MODEL };
}

export async function loadOpenAIOAuthSdk() {
  const [{ createOpenAIOAuth }, { openaiCredentials }, { generateImage }] = await Promise.all([
    import('@openai-oauth/ai-sdk'),
    import('@openai-oauth/local'),
    import('ai'),
  ]);
  return { createOpenAIOAuth, openaiCredentials, generateImage };
}

/** Generate one image; resolves to { bytes: Uint8Array, mediaType }. */
export async function generateWithOpenAIOAuth({ prompt, size }) {
  const { createOpenAIOAuth, openaiCredentials, generateImage } = await loadOpenAIOAuthSdk();
  const openai = createOpenAIOAuth(openaiCredentials());
  const { image } = await generateImage({
    model: openai.image(OPENAI_OAUTH_IMAGE_MODEL),
    prompt,
    size,
    // One approval should trigger at most one paid/quota-consuming generation request.
    maxRetries: 0,
    // Do not let a stuck OAuth/backend request hold an MCP tool call indefinitely.
    abortSignal: AbortSignal.timeout(180_000),
  });
  return { bytes: image.uint8Array, mediaType: image.mediaType || 'image/png' };
}

export function extensionFor(mediaType) {
  return { 'image/jpeg': 'jpg', 'image/webp': 'webp' }[mediaType] ?? 'png';
}

/** Scale to cover width x height, center-crop the overflow, write PNG. Returns the PNG's real size. */
export async function normalizeImage(ffmpeg, input, output, { width, height }) {
  const filter = `scale=${width}:${height}:force_original_aspect_ratio=increase:flags=lanczos,crop=${width}:${height}`;
  const result = await run(ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', '-i', input, '-vf', filter, '-frames:v', '1', '-f', 'image2', '-c:v', 'png', output]);
  if (result.code !== 0) {
    throw new ToolError(`ffmpeg could not normalize the image: ${result.stderr.trim().split('\n').slice(-3).join('\n')}`);
  }
  return readPngSize(await readFile(output));
}

export function readPngSize(buffer) {
  const signature = '89504e470d0a1a0a';
  if (buffer.length < 24 || buffer.subarray(0, 8).toString('hex') !== signature) {
    throw new ToolError('not a PNG file');
  }
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}
