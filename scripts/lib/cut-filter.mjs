// Pure helpers that turn keep-ranges into an FFmpeg trim/concat filtergraph.

/** Clamp to [0, duration], drop empty ranges, sort and merge overlaps. Throws on malformed input. */
export function normalizeRanges(ranges, duration) {
  if (!Array.isArray(ranges)) {
    throw new Error('ranges 必须是数组');
  }
  const limit = duration > 0 ? duration : Number.POSITIVE_INFINITY;
  const cleaned = ranges
    .map((range) => {
      const start = Number(range?.start);
      const end = Number(range?.end);
      if (!Number.isFinite(start) || !Number.isFinite(end)) {
        throw new Error(`无效的时间范围：${JSON.stringify(range)}`);
      }
      return { start: Math.max(0, start), end: Math.min(limit, end) };
    })
    .filter((range) => range.end - range.start >= 0.02)
    .sort((a, b) => a.start - b.start);
  const merged = [];
  for (const range of cleaned) {
    const last = merged[merged.length - 1];
    if (last && range.start <= last.end + 0.001) {
      last.end = Math.max(last.end, range.end);
    } else {
      merged.push({ ...range });
    }
  }
  return merged;
}

const ts = (value) => Number(value.toFixed(3)).toString();

/**
 * Build a filter_complex script producing [outv] and/or [outa].
 *
 * Plan limits act on the encoded video itself: `scale` ({width, height}) downsizes the
 * concatenated video, `watermark` ({width, height, x, y}) overlays input 1 (the watermark
 * PNG) on it. Both are null when the plan has no such limit.
 */
export function buildCutFilter(ranges, { hasVideo = true, hasAudio = true } = {}, { scale = null, watermark = null } = {}) {
  const count = ranges.length;
  const lines = [];
  if (hasVideo) {
    lines.push(count > 1 ? `[0:v]split=${count}${ranges.map((_, i) => `[vs${i}]`).join('')}` : '[0:v]null[vs0]');
  }
  if (hasAudio) {
    lines.push(count > 1 ? `[0:a]asplit=${count}${ranges.map((_, i) => `[as${i}]`).join('')}` : '[0:a]anull[as0]');
  }
  ranges.forEach((range, i) => {
    if (hasVideo) {
      lines.push(`[vs${i}]trim=start=${ts(range.start)}:end=${ts(range.end)},setpts=PTS-STARTPTS[v${i}]`);
    }
    if (hasAudio) {
      // Short fades hide clicks at cut points.
      const fade = Math.min(0.01, (range.end - range.start) / 4);
      const fadeOut = ts(Math.max(0, range.end - range.start - fade));
      lines.push(
        `[as${i}]atrim=start=${ts(range.start)}:end=${ts(range.end)},asetpts=PTS-STARTPTS,` +
          `afade=t=in:d=${ts(fade)},afade=t=out:st=${fadeOut}:d=${ts(fade)}[a${i}]`,
      );
    }
  });
  const inputs = ranges.map((_, i) => `${hasVideo ? `[v${i}]` : ''}${hasAudio ? `[a${i}]` : ''}`).join('');
  const post = hasVideo && (scale || watermark);
  const outputs = `${hasVideo ? (post ? '[catv]' : '[outv]') : ''}${hasAudio ? '[outa]' : ''}`;
  lines.push(`${inputs}concat=n=${count}:v=${hasVideo ? 1 : 0}:a=${hasAudio ? 1 : 0}${outputs}`);
  if (post) {
    const scaled = watermark ? '[scaledv]' : '[outv]';
    lines.push(scale ? `[catv]scale=${scale.width}:${scale.height}:flags=lanczos,setsar=1${scaled}` : `[catv]null${scaled}`);
    if (watermark) {
      lines.push(`[1:v]scale=${watermark.width}:${watermark.height},format=rgba[wm]`);
      lines.push(`[scaledv][wm]overlay=x=${watermark.x}:y=${watermark.y}:format=auto[outv]`);
    }
  }
  return `${lines.join(';\n')}\n`;
}
