export type SceneTemplate = 'TitleSlide' | 'CodeExplainer' | 'BulletPoints' | 'ImageFrame';

export type VoiceEngine = 'edge' | 'f5';

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
