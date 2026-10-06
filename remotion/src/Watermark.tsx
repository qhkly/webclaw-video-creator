import { AbsoluteFill, useVideoConfig } from 'remotion';

/**
 * Free-plan watermark, rendered into the frame (not a player overlay), bottom-right.
 * Sized from the composition so it reads the same at every export scale; same placement
 * as the FFmpeg overlay in scripts/lib/plan.mjs (watermarkBox).
 */
export function Watermark() {
  const { width, height } = useVideoConfig();
  const boxWidth = width * (width >= height ? 0.26 : 0.42);
  const margin = Math.min(width, height) * 0.03;
  return (
    <AbsoluteFill style={{ pointerEvents: 'none' }}>
      <div
        style={{
          position: 'absolute',
          right: margin,
          bottom: margin,
          width: boxWidth,
          textAlign: 'right',
          fontFamily: 'Arial, Helvetica, sans-serif',
          fontWeight: 800,
          fontSize: boxWidth / 11,
          lineHeight: 1,
          whiteSpace: 'nowrap',
          color: 'rgba(255, 255, 255, 0.85)',
          WebkitTextStroke: `${Math.max(1, boxWidth / 240)}px rgba(0, 0, 0, 0.45)`,
          textShadow: '0 2px 6px rgba(0, 0, 0, 0.35)',
        }}
      >
        WebClaw Video Creator
      </div>
    </AbsoluteFill>
  );
}
