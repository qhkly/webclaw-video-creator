import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { APP_ROOT, createContext, findFfmpeg, run } from '../mcp/context.mjs';
import { createMcpServer, PRO_REQUIRED_MESSAGE } from '../mcp/protocol.mjs';
import { FREE_LIMITS } from '../scripts/lib/plan.mjs';
const PRO_PLAN = { maxExportHeight: 2160, watermark: false, commercialUse: true };
import { providerIds } from '../mcp/providers.mjs';
import { buildMuxArgs, parseProbe, tools, withFileLock } from '../mcp/tools.mjs';

async function setup() {
  const workspace = await mkdtemp(join(tmpdir(), 'vc-mcp-'));
  const ctx = createContext({ workspace });
  const server = createMcpServer({ tools, ctx, readPlan: async () => PRO_PLAN });
  let id = 0;
  const call = async (name, args = {}) => {
    const response = await server.handle({ jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name, arguments: args } });
    return response.result;
  };
  return { workspace, ctx, server, call };
}

const SCENE = {
  id: 's1',
  title: 'Hello',
  text: 'Hello',
  narration: '你好，世界',
  template: 'TitleSlide',
  duration: 3,
  props: { title: 'Hello', subtitle: 'MCP' },
};

test('initialize negotiates protocol version and returns director instructions', async () => {
  const { server } = await setup();
  const known = await server.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } });
  assert.equal(known.result.protocolVersion, '2025-03-26');
  assert.ok(known.result.capabilities.tools);
  assert.match(known.result.instructions, /director/);
  const unknown = await server.handle({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '1999-01-01' } });
  assert.equal(unknown.result.protocolVersion, '2025-06-18');
  assert.equal(await server.handle({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);
});

test('tools/list exposes discoverable, well-formed tool descriptions', async () => {
  const { server } = await setup();
  const { result } = await server.handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  const names = result.tools.map((tool) => tool.name);
  for (const expected of ['video_project_status', 'video_brand_profile_get', 'video_media_probe', 'video_scenes_save', 'video_tts_synthesize', 'video_render', 'video_audio_mux']) {
    assert.ok(names.includes(expected), `missing ${expected}`);
  }
  for (const tool of result.tools) {
    assert.match(tool.name, /^video_[a-z_]+$/);
    assert.ok(tool.description.length > 40, `${tool.name} description too thin`);
    assert.equal(tool.inputSchema.type, 'object');
    assert.equal(typeof tool.annotations?.readOnlyHint, 'boolean');
    for (const key of tool.inputSchema.required ?? []) {
      assert.ok(tool.inputSchema.properties[key], `${tool.name}.${key} required but undeclared`);
    }
  }
});

test('protocol errors: unknown method and unknown tool', async () => {
  const { server } = await setup();
  const method = await server.handle({ jsonrpc: '2.0', id: 1, method: 'resources/nope' });
  assert.equal(method.error.code, -32601);
  const tool = await server.handle({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'nope', arguments: {} } });
  assert.equal(tool.error.code, -32602);
});

test('argument validation reports actionable tool errors', async () => {
  const { call } = await setup();
  const missing = await call('video_scenes_save', { scenes: [SCENE] });
  assert.equal(missing.isError, true);
  assert.match(missing.content[0].text, /missing required argument: project/);
  const badEnum = await call('video_render', { project: 'p', format: 'AVI' });
  assert.match(badEnum.content[0].text, /must be one of/);
  const extra = await call('video_providers_list', { foo: 1 });
  assert.match(extra.content[0].text, /unknown argument: foo/);
});

test('scenes_save validates, writes, and project_status reports it', async () => {
  const { call, workspace } = await setup();
  const invalid = await call('video_scenes_save', { project: 'demo', scenes: [{ ...SCENE, template: 'Nope', duration: 0 }] });
  assert.equal(invalid.isError, true);
  assert.match(invalid.content[0].text, /template must be one of/);
  assert.match(invalid.content[0].text, /duration must be a positive number/);

  const saved = await call('video_scenes_save', { project: 'demo', scenes: [SCENE, { ...SCENE, id: 's2', duration: 4.5 }] });
  assert.equal(saved.isError, undefined);
  assert.equal(saved.structuredContent.totalDuration, 7.5);
  const written = JSON.parse(await readFile(join(workspace, 'projects', 'demo', 'scenes.json'), 'utf8'));
  assert.equal(written.length, 2);

  const status = await call('video_project_status', { project: 'demo' });
  const [project] = status.structuredContent.projects;
  assert.equal(project.sceneCount, 2);
  assert.deepEqual(project.validationErrors, []);
  assert.equal(project.scenes[0].hasAudio, false);
  const all = await call('video_project_status');
  assert.deepEqual(all.structuredContent.projects.map((item) => item.id), ['demo']);
});

