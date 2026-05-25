import { Wand2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useVideoStore } from '../store/useVideoStore';
import { useI18n } from '../i18n';

export default function ScriptEditor() {
  const scenes = useVideoStore((state) => state.scenes);
  const splitScript = useVideoStore((state) => state.splitScript);
  const setActivePage = useVideoStore((state) => state.setActivePage);
  const [script, setScript] = useState(() => scenes.map((scene) => scene.narration).join('\n\n'));
  const { t } = useI18n();

  const stats = useMemo(() => {
    const minutes = scenes.reduce((total, scene) => total + scene.duration, 0) / 60;
    return `${scenes.length} ${t.scriptEditor.scenesUnit} · ${minutes.toFixed(1)} ${t.scriptEditor.minUnit}`;
  }, [scenes, t]);

  return (
    <section className="page">
      <header className="page-header">
        <div>
          <h1>{t.scriptEditor.title}</h1>
          <p>{stats}</p>
        </div>
        <button
          className="primary"
          onClick={() => {
            splitScript(script);
            setActivePage('scenes');
          }}
        >
          <Wand2 size={16} />
          {t.scriptEditor.splitScript}
        </button>
      </header>
      <textarea
        className="script-editor"
        value={script}
        onChange={(event) => setScript(event.target.value)}
        placeholder={t.scriptEditor.placeholder}
      />
    </section>
  );
}
