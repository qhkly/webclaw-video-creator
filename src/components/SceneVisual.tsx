import { Image } from 'lucide-react';
import type { VideoScene } from '../types';

interface Props {
  scene: VideoScene;
  compact?: boolean;
}

function stringProp(value: unknown, fallback = '') {
  return typeof value === 'string' && value.trim() ? value : fallback;
}

function listProp(value: unknown) {
  return Array.isArray(value) ? value.map(String).filter(Boolean) : [];
}

export default function SceneVisual({ scene, compact = false }: Props) {
  const props = scene.props ?? {};
  const bgColor = stringProp(props.bgColor, '#0f172a');

  return (
    <div className={compact ? 'scene-visual compact' : 'scene-visual'} style={{ backgroundColor: bgColor }}>
      <div className="stage-decor" />
      {scene.template === 'BulletPoints' && (
        <div className="visual-content bullet-visual">
          <h2>{stringProp(props.title, scene.title)}</h2>
          <div>
            {listProp(props.bullets)
              .slice(0, compact ? 4 : 5)
              .map((item, index) => (
                <p key={`${item}-${index}`}>
                  <span>{index + 1}</span>
                  {item}
                </p>
              ))}
          </div>
        </div>
      )}
      {scene.template === 'BigStat' && (
        <div className="visual-content stat-visual">
          <strong>{stringProp(props.stat, '5×')}</strong>
          <span>{stringProp(props.label, scene.title)}</span>
        </div>
      )}
      {scene.template === 'Quote' && (
        <div className="visual-content quote-visual">
          <em>“</em>
          <blockquote>{stringProp(props.quote, scene.narration || scene.title)}</blockquote>
          <span>— {stringProp(props.author, 'WebClaw')}</span>
        </div>
      )}
      {scene.template === 'CodeExplainer' && (
        <div className="visual-content code-visual">
          <h2>{stringProp(props.caption, scene.title)}</h2>
          <pre>{stringProp(props.code, scene.text || 'render(scenes)')}</pre>
        </div>
      )}
      {scene.template === 'ImageFrame' && (
        <div className="visual-content image-visual">
          <div>
            <Image size={compact ? 18 : 34} />
            <span>{stringProp(props.subtitle, '产品截图 / B-roll')}</span>
          </div>
          <strong>{stringProp(props.caption, scene.title)}</strong>
        </div>
      )}
      {scene.template === 'TitleSlide' && (
        <div className="visual-content title-visual">
          <span>{stringProp(props.kicker, 'WEBCLAW')}</span>
          <h1>{stringProp(props.title, scene.title)}</h1>
          <p>{stringProp(props.subtitle, scene.text)}</p>
        </div>
      )}
    </div>
  );
}
