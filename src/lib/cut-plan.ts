// Pure edit-decision logic for the text-based cutter.
// Kept dependency-free (no imports, no enums) so it runs under `node --test` via type stripping.

export interface TranscriptWord {
  id: string;
  text: string;
  start: number;
  end: number;
}

export interface TranscriptSegment {
  id: string;
  start: number;
  end: number;
  text: string;
  words?: TranscriptWord[];
}

export interface Transcript {
  provider: string;
  language?: string;
  duration: number;
  segments: TranscriptSegment[];
  warning?: string;
}

/** Who removed a unit: the user directly, or an AI suggestion (shown differently, undoable). */
export type CutSource = 'user' | 'ai';
export type CutMap = Record<string, CutSource>;

export interface TimelineUnit {
  id: string;
  kind: 'word' | 'segment' | 'gap';
  segmentId?: string;
  text: string;
  start: number;
  end: number;
}

export interface TimeRange {
  start: number;
  end: number;
}

export const MIN_GAP = 0.3;
export const GAP_PAD = 0.12;

const round = (value: number) => Math.round(value * 1000) / 1000;

/**
 * Partition [0, duration] into contiguous units: words (or whole segments when no words),
 * plus explicit gap units for pauses >= MIN_GAP. Small gaps are split between neighbours,
 * so the union of all units always equals the full source timeline.
 */
export function buildTimeline(transcript: Transcript, minGap = MIN_GAP): TimelineUnit[] {
  const duration = Math.max(0, transcript.duration);
  const speech: TimelineUnit[] = [];
  for (const segment of transcript.segments) {
    if (segment.words && segment.words.length > 0) {
      for (const word of segment.words) {
        speech.push({ id: word.id, kind: 'word', segmentId: segment.id, text: word.text, start: word.start, end: word.end });
      }
    } else {
      speech.push({ id: segment.id, kind: 'segment', segmentId: segment.id, text: segment.text, start: segment.start, end: segment.end });
    }
  }
  speech.sort((a, b) => a.start - b.start);

  const units: TimelineUnit[] = [];
  let cursor = 0;
  for (let index = 0; index < speech.length; index += 1) {
    const unit = { ...speech[index] };
    unit.start = Math.min(Math.max(unit.start, cursor), duration);
    // ASR sometimes reports zero-length words; give them a sliver so they stay visible and cuttable.
    unit.end = Math.min(Math.max(unit.end, unit.start + 0.02), duration);
    const gap = unit.start - cursor;
    if (gap >= minGap) {
      units.push({ id: `gap-${round(cursor)}`, kind: 'gap', text: '', start: round(cursor), end: round(unit.start) });
    } else if (gap > 0) {
      const previous = units[units.length - 1];
      if (previous && previous.kind !== 'gap') {
        const middle = cursor + gap / 2;
        previous.end = round(middle);
        unit.start = middle;
      } else {
        unit.start = cursor;
      }
    }
    unit.start = round(unit.start);
    unit.end = round(unit.end);
    if (unit.end > unit.start) {
      units.push(unit);
      cursor = unit.end;
    }
  }
  if (duration - cursor >= minGap || (units.length === 0 && duration > 0)) {
    units.push({ id: `gap-${round(cursor)}`, kind: 'gap', text: '', start: round(cursor), end: round(duration) });
  } else if (duration > cursor && units.length > 0) {
    units[units.length - 1].end = round(duration);
  }
  return units;
}

/**
 * Turn cut decisions into source-time ranges to keep. Deleted pauses keep a short pad on
 * each side that touches kept speech, so cuts don't sound clipped.
 */
export function computeKeepRanges(units: TimelineUnit[], cuts: CutMap, pad = GAP_PAD): TimeRange[] {
  const raw: TimeRange[] = [];
  units.forEach((unit, index) => {
    if (!cuts[unit.id]) {
      raw.push({ start: unit.start, end: unit.end });
      return;
    }
    if (unit.kind !== 'gap' || unit.end - unit.start <= pad * 2) {
      return;
    }
    const previous = units[index - 1];
    const next = units[index + 1];
    if (previous && !cuts[previous.id]) {
      raw.push({ start: unit.start, end: unit.start + pad });
    }
    if (next && !cuts[next.id]) {
      raw.push({ start: unit.end - pad, end: unit.end });
    }
  });
  return mergeRanges(raw);
}

