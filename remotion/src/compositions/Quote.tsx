import { AbsoluteFill, interpolate } from 'remotion';
import { useScale } from '../useScale';

interface Props {
  quote?: unknown;
  author?: unknown;
  bgColor?: unknown;
  fallbackTitle: string;
  frame: number;
}

export default function Quote({ quote, author, bgColor, fallbackTitle, frame }: Props) {
  const opacity = interpolate(frame, [0, 18], [0, 1], { extrapolateRight: 'clamp' });
  const scale = useScale();

  return (
    <AbsoluteFill
      style={{
        justifyContent: 'center',
        padding: 170 * scale,
        background: String(bgColor || '#0a0f1c'),
        color: '#f8fafc',
        opacity,
      }}
    >
      <div style={{ color: '#818cf8', fontFamily: 'Georgia, serif', fontSize: 180 * scale, lineHeight: 0.5 }}>“</div>
      <blockquote style={{ margin: `${30 * scale}px 0 0`, fontSize: 74 * scale, lineHeight: 1.25, fontWeight: 800 }}>
        {String(quote || fallbackTitle)}
      </blockquote>
      <div style={{ marginTop: 56 * scale, color: '#818cf8', fontSize: 40 * scale, fontWeight: 700 }}>
        — {String(author || 'WebClaw')}
      </div>
    </AbsoluteFill>
  );
}
