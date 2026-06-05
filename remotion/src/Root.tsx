import { Composition } from 'remotion';
import { ASPECT_DIMENSIONS, type Aspect } from '../../src/constants/aspect';
import type { CaptionSettings, VideoScene } from '../../src/types';
import { VideoComposition } from './VideoComposition';
import { sampleScenes } from './sampleScenes';

type CompositionProps = {
  scenes?: VideoScene[];
  aspect?: Aspect;
  captions?: CaptionSettings;
};

export function Root() {
  const durationInFrames = sampleScenes.reduce((total, scene) => total + scene.duration * 30, 0);
  const defaultDimensions = ASPECT_DIMENSIONS['16:9'];

  return (
    <Composition
      id="WebClawVideo"
      component={VideoComposition}
      durationInFrames={durationInFrames}
      fps={30}
      width={defaultDimensions.width}
      height={defaultDimensions.height}
      defaultProps={{ scenes: sampleScenes, aspect: '16:9' as Aspect }}
      calculateMetadata={({ props }) => {
        const { scenes = sampleScenes, aspect = '16:9' } = props as CompositionProps;
        const dimensions = ASPECT_DIMENSIONS[aspect] ?? ASPECT_DIMENSIONS['16:9'];
        return {
          ...dimensions,
          durationInFrames: Math.max(1, scenes.reduce((total, scene) => total + scene.duration * 30, 0)),
        };
      }}
    />
  );
}
