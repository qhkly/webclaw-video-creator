// Creator "Brand DNA": persistent identity the agent director must read before
// planning. Stored as plain JSON at <workspace>/brand/<profile>.json so it can be
// edited by hand or by a future settings UI; missing fields fall back to defaults.
import { readdir, readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { exists, ToolError } from './context.mjs';

export const DEFAULT_BRAND = {
  id: 'default',
  displayName: '',
  voice: {
    // Provider id from video_providers_list (tts kind), e.g. "edge" or "f5" (voice clone).
    provider: 'edge',
    voiceId: 'zh-CN-YunxiNeural',
    // Reference audio for cloning providers; workspace-relative.
    cloneReference: null,
    rate: '+0%',
  },
  persona: {
    audience: '',
    tone: '',
    pointsOfView: [],
    mustSay: [],
    avoid: [],
    language: 'zh-CN',
  },
  visual: {
    aspect: '16:9',
    palette: { background: '#0f172a', text: '#f8fafc', accent: '#38bdf8' },
    fontFamily: null,
    preferredTemplates: ['TitleSlide', 'BulletPoints', 'CodeExplainer'],
    logo: null,
  },
  captions: {
    enabled: true,
    position: 'bottom',
    fontSize: 48,
    activeColor: '#facc15',
    inactiveColor: '#ffffff',
  },
  music: {
    mood: '',
    bgm: [],
    volume: 0.15,
  },
  // Reusable material: intro/outro clips, b-roll, product shots, etc. (workspace-relative paths).
  assets: [],
};

export function brandDir(ctx) {
  return join(ctx.workspace, 'brand');
}

export async function listBrandProfiles(ctx) {
  const dir = brandDir(ctx);
  if (!(await exists(dir))) {
    return [];
  }
  const entries = await readdir(dir);
  return entries.filter((name) => name.endsWith('.json')).map((name) => basename(name, '.json'));
}

export async function loadBrandProfile(ctx, profile = 'default') {
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(profile)) {
    throw new ToolError('profile must match [A-Za-z0-9._-]{1,64}');
  }
  const path = join(brandDir(ctx), `${profile}.json`);
  if (!(await exists(path))) {
    return { profile: { ...structuredClone(DEFAULT_BRAND), id: profile }, path, isDefault: true };
  }
  let stored;
  try {
    stored = JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    throw new ToolError(`brand profile ${path} is not valid JSON: ${error.message}`);
  }
  return { profile: mergeDeep(structuredClone(DEFAULT_BRAND), { ...stored, id: profile }), path, isDefault: false };
}

function mergeDeep(base, override) {
  for (const [key, value] of Object.entries(override ?? {})) {
    if (value && typeof value === 'object' && !Array.isArray(value) && base[key] && typeof base[key] === 'object' && !Array.isArray(base[key])) {
      mergeDeep(base[key], value);
    } else {
      base[key] = value;
    }
  }
  return base;
}
