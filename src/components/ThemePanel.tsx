import { Check, Palette, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

const STORAGE_KEY = 'webclaw-video-creator-theme';

const ACCENTS = {
  teal: {
    label: '青绿',
    accent: '#14b8a6',
    ink: '#0d9488',
    deep: '#0f766e',
    tint: '#ecfbf7',
    tint2: '#d6f5ee',
  },
  indigo: {
    label: '藏蓝',
    accent: '#6366f1',
    ink: '#4f46e5',
    deep: '#4338ca',
    tint: '#eef0ff',
    tint2: '#e0e3fe',
  },
  violet: {
    label: '紫罗兰',
    accent: '#8b5cf6',
    ink: '#7c3aed',
    deep: '#6d28d9',
    tint: '#f4effe',
    tint2: '#e9defc',
  },
  blue: {
    label: '天蓝',
    accent: '#3b82f6',
    ink: '#2563eb',
    deep: '#1d4ed8',
    tint: '#eaf2ff',
    tint2: '#d8e6ff',
  },
  rose: {
    label: '玫红',
    accent: '#f43f5e',
    ink: '#e11d48',
    deep: '#be123c',
    tint: '#fff0f2',
    tint2: '#ffe1e6',
  },
  amber: {
    label: '琥珀',
    accent: '#f59e0b',
    ink: '#d97706',
    deep: '#b45309',
    tint: '#fff8eb',
    tint2: '#fdedcf',
  },
  graphite: {
    label: '石墨',
    accent: '#475569',
    ink: '#334155',
    deep: '#1e293b',
    tint: '#f1f4f8',
    tint2: '#e2e8f0',
  },
} as const;

const RADII = {
  sharp: { label: '直角', values: ['4px', '6px', '9px', '12px'] },
  medium: { label: '适中', values: ['7px', '10px', '14px', '18px'] },
  round: { label: '圆润', values: ['10px', '14px', '18px', '24px'] },
} as const;

type AccentKey = keyof typeof ACCENTS;
type RadiusKey = keyof typeof RADII;

interface ThemePrefs {
  accent: AccentKey;
  radius: RadiusKey;
}

const DEFAULT_PREFS: ThemePrefs = {
  accent: 'indigo',
  radius: 'medium',
};

function readPrefs(): ThemePrefs {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? (JSON.parse(raw) as Partial<ThemePrefs>) : {};
    return {
      accent: parsed.accent && parsed.accent in ACCENTS ? parsed.accent : DEFAULT_PREFS.accent,
      radius: parsed.radius && parsed.radius in RADII ? parsed.radius : DEFAULT_PREFS.radius,
    };
  } catch {
    return DEFAULT_PREFS;
  }
}

function applyTheme(prefs: ThemePrefs) {
  const accent = ACCENTS[prefs.accent];
  const [sm, md, lg, xl] = RADII[prefs.radius].values;
  const root = document.documentElement.style;

  root.setProperty('--accent', accent.accent);
  root.setProperty('--accent-ink', accent.ink);
  root.setProperty('--accent-deep', accent.deep);
  root.setProperty('--accent-tint', accent.tint);
  root.setProperty('--accent-tint-2', accent.tint2);
  root.setProperty('--r-sm', sm);
  root.setProperty('--r-md', md);
  root.setProperty('--r-lg', lg);
  root.setProperty('--r-xl', xl);
}

export default function ThemePanel() {
  const [open, setOpen] = useState(false);
  const [prefs, setPrefs] = useState<ThemePrefs>(() => readPrefs());
  const currentAccent = useMemo(() => ACCENTS[prefs.accent], [prefs.accent]);

  useEffect(() => {
    applyTheme(prefs);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
  }, [prefs]);

  const updatePrefs = (patch: Partial<ThemePrefs>) => {
    setPrefs((current) => ({ ...current, ...patch }));
  };

  return (
    <>
      <button className="btn btn-ghost btn-sm" onClick={() => setOpen(true)} title="打开调色面板">
        <Palette size={14} />
        主题
      </button>
      {open && (
        <div className="theme-panel" role="dialog" aria-label="调色面板">
          <div className="theme-panel-head">
            <div>
              <strong>调色面板</strong>
              <span>{currentAccent.label} · {RADII[prefs.radius].label}</span>
            </div>
            <button className="theme-close" onClick={() => setOpen(false)} title="关闭">
              <X size={15} />
            </button>
          </div>
          <div className="theme-panel-body">
            <section className="theme-section">
              <span className="theme-section-title">主色调</span>
              <div className="swatch-grid">
                {Object.entries(ACCENTS).map(([key, accent]) => {
                  const selected = prefs.accent === key;
                  return (
                    <button
                      className={selected ? 'swatch active' : 'swatch'}
                      key={key}
                      onClick={() => updatePrefs({ accent: key as AccentKey })}
                      title={accent.label}
                    >
                      <span style={{ background: accent.accent }} />
                      <em style={{ background: accent.tint }} />
                      {selected && <Check size={14} />}
                    </button>
                  );
                })}
              </div>
            </section>
            <section className="theme-section">
              <span className="theme-section-title">外观</span>
              <div className="radius-segment">
                {Object.entries(RADII).map(([key, radius]) => (
                  <button
                    className={prefs.radius === key ? 'active' : ''}
                    key={key}
                    onClick={() => updatePrefs({ radius: key as RadiusKey })}
                  >
                    {radius.label}
                  </button>
                ))}
              </div>
            </section>
            <button className="theme-reset" onClick={() => updatePrefs(DEFAULT_PREFS)}>
              恢复默认
            </button>
          </div>
        </div>
      )}
    </>
  );
}
