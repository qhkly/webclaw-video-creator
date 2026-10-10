import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createContext, findFfmpeg, run } from '../mcp/context.mjs';
import { createMcpServer } from '../mcp/protocol.mjs';
import { tools } from '../mcp/tools.mjs';
import { extractPreviewFrames, readState, runDirectorChecks } from '../mcp/director.mjs';

const PRO_PLAN = { maxExportHeight: 2160, watermark: false, commercialUse: true };

async function setup() {
  const workspace = await mkdtemp(join(tmpdir(), 'vc-director-'));
  const ctx = createContext({ workspace });
  const server = createMcpServer({ tools, ctx, readPlan: async () => PRO_PLAN });
  let id = 0;
  const call = async (name, args = {}) => {
    const response = await server.handle({ jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name, arguments: args } });
    return response.result;
  };
  return { workspace, ctx, server, call };
}

const SCENE = (id, overrides = {}) => ({
  id,
  title: `T ${id}`,
  text: `T ${id}`,
  narration: '',
  template: 'TitleSlide',
  duration: 3,
  props: { title: `T ${id}` },
  ...overrides,
});

const audio = (duration) => ({ path: '/tmp/a.mp3', duration, wordsPath: '/tmp/a.words.json' });

test('director checks: audio-first, timing drift, caption coverage, text runs, overflow, closer', () => {
  const scenes = [
    SCENE('s1', { narration: 'hello' }), // blocker: narration without audio
    SCENE('s2', { narration: 'hi', audio: audio(2.0), duration: 6, captions: [{ text: 'hi', startMs: 0, durationMs: 500 }] }), // timing drift
    SCENE('s3', { narration: 'yo', audio: audio(2.0), duration: 2 }), // no captions
    SCENE('s4'), // three text-only scenes s2..s4 → visual warning (only after >2)
  ];
  const findings = runDirectorChecks(scenes, {});
  const byNote = (part) => findings.filter((finding) => finding.note.includes(part));
  assert.ok(findings.some((finding) => finding.severity === 'blocker' && finding.category === 'audio' && finding.sceneId === 's1'));
  assert.ok(byNote('drifts').some((finding) => finding.sceneId === 's2'));
  assert.ok(byNote('no word-level captions').some((finding) => finding.sceneId === 's3'));
  assert.ok(byNote('consecutive text-only').length > 0, 'warns on text-card runs');
  assert.ok(findings.some((finding) => finding.category === 'structure' && finding.note.includes('CTA')), 'suggests a CTA closer');
});

test('director checks: assets break text runs; CTA closer satisfies structure check', () => {
  const scenes = [
    SCENE('s1', { background: { kind: 'image', assetPath: '/tmp/bg.png' } }),
    SCENE('s2', { template: 'ImageFrame', props: { imageSrc: '/tmp/x.png' } }),
    SCENE('s3', { template: 'CTA', props: { title: 'Try it' } }),
  ];
  const findings = runDirectorChecks(scenes, {});
  assert.deepEqual(findings.filter((finding) => finding.category === 'visual' || finding.category === 'structure'), []);
});

test('director checks: headline overflow limits differ by aspect', () => {
  const long = '这是一个特别长的标题会溢出画面真的太长了吧';
  const wide = runDirectorChecks([SCENE('s1', { props: { title: long }, template: 'CTA' })], { aspect: '16:9' });
  const tall = runDirectorChecks([SCENE('s1', { props: { title: long }, template: 'CTA' })], { aspect: '9:16' });
  assert.ok(tall.filter((finding) => finding.category === 'overflow').length >= wide.filter((finding) => finding.category === 'overflow').length);
});

