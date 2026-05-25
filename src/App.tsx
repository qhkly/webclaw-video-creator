import { Film, LayoutDashboard, ListVideo, PenLine } from 'lucide-react';
import ExportPage from './pages/ExportPage';
import PreviewPage from './pages/PreviewPage';
import SceneManager from './pages/SceneManager';
import ScriptEditor from './pages/ScriptEditor';
import { useVideoStore } from './store/useVideoStore';
import { useI18n, type Locale } from './i18n';

const NAV_KEYS = ['script', 'scenes', 'preview', 'export'] as const;
const NAV_ICONS = { script: PenLine, scenes: ListVideo, preview: LayoutDashboard, export: Film };

const LOCALES: Locale[] = ['zh-CN', 'en-US'];
const LOCALE_LABELS: Record<Locale, string> = { 'zh-CN': '中文', 'en-US': 'EN' };

export default function App() {
  const activePage = useVideoStore((state) => state.activePage);
  const setActivePage = useVideoStore((state) => state.setActivePage);
  const { t, locale, setLocale } = useI18n();

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <span>WebClaw</span>
          <strong>Video Creator</strong>
        </div>
        <nav className="nav-list">
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
              </button>
            );
          })}
        </nav>
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
      </aside>
      <main className="workspace">
        {activePage === 'script' && <ScriptEditor />}
        {activePage === 'scenes' && <SceneManager />}
        {activePage === 'preview' && <PreviewPage />}
        {activePage === 'export' && <ExportPage />}
      </main>
    </div>
  );
}
