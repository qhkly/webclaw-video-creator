import type { WordToken } from '../../src/types';

export interface CaptionGroup {
  words: WordToken[];
  startMs: number;
  endMs: number;
}

export interface CaptionContext {
  group: CaptionGroup;
  activeIndex: number;
}

const DEFAULT_MAX_UNITS = 16;
const DEFAULT_GAP_MS = 650;

export function buildCaptionGroups(
  words: WordToken[] | undefined,
  maxUnits = DEFAULT_MAX_UNITS,
  gapMs = DEFAULT_GAP_MS,
): CaptionGroup[] {
  const clean = (words ?? []).filter((word) => word && String(word.text ?? '').trim());
  if (clean.length === 0) {
    return [];
  }

  const groups: CaptionGroup[] = [];
  let current: WordToken[] = [];
  let units = 0;

  const flush = () => {
    if (current.length === 0) return;
    const first = current[0];
    const last = current[current.length - 1];
    groups.push({
      words: current,
      startMs: first.startMs,
      endMs: last.startMs + Math.max(80, last.durationMs),
    });
    current = [];
    units = 0;
  };

  for (const word of clean) {
    const previous = current[current.length - 1];
    const gap = previous ? word.startMs - (previous.startMs + Math.max(80, previous.durationMs)) : 0;
    const separatorUnits = previous && needsSpace(previous.text, word.text) ? 0.45 : 0;
    const nextUnits = tokenUnits(word.text) + separatorUnits;
    const wouldOverflow = current.length > 0 && units + nextUnits > maxUnits;
    const longPause = current.length > 0 && gap > gapMs;

    if (wouldOverflow || longPause) {
      flush();
    }

    const newPrevious = current[current.length - 1];
    units += tokenUnits(word.text) + (newPrevious && needsSpace(newPrevious.text, word.text) ? 0.45 : 0);
    current.push(word);
  }
  flush();
  return groups;
}

export function findCaptionContext(words: WordToken[] | undefined, currentMs: number): CaptionContext | undefined {
  const groups = buildCaptionGroups(words);
  if (groups.length === 0) return undefined;

  let wordIndex = -1;
  const clean = groups.flatMap((group) => group.words);
  for (let index = 0; index < clean.length; index += 1) {
    const word = clean[index];
    if (currentMs >= word.startMs) {
      wordIndex = index;
    } else {
      break;
    }
  }
  if (wordIndex < 0) return undefined;

  let consumed = 0;
  for (const group of groups) {
    const nextConsumed = consumed + group.words.length;
    if (wordIndex < nextConsumed) {
      const localIndex = wordIndex - consumed;
      const word = group.words[localIndex];
      const active =
        currentMs >= word.startMs &&
        currentMs <= word.startMs + Math.max(80, word.durationMs)
          ? localIndex
          : -1;
      // Do not leave stale text on screen throughout a long pause. A phrase
      // gets a short tail, then disappears until the next group starts.
      const visibleUntil = group.endMs + 300;
      if (currentMs <= visibleUntil) {
        return { group, activeIndex: active };
      }
      return undefined;
    }
    consumed = nextConsumed;
  }
  return undefined;
}

export function captionTokenText(previous: WordToken | undefined, current: WordToken): string {
  return `${previous && needsSpace(previous.text, current.text) ? ' ' : ''}${current.text}`;
}

export function needsSpace(left: string, right: string): boolean {
  const l = lastVisibleChar(left);
  const r = firstVisibleChar(right);
  if (!l || !r) return false;
  if (isClosingPunctuation(r) || isOpeningPunctuation(l)) return false;
  const leftHan = isHan(l);
  const rightHan = isHan(r);
  return !(leftHan && rightHan);
}

function tokenUnits(text: string): number {
  let units = 0;
  for (const char of Array.from(String(text ?? ''))) {
    if (/\s/u.test(char)) continue;
    if (isHan(char)) units += 1;
    else if (/[A-Za-z0-9]/u.test(char)) units += 0.55;
    else units += 0.5;
  }
  return Math.max(0.8, units);
}

function firstVisibleChar(text: string): string {
  return Array.from(String(text ?? '').trim())[0] ?? '';
}

function lastVisibleChar(text: string): string {
  const chars = Array.from(String(text ?? '').trim());
  return chars[chars.length - 1] ?? '';
}

function isHan(char: string): boolean {
  return /\p{Script=Han}/u.test(char);
}

function isOpeningPunctuation(char: string): boolean {
  return /[（(【［《“‘]/u.test(char);
}

function isClosingPunctuation(char: string): boolean {
  return /[，。！？；：、,.!?;:)）】］》”’]/u.test(char);
}