test('writes are confined to the workspace', async () => {
  const { ctx, call } = await setup();
  assert.throws(() => ctx.writePath('../escape.mp4'), /outside the workspace/);
  assert.throws(() => ctx.writePath('/tmp/escape.mp4'), /outside the workspace/);
  assert.throws(() => ctx.projectDir('../x'), /project must match/);
  const escaped = await call('video_scenes_save', { project: '../../etc', scenes: [SCENE] });
  assert.equal(escaped.isError, true);
});

test('brand profile falls back to defaults and deep-merges stored overrides', async () => {
  const { call, workspace } = await setup();
  const fallback = await call('video_brand_profile_get');
  assert.equal(fallback.structuredContent.isDefault, true);
  assert.equal(fallback.structuredContent.profile.voice.provider, 'edge');

  await mkdir(join(workspace, 'brand'), { recursive: true });
  await writeFile(join(workspace, 'brand', 'jia.json'), JSON.stringify({ voice: { voiceId: 'zh-CN-XiaoxiaoNeural' }, persona: { avoid: ['hype'] } }));
  const stored = await call('video_brand_profile_get', { profile: 'jia' });
  const { profile } = stored.structuredContent;
  assert.equal(stored.structuredContent.isDefault, false);
  assert.equal(profile.voice.voiceId, 'zh-CN-XiaoxiaoNeural');
  assert.equal(profile.voice.provider, 'edge');
  assert.deepEqual(profile.persona.avoid, ['hype']);
  assert.equal(profile.captions.enabled, true);
  const status = await call('video_project_status');
  assert.deepEqual(status.structuredContent.brandProfiles, ['jia']);
});

test('tts reports missing scene without spawning a provider', async () => {
  const { call } = await setup();
  await call('video_scenes_save', { project: 'demo', scenes: [SCENE] });
  const result = await call('video_tts_synthesize', { project: 'demo', sceneId: 'missing' });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /scene missing not found/);
});

test('review hardening: batch, provider enum, project listing, mux guards, symlink escape', async () => {
  const { server, call, workspace } = await setup();
  const batch = await server.handle([{ jsonrpc: '2.0', id: 1, method: 'ping' }]);
  assert.equal(batch.error.code, -32600);

  const { result } = await server.handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  const tts = result.tools.find((tool) => tool.name === 'video_tts_synthesize');
  assert.deepEqual(tts.inputSchema.properties.provider.enum, providerIds('tts'));

  await mkdir(join(workspace, 'projects', 'has space'), { recursive: true });
  await call('video_scenes_save', { project: 'ok', scenes: [SCENE] });
  const status = await call('video_project_status');
  assert.equal(status.isError, undefined);
  assert.deepEqual(status.structuredContent.projects.map((item) => item.id), ['ok']);

  await writeFile(join(workspace, 'v.mp4'), 'x');
  await writeFile(join(workspace, 'a.mp3'), 'x');
  const same = await call('video_audio_mux', { video: 'v.mp4', segments: [{ path: 'a.mp3' }], output: 'v.mp4' });
  assert.match(same.content[0].text, /output must differ/);
  const badVolume = await call('video_audio_mux', { video: 'v.mp4', segments: [{ path: 'a.mp3', volume: 'loud' }], output: 'o.mp4' });
  assert.match(badVolume.content[0].text, /volume must be a number/);
  const badStart = await call('video_audio_mux', { video: 'v.mp4', segments: [{ path: 'a.mp3', startTime: -1 }], output: 'o.mp4' });
  assert.match(badStart.content[0].text, /startTime must be a number >= 0/);
  const root = await call('video_audio_mux', { video: 'v.mp4', segments: [{ path: 'a.mp3' }], output: '.' });
  assert.match(root.content[0].text, /outside the workspace/);

  const outside = await mkdtemp(join(tmpdir(), 'vc-outside-'));
  await symlink(outside, join(workspace, 'escape'));
  const escaped = await call('video_audio_mux', { video: 'v.mp4', segments: [{ path: 'a.mp3' }], output: 'escape/x/out.mp4' });
  assert.match(escaped.content[0].text, /link that leaves the workspace/);
});

