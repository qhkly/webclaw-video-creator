// Pluggable media-generation providers. Kept separate from agent reasoning: the
// agent (Claude Code / Codex, on the user's own plan) decides *what* to make;
// providers only turn a request into a media file. No LLM provider lives here.
//
// billing: "free" (no account), "local" (runs on this machine), "paid" (metered API key).
import { exists, findFfmpeg, run } from './context.mjs';
import { join } from 'node:path';

const F5_URL = 'http://127.0.0.1:9880';

export const PROVIDERS = [
  {
    id: 'edge',
    kind: 'tts',
    billing: 'free',
    description: 'Microsoft Edge neural voices via scripts/tts.mjs. Returns word-level timings for captions.',
    voiceClone: false,
    check: async () => ({ available: true }),
  },
  {
    id: 'f5',
    kind: 'tts',
    billing: 'local',
    description: `F5-TTS voice-clone server at ${F5_URL}/tts (scripts/tts.mjs --engine f5). Word timings are estimated.`,
    voiceClone: true,
    check: async () => probeHttp(F5_URL),
  },
  {
    id: 'ffmpeg',
    kind: 'compose',
    billing: 'local',
    description: 'FFmpeg (ffmpeg-static or PATH) for probing, muxing and cutting.',
    check: async () => {
      const ffmpeg = await findFfmpeg();
      const { code } = await run(ffmpeg, ['-hide_banner', '-version']).catch(() => ({ code: -1 }));
      return code === 0 ? { available: true, path: ffmpeg } : { available: false, reason: `${ffmpeg} -version exited ${code}; set FFMPEG_PATH` };
    },
  },
  {
    id: 'remotion',
    kind: 'render',
    billing: 'local',
    description: 'Remotion renderer for scene templates (scripts/render.mjs).',
    check: async (ctx) => ({ available: await exists(join(ctx.appRoot, 'node_modules', '@remotion', 'renderer')) }),
  },
  {
    id: 'pexels',
    kind: 'stock',
    billing: 'free',
    description: 'Pexels stock video/photo search (scripts/fetch-assets.mjs). Needs PEXELS_API_KEY.',
    check: async () => ({ available: Boolean(process.env.PEXELS_API_KEY), reason: process.env.PEXELS_API_KEY ? undefined : 'PEXELS_API_KEY not set' }),
  },
];

// Capability slots the director can plan around but that have no adapter yet.
export const PLANNED_KINDS = [
  { kind: 'asr', note: 'Transcription adapters (openai-compatible / whisper-cpp / silence) arrive with the Cutter MVP merge.' },
  { kind: 'image-gen', note: 'Paid image generation adapters (pluggable, API key per provider).' },
  { kind: 'video-gen', note: 'Paid video generation adapters (pluggable, API key per provider).' },
];

export async function listProviders(ctx) {
  const providers = await Promise.all(
    PROVIDERS.map(async ({ check, ...meta }) => {
      try {
        return { ...meta, ...(await check(ctx)) };
      } catch (error) {
        return { ...meta, available: false, reason: error.message };
      }
    }),
  );
  return { providers, planned: PLANNED_KINDS };
}

export function providerIds(kind) {
  return PROVIDERS.filter((provider) => provider.kind === kind).map((provider) => provider.id);
}

export function getProvider(id, kind) {
  return PROVIDERS.find((provider) => provider.id === id && (!kind || provider.kind === kind));
}

async function probeHttp(url) {
  try {
    await fetch(url, { signal: AbortSignal.timeout(800) });
    return { available: true };
  } catch {
    return { available: false, reason: `no server at ${url}` };
  }
}