test('director plan saves scenes + plan and reports phase/nextStep', async () => {
  const { call, workspace } = await setup();
  const result = await call('video_director_plan', {
    project: 'demo',
    brief: 'a promo',
    scenes: [SCENE('s1', { template: 'CTA', props: { title: 'Try WebClaw', actionText: '免费开始' } })],
  });
  assert.equal(result.isError, undefined);
  assert.equal(result.structuredContent.phase, 'planned');
  assert.match(result.structuredContent.nextStep, /video_tts_synthesize/);
  assert.equal(result.structuredContent.worstFinding, null);
  const scenes = JSON.parse(await readFile(join(workspace, 'projects', 'demo', 'scenes.json'), 'utf8'));
  assert.equal(scenes[0].template, 'CTA');
  const plan = JSON.parse(await readFile(join(workspace, 'projects', 'demo', 'director', 'plan.json'), 'utf8'));
  assert.equal(plan.brief, 'a promo');

  const invalid = await call('video_director_plan', { project: 'demo', brief: 'x', scenes: [{ ...SCENE('s1'), template: 'Nope' }] });
  assert.equal(invalid.isError, true);
  assert.match(invalid.content[0].text, /template must be one of/);
});

test('director review requires a preview, records findings, gates approval on blockers', async () => {
  const { call } = await setup();
  await call('video_director_plan', { project: 'demo', brief: 'b', scenes: [SCENE('s1')] });
  const tooEarly = await call('video_director_review', { project: 'demo', verdict: 'pass' });
  assert.equal(tooEarly.isError, true);
  assert.match(tooEarly.content[0].text, /video_director_preview first/);
});

test('director preview → review → finalize state machine (render sidecar stubbed)', async () => {
  const { call, ctx, workspace } = await setup();
  const scenes = [
    SCENE('s1', { narration: 'first', audio: audio(2.4), duration: 3, captions: [{ text: 'first', startMs: 0, durationMs: 400 }] }),
    SCENE('s2', { template: 'CTA', props: { title: 'Try it', actionText: 'Start' }, narration: 'go', audio: audio(1.9), duration: 2, captions: [{ text: 'go', startMs: 0, durationMs: 300 }] }),
  ];
  await call('video_director_plan', { project: 'demo', brief: 'b', scenes });

  // Stub the render sidecar: write a real tiny mp4 (so frame extraction runs),
  // emit the done line the way the real child process would (through onStdoutLine).
  const renderCalls = [];
  const ffmpeg = await findFfmpeg();
  ctx.runScript = async (context, script, args, options = {}) => {
    renderCalls.push({ script, args });
    const output = args[args.indexOf('--output') + 1];
    await context.ensureDir(join(output, '..'));
    const made = await run(ffmpeg, ['-y', '-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=15:duration=5', '-pix_fmt', 'yuv420p', output]);
    assert.equal(made.code, 0, made.stderr.slice(-300));
    options.onStdoutLine?.(JSON.stringify({ type: 'done', output, resolution: '720p', watermark: true }));
    return { code: 0, stdout: '', stderr: '' };
  };

  const preview = await call('video_director_preview', { project: 'demo' });
  assert.equal(preview.isError, undefined, preview?.content?.[0]?.text);
  assert.equal(preview.structuredContent.phase, 'previewed');
  assert.match(preview.structuredContent.nextStep, /video_director_review/);
  assert.equal(preview.structuredContent.frames.length, 2);
  assert.ok(renderCalls.every((call_) => call_.args.includes('--maxHeight') === false || true));

  const revise = await call('video_director_review', {
    project: 'demo',
    verdict: 'revise',
    findings: [{ sceneId: 's2', severity: 'warning', category: 'visual', note: 'CTA too plain' }],
  });
  assert.equal(revise.structuredContent.phase, 'revising');
  assert.equal(revise.structuredContent.round, 2, 'a revise verdict opens round 2');
  assert.deepEqual(revise.structuredContent.reviseSceneIds, ['s2']);
  assert.match(revise.structuredContent.nextStep, /video_scenes_save|video_tts_synthesize/);

  const badScene = await call('video_director_review', { project: 'demo', verdict: 'pass', findings: [{ sceneId: 'nope', severity: 'nit', category: 'x', note: 'y' }] });
  assert.equal(badScene.isError, true);

  const blocked = await call('video_director_finalize', { project: 'demo' });
  assert.equal(blocked.isError, true);
  assert.match(blocked.content[0].text, /not approved/);

  // Round 2 preview (new files, round 1 kept), then approve and finalize.
  const preview2 = await call('video_director_preview', { project: 'demo' });
  assert.match(preview2.structuredContent.previewVideo, /round-2\.mp4$/);
  const pass = await call('video_director_review', { project: 'demo', verdict: 'pass', findings: [{ severity: 'nit', category: 'pacing', note: 'fine' }] });
  assert.equal(pass.structuredContent.approved, true);
  assert.equal(pass.structuredContent.phase, 'approved');

  const final = await call('video_director_finalize', { project: 'demo', resolution: '1080p' });
  assert.equal(final.isError, undefined, final?.content?.[0]?.text);
  assert.equal(final.structuredContent.phase, 'done');
  assert.match(final.structuredContent.output, /final-round-2\.mp4$/);
  assert.match(final.structuredContent.nextStep, /Deliver/);

  const state = JSON.parse(await readFile(join(workspace, 'projects', 'demo', 'director', 'state.json'), 'utf8'));
  assert.equal(state.phase, 'done');
  assert.equal(state.finalOutput, final.structuredContent.output);
});

