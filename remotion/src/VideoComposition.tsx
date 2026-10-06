import { AbsoluteFill, Audio, Sequence, useCurrentFrame, useVideoConfig } from 'remotion';
import type { Aspect } from '../../src/constants/aspect';
import type { CaptionSettings, VideoScene } from '../../src/types';
import { Background } from './Background';
import { Captions } from './Captions';
import BulletPoints from './compositions/BulletPoints';
import BigStat from './compositions/BigStat';
import CodeExplainer from './compositions/CodeExplainer';
import ImageFrame from './compositions/ImageFrame';
import Quote from './compositions/Quote';
import TitleSlide from './compositions/TitleSlide';
import { mediaSrc } from './media';
import { Watermark } from './Watermark';

interface Props {
  scenes?: VideoScene[];
  aspect?: Aspect;
  captions?: CaptionSettings;
  /** Free plan: burn the product watermark into every frame (scripts/lib/plan.mjs). */
  watermark?: boolean;
}

export function VideoComposition({ scenes = [], captions, watermark = false }: Props) {
  const { fps } = useVideoConfig();
  let from = 0;

  return (
    <AbsoluteFill style={{ backgroundColor: '#0b1020' }}>
      {scenes.map((scene) => {
        const durationInFrames = Math.max(1, Math.round(scene.duration * fps));
        const sequenceFrom = from;
        from += durationInFrames;
        return (
          <Sequence from={sequenceFrom} durationInFrames={durationInFrames} key={scene.id}>
            {scene.audio?.path && <Audio src={mediaSrc(scene.audio.path)} />}
            <SceneRenderer scene={scene} />
          </Sequence>
        );
      })}
      <Captions scenes={scenes} settings={captions} />
      {watermark && <Watermark />}
    </AbsoluteFill>
  );
}

function SceneRenderer({ scene }: { scene: VideoScene }) {
  const frame = useCurrentFrame();
  const hasBackground = Boolean(scene.background?.assetPath && scene.background.kind !== 'none');
  const props = hasBackground ? { ...scene.props, bgColor: 'rgba(2, 6, 23, 0.46)' } : scene.props;

  return (
    <AbsoluteFill>
      <Background background={scene.background} />
      {scene.template === 'CodeExplainer' && <CodeExplainer {...props} fallbackTitle={scene.title} frame={frame} />}
      {scene.template === 'BulletPoints' && <BulletPoints {...props} fallbackTitle={scene.title} frame={frame} />}
      {scene.template === 'BigStat' && <BigStat {...props} fallbackTitle={scene.title} frame={frame} />}
      {scene.template === 'Quote' && <Quote {...props} fallbackTitle={scene.title} frame={frame} />}
      {scene.template === 'ImageFrame' && <ImageFrame {...props} fallbackTitle={scene.title} frame={frame} />}
      {scene.template === 'TitleSlide' && <TitleSlide {...props} fallbackTitle={scene.title} frame={frame} />}
    </AbsoluteFill>
  );
}
