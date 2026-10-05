// MCP tool catalog. Each tool is a thin wrapper over an existing capability
// (scripts/*.mjs sidecars, ffmpeg, scenes JSON) — no new pipeline logic and no
// LLM calls. The agent composes them; see SERVER_INSTRUCTIONS in protocol.mjs.
import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { listBrandProfiles, loadBrandProfile } from './brand.mjs';
import { exists, findFfmpeg, isProjectId, lastJsonLine, run, runScript, scriptError, ToolError } from './context.mjs';
import { extensionFor, generateWithOpenAIOAuth, IMAGE_ASPECTS, normalizeImage } from './image-gen.mjs';
import { getProvider, listProviders, providerIds } from './providers.mjs';
import { SCENE_TEMPLATES, validateScenes } from './scenes.mjs';

const PROJECT_ARG = {
  type: 'string',
  description: 'Project id (folder under <workspace>/projects). Created on first write.',
};

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const LOCAL_WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false };

export const tools = [
  {
    name: 'video_project_status',
    title: 'Project status',
    description:
      'Call this first. Returns the workspace path, brand profiles, provider availability summary and every project ' +
      '(or one project in detail: scenes summary, generated audio, renders, file paths). Read files directly from the returned paths when you need full content.',
    inputSchema: {
      type: 'object',
      properties: { project: { ...PROJECT_ARG, description: 'Optional: return details for this project only.' } },
      additionalProperties: false,
    },
    annotations: READ_ONLY,
    async handler({ project }, { ctx }) {
      const projectsRoot = join(ctx.workspace, 'projects');
      // Hand-made folders with names the tools cannot address are skipped rather than failing the whole listing.
      const ids = project ? [project] : (await exists(projectsRoot)) ? (await readdir(projectsRoot)).filter((name) => isProjectId(name)) : [];
      const projects = await Promise.all(ids.map((id) => describeProject(ctx, id, Boolean(project))));
      const { providers } = await listProviders(ctx);
      return {
        workspace: ctx.workspace,
        brandProfiles: await listBrandProfiles(ctx),
        providers: providers.map(({ id, kind, available }) => ({ id, kind, available })),
        sceneTemplates: SCENE_TEMPLATES,
        projects,
      };
    },
  },
  {
    name: 'video_brand_profile_get',
    title: 'Get creator Brand DNA',
    description:
      'Read the creator\'s persistent Brand DNA: voice identity (TTS provider/voice/clone reference), persona (audience, tone, points of view, must-say, avoid), ' +
      'visual style (aspect, palette, templates, logo), caption and music preferences, reusable assets. Respect it when writing scripts and choosing voices/templates. ' +
      `Stored at <workspace>/brand/<profile>.json; isDefault=true means no file exists yet (you may create it with the returned shape).`,
    inputSchema: {
      type: 'object',
      properties: { profile: { type: 'string', description: 'Profile id, default "default".' } },
      additionalProperties: false,
    },
    annotations: READ_ONLY,
    async handler({ profile }, { ctx }) {
      return loadBrandProfile(ctx, profile || 'default');
    },
  },
  {
    name: 'video_providers_list',
    title: 'List media providers',
    description:
      'List pluggable media providers (tts, image-gen, compose, render, stock) with billing (free/local/paid), availability and planned capability slots. ' +
      'Providers only generate media; planning and writing stay with you.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: READ_ONLY,
    async handler(_args, { ctx }) {
      return listProviders(ctx);
    },
  },
  {
    name: 'video_media_probe',
    title: 'Probe media file',
    description: 'Read duration, video/audio stream presence and resolution of any local media file (user recording, footage, generated audio) via ffmpeg. Deterministic, read-only.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Absolute path, or path relative to the workspace.' } },
      required: ['path'],
      additionalProperties: false,
    },
    annotations: READ_ONLY,
    async handler({ path }, { ctx }) {
      const input = ctx.readPath(path);
      if (!(await exists(input))) {
        throw new ToolError(`file not found: ${input}`);
      }
      return { path: input, ...(await probeMedia(await findFfmpeg(), input)) };
    },
  },
  {
    name: 'video_scenes_save',
    // Approval class (see mcp/approval.mjs): local | free-network | paid.
    cost: 'local',
    title: 'Validate and save scenes',
    description:
      'Validate a scenes array (same shape the editor and Remotion renderer use) and write it to <workspace>/projects/<project>/scenes.json. ' +
      `Scene: { id, title, text, narration, template: ${SCENE_TEMPLATES.join('|')}, duration (s), props: {...}, audio?, background?, captions? }. ` +
      'Returns validation errors instead of writing when invalid. Template props (all optional, bgColor/accent accepted): TitleSlide {title, subtitle}, ' +
      'BulletPoints {title, bullets: string[]}, BigStat {stat, label}, Quote {quote, author}, CodeExplainer {code, language, highlightLines: number[], caption}, ' +
      'ImageFrame {imageSrc, caption, subtitle}. Scene title is the fallback heading.',
    inputSchema: {
      type: 'object',
      properties: {
        project: PROJECT_ARG,
        scenes: { type: 'array', description: 'Ordered scenes.', items: { type: 'object' } },
      },
      required: ['project', 'scenes'],
      additionalProperties: false,
    },
    annotations: LOCAL_WRITE,
    async handler({ project, scenes }, { ctx }) {
      const errors = validateScenes(scenes);
      if (errors.length > 0) {
        throw new ToolError(`scenes invalid:\n- ${errors.join('\n- ')}`);
      }
      const dir = await ctx.ensureDir(ctx.projectDir(project));
      const path = join(dir, 'scenes.json');
      await withFileLock(path, () => writeFile(path, JSON.stringify(scenes, null, 2)));
      return { path, sceneCount: scenes.length, totalDuration: sum(scenes.map((scene) => scene.duration)) };
    },
  },
  {
    name: 'video_tts_synthesize',
    cost: 'free-network',
    title: 'Synthesize narration (TTS)',
    description:
      'Generate narration audio with a TTS provider (default: the brand profile voice) via scripts/tts.mjs, producing an mp3 plus word-level timings for captions. ' +
      'If sceneId is given, the scene in the project\'s scenes.json gets audio/captions attached and its duration extended to fit, exactly like the editor\'s "Generate TTS" button.',
    inputSchema: {
      type: 'object',
      properties: {
        project: PROJECT_ARG,
        text: { type: 'string', description: 'Narration text. Defaults to the scene narration when sceneId is given.' },
        sceneId: { type: 'string', description: 'Attach the result to this scene in scenes.json.' },
        provider: { type: 'string', enum: providerIds('tts'), description: 'TTS provider id (see video_providers_list). Default: brand voice.provider.' },
        voice: { type: 'string', description: 'Voice id, e.g. zh-CN-YunxiNeural. Default: brand voice.voiceId.' },
        profile: { type: 'string', description: 'Brand profile for defaults, default "default".' },
      },
      required: ['project'],
      additionalProperties: false,
    },
    annotations: { ...LOCAL_WRITE, idempotentHint: false, openWorldHint: true },
    async handler({ project, text, sceneId, provider, voice, profile }, { ctx, progress }) {
      const { profile: brand } = await loadBrandProfile(ctx, profile || 'default');
      const providerId = provider || brand.voice.provider || 'edge';
      if (!getProvider(providerId, 'tts')) {
        throw new ToolError(`unknown tts provider: ${providerId}`);
      }
      const dir = ctx.projectDir(project);
      const scenesPath = join(dir, 'scenes.json');
      let scenes;
      let scene;
      if (sceneId) {
        scenes = await readScenes(scenesPath);
        scene = scenes.find((item) => item.id === sceneId);
        if (!scene) {
          throw new ToolError(`scene ${sceneId} not found in ${scenesPath}`);
        }
      }
      const narration = text ?? scene?.narration;
      if (!narration?.trim()) {
        throw new ToolError('nothing to synthesize: pass text or a scene with narration');
      }
      const output = join(await ctx.ensureDir(join(dir, 'audio')), `${safeName(sceneId || `tts-${Date.now()}`)}.mp3`);
      progress(10, `synthesizing with ${providerId}`);
      const result = await runScript(ctx, 'tts.mjs', ['--text', narration, '--voice', voice || brand.voice.voiceId, '--output', output, '--engine', providerId]);
      if (result.code !== 0) {
        throw scriptError('tts.mjs', result);
      }
      const tts = lastJsonLine(result.stdout, (value) => value && typeof value.output === 'string');
      if (!tts) {
        throw new ToolError('tts.mjs returned no result');
      }
      if (scene) {
        // Re-read under the lock: agents often synthesize several scenes in parallel.
        await withFileLock(scenesPath, async () => {
          const latest = await readScenes(scenesPath);
          const target = latest.find((item) => item.id === sceneId);
          if (!target) {
            throw new ToolError(`scene ${sceneId} was removed from ${scenesPath} during synthesis; audio kept at ${tts.output}`);
          }
          target.duration = Math.max(2, Math.ceil(tts.duration));
          target.audio = { path: tts.output, duration: tts.duration, wordsPath: tts.wordsPath };
          target.captions = tts.words ?? [];
          await writeFile(scenesPath, JSON.stringify(latest, null, 2));
        });
      }
      return {
        output: tts.output,
        duration: tts.duration,
        wordsPath: tts.wordsPath,
        wordCount: tts.words?.length ?? 0,
        attachedToScene: scene ? sceneId : null,
      };
    },
  },
  {
    name: 'video_image_generate',
    // Spends the user's ChatGPT image quota, so it always goes through approval.
    cost: 'paid',
    title: 'Generate image',
    description:
      'Generate one still image (GPT Image via the local Codex/ChatGPT OAuth login, provider openai-oauth-image; no API key, uses account quota) ' +
      'and save it as a PNG in <workspace>/projects/<project>/assets/. The model may return a different size than requested, so the result is ' +
      'cover-cropped to a fixed canvas per aspect (16:9 1920x1080, 9:16 1080x1920, 1:1 1080x1080); the untouched original is kept in assets/_source/. ' +
      'If sceneId is given, an ImageFrame scene gets props.imageSrc set, any other scene gets it as a cover background image. Returns path, width, height, mimeType.',
    inputSchema: {
      type: 'object',
      properties: {
        project: PROJECT_ARG,
        prompt: { type: 'string', description: 'What the image should show (subject, style, composition). No text overlays; captions are rendered by the templates.' },
        filename: { type: 'string', description: 'Base file name, e.g. "hero"; saved as <filename>.png (a numeric suffix is added instead of overwriting). Default image-<timestamp>.' },
        aspect: { type: 'string', enum: Object.keys(IMAGE_ASPECTS), description: 'Default: brand visual.aspect.' },
        sceneId: { type: 'string', description: 'Attach the image to this scene in scenes.json.' },
      },
      required: ['project', 'prompt'],
      additionalProperties: false,
    },
    annotations: { ...LOCAL_WRITE, idempotentHint: false, openWorldHint: true },
    async handler({ project, prompt, filename, aspect, sceneId }, { ctx, progress }) {
      if (!prompt.trim()) {
        throw new ToolError('prompt must not be empty');
      }
      const { profile: brand } = await loadBrandProfile(ctx, 'default');
      const ratio = aspect || (IMAGE_ASPECTS[brand.visual.aspect] ? brand.visual.aspect : '16:9');
      const target = IMAGE_ASPECTS[ratio];
      const dir = ctx.projectDir(project);
      const scenesPath = join(dir, 'scenes.json');
      if (sceneId && !(await readScenes(scenesPath)).some((item) => item.id === sceneId)) {
        throw new ToolError(`scene ${sceneId} not found in ${scenesPath}`);
      }
      const generate = ctx.generateImage ?? generateWithOpenAIOAuth;
      if (!ctx.generateImage) {
        const check = await getProvider('openai-oauth-image', 'image-gen').check(ctx);
        if (!check.available) {
          throw new ToolError(`image provider openai-oauth-image unavailable: ${check.reason}`);
        }
      }
      const assetsDir = await ctx.ensureDir(join(dir, 'assets'));
      const sourceDir = await ctx.ensureDir(join(assetsDir, '_source'));
      const base = await freeName(assetsDir, safeName(filename || `image-${Date.now()}`).replace(/\.(png|jpe?g|webp)$/i, ''));
      progress(10, `generating ${target.request} image`);
      let image;
      try {
        image = await generate({ prompt, size: target.request });
      } catch (error) {
        throw new ToolError(`image generation failed: ${error.message}`);
      }
      const sourcePath = join(sourceDir, `${base}.${extensionFor(image.mediaType)}`);
      await writeFile(sourcePath, image.bytes);
      progress(80, 'normalizing size');
      const ffmpeg = await findFfmpeg();
      const source = await probeMedia(ffmpeg, sourcePath);
      const path = join(assetsDir, `${base}.png`);
      const size = await normalizeImage(ffmpeg, sourcePath, path, target);
      if (sceneId) {
        await withFileLock(scenesPath, async () => {
          const latest = await readScenes(scenesPath);
          const scene = latest.find((item) => item.id === sceneId);
          if (!scene) {
            throw new ToolError(`scene ${sceneId} was removed from ${scenesPath} during generation; image kept at ${path}`);
          }
          if (scene.template === 'ImageFrame') {
            scene.props = { ...scene.props, imageSrc: path };
          } else {
            scene.background = { kind: 'image', assetPath: path, fit: 'cover' };
          }
          await writeFile(scenesPath, JSON.stringify(latest, null, 2));
        });
      }
      return {
        path,
        width: size.width,
        height: size.height,
        mimeType: 'image/png',
        aspect: ratio,
        sourcePath,
        source: { width: source.width, height: source.height, mimeType: image.mediaType },
        attachedToScene: sceneId ?? null,
      };
    },
  },
  {
    name: 'video_render',
    cost: 'local',
    title: 'Render scenes to video',
    description:
      'Render the project\'s scenes.json with the Remotion templates (scripts/render.mjs), including scene audio and word captions. ' +
      'Writes <workspace>/projects/<project>/renders/raw_video.<ext>. Slow (minutes); sends progress notifications when a progressToken is supplied.',
    inputSchema: {
      type: 'object',
      properties: {
        project: PROJECT_ARG,
        aspect: { type: 'string', enum: ['16:9', '9:16', '1:1'], description: 'Default: brand visual.aspect.' },
        resolution: { type: 'string', enum: ['720p', '1080p', '4K'], description: 'Default 1080p.' },
        format: { type: 'string', enum: ['MP4', 'MOV', 'WebM'], description: 'Default MP4.' },
        profile: { type: 'string', description: 'Brand profile supplying aspect/caption defaults, default "default".' },
      },
      required: ['project'],
      additionalProperties: false,
    },
    annotations: { ...LOCAL_WRITE, idempotentHint: true },
    async handler({ project, aspect, resolution, format, profile }, { ctx, progress }) {
      const { profile: brand } = await loadBrandProfile(ctx, profile || 'default');
      const dir = ctx.projectDir(project);
      const scenesPath = join(dir, 'scenes.json');
      const errors = validateScenes(await readScenes(scenesPath));
      if (errors.length > 0) {
        throw new ToolError(`scenes.json invalid, fix with video_scenes_save:\n- ${errors.join('\n- ')}`);
      }
      const outputDir = await ctx.ensureDir(join(dir, 'renders'));
      let output = null;
      const result = await runScript(
        ctx,
        'render.mjs',
        [
          '--scenes', scenesPath,
          '--outputDir', outputDir,
          '--aspect', aspect || brand.visual.aspect || '16:9',
          '--resolution', resolution || '1080p',
          '--format', format || 'MP4',
          '--captions', JSON.stringify(brand.captions),
        ],
        {
          onStdoutLine(line) {
            try {
              const event = JSON.parse(line);
              if (event.type === 'progress') {
                progress(event.percent, `rendering ${event.percent}%`);
              } else if (event.type === 'done') {
                output = event.output;
              }
            } catch {
              // bundler noise
            }
          },
        },
      );
      if (result.code !== 0 || !output) {
        throw scriptError('render.mjs', result);
      }
      return { output, ...(await probeMedia(await findFfmpeg(), output).catch(() => ({}))) };
    },
  },
  {
    name: 'video_audio_mux',
    cost: 'local',
    title: 'Mux audio onto video',
    description:
      'Lay one or more audio files onto a video at given start times with FFmpeg (video stream copied, output keeps the video length). ' +
      'By default the video\'s own audio (e.g. rendered narration) is kept and mixed in; set keepOriginalAudio=false to replace it. ' +
      'Use for voice-over on screen recordings or adding background music. Output is written inside the workspace.',
    inputSchema: {
      type: 'object',
      properties: {
        video: { type: 'string', description: 'Input video path (absolute or workspace-relative).' },
        segments: {
          type: 'array',
          description: 'Audio clips: [{ path, startTime (seconds, default 0), volume (default 1) }].',
          items: { type: 'object' },
        },
        output: { type: 'string', description: 'Workspace-relative output path, e.g. projects/demo/renders/final.mp4.' },
        keepOriginalAudio: { type: 'boolean', description: 'Mix with the video\'s existing audio track if it has one. Default true.' },
      },
      required: ['video', 'segments', 'output'],
      additionalProperties: false,
    },
    annotations: { ...LOCAL_WRITE, idempotentHint: true },
    async handler({ video, segments, output, keepOriginalAudio = true }, { ctx }) {
      const input = ctx.readPath(video);
      const target = await ctx.safeWritePath(output);
      if (!(await exists(input))) {
        throw new ToolError(`video not found: ${input}`);
      }
      if (resolve(input) === target) {
        throw new ToolError('output must differ from the input video');
      }
      if (segments.length === 0) {
        throw new ToolError('segments must contain at least one audio clip');
      }
      const clips = await Promise.all(
        segments.map(async (segment, index) => {
          const path = typeof segment?.path === 'string' ? ctx.readPath(segment.path) : null;
          if (!path || !(await exists(path))) {
            throw new ToolError(`segments[${index}].path not found: ${segment?.path}`);
          }
          const startTime = Number(segment.startTime ?? 0);
          const volume = Number(segment.volume ?? 1);
          if (!Number.isFinite(startTime) || startTime < 0) {
            throw new ToolError(`segments[${index}].startTime must be a number >= 0`);
          }
          if (!Number.isFinite(volume) || volume < 0 || volume > 10) {
            throw new ToolError(`segments[${index}].volume must be a number between 0 and 10`);
          }
          if (resolve(path) === target) {
            throw new ToolError(`segments[${index}].path must differ from output`);
          }
          return { path, startTime, volume };
        }),
      );
      await ctx.ensureDir(join(target, '..'));
      const ffmpeg = await findFfmpeg();
      const source = await probeMedia(ffmpeg, input);
      const keepOriginal = keepOriginalAudio && source.hasAudio;
      const result = await run(ffmpeg, buildMuxArgs(input, clips, target, { keepOriginal, duration: source.duration }));
      if (result.code !== 0) {
        throw new ToolError(`ffmpeg failed: ${result.stderr.trim().split('\n').slice(-5).join('\n')}`);
      }
      return { output: target, keptOriginalAudio: keepOriginal, ...(await probeMedia(ffmpeg, target)) };
    },
  },
];

