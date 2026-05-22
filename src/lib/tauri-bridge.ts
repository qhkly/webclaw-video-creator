import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { RenderProgress, VideoScene, VoiceEngine } from '../types';

export function generateTts(input: {
  text: string;
  voice: string;
  output: string;
  engine: VoiceEngine;
}) {
  return invoke<number>('generate_tts', input);
}

export function renderVideo(input: { scenesJson: string; outputDir: string }) {
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
