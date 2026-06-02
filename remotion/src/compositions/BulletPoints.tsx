import { AbsoluteFill, interpolate } from 'remotion';
import { useScale } from '../useScale';

interface Props {
  title?: unknown;
  bullets?: unknown;
  accent?: unknown;
  bgColor?: unknown;
  fallbackTitle: string;
  frame: number;
}

export default function BulletPoints({ title, bullets, accent, bgColor, fallbackTitle, frame }: Props) {
  const items = Array.isArray(bullets) ? bullets.map(String) : [];
  const accentColor = String(accent || '#818cf8');
  const scale = useScale();

  return (
    <AbsoluteFill style={{ background: String(bgColor || '#0b1220'), color: '#f8fafc', padding: `${120 * scale}px ${150 * scale}px` }}>
      <h1 style={{ margin: 0, fontSize: 78 * scale, lineHeight: 1.1 }}>{String(title || fallbackTitle)}</h1>
      <div style={{ display: 'grid', gap: 28 * scale, marginTop: 72 * scale }}>
        {items.map((item, index) => {
          const start = 18 + index * 14;
          const opacity = interpolate(frame, [start, start + 12], [0, 1], { extrapolateRight: 'clamp' });
          const x = interpolate(frame, [start, start + 12], [80, 0], { extrapolateRight: 'clamp' });
          return (
            <div
              key={item}
              style={{
                display: 'grid',
                gridTemplateColumns: `${32 * scale}px 1fr`,
                gap: 24 * scale,
                alignItems: 'start',
                opacity,
                transform: `translateX(${x * scale}px)`,
                fontSize: 44 * scale,
                lineHeight: 1.25,
              }}
            >
              <span style={{ width: 20 * scale, height: 20 * scale, marginTop: 18 * scale, background: accentColor, borderRadius: 20 * scale }} />
              <span>{item}</span>
            </div>
          );
        })}
      </div>
    </AbsoluteFill>
  );
}
