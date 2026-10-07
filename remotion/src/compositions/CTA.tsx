import { AbsoluteFill, Img, interpolate, spring, useVideoConfig } from 'remotion';
import { mediaSrc } from '../media';
import { useScale } from '../useScale';

interface Props {
  kicker?: unknown;
  title?: unknown;
  subtitle?: unknown;
  actionText?: unknown;
  logoSrc?: unknown;
  bgColor?: unknown;
  accent?: unknown;
  fallbackTitle: string;
  frame: number;
}

/**
 * Brand closer / call-to-action. Deliberately its own design (not a reused
 * TitleSlide): glow + smooth spring, no bouncy entrances — see
 * docs/remotion-best-practices.md §2 and §7.
 */
export default function CTA({ kicker, title, subtitle, actionText, logoSrc, bgColor, accent, fallbackTitle, frame }: Props) {
  const { fps } = useVideoConfig();
  const scale = useScale();
  const accentColor = typeof accent === 'string' && accent ? accent : '#7c5cff';
  // damping 200 = smooth, no bounce (official recommendation for subtle reveals).
  const rise = spring({ frame, fps, config: { damping: 200 } });
  const glow = interpolate(frame, [0, 45], [0, 1], { extrapolateRight: 'clamp' });
  const fade = interpolate(frame, [18, 42], [0, 1], { extrapolateRight: 'clamp' });
  const actionPulse = 1 + interpolate(Math.sin(frame / 22), [-1, 1], [0, 0.025]);
  const logo = typeof logoSrc === 'string' && logoSrc ? mediaSrc(logoSrc) : '';

  return (
    <AbsoluteFill
      style={{
        alignItems: 'center',
        justifyContent: 'center',
        background: `radial-gradient(circle at 50% 36%, ${accentColor}2e 0%, transparent 58%), ${String(bgColor || '#0b1026')}`,
        color: '#f8fafc',
      }}
    >
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          padding: `0 ${120 * scale}px`,
          opacity: glow,
          transform: `translateY(${(1 - rise) * 46 * scale}px)`,
        }}
      >
        {logo ? (
          <Img
            src={logo}
            style={{ height: 132 * scale, width: 'auto', marginBottom: 44 * scale, objectFit: 'contain' }}
          />
        ) : null}
        {kicker ? (
          <span
            style={{
              fontSize: 30 * scale,
              fontWeight: 700,
              letterSpacing: `${6 * scale}px`,
              textTransform: 'uppercase',
              color: accentColor,
              opacity: fade,
            }}
          >
            {String(kicker)}
          </span>
        ) : null}
        <h1
          style={{
            margin: `${(kicker ? 26 : 0) * scale}px 0 0`,
            fontSize: 92 * scale,
            lineHeight: 1.08,
            textAlign: 'center',
            opacity: fade,
          }}
        >
          {String(title || fallbackTitle)}
        </h1>
        {subtitle ? (
          <p style={{ margin: `${30 * scale}px 0 0`, fontSize: 38 * scale, lineHeight: 1.3, color: '#cbd5e1', textAlign: 'center', opacity: fade }}>
            {String(subtitle)}
          </p>
        ) : null}
        {actionText ? (
          <span
            style={{
              marginTop: 52 * scale,
              padding: `${20 * scale}px ${54 * scale}px`,
              borderRadius: 999,
              background: accentColor,
              color: '#ffffff',
              fontSize: 36 * scale,
              fontWeight: 800,
              transform: `scale(${actionPulse})`,
            }}
          >
            {String(actionText)}
          </span>
        ) : null}
      </div>
    </AbsoluteFill>
  );
}