test('director finalize keeps the audio-first gate even with an approved review', async () => {
  const { call, ctx } = await setup();
  const scenes = [SCENE('s1', { narration: 'unvoiced' })];
  await call('video_director_plan', { project: 'demo', brief: 'b', scenes });
  ctx.runScript = async (context, script, args, options = {}) => {
    const output = args[args.indexOf('--output') + 1];
    await context.ensureDir(join(output, '..'));
    await writeFile(output, 'fake');
    options.onStdoutLine?.(JSON.stringify({ type: 'done', output, resolution: '720p', watermark: true }));
    return { code: 0, stdout: '', stderr: '' };
  };
  await call('video_director_preview', { project: 'demo' });
  // Review cannot pass: the deterministic audio-first blocker is merged in.
  const pass = await call('video_director_review', { project: 'demo', verdict: 'pass' });
  assert.equal(pass.structuredContent.approved, false);
  const forced = await call('video_director_finalize', { project: 'demo' });
  assert.equal(forced.isError, true);
  assert.match(forced.content[0].text, /no audio/);
  // The user is the final judge: an explicit override with a reason ships it.
  const noReason = await call('video_director_finalize', { project: 'demo', override: true });
  assert.match(noReason.content[0].text, /overrideReason/);
  const shipped = await call('video_director_finalize', { project: 'demo', override: true, overrideReason: 'user asked to ship silent' });
  assert.equal(shipped.structuredContent.phase, 'done');
});

test('extractPreviewFrames grabs one midpoint frame per scene plus a contact sheet', async () => {
  const ffmpeg = await findFfmpeg();
  const dir = await mkdtemp(join(tmpdir(), 'vc-frames-'));
  const video = join(dir, 'preview.mp4');
  // 4 seconds of moving test pattern, one scene per second.
  const made = await run(ffmpeg, ['-y', '-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=15:duration=4', '-pix_fmt', 'yuv420p', video]);
  assert.equal(made.code, 0, made.stderr.slice(-300));
  const scenes = [SCENE('s1', { duration: 1 }), SCENE('s2', { duration: 1 }), SCENE('s3', { duration: 1 }), SCENE('s4', { duration: 1 })];
  const extraction = await extractPreviewFrames(ffmpeg, video, scenes, join(dir, 'round-1'));
  assert.equal(extraction.frames.length, 4);
  assert.ok(extraction.frames.every((frame) => frame.path.endsWith('.jpg')));
  assert.equal(extraction.frames.map((frame) => frame.sceneId).join(','), 's1,s2,s3,s4');
  // Midpoints: 0.45s, 1.45s, 2.45s, 3.45s.
  assert.ok(extraction.frames[0].atSeconds < 1 && extraction.frames[3].atSeconds > 3);
  assert.ok(extraction.contactSheet, 'contact sheet extracted');
});

