import { AbsoluteFill, Img, OffthreadVideo, interpolate, useCurrentFrame, useVideoConfig } from 'remotion';
import type { BackgroundAsset } from '../../src/types';
import { mediaSrc } from './media';

export function Background({ background }: { background?: BackgroundAsset }) {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();

  if (!background || background.kind === 'none' || !background.assetPath) {
    return null;
  }

  const src = mediaSrc(background.assetPath);
  const scale = background.kind === 'image' && background.kenBurns !== false
    ? interpolate(frame, [0, Math.max(1, durationInFrames)], [1.04, 1.12], { extrapolateRight: 'clamp' })
    : 1;
  const translate = background.kind === 'image' && background.kenBurns !== false
    ? interpolate(frame, [0, Math.max(1, durationInFrames)], [-18, 18], { extrapolateRight: 'clamp' })
    : 0;

  return (
    <AbsoluteFill style={{ backgroundColor: '#05080f' }}>
      {background.kind === 'video' ? (
        <OffthreadVideo
          src={src}
          muted
          style={{ width: '100%', height: '100%', objectFit: background.fit ?? 'cover' }}
        />
      ) : (
        <Img
          src={src}
          style={{
            width: '100%',
            height: '100%',
            objectFit: background.fit ?? 'cover',
            transform: `scale(${scale}) translate3d(${translate}px, 0, 0)`,
          }}
        />
      )}
      <AbsoluteFill
        style={{
          background:
            'linear-gradient(180deg, rgba(2, 6, 23, 0.32) 0%, rgba(2, 6, 23, 0.54) 64%, rgba(2, 6, 23, 0.76) 100%)',
        }}
      />
    </AbsoluteFill>
  );
}
