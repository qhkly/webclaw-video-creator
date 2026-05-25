import { Player } from '@remotion/player';
import { VideoComposition } from '../../remotion/src/VideoComposition';
import { useVideoStore } from '../store/useVideoStore';
import { useI18n } from '../i18n';

export default function PreviewPage() {
  const scenes = useVideoStore((state) => state.scenes);
  const durationInFrames = Math.max(1, scenes.reduce((total, scene) => total + scene.duration * 30, 0));
  const { t } = useI18n();

  return (
    <section className="page preview-page">
      <header className="page-header">
        <div>
          <h1>{t.preview.title}</h1>
          <p>{t.preview.desc}</p>
        </div>
      </header>
      <div className="player-frame">
        <Player
          component={VideoComposition}
          inputProps={{ scenes }}
          durationInFrames={durationInFrames}
          compositionWidth={1920}
          compositionHeight={1080}
          fps={30}
          controls
          style={{ width: '100%', aspectRatio: '16 / 9' }}
        />
      </div>
    </section>
  );
}
