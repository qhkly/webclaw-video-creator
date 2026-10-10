// Deterministic core of the Director workflow (brief → storyboard → audio-first
// narration → preview → critique → targeted revisions → final render).
// No LLM calls and no aesthetic judgment live here: the directing agent writes
// the storyboard and reads the extracted frames; these helpers keep the phase
// state machine, quality lint and FFmpeg frame extraction reproducible.
// Visual/motion conventions: docs/remotion-best-practices.md (vendored from
// remotion-dev/skills).
import { copyFile, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exists, run, ToolError } from './context.mjs';
import { validateScenes } from './scenes.mjs';

export const DIRECTOR_PHASES = ['planned', 'previewed', 'revising', 'approved', 'done'];

/** Finding shape shared by the deterministic lint and the agent's critique. */
// { sceneId?: string, severity: 'blocker' | 'warning' | 'nit', category: string, note: string, check?: string }

const SEVERITY_ORDER = { blocker: 0, warning: 1, nit: 2 };

export function worstSeverity(findings) {
  return findings.reduce((worst, finding) => {
    const rank = SEVERITY_ORDER[finding.severity];
    return rank < SEVERITY_ORDER[worst] ? finding.severity : worst;
  }, 'nit');
}

/**
 * Deterministic quality lint over a scenes array — the checks an AI director
 * should run before burning render time. Every finding names the scene and a
 * fix the agent can act on; nothing here judges aesthetics (that is the
 * agent's job on the extracted frames).
 */
export function runDirectorChecks(scenes, { maxTextRun = 2, aspect } = {}) {
  const findings = [];
  const push = (severity, category, note, sceneId) => findings.push({ severity, category, note, sceneId });

  // 1) Audio-first: narration without generated audio means the timeline is
  //    guesswork (durations not derived from real audio).
  for (const scene of scenes) {
    if ((scene.narration ?? '').trim() && !scene.audio?.path) {
      push('blocker', 'audio', `scene ${scene.id} has narration but no audio; run video_tts_synthesize (audio-first) or clear narration`, scene.id);
    }
  }

  // 2) Timing: scene duration should track the real audio duration (TTS attach
  //    rounds up; big drift means the scene was retimed after narration).
  for (const scene of scenes) {
    if (scene.audio?.duration && Math.abs(scene.duration - scene.audio.duration) > 1.6) {
      push('warning', 'timing', `scene ${scene.id} duration ${scene.duration}s drifts ${Math.round((scene.duration - scene.audio.duration) * 10) / 10}s from its ${scene.audio.duration}s audio`, scene.id);
    }
  }

  // 3) Captions: audio without word timings cannot render karaoke captions.
  for (const scene of scenes) {
    if (scene.audio?.path && !(scene.captions?.length > 0)) {
      push('warning', 'captions', `scene ${scene.id} has audio but no word-level captions attached`, scene.id);
    }
  }

  // 4) Visual baseline: long runs of pure text cards read as a slideshow.
  let runStart = null;
  let textRun = 0;
  scenes.forEach((scene, index) => {
    const hasVisual = Boolean(scene.background?.assetPath) || (scene.template === 'ImageFrame' && scene.props?.imageSrc);
    if (hasVisual) {
      runStart = null;
      textRun = 0;
      return;
    }
    if (runStart === null) {
      runStart = index;
    }
    textRun += 1;
    if (textRun > maxTextRun) {
      push(
        'warning',
        'visual',
        `scenes ${scenes[runStart].id}..${scene.id} are ${textRun} consecutive text-only scenes; add an image/screenshot/video background or an ImageFrame scene`,
        scene.id,
      );
    }
  });

  // 5) Text overflow heuristics: headline templates wrap badly past ~2 lines.
  for (const scene of scenes) {
    const headline =
      scene.template === 'TitleSlide' ? String(scene.props?.title ?? scene.title ?? '') :
      scene.template === 'BigStat' ? String(scene.props?.stat ?? '') :
      scene.template === 'Quote' ? String(scene.props?.quote ?? '') : '';
    const limit = scene.template === 'BigStat' ? 14 : aspect === '9:16' ? 16 : 24;
    if (headline.length > limit) {
      push('warning', 'overflow', `scene ${scene.id} ${scene.template} headline is ${headline.length} chars (>${limit} for ${aspect || '16:9'}); shorten it or it will wrap/overflow`, scene.id);
    }
    if (scene.template === 'BulletPoints' && Array.isArray(scene.props?.bullets)) {
      const longBullet = scene.props.bullets.find((bullet) => String(bullet).length > (aspect === '9:16' ? 22 : 34));
      if (longBullet) {
        push('nit', 'overflow', `scene ${scene.id} has a ${String(longBullet).length}-char bullet; keep bullets one line`, scene.id);
      }
    }
  }

  // 6) Brand closer: a promo without a dedicated ending wastes the last beat.
  const last = scenes[scenes.length - 1];
  if (last && last.template !== 'CTA' && !String(last.props?.kicker ?? '').toLowerCase().includes('cta')) {
    push('nit', 'structure', `last scene ${last.id} is ${last.template}; a CTA/brand closer (template CTA) ends promos better`, last.id);
  }

  findings.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
  return findings;
}

