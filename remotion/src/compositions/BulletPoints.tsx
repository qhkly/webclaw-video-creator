import { AbsoluteFill, interpolate } from 'remotion';

interface Props {
  title?: unknown;
  bullets?: unknown;
  accent?: unknown;
  fallbackTitle: string;
  frame: number;
}

export default function BulletPoints({ title, bullets, accent, fallbackTitle, frame }: Props) {
  const items = Array.isArray(bullets) ? bullets.map(String) : [];
  const accentColor = String(accent || '#22c55e');

  return (
    <AbsoluteFill style={{ background: '#f8fafc', color: '#172033', padding: '120px 150px' }}>
      <h1 style={{ margin: 0, fontSize: 78, lineHeight: 1.1 }}>{String(title || fallbackTitle)}</h1>
      <div style={{ display: 'grid', gap: 28, marginTop: 72 }}>
        {items.map((item, index) => {
          const start = 18 + index * 14;
          const opacity = interpolate(frame, [start, start + 12], [0, 1], { extrapolateRight: 'clamp' });
          const x = interpolate(frame, [start, start + 12], [80, 0], { extrapolateRight: 'clamp' });
          return (
            <div
              key={item}
              style={{
                display: 'grid',
                gridTemplateColumns: '32px 1fr',
                gap: 24,
                alignItems: 'start',
                opacity,
                transform: `translateX(${x}px)`,
                fontSize: 44,
                lineHeight: 1.25,
              }}
            >
              <span style={{ width: 20, height: 20, marginTop: 18, background: accentColor, borderRadius: 20 }} />
              <span>{item}</span>
            </div>
          );
        })}
      </div>
    </AbsoluteFill>
  );
}
