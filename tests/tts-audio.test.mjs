import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { buildLoudnormArgs, NARRATION_LOUDNORM, normalizedTempPath, normalizeNarration } from '../scripts/lib/tts-audio.mjs';

test('loudnorm uses a distinct temporary output and targets narration loudness', () => {
  const input = '/tmp/voice.mp3';
  const temp = normalizedTempPath(input, 'test');
  assert.notEqual(input, temp);
  assert.match(temp, /\.loudnorm-test\.tmp\.mp3$/);
  const args = buildLoudnormArgs(input, temp);
  assert.deepEqual(args.slice(0, 6), ['-y', '-hide_banner', '-loglevel', 'error', '-i', input]);
  assert.ok(args.includes(NARRATION_LOUDNORM));
  assert.equal(NARRATION_LOUDNORM, 'loudnorm=I=-16:LRA=7:TP=-1.5');
  assert.throws(() => buildLoudnormArgs(input, input), /distinct/);
});

test('normalization failure preserves the original audio', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vc-tts-normalize-'));
  const output = join(dir, 'voice.mp3');
  await writeFile(output, 'ORIGINAL');
  const result = await normalizeNarration('/fake/ffmpeg', output, async () => ({ code: 1, stdout: '', stderr: 'boom' }));
  assert.equal(result.normalized, false);
  assert.equal(await readFile(output, 'utf8'), 'ORIGINAL');
});

test('normalization replaces original only after a non-empty temporary result', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vc-tts-normalize-ok-'));
  const output = join(dir, 'voice.mp3');
  await writeFile(output, 'ORIGINAL');
  const result = await normalizeNarration('/fake/ffmpeg', output, async (_command, args) => {
    const temporary = args.at(-1);
    await writeFile(temporary, Buffer.alloc(512, 7));
    return { code: 0, stdout: '', stderr: '' };
  });
  assert.equal(result.normalized, true);
  assert.equal((await readFile(output)).length, 512);
});
