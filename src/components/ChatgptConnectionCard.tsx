import { ExternalLink, Loader2, Play, PlugZap, Save, Square } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { useI18n } from '../i18n';
import { FeatureGateNotice, useGate } from './AccountPanel';
import {
  CHATGPT_RUN_ID,
  OPENAI_API_KEY_CONSOLE_URL,
  OPENAI_TUNNEL_CONSOLE_URL,
  OPENAI_TUNNEL_DOCS_URL,
  chatgptSaveConfig,
  chatgptStart,
  chatgptStatus,
  chatgptStop,
  openExternalUrl,
  pendingApprovals,
  type ApprovalMode,
  type ApprovalRequest,
  type ChatgptStatus,
} from '../lib/agent-bridge';
import { ApprovalCard } from '../pages/AgentPage';
import '../pages/agent.css';

const POLL_MS = 2000;

/** Settings card for the ChatGPT connection (local HTTP MCP on 32159 + OpenAI Secure Tunnel). */
export default function ChatgptConnectionCard() {
  const { t } = useI18n();
  // The bridge itself may run; every tool call is checked against the plan by the MCP server.
  const directorGate = useGate('agent.director');
  const c = t.chatgpt;
  const [info, setInfo] = useState<ChatgptStatus | null>(null);
  const [approvals, setApprovals] = useState<ApprovalRequest[]>([]);
  const [tunnelId, setTunnelId] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [autoStart, setAutoStart] = useState(false);
  const [approval, setApproval] = useState<ApprovalMode>('ask');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');

  const refresh = useCallback(async () => {
    try {
      const next = await chatgptStatus();
      setInfo(next);
      setApprovals(next.running ? await pendingApprovals(CHATGPT_RUN_ID) : []);
      return next;
    } catch (error) {
      setMessage(String(error));
      return null;
    }
  }, []);

  useEffect(() => {
    void refresh().then((next) => {
      if (next) {
        setTunnelId(next.config.tunnelId);
        setAutoStart(next.config.autoStart);
        setApproval(next.config.approval);
      }
    });
    const timer = window.setInterval(() => void refresh(), POLL_MS);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const act = async (action: () => Promise<unknown>, done?: string) => {
    setBusy(true);
    setMessage('');
    try {
      await action();
      if (done) {
        setMessage(done);
      }
    } catch (error) {
      setMessage(String(error));
    } finally {
      setBusy(false);
      void refresh();
    }
  };

  const save = (clearApiKey = false) =>
    act(async () => {
      await chatgptSaveConfig({ tunnelId, apiKey: apiKey || undefined, clearApiKey, autoStart, approval });
      setApiKey('');
    }, c.saved);

  const running = info?.running ?? false;
  const state = running ? info?.status?.state ?? 'starting' : 'stopped';
  const tunnel = info?.status?.tunnel;
  const chatgptActivity = info?.status?.chatgpt;
  const error = (running ? info?.status?.error ?? tunnel?.error : info?.lastError) ?? null;
  const config = info?.config;
  const workspaceMissing = state === 'workspace_access_missing' || tunnel?.workspaceAccess === 'missing';

  const pillClass =
    state === 'running'
      ? 'pill-accent'
      : state === 'error' || state === 'workspace_access_missing'
        ? 'pill-warn'
        : state === 'awaiting_chatgpt'
          ? 'pill-awaiting'
          : 'pill-muted';

  const workspaceFact = !running
    ? null
    : tunnel?.workspaceAccess == null
      ? { text: c.workspaceNotChecked, tone: 'dim' }
      : tunnel.workspaceAccess === 'associated'
        ? { text: `${c.workspaceAssociated}（${tunnel.workspaceCount} ${c.workspaceAssociatedCount}）`, tone: 'ok' }
        : tunnel.workspaceAccess === 'missing'
          ? { text: c.workspaceMissing, tone: 'err' }
          : { text: c.workspaceUnknown, tone: 'warn' };

  return (
    <div className="card settings-card chatgpt-card">
      <span className="field-label">
        <PlugZap size={14} />
        {c.title}
      </span>
      <p className="settings-hint">{c.desc}</p>
      <FeatureGateNotice access={directorGate.access} message={t.account.proOnly.chatgpt} />

      <div className="chatgpt-status">
        <span className={`pill ${pillClass}`}>
          {state === 'starting' && <Loader2 size={12} className="spin" />}
          {c.states[state] ?? state}
        </span>
        {running && tunnel && (
          <span className="tag-dim">
            {c.tunnel}: {c.tunnelStates[tunnel.state] ?? tunnel.state}
          </span>
        )}
      </div>

      {running && info?.status && (
        <dl className="chatgpt-facts">
          <dt>{c.diagMcp}</dt>
          <dd className={info.status.mcp.port ? 'chatgpt-diag-ok' : 'chatgpt-diag-err'}>
            {info.status.mcp.port ? `127.0.0.1:${info.status.mcp.port}` : '—'}
          </dd>
          <dt>{c.diagTunnel}</dt>
          <dd className={tunnel?.state === 'running' ? 'chatgpt-diag-ok' : tunnel?.state === 'error' ? 'chatgpt-diag-err' : 'chatgpt-diag-warn'}>
            {tunnel ? c.tunnelStates[tunnel.state] ?? tunnel.state : '—'}
          </dd>
          <dt>{c.diagWorkspace}</dt>
          <dd
            className={
              workspaceFact?.tone === 'ok'
                ? 'chatgpt-diag-ok'
                : workspaceFact?.tone === 'err'
                  ? 'chatgpt-diag-err'
                  : workspaceFact?.tone === 'warn'
                    ? 'chatgpt-diag-warn'
                    : undefined
            }
          >
            {workspaceFact?.text ?? '—'}
          </dd>
          <dt>{c.diagChatgpt}</dt>
          <dd className={chatgptActivity?.seen ? 'chatgpt-diag-ok' : 'chatgpt-diag-warn'}>
            {chatgptActivity?.seen
              ? `${c.chatgptSeen}${chatgptActivity.lastMethod ? `（${chatgptActivity.lastMethod}）` : ''}`
              : c.chatgptAwaiting}
          </dd>
        </dl>
      )}

      {workspaceMissing && running && (
        <div className="chatgpt-ws-banner">
          <span className="chatgpt-ws-title">{c.wsBannerTitle}</span>
          <p>{c.wsBannerSteps}</p>
          <button type="button" className="chatgpt-link" onClick={() => void openExternalUrl(OPENAI_TUNNEL_CONSOLE_URL)}>
            {c.wsBannerAction}
            <ExternalLink size={12} />
          </button>
        </div>
      )}
      <dl className="chatgpt-facts">
        <dt>{c.localPort}</dt>
        <dd>
          <code>127.0.0.1:{info?.port ?? 32159}</code>
        </dd>
        <dt>{c.tunnelId}</dt>
        <dd>
          <code>{config?.tunnelId || '—'}</code>
        </dd>
        <dt>API Key</dt>
        <dd>{config?.hasApiKey ? `${c.apiKeySaved} (${config.apiKeyHint})` : c.apiKeyMissing}</dd>
        {running && info?.status && (
          <>
            <dt>{c.tools}</dt>
            <dd>{info.status.toolCount}</dd>
            <dt>{c.requests}</dt>
            <dd>
              {info.status.requestCount}
              {info.status.lastTool ? ` · ${t.agent.tools[info.status.lastTool] ?? info.status.lastTool}` : ''}
            </dd>
          </>
        )}
      </dl>
      {error && <p className="chatgpt-error">{error}</p>}

      {approvals.length > 0 && (
        <div className="chatgpt-approvals">
          <span className="field-label">{c.pending}</span>
          {approvals.map((request) => (
            <ApprovalCard key={request.id} request={request} runId={CHATGPT_RUN_ID} />
          ))}
        </div>
      )}

      <div className="chatgpt-field">
        <div className="chatgpt-field-head">
          <label className="field-label" htmlFor="chatgpt-tunnel-id">
            {c.tunnelId}
          </label>
          <button type="button" className="chatgpt-link" onClick={() => void openExternalUrl(OPENAI_TUNNEL_CONSOLE_URL)}>
            {c.createTunnel}
            <ExternalLink size={12} />
          </button>
        </div>
        <input
          id="chatgpt-tunnel-id"
          className="input"
          value={tunnelId}
          onChange={(event) => setTunnelId(event.target.value)}
          placeholder={c.tunnelIdPlaceholder}
          spellCheck={false}
        />
      </div>
      <div className="chatgpt-field">
        <div className="chatgpt-field-head">
          <label className="field-label" htmlFor="chatgpt-api-key">
            {c.apiKey}
          </label>
          <button type="button" className="chatgpt-link" onClick={() => void openExternalUrl(OPENAI_API_KEY_CONSOLE_URL)}>
            {c.createApiKey}
            <ExternalLink size={12} />
          </button>
        </div>
        <input
          id="chatgpt-api-key"
          className="input"
          type="password"
          autoComplete="off"
          value={apiKey}
          onChange={(event) => setApiKey(event.target.value)}
          placeholder={config?.hasApiKey ? c.apiKeyKeep : 'sk-...'}
        />
        <p className="settings-hint">
          {c.apiKeyHelp}{' '}
          <button type="button" className="chatgpt-link chatgpt-link-inline" onClick={() => void openExternalUrl(OPENAI_TUNNEL_DOCS_URL)}>
            {c.docs}
            <ExternalLink size={12} />
          </button>
        </p>
      </div>
      <label>
        <span className="field-label">{c.approval}</span>
        <select className="select" value={approval} onChange={(event) => setApproval(event.target.value as ApprovalMode)}>
          <option value="ask">{c.approvalAsk}</option>
          <option value="auto">{c.approvalAuto}</option>
        </select>
      </label>
      <label className="toggle-row">
        <input type="checkbox" checked={autoStart} onChange={(event) => setAutoStart(event.target.checked)} />
        <span>{c.autoStart}</span>
      </label>

      <div className="chatgpt-actions">
        {running ? (
          <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void act(chatgptStop)}>
            <Square size={14} />
            {c.stop}
          </button>
        ) : (
          <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void act(chatgptStart)}>
            <Play size={14} />
            {c.start}
          </button>
        )}
        <button className="btn btn-primary btn-sm" disabled={busy} onClick={() => void save()}>
          <Save size={14} />
          {c.save}
        </button>
        {config?.hasApiKey && (
          <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void save(true)}>
            {c.clearKey}
          </button>
        )}
      </div>
      {message && <span className="tag-dim">{message}</span>}
      <p className="settings-hint">{c.help}</p>
      {info?.logPath && (
        <span className="tag-dim">
          {c.log}: {info.logPath}
        </span>
      )}
    </div>
  );
}
