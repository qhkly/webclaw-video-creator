import { AbsoluteFill, interpolate } from 'remotion';
import { useScale } from '../useScale';

interface Props {
  stat?: unknown;
  label?: unknown;
  bgColor?: unknown;
  fallbackTitle: string;
  frame: number;
}

export default function BigStat({ stat, label, bgColor, fallbackTitle, frame }: Props) {
  const opacity = interpolate(frame, [0, 18], [0, 1], { extrapolateRight: 'clamp' });
  const scale = useScale();

  return (
    <AbsoluteFill
      style={{
        alignItems: 'center',
        justifyContent: 'center',
        background: String(bgColor || '#134e4a'),
        color: '#f8fafc',
        opacity,
        textAlign: 'center',
      }}
    >
      <div style={{ fontSize: 260 * scale, fontWeight: 900, lineHeight: 0.9 }}>{String(stat || '5×')}</div>
      <div style={{ marginTop: 36 * scale, fontSize: 48 * scale, color: '#cbd5e1', fontWeight: 700 }}>
        {String(label || fallbackTitle)}
      </div>
    </AbsoluteFill>
  );
}
