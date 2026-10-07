import type { Aspect, Resolution } from './constants/aspect';

export type SceneTemplate = 'TitleSlide' | 'BulletPoints' | 'BigStat' | 'Quote' | 'CodeExplainer' | 'ImageFrame' | 'CTA';

export type VoiceEngine = 'edge' | 'f5';
export type { Aspect, Format, Resolution } from './constants/aspect';
export type { CutMap, CutSource, TimeRange, Transcript, TranscriptSegment, TranscriptWord } from './lib/cut-plan';

export interface AudioAsset {
  path: string;
  duration: number;
  wordsPath?: string;
}

export interface WordToken {
  text: string;
  startMs: number;
  durationMs: number;
}

export interface BackgroundAsset {
  kind: 'video' | 'image' | 'none';
  assetPath?: string;
  query?: string;
  fit?: 'cover';
  kenBurns?: boolean;
}

export interface AssetCandidate {
  type: 'video' | 'image';
  localPath: string;
  thumb?: string;
  duration?: number;
  w?: number;
  h?: number;
}

export interface FetchAssetsResult {
  query: string;
  candidates: AssetCandidate[];
}

export interface CaptionSettings {
  enabled: boolean;
  position: 'bottom' | 'middle';
  fontSize: number;
  activeColor: string;
  inactiveColor: string;
}

export type AsrProvider = 'auto' | 'openai' | 'whisper-cpp' | 'silence';

export interface AsrSettings {
  provider: AsrProvider;
  baseUrl: string;
  apiKey: string;
  model: string;
  language: string;
  whisperBin: string;
  whisperModel: string;
}

export interface CreatorSettings {
  pexelsApiKey: string;
  llm: {
    provider: string;
    baseUrl: string;
    model: string;
  };
  defaults: {
    voice: string;
    aspect: Aspect;
    resolution: Resolution;
  };
  captions: CaptionSettings;
  asr: AsrSettings;
}

export interface VideoScene {
  id: string;
  title: string;
  text: string;
  narration: string;
  template: SceneTemplate;
  duration: number;
  props: Record<string, unknown>;
  audio?: AudioAsset;
  background?: BackgroundAsset;
  captions?: WordToken[];
}

export interface TtsResult {
  output: string;
  duration: number;
  wordsPath?: string;
  words?: WordToken[];
}

export interface CutterProgress {
  task: 'transcribe' | 'export';
  percent: number;
  message: string;
}

export interface RenderProgress {
  percent: number;
  message: string;
}
