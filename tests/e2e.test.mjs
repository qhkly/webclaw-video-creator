// End-to-end: real FFmpeg → transcribe sidecar → cut plan → export sidecar.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { buildTimeline, computeKeepRanges, totalDuration } from '../src/lib/cut-plan.ts';
import { findFfmpeg, probeMedia, run } from '../scripts/lib/media.mjs';

let dir;
let ffmpeg;
let video;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'webclaw-cutter-'));
  ffmpeg = await findFfmpeg();
  video = join(dir, 'source.mp4');
  // 8s clip: tone 0-2s, silence 2-3.5s, tone 3.5-5s, silence 5-6s, tone 6-8s.
  const tone = "if(between(t,0,2)+between(t,3.5,5)+between(t,6,8),0.5*sin(440*2*PI*t),0)";
  const { code, stderr } = await run(ffmpeg, [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=25:duration=8',
    '-f', 'lavfi', '-i', `aevalsrc='${tone}':s=16000:d=8`,
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', video,
  ]);
  assert.equal(code, 0, stderr);
});

after(async () => {
  await rm(dir, { recursive: true, force: true });
});

function sidecar(script, args, env = {}) {
  const previous = { ...process.env };
  Object.assign(process.env, env);
  const pending = run(process.execPath, [join('scripts', script), ...args]);
  process.env = previous;
  return pending.then(({ code, stdout, stderr }) => {
    const lines = stdout.split('\n').filter(Boolean).map((line) => JSON.parse(line));
    return { code, stderr, lines, done: lines.find((line) => line.type === 'done') };
  });
}

test('silence fallback → cut middle segment → export shorter MP4', async () => {
  const transcribed = await sidecar('transcribe.mjs', ['--input', video, '--provider', 'auto', '--options', '{}', '--workDir', dir]);
  assert.equal(transcribed.code, 0, transcribed.stderr);
  const transcript = transcribed.done.transcript;
  assert.equal(transcript.provider, 'silence');
  assert.equal(transcript.segments.length, 3);
  assert.ok(existsSync(video), 'source video must survive transcription');
  assert.deepEqual((await readdir(dir)).filter((name) => name.startsWith('asr-')), [], 'per-run work dir is cleaned up');

  const units = buildTimeline(transcript);
  const middle = transcript.segments[1].id;
  const ranges = computeKeepRanges(units, { [middle]: 'user' });
  const expected = totalDuration(ranges);
  assert.ok(expected > 5 && expected < 7, `expected ~6s, got ${expected}`);

  const output = join(dir, 'out.mp4');
  const exported = await sidecar('cut-export.mjs', ['--input', video, '--ranges', JSON.stringify(ranges), '--output', output]);
  assert.equal(exported.code, 0, exported.stderr);
  assert.equal(exported.done.output, output);
  assert.ok(exported.lines.some((line) => line.type === 'progress'));

  const media = await probeMedia(ffmpeg, output);
  assert.ok(media.hasVideo && media.hasAudio);
  assert.ok(Math.abs(media.duration - expected) < 0.15, `duration ${media.duration} vs ${expected}`);
});

test('export rejects empty ranges and overwriting the source', async () => {
  const empty = await sidecar('cut-export.mjs', ['--input', video, '--ranges', '[]', '--output', join(dir, 'x.mp4')]);
  assert.notEqual(empty.code, 0);
  assert.match(empty.stderr, /没有保留任何片段/);
  const overwrite = await sidecar('cut-export.mjs', ['--input', video, '--ranges', '[{"start":0,"end":1}]', '--output', video]);
  assert.notEqual(overwrite.code, 0);
});

test('OpenAI-compatible provider posts audio and normalizes verbose_json', async () => {
  let received = null;
  const server = createServer((request, response) => {
    let size = 0;
    request.on('data', (chunk) => (size += chunk.length));
    request.on('end', () => {
      received = { url: request.url, auth: request.headers.authorization, size };
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({
        language: 'en',
        duration: 8,
        segments: [{ start: 0, end: 2, text: 'hello world' }],
        words: [{ word: 'hello', start: 0, end: 0.9 }, { word: 'world', start: 1, end: 2 }],
      }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    const options = { baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'test-key', model: 'whisper-1' };
    // Same channel the Tauri command uses: options (with the API key) via env, not argv.
    const result = await sidecar('transcribe.mjs', ['--input', video, '--provider', 'openai', '--workDir', dir], {
      WEBCLAW_ASR_OPTIONS: JSON.stringify(options),
    });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(received.url, '/v1/audio/transcriptions');
    assert.equal(received.auth, 'Bearer test-key');
    assert.ok(received.size > 1000);
    assert.equal(result.done.transcript.provider, 'openai');
    assert.deepEqual(result.done.transcript.segments[0].words.map((word) => word.text), ['hello', 'world']);
  } finally {
    server.close();
  }
});

test('auto mode degrades to silence when the API fails', async () => {
  const options = { baseUrl: 'http://127.0.0.1:9/v1', apiKey: 'k' };
  const result = await sidecar('transcribe.mjs', ['--input', video, '--provider', 'auto', '--options', JSON.stringify(options), '--workDir', dir]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.done.transcript.provider, 'silence');
  assert.match(result.done.transcript.warning, /降级/);
});