/**
 * Inventory of reusable assets before generating anything new (asset-first):
 * images and videos already in the project, plus shared/brand assets.
 */
export async function inventoryProjectAssets(ctx, projectId) {
  const dir = ctx.projectDir(projectId);
  const entries = [];
  const seen = new Set();
  const scan = async (folder, origin) => {
    const target = join(dir, folder);
    if (!(await exists(target))) {
      return;
    }
    for (const name of await readdir(target)) {
      if (name.startsWith('_') || name.startsWith('.')) {
        continue;
      }
      const path = join(target, name);
      const info = await stat(path).catch(() => null);
      if (!info?.isFile()) {
        continue;
      }
      const kind = /\.(mp4|mov|webm|m4v)$/i.test(name) ? 'video' : /\.(png|jpe?g|webp|gif)$/i.test(name) ? 'image' : null;
      if (kind && !seen.has(path)) {
        seen.add(path);
        entries.push({ path, kind, origin, sizeBytes: info.size });
      }
    }
  };
  await scan('assets', 'project');
  const shared = join(ctx.workspace, 'assets');
  if (await exists(shared)) {
    for (const name of await readdir(shared)) {
      const path = join(shared, name);
      const info = await stat(path).catch(() => null);
      const kind = info?.isFile() && (/\.(mp4|mov|webm|m4v)$/i.test(name) ? 'video' : /\.(png|jpe?g|webp|gif)$/i.test(name) ? 'image' : null);
      if (kind && !seen.has(path)) {
        seen.add(path);
        entries.push({ path, kind, origin: 'workspace', sizeBytes: info.size });
      }
    }
  }
  return entries;
}

/** Director state: <project>/director/state.json (phase machine across calls). */
export function directorPaths(ctx, projectId) {
  const dir = join(ctx.projectDir(projectId), 'director');
  return {
    dir,
    state: join(dir, 'state.json'),
    plan: join(dir, 'plan.json'),
    reviews: join(dir, 'reviews'),
    previews: join(dir, 'previews'),
  };
}

export async function readState(ctx, projectId) {
  const { state } = directorPaths(ctx, projectId);
  if (!(await exists(state))) {
    return null;
  }
  try {
    return JSON.parse(await readFile(state, 'utf8'));
  } catch {
    return null;
  }
}

export async function writeState(ctx, projectId, patch) {
  const paths = directorPaths(ctx, projectId);
  await ctx.ensureDir(paths.dir);
  const previous = (await readState(ctx, projectId)) ?? {
    version: 1,
    project: projectId,
    phase: 'planned',
    round: 1,
    createdAt: new Date().toISOString(),
    brief: null,
  };
  const next = { ...previous, ...patch, updatedAt: new Date().toISOString() };
  await writeFile(paths.state, JSON.stringify(next, null, 2));
  return next;
}

/**
 * Extract review material from a rendered preview with FFmpeg:
 * one representative frame per scene (its midpoint) plus a contact sheet of
 * evenly spread frames. The directing agent looks at these images to critique.
 */
