import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildTimeline,
  computeKeepRanges,
  nextPlayableTime,
  outputToSource,
  retimeWords,
  sourceToOutput,
  suggestCuts,
  totalDuration,
} from '../src/lib/cut-plan.ts';

const wordTranscript = {
  provider: 'test',
  duration: 10,
  segments: [
    {
      id: 's0',
      start: 0.5,
      end: 3,
      text: '大家好 嗯 今天',
      words: [
        { id: 'w0', text: '大家好', start: 0.5, end: 1.4 },
        { id: 'w1', text: '嗯', start: 1.5, end: 1.9 },
        { id: 'w2', text: '今天', start: 2.0, end: 3.0 },
      ],
    },
    { id: 's1', start: 5, end: 9, text: '演示产品' },
  ],
};

test('timeline partitions the whole source duration without overlap', () => {
  const units = buildTimeline(wordTranscript);
  assert.equal(units[0].start, 0);
  assert.equal(units.at(-1).end, 10);
  for (let i = 1; i < units.length; i += 1) {
    assert.equal(units[i].start, units[i - 1].end, `gap/overlap at ${units[i].id}`);
  }
  assert.deepEqual(
    units.map((unit) => unit.kind),
    ['gap', 'word', 'word', 'word', 'gap', 'segment', 'gap'],
  );
});

test('no cuts keeps the full video', () => {
  const units = buildTimeline(wordTranscript);
  assert.deepEqual(computeKeepRanges(units, {}), [{ start: 0, end: 10 }]);
});

test('cutting a word removes it and its share of the small surrounding gaps', () => {
  const units = buildTimeline(wordTranscript);
  const ranges = computeKeepRanges(units, { w1: 'user' });
  assert.deepEqual(ranges, [
    { start: 0, end: 1.45 },
    { start: 1.95, end: 10 },
  ]);
  assert.equal(totalDuration(ranges), 9.5);
});

test('cut pauses keep a short pad next to kept speech', () => {
  const units = buildTimeline(wordTranscript);
  const gapId = units.find((unit) => unit.kind === 'gap' && unit.start === 3).id;
  const ranges = computeKeepRanges(units, { [gapId]: 'ai' });
  assert.deepEqual(ranges, [
    { start: 0, end: 3.12 },
    { start: 4.88, end: 10 },
  ]);
});

test('adjacent cut units merge into one removed span', () => {
  const units = buildTimeline(wordTranscript);
  const gap = units.find((unit) => unit.kind === 'gap' && unit.start === 3);
  const cuts = { w2: 'user', [gap.id]: 'user', s1: 'user' };
  assert.deepEqual(computeKeepRanges(units, cuts), [
    { start: 0, end: 1.95 },
    { start: 9, end: 10 },
  ]);
});

test('source/output time mapping round-trips across cuts', () => {
  const ranges = [
    { start: 0, end: 2 },
    { start: 5, end: 8 },
  ];
  assert.equal(sourceToOutput(ranges, 1), 1);
  assert.equal(sourceToOutput(ranges, 3), null);
  assert.equal(sourceToOutput(ranges, 6), 3);
  assert.equal(outputToSource(ranges, 3), 6);
  assert.equal(outputToSource(ranges, 99), 8);
  assert.equal(nextPlayableTime(ranges, 1), 1);
  assert.equal(nextPlayableTime(ranges, 2.5), 5);
  assert.equal(nextPlayableTime(ranges, 8.5), null);
});

test('AI suggestions find filler words and long pauses only', () => {
  const units = buildTimeline(wordTranscript);
  assert.deepEqual(suggestCuts(units, { fillers: true }), ['w1']);
  const pauses = suggestCuts(units, { pausesLongerThan: 0.8 });
  assert.equal(pauses.length, 2);
  assert.ok(pauses.every((id) => id.startsWith('gap-')));
});

test('retiming edited text spreads new words across the segment', () => {
  const words = retimeWords(wordTranscript.segments[0], '大家好 今天');
  assert.equal(words.length, 5);
  assert.equal(words[0].start, 0.5);
  assert.equal(words.at(-1).end, 3);
  assert.equal(retimeWords(wordTranscript.segments[1], 'x'), undefined);
});

test('zero-length ASR words stay visible and cuttable', () => {
  const units = buildTimeline({
    provider: 'x',
    duration: 3,
    segments: [{ id: 's', start: 1, end: 2, text: 'a b', words: [{ id: 'a', text: 'a', start: 1, end: 1 }, { id: 'b', text: 'b', start: 1, end: 2 }] }],
  });
  assert.deepEqual(units.filter((unit) => unit.kind === 'word').map((unit) => unit.id), ['a', 'b']);
  assert.ok(totalDuration(computeKeepRanges(units, { a: 'user' })) < 3);
});

test('empty transcript still covers the media as one gap', () => {
  const units = buildTimeline({ provider: 'x', duration: 4, segments: [] });
  assert.deepEqual(computeKeepRanges(units, {}), [{ start: 0, end: 4 }]);
});
