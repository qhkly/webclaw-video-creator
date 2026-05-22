import { Wand2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useVideoStore } from '../store/useVideoStore';

export default function ScriptEditor() {
  const scenes = useVideoStore((state) => state.scenes);
  const splitScript = useVideoStore((state) => state.splitScript);
  const setActivePage = useVideoStore((state) => state.setActivePage);
  const [script, setScript] = useState(() => scenes.map((scene) => scene.narration).join('\n\n'));
  const stats = useMemo(() => {
    const minutes = scenes.reduce((total, scene) => total + scene.duration, 0) / 60;
    return `${scenes.length} scenes · ${minutes.toFixed(1)} min`;
  }, [scenes]);

  return (
    <section className="page">
      <header className="page-header">
        <div>
          <h1>脚本编辑器</h1>
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
          手动分段
        </button>
      </header>
      <textarea
        className="script-editor"
        value={script}
        onChange={(event) => setScript(event.target.value)}
        placeholder="每个场景用空行分隔。第一行会作为场景标题。"
      />
    </section>
  );
}
