import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildCaptionGroups, captionTokenText, findCaptionContext, needsSpace } from '../remotion/src/caption-groups.ts';

function words(tokens, step = 200) {
  return tokens.map((text, index) => ({ text, startMs: index * step, durationMs: step }));
}

test('Chinese single-character tokens are grouped into readable phrases', () => {
  const groups = buildCaptionGroups(words(Array.from('这是一次端到端真机测试')));
  assert.ok(groups.length >= 1);
  assert.ok(groups[0].words.length > 1);
  const rendered = groups[0].words.map((word, index) => captionTokenText(index ? groups[0].words[index - 1] : undefined, word)).join('');
  assert.match(rendered, /^这是一次/);
  assert.equal(rendered.includes('这 是 一 次'), false);
});

test('English and mixed Chinese/English spacing is readable', () => {
  assert.equal(needsSpace('ChatGPT', 'Video'), true);
  assert.equal(needsSpace('次', 'ChatGPT'), true);
  assert.equal(needsSpace('ChatGPT', '到'), true);
  assert.equal(needsSpace('端', '到'), false);

  const tokens = words(['这', '是', 'ChatGPT', '到', 'Video', 'Creator']);
  const group = buildCaptionGroups(tokens, 40)[0];
  const rendered = group.words
    .map((word, index) => captionTokenText(index ? group.words[index - 1] : undefined, word))
    .join('');
  assert.equal(rendered, '这是 ChatGPT 到 Video Creator');
});

test('caption groups split on width and long pauses', () => {
  const widthGroups = buildCaptionGroups(words(Array.from('这是一个足够长的中文字幕测试用于换组')), 6);
  assert.ok(widthGroups.length >= 2);

  const paused = [
    { text: '前', startMs: 0, durationMs: 200 },
    { text: '半', startMs: 200, durationMs: 200 },
    { text: '后', startMs: 1600, durationMs: 200 },
    { text: '半', startMs: 1800, durationMs: 200 },
  ];
  assert.equal(buildCaptionGroups(paused, 20, 650).length, 2);
  assert.equal(findCaptionContext(paused, 900), undefined, 'stale phrase should disappear during a long pause');
});

test('active word changes highlight index without changing the phrase group', () => {
  const tokens = words(['这', '是', 'ChatGPT', '测', '试'], 250);
  const first = findCaptionContext(tokens, 100);
  const third = findCaptionContext(tokens, 600);
  assert.ok(first);
  assert.ok(third);
  assert.deepEqual(first.group.words.map((word) => word.text), third.group.words.map((word) => word.text));
  assert.equal(first.activeIndex, 0);
  assert.equal(third.activeIndex, 2);
});
