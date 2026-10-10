// The Director workflow as composable MCP tools: plan → (tts) → preview →
// review → revise → finalize. The directing agent keeps every judgment call
// (script, storyboard, what to critique, when it is good enough); these tools
// persist the phase state, run the deterministic quality lint and drive the
// existing render / TTS sidecars, so one agent task can chain the whole flow.
// Every result reports { phase, artifacts, nextStep } (and the failure point on
// isError), per the director contract in docs/agent-director.md.
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { findFfmpeg, runScript, scriptError, ToolError } from './context.mjs';
import { limitArgs } from '../scripts/lib/plan.mjs';
import { loadBrandProfile } from './brand.mjs';
import {
  directorPaths,
  extractPreviewFrames,
  inventoryProjectAssets,
  jpegImageContent,
  listRoundFrames,
  readDirectorScenes,
  readState,
  runDirectorChecks,
  worstSeverity,
  writeState,
} from './director.mjs';
import { validateScenes } from './scenes.mjs';
import { probeMedia, withFileLock } from './tools.mjs';

const PROJECT_ARG = {
  type: 'string',
  description: 'Project id (folder under <workspace>/projects). Created on first write.',
};
const LOCAL_WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const LOCAL_READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

/** How many representative frames ride along with a preview (the whole sheet
 * plus every single frame would bloat a remote agent's context). */
const PREVIEW_INLINE_FRAMES = 4;

/** mcpImages attachment shared by preview / frames tools; never fatal — the
 * local paths are always in structuredContent as the fallback. */
async function inlineReviewImages(ffmpeg, extraction, { frameLimit = PREVIEW_INLINE_FRAMES, frameWidth = 640 } = {}) {
  const images = [];
  if (extraction.contactSheet) {
    images.push({ ...(await jpegImageContent(ffmpeg, extraction.contactSheet, { width: 1024 })), title: 'contact sheet' });
  }
  for (const frame of extraction.frames.slice(0, frameLimit)) {
    images.push({ ...(await jpegImageContent(ffmpeg, frame.path, { width: frameWidth })), title: `scene ${frame.sceneId} @ ${frame.atSeconds ?? '?'}s` });
  }
  return images;
}

function nextStepFor(state) {
  switch (state.phase) {
    case 'planned':
      return 'Audio first: video_tts_synthesize each narration scene (sceneId), then video_director_preview.';
    case 'previewed':
      return 'Look at the attached images (contact sheet + frames) — or video_director_frames for specific scenes. Then video_director_review with your findings.';
    case 'revising':
      return 'Fix the flagged scenes (video_scenes_save / video_tts_synthesize / video_image_generate — image generation keeps its per-call approval), then video_director_preview again.';
    case 'approved':
      return 'video_director_finalize for the full-quality render.';
    case 'done':
      return `Deliver ${state.finalOutput}; iterate with video_director_preview if the user asks for changes.`;
    default:
      return 'video_director_plan.';
  }
}

/** Fingerprint of the storyboard a preview/approval refers to: any later edit
 * (video_scenes_save, video_tts_synthesize, hand edits) invalidates both. */
function scenesFingerprint(scenes) {
  return createHash('sha1').update(JSON.stringify(scenes)).digest('hex');
}

async function scenesOrThrow(ctx, project) {
  const scenesPath = join(ctx.projectDir(project), 'scenes.json');
  const scenes = await readDirectorScenes(scenesPath);
  if (!scenes) {
    throw new ToolError(`no scenes.json at ${scenesPath}; start with video_director_plan`);
  }
  const errors = validateScenes(scenes);
  if (errors.length > 0) {
    throw new ToolError(`scenes.json invalid:\n- ${errors.join('\n- ')}`);
  }
  return { scenes, scenesPath };
}

/** Shared with video_render: spawn scripts/render.mjs and surface progress. */
async function renderTo(ctx, { scenesPath, output, resolution, format, aspect, captions, plan, progress }) {
  let done = null;
  const result = await (ctx.runScript ?? runScript)(
    ctx,
    'render.mjs',
    [
      '--scenes', scenesPath,
      '--outputDir', join(output, '..'),
      '--output', output,
      '--aspect', aspect,
      '--resolution', resolution,
      '--format', format || 'MP4',
      '--captions', JSON.stringify(captions),
      ...limitArgs(plan),
    ],
    {
      onStdoutLine(line) {
        try {
          const event = JSON.parse(line);
          if (event.type === 'progress') {
            progress?.(event.percent, `rendering ${event.percent}%`);
          } else if (event.type === 'done') {
            done = event;
          }
        } catch {
          // bundler noise
        }
      },
    },
  );
  if (result.code !== 0 || !done) {
    throw scriptError('render.mjs', result);
  }
  return done;
}

