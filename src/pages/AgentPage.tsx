import { Bot, Check, ChevronDown, ChevronRight, CircleAlert, Film, ListVideo, Loader2, RefreshCw, Send, ShieldCheck, Square, Wrench, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { chatgptStatus, decideApproval, detectAgentClis, previewSrc, projectSnapshot, type ApprovalRequest, type ChatgptActivity, type ProjectSnapshot } from '../lib/agent-bridge';
import type { AgentEvent } from '../lib/agent-events';
import { ensureAgentListener, runAgentTask, stopAgentTask } from '../lib/agent-runtime';
import { useAgentStore, type TimelineItem } from '../store/useAgentStore';
import { useVideoStore } from '../store/useVideoStore';
import { useI18n } from '../i18n';
import './agent.css';

const REFRESH_TOOLS = new Set(['video_scenes_save', 'video_tts_synthesize', 'video_render', 'video_audio_mux']);

export default function AgentPage() {
  const { t } = useI18n();
  const store = useAgentStore();
  const loadProject = useVideoStore((state) => state.loadProject);
  const setActivePage = useVideoStore((state) => state.setActivePage);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [startError, setStartError] = useState('');
  const [snapshot, setSnapshot] = useState<ProjectSnapshot | null>(null);
  const [remoteActivity, setRemoteActivity] = useState<ChatgptActivity[]>([]);
  const running = store.status === 'running';
  const projectValid = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(store.project.trim());

  useEffect(() => {
    void ensureAgentListener();
    if (store.clis.length === 0) {
      void detectAgentClis().then(store.setClis).catch(() => store.setClis([]));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const refreshSnapshot = useCallback(() => {
    if (!projectValid) {
      return;
    }
    void projectSnapshot(store.project.trim())
      .then(setSnapshot)
      .catch(() => setSnapshot(null));
  }, [store.project, projectValid]);

  useEffect(refreshSnapshot, [refreshSnapshot]);

  useEffect(() => {
    let cancelled = false;
    const refreshRemote = async () => {
      try {
        const info = await chatgptStatus();
        if (cancelled) return;
        const activity = info.status?.recentActivity ?? [];
        setRemoteActivity(activity);
        const latestProject = [...activity].reverse().find((item) => item.project)?.project;
        if (latestProject && store.status !== 'running' && latestProject !== store.project) {
          store.setProject(latestProject);
        }
      } catch {
        if (!cancelled) setRemoteActivity([]);
      }
    };
    void refreshRemote();
    const timer = window.setInterval(() => void refreshRemote(), 1500);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [store.status, store.project, store.setProject]);

  async function openProject(project: string) {
    const next = await projectSnapshot(project);
    if (!next.scenes) return;
    loadProject(next.project, next.dir, next.scenes, 0);
    setActivePage('scenes');
  }

  // Refresh results whenever a tool that produces files finishes, and when the run ends.
  const toolNames = useMemo(() => {
    const names = new Map<string, string>();
    for (const item of store.timeline) {
      if (item.event.kind === 'tool_call') {
        names.set(item.event.id, item.event.tool);
      }
    }
    return names;
  }, [store.timeline]);
  const lastItem = store.timeline[store.timeline.length - 1];
  useEffect(() => {
    if (!lastItem) {
      return;
    }
    const { event } = lastItem;
    if (event.kind === 'done' || (event.kind === 'tool_result' && REFRESH_TOOLS.has(toolNames.get(event.id) ?? ''))) {
      refreshSnapshot();
    }
  }, [lastItem, toolNames, refreshSnapshot]);

  const activeCli = store.clis.find((cli) => cli.id === (store.runCli ?? (store.cliChoice === 'auto' ? store.clis.find((item) => item.available)?.id : store.cliChoice)));
  const anyCli = store.clis.some((cli) => cli.available);
  const latestRender = snapshot?.renders[0];

  async function start() {
    setStartError('');
    try {
      await runAgentTask();
    } catch (error) {
      setStartError(String(error));
    }
  }

  return (
    <section className="page agent-page rise">
      <header className="page-head head-row">
        <div>
          <h1>{t.agent.title}</h1>
          <p>{t.agent.desc}</p>
        </div>
        <div className="header-pills">
          <span className={`pill ${activeCli?.available ? 'pill-accent' : 'pill-muted'}`} title={activeCli?.path}>
            <Bot size={13} />
            {activeCli ? `${activeCli.label}${activeCli.version ? ` · ${activeCli.version}` : ''}` : store.clis.length === 0 ? t.agent.detecting : t.agent.noCli}
          </span>
          <span className={`pill ${running ? 'pill-accent' : 'pill-muted'}`}>
            {running && <Loader2 size={13} className="spin" />}
            {t.agent.status[store.status]}
          </span>
        </div>
      </header>

      <div className="card agent-composer">
        <textarea
          className="textarea agent-task"
          value={store.task}
          placeholder={t.agent.placeholder}
          disabled={running}
          onChange={(event) => store.setTask(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !running && store.task.trim() && projectValid) {
              void start();
            }
          }}
        />
        {!store.task && !running && (
          <div className="agent-suggestions">
            {t.agent.suggestions.map((suggestion) => (
              <button key={suggestion} className="chip" onClick={() => store.setTask(suggestion)}>
                {suggestion}
              </button>
            ))}
          </div>
        )}
        <div className="agent-composer-bar">
          <label className="agent-project">
            <span>{t.agent.project}</span>
            <input className="input" value={store.project} disabled={running} onChange={(event) => store.setProject(event.target.value)} />
          </label>
          <button className="btn btn-ghost btn-sm" onClick={() => setShowAdvanced(!showAdvanced)}>
            {showAdvanced ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            {t.agent.advanced}
          </button>
          <div className="spacer" />
          {running ? (
            <button className="btn btn-ghost" onClick={() => void stopAgentTask()}>
              <Square size={14} />
              {t.agent.stop}
            </button>
          ) : (
            <button className="btn btn-primary" disabled={!store.task.trim() || !projectValid || !anyCli} onClick={() => void start()}>
              <Send size={14} />
              {t.agent.start}
            </button>
          )}
        </div>
        {showAdvanced && (
          <div className="agent-advanced">
            <label>
              <span>{t.agent.cli}</span>
              <select className="input" value={store.cliChoice} disabled={running} onChange={(event) => store.setCliChoice(event.target.value as typeof store.cliChoice)}>
                <option value="auto">{t.agent.cliAuto}</option>
                {store.clis.map((cli) => (
                  <option key={cli.id} value={cli.id} disabled={!cli.available}>
                    {cli.label} {cli.available ? `(${cli.version})` : `— ${t.agent.notInstalled}`}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>{t.agent.model}</span>
              <input className="input" value={store.model} placeholder={t.agent.modelPlaceholder} disabled={running} onChange={(event) => store.setModel(event.target.value)} />
            </label>
            <label>
              <span>{t.agent.approval}</span>
              <select className="input" value={store.approvalMode} disabled={running} onChange={(event) => store.setApprovalMode(event.target.value as typeof store.approvalMode)}>
                <option value="auto">{t.agent.approvalAuto}</option>
                <option value="ask">{t.agent.approvalAsk}</option>
              </select>
            </label>
            <p className="agent-hint">{t.agent.safetyNote}</p>
          </div>
        )}
        {(startError || (!anyCli && store.clis.length > 0) || !projectValid) && (
          <div className="agent-alert">
            <CircleAlert size={14} />
            {startError || (!projectValid ? t.agent.invalidProject : t.agent.installHint)}
          </div>
        )}
      </div>

      <div className="card agent-remote">
        <div className="card-toolbar">
          <b>{t.agent.remoteProgress}</b>
          {remoteActivity.length > 0 && (
            <span className="tag-dim">{remoteActivity.length}</span>
          )}
        </div>
        {remoteActivity.length === 0 ? (
          <div className="agent-empty">{t.agent.remoteEmpty}</div>
        ) : (
          <ol className="agent-events agent-remote-events">
            {[...remoteActivity].reverse().map((item) => (
              <li key={item.id} className={item.state === 'error' ? 'ev ev-fail' : item.state === 'done' ? 'ev ev-ok' : 'ev ev-tool'}>
                {item.state === 'started' ? <Loader2 size={13} className="spin" /> : item.state === 'done' ? <Check size={13} /> : <CircleAlert size={13} />}
                <b>{t.agent.tools[item.tool] ?? item.tool}</b>
                {item.summary && <code>{item.summary}</code>}
                {item.project && (
                  <button className="btn btn-soft btn-sm agent-remote-open" onClick={() => void openProject(item.project!)}>
                    {t.agent.remoteProject}
                  </button>
                )}
              </li>
            ))}
          </ol>
        )}
      </div>

      <div className="agent-grid">
        <div className="card agent-timeline">
          <div className="card-toolbar">
            <b>{t.agent.progress}</b>
          </div>
          {store.approvals.map((request) => (
            <ApprovalCard key={request.id} request={request} runId={store.runId} />
          ))}
          {store.timeline.length === 0 ? (
            <div className="agent-empty">{t.agent.emptyTimeline}</div>
          ) : (
            <ol className="agent-events">
              {store.timeline.map((item) => (
                <TimelineRow key={item.key} item={item} toolNames={toolNames} />
              ))}
            </ol>
          )}
        </div>

        <div className="card agent-results">
          <div className="card-toolbar">
            <b>{t.agent.results}</b>
            <button className="btn btn-ghost btn-sm icon-only" title={t.agent.refresh} onClick={refreshSnapshot}>
              <RefreshCw size={14} />
            </button>
          </div>
          {latestRender ? (
            <video key={latestRender.path} className="agent-video" src={previewSrc(latestRender.path)} controls />
          ) : (
            <div className="agent-video agent-video-empty">
              <Film size={22} />
              <span>{t.agent.noRender}</span>
            </div>
          )}
          <div className="agent-result-list">
            {snapshot?.renders.map((render) => (
              <div key={render.path} className="agent-result-row" title={render.path}>
                <Film size={14} />
                <span>{render.name}</span>
                <em>{(render.size / 1024 / 1024).toFixed(1)} MB</em>
              </div>
            ))}
            <div className="agent-result-row">
              <ListVideo size={14} />
              <span>
                {snapshot?.scenes ? `${snapshot.scenes.length} ${t.agent.scenesUnit}` : t.agent.noScenes}
              </span>
              {snapshot?.scenes && (
                <button
                  className="btn btn-soft btn-sm"
                  onClick={() => void openProject(snapshot.project)}
                >
                  {t.agent.openInEditor}
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

export function ApprovalCard({ request, runId }: { request: ApprovalRequest; runId: string | null }) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const decide = async (allow: boolean) => {
    if (!runId) {
      return;
    }
    setBusy(true);
    // On success the request disappears with the next poll; on failure (e.g. already expired) let the user retry.
    await decideApproval(runId, request.id, allow).catch(() => setBusy(false));
  };
  return (
    <div className="agent-approval">
      <div className="agent-approval-head">
        <ShieldCheck size={15} />
        <b>{t.agent.approvalTitle}</b>
        <span className="pill pill-muted">{t.agent.tools[request.tool] ?? request.tool}</span>
        {request.cost === 'paid' && <span className="pill pill-warn">{t.agent.paid}</span>}
      </div>
      <pre>{JSON.stringify(request.arguments ?? {}, null, 2).slice(0, 1200)}</pre>
      <div className="agent-approval-actions">
        <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void decide(false)}>
          <X size={14} />
          {t.agent.deny}
        </button>
        <button className="btn btn-primary btn-sm" disabled={busy} onClick={() => void decide(true)}>
          <Check size={14} />
          {t.agent.allow}
        </button>
      </div>
    </div>
  );
}

function TimelineRow({ item, toolNames }: { item: TimelineItem; toolNames: Map<string, string> }) {
  const { t } = useI18n();
  const event = item.event as AgentEvent | { kind: 'log'; text: string };
  switch (event.kind) {
    case 'session':
      return <li className="ev ev-muted">{t.agent.sessionStarted}</li>;
    case 'text':
      return <li className="ev ev-text">{event.text}</li>;
    case 'tool_call':
      return (
        <li className="ev ev-tool">
          <Wrench size={13} />
          <b>{t.agent.tools[event.tool] ?? event.tool}</b>
          <code>{summarizeArgs(event.args)}</code>
        </li>
      );
    case 'tool_result':
      return (
        <li className={event.ok ? 'ev ev-ok' : 'ev ev-fail'}>
          {event.ok ? <Check size={13} /> : <CircleAlert size={13} />}
          <span>{t.agent.tools[toolNames.get(event.id) ?? ''] ?? toolNames.get(event.id) ?? ''}</span>
          <code>{event.ok ? summarizeResult(event.data, event.summary) : event.summary.slice(0, 400)}</code>
        </li>
      );
    case 'done':
      return (
        <li className={event.ok ? 'ev ev-done' : 'ev ev-fail'}>
          {event.ok ? <Check size={14} /> : <CircleAlert size={14} />}
          <div>
            <b>{event.ok ? t.agent.finished : t.agent.failed}</b>
            {event.summary && <p>{event.summary}</p>}
            {event.costUsd !== undefined && <em>{t.agent.cost} ${event.costUsd.toFixed(4)}</em>}
            {event.denied && <em>{t.agent.denied}: {event.denied.join(', ')}</em>}
          </div>
        </li>
      );
    case 'error':
      return (
        <li className="ev ev-fail">
          <CircleAlert size={13} />
          <code>{event.message}</code>
        </li>
      );
    default:
      return <li className="ev ev-muted">{event.text}</li>;
  }
}

function summarizeArgs(args: Record<string, unknown>) {
  const text = Object.entries(args)
    .filter(([key]) => key !== 'scenes')
    .map(([key, value]) => `${key}=${typeof value === 'string' ? value : JSON.stringify(value)}`)
    .join(' ');
  const scenes = Array.isArray(args.scenes) ? ` scenes×${args.scenes.length}` : '';
  return (text + scenes).slice(0, 220);
}

function summarizeResult(data: unknown, fallback: string) {
  if (data && typeof data === 'object') {
    const record = data as Record<string, unknown>;
    const parts = ['output', 'path', 'sceneCount', 'duration', 'attachedToScene']
      .filter((key) => record[key] !== undefined && record[key] !== null)
      .map((key) => `${key}=${typeof record[key] === 'number' ? Number(record[key]).toFixed(key === 'duration' ? 1 : 0) : record[key]}`);
    if (parts.length > 0) {
      return parts.join(' ');
    }
  }
  return fallback.replace(/\s+/g, ' ').slice(0, 220);
}
