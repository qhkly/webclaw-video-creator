import { Download, Film, LayoutDashboard, ListVideo, PenLine, Play, Scissors, Settings, Sparkles, Volume2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import AgentPage from './pages/AgentPage';
import CutterPage from './pages/CutterPage';
import ExportPage from './pages/ExportPage';
import PreviewPage from './pages/PreviewPage';
import SceneManager from './pages/SceneManager';
import ScriptEditor from './pages/ScriptEditor';
import SettingsPanel from './pages/SettingsPanel';
import ThemePanel from './components/ThemePanel';
import { AccountRailCard } from './components/AccountPanel';
import { startAccountSync } from './store/useAccountStore';
import { getSettings } from './lib/tauri-bridge';
import { listProjects, projectSnapshot, saveProjectScenes, type ProjectSummary } from './lib/agent-bridge';
import { useVideoStore } from './store/useVideoStore';
import { useI18n, type Locale } from './i18n';

const NAV_KEYS = ['agent', 'cutter', 'script', 'scenes', 'preview', 'export', 'settings'] as const;
const NAV_ICONS = { agent: Sparkles, cutter: Scissors, script: PenLine, scenes: ListVideo, preview: LayoutDashboard, export: Film, settings: Settings };
const NAV_STEPS = { agent: 'AI', cutter: '00', script: '01', scenes: '02', preview: '03', export: '04', settings: '05' };

// The title-bar project badges and Preview/Export shortcuts belong to the scene workflow (script → scenes → preview →
// export). The AI Director and the Cutter have their own result/export flows, so the shortcuts are hidden there to
// avoid sending the user to the scene exporter with unrelated (demo) scenes.
const SCENE_WORKFLOW_PAGES = new Set<string>(['script', 'scenes', 'preview', 'export']);

const LOCALES: Locale[] = ['zh-CN', 'en-US'];
const LOCALE_LABELS: Record<Locale, string> = { 'zh-CN': '中文', 'en-US': 'EN' };

export default function App() {
  const activePage = useVideoStore((state) => state.activePage);
  const setActivePage = useVideoStore((state) => state.setActivePage);
  const setSettings = useVideoStore((state) => state.setSettings);
  const scenes = useVideoStore((state) => state.scenes);
  const currentProjectId = useVideoStore((state) => state.currentProjectId);
  const projectRevision = useVideoStore((state) => state.projectRevision);
  const savedProjectRevision = useVideoStore((state) => state.savedProjectRevision);
  const loadProject = useVideoStore((state) => state.loadProject);
  const markProjectSaved = useVideoStore((state) => state.markProjectSaved);
  const aspect = useVideoStore((state) => state.aspect);
  const { t, locale, setLocale } = useI18n();
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [projectBusy, setProjectBusy] = useState(false);
  const totalSeconds = scenes.reduce((total, scene) => total + scene.duration, 0);
  const voicedCount = scenes.filter((scene) => scene.audio).length;
  const inSceneWorkflow = SCENE_WORKFLOW_PAGES.has(activePage);

  const loadProjectById = useCallback(async (projectId: string, knownModifiedMs = 0) => {
    const snapshot = await projectSnapshot(projectId);
    if (!snapshot.scenes) {
      return;
    }
    loadProject(projectId, snapshot.dir, snapshot.scenes, knownModifiedMs);
  }, [loadProject]);

  useEffect(() => startAccountSync(), []);

  useEffect(() => {
    void getSettings()
      .then(setSettings)
      .catch(() => {});
  }, [setSettings]);

  // The stable app-data workspace is the source of truth for projects created
  // by ChatGPT, the built-in Agent, and the visual editor.
  useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      try {
        const next = await listProjects();
        if (cancelled) return;
        setProjects(next);
        const state = useVideoStore.getState();
        const dirty = state.projectRevision !== state.savedProjectRevision;
        if (!state.currentProjectId && next[0]) {
          await loadProjectById(next[0].id, next[0].modifiedMs);
          return;
        }
        if (!dirty && state.currentProjectId) {
          const current = next.find((item) => item.id === state.currentProjectId);
          if (current && current.modifiedMs > state.currentProjectModifiedMs) {
            await loadProjectById(current.id, current.modifiedMs);
          }
        }
      } catch {
        // Keep the current in-memory project if the workspace is temporarily unavailable.
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 2000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [loadProjectById]);

  // Visual edits to a disk-backed project are persisted atomically after a
  // short debounce. Loading a project resets both revisions so it never writes
  // the old demo scenes back over a ChatGPT-generated project.
  useEffect(() => {
    if (!currentProjectId || projectRevision === savedProjectRevision) {
      return undefined;
    }
    const revision = projectRevision;
    const timer = window.setTimeout(() => {
      void saveProjectScenes(currentProjectId, scenes)
        .then((result) => markProjectSaved(revision, result.modifiedMs))
        .catch(() => {});
    }, 700);
    return () => window.clearTimeout(timer);
  }, [currentProjectId, projectRevision, savedProjectRevision, scenes, markProjectSaved]);

  const switchProject = useCallback(async (projectId: string) => {
    if (!projectId || projectId === currentProjectId || projectBusy) {
      return;
    }
    setProjectBusy(true);
    try {
      const state = useVideoStore.getState();
      if (state.currentProjectId && state.projectRevision !== state.savedProjectRevision) {
        const saved = await saveProjectScenes(state.currentProjectId, state.scenes);
        state.markProjectSaved(state.projectRevision, saved.modifiedMs);
      }
      const summary = projects.find((item) => item.id === projectId);
      await loadProjectById(projectId, summary?.modifiedMs ?? 0);
    } finally {
      setProjectBusy(false);
    }
  }, [currentProjectId, projectBusy, projects, loadProjectById]);

  return (
    <div className="app">
      <header className="titlebar">
        <div className="tb-project">
          <span className="dot" />
          {inSceneWorkflow ? (
            projects.length > 0 ? (
              <select
                className="tb-project-select"
                value={currentProjectId ?? ''}
                disabled={projectBusy}
                aria-label={t.app.projectSelect}
                onChange={(event) => void switchProject(event.target.value)}
              >
                {!currentProjectId && <option value="">{t.app.projectName}</option>}
                {projects.map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.id}
                  </option>
                ))}
              </select>
            ) : (
              <span>{currentProjectId ?? t.app.projectName}</span>
            )
          ) : (
            <span>{t.nav[activePage]}</span>
          )}
          {inSceneWorkflow && currentProjectId && projectRevision !== savedProjectRevision && <span className="badge">{t.app.unsaved}</span>}
          {inSceneWorkflow && <span className="badge">{aspect}</span>}
          {inSceneWorkflow && <span className="badge">{totalSeconds}s</span>}
        </div>
        <div className="tb-right">
          <ThemePanel />
          {inSceneWorkflow && activePage !== 'preview' && (
            <button className="btn btn-ghost btn-sm" onClick={() => setActivePage('preview')}>
              <Play size={14} />
              {t.nav.preview}
            </button>
          )}
          {inSceneWorkflow && activePage !== 'export' && (
            <button className="btn btn-primary btn-sm" onClick={() => setActivePage('export')}>
              <Download size={14} />
              {t.nav.export}
            </button>
          )}
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
            <AccountRailCard />
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
          {activePage === 'agent' && <AgentPage />}
          {activePage === 'cutter' && <CutterPage />}
          {activePage === 'script' && <ScriptEditor />}
          {activePage === 'scenes' && <SceneManager />}
          {activePage === 'preview' && <PreviewPage />}
          {activePage === 'export' && <ExportPage />}
          {activePage === 'settings' && <SettingsPanel />}
        </main>
      </div>
    </div>
  );
}
