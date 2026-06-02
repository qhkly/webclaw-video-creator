import { useState } from 'react';
import { Player } from '@remotion/player';
import { VideoComposition } from '../../remotion/src/VideoComposition';
import SceneVisual from '../components/SceneVisual';
import { ASPECT_CSS, ASPECT_DIMENSIONS } from '../constants/aspect';
import { useVideoStore } from '../store/useVideoStore';
import { useI18n } from '../i18n';

export default function PreviewPage() {
  const scenes = useVideoStore((state) => state.scenes);
  const aspect = useVideoStore((state) => state.aspect);
  const { t } = useI18n();
  const totalSeconds = scenes.reduce((total, scene) => total + scene.duration, 0);
  const durationInFrames = Math.max(1, scenes.reduce((total, scene) => total + scene.duration * 30, 0));
  const [selectedId, setSelectedId] = useState(() => scenes[0]?.id ?? '');
  const selectedScene = scenes.find((scene) => scene.id === selectedId) ?? scenes[0];
  const dimensions = ASPECT_DIMENSIONS[aspect];
  const playerStyle = {
    width: aspect === '16:9' ? '100%' : 'auto',
    height: aspect === '16:9' ? 'auto' : '100%',
    maxWidth: '100%',
    maxHeight: '100%',
    aspectRatio: ASPECT_CSS[aspect],
  };

  return (
    <section className="page preview-page rise">
      <header className="page-head">
        <div>
          <h1>{t.preview.title}</h1>
          <p>{t.preview.desc}</p>
        </div>
      </header>
      <div className="player-frame card">
        <Player
          component={VideoComposition}
          inputProps={{ scenes, aspect }}
          durationInFrames={durationInFrames}
          compositionWidth={dimensions.width}
          compositionHeight={dimensions.height}
          fps={30}
          controls
          style={playerStyle}
        />
      </div>
      <div className="preview-thumbs">
        {scenes.map((scene, index) => (
          <button
            className={scene.id === selectedScene?.id ? 'preview-thumb active' : 'preview-thumb'}
            key={scene.id}
            onClick={() => setSelectedId(scene.id)}
          >
            <SceneVisual scene={scene} compact />
            <span>{String(index + 1).padStart(2, '0')}</span>
            <strong>{scene.title}</strong>
          </button>
        ))}
      </div>
      <p className="tag-dim preview-total">
        {scenes.length} scenes · {totalSeconds}s
      </p>
    </section>
  );
}
