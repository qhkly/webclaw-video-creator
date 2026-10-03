#!/usr/bin/env node
// Transcription adapter for the text-based cutter.
//
// Providers (all return the same normalized transcript shape):
//   openai      OpenAI-compatible POST {baseUrl}/audio/transcriptions (OpenAI, Groq, SiliconFlow, local servers…)
//   whisper-cpp Local whisper.cpp CLI (`whisper-cli`) with a ggml model file
//   silence     Always-available fallback: FFmpeg silencedetect splits speech into editable placeholder segments
//   auto        openai if an API key is configured, else whisper-cpp if a model is configured, else silence;
//               a failing engine degrades to silence with a warning instead of failing the whole flow.
//
// Output: JSON lines on stdout — {type:"progress",percent,message} … then {type:"done",transcript}.
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { normalizeOpenAi, parseSilences, speechFromSilences } from './lib/asr.mjs';
import { emit, fail, findFfmpeg, parseArgs, probeMedia, run } from './lib/media.mjs';

const args = parseArgs(process.argv.slice(2));
if (!args.input) {
  fail('Missing --input');
}
const input = resolve(args.input);
const provider = args.provider || 'auto';
// The app passes options via env (they may contain an API key); --options remains for CLI use.
const options = JSON.parse(process.env.WEBCLAW_ASR_OPTIONS || args.options || '{}');
// Each run works in its own fresh subdirectory, which is the only thing removed afterwards.
const workRoot = resolve(args.workDir || join(tmpdir(), 'webclaw-video-creator'));
let workDir = workRoot;

try {
  const transcript = await transcribe();
  emit({ type: 'done', transcript });
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}

async function transcribe() {
  if (!existsSync(input)) {
    throw new Error(`文件不存在：${input}`);
  }
  const ffmpeg = await findFfmpeg();
  const media = await probeMedia(ffmpeg, input);
  if (!media.hasAudio) {
    throw new Error('该视频没有音轨，无法转写');
  }
  if (!media.duration) {
    throw new Error('无法读取视频时长');
  }
  await mkdir(workRoot, { recursive: true });
  workDir = await mkdtemp(join(workRoot, 'asr-'));
  emit({ type: 'progress', percent: 5, message: '读取媒体信息完成' });

  const chosen = resolveProvider(provider, options);
  try {
    if (chosen === 'openai') {
      return await transcribeOpenAi(ffmpeg, media);
    }
    if (chosen === 'whisper-cpp') {
      return await transcribeWhisperCpp(ffmpeg, media);
    }
    return await transcribeSilence(ffmpeg, media);
  } catch (error) {
    if (provider !== 'auto' || chosen === 'silence') {
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error);
    emit({ type: 'progress', percent: 50, message: `${chosen} 转写失败，降级为静音切分：${message}` });
    const transcript = await transcribeSilence(ffmpeg, media);
    transcript.warning = `${chosen} 转写失败，已降级为静音切分（文字需手动填写）：${message}`;
    return transcript;
  } finally {
    if (!args.keepWork && workDir !== workRoot) {
      await rm(workDir, { recursive: true, force: true });
    }
  }
}

function resolveProvider(name, opts) {
  if (name !== 'auto') {
    return name;
  }
  if (opts.apiKey && opts.baseUrl) {
    return 'openai';
  }
  if (opts.whisperModel && existsSync(opts.whisperModel)) {
    return 'whisper-cpp';
  }
  return 'silence';
}

async function extractAudio(ffmpeg, output, codecArgs) {
  const { code, stderr } = await run(ffmpeg, ['-y', '-hide_banner', '-i', input, '-vn', '-ac', '1', '-ar', '16000', ...codecArgs, output]);
  if (code !== 0) {
    throw new Error(`提取音频失败：${lastLines(stderr)}`);
  }
  return output;
}

