// Plan limits on real output: FFmpeg cut export and the Remotion render, probed and pixel-checked.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { findFfmpeg, probeMedia, run } from '../scripts/lib/media.mjs';
import { watermarkBox } from '../scripts/lib/plan.mjs';

let dir;
let ffmpeg;
let landscape;
let portrait;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'webclaw-plan-'));
  ffmpeg = await findFfmpeg();
  landscape = join(dir, 'landscape.mp4');
  portrait = join(dir, 'portrait.mp4');
  for (const [path, size] of [[landscape, '1920x1080'], [portrait, '1080x1920']]) {
    const { code, stderr } = await run(ffmpeg, [
      '-y', '-hide_banner', '-loglevel', 'error',
      // A flat dark frame, so the watermark is the only bright thing in its corner.
      '-f', 'lavfi', '-i', `color=c=0x101828:size=${size}:rate=25:duration=1.5`,
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=16000:duration=1.5',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', path,
    ]);
    assert.equal(code, 0, stderr);
  }
});

after(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function exportCut(input, name, extra = []) {
  const output = join(dir, name);
  const { code, stdout, stderr } = await run(process.execPath, [
    join('scripts', 'cut-export.mjs'), '--input', input, '--ranges', '[{"start":0,"end":1.2}]', '--output', output, ...extra,
  ]);
  assert.equal(code, 0, stderr);
  const done = stdout.split('\n').filter(Boolean).map((line) => JSON.parse(line)).find((line) => line.type === 'done');
  return { output, done, media: await probeMedia(ffmpeg, output) };
}

/** Mean luma of a frame region (0-255), decoded from the real file. */
function regionLuma(file, { x, y, width, height }, at = 0.6) {
  const result = spawnSync(ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-ss', String(at), '-i', file,
    '-frames:v', '1', '-vf', `crop=${width}:${height}:${x}:${y},format=gray`, '-f', 'rawvideo', 'pipe:1',
  ], { maxBuffer: 64 * 1024 * 1024 });
  assert.equal(result.status, 0, String(result.stderr));
  const pixels = result.stdout;
  assert.equal(pixels.length, width * height);
  return pixels.reduce((sum, value) => sum + value, 0) / pixels.length;
}

test('free cut export (default args): 1080p source → 1280x720 with the watermark burned in', async () => {
  const { done, media } = await exportCut(landscape, 'free.mp4');
  assert.equal(media.width, 1280);
  assert.equal(media.height, 720);
  assert.equal(done.watermark, true);
  assert.equal(done.maxExportHeight, 720);
  assert.ok(media.hasAudio, 'audio survives');
  assert.ok(Math.abs(media.duration - 1.2) < 0.15, `duration ${media.duration}`);

  const plain = await exportCut(landscape, 'free-unmarked.mp4', ['--maxHeight', '720', '--watermark', '0']);
  const box = watermarkBox(1280, 720);
  const marked = regionLuma(join(dir, 'free.mp4'), box);
  const unmarked = regionLuma(plain.output, box);
  assert.ok(marked - unmarked > 20, `watermark region must be brighter: ${marked} vs ${unmarked}`);
  // Elsewhere the two encodes are the same picture.
  const corner = { x: 0, y: 0, width: 200, height: 120 };
  assert.ok(Math.abs(regionLuma(join(dir, 'free.mp4'), corner) - regionLuma(plain.output, corner)) < 3);
});

test('free cut export of a portrait video keeps orientation: 720x1280', async () => {
  const { media } = await exportCut(portrait, 'portrait-free.mp4');
  assert.equal(media.width, 720);
  assert.equal(media.height, 1280);
});

test('Pro cut export keeps the source resolution and adds no watermark', async () => {
  const { done, media, output } = await exportCut(landscape, 'pro.mp4', ['--maxHeight', '2160', '--watermark', '0']);
  assert.equal(media.width, 1920);
  assert.equal(media.height, 1080);
  assert.equal(done.watermark, false);
  const box = watermarkBox(1920, 1080);
  assert.ok(regionLuma(output, box) < 40, 'no bright watermark in the corner');
});

test('a 1080 Pro limit downsizes 4K-class sources only to 1080', async () => {
  const { media } = await exportCut(landscape, 'pro-1080.mp4', ['--maxHeight', '1080', '--watermark', '0']);
  assert.equal(media.height, 1080);
});

// Remotion needs its headless Chromium (downloaded on first render into node_modules/.remotion).
const remotionBrowser = join('node_modules', '.remotion', 'chrome-headless-shell');
const hasBrowser = existsSync(remotionBrowser) && readdirSync(remotionBrowser).some((name) => !name.startsWith('VERSION'));

test('Remotion render: a free 4K request renders 720p with the watermark in the frame', { skip: !hasBrowser && 'Remotion browser not downloaded', timeout: 480_000 }, async () => {
  const scenes = join(dir, 'scenes.json');
  await writeFile(scenes, JSON.stringify([{ id: 's1', title: 'Plan', template: 'TitleSlide', duration: 1, narration: '', props: { title: 'Plan', subtitle: '' } }]));
  const render = async (name, extra) => {
    const output = join(dir, name);
    const { code, stdout, stderr } = await run(process.execPath, [
      join('scripts', 'render.mjs'), '--scenes', scenes, '--outputDir', dir, '--output', output, ...extra,
    ]);
    assert.equal(code, 0, stderr);
    const done = stdout.split('\n').filter((line) => line.startsWith('{')).map((line) => JSON.parse(line)).find((line) => line.type === 'done');
    return { output, done, media: await probeMedia(ffmpeg, output) };
  };

  const free = await render('render-free.mp4', ['--resolution', '4K']);
  assert.equal(free.done.resolution, '720p');
  assert.equal(free.done.watermark, true);
  assert.equal(free.media.width, 1280);
  assert.equal(free.media.height, 720);

  const pro = await render('render-pro.mp4', ['--resolution', '720p', '--maxHeight', '2160', '--watermark', '0']);
  assert.equal(pro.done.watermark, false);
  const box = watermarkBox(1280, 720);
  const marked = regionLuma(free.output, box, 0.5);
  const unmarked = regionLuma(pro.output, box, 0.5);
  assert.ok(marked - unmarked > 20, `rendered watermark must be visible: ${marked} vs ${unmarked}`);
});
