import { open } from '@tauri-apps/plugin-dialog';
import { Clock3, FolderOpen, Layers3, Monitor, Play, RefreshCw } from 'lucide-react';
import { useEffect, useState } from 'react';
import VoiceSelector from '../components/VoiceSelector';
import { onRenderProgress, renderVideo, saveScenes } from '../lib/tauri-bridge';
import { useVideoStore } from '../store/useVideoStore';
import { useI18n } from '../i18n';
import type { Format, RenderProgress, Resolution } from '../types';

export default function ExportPage() {
  const scenes = useVideoStore((state) => state.scenes);
  const aspect = useVideoStore((state) => state.aspect);
  const captions = useVideoStore((state) => state.captions);
  const voice = useVideoStore((state) => state.voice);
  const engine = useVideoStore((state) => state.engine);
  const setVoice = useVideoStore((state) => state.setVoice);
  const setEngine = useVideoStore((state) => state.setEngine);
  const { t } = useI18n();
  const [outputDir, setOutputDir] = useState('');
  const [resolution, setResolution] = useState<Resolution>('1080p');
  const [format, setFormat] = useState<Format>('MP4');
  const [progress, setProgress] = useState<RenderProgress>({ percent: 0, message: t.export.ready });
  const [result, setResult] = useState('');
  const totalSeconds = scenes.reduce((total, scene) => total + scene.duration, 0);
  const running = progress.percent > 0 && progress.percent < 100;

  useEffect(() => {
    let cleanup: (() => void) | undefined;
    void onRenderProgress(setProgress).then((unlisten) => {
      cleanup = unlisten;
    });
    return () => cleanup?.();
  }, []);

  return (
    <section className="page export-page rise">
      <header className="page-head">
        <div>
          <h1>{t.export.title}</h1>
          <p>{t.export.desc}</p>
        </div>
      </header>
      <div className="summary-strip card">
        {[
          { icon: Layers3, label: '场景', value: scenes.length },
          { icon: Clock3, label: '总时长', value: `${totalSeconds}s` },
          { icon: Monitor, label: '画幅', value: aspect },
          { icon: Monitor, label: '分辨率', value: resolution },
        ].map((item) => {
          const Icon = item.icon;
          return (
            <div className="summary-item" key={item.label}>
              <span>
                <Icon size={17} />
              </span>
              <div>
                <small>{item.label}</small>
                <strong>{item.value}</strong>
              </div>
            </div>
          );
        })}
      </div>
      <div className="export-panel">
        <div className="export-grid">
          <div className="card export-card">
            <VoiceSelector voice={voice} engine={engine} onVoiceChange={setVoice} onEngineChange={setEngine} />
          </div>
          <div className="card export-card">
            <span className="field-label">
              <Monitor size={14} />
              分辨率
            </span>
            <div className="choice-row">
              {(['720p', '1080p', '4K'] as Resolution[]).map((item) => (
                <button className={resolution === item ? 'active' : ''} key={item} onClick={() => setResolution(item)}>
                  {item}
                </button>
              ))}
            </div>
            <span className="field-label export-format-label">格式</span>
            <div className="choice-row">
              {(['MP4', 'MOV', 'WebM'] as Format[]).map((item) => (
                <button className={format === item ? 'active' : ''} key={item} onClick={() => setFormat(item)}>
                  {item}
                </button>
              ))}
            </div>
          </div>
        </div>
        <label className="card export-card">
          <span className="field-label">{t.export.outputDir}</span>
          <div className="path-row">
            <input className="input" value={outputDir} onChange={(event) => setOutputDir(event.target.value)} />
            <button
              className="btn btn-ghost"
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
        <div className="card render-progress-card">
          <div className="progress-head">
            <strong>{progress.percent >= 100 ? '渲染完成' : running ? '正在渲染...' : t.export.ready}</strong>
            <span>{Math.round(progress.percent)}%</span>
          </div>
          <div className="progress-track">
            <div className="progress-bar" style={{ width: `${progress.percent}%` }} />
          </div>
          <p className="progress-text">{progress.message}</p>
        </div>
        <button
          className="btn btn-primary btn-block export-cta"
          disabled={!outputDir || running}
          onClick={async () => {
            const scenesJson = await saveScenes({ scenes, outputDir });
            const output = await renderVideo({ scenesJson, outputDir, aspect, resolution, format, captionsJson: JSON.stringify(captions) });
            setResult(output);
          }}
        >
          {running ? <RefreshCw size={16} className="spin" /> : <Play size={16} />}
          {t.export.startRender}
        </button>
        {result && <p className="result-path">{result}</p>}
      </div>
    </section>
  );
}
