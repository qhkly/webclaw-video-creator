import { Check, Monitor, Moon, Palette, Sun, X } from 'lucide-react';
import { useLayoutEffect, useMemo, useState } from 'react';

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

const MODES = {
  light: { label: '浅色', icon: Sun },
  dark: { label: '深色', icon: Moon },
  system: { label: '系统', icon: Monitor },
} as const;

type AccentKey = keyof typeof ACCENTS;
type RadiusKey = keyof typeof RADII;
type ThemeMode = keyof typeof MODES;
type ResolvedThemeMode = Exclude<ThemeMode, 'system'>;

interface ThemePrefs {
  accent: AccentKey;
  radius: RadiusKey;
  mode: ThemeMode;
}

const DEFAULT_PREFS: ThemePrefs = {
  accent: 'indigo',
  radius: 'medium',
  mode: 'light',
};

const readPrefs = (): ThemePrefs => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? (JSON.parse(raw) as Partial<ThemePrefs>) : {};
    return {
      accent: parsed.accent && parsed.accent in ACCENTS ? parsed.accent : DEFAULT_PREFS.accent,
      radius: parsed.radius && parsed.radius in RADII ? parsed.radius : DEFAULT_PREFS.radius,
      mode: parsed.mode && parsed.mode in MODES ? parsed.mode : DEFAULT_PREFS.mode,
    };
  } catch {
    return DEFAULT_PREFS;
  }
};

const resolveThemeMode = (mode: ThemeMode): ResolvedThemeMode => {
  if (mode !== 'system') {
    return mode;
  }

  return window.matchMedia?.('(prefers-color-scheme: dark)')?.matches ? 'dark' : 'light';
};

const applyTheme = (prefs: ThemePrefs) => {
  const accent = ACCENTS[prefs.accent];
  const [sm, md, lg, xl] = RADII[prefs.radius].values;
  const resolvedMode = resolveThemeMode(prefs.mode);
  const root = document.documentElement;
  const style = root.style;

  root.dataset.theme = resolvedMode;
  root.dataset.themePreference = prefs.mode;
  style.colorScheme = resolvedMode;

  style.setProperty('--accent', accent.accent);
  if (resolvedMode === 'dark') {
    style.setProperty('--accent-ink', `color-mix(in srgb, ${accent.accent} 86%, white)`);
    style.setProperty('--accent-deep', `color-mix(in srgb, ${accent.accent} 70%, white)`);
    style.setProperty('--accent-tint', `color-mix(in srgb, ${accent.accent} 14%, var(--surface))`);
    style.setProperty('--accent-tint-2', `color-mix(in srgb, ${accent.accent} 23%, var(--surface))`);
  } else {
    style.setProperty('--accent-ink', accent.ink);
    style.setProperty('--accent-deep', accent.deep);
    style.setProperty('--accent-tint', accent.tint);
    style.setProperty('--accent-tint-2', accent.tint2);
  }
  style.setProperty('--r-sm', sm);
  style.setProperty('--r-md', md);
  style.setProperty('--r-lg', lg);
  style.setProperty('--r-xl', xl);
};

export default function ThemePanel() {
  const [open, setOpen] = useState(false);
  const [prefs, setPrefs] = useState<ThemePrefs>(() => readPrefs());
  const currentAccent = useMemo(() => ACCENTS[prefs.accent], [prefs.accent]);

  useLayoutEffect(() => {
    applyTheme(prefs);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));

    if (prefs.mode !== 'system') {
      return undefined;
    }

    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const handleSystemThemeChange = () => applyTheme(prefs);
    media.addEventListener('change', handleSystemThemeChange);
    return () => media.removeEventListener('change', handleSystemThemeChange);
  }, [prefs]);

  const updatePrefs = (patch: Partial<ThemePrefs>) => {
    setPrefs((current) => ({ ...current, ...patch }));
  };

  return (
    <>
      <button className="btn btn-ghost btn-sm" onClick={() => setOpen(true)} title="打开主题设置">
        <Palette size={14} />
        主题
      </button>
      {open && (
        <div className="theme-panel" role="dialog" aria-label="主题设置">
          <div className="theme-panel-head">
            <div>
              <strong>主题设置</strong>
              <span>{MODES[prefs.mode].label} · {currentAccent.label} · {RADII[prefs.radius].label}</span>
            </div>
            <button className="theme-close" onClick={() => setOpen(false)} title="关闭">
              <X size={15} />
            </button>
          </div>
          <div className="theme-panel-body">
            <section className="theme-section">
              <span className="theme-section-title">明暗模式</span>
              <div className="theme-mode-segment">
                {Object.entries(MODES).map(([key, mode]) => {
                  const Icon = mode.icon;
                  return (
                    <button
                      className={prefs.mode === key ? 'active' : ''}
                      key={key}
                      onClick={() => updatePrefs({ mode: key as ThemeMode })}
                      aria-pressed={prefs.mode === key}
                    >
                      <Icon size={13} />
                      {mode.label}
                    </button>
                  );
                })}
              </div>
            </section>
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
              <span className="theme-section-title">圆角</span>
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
