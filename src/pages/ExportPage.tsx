import { open } from '@tauri-apps/plugin-dialog';
import { FolderOpen, Play } from 'lucide-react';
import { useEffect, useState } from 'react';
import VoiceSelector from '../components/VoiceSelector';
import { onRenderProgress, renderVideo, saveScenes } from '../lib/tauri-bridge';
import { useVideoStore } from '../store/useVideoStore';
import { useI18n } from '../i18n';
import type { RenderProgress } from '../types';

export default function ExportPage() {
  const scenes = useVideoStore((state) => state.scenes);
  const voice = useVideoStore((state) => state.voice);
  const engine = useVideoStore((state) => state.engine);
  const setVoice = useVideoStore((state) => state.setVoice);
  const setEngine = useVideoStore((state) => state.setEngine);
  const { t } = useI18n();
  const [outputDir, setOutputDir] = useState('');
  const [progress, setProgress] = useState<RenderProgress>({ percent: 0, message: t.export.ready });
  const [result, setResult] = useState('');

  useEffect(() => {
    let cleanup: (() => void) | undefined;
    void onRenderProgress(setProgress).then((unlisten) => {
      cleanup = unlisten;
    });
    return () => cleanup?.();
  }, []);

  return (
    <section className="page">
      <header className="page-header">
        <div>
          <h1>{t.export.title}</h1>
          <p>{t.export.desc}</p>
        </div>
      </header>
      <div className="export-panel">
        <VoiceSelector voice={voice} engine={engine} onVoiceChange={setVoice} onEngineChange={setEngine} />
        <label>
          <span>{t.export.outputDir}</span>
          <div className="path-row">
            <input value={outputDir} onChange={(event) => setOutputDir(event.target.value)} />
            <button
              title={t.export.chooseDir}
              onClick={async () => {
                const selected = await open({ directory: true, multiple: false });
                if (typeof selected === 'string') {
                  setOutputDir(selected);
                }
              }}
            >
              <FolderOpen size={16} />
            </button>
          </div>
        </label>
        <button
          className="primary"
          disabled={!outputDir}
          onClick={async () => {
            const scenesJson = await saveScenes({ scenes, outputDir });
            const output = await renderVideo({ scenesJson, outputDir });
            setResult(output);
          }}
        >
          <Play size={16} />
          {t.export.startRender}
        </button>
        <div className="progress-track">
          <div className="progress-bar" style={{ width: `${progress.percent}%` }} />
        </div>
        <p className="progress-text">{progress.message}</p>
        {result && <p className="result-path">{result}</p>}
      </div>
    </section>
  );
}
