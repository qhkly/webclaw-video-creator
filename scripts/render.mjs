#!/usr/bin/env node
import { mkdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { bundle } from '@remotion/bundler';
import { getCompositions, renderMedia } from '@remotion/renderer';

const args = parseArgs(process.argv.slice(2));
const scenesPath = resolve(args.scenes || '');
const outputDir = resolve(args.outputDir || 'dist-video');
const output = resolve(args.output || `${outputDir}/raw_video.mp4`);

if (!args.scenes) {
  fail('Missing --scenes');
}

await mkdir(outputDir, { recursive: true });
const scenes = JSON.parse(await readFile(scenesPath, 'utf8'));
const entryPoint = resolve('remotion/src/index.ts');
const serveUrl = await bundle({ entryPoint });
const compositions = await getCompositions(serveUrl, { inputProps: { scenes } });
const composition = compositions.find((item) => item.id === 'WebClawVideo');

if (!composition) {
  fail('Composition WebClawVideo not found');
}

await renderMedia({
  composition,
  serveUrl,
  codec: 'h264',
  outputLocation: output,
  inputProps: { scenes },
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
