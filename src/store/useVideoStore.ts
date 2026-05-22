import { create } from 'zustand';
import type { SceneTemplate, VideoScene, VoiceEngine } from '../types';

const templates: SceneTemplate[] = ['TitleSlide', 'CodeExplainer', 'BulletPoints', 'ImageFrame'];

const defaultScenes: VideoScene[] = [
  {
    id: crypto.randomUUID(),
    title: '技术视频生成工具',
    text: '从脚本到可发布视频',
    narration: '这个工具会把脚本拆成场景，生成配音，并使用程序化模板渲染技术视频。',
    template: 'TitleSlide',
    duration: 5,
    props: {
      title: 'WebClaw Video Creator',
      subtitle: 'Tauri + Remotion + Edge TTS',
      bgColor: '#0f172a',
    },
  },
  {
    id: crypto.randomUUID(),
    title: '核心流程',
    text: '脚本 -> 场景 -> 配音 -> 渲染 -> 合成',
    narration: '核心流程分为五步：输入脚本、拆分场景、生成配音、渲染画面，最后合成音视频。',
    template: 'BulletPoints',
    duration: 8,
    props: {
      title: 'Pipeline',
      bullets: ['脚本拆分', 'Edge TTS 配音', 'Remotion 模板渲染', 'FFmpeg 合成'],
      accent: '#22c55e',
    },
  },
];

interface VideoStore {
  scenes: VideoScene[];
  activePage: 'script' | 'scenes' | 'preview' | 'export';
  voice: string;
  engine: VoiceEngine;
  setActivePage: (page: VideoStore['activePage']) => void;
  setVoice: (voice: string) => void;
  setEngine: (engine: VoiceEngine) => void;
  setScenes: (scenes: VideoScene[]) => void;
  updateScene: (id: string, patch: Partial<VideoScene>) => void;
  moveScene: (id: string, direction: -1 | 1) => void;
  splitScript: (script: string) => void;
}

export const useVideoStore = create<VideoStore>((set) => ({
  scenes: defaultScenes,
  activePage: 'script',
  voice: 'zh-CN-YunxiNeural',
  engine: 'edge',
  setActivePage: (activePage) => set({ activePage }),
  setVoice: (voice) => set({ voice }),
  setEngine: (engine) => set({ engine }),
  setScenes: (scenes) => set({ scenes }),
  updateScene: (id, patch) =>
    set((state) => ({
      scenes: state.scenes.map((scene) => (scene.id === id ? { ...scene, ...patch } : scene)),
    })),
  moveScene: (id, direction) =>
    set((state) => {
      const index = state.scenes.findIndex((scene) => scene.id === id);
      const nextIndex = index + direction;
      if (index < 0 || nextIndex < 0 || nextIndex >= state.scenes.length) {
        return state;
      }
      const scenes = [...state.scenes];
      const [scene] = scenes.splice(index, 1);
      scenes.splice(nextIndex, 0, scene);
      return { scenes };
    }),
  splitScript: (script) =>
    set({
      scenes: script
        .split(/\n\s*\n/)
        .map((part) => part.trim())
        .filter(Boolean)
        .map((part, index) => {
          const template = templates[Math.min(index, templates.length - 1)];
          const title = part.split('\n')[0].slice(0, 36) || `Scene ${index + 1}`;
          return {
            id: crypto.randomUUID(),
            title,
            text: part,
            narration: part.replace(/\n+/g, ' '),
            template,
            duration: Math.max(5, Math.ceil(part.length / 28)),
            props:
              template === 'CodeExplainer'
                ? { code: part, language: 'typescript', highlightLines: [1], caption: title }
                : template === 'BulletPoints'
                  ? { title, bullets: part.split('\n').slice(1, 5), accent: '#0ea5e9' }
                  : template === 'ImageFrame'
                    ? { imageSrc: '', caption: title, subtitle: part }
                    : { title, subtitle: part.slice(title.length).trim(), bgColor: '#111827' },
          };
        }),
    }),
}));
