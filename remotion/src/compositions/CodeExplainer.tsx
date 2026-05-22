import { AbsoluteFill, interpolate } from 'remotion';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneLight } from 'react-syntax-highlighter/dist/esm/styles/prism';

interface Props {
  code?: unknown;
  language?: unknown;
  highlightLines?: unknown;
  caption?: unknown;
  fallbackTitle: string;
  frame: number;
}

export default function CodeExplainer({ code, language, highlightLines, caption, fallbackTitle, frame }: Props) {
  const source = String(code || '// Add code in scene props');
  const highlighted = Array.isArray(highlightLines) ? highlightLines.map(Number) : [];
  const activeLine = highlighted[Math.floor(frame / 30) % Math.max(1, highlighted.length)] || 1;
  const opacity = interpolate(frame, [0, 20], [0, 1], { extrapolateRight: 'clamp' });

  return (
    <AbsoluteFill style={{ background: '#101624', color: '#f8fafc', padding: 96 }}>
      <h1 style={{ margin: '0 0 34px', fontSize: 58 }}>{String(caption || fallbackTitle)}</h1>
      <div
        style={{
          overflow: 'hidden',
          borderRadius: 18,
          border: '1px solid rgba(148, 163, 184, 0.25)',
          boxShadow: '0 30px 90px rgba(0, 0, 0, 0.28)',
          opacity,
        }}
      >
        <SyntaxHighlighter
          language={String(language || 'typescript')}
          style={oneLight}
          wrapLines
          showLineNumbers
          customStyle={{ margin: 0, padding: 42, fontSize: 34, lineHeight: 1.45, minHeight: 640 }}
          lineProps={(lineNumber: number) => ({
            style: {
              display: 'block',
              background: lineNumber === activeLine ? 'rgba(14, 165, 233, 0.18)' : 'transparent',
            },
          })}
        >
          {source}
        </SyntaxHighlighter>
      </div>
    </AbsoluteFill>
  );
}