async function transcribeOpenAi(ffmpeg, media) {
  const baseUrl = String(options.baseUrl || '').replace(/\/+$/, '');
  if (!baseUrl || !options.apiKey) {
    throw new Error('OpenAI 兼容转写需要 Base URL 和 API Key');
  }
  emit({ type: 'progress', percent: 10, message: '提取音频…' });
  const audio = await extractAudio(ffmpeg, join(workDir, 'audio.mp3'), ['-c:a', 'libmp3lame', '-b:a', '48k']);
  const form = new FormData();
  form.append('file', new Blob([await readFile(audio)], { type: 'audio/mpeg' }), 'audio.mp3');
  form.append('model', options.model || 'whisper-1');
  form.append('response_format', 'verbose_json');
  form.append('timestamp_granularities[]', 'segment');
  form.append('timestamp_granularities[]', 'word');
  if (options.language) {
    form.append('language', options.language);
  }
  emit({ type: 'progress', percent: 30, message: '上传并等待转写结果…' });
  const response = await fetch(`${baseUrl}/audio/transcriptions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${options.apiKey}` },
    body: form,
  });
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`转写接口返回 ${response.status}：${body.slice(0, 300)}`);
  }
  let data;
  try {
    data = JSON.parse(body);
  } catch {
    throw new Error('转写接口未返回 verbose_json');
  }
  emit({ type: 'progress', percent: 95, message: '整理时间戳…' });
  return normalizeOpenAi(data, media.duration);
}

async function transcribeWhisperCpp(ffmpeg, media) {
  const model = options.whisperModel;
  if (!model || !existsSync(model)) {
    throw new Error('whisper.cpp 需要有效的模型文件路径（ggml-*.bin）');
  }
  const bin = options.whisperBin || process.env.WHISPER_CPP_BIN || 'whisper-cli';
  emit({ type: 'progress', percent: 10, message: '提取音频…' });
  const wav = await extractAudio(ffmpeg, join(workDir, 'audio.wav'), ['-c:a', 'pcm_s16le']);
  const outputBase = join(workDir, 'whisper');
  emit({ type: 'progress', percent: 20, message: 'whisper.cpp 转写中…' });
  const { code, stderr } = await run(bin, ['-m', model, '-f', wav, '-l', options.language || 'auto', '-oj', '-of', outputBase], {
    onStderrLine: (line) => {
      const match = line.match(/progress\s*=\s*(\d+)%/);
      if (match) {
        emit({ type: 'progress', percent: 20 + Math.round(Number(match[1]) * 0.75), message: 'whisper.cpp 转写中…' });
      }
    },
  });
  if (code !== 0) {
    throw new Error(`whisper.cpp 失败：${lastLines(stderr)}`);
  }
  const data = JSON.parse(await readFile(`${outputBase}.json`, 'utf8'));
  const segments = (data.transcription || [])
    .map((item, index) => ({
      id: `s${index}`,
      start: Number(item.offsets?.from ?? 0) / 1000,
      end: Number(item.offsets?.to ?? 0) / 1000,
      text: String(item.text || '').trim(),
    }))
    .filter((segment) => segment.text);
  return { provider: 'whisper-cpp', language: data.result?.language, duration: media.duration, segments };
}

async function transcribeSilence(ffmpeg, media) {
  const noise = options.silenceNoise || '-32dB';
  const minSilence = Number(options.minSilence || 0.4);
  emit({ type: 'progress', percent: 15, message: '检测静音区间…' });
  const { code, stderr } = await run(ffmpeg, [
    '-hide_banner', '-nostats', '-i', input, '-vn', '-af', `silencedetect=noise=${noise}:d=${minSilence}`, '-f', 'null', '-',
  ]);
  if (code !== 0) {
    throw new Error(`静音检测失败：${lastLines(stderr)}`);
  }
  const silences = parseSilences(stderr, media.duration);
  const segments = speechFromSilences(silences, media.duration).map((range, index) => ({
    id: `s${index}`,
    start: range.start,
    end: range.end,
    text: `[语音片段 ${index + 1}]`,
  }));
  return {
    provider: 'silence',
    duration: media.duration,
    segments,
    warning: options.quiet ? undefined : '未配置语音识别引擎：已按停顿切分为语音片段，可直接按片段剪辑，或点击文字手动填写。',
  };
}

function lastLines(text, count = 4) {
  return text.trim().split('\n').slice(-count).join('\n') || basename(input);
}
