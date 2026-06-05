import { AbsoluteFill, interpolate, useCurrentFrame, useVideoConfig } from 'remotion';
import type { CaptionSettings, VideoScene, WordToken } from '../../src/types';
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

  const active = findActiveWord(scenes, currentMs);
  if (!active) {
    return null;
  }

  const progress = Math.max(0, currentMs - active.startMs);
  const pop = interpolate(progress, [0, 120], [0.88, 1], { extrapolateRight: 'clamp' });
  const top = captions.position === 'middle' ? '55%' : undefined;
  const bottom = captions.position === 'bottom' ? 92 * scale : undefined;

  return (
    <AbsoluteFill style={{ justifyContent: 'flex-end', alignItems: 'center', pointerEvents: 'none' }}>
      <div
        style={{
          position: 'absolute',
          top,
          bottom,
          maxWidth: '82%',
          padding: `${14 * scale}px ${30 * scale}px`,
          borderRadius: 18 * scale,
          background: 'rgba(2, 6, 23, 0.58)',
          color: captions.inactiveColor,
          fontSize: captions.fontSize * scale,
          fontWeight: 900,
          lineHeight: 1.16,
          textAlign: 'center',
          textShadow: '0 3px 10px rgba(0,0,0,0.85), 0 0 2px rgba(0,0,0,0.95)',
          WebkitTextStroke: `${Math.max(1, 2 * scale)}px rgba(0,0,0,0.52)`,
          transform: `scale(${pop})`,
        }}
      >
        <span style={{ color: captions.activeColor }}>{active.text}</span>
      </div>
    </AbsoluteFill>
  );
}

function findActiveWord(scenes: VideoScene[], currentMs: number): WordToken | undefined {
  let offset = 0;
  for (const scene of scenes) {
    const durationMs = scene.duration * 1000;
    if (currentMs >= offset && currentMs < offset + durationMs) {
      const localMs = currentMs - offset;
      return scene.captions?.find((word) => localMs >= word.startMs && localMs <= word.startMs + Math.max(80, word.durationMs));
    }
    offset += durationMs;
  }
  return undefined;
}
