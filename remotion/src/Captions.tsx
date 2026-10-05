import { AbsoluteFill, interpolate, useCurrentFrame, useVideoConfig } from 'remotion';
import type { CaptionSettings, VideoScene } from '../../src/types';
import { captionTokenText, findCaptionContext } from './caption-groups';
import { useScale } from './useScale';

interface Props {
  scenes: VideoScene[];
  settings?: CaptionSettings;
}

export function Captions({ scenes, settings }: Props) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const scale = useScale();
  const currentMs = (frame / fps) * 1000;
  const captions = settings ?? {
    enabled: true,
    position: 'bottom',
    fontSize: 54,
    activeColor: '#facc15',
    inactiveColor: '#ffffff',
  };

  if (!captions.enabled) {
    return null;
  }

  const active = findActiveCaption(scenes, currentMs);
  if (!active) {
    return null;
  }

  const progress = Math.max(0, currentMs - active.group.startMs);
  const pop = interpolate(progress, [0, 140], [0.96, 1], { extrapolateRight: 'clamp' });
  const isMiddle = captions.position === 'middle';
  const positionTransform = isMiddle ? 'translateY(-50%) ' : '';

  return (
    <AbsoluteFill style={{ alignItems: 'center', pointerEvents: 'none' }}>
      <div
        style={{
          position: 'absolute',
          top: isMiddle ? '50%' : undefined,
          bottom: isMiddle ? undefined : 92 * scale,
          maxWidth: '82%',
          padding: `${14 * scale}px ${30 * scale}px`,
          borderRadius: 18 * scale,
          background: 'rgba(2, 6, 23, 0.62)',
          color: captions.inactiveColor,
          fontSize: captions.fontSize * scale,
          fontWeight: 900,
          lineHeight: 1.2,
          textAlign: 'center',
          textShadow: '0 3px 10px rgba(0,0,0,0.85), 0 0 2px rgba(0,0,0,0.95)',
          WebkitTextStroke: `${Math.max(1, 2 * scale)}px rgba(0,0,0,0.52)`,
          transform: `${positionTransform}scale(${pop})`,
          whiteSpace: 'pre-wrap',
        }}
      >
        {active.group.words.map((word, index) => (
          <span
            key={`${word.startMs}-${index}`}
            style={{
              color: index === active.activeIndex ? captions.activeColor : captions.inactiveColor,
            }}
          >
            {captionTokenText(index > 0 ? active.group.words[index - 1] : undefined, word)}
          </span>
        ))}
      </div>
    </AbsoluteFill>
  );
}

function findActiveCaption(scenes: VideoScene[], currentMs: number) {
  let offset = 0;
  for (const scene of scenes) {
    const durationMs = scene.duration * 1000;
    if (currentMs >= offset && currentMs < offset + durationMs) {
      return findCaptionContext(scene.captions, currentMs - offset);
    }
    offset += durationMs;
  }
  return undefined;
}