test('file lock serializes concurrent read-modify-write cycles', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'vc-lock-'));
  const path = join(workspace, 'counter.json');
  await writeFile(path, JSON.stringify({ n: 0 }));
  const bump = () =>
    withFileLock(path, async () => {
      const { n } = JSON.parse(await readFile(path, 'utf8'));
      await new Promise((resolve) => setTimeout(resolve, 5));
      await writeFile(path, JSON.stringify({ n: n + 1 }));
    });
  const failing = withFileLock(path, async () => {
    throw new Error('boom');
  });
  await Promise.all([bump(), bump(), failing.catch(() => {}), bump(), bump()]);
  assert.equal(JSON.parse(await readFile(path, 'utf8')).n, 4);
});

test('probe parser and mux argument builder', () => {
  const probe = parseProbe(
    'Input #0, mov,mp4, from \'a.mp4\':\n  Duration: 00:01:02.50, start: 0.000000\n' +
      '  Stream #0:0: Video: h264 (High), yuv420p, 1920x1080 [SAR 1:1 DAR 16:9], 30 fps\n  Stream #0:1: Audio: aac, 48000 Hz, stereo\n',
  );
  assert.deepEqual(probe, { duration: 62.5, hasVideo: true, hasAudio: true, width: 1920, height: 1080 });
  const args = buildMuxArgs('v.mp4', [{ path: 'a.mp3', startTime: 1.5, volume: 1 }, { path: 'b.mp3', startTime: 0, volume: 0.2 }], 'out.mp4');
  const filter = args[args.indexOf('-filter_complex') + 1];
  assert.match(filter, /\[1:a:0\]adelay=1500\|1500,volume=1\[a0\]/);
  assert.match(filter, /\[2:a:0\]adelay=0\|0,volume=0.2\[a1\]/);
  assert.match(filter, /amix=inputs=2:normalize=0:duration=longest,apad\[aout\]/);
  assert.equal(args.at(-1), 'out.mp4');
  assert.ok(args.includes('-shortest'), 'falls back to -shortest without a known duration');
  const kept = buildMuxArgs('v.mp4', [{ path: 'a.mp3', startTime: 0, volume: 1 }], 'out.mp4', { keepOriginal: true, duration: 8.04 });
  assert.match(kept[kept.indexOf('-filter_complex') + 1], /\[0:a:0\]\[a0\]amix=inputs=2:normalize=0:duration=longest,apad\[aout\]/);
  assert.equal(kept[kept.indexOf('-t') + 1], '8.04');
});

async function workingFfmpeg() {
  const ffmpeg = await findFfmpeg();
  const { code } = await run(ffmpeg, ['-hide_banner', '-version']).catch(() => ({ code: -1 }));
  return code === 0 ? ffmpeg : null;
}

test('probe and mux real media with ffmpeg', async (t) => {
  const ffmpeg = await workingFfmpeg();
  if (!ffmpeg) {
    t.skip('no runnable ffmpeg (set FFMPEG_PATH)');
    return;
  }
  const { call, workspace } = await setup();
  const video = join(workspace, 'clip.mp4');
  const audio = join(workspace, 'voice.wav');
  await run(ffmpeg, ['-y', '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=10:duration=2', '-pix_fmt', 'yuv420p', video]);
  await run(ffmpeg, ['-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', audio]);

  const probe = await call('video_media_probe', { path: 'clip.mp4' });
  assert.equal(probe.structuredContent.hasVideo, true);
  assert.equal(probe.structuredContent.width, 320);

  const muxed = await call('video_audio_mux', { video: 'clip.mp4', segments: [{ path: audio, startTime: 0.5 }], output: 'out/final.mp4' });
  assert.equal(muxed.isError, undefined, muxed.content[0].text);
  assert.equal(muxed.structuredContent.hasAudio, true);
  assert.equal(muxed.structuredContent.hasVideo, true);
  assert.ok(Math.abs(muxed.structuredContent.duration - 2) < 0.2, `video length kept, got ${muxed.structuredContent.duration}`);

  // Second pass mixes onto a video that now has audio: original track kept, length unchanged.
  const remixed = await call('video_audio_mux', { video: 'out/final.mp4', segments: [{ path: audio, startTime: 1 }], output: 'out/remix.mp4' });
  assert.equal(remixed.structuredContent.keptOriginalAudio, true);
  assert.ok(Math.abs(remixed.structuredContent.duration - 2) < 0.2, `video length kept, got ${remixed.structuredContent.duration}`);
});