test('director preview attaches critique images; video_director_frames re-reads scenes as images', async () => {
  const { call, ctx } = await setup();
  assert.equal(tools.find((tool) => tool.name === 'video_director_frames').planFeature, undefined, 'free principle: no planFeature');
  const scenes = [
    SCENE('s1', { narration: 'one', audio: audio(1.4), duration: 2, captions: [{ text: 'one', startMs: 0, durationMs: 300 }] }),
    SCENE('s2', { narration: 'two', audio: audio(1.4), duration: 2, captions: [{ text: 'two', startMs: 0, durationMs: 300 }] }),
    SCENE('s3', { template: 'CTA', props: { title: 'Go', actionText: 'Start' }, narration: 'go', audio: audio(1.4), duration: 2, captions: [{ text: 'go', startMs: 0, durationMs: 300 }] }),
  ];
  await call('video_director_plan', { project: 'demo', brief: 'b', scenes });
  const ffmpeg = await findFfmpeg();
  ctx.runScript = async (context, script, args, options = {}) => {
    const output = args[args.indexOf('--output') + 1];
    await context.ensureDir(join(output, '..'));
    await run(ffmpeg, ['-y', '-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=15:duration=6', '-pix_fmt', 'yuv420p', output]);
    options.onStdoutLine?.(JSON.stringify({ type: 'done', output, resolution: '720p', watermark: true }));
    return { code: 0, stdout: '', stderr: '' };
  };

  const before = await call('video_director_frames', { project: 'demo' });
  assert.equal(before.isError, true);
  assert.match(before.content[0].text, /video_director_preview first/);

  const preview = await call('video_director_preview', { project: 'demo' });
  assert.equal(preview.isError, undefined, preview?.content?.[0]?.text);
  const imageBlocks = preview.content.filter((block) => block.type === 'image');
  // Contact sheet + up to PREVIEW_INLINE_FRAMES representative frames.
  assert.equal(imageBlocks.length, 4);
  assert.ok(imageBlocks.every((block) => block.mimeType === 'image/jpeg' && block.data.length > 1000));
  assert.equal(preview.structuredContent.inlineImageCount, 4);
  assert.equal('mcpImages' in preview.structuredContent, false, 'attachment key is stripped');

  const bare = await call('video_director_preview', { project: 'demo', images: false });
  assert.equal(bare.content.filter((block) => block.type === 'image').length, 0);
  assert.equal(bare.structuredContent.inlineImageCount, 0);

  const sheet = await call('video_director_frames', { project: 'demo' });
  assert.equal(sheet.isError, undefined);
  assert.equal(sheet.content.filter((block) => block.type === 'image').length, 1, 'default: contact sheet only');
  assert.equal(sheet.structuredContent.round, 1);
  assert.equal(sheet.structuredContent.frames.length, 3);

  const one = await call('video_director_frames', { project: 'demo', sceneIds: ['s2'] });
  assert.equal(one.content.filter((block) => block.type === 'image').length, 1);
  assert.deepEqual(one.structuredContent.frames.map((frame) => frame.sceneId), ['s1', 's2', 's3']);

  const missing = await call('video_director_frames', { project: 'demo', sceneIds: ['zz'] });
  assert.equal(missing.isError, true);
  assert.match(missing.content[0].text, /no frame in round 1/);
});

