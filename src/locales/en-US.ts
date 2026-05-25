import type zhCN from './zh-CN';

const enUS: typeof zhCN = {
  nav: {
    script: 'Script',
    scenes: 'Scenes',
    preview: 'Preview',
    export: 'Export',
  },
  scriptEditor: {
    title: 'Script Editor',
    splitScript: 'Split into Scenes',
    placeholder: 'Separate each scene with a blank line. The first line becomes the scene title.',
    scenesUnit: 'scenes',
    minUnit: 'min',
  },
  sceneManager: {
    title: 'Scene Manager',
    desc: 'Edit templates, narration, duration and render props',
  },
  preview: {
    title: 'Live Preview',
    desc: 'Remotion Player renders Scene[] directly in WebView',
  },
  export: {
    title: 'Export',
    desc: 'Generate TTS audio, render Remotion video, output MP4',
    outputDir: 'Output Directory',
    chooseDir: 'Choose Directory',
    startRender: 'Start Render',
    ready: 'Ready',
  },
  sceneCard: {
    moveUp: 'Move Up',
    moveDown: 'Move Down',
    template: 'Template',
    duration: 'Duration',
    narration: 'Narration',
    propsJson: 'Template Props JSON',
    generateTts: 'Generate TTS',
  },
  voiceSelector: {
    engine: 'Engine',
    voice: 'Voice',
  },
  voices: {
    'zh-CN-YunxiNeural': 'Chinese Male Yunxi',
    'zh-CN-XiaoxiaoNeural': 'Chinese Female Xiaoxiao',
    'en-US-GuyNeural': 'English Guy',
    'en-US-JennyNeural': 'English Jenny',
  },
};

export default enUS;
