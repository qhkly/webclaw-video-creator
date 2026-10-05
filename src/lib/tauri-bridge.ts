import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type {
  Aspect,
  CreatorSettings,
  CutterProgress,
  FetchAssetsResult,
  Format,
  RenderProgress,
  Resolution,
  TimeRange,
  Transcript,
  TtsResult,
  VideoScene,
  VoiceEngine,
} from '../types';

export function generateTts(input: {
  text: string;
  voice: string;
  output: string;
  engine: VoiceEngine;
  project?: string;
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

/** Grant the WebView asset-protocol access to one user-picked file; returns its canonical path. */
export function allowMediaPreview(videoPath: string) {
  return invoke<string>('allow_media_preview', { videoPath });
}

export function transcribeVideo(input: { videoPath: string; provider: string; options: Record<string, unknown> }) {
  return invoke<Transcript>('transcribe_video', {
    videoPath: input.videoPath,
    provider: input.provider,
    optionsJson: JSON.stringify(input.options),
  });
}

export function exportCut(input: { videoPath: string; ranges: TimeRange[]; outputPath: string }) {
  return invoke<string>('export_cut', {
    videoPath: input.videoPath,
    rangesJson: JSON.stringify(input.ranges),
    outputPath: input.outputPath,
  });
}

export function onCutterProgress(callback: (progress: CutterProgress) => void) {
  return listen<CutterProgress>('cutter_progress', (event) => callback(event.payload));
}

export function onRenderProgress(callback: (progress: RenderProgress) => void) {
  return listen<RenderProgress>('render_progress', (event) => callback(event.payload));
}