export function mergeRanges(ranges: TimeRange[], epsilon = 0.001): TimeRange[] {
  const sorted = ranges.filter((range) => range.end - range.start > epsilon).sort((a, b) => a.start - b.start);
  const merged: TimeRange[] = [];
  for (const range of sorted) {
    const last = merged[merged.length - 1];
    if (last && range.start <= last.end + epsilon) {
      last.end = Math.max(last.end, range.end);
    } else {
      merged.push({ start: range.start, end: range.end });
    }
  }
  return merged.map((range) => ({ start: round(range.start), end: round(range.end) }));
}

export function totalDuration(ranges: TimeRange[]) {
  return round(ranges.reduce((total, range) => total + (range.end - range.start), 0));
}

/** Map a source timestamp to the edited output timeline (null when it falls inside a cut). */
export function sourceToOutput(ranges: TimeRange[], time: number): number | null {
  let offset = 0;
  for (const range of ranges) {
    if (time < range.start) {
      return null;
    }
    if (time <= range.end) {
      return round(offset + time - range.start);
    }
    offset += range.end - range.start;
  }
  return null;
}

export function outputToSource(ranges: TimeRange[], time: number): number {
  let remaining = Math.max(0, time);
  for (const range of ranges) {
    const length = range.end - range.start;
    if (remaining <= length) {
      return round(range.start + remaining);
    }
    remaining -= length;
  }
  const last = ranges[ranges.length - 1];
  return last ? last.end : 0;
}

/**
 * Where the preview player should be for a given source time: the same time if it is kept,
 * the start of the next kept range if it lies in a cut, or null when past the last kept range.
 */
export function nextPlayableTime(ranges: TimeRange[], time: number, epsilon = 0.02): number | null {
  for (const range of ranges) {
    if (time < range.start - epsilon) {
      return range.start;
    }
    if (time < range.end - epsilon) {
      return time;
    }
  }
  return null;
}

const FILLERS = ['嗯', '啊', '呃', '额', '唔', '哦', '那个', '就是说', '然后呢', 'um', 'uh', 'erm', 'hmm', 'ah', 'er'];

function normalizeToken(text: string) {
  return text.toLowerCase().replace(/[\s，。！？、,.!?…~～"'“”]+/g, '');
}

/** AI-style suggestions: filler words/segments and long pauses. Returns unit ids to cut. */
export function suggestCuts(units: TimelineUnit[], options: { fillers?: boolean; pausesLongerThan?: number } = {}) {
  const ids: string[] = [];
  for (const unit of units) {
    if (unit.kind === 'gap') {
      if (options.pausesLongerThan !== undefined && unit.end - unit.start > options.pausesLongerThan) {
        ids.push(unit.id);
      }
    } else if (options.fillers) {
      const token = normalizeToken(unit.text);
      if (token && FILLERS.includes(token)) {
        ids.push(unit.id);
      }
    }
  }
  return ids;
}

/** Re-time words evenly across a segment after its text was edited. */
export function retimeWords(segment: TranscriptSegment, text: string): TranscriptWord[] | undefined {
  if (!segment.words || segment.words.length === 0) {
    return undefined;
  }
  const tokens = text.match(/[\p{Script=Han}]|[^\s\p{Script=Han}]+/gu) ?? [];
  if (tokens.length === 0) {
    return [];
  }
  const span = segment.end - segment.start;
  const weights = tokens.map((token) => Math.max(1, token.length));
  const weightTotal = weights.reduce((total, weight) => total + weight, 0);
  let cursor = segment.start;
  return tokens.map((token, index) => {
    const end = index === tokens.length - 1 ? segment.end : cursor + (weights[index] / weightTotal) * span;
    const word = { id: `${segment.id}-w${index}-${round(cursor)}`, text: token, start: round(cursor), end: round(end) };
    cursor = end;
    return word;
  });
}

export function formatTime(seconds: number) {
  const safe = Math.max(0, seconds);
  const minutes = Math.floor(safe / 60);
  const rest = safe - minutes * 60;
  return `${String(minutes).padStart(2, '0')}:${rest.toFixed(1).padStart(4, '0')}`;
}
