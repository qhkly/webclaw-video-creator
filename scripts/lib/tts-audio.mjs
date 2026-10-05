import { rename, rm, stat } from 'node:fs/promises';
import { extname } from 'node:path';

export const NARRATION_LOUDNORM = 'loudnorm=I=-16:LRA=7:TP=-1.5';

export function normalizedTempPath(output, suffix = `${process.pid}-${Date.now()}`) {
  const extension = extname(output) || '.mp3';
  return `${output.slice(0, output.length - extension.length)}.loudnorm-${suffix}.tmp${extension}`;
}

export function buildLoudnormArgs(input, output) {
  if (!input || !output || input === output) {
    throw new Error('loudness normalization requires distinct input/output paths');
  }
  return [
    '-y',
    '-hide_banner',
    '-loglevel',
    'error',
    '-i',
    input,
    '-af',
    NARRATION_LOUDNORM,
    '-c:a',
    'libmp3lame',
    '-b:a',
    '96k',
    output,
  ];
}

/**
 * Normalize narration through a temporary file and atomically replace only
 * after ffmpeg produced a non-empty result. On failure the original audio is
 * left untouched and the caller can safely continue with it.
 */
export async function normalizeNarration(ffmpeg, output, run) {
  const temporary = normalizedTempPath(output);
  try {
    const result = await run(ffmpeg, buildLoudnormArgs(output, temporary));
    if (result.code !== 0) {
      return { normalized: false, warning: result.stderr.trim().split('\n').slice(-3).join(' ') || `ffmpeg exited ${result.code}` };
    }
    const meta = await stat(temporary);
    if (meta.size < 256) {
      return { normalized: false, warning: 'ffmpeg produced an empty/invalid normalized audio file' };
    }
    await rename(temporary, output);
    return { normalized: true, warning: null };
  } catch (error) {
    return { normalized: false, warning: error instanceof Error ? error.message : String(error) };
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }
}
