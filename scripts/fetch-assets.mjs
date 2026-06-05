#!/usr/bin/env node
import { access, mkdir, writeFile } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { basename, extname, join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';

const args = parseArgs(process.argv.slice(2));
const query = (args.query || '').trim();
const count = Math.max(1, Math.min(12, Number(args.count || 6)));
const orientation = args.orientation || 'landscape';
const apiKey = args.apiKey || process.env.PEXELS_API_KEY || '';
const projectDir = resolve(args.projectDir || '.video-work/assets');

if (!query) {
  fail('Missing --query');
}
if (!apiKey) {
  fail('Missing Pexels API key');
}

await mkdir(projectDir, { recursive: true });

const [videos, photos] = await Promise.all([
  searchPexels('videos/search'),
  searchPexels('v1/search'),
]);

const candidates = [];
for (const video of videos.videos ?? []) {
  const file = pickVideoFile(video.video_files ?? []);
  if (!file?.link || candidates.length >= count) {
    continue;
  }
  const localPath = await download(file.link, 'video', video.id);
  candidates.push({
    type: 'video',
    localPath,
    thumb: video.image,
    duration: video.duration,
    w: file.width,
    h: file.height,
  });
}

for (const photo of photos.photos ?? []) {
  const link = photo.src?.large2x || photo.src?.large || photo.src?.original;
  if (!link || candidates.length >= count) {
    continue;
  }
  const localPath = await download(link, 'image', photo.id);
  candidates.push({
    type: 'image',
    localPath,
    thumb: photo.src?.tiny || photo.src?.medium,
    w: photo.width,
    h: photo.height,
  });
}

console.log(JSON.stringify({ query, candidates }));

async function searchPexels(path) {
  const url = new URL(`https://api.pexels.com/${path}`);
  url.searchParams.set('query', query);
  url.searchParams.set('per_page', String(count));
  url.searchParams.set('orientation', orientation);
  const response = await fetch(url, {
    headers: { Authorization: apiKey },
  });
  if (!response.ok) {
    fail(`Pexels ${path} returned ${response.status}`);
  }
  return response.json();
}

function pickVideoFile(files) {
  const compatible = files
    .filter((file) => file.link && (file.file_type || '').includes('mp4'))
    .sort((a, b) => scoreVideo(b) - scoreVideo(a));
  return compatible[0];
}

function scoreVideo(file) {
  const width = Number(file.width || 0);
  const height = Number(file.height || 0);
  const pixels = width * height;
  const aspectScore =
    orientation === 'portrait'
      ? height >= width
        ? 100000000
        : 0
      : orientation === 'square'
        ? Math.max(0, 100000000 - Math.abs(width - height) * 10000)
        : width >= height
          ? 100000000
          : 0;
  return aspectScore + Math.min(pixels, 1920 * 1080);
}

async function download(url, kind, id) {
  const ext = cleanExt(extname(new URL(url).pathname)) || (kind === 'video' ? '.mp4' : '.jpg');
  const fileName = `${slug(query)}-${id}${ext}`;
  const localPath = join(projectDir, kind === 'video' ? 'videos' : 'images', fileName);
  try {
    await access(localPath);
    return localPath;
  } catch {
    await mkdir(join(projectDir, kind === 'video' ? 'videos' : 'images'), { recursive: true });
  }
  const response = await fetch(url);
  if (!response.ok || !response.body) {
    fail(`Failed to download ${basename(localPath)}: ${response.status}`);
  }
  await pipeline(response.body, createWriteStream(localPath));
  return localPath;
}

function cleanExt(ext) {
  const lowered = ext.toLowerCase();
  return ['.mp4', '.mov', '.jpg', '.jpeg', '.png', '.webp'].includes(lowered) ? lowered : '';
}

function slug(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'asset';
}

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