test('render staging rewrites local media to static paths inside publicDir', async () => {
  const { stageSceneMedia } = await import('../scripts/lib/stage-media.mjs');
  const root = await mkdtemp(join(tmpdir(), 'vc-stage-'));
  const publicDir = join(root, 'public');
  await mkdir(join(publicDir, 'bg'), { recursive: true });
  await writeFile(join(root, 'voice.mp3'), 'audio');
  await writeFile(join(publicDir, 'bg', 'clip.mp4'), 'video');
  const scenes = [
    { ...SCENE, audio: { path: join(root, 'voice.mp3'), duration: 1 }, background: { kind: 'video', assetPath: join(publicDir, 'bg', 'clip.mp4') } },
    { ...SCENE, id: 's2', audio: { path: 'https://example.com/a.mp3', duration: 1 } },
  ];
  const staged = await stageSceneMedia(scenes, publicDir);
  assert.match(staged[0].audio.path, /^static:_render\/[0-9a-f]{10}-voice\.mp3$/);
  assert.equal(await readFile(join(publicDir, staged[0].audio.path.slice('static:'.length)), 'utf8'), 'audio');
  assert.equal(staged[0].background.assetPath, 'static:bg/clip.mp4');
  assert.equal(staged[1].audio.path, 'https://example.com/a.mp3');
  assert.equal(scenes[0].audio.path, join(root, 'voice.mp3'), 'input scenes are not mutated');
});

async function stdioSession(messages, env = {}) {
  const workspace = await mkdtemp(join(tmpdir(), 'vc-mcp-stdio-'));
  const child = spawn(process.execPath, [join(APP_ROOT, 'mcp', 'server.mjs'), '--workspace', workspace], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, VIDEO_CREATOR_ENTITLEMENT_FILE: '', ...env },
  });
  child.stdin.end(messages.map((message) => JSON.stringify(message)).join('\n') + '\n');
  let stdout = '';
  child.stdout.on('data', (chunk) => (stdout += chunk));
  const code = await new Promise((resolve) => child.on('close', resolve));
  const responses = stdout.trim().split('\n').map((line) => JSON.parse(line));
  return { code, workspace, responses, byId: Object.fromEntries(responses.map((response) => [response.id, response])) };
}

async function entitlementFile(limits, expiresAt = Date.now() + 10 * 60 * 1000) {
  const path = join(await mkdtemp(join(tmpdir(), 'vc-entitlement-')), 'entitlement.json');
  await writeFile(path, JSON.stringify({ version: 1, limits, expiresAt }));
  return path;
}

const STATUS_CALL = { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'video_project_status', arguments: {} } };

test('stdio transport: an MCP client can initialize and list tools', async () => {
  const messages = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    STATUS_CALL,
  ];
  const { code, workspace, responses, byId } = await stdioSession(messages, { VIDEO_CREATOR_ENTITLEMENT_FILE: await entitlementFile(PRO_PLAN) });
  assert.equal(code, 0);
  assert.equal(byId[1].result.serverInfo.name, 'webclaw-video-creator');
  assert.ok(byId[2].result.tools.length >= 5);
  assert.equal(byId[3].result.structuredContent.workspace, workspace);
  assert.equal(responses.length, 3, 'notifications must not produce responses');
});

test('free plan regression: basic video tools run without sign-in, membership or a live entitlement', async () => {
  // Regression: a free install used to get "AI Director is a Pro feature" on the very first
  // video_project_status call, so an agent never reached generation or rendering.
  const SAVE_CALL = { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'video_scenes_save', arguments: { project: 'demo', scenes: [{ id: 's1', title: 'T', text: '', narration: 'n', template: 'TitleSlide', duration: 3, props: {} }] } } };
  const PROVIDERS_CALL = { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'video_providers_list', arguments: {} } };
  const cases = {
    'no entitlement file (signed out / membership lookup failed)': {},
    'missing file': { VIDEO_CREATOR_ENTITLEMENT_FILE: join(tmpdir(), 'vc-no-such-entitlement.json') },
    'expired file': { VIDEO_CREATOR_ENTITLEMENT_FILE: await entitlementFile(PRO_PLAN, Date.now() - 1) },
    'free plan file': { VIDEO_CREATOR_ENTITLEMENT_FILE: await entitlementFile(FREE_LIMITS) },
    'old free file with aiDirector: false': { VIDEO_CREATOR_ENTITLEMENT_FILE: await entitlementFile({ ...FREE_LIMITS, aiDirector: false, aiCutCleanup: false }) },
  };
  for (const [label, env] of Object.entries(cases)) {
    const { code, workspace, byId } = await stdioSession([{ jsonrpc: '2.0', id: 2, method: 'tools/list' }, STATUS_CALL, PROVIDERS_CALL, SAVE_CALL], env);
    assert.equal(code, 0, label);
    assert.ok(byId[2].result.tools.length >= 5, label);
    for (const callId of [3, 4, 5]) {
      assert.equal(byId[callId].result.isError, undefined, `${label} / call ${callId}: ${byId[callId].result.content[0].text}`);
      assert.doesNotMatch(byId[callId].result.content[0].text, /Pro feature|PRO_REQUIRED|needs WebClaw Video Creator Pro/, label);
    }
    assert.equal(byId[3].result.structuredContent.workspace, workspace, label);
    assert.ok(Array.isArray(byId[4].result.structuredContent.providers), label);
  }
});

