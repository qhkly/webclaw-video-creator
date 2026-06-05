import { Save, Settings, Subtitles } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { Aspect, Resolution } from '../constants/aspect';
import { getSettings, saveSettings } from '../lib/tauri-bridge';
import { useVideoStore } from '../store/useVideoStore';
import type { CaptionSettings, CreatorSettings } from '../types';

const RESOLUTIONS: Resolution[] = ['720p', '1080p', '4K'];
const ASPECTS: Array<{ value: Aspect; label: string }> = [
  { value: '16:9', label: '横屏 16:9' },
  { value: '9:16', label: '竖屏 9:16' },
  { value: '1:1', label: '方形 1:1' },
];

export default function SettingsPanel() {
  const settings = useVideoStore((state) => state.settings);
  const setSettings = useVideoStore((state) => state.setSettings);
  const updateCaptionSettings = useVideoStore((state) => state.updateCaptionSettings);
  const [draft, setDraft] = useState<CreatorSettings>(settings);
  const [status, setStatus] = useState('设置会保存到应用配置目录');

  useEffect(() => {
    void getSettings()
      .then((loaded) => {
        setSettings(loaded);
        setDraft(loaded);
      })
      .catch((error) => setStatus(String(error)));
  }, [setSettings]);

  const updateCaptions = (patch: Partial<CaptionSettings>) => {
    setDraft((current) => ({
      ...current,
      captions: { ...current.captions, ...patch },
    }));
  };

  return (
    <section className="page settings-page rise">
      <header className="page-head">
        <div>
          <h1>设置</h1>
          <p>Pexels、默认导出参数和烧录字幕样式。</p>
        </div>
      </header>
      <div className="settings-grid">
        <div className="card settings-card">
          <span className="field-label">
            <Settings size={14} />
            Pexels
          </span>
          <label>
            <span className="field-label">API Key</span>
            <input
              className="input"
              type="password"
              value={draft.pexelsApiKey}
              onChange={(event) => setDraft({ ...draft, pexelsApiKey: event.target.value })}
              placeholder="Pexels API Key"
            />
          </label>
        </div>

        <div className="card settings-card">
          <span className="field-label">默认参数</span>
          <label>
            <span className="field-label">默认音色</span>
            <input
              className="input"
              value={draft.defaults.voice}
              onChange={(event) => setDraft({ ...draft, defaults: { ...draft.defaults, voice: event.target.value } })}
            />
          </label>
          <label>
            <span className="field-label">默认画幅</span>
            <select
              className="select"
              value={draft.defaults.aspect}
              onChange={(event) => setDraft({ ...draft, defaults: { ...draft.defaults, aspect: event.target.value as Aspect } })}
            >
              {ASPECTS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span className="field-label">默认分辨率</span>
            <select
              className="select"
              value={draft.defaults.resolution}
              onChange={(event) => setDraft({ ...draft, defaults: { ...draft.defaults, resolution: event.target.value as Resolution } })}
            >
              {RESOLUTIONS.map((resolution) => (
                <option key={resolution} value={resolution}>
                  {resolution}
                </option>
              ))}
            </select>
          </label>
        </div>

        <div className="card settings-card">
          <span className="field-label">
            <Subtitles size={14} />
            词级字幕
          </span>
          <label className="toggle-row">
            <input
              type="checkbox"
              checked={draft.captions.enabled}
              onChange={(event) => updateCaptions({ enabled: event.target.checked })}
            />
            <span>导出时烧录字幕</span>
          </label>
          <label>
            <span className="field-label">位置</span>
            <select
              className="select"
              value={draft.captions.position}
              onChange={(event) => updateCaptions({ position: event.target.value as CaptionSettings['position'] })}
            >
              <option value="bottom">底部</option>
              <option value="middle">中部</option>
            </select>
          </label>
          <label>
            <span className="field-label">字号 · {draft.captions.fontSize}</span>
            <input
              type="range"
              min={32}
              max={88}
              value={draft.captions.fontSize}
              onChange={(event) => updateCaptions({ fontSize: Number(event.target.value) })}
            />
          </label>
          <div className="color-row">
            <label>
              <span className="field-label">高亮</span>
              <input className="input color-input" type="color" value={draft.captions.activeColor} onChange={(event) => updateCaptions({ activeColor: event.target.value })} />
            </label>
            <label>
              <span className="field-label">默认</span>
              <input className="input color-input" type="color" value={draft.captions.inactiveColor} onChange={(event) => updateCaptions({ inactiveColor: event.target.value })} />
            </label>
          </div>
        </div>
      </div>
      <div className="settings-actions">
        <button
          className="btn btn-primary"
          onClick={async () => {
            const saved = await saveSettings({ settings: draft });
            setSettings(saved);
            updateCaptionSettings(saved.captions);
            setStatus('设置已保存');
          }}
        >
          <Save size={16} />
          保存设置
        </button>
        <span className="tag-dim">{status}</span>
      </div>
    </section>
  );
}
