import { Film, LayoutDashboard, ListVideo, PenLine } from 'lucide-react';
import ExportPage from './pages/ExportPage';
import PreviewPage from './pages/PreviewPage';
import SceneManager from './pages/SceneManager';
import ScriptEditor from './pages/ScriptEditor';
import { useVideoStore } from './store/useVideoStore';

const nav = [
  { key: 'script', label: '脚本', icon: PenLine },
  { key: 'scenes', label: '场景', icon: ListVideo },
  { key: 'preview', label: '预览', icon: LayoutDashboard },
  { key: 'export', label: '导出', icon: Film },
] as const;

export default function App() {
  const activePage = useVideoStore((state) => state.activePage);
  const setActivePage = useVideoStore((state) => state.setActivePage);

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <span>WebClaw</span>
          <strong>Video Creator</strong>
        </div>
        <nav className="nav-list">
          {nav.map((item) => {
            const Icon = item.icon;
            return (
              <button
                className={activePage === item.key ? 'nav-item active' : 'nav-item'}
                key={item.key}
                onClick={() => setActivePage(item.key)}
                title={item.label}
              >
                <Icon size={18} />
                <span>{item.label}</span>
              </button>
            );
          })}
        </nav>
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
