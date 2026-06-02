export type SceneTemplate = 'TitleSlide' | 'BulletPoints' | 'BigStat' | 'Quote' | 'CodeExplainer' | 'ImageFrame';

export type VoiceEngine = 'edge' | 'f5';
export type { Aspect, Format, Resolution } from './constants/aspect';

export interface AudioAsset {
  path: string;
  duration: number;
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
}

export interface RenderProgress {
  percent: number;
  message: string;
}