/**
 * Delay each clip to its start time and amix them (the Tauri `combine_audio_video` idea, with adelay so offsets
 * survive amix). The output keeps the video length: the mix is padded with silence and cut at the probed video
 * duration with -t (-shortest is unreliable with filter graphs and ended mixes early).
 */
export function buildMuxArgs(video, clips, output, { keepOriginal = false, duration } = {}) {
  const args = ['-y', '-i', video];
  clips.forEach((clip) => args.push('-i', clip.path));
  const chains = clips.map((clip, index) => {
    const delay = Math.round(clip.startTime * 1000);
    return `[${index + 1}:a:0]adelay=${delay}|${delay},volume=${clip.volume}[a${index}]`;
  });
  const labels = [...(keepOriginal ? ['[0:a:0]'] : []), ...clips.map((_, index) => `[a${index}]`)];
  const mix = `${labels.join('')}amix=inputs=${labels.length}:normalize=0:duration=longest,apad[aout]`;
  args.push('-filter_complex', `${chains.join(';')};${mix}`, '-map', '0:v:0', '-map', '[aout]', '-c:v', 'copy');
  args.push(...(duration > 0 ? ['-t', String(duration)] : ['-shortest']), output);
  return args;
}

/** Parse `ffmpeg -i` output (ffmpeg-static ships no ffprobe). */
export async function probeMedia(ffmpeg, input) {
  // `ffmpeg -i` without an output always exits 1; success is judged by the "Input #" banner.
  const { code, stderr } = await run(ffmpeg, ['-hide_banner', '-i', input]);
  if (/No such file or directory|Invalid data found/i.test(stderr)) {
    throw new ToolError(`cannot read media file: ${input}`);
  }
  if (!/Input #\d/.test(stderr)) {
    throw new ToolError(`ffmpeg (${ffmpeg}) did not run (exit ${code}); set FFMPEG_PATH to a working binary. ${stderr.trim().slice(-300)}`);
  }
  return parseProbe(stderr);
}

