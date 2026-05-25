import { ArrowDown, ArrowUp, Volume2 } from 'lucide-react';
import TemplateSelector from './TemplateSelector';
import { useI18n } from '../i18n';
import type { VideoScene } from '../types';

interface Props {
  scene: VideoScene;
  index: number;
  onUpdate: (patch: Partial<VideoScene>) => void;
  onMove: (direction: -1 | 1) => void;
  onGenerateTts: () => void;
}

export default function SceneCard({ scene, index, onUpdate, onMove, onGenerateTts }: Props) {
  const { t } = useI18n();

  return (
    <article className="scene-card">
      <div className="scene-card-header">
        <span className="scene-index">{String(index + 1).padStart(2, '0')}</span>
        <input value={scene.title} onChange={(event) => onUpdate({ title: event.target.value })} />
        <div className="icon-row">
          <button title={t.sceneCard.moveUp} onClick={() => onMove(-1)}>
            <ArrowUp size={16} />
          </button>
          <button title={t.sceneCard.moveDown} onClick={() => onMove(1)}>
            <ArrowDown size={16} />
          </button>
        </div>
      </div>
      <div className="scene-fields">
        <label>
          <span>{t.sceneCard.template}</span>
          <TemplateSelector value={scene.template} onChange={(template) => onUpdate({ template })} />
        </label>
        <label>
          <span>{t.sceneCard.duration}</span>
          <input
            type="number"
            min={2}
            value={scene.duration}
            onChange={(event) => onUpdate({ duration: Number(event.target.value) })}
          />
        </label>
      </div>
      <label>
        <span>{t.sceneCard.narration}</span>
        <textarea value={scene.narration} onChange={(event) => onUpdate({ narration: event.target.value })} />
      </label>
      <label>
        <span>{t.sceneCard.propsJson}</span>
        <textarea
          className="mono"
          value={JSON.stringify(scene.props, null, 2)}
          onChange={(event) => {
            try {
              onUpdate({ props: JSON.parse(event.target.value) as Record<string, unknown> });
            } catch {
              onUpdate({ text: scene.text });
            }
          }}
        />
      </label>
      <div className="scene-actions">
        <button className="primary subtle" onClick={onGenerateTts}>
          <Volume2 size={16} />
          {t.sceneCard.generateTts}
        </button>
        {scene.audio && <span>{scene.audio.duration.toFixed(1)}s</span>}
      </div>
    </article>
  );
}
