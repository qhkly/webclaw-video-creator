import { AbsoluteFill, Img, interpolate } from 'remotion';

interface Props {
  imageSrc?: unknown;
  caption?: unknown;
  subtitle?: unknown;
  fallbackTitle: string;
  frame: number;
}

export default function ImageFrame({ imageSrc, caption, subtitle, fallbackTitle, frame }: Props) {
  const opacity = interpolate(frame, [0, 24], [0, 1], { extrapolateRight: 'clamp' });
  const src = String(imageSrc || '');

  return (
    <AbsoluteFill style={{ background: '#e7edf5', color: '#172033', padding: 96 }}>
      <h1 style={{ margin: 0, fontSize: 62 }}>{String(caption || fallbackTitle)}</h1>
      <div
        style={{
          marginTop: 46,
          height: 720,
          borderRadius: 18,
          background: '#ffffff',
          border: '1px solid #cbd5e1',
          display: 'grid',
          placeItems: 'center',
          overflow: 'hidden',
          opacity,
        }}
      >
        {src ? (
          <Img src={src} style={{ width: '100%', height: '100%', objectFit: 'contain' }} />
        ) : (
          <span style={{ color: '#64748b', fontSize: 42 }}>Drop screenshot or diagram path into props</span>
        )}
      </div>
      <p style={{ margin: '30px 0 0', fontSize: 34, color: '#475569' }}>{String(subtitle || '')}</p>
    </AbsoluteFill>
  );
}