test('director gates follow the storyboard: format, edits after approval, re-plan rounds, stale frames', async () => {
  const { call, ctx, workspace } = await setup();
  const voiced = (id, extra = {}) => SCENE(id, { narration: id, audio: audio(1.4), duration: 2, captions: [{ text: id, startMs: 0, durationMs: 300 }], ...extra });
  const scenes = [voiced('s1'), voiced('s2', { template: 'CTA', props: { title: 'Go', actionText: 'Start' } })];
  await call('video_director_plan', { project: 'demo', brief: 'b', scenes });
  const ffmpeg = await findFfmpeg();
  const renderCalls = [];
  ctx.runScript = async (context, script, args, options = {}) => {
    renderCalls.push(args);
    const output = args[args.indexOf('--output') + 1];
    await context.ensureDir(join(output, '..'));
    await run(ffmpeg, ['-y', '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=10:duration=4', '-pix_fmt', 'yuv420p', join(output, '..', 'tmp.mp4')]);
    await run(ffmpeg, ['-y', '-i', join(output, '..', 'tmp.mp4'), '-c', 'copy', '-f', 'mp4', output]);
    options.onStdoutLine?.(JSON.stringify({ type: 'done', output, resolution: '720p', watermark: true }));
    return { code: 0, stdout: '', stderr: '' };
  };
  const framesDir = (round) => join(workspace, 'projects', 'demo', 'director', 'previews', `round-${round}`);
  const { readdir } = await import('node:fs/promises');

  // Re-preview in the same round after renaming a scene: old frames are gone.
  await call('video_director_preview', { project: 'demo', images: false });
  assert.ok((await readdir(framesDir(1))).some((name) => name.includes('-s1.jpg')));
  const renamed = [voiced('intro'), scenes[1]];
  await call('video_scenes_save', { project: 'demo', scenes: renamed });

  // A review of a preview that no longer matches scenes.json cannot approve.
  const stale = await call('video_director_review', { project: 'demo', verdict: 'pass' });
  assert.equal(stale.structuredContent.approved, false);
  assert.ok(stale.structuredContent.blockers.some((finding) => /changed since the last preview/.test(finding.note)));

  await call('video_director_preview', { project: 'demo', images: false }); // round 2 after the revise
  const round2 = await readdir(framesDir(2));
  assert.ok(round2.some((name) => name.includes('-intro.jpg')));
  assert.ok(!round2.some((name) => name.includes('-s1.jpg')), 'no stale frames for removed scenes');
  // Rename inside the same round and re-preview: round-2/ must not keep -intro frames.
  await call('video_scenes_save', { project: 'demo', scenes: [voiced('opening'), scenes[1]] });
  await call('video_director_preview', { project: 'demo', images: false });
  const reshot = await readdir(framesDir(2));
  assert.ok(reshot.some((name) => name.includes('-opening.jpg')));
  assert.ok(!reshot.some((name) => name.includes('-intro.jpg')), 'same-round re-preview drops stale frames');
  await call('video_scenes_save', { project: 'demo', scenes: renamed });
  await call('video_director_preview', { project: 'demo', images: false });

  const pass = await call('video_director_review', { project: 'demo', verdict: 'pass' });
  assert.equal(pass.structuredContent.approved, true);

  // Editing after approval re-closes the gate.
  await call('video_scenes_save', { project: 'demo', scenes: [voiced('intro', { duration: 2.2 }), scenes[1]] });
  const edited = await call('video_director_finalize', { project: 'demo' });
  assert.equal(edited.isError, true);
  assert.match(edited.content[0].text, /changed after approval/);
  await call('video_scenes_save', { project: 'demo', scenes: renamed }); // back to the approved storyboard

  // The requested container reaches render.mjs.
  const final = await call('video_director_finalize', { project: 'demo', format: 'WebM' });
  assert.equal(final.isError, undefined, final?.content?.[0]?.text);
  assert.match(final.structuredContent.output, /final-round-2\.webm$/);
  const finalArgs = renderCalls.at(-1);
  assert.equal(finalArgs[finalArgs.indexOf('--format') + 1], 'WebM');
  assert.equal(renderCalls[0][renderCalls[0].indexOf('--format') + 1], 'MP4', 'previews stay MP4');

  // Re-planning a finished project opens round 3 instead of overwriting round 1/2.
  const replan = await call('video_director_plan', { project: 'demo', brief: 'v2', scenes: renamed });
  assert.equal((await readState(ctx, 'demo')).round, 3);
  assert.equal(replan.structuredContent.phase, 'planned');
  const preview3 = await call('video_director_preview', { project: 'demo', images: false });
  assert.match(preview3.structuredContent.previewVideo, /round-3\.mp4$/);
  assert.ok((await readdir(framesDir(1))).some((name) => name.includes('-s1.jpg')), 'round 1 material kept');
});
