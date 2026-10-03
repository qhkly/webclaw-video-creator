import { access, constants } from 'node:fs/promises';
import { spawn } from 'node:child_process';

/** Resolve an ffmpeg binary: FFMPEG_PATH env, then ffmpeg-static, then `ffmpeg` on PATH. */
export async function findFfmpeg() {
  const candidates = [];
  if (process.env.FFMPEG_PATH) {
    candidates.push(process.env.FFMPEG_PATH);
  }
  try {
    const bundled = (await import('ffmpeg-static')).default;
    if (bundled) {
      candidates.push(bundled);
    }
  } catch {
    // ffmpeg-static not installed; fall through to PATH.
  }
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // try next
    }
  }
  return 'ffmpeg';
}

/** Run a process, collecting stdout/stderr. `onStderrLine` receives each stderr line as it arrives. */
export function run(command, args, { onStdoutLine, onStderrLine } = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    let child;
    try {
      child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      rejectPromise(error);
      return;
    }
    let stdout = '';
    let stderr = '';
    const lineSplitter = (callback, append) => {
      let buffer = '';
      return (chunk) => {
        const text = chunk.toString();
        append(text);
        if (!callback) {
          return;
        }
        buffer += text;
        const lines = buffer.split(/\r?\n|\r/);
        buffer = lines.pop() ?? '';
        lines.forEach(callback);
      };
    };
    child.stdout.on('data', lineSplitter(onStdoutLine, (text) => (stdout += text)));
    child.stderr.on('data', lineSplitter(onStderrLine, (text) => (stderr += text)));
    child.on('error', (error) => rejectPromise(new Error(`无法启动 ${command}: ${error.message}`)));
    child.on('close', (code) => resolvePromise({ code, stdout, stderr }));
  });
}

/** Probe duration and stream presence by parsing `ffmpeg -i` output (ffmpeg-static ships no ffprobe). */
export async function probeMedia(ffmpeg, input) {
  const { stderr } = await run(ffmpeg, ['-hide_banner', '-i', input]);
  if (/No such file or directory|Invalid data found/i.test(stderr)) {
    throw new Error(`无法读取媒体文件：${input}`);
  }
  const match = stderr.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  const duration = match ? Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) : 0;
  const videoLine = stderr.split('\n').find((line) => /Stream #.*Video:/.test(line) && !/attached pic/.test(line));
  const size = videoLine?.match(/,\s(\d{2,5})x(\d{2,5})[\s,\[]/);
  return {
    duration,
    hasVideo: Boolean(videoLine),
    hasAudio: /Stream #.*Audio:/.test(stderr),
    width: size ? Number(size[1]) : undefined,
    height: size ? Number(size[2]) : undefined,
  };
}

export function emit(payload) {
  console.log(JSON.stringify(payload));
}

export function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item.startsWith('--')) {
      parsed[item.slice(2)] = argv[index + 1];
      index += 1;
    }
  }
  return parsed;
}

export function fail(message) {
  console.error(JSON.stringify({ error: message }));
  process.exit(1);
}
