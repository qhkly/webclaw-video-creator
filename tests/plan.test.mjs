import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { buildCutFilter } from '../scripts/lib/cut-filter.mjs';
import {
  FREE_LIMITS,
  clampResolution,
  fitShortSide,
  limitArgs,
  limitsFromArgs,
  readPlanFile,
  sanitizeLimits,
  watermarkBox,
} from '../scripts/lib/plan.mjs';

const PRO = { maxExportHeight: 2160, watermark: false, commercialUse: true };

test('sanitizeLimits fails closed field by field', () => {
  assert.deepEqual(sanitizeLimits(PRO), PRO);
  for (const raw of [null, undefined, 'pro', [], 42]) assert.deepEqual(sanitizeLimits(raw), FREE_LIMITS);
  assert.deepEqual(sanitizeLimits({ maxExportHeight: '2160', watermark: 'false', commercialUse: 1 }), FREE_LIMITS);
  assert.equal(sanitizeLimits({ maxExportHeight: 99999 }).maxExportHeight, 2160);
  assert.equal(sanitizeLimits({ maxExportHeight: 10 }).maxExportHeight, 720);
  assert.equal(sanitizeLimits({ maxExportHeight: 1080.5 }).maxExportHeight, 720);
});

test('entitlement file: only a current version-1 document counts', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vc-plan-'));
  const file = async (name, body) => {
    const path = join(dir, name);
    await writeFile(path, typeof body === 'string' ? body : JSON.stringify(body));
    return path;
  };
  const now = 1_000_000;
  assert.deepEqual(await readPlanFile(await file('ok.json', { version: 1, limits: PRO, expiresAt: now + 1 }), now), PRO);
  assert.deepEqual(await readPlanFile(await file('expired.json', { version: 1, limits: PRO, expiresAt: now }), now), FREE_LIMITS);
  assert.deepEqual(await readPlanFile(await file('v2.json', { version: 2, limits: PRO, expiresAt: now + 1 }), now), FREE_LIMITS);
  assert.deepEqual(await readPlanFile(await file('noexp.json', { version: 1, limits: PRO }), now), FREE_LIMITS);
  assert.deepEqual(await readPlanFile(await file('garbage.json', '{nope'), now), FREE_LIMITS);
  assert.deepEqual(await readPlanFile(join(dir, 'missing.json'), now), FREE_LIMITS);
  assert.deepEqual(await readPlanFile('', now), FREE_LIMITS);
  assert.deepEqual(await readPlanFile(undefined, now), FREE_LIMITS);
});

test('sidecar arguments: missing means free, round-trips Pro', () => {
  assert.deepEqual(limitsFromArgs({}), { maxExportHeight: 720, watermark: true });
  assert.deepEqual(limitsFromArgs({ maxHeight: 'abc', watermark: 'no' }), { maxExportHeight: 720, watermark: true });
  assert.deepEqual(limitsFromArgs({ maxHeight: '2160', watermark: '0' }), { maxExportHeight: 2160, watermark: false });
  assert.deepEqual(limitArgs(PRO), ['--maxHeight', '2160', '--watermark', '0']);
  assert.deepEqual(limitArgs(undefined), ['--maxHeight', '720', '--watermark', '1']);
});

test('render resolution is clamped to the plan', () => {
  assert.equal(clampResolution('4K', 720), '720p');
  assert.equal(clampResolution('1080p', 720), '720p');
  assert.equal(clampResolution('4K', 1080), '1080p');
  assert.equal(clampResolution('4K', 2160), '4K');
  assert.equal(clampResolution(undefined, 2160), '1080p');
  assert.equal(clampResolution('8K', 2160), '1080p');
  assert.equal(clampResolution('4K', 'lots'), '720p');
});

test('short side is limited, never upscaled, dimensions stay even', () => {
  assert.deepEqual(fitShortSide(1920, 1080, 720), { width: 1280, height: 720 });
  assert.deepEqual(fitShortSide(1080, 1920, 720), { width: 720, height: 1280 });
  assert.deepEqual(fitShortSide(3840, 2160, 720), { width: 1280, height: 720 });
  assert.deepEqual(fitShortSide(1366, 768, 720), { width: 1280, height: 720 });
  assert.equal(fitShortSide(1280, 720, 720), null);
  assert.equal(fitShortSide(320, 180, 720), null);
  assert.equal(fitShortSide(3840, 2160, 2160), null);
  const odd = fitShortSide(1001, 999, 720);
  assert.equal(odd.width % 2, 0);
  assert.equal(odd.height % 2, 0);
  assert.throws(() => fitShortSide(undefined, undefined, 720), /分辨率/);
});

test('watermark box sits inside the frame, bottom-right', () => {
  for (const [w, h] of [[1280, 720], [720, 1280], [720, 720], [320, 180], [3840, 2160]]) {
    const box = watermarkBox(w, h);
    assert.ok(box.x >= 0 && box.y >= 0, `${w}x${h}`);
    assert.ok(box.x + box.width <= w && box.y + box.height <= h, `${w}x${h}`);
    assert.ok(box.x > w / 2 && box.y > h / 2, `${w}x${h} bottom-right`);
  }
});

test('cut filter: plan limits are appended after concat', () => {
  const ranges = [{ start: 0, end: 1 }, { start: 2, end: 3 }];
  const plain = buildCutFilter(ranges, { hasVideo: true, hasAudio: true });
  assert.match(plain, /concat=n=2:v=1:a=1\[outv\]\[outa\]/);
  assert.doesNotMatch(plain, /overlay|scale=/);

  const free = buildCutFilter(ranges, { hasVideo: true, hasAudio: true }, {
    scale: { width: 1280, height: 720 },
    watermark: { width: 332, height: 42, x: 926, y: 656 },
  });
  assert.match(free, /concat=n=2:v=1:a=1\[catv\]\[outa\]/);
  assert.match(free, /\[catv\]scale=1280:720:flags=lanczos,setsar=1\[scaledv\]/);
  assert.match(free, /\[1:v\]scale=332:42,format=rgba\[wm\]/);
  assert.match(free, /\[scaledv\]\[wm\]overlay=x=926:y=656:format=auto\[outv\]/);

  const watermarkOnly = buildCutFilter(ranges, { hasVideo: true, hasAudio: false }, { watermark: { width: 160, height: 20, x: 150, y: 155 } });
  assert.match(watermarkOnly, /\[catv\]null\[scaledv\]/);

  // Audio-only sources have nothing to scale or mark.
  const audioOnly = buildCutFilter(ranges, { hasVideo: false, hasAudio: true }, { scale: { width: 2, height: 2 }, watermark: { width: 2, height: 2, x: 0, y: 0 } });
  assert.doesNotMatch(audioOnly, /catv|overlay/);
});
