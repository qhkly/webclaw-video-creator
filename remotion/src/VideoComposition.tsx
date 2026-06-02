import { AbsoluteFill, Sequence, useCurrentFrame, useVideoConfig } from 'remotion';
import type { Aspect } from '../../src/constants/aspect';
import type { VideoScene } from '../../src/types';
import BulletPoints from './compositions/BulletPoints';
import BigStat from './compositions/BigStat';
import CodeExplainer from './compositions/CodeExplainer';
import ImageFrame from './compositions/ImageFrame';
import Quote from './compositions/Quote';
import TitleSlide from './compositions/TitleSlide';

interface Props {
  scenes?: VideoScene[];
  aspect?: Aspect;
}

export function VideoComposition({ scenes = [] }: Props) {
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
            <SceneRenderer scene={scene} />
          </Sequence>
        );
      })}
    </AbsoluteFill>
  );
}

function SceneRenderer({ scene }: { scene: VideoScene }) {
  const frame = useCurrentFrame();
  const props = scene.props;

  if (scene.template === 'CodeExplainer') {
    return <CodeExplainer {...props} fallbackTitle={scene.title} frame={frame} />;
  }
  if (scene.template === 'BulletPoints') {
    return <BulletPoints {...props} fallbackTitle={scene.title} frame={frame} />;
  }
  if (scene.template === 'BigStat') {
    return <BigStat {...props} fallbackTitle={scene.title} frame={frame} />;
  }
  if (scene.template === 'Quote') {
    return <Quote {...props} fallbackTitle={scene.title} frame={frame} />;
  }
  if (scene.template === 'ImageFrame') {
    return <ImageFrame {...props} fallbackTitle={scene.title} frame={frame} />;
  }
  return <TitleSlide {...props} fallbackTitle={scene.title} frame={frame} />;
}