export async function extractPreviewFrames(ffmpeg, video, scenes, outDir, { frameWidth = 480, sheetColumns = 4, sheetMaxFrames = 16 } = {}) {
  // outDir is this round's frame folder: drop frames of a previous extraction
  // (renamed/removed scenes) so readers never mistake them for current ones.
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });
  const frames = [];
  let offset = 0;
  for (const [index, scene] of scenes.entries()) {
    const at = Math.max(0, offset + scene.duration / 2 - 0.05);
    const path = join(outDir, `scene-${String(index + 1).padStart(2, '0')}-${scene.id}.jpg`);
    const grab = await run(ffmpeg, [
      '-y', '-ss', String(at), '-i', video,
      '-frames:v', '1', '-vf', `scale=${frameWidth}:-2`, '-q:v', '3', path,
    ]);
    if (grab.code === 0 && (await exists(path))) {
      frames.push({ sceneId: scene.id, index, atSeconds: Math.round(at * 100) / 100, path });
    }
    offset += scene.duration;
  }

  const total = scenes.reduce((sum, scene) => sum + scene.duration, 0);
  const contactSheet = join(outDir, 'contact-sheet.jpg');
  const count = Math.min(sheetMaxFrames, Math.max(1, frames.length ? scenes.length : 1));
  const interval = Math.max(0.5, total / (sheetColumns * Math.ceil(count / sheetColumns)));
  const rows = Math.ceil(Math.min(sheetMaxFrames, Math.max(1, Math.round(total / interval))) / sheetColumns);
  const sheet = await run(ffmpeg, [
    '-y', '-i', video,
    '-vf', `fps=1/${interval},scale=${Math.round(frameWidth / 1.5)}:-2,tile=${sheetColumns}x${Math.max(1, rows)}`,
    '-frames:v', '1', '-q:v', '4', contactSheet,
  ]);
  const sheetPath = sheet.code === 0 && (await exists(contactSheet)) ? contactSheet : null;
  return { frames, contactSheet: sheetPath, intervalSeconds: Math.round(interval * 100) / 100 };
}

/**
 * Read an image as MCP image content (base64 JPEG), downscaled so a handful of
 * frames fit a remote agent's context. `run()` decodes stdout as text, so the
 * re-encode goes through a temp file instead of a pipe.
 */
export async function jpegImageContent(ffmpeg, source, { width = 640, quality = 5 } = {}) {
  const temp = join(tmpdir(), `vc-frame-${createHash('sha1').update(`${source}:${width}:${quality}`).digest('hex').slice(0, 16)}.jpg`);
  const made = await run(ffmpeg, [
    '-y', '-i', source,
    '-vf', `scale='min(${width},iw)':-2`,
    '-q:v', String(quality),
    '-f', 'image2', temp,
  ]);
  if (made.code !== 0 || !(await exists(temp))) {
    throw new ToolError(`failed to encode ${source} for transport: ${made.stderr.slice(-200)}`);
  }
  return { data: (await readFile(temp)).toString('base64'), mimeType: 'image/jpeg' };
}

/** Frames + contact sheet of a preview round, reconstructed from the round dir
 * (file naming is ours: scene-NN-<sceneId>.jpg, contact-sheet.jpg). Works for
 * historical rounds that state.lastPreview no longer describes. */
export async function listRoundFrames(previewsDir, round) {
  const dir = join(previewsDir, `round-${Math.max(1, round)}`);
  if (!(await exists(dir))) {
    return null;
  }
  const frames = [];
  let contactSheet = null;
  for (const name of (await readdir(dir)).sort()) {
    if (name === 'contact-sheet.jpg') {
      contactSheet = join(dir, name);
    } else if (/^scene-\d+-/.test(name) && name.endsWith('.jpg')) {
      frames.push({ sceneId: name.replace(/^scene-\d+-/, '').replace(/\.jpg$/, ''), path: join(dir, name) });
    }
  }
  return { round, dir, frames, contactSheet };
}

/** Scenes plus the plan metadata the critique rounds refer back to. */
export async function readDirectorScenes(scenesPath) {
  if (!(await exists(scenesPath))) {
    return null;
  }
  try {
    return JSON.parse(await readFile(scenesPath, 'utf8'));
  } catch (error) {
    throw new Error(`${scenesPath} is not valid JSON: ${error.message}`);
  }
}

export { validateScenes };

/** Copy an asset into the project's assets/ folder (reuse without regenerating). */
export async function importAsset(ctx, projectId, sourcePath, { name } = {}) {
  const assetsDir = await ctx.ensureDir(join(ctx.projectDir(projectId), 'assets'));
  const base = (name || sourcePath.split('/').pop()).replace(/[^A-Za-z0-9._-]/g, '_');
  let target = join(assetsDir, base);
  for (let n = 2; await exists(target); n += 1) {
    target = join(assetsDir, base.replace(/(\.[^.]+)?$/, `-${n}$1`));
  }
  await copyFile(ctx.readPath(sourcePath), target);
  return target;
}
