#!/usr/bin/env node
import { mkdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { bundle } from '@remotion/bundler';
import { renderMedia, selectComposition } from '@remotion/renderer';

const RESOLUTION_SCALE = { '720p': 2 / 3, '1080p': 1, '4K': 2 };
const FORMAT_CODEC = { MP4: 'h264', MOV: 'prores', WebM: 'vp8' };
const FORMAT_EXT = { MP4: 'mp4', MOV: 'mov', WebM: 'webm' };

const args = parseArgs(process.argv.slice(2));
const scenesPath = resolve(args.scenes || '');
const outputDir = resolve(args.outputDir || 'dist-video');
const format = args.format || 'MP4';
const output = resolve(args.output || `${outputDir}/raw_video.${FORMAT_EXT[format] ?? 'mp4'}`);
const aspect = args.aspect || '16:9';
const resolution = args.resolution || '1080p';
const inputProps = { scenes: [], aspect };

if (!args.scenes) {
  fail('Missing --scenes');
}

await mkdir(outputDir, { recursive: true });
const scenes = JSON.parse(await readFile(scenesPath, 'utf8'));
inputProps.scenes = scenes;
const entryPoint = resolve('remotion/src/index.ts');
const serveUrl = await bundle({ entryPoint });
const composition = await selectComposition({
  serveUrl,
  id: 'WebClawVideo',
  inputProps,
});

if (!composition) {
  fail('Composition WebClawVideo not found');
}

await renderMedia({
  composition,
  serveUrl,
  codec: FORMAT_CODEC[format] ?? 'h264',
  outputLocation: output,
  inputProps,
  scale: RESOLUTION_SCALE[resolution] ?? 1,
  onProgress: ({ progress }) => {
    console.log(JSON.stringify({ type: 'progress', percent: Math.round(progress * 100) }));
  },
});

console.log(JSON.stringify({ type: 'done', output }));

function parseArgs(argv) {
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

function fail(message) {
  console.error(JSON.stringify({ error: message }));
  process.exit(1);
}