export const directorTools = [
  {
    name: 'video_director_plan',
    cost: 'local',
    title: 'Director: save storyboard plan',
    description:
      'Start of the Director workflow. Saves the storyboard (same scenes shape as video_scenes_save; write it yourself from the brief — scene-first, one beat per scene, last scene a CTA/brand closer) ' +
      'plus the brief and an asset inventory of what already exists in the project/workspace (asset-first: reuse before generating). ' +
      'Runs deterministic checks (audio-first violations, caption coverage, text-only runs, headline overflow) and returns them as findings with severities. ' +
      'Phases: planned → previewed → revising → approved → done; every director tool returns { phase, artifacts, nextStep }. ' +
      'Conventions: docs/remotion-best-practices.md.',
    inputSchema: {
      type: 'object',
      properties: {
        project: PROJECT_ARG,
        brief: { type: 'string', description: 'What the user asked for, in your own words — kept with the plan for later rounds.' },
        scenes: { type: 'array', description: 'Ordered storyboard scenes (validated like video_scenes_save).', items: { type: 'object' } },
        aspect: { type: 'string', enum: ['16:9', '9:16', '1:1'], description: 'Default: brand visual.aspect.' },
      },
      required: ['project', 'brief', 'scenes'],
      additionalProperties: false,
    },
    annotations: LOCAL_WRITE,
    async handler({ project, brief, scenes, aspect }, { ctx }) {
      if (!(brief ?? '').trim()) {
        throw new ToolError('brief must not be empty');
      }
      const errors = validateScenes(scenes);
      if (errors.length > 0) {
        throw new ToolError(`scenes invalid:\n- ${errors.join('\n- ')}`);
      }
      const { profile: brand } = await loadBrandProfile(ctx, 'default');
      const ratio = aspect || brand.visual.aspect || '16:9';
      const dir = await ctx.ensureDir(ctx.projectDir(project));
      const scenesPath = join(dir, 'scenes.json');
      await withFileLock(scenesPath, () => writeFile(scenesPath, JSON.stringify(scenes, null, 2)));
      const findings = runDirectorChecks(scenes, { aspect: ratio });
      const inventory = await inventoryProjectAssets(ctx, project);
      const paths = directorPaths(ctx, project);
      await ctx.ensureDir(paths.dir);
      await writeFile(paths.plan, JSON.stringify(
        { version: 1, brief, aspect: ratio, createdAt: new Date().toISOString(), sceneCount: scenes.length, totalDuration: scenes.reduce((sum, scene) => sum + scene.duration, 0), findings, assetInventory: inventory },
        null,
        2,
      ));
      // Re-planning must not overwrite the earlier cycle's previews/reviews:
      // open the next round once the current one has produced any material.
      const previous = await readState(ctx, project);
      const round = previous
        ? Math.max(1, previous.round || 1) + (previous.phase === 'planned' ? 0 : 1)
        : 1;
      const state = await writeState(ctx, project, { phase: 'planned', brief, aspect: ratio, round, finalOutput: null, approvedScenesHash: null });
      return {
        phase: state.phase,
        brief,
        aspect: ratio,
        sceneCount: scenes.length,
        findings,
        worstFinding: findings.length ? worstSeverity(findings) : null,
        assetInventory: inventory,
        artifacts: { scenes: scenesPath, plan: paths.plan, state: paths.state },
        nextStep: nextStepFor(state),
      };
    },
  },
  {
    name: 'video_director_preview',
    cost: 'local',
    title: 'Director: low-cost preview render',
    description:
      'Renders the current scenes.json at preview quality (720p) with the existing Remotion pipeline, then extracts per-scene representative frames (scene midpoints) and a contact sheet for visual critique. ' +
      'Slow (minutes); reports progress. Read the returned frame images yourself before critiquing — do not judge blind.',
    inputSchema: {
      type: 'object',
      properties: {
        project: PROJECT_ARG,
        profile: { type: 'string', description: 'Brand profile supplying aspect/caption defaults, default "default".' },
        images: { type: 'boolean', description: 'Attach the contact sheet + representative frames as MCP image content (default true) so you actually see them. Local paths are returned either way.' },
      },
      required: ['project'],
      additionalProperties: false,
    },
    annotations: { ...LOCAL_WRITE, idempotentHint: false },
    async handler({ project, profile, images = true }, { ctx, progress, log, plan }) {
      const { scenes, scenesPath } = await scenesOrThrow(ctx, project);
      const { profile: brand } = await loadBrandProfile(ctx, profile || 'default');
      const paths = directorPaths(ctx, project);
      const stateBefore = await readState(ctx, project);
      const round = Math.max(1, stateBefore?.round || 1);
      const outDir = await ctx.ensureDir(paths.previews);
      const preview = join(outDir, `round-${round}.mp4`);
      progress?.(2, 'rendering 720p preview');
      // Preview is deliberately cheap: 720p regardless of plan; watermark per plan.
      const done = await renderTo(ctx, {
        scenesPath,
        output: preview,
        resolution: '720p',
        aspect: (stateBefore?.aspect) || brand.visual.aspect || '16:9',
        captions: brand.captions,
        plan: { ...plan, maxExportHeight: 720 },
        progress,
      });
      progress?.(80, 'extracting review frames');
      const reviewDir = join(outDir, `round-${round}`);
      const extraction = await extractPreviewFrames(await findFfmpeg(), preview, scenes, reviewDir);
      const state = await writeState(ctx, project, {
        phase: 'previewed',
        round,
        lastPreview: { video: preview, resolution: done.resolution, frames: extraction.frames, contactSheet: extraction.contactSheet, scenesHash: scenesFingerprint(scenes) },
        approvedScenesHash: null,
      });
      // Remote agents cannot read local paths; attach the critique material as
      // image content (protocol.mjs turns mcpImages into image blocks).
      let mcpImages = [];
      if (images) {
        progress?.(92, 'encoding review frames for transport');
        try {
          mcpImages = await inlineReviewImages(await findFfmpeg(), extraction);
        } catch (error) {
          log(`director preview could not inline images: ${error.message}`);
        }
      }
      return {
        phase: state.phase,
        round,
        previewVideo: preview,
        durationSeconds: scenes.reduce((sum, scene) => sum + scene.duration, 0),
        frames: extraction.frames,
        contactSheet: extraction.contactSheet,
        inlineImageCount: mcpImages.length,
        findings: runDirectorChecks(scenes, { aspect: stateBefore?.aspect || brand.visual.aspect }),
        mcpImages,
        artifacts: { preview: reviewDir, state: paths.state },
        nextStep: nextStepFor(state),
      };
    },
  },
  {
    name: 'video_director_frames',
    cost: 'local',
    title: 'Director: read review frames as images',
    description:
      'Returns extracted preview frames as MCP image content (base64 JPEG) so a remote agent can actually see them — the contact sheet by default, or specific scenes via sceneIds (a preview renders all frames but only attaches a few). ' +
      'Local file paths come back either way. Use between review rounds to re-examine a scene after fixing it.',
    inputSchema: {
      type: 'object',
      properties: {
        project: PROJECT_ARG,
        round: { type: 'integer', description: 'Preview round to read; default: the latest round.' },
        sceneIds: {
          type: 'array',
          description: 'Specific scenes to see (replaces the contact sheet). Default: none → contact sheet only.',
          items: { type: 'string' },
        },
        maxWidth: { type: 'integer', description: 'Frame width in px, 256–1280, default 640.' },
      },
      required: ['project'],
      additionalProperties: false,
    },
    annotations: LOCAL_READ,
    async handler({ project, round, sceneIds = [], maxWidth = 640 }, { ctx }) {
      const state = await readState(ctx, project);
      if (!state || state.phase === 'planned') {
        throw new ToolError('no preview frames yet: run video_director_preview first');
      }
      const targetRound = Math.max(1, round ?? state.round ?? 1);
      const extraction = await listRoundFrames(directorPaths(ctx, project).previews, targetRound);
      if (!extraction) {
        throw new ToolError(`round ${targetRound} has no extracted frames; run video_director_preview first`);
      }
      const known = new Set(extraction.frames.map((frame) => frame.sceneId));
      for (const sceneId of sceneIds) {
        if (!known.has(sceneId)) {
          throw new ToolError(`scene "${sceneId}" has no frame in round ${targetRound}; available: ${[...known].join(', ') || 'none'}`);
        }
      }
      const width = Math.min(1280, Math.max(256, maxWidth));
      const ffmpeg = await findFfmpeg();
      const wanted = sceneIds.length
        ? extraction.frames.filter((frame) => sceneIds.includes(frame.sceneId))
        : [];
      const mcpImages = [];
      if (!sceneIds.length && extraction.contactSheet) {
        mcpImages.push({ ...(await jpegImageContent(ffmpeg, extraction.contactSheet, { width: Math.max(1024, width) })), title: `round ${targetRound} contact sheet` });
      }
      for (const frame of wanted) {
        mcpImages.push({ ...(await jpegImageContent(ffmpeg, frame.path, { width })), title: `round ${targetRound} scene ${frame.sceneId}` });
      }
      if (mcpImages.length === 0) {
        throw new ToolError(`round ${targetRound} has no readable images (no contact sheet, no matching frames)`);
      }
      return {
        phase: state.phase,
        round: targetRound,
        frames: extraction.frames,
        contactSheet: extraction.contactSheet,
        inlineImageCount: mcpImages.length,
        mcpImages,
        artifacts: { preview: extraction.dir },
        nextStep: 'Critique what you see, then video_director_review with your findings.',
      };
    },
  },
  {
    name: 'video_director_review',
    cost: 'local',
    title: 'Director: record critique verdict',
    description:
      'Records your critique of the preview as the review of record: findings [{sceneId?, severity: blocker|warning|nit, category, note}] plus verdict. ' +
      'verdict=revise marks the named scenes for targeted revision (redo scenes, not the whole film); verdict=pass with no blockers approves the cut for final render. ' +
      'Deterministic checks are re-run and merged so nothing structural slips through. Look at the extracted frames first — this tool records judgment, it does not replace it.',
    inputSchema: {
      type: 'object',
      properties: {
        project: PROJECT_ARG,
        verdict: { type: 'string', enum: ['pass', 'revise'], description: 'pass = good enough to finalize; revise = rounds continue.' },
        findings: {
          type: 'array',
          description: 'Your critique findings from the preview frames/video.',
          items: {
            type: 'object',
            properties: {
              sceneId: { type: 'string' },
              severity: { type: 'string', enum: ['blocker', 'warning', 'nit'] },
              category: { type: 'string', description: 'content | visual | pacing | captions | audio | structure | safe-area …' },
              note: { type: 'string' },
            },
          },
        },
        notes: { type: 'string', description: 'Free-form summary of this round.' },
      },
      required: ['project', 'verdict'],
      additionalProperties: false,
    },
    annotations: LOCAL_WRITE,
    async handler({ project, verdict, findings = [], notes }, { ctx }) {
      const { scenes } = await scenesOrThrow(ctx, project);
      const stateBefore = await readState(ctx, project);
      if (!stateBefore || stateBefore.phase === 'planned') {
        throw new ToolError('nothing to review yet: run video_director_preview first');
      }
      const round = Math.max(1, stateBefore.round || 1);
      const ids = new Set(scenes.map((scene) => scene.id));
      for (const [index, finding] of findings.entries()) {
        if (finding?.sceneId && !ids.has(finding.sceneId)) {
          throw new ToolError(`findings[${index}].sceneId "${finding.sceneId}" is not in scenes.json`);
        }
        if (!['blocker', 'warning', 'nit'].includes(finding?.severity)) {
          throw new ToolError(`findings[${index}].severity must be blocker|warning|nit`);
        }
        if (typeof finding?.note !== 'string' || !finding.note.trim()) {
          throw new ToolError(`findings[${index}].note must be a non-empty string`);
        }
      }
      const deterministic = runDirectorChecks(scenes, { aspect: stateBefore.aspect }).map((finding) => ({ ...finding, source: 'deterministic' }));
      const hash = scenesFingerprint(scenes);
      if (stateBefore.lastPreview?.scenesHash && stateBefore.lastPreview.scenesHash !== hash) {
        deterministic.unshift({
          severity: 'blocker',
          category: 'structure',
          note: 'scenes.json changed since the last preview; run video_director_preview again so the review covers what will render',
          source: 'deterministic',
        });
      }
      const merged = [...findings.map((finding) => ({ ...finding, source: 'agent' })), ...deterministic];
      const blockers = merged.filter((finding) => finding.severity === 'blocker');
      const approved = verdict === 'pass' && blockers.length === 0;
      const paths = directorPaths(ctx, project);
      const reviewPath = join(await ctx.ensureDir(paths.reviews), `round-${round}.json`);
      await writeFile(reviewPath, JSON.stringify(
        { version: 1, round, verdict, approved, notes: notes ?? null, findings: merged, createdAt: new Date().toISOString() },
        null,
        2,
      ));
      // A revise verdict opens the next round: the following preview renders round N+1
      // instead of overwriting the material this critique refers to.
      const state = approved
        ? await writeState(ctx, project, { phase: 'approved', round, approvedScenesHash: hash })
        : await writeState(ctx, project, { phase: 'revising', round: round + 1 });
      const reviseSceneIds = [...new Set(merged.filter((finding) => finding.sceneId).map((finding) => finding.sceneId))];
      return {
        phase: state.phase,
        // The critique refers to `reviewedRound`; `round` is the round now open.
        reviewedRound: round,
        round: state.round,
        approved,
        blockers,
        findings: merged,
        reviseSceneIds,
        artifacts: { review: reviewPath, state: paths.state },
        nextStep: nextStepFor(state),
      };
    },
  },
  {
    name: 'video_director_finalize',
    cost: 'local',
    title: 'Director: final render',
    description:
      'Gate-checked full-quality render. Refuses (with the failure point) while any scene with narration lacks audio, or the latest review is not approved — unless override=true with a reason (the user is the final judge, e.g. they asked to ship without captions). ' +
      'Renders like video_render (plan limits apply: free = 720p watermark) and marks the project done.',
    inputSchema: {
      type: 'object',
      properties: {
        project: PROJECT_ARG,
        resolution: { type: 'string', enum: ['720p', '1080p', '4K'], description: 'Default 1080p. Capped by the plan (free: 720p with watermark).' },
        format: { type: 'string', enum: ['MP4', 'MOV', 'WebM'], description: 'Default MP4.' },
        profile: { type: 'string', description: 'Brand profile supplying aspect/caption defaults, default "default".' },
        override: { type: 'boolean', description: 'Skip the review/audio gates. Use only when the user explicitly accepts the current state.' },
        overrideReason: { type: 'string', description: 'Required with override=true; recorded in the state.' },
      },
      required: ['project'],
      additionalProperties: false,
    },
    annotations: { ...LOCAL_WRITE, idempotentHint: false },
    async handler({ project, resolution, format, profile, override = false, overrideReason }, { ctx, progress, plan }) {
      const { scenes, scenesPath } = await scenesOrThrow(ctx, project);
      const { profile: brand } = await loadBrandProfile(ctx, profile || 'default');
      const state = (await readState(ctx, project)) ?? (await writeState(ctx, project, { phase: 'planned', round: 1 }));
      const failures = [];
      if (!override) {
        for (const scene of scenes) {
          if ((scene.narration ?? '').trim() && !scene.audio?.path) {
            failures.push(`scene ${scene.id} has narration but no audio (audio-first violated)`);
          }
        }
      }
      if (state.phase !== 'approved' && !override) {
        failures.push(`state phase is "${state.phase}", not approved — pass video_director_review (verdict=pass, no blockers) first`);
      } else if (!override && state.approvedScenesHash && state.approvedScenesHash !== scenesFingerprint(scenes)) {
        failures.push('scenes.json changed after approval — video_director_preview and video_director_review again');
      }
      if (override && !(overrideReason ?? '').trim()) {
        failures.push('override=true requires overrideReason');
      }
      if (failures.length > 0) {
        throw new ToolError(`not ready to finalize:\n- ${failures.join('\n- ')}`);
      }
      const ext = { MP4: 'mp4', MOV: 'mov', WebM: 'webm' }[format || 'MP4'] ?? 'mp4';
      const outputDir = await ctx.ensureDir(join(ctx.projectDir(project), 'renders'));
      const output = join(outputDir, `final-round-${Math.max(1, state.round || 1)}.${ext}`);
      const done = await renderTo(ctx, {
        scenesPath,
        output,
        resolution: resolution || '1080p',
        format: format || 'MP4',
        aspect: state.aspect || brand.visual.aspect || '16:9',
        captions: brand.captions,
        plan,
        progress,
      });
      const finalState = await writeState(ctx, project, {
        phase: 'done',
        finalOutput: output,
        override: override ? (overrideReason ?? null) : undefined,
      });
      return {
        phase: finalState.phase,
        output,
        resolution: done.resolution,
        watermark: done.watermark,
        rounds: Math.max(1, state.round || 1),
        probe: await probeMedia(await findFfmpeg(), output).catch(() => ({})),
        artifacts: { state: directorPaths(ctx, project).state },
        nextStep: nextStepFor(finalState),
      };
    },
  },
];
