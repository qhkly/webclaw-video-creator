#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { findFfmpeg, probeMedia, run } from './lib/media.mjs';
import { normalizeNarration } from './lib/tts-audio.mjs';

const args = parseArgs(process.argv.slice(2));
const text = args.text || '';
const voice = args.voice || 'zh-CN-YunxiNeural';
const output = resolve(args.output || 'scene.mp3');
const engine = args.engine || 'edge';
let edgeWords = [];

if (!text.trim()) {
  fail('Missing --text');
}

await mkdir(dirname(output), { recursive: true });

if (engine === 'f5') {
  await synthesizeWithF5({ text, voice, output });
} else {
  await synthesizeWithEdge({ text, voice, output }).catch(async (error) => {
    console.error(JSON.stringify({ warning: `primary Edge TTS failed: ${error.message}` }));
    await synthesizeWithNodeEdge({ text, voice, output });
  });
}

const ffmpeg = await findFfmpeg();
const normalized = await normalizeNarration(ffmpeg, output, run);
if (!normalized.normalized && normalized.warning) {
  console.error(JSON.stringify({ warning: `loudness normalization skipped: ${normalized.warning}` }));
}
const probed = await probeMedia(ffmpeg, output).catch(() => ({ duration: 0 }));
const duration = probed.duration > 0 ? probed.duration : Math.max(2, text.length / 8);
const words = edgeWords.length > 0 ? normalizeEdgeWords(edgeWords, duration) : estimateWords(text, duration);
const wordsPath = output.replace(/\.[^.]+$/, '.words.json');
await writeFile(wordsPath, JSON.stringify(words, null, 2));
console.log(JSON.stringify({ output, duration, wordsPath, words, normalizedLoudness: normalized.normalized }));

async function synthesizeWithEdge({ text, voice, output }) {
  const { Communicate } = await import('@duyquangnvx/edge-tts');
  const communicate = new Communicate(text, {
    voice,
    rate: '+0%',
    volume: '+0%',
    pitch: '+0Hz',
    boundary: 'WordBoundary',
  });
  const chunks = [];
  for await (const chunk of communicate.stream()) {
    if (chunk.type === 'audio' && chunk.data) {
      chunks.push(Buffer.from(chunk.data));
    } else if (chunk.type === 'WordBoundary' && chunk.text) {
      edgeWords.push({
        text: String(chunk.text),
        startMs: ticksToMs(chunk.offset ?? 0),
        durationMs: ticksToMs(chunk.duration ?? 0),
      });
    }
  }
  await communicate.close?.();
  if (chunks.length === 0) {
    fail('Edge TTS returned no audio');
  }
  await writeFile(output, Buffer.concat(chunks));
}

async function synthesizeWithF5({ text, voice, output }) {
  const response = await fetch('http://127.0.0.1:9880/tts', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text, voice }),
  });
  if (!response.ok) {
    fail(`F5-TTS server returned ${response.status}`);
  }
  await writeFile(output, Buffer.from(await response.arrayBuffer()));
}

async function synthesizeWithNodeEdge({ text, voice, output }) {
  edgeWords = [];
  const { EdgeTTS } = await import('node-edge-tts');
  const lang = voice.split('-').slice(0, 2).join('-') || 'zh-CN';
  const tts = new EdgeTTS({
    voice,
    lang,
    outputFormat: 'audio-24khz-48kbitrate-mono-mp3',
    timeout: 20000,
  });
  await tts.ttsPromise(text, output);
}

function normalizeEdgeWords(words, duration) {
  const maxDurationMs = duration * 1000;
  return words
    .map((word, index) => {
      const next = words[index + 1];
      const durationMs = word.durationMs > 0 ? word.durationMs : Math.max(80, (next?.startMs ?? maxDurationMs) - word.startMs);
      return {
        text: word.text,
        startMs: clamp(Math.round(word.startMs), 0, maxDurationMs),
        durationMs: clamp(Math.round(durationMs), 80, maxDurationMs),
      };
    })
    .filter((word) => word.text.trim() && word.startMs < maxDurationMs);
}

function estimateWords(text, duration) {
  const tokens = tokenize(text);
  if (tokens.length === 0) {
    return [];
  }
  const totalMs = duration * 1000;
  const weightTotal = tokens.reduce((total, token) => total + Math.max(1, token.length), 0);
  let cursor = 0;
  return tokens.map((token, index) => {
    const isLast = index === tokens.length - 1;
    const durationMs = isLast ? totalMs - cursor : Math.max(120, (Math.max(1, token.length) / weightTotal) * totalMs);
    const word = {
      text: token,
      startMs: Math.round(cursor),
      durationMs: Math.round(durationMs),
    };
    cursor += durationMs;
    return word;
  });
}

function tokenize(text) {
  const matches = text.match(/[\p{Script=Han}]|[A-Za-z0-9]+(?:[-'][A-Za-z0-9]+)?/gu);
  return matches ?? [];
}

function ticksToMs(value) {
  return Number(value || 0) / 10000;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
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
