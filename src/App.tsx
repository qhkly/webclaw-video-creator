import { Download, Film, LayoutDashboard, ListVideo, PenLine, Play, Volume2 } from 'lucide-react';
import ExportPage from './pages/ExportPage';
import PreviewPage from './pages/PreviewPage';
import SceneManager from './pages/SceneManager';
import ScriptEditor from './pages/ScriptEditor';
import ThemePanel from './components/ThemePanel';
import { useVideoStore } from './store/useVideoStore';
import { useI18n, type Locale } from './i18n';

const NAV_KEYS = ['script', 'scenes', 'preview', 'export'] as const;
const NAV_ICONS = { script: PenLine, scenes: ListVideo, preview: LayoutDashboard, export: Film };
const NAV_STEPS = { script: '01', scenes: '02', preview: '03', export: '04' };

const LOCALES: Locale[] = ['zh-CN', 'en-US'];
const LOCALE_LABELS: Record<Locale, string> = { 'zh-CN': '中文', 'en-US': 'EN' };

export default function App() {
  const activePage = useVideoStore((state) => state.activePage);
  const setActivePage = useVideoStore((state) => state.setActivePage);
  const scenes = useVideoStore((state) => state.scenes);
  const aspect = useVideoStore((state) => state.aspect);
  const { t, locale, setLocale } = useI18n();
  const totalSeconds = scenes.reduce((total, scene) => total + scene.duration, 0);
  const voicedCount = scenes.filter((scene) => scene.audio).length;

  return (
    <div className="app">
      <header className="titlebar">
        <div className="tb-project">
          <span className="dot" />
          <span>{t.app.projectName}</span>
          <span className="badge">{aspect}</span>
          <span className="badge">{totalSeconds}s</span>
        </div>
        <div className="tb-right">
          <ThemePanel />
          <button className="btn btn-ghost btn-sm" onClick={() => setActivePage('preview')}>
            <Play size={14} />
            {t.nav.preview}
          </button>
          <button className="btn btn-primary btn-sm" onClick={() => setActivePage('export')}>
            <Download size={14} />
            {t.nav.export}
          </button>
        </div>
      </header>

      <div className="body">
        <aside className="rail">
          <div className="brand">
            <div className="mark">
              <Film size={19} />
            </div>
            <div className="txt">
              <b>WebClaw</b>
              <span>Video Creator</span>
            </div>
          </div>
          <div className="nav-label">{t.app.workflow}</div>
          <nav className="nav">
          {NAV_KEYS.map((key) => {
            const Icon = NAV_ICONS[key];
            const label = t.nav[key];
            return (
              <button
                className={activePage === key ? 'nav-item active' : 'nav-item'}
                key={key}
                onClick={() => setActivePage(key)}
                title={label}
              >
                <Icon size={18} />
                <span>{label}</span>
                <span className="step">{NAV_STEPS[key]}</span>
              </button>
            );
          })}
          </nav>
          <div className="rail-sep" />
          <div className="rail-foot">
            <div className="rail-card">
              <div className="t">
                <Volume2 size={14} />
                {t.app.voiceProgress}
              </div>
              <div className="d">
                {voicedCount} / {scenes.length} {t.app.voiceProgressDesc}
              </div>
              <div className="rail-progress">
                <div style={{ width: `${scenes.length ? (voicedCount / scenes.length) * 100 : 0}%` }} />
              </div>
            </div>
            <div className="locale-switcher">
              {LOCALES.map((loc) => (
                <button
                  key={loc}
                  className={locale === loc ? 'locale-btn active' : 'locale-btn'}
                  onClick={() => setLocale(loc)}
                >
                  {LOCALE_LABELS[loc]}
                </button>
              ))}
            </div>
          </div>
        </aside>
        <main className="main">
          {activePage === 'script' && <ScriptEditor />}
          {activePage === 'scenes' && <SceneManager />}
          {activePage === 'preview' && <PreviewPage />}
          {activePage === 'export' && <ExportPage />}
        </main>
      </div>
    </div>
  );
}
