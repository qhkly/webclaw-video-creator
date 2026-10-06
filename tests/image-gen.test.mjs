import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { needsApproval } from '../mcp/approval.mjs';
import { createContext, findFfmpeg, run } from '../mcp/context.mjs';
import { checkOpenAIOAuthImage, normalizeImage, readPngSize } from '../mcp/image-gen.mjs';
import { createMcpServer } from '../mcp/protocol.mjs';
const PRO_PLAN = { maxExportHeight: 2160, watermark: false, aiDirector: true, aiCutCleanup: true, commercialUse: true };
import { listProviders } from '../mcp/providers.mjs';
import { tools } from '../mcp/tools.mjs';
import { stageSceneMedia } from '../scripts/lib/stage-media.mjs';

const SCENES = [
  { id: 'img', title: 'Pic', text: '', narration: 'n', template: 'ImageFrame', duration: 3, props: { caption: 'c' } },
  { id: 'title', title: 'T', text: '', narration: 'n', template: 'TitleSlide', duration: 3, props: {} },
];

/** A real PNG of the given size, made with ffmpeg so tests need no image fixtures. */
async function pngBytes(width, height) {
  const dir = await mkdtemp(join(tmpdir(), 'vc-png-'));
  const path = join(dir, 'in.png');
  const result = await run(await findFfmpeg(), ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `color=c=red:s=${width}x${height}`, '-frames:v', '1', path]);
  assert.equal(result.code, 0, result.stderr);
  return readFile(path);
}

async function setup(generateImage) {
  const workspace = await mkdtemp(join(tmpdir(), 'vc-image-'));
  const ctx = Object.assign(createContext({ workspace }), { generateImage });
  const server = createMcpServer({ tools, ctx, readPlan: async () => PRO_PLAN });
  let id = 0;
  const call = (name, args) => server.handle({ jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name, arguments: args } }).then((r) => r.result);
  return { workspace, ctx, call };
}

test('openai-oauth-image is available only with a Codex OAuth login and a loadable SDK', async () => {
  const home = await mkdtemp(join(tmpdir(), 'vc-home-'));
  const ok = async () => ({});
  const missing = await checkOpenAIOAuthImage({ env: {}, home, loadSdk: ok });
  assert.equal(missing.available, false);
  assert.match(missing.reason, /Codex OAuth/);

  await mkdir(join(home, '.codex'));
  await writeFile(join(home, '.codex', 'auth.json'), JSON.stringify({ tokens: { refresh_token: 'secret-value' } }));
  const ready = await checkOpenAIOAuthImage({ env: {}, home, loadSdk: ok });
  assert.equal(ready.available, true);
  assert.ok(!JSON.stringify(ready).includes('secret-value'), 'credentials never leak into the status');

  const broken = await checkOpenAIOAuthImage({ env: {}, home, loadSdk: async () => { throw new Error('nope'); } });
  assert.equal(broken.available, false);
  assert.match(broken.reason, /ai-sdk cannot be loaded/);

  const { providers, planned } = await listProviders(createContext({ workspace: home }));
  const provider = providers.find((item) => item.id === 'openai-oauth-image');
  assert.equal(provider.kind, 'image-gen');
  assert.equal(provider.billing, 'paid');
  assert.ok(!planned.some((slot) => slot.kind === 'image-gen'));
});

test('video_image_generate is a paid tool that always needs approval', () => {
  const tool = tools.find((item) => item.name === 'video_image_generate');
  assert.equal(tool.cost, 'paid');
  assert.equal(needsApproval(tool, 'auto'), true);
  assert.deepEqual(tool.inputSchema.required, ['project', 'prompt']);
  assert.deepEqual(Object.keys(tool.inputSchema.properties).sort(), ['aspect', 'filename', 'project', 'prompt', 'sceneId']);
});

test('normalizeImage cover-crops whatever size the model returned to the aspect canvas', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vc-norm-'));
  const input = join(dir, 'tall.png');
  await writeFile(input, await pngBytes(1024, 1536));
  const size = await normalizeImage(await findFfmpeg(), input, join(dir, 'out.png'), { width: 1920, height: 1080 });
  assert.deepEqual(size, { width: 1920, height: 1080 });
  assert.deepEqual(readPngSize(await readFile(join(dir, 'out.png'))), size);
});

test('video_image_generate writes a normalized PNG into project assets and attaches it to scenes', async () => {
  const requests = [];
  const bytes = await pngBytes(1024, 1024);
  const { workspace, call } = await setup(async (request) => {
    requests.push(request);
    return { bytes, mediaType: 'image/png' };
  });
  await call('video_scenes_save', { project: 'demo', scenes: SCENES });

  const first = await call('video_image_generate', { project: 'demo', prompt: 'a red square', filename: 'hero', aspect: '9:16', sceneId: 'img' });
  assert.equal(first.isError, undefined, first.content[0].text);
  const result = first.structuredContent;
  assert.equal(result.path, join(workspace, 'projects', 'demo', 'assets', 'hero.png'));
  assert.deepEqual([result.width, result.height, result.mimeType], [1080, 1920, 'image/png']);
  assert.deepEqual([result.source.width, result.source.height], [1024, 1024]);
  assert.deepEqual(requests[0], { prompt: 'a red square', size: '1024x1536' });

  const second = await call('video_image_generate', { project: 'demo', prompt: 'bg', filename: 'hero.png', sceneId: 'title' });
  assert.equal(second.structuredContent.path, join(workspace, 'projects', 'demo', 'assets', 'hero-2.png'), 'never overwrites');
  assert.deepEqual([second.structuredContent.width, second.structuredContent.height], [1920, 1080], 'brand default aspect 16:9');

  const scenes = JSON.parse(await readFile(join(workspace, 'projects', 'demo', 'scenes.json'), 'utf8'));
  assert.equal(scenes[0].props.imageSrc, result.path);
  assert.equal(scenes[0].props.caption, 'c');
  assert.deepEqual(scenes[1].background, { kind: 'image', assetPath: second.structuredContent.path, fit: 'cover' });

  const status = await call('video_project_status', { project: 'demo' });
  assert.deepEqual(status.structuredContent.projects[0].images.map((item) => item.name).sort(), ['hero-2.png', 'hero.png']);

  const missing = await call('video_image_generate', { project: 'demo', prompt: 'x', sceneId: 'nope' });
  assert.equal(missing.isError, true);
  assert.equal(requests.length, 2, 'unknown scene fails before spending quota');
});

test('render staging moves ImageFrame imageSrc into publicDir', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vc-stage-img-'));
  const image = join(root, 'hero.png');
  await writeFile(image, 'png');
  const publicDir = join(root, 'public');
  const staged = await stageSceneMedia([{ ...SCENES[0], props: { imageSrc: image, caption: 'c' } }, SCENES[1]], publicDir);
  assert.match(staged[0].props.imageSrc, /^static:_render\/[0-9a-f]{10}-hero\.png$/);
  assert.equal(staged[0].props.caption, 'c');
  assert.equal(await readFile(join(publicDir, staged[0].props.imageSrc.slice('static:'.length)), 'utf8'), 'png');
  assert.deepEqual(staged[1], SCENES[1]);
});
