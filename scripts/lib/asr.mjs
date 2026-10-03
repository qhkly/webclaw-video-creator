// Pure transcript helpers shared by scripts/transcribe.mjs and tests.

/** Normalize OpenAI-style verbose_json (segments + optional words) into the cutter transcript shape. */
export function normalizeOpenAi(data, duration) {
  const words = Array.isArray(data.words) ? data.words : [];
  const rawSegments = Array.isArray(data.segments) && data.segments.length > 0
    ? data.segments
    : [{ start: 0, end: data.duration || duration, text: data.text || '' }];
  const segments = rawSegments
    .map((segment, index) => {
      const start = Number(segment.start) || 0;
      const end = Math.max(start, Number(segment.end) || start);
      const id = `s${index}`;
      const segmentWords = words
        .filter((word) => {
          const middle = (Number(word.start) + Number(word.end)) / 2;
          return middle >= start && (middle < end || (index === rawSegments.length - 1 && middle <= end));
        })
        .map((word, wordIndex) => ({
          id: `${id}-w${wordIndex}`,
          text: String(word.word ?? word.text ?? '').trim(),
          start: Number(word.start),
          end: Math.max(Number(word.start), Number(word.end)),
        }))
        .filter((word) => word.text);
      return {
        id,
        start,
        end,
        text: String(segment.text || '').trim(),
        ...(segmentWords.length > 0 ? { words: segmentWords } : {}),
      };
    })
    .filter((segment) => segment.text || segment.words);
  return { provider: 'openai', language: data.language, duration: duration || Number(data.duration) || 0, segments };
}

export function parseSilences(stderr, duration) {
  const silences = [];
  let currentStart = null;
  for (const line of stderr.split('\n')) {
    const start = line.match(/silence_start:\s*(-?[\d.]+)/);
    const end = line.match(/silence_end:\s*([\d.]+)/);
    if (start) {
      currentStart = Math.max(0, Number(start[1]));
    } else if (end && currentStart !== null) {
      silences.push({ start: currentStart, end: Number(end[1]) });
      currentStart = null;
    }
  }
  if (currentStart !== null) {
    silences.push({ start: currentStart, end: duration });
  }
  return silences;
}

export function speechFromSilences(silences, duration, maxSegment = 12) {
  const speech = [];
  let cursor = 0;
  for (const silence of silences) {
    if (silence.start - cursor > 0.15) {
      speech.push({ start: cursor, end: silence.start });
    }
    cursor = Math.max(cursor, silence.end);
  }
  if (duration - cursor > 0.15) {
    speech.push({ start: cursor, end: duration });
  }
  // Long monologues without pauses are split so each piece stays easy to cut.
  return speech.flatMap((range) => {
    const length = range.end - range.start;
    const pieces = Math.max(1, Math.ceil(length / maxSegment));
    return Array.from({ length: pieces }, (_, index) => ({
      start: round(range.start + (length * index) / pieces),
      end: round(range.start + (length * (index + 1)) / pieces),
    }));
  });
}

function round(value) {
  return Math.round(value * 1000) / 1000;
}
