import { AbsoluteFill, Img, interpolate, spring, useVideoConfig } from 'remotion';
import { mediaSrc } from '../media';
import { useScale } from '../useScale';

interface Props {
  imageSrc?: unknown;
  caption?: unknown;
  subtitle?: unknown;
  fallbackTitle: string;
  frame: number;
}

export default function ImageFrame({ imageSrc, caption, subtitle, fallbackTitle, frame }: Props) {
  const { fps, durationInFrames } = useVideoConfig();
  const scale = useScale();
  // Restrained motion per docs/remotion-best-practices.md: a smooth spring
  // reveal (damping 200, no bounce) plus a slow Ken Burns drift on the image,
  // never a static card and never a flashy effect.
  const reveal = spring({ frame, fps, config: { damping: 200 } });
  const opacity = interpolate(frame, [0, 24], [0, 1], { extrapolateRight: 'clamp' });
  const zoom = interpolate(frame, [0, Math.max(1, durationInFrames)], [1.02, 1.1], { extrapolateRight: 'clamp' });
  const drift = interpolate(frame, [0, Math.max(1, durationInFrames)], [-10, 10], { extrapolateRight: 'clamp' });
  const src = mediaSrc(String(imageSrc || ''));

  return (
    <AbsoluteFill style={{ background: '#e7edf5', color: '#172033', padding: 96 * scale }}>
      <h1 style={{ margin: 0, fontSize: 62 * scale }}>{String(caption || fallbackTitle)}</h1>
      <div
        style={{
          marginTop: 46 * scale,
          height: 720 * scale,
          borderRadius: 18 * scale,
          background: '#ffffff',
          border: '1px solid #cbd5e1',
          display: 'grid',
          placeItems: 'center',
          overflow: 'hidden',
          opacity,
          transform: `translateY(${(1 - reveal) * 28 * scale}px)`,
          boxShadow: '0 24px 60px rgba(15, 23, 42, 0.18)',
        }}
      >
        {src ? (
          <Img
            src={src}
            style={{
              width: '100%',
              height: '100%',
              objectFit: 'contain',
              transform: `scale(${zoom}) translate3d(${drift}px, 0, 0)`,
            }}
          />
        ) : (
          <span style={{ color: '#64748b', fontSize: 42 * scale }}>Drop screenshot or diagram path into props</span>
        )}
      </div>
      <p style={{ margin: `${30 * scale}px 0 0`, fontSize: 34 * scale, color: '#475569' }}>{String(subtitle || '')}</p>
    </AbsoluteFill>
  );
}