export function parseProbe(stderr) {
  const match = stderr.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  const duration = match ? Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) : 0;
  const videoLine = stderr.split('\n').find((line) => /Stream #.*Video:/.test(line) && !/attached pic/.test(line));
  const size = videoLine?.match(/,\s(\d{2,5})x(\d{2,5})[\s,[]/);
  return {
    duration,
    hasVideo: Boolean(videoLine),
    hasAudio: /Stream #.*Audio:/.test(stderr),
    width: size ? Number(size[1]) : undefined,
    height: size ? Number(size[2]) : undefined,
  };
}

async function describeProject(ctx, id, detailed) {
  const dir = ctx.projectDir(id);
  if (!(await exists(dir))) {
    return { id, exists: false, dir };
  }
  const scenesPath = join(dir, 'scenes.json');
  const info = { id, exists: true, dir, scenesPath: (await exists(scenesPath)) ? scenesPath : null };
  if (info.scenesPath) {
    try {
      const scenes = JSON.parse(await readFile(scenesPath, 'utf8'));
      info.sceneCount = scenes.length;
      info.totalDuration = sum(scenes.map((scene) => Number(scene.duration) || 0));
      if (detailed) {
        info.scenes = scenes.map((scene) => ({
          id: scene.id,
          title: scene.title,
          template: scene.template,
          duration: scene.duration,
          hasAudio: Boolean(scene.audio?.path),
          captionWords: scene.captions?.length ?? 0,
        }));
        info.validationErrors = validateScenes(scenes);
      }
    } catch (error) {
      info.scenesError = error.message;
    }
  }
  info.audio = await listFiles(join(dir, 'audio'), /\.(mp3|wav|m4a)$/i);
  info.images = await listFiles(join(dir, 'assets'), /\.(png|jpe?g|webp)$/i);
  info.renders = await listFiles(join(dir, 'renders'), /\.(mp4|mov|webm)$/i);
  return info;
}

async function listFiles(dir, pattern) {
  if (!(await exists(dir))) {
    return [];
  }
  const names = (await readdir(dir)).filter((name) => pattern.test(name));
  return Promise.all(
    names.map(async (name) => {
      const path = join(dir, name);
      const { size, mtime } = await stat(path);
      return { name, path, size, modifiedAt: mtime.toISOString() };
    }),
  );
}

async function readScenes(path) {
  if (!(await exists(path))) {
    throw new ToolError(`no scenes.json at ${path}; create it with video_scenes_save`);
  }
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    throw new ToolError(`${path} is not valid JSON: ${error.message}`);
  }
}

const fileLocks = new Map();

/** Serialize read-modify-write cycles on one file within this server process. */
export function withFileLock(path, task) {
  const previous = fileLocks.get(path) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(task);
  const tail = next.catch(() => {});
  fileLocks.set(path, tail);
  tail.then(() => {
    if (fileLocks.get(path) === tail) {
      fileLocks.delete(path);
    }
  });
  return next;
}

/** `base`, or `base-2`, `base-3`… so a generated asset never overwrites an existing one. */
async function freeName(dir, base) {
  let name = base;
  for (let n = 2; await exists(join(dir, `${name}.png`)); n += 1) {
    name = `${base}-${n}`;
  }
  return name;
}

function safeName(name) {
  return basename(name).replace(/[^A-Za-z0-9._-]/g, '_') || 'audio';
}

function sum(values) {
  return Math.round(values.reduce((total, value) => total + value, 0) * 100) / 100;
}
