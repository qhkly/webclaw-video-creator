export type Aspect = '16:9' | '9:16' | '1:1';
export type Resolution = '720p' | '1080p' | '4K';
export type Format = 'MP4' | 'MOV' | 'WebM';

export const ASPECT_DIMENSIONS: Record<Aspect, { width: number; height: number }> = {
  '16:9': { width: 1920, height: 1080 },
  '9:16': { width: 1080, height: 1920 },
  '1:1': { width: 1080, height: 1080 },
};

export const ASPECT_CSS: Record<Aspect, string> = {
  '16:9': '16 / 9',
  '9:16': '9 / 16',
  '1:1': '1 / 1',
};

export const DESIGN_BASE_WIDTH = 1920;

export const RESOLUTION_SCALE: Record<Resolution, number> = {
  '720p': 2 / 3,
  '1080p': 1,
  '4K': 2,
};
