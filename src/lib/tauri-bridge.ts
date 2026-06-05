import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type {
  Aspect,
  CreatorSettings,
  FetchAssetsResult,
  Format,
  RenderProgress,
  Resolution,
  TtsResult,
  VideoScene,
  VoiceEngine,
} from '../types';

export function generateTts(input: {
  text: string;
  voice: string;
  output: string;
  engine: VoiceEngine;
}) {
  return invoke<TtsResult>('generate_tts', input);
}

export function fetchAssets(input: {
  query: string;
  count: number;
  orientation: 'landscape' | 'portrait' | 'square';
  apiKey: string;
  projectDir?: string;
}) {
  return invoke<FetchAssetsResult>('fetch_assets', input);
}

export function getSettings() {
  return invoke<CreatorSettings>('get_settings');
}

export function saveSettings(input: { settings: CreatorSettings }) {
  return invoke<CreatorSettings>('save_settings', input);
}

export function renderVideo(input: {
  scenesJson: string;
  outputDir: string;
  aspect: Aspect;
  resolution: Resolution;
  format: Format;
  captionsJson?: string;
}) {
  return invoke<string>('render_video', input);
}

export function combineAudioVideo(input: {
  videoPath: string;
  audioSegments: Array<{ path: string; start_time: number }>;
  outputPath: string;
}) {
  return invoke<string>('combine_audio_video', input);
}

export function saveScenes(input: { scenes: VideoScene[]; outputDir: string }) {
  return invoke<string>('save_scenes_json', input);
}

export function onRenderProgress(callback: (progress: RenderProgress) => void) {
  return listen<RenderProgress>('render_progress', (event) => callback(event.payload));
}
