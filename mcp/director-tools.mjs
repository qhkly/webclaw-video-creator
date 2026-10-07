// The Director workflow as composable MCP tools: plan → (tts) → preview →
// review → revise → finalize. The directing agent keeps every judgment call
// (script, storyboard, what to critique, when it is good enough); these tools
// persist the phase state, run the deterministic quality lint and drive the
// existing render / TTS sidecars, so one agent task can chain the whole flow.
// Every result reports { phase, artifacts, nextStep } (and the failure point on
// isError), per the director contract in docs/agent-director.md.
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { findFfmpeg, runScript, scriptError, ToolError } from './context.mjs';
import { limitArgs } from '../scripts/lib/plan.mjs';
import { loadBrandProfile } from './brand.mjs';
import {
  directorPaths,
  extractPreviewFrames,
  inventoryProjectAssets,
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

function nextStepFor(state) {
  switch (state.phase) {
    case 'planned':
      return 'Audio first: video_tts_synthesize each narration scene (sceneId), then video_director_preview.';
    case 'previewed':
      return 'Look at contactSheet + per-scene frames (read the image files). Then video_director_review with your findings.';
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
async function renderTo(ctx, { scenesPath, output, resolution, aspect, captions, plan, progress }) {
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
      const state = await writeState(ctx, project, { phase: 'planned', brief, aspect: ratio, round: 1, finalOutput: null });
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
      },
      required: ['project'],
      additionalProperties: false,
    },
    annotations: { ...LOCAL_WRITE, idempotentHint: false },
    async handler({ project, profile }, { ctx, progress, plan }) {
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
        lastPreview: { video: preview, resolution: done.resolution, frames: extraction.frames, contactSheet: extraction.contactSheet },
      });
      return {
        phase: state.phase,
        round,
        previewVideo: preview,
        durationSeconds: scenes.reduce((sum, scene) => sum + scene.duration, 0),
        frames: extraction.frames,
        contactSheet: extraction.contactSheet,
        findings: runDirectorChecks(scenes, { aspect: stateBefore?.aspect || brand.visual.aspect }),
        artifacts: { preview: reviewDir, state: paths.state },
        nextStep: nextStepFor(state),
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
        ? await writeState(ctx, project, { phase: 'approved', round })
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
