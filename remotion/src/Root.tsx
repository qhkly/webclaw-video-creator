import { Composition } from 'remotion';
import { VideoComposition } from './VideoComposition';
import { sampleScenes } from './sampleScenes';

export function Root() {
  const durationInFrames = sampleScenes.reduce((total, scene) => total + scene.duration * 30, 0);

  return (
    <Composition
      id="WebClawVideo"
      component={VideoComposition}
      durationInFrames={durationInFrames}
      fps={30}
      width={1920}
      height={1080}
      defaultProps={{ scenes: sampleScenes }}
    />
  );
}