test('no shipped tool requires a WebClaw plan; only a tool declaring planFeature is gated', async () => {
  assert.deepEqual(tools.filter((tool) => tool.planFeature).map((tool) => tool.name), []);
  const hosted = {
    name: 'video_hosted_test',
    title: 'Hosted (WebClaw-paid) test tool',
    description: 'test',
    cost: 'paid',
    planFeature: 'hostedTest',
    inputSchema: { type: 'object', properties: {} },
    annotations: {},
    handler: async () => ({ ok: true }),
  };
  const ctx = createContext({ workspace: await mkdtemp(join(tmpdir(), 'vc-mcp-plan-')) });
  const call = (readPlan) => createMcpServer({ tools: [hosted], ctx, readPlan })
    .handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: hosted.name, arguments: {} } })
    .then((response) => response.result);
  const refused = await call(async () => FREE_LIMITS);
  assert.equal(refused.isError, true);
  assert.equal(refused.content[0].text, PRO_REQUIRED_MESSAGE);
  assert.equal((await call(async () => ({ ...PRO_PLAN, hostedTest: 'true' }))).isError, true, 'only boolean true counts');
  assert.deepEqual((await call(async () => ({ ...PRO_PLAN, hostedTest: true }))).structuredContent, { ok: true });
});

test('tools/call turns handler mcpImages into image content blocks (generic, any tool)', async () => {
  const ctx = createContext({ workspace: await mkdtemp(join(tmpdir(), 'vc-mcp-img-')) });
  const pixel = Buffer.from('not-really-a-jpeg').toString('base64');
  const fake = [
    { name: 'with_image', inputSchema: { type: 'object' }, handler: async () => ({ ok: true, mcpImages: [{ data: pixel, mimeType: 'image/jpeg', title: 'sheet' }] }) },
    { name: 'plain', inputSchema: { type: 'object' }, handler: async () => ({ ok: true }) },
    {
      name: 'oversize',
      inputSchema: { type: 'object' },
      handler: async () => ({
        ok: true,
        mcpImages: [{ data: 'A'.repeat(1_600_000), mimeType: 'image/jpeg' }, { mimeType: 'image/jpeg' }], // too big + missing data
      }),
    },
  ];
  let id = 0;
  const call = async (name) => {
    const response = await createMcpServer({ tools: fake, ctx, readPlan: async () => PRO_PLAN })
      .handle({ jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name, arguments: {} } });
    return response.result;
  };

  const withImage = await call('with_image');
  const image = withImage.content.find((block) => block.type === 'image');
  assert.ok(image, 'an image content block is present');
  assert.equal(image.data, pixel);
  assert.equal(image.mimeType, 'image/jpeg');
  assert.equal(withImage.content.filter((block) => block.type === 'text').length, 1, 'exactly one text block');
  // The attachment key never leaks into structuredContent or the text JSON.
  assert.deepEqual(withImage.structuredContent, { ok: true });
  assert.deepEqual(JSON.parse(withImage.content.find((block) => block.type === 'text').text), { ok: true });

  const plain = await call('plain');
  assert.equal(plain.content.length, 1);
  assert.equal(plain.content[0].type, 'text');
  assert.deepEqual(plain.structuredContent, { ok: true });

  const oversize = await call('oversize');
  assert.equal(oversize.content.filter((block) => block.type === 'image').length, 0, 'oversized/malformed images are dropped, not fatal');
  assert.ok(oversize.content.some((block) => block.type === 'text' && /omitted/.test(block.text)));
  assert.deepEqual(oversize.structuredContent, { ok: true });
});
