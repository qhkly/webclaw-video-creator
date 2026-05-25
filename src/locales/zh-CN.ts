const zhCN = {
  nav: {
    script: '脚本',
    scenes: '场景',
    preview: '预览',
    export: '导出',
  },
  scriptEditor: {
    title: '脚本编辑器',
    splitScript: '手动分段',
    placeholder: '每个场景用空行分隔。第一行会作为场景标题。',
    scenesUnit: '个场景',
    minUnit: '分钟',
  },
  sceneManager: {
    title: '场景管理器',
    desc: '编辑模板、旁白、时长和渲染参数',
  },
  preview: {
    title: '实时预览',
    desc: 'Remotion Player 在 WebView 中直接渲染当前 Scene[]',
  },
  export: {
    title: '导出',
    desc: '生成配音、渲染 Remotion 视频，并输出 MP4',
    outputDir: '输出目录',
    chooseDir: '选择目录',
    startRender: '开始渲染',
    ready: '待开始',
  },
  sceneCard: {
    moveUp: '上移',
    moveDown: '下移',
    template: '模板',
    duration: '时长',
    narration: '旁白',
    propsJson: '模板 Props JSON',
    generateTts: '生成配音',
  },
  voiceSelector: {
    engine: '引擎',
    voice: '音色',
  },
  voices: {
    'zh-CN-YunxiNeural': '中文男声 Yunxi',
    'zh-CN-XiaoxiaoNeural': '中文女声 Xiaoxiao',
    'en-US-GuyNeural': 'English Guy',
    'en-US-JennyNeural': 'English Jenny',
  } as Record<string, string>,
};

export default zhCN;
