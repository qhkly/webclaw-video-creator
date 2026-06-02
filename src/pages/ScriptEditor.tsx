import { Clock3, Layers3, Mic, Monitor, Scissors, Trash2, Type, Wand2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import VoiceSelector from '../components/VoiceSelector';
import type { Aspect } from '../constants/aspect';
import { useVideoStore } from '../store/useVideoStore';
import { useI18n } from '../i18n';

const ASPECT_OPTIONS: Array<{ id: Aspect; label: string; shape: string }> = [
  { id: '16:9', label: '16:9', shape: 'wide' },
  { id: '9:16', label: '9:16', shape: 'vertical' },
  { id: '1:1', label: '1:1', shape: 'square' },
];

export default function ScriptEditor() {
  const scenes = useVideoStore((state) => state.scenes);
  const aspect = useVideoStore((state) => state.aspect);
  const voice = useVideoStore((state) => state.voice);
  const engine = useVideoStore((state) => state.engine);
  const setVoice = useVideoStore((state) => state.setVoice);
  const setEngine = useVideoStore((state) => state.setEngine);
  const setAspect = useVideoStore((state) => state.setAspect);
  const splitScript = useVideoStore((state) => state.splitScript);
  const setActivePage = useVideoStore((state) => state.setActivePage);
  const [script, setScript] = useState(() => scenes.map((scene) => scene.narration).join('\n\n'));
  const { t } = useI18n();

  const stats = useMemo(() => {
    const minutes = scenes.reduce((total, scene) => total + scene.duration, 0) / 60;
    return `${scenes.length} ${t.scriptEditor.scenesUnit} · ${minutes.toFixed(1)} ${t.scriptEditor.minUnit}`;
  }, [scenes, t]);
  const chars = script.trim().length;
  const paragraphs = script
    .split(/\n\s*\n/)
    .map((part) => part.trim())
    .filter(Boolean);
  const estimatedMinutes = (chars / 280).toFixed(1);

  return (
    <section className="page script-page rise">
      <header className="page-head head-row">
        <div>
          <h1>{t.scriptEditor.title}</h1>
          <p>{stats}</p>
        </div>
        <div className="header-pills">
          <span className="pill pill-muted">
            <Type size={13} />
            {chars} 字
          </span>
          <span className="pill pill-muted">
            <Clock3 size={13} />
            约 {estimatedMinutes} 分钟
          </span>
        </div>
      </header>
      <div className="script-grid">
        <div className="card script-card">
          <div className="card-toolbar">
            <span>{t.scriptEditor.title}</span>
            <span className="tag-dim">{paragraphs.length} 段</span>
            <button className="btn btn-ghost btn-sm icon-only" onClick={() => setScript('')} disabled={!chars} title="清空">
              <Trash2 size={14} />
            </button>
          </div>
          <textarea
            className="textarea script-editor"
            value={script}
            onChange={(event) => setScript(event.target.value)}
            placeholder={t.scriptEditor.placeholder}
          />
          <div className="card-footer">
            <span>拆分后可在「场景」中逐镜调整模板、配音与时长</span>
            <button
              className="btn btn-primary"
              disabled={!chars}
              onClick={() => {
                splitScript(script);
                setActivePage('scenes');
              }}
            >
              <Scissors size={15} />
              {t.scriptEditor.splitScript}
            </button>
          </div>
        </div>
        <aside className="side-stack">
          <div className="card stat-card">
            <div className="field-label">
              <Monitor size={14} />
              画幅比例
            </div>
            <div className="aspect-options">
              {ASPECT_OPTIONS.map((option) => (
                <button
                  className={aspect === option.id ? 'active' : ''}
                  key={option.id}
                  onClick={() => setAspect(option.id)}
                >
                  <i className={option.shape} />
                  <span>{option.label}</span>
                </button>
              ))}
            </div>
            <p className="tag-dim">{t.scriptEditor.aspectLabels[aspect]}</p>
          </div>
          <div className="card stat-card">
            <div className="field-label">
              <Mic size={14} />
              默认配音
            </div>
            <VoiceSelector voice={voice} engine={engine} onVoiceChange={setVoice} onEngineChange={setEngine} />
          </div>
          <div className="card stat-card">
            <div className="field-label">
              <Layers3 size={14} />
              已识别 {scenes.length} 个场景
            </div>
            <div className="recognized-scenes">
              {scenes.map((scene, index) => (
                <div key={scene.id} className="recognized-scene">
                  <span className="tag-dim">{String(index + 1).padStart(2, '0')}</span>
                  <span>{scene.title}</span>
                </div>
              ))}
            </div>
            <button className="btn btn-soft btn-block btn-sm" onClick={() => setActivePage('scenes')}>
              <Wand2 size={14} />
              打开场景编辑器
            </button>
          </div>
        </aside>
      </div>
    </section>
  );
}
