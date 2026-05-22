import type { VideoScene } from '../../src/types';

export const sampleScenes: VideoScene[] = [
  {
    id: 'sample-title',
    title: 'WebClaw Video Creator',
    text: 'Tauri + Remotion + Edge TTS',
    narration: 'WebClaw Video Creator 可以把技术脚本转换成带配音的视频。',
    template: 'TitleSlide',
    duration: 5,
    props: {
      title: 'WebClaw Video Creator',
      subtitle: 'Tauri + Remotion + Edge TTS',
      bgColor: '#0f172a',
    },
  },
  {
    id: 'sample-code',
    title: 'Renderer',
    text: 'renderMedia()',
    narration: '导出阶段通过 Remotion Renderer 生成视频。',
    template: 'CodeExplainer',
    duration: 7,
    props: {
      code: "const output = await renderMedia({\n  composition,\n  serveUrl,\n  codec: 'h264',\n});",
      language: 'typescript',
      highlightLines: [2, 3, 4],
      caption: 'Renderer script',
    },
  },
];
