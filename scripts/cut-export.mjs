#!/usr/bin/env node
// Export an edited cut: keep only the given source-time ranges and concatenate them with FFmpeg.
//
//   node scripts/cut-export.mjs --input in.mp4 --ranges '[{"start":0,"end":3.2},…]' --output out.mp4 [--maxHeight 2160 --watermark 0]
//
// `--ranges` accepts inline JSON or a path to a JSON file. Progress is emitted as JSON lines.
// Plan limits (scripts/lib/plan.mjs) default to the free plan: short side ≤ 720 px and the
// WebClaw Video Creator watermark burned into the video. The app passes Pro limits explicitly.
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildCutFilter, normalizeRanges } from './lib/cut-filter.mjs';
import { emit, fail, findFfmpeg, parseArgs, probeMedia, run } from './lib/media.mjs';
import { WATERMARK_ASSET, fitShortSide, limitsFromArgs, watermarkBox } from './lib/plan.mjs';

const WATERMARK_PATH = join(dirname(fileURLToPath(import.meta.url)), 'assets', WATERMARK_ASSET.file);

const args = parseArgs(process.argv.slice(2));

try {
  const output = await exportCut();
  emit({ type: 'done', ...output });
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}

async function exportCut() {
  if (!args.input || !args.ranges || !args.output) {
    throw new Error('Missing --input, --ranges or --output');
  }
  const input = resolve(args.input);
  const output = resolve(args.output);
  if (!existsSync(input)) {
    throw new Error(`文件不存在：${input}`);
  }
  if (input === output) {
    throw new Error('输出文件不能覆盖源视频');
  }
  const rawRanges = JSON.parse(args.ranges.trim().startsWith('[') ? args.ranges : await readFile(args.ranges, 'utf8'));

  const ffmpeg = await findFfmpeg();
  const media = await probeMedia(ffmpeg, input);
  const ranges = normalizeRanges(rawRanges, media.duration);
  if (ranges.length === 0) {
    throw new Error('没有保留任何片段，无法导出');
  }
  if (!media.hasVideo && !media.hasAudio) {
    throw new Error('源文件没有可用的音视频流');
  }
  const outputDuration = ranges.reduce((total, range) => total + range.end - range.start, 0);

  const limits = limitsFromArgs(args);
  let scale = null;
  let watermark = null;
  let frame = null;
  if (media.hasVideo) {
    scale = fitShortSide(media.width, media.height, limits.maxExportHeight);
    frame = scale ?? { width: media.width, height: media.height };
    if (limits.watermark) {
      if (!existsSync(WATERMARK_PATH)) {
        throw new Error(`水印素材缺失：${WATERMARK_PATH}`);
      }
      watermark = watermarkBox(frame.width, frame.height);
    }
  }

  await mkdir(dirname(output), { recursive: true });
  const tempDir = await mkdtemp(join(tmpdir(), 'webclaw-cut-'));
  const filterPath = join(tempDir, 'filter.txt');
  await writeFile(filterPath, buildCutFilter(ranges, media, { scale, watermark }));
  emit({ type: 'progress', percent: 1, message: `开始导出 ${ranges.length} 个片段…` });

  const ext = extname(output).toLowerCase();
  const codecArgs =
    ext === '.webm'
      ? ['-c:v', 'libvpx-vp9', '-b:v', '0', '-crf', '32', '-c:a', 'libopus', '-b:a', '128k']
      : ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart'];
  const mapArgs = [...(media.hasVideo ? ['-map', '[outv]'] : []), ...(media.hasAudio ? ['-map', '[outa]'] : [])];

  try {
    const { code, stderr } = await run(
      ffmpeg,
      [
        '-y', '-hide_banner', '-nostats',
        '-i', input,
        // A single still frame: overlay repeats it for the whole video (eof_action=repeat).
        ...(watermark ? ['-i', WATERMARK_PATH] : []),
        '-filter_complex_script', filterPath,
        ...mapArgs, ...codecArgs,
        '-progress', 'pipe:1', output,
      ],
      {
        onStdoutLine: (line) => {
          const match = line.match(/^out_time_(?:us|ms)=(\d+)/);
          if (match && outputDuration > 0) {
            const seconds = Number(match[1]) / 1_000_000;
            const percent = Math.min(99, Math.max(1, Math.round((seconds / outputDuration) * 100)));
            emit({ type: 'progress', percent, message: `FFmpeg 编码中：${percent}%` });
          }
        },
      },
    );
    if (code !== 0) {
      await rm(output, { force: true });
      throw new Error(`FFmpeg 导出失败：${stderr.trim().split('\n').slice(-6).join('\n')}`);
    }
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
  emit({ type: 'progress', percent: 100, message: '导出完成' });
  return {
    output,
    width: frame?.width ?? null,
    height: frame?.height ?? null,
    watermark: Boolean(watermark),
    maxExportHeight: limits.maxExportHeight,
  };
}
