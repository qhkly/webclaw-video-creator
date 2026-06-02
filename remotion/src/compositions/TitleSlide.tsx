import { AbsoluteFill, interpolate, spring, useVideoConfig } from 'remotion';
import { useScale } from '../useScale';

interface Props {
  title?: unknown;
  subtitle?: unknown;
  bgColor?: unknown;
  fallbackTitle: string;
  frame: number;
}

export default function TitleSlide({ title, subtitle, bgColor, fallbackTitle, frame }: Props) {
  const { fps } = useVideoConfig();
  const scale = useScale();
  const progress = spring({ frame, fps, config: { damping: 18 } });
  const opacity = interpolate(frame, [0, 20], [0, 1], { extrapolateRight: 'clamp' });

  return (
    <AbsoluteFill
      style={{
        justifyContent: 'center',
        padding: 150 * scale,
        background: String(bgColor || '#111827'),
        color: '#f8fafc',
      }}
    >
      <h1
        style={{
          margin: 0,
          fontSize: 104 * scale,
          lineHeight: 1,
          opacity,
          transform: `translateY(${(1 - progress) * 80 * scale}px)`,
        }}
      >
        {String(title || fallbackTitle)}
      </h1>
      <p
        style={{
          margin: `${36 * scale}px 0 0`,
          maxWidth: 1200 * scale,
          fontSize: 44 * scale,
          lineHeight: 1.25,
          color: '#cbd5e1',
          opacity: interpolate(frame, [15, 35], [0, 1], { extrapolateRight: 'clamp' }),
        }}
      >
        {String(subtitle || '')}
      </p>
    </AbsoluteFill>
  );
}
