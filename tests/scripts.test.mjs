import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeOpenAi, parseSilences, speechFromSilences } from '../scripts/lib/asr.mjs';
import { buildCutFilter, normalizeRanges } from '../scripts/lib/cut-filter.mjs';

test('normalizeRanges clamps, sorts, merges and validates', () => {
  assert.deepEqual(
    normalizeRanges(
      [
        { start: 5, end: 12 },
        { start: -1, end: 2 },
        { start: 1.5, end: 3 },
        { start: 4, end: 4.01 },
      ],
      10,
    ),
    [
      { start: 0, end: 3 },
      { start: 5, end: 10 },
    ],
  );
  assert.throws(() => normalizeRanges([{ start: 'a', end: 1 }], 10));
  assert.throws(() => normalizeRanges({}, 10));
});

test('buildCutFilter emits split/trim/concat for each stream', () => {
  const filter = buildCutFilter(
    [
      { start: 0, end: 1.5 },
      { start: 3, end: 4 },
    ],
    { hasVideo: true, hasAudio: true },
  );
  assert.match(filter, /\[0:v\]split=2\[vs0\]\[vs1\]/);
  assert.match(filter, /\[vs1\]trim=start=3:end=4,setpts=PTS-STARTPTS\[v1\]/);
  assert.match(filter, /\[v0\]\[a0\]\[v1\]\[a1\]concat=n=2:v=1:a=1\[outv\]\[outa\]/);
  const audioOnly = buildCutFilter([{ start: 0, end: 1 }], { hasVideo: false, hasAudio: true });
  assert.doesNotMatch(audioOnly, /0:v/);
  assert.match(audioOnly, /concat=n=1:v=0:a=1\[outa\]/);
});

test('silencedetect output becomes speech segments', () => {
  const stderr = [
    '[silencedetect @ 0x1] silence_start: 2.01',
    '[silencedetect @ 0x1] silence_end: 3.0 | silence_duration: 0.99',
    '[silencedetect @ 0x1] silence_start: 5',
  ].join('\n');
  const silences = parseSilences(stderr, 6);
  assert.deepEqual(silences, [
    { start: 2.01, end: 3 },
    { start: 5, end: 6 },
  ]);
  assert.deepEqual(speechFromSilences(silences, 6), [
    { start: 0, end: 2.01 },
    { start: 3, end: 5 },
  ]);
  assert.equal(speechFromSilences([], 30, 12).length, 3);
});

test('OpenAI verbose_json words are attached to their segments', () => {
  const transcript = normalizeOpenAi(
    {
      language: 'zh',
      duration: 4,
      segments: [
        { start: 0, end: 2, text: ' 你好 世界 ' },
        { start: 2, end: 4, text: '再见' },
      ],
      words: [
        { word: '你好', start: 0, end: 0.8 },
        { word: '世界', start: 0.9, end: 1.9 },
        { word: '再见', start: 2.2, end: 3.5 },
      ],
    },
    4,
  );
  assert.equal(transcript.segments.length, 2);
  assert.equal(transcript.segments[0].text, '你好 世界');
  assert.deepEqual(
    transcript.segments.map((segment) => segment.words.map((word) => word.text)),
    [['你好', '世界'], ['再见']],
  );
});
