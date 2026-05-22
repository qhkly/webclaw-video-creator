import { Player } from '@remotion/player';
import { VideoComposition } from '../../remotion/src/VideoComposition';
import { useVideoStore } from '../store/useVideoStore';

export default function PreviewPage() {
  const scenes = useVideoStore((state) => state.scenes);
  const durationInFrames = Math.max(1, scenes.reduce((total, scene) => total + scene.duration * 30, 0));

  return (
    <section className="page preview-page">
      <header className="page-header">
        <div>
          <h1>实时预览</h1>
          <p>Remotion Player 在 WebView 中直接渲染当前 Scene[]</p>
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
