import { convertFileSrc, invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { VideoScene } from '../types';
import type { AgentCliId } from './agent-events';

export type AgentCliChoice = 'auto' | AgentCliId;
export type ApprovalMode = 'auto' | 'ask';

export interface AgentCliInfo {
  id: AgentCliId;
  label: string;
  available: boolean;
  path?: string;
  version?: string;
}

export interface AgentRunInfo {
  runId: string;
  cli: AgentCliId;
  project: string;
}

export interface AgentRawEvent {
  runId: string;
  stream: 'stdout' | 'stderr' | 'exit';
  line?: string;
  code?: number | null;
}

export interface ApprovalRequest {
  id: string;
  tool: string;
  title?: string;
  cost?: string;
  arguments?: Record<string, unknown>;
  createdAt?: string;
}

export interface ProjectSnapshot {
  project: string;
  dir: string;
  scenes: VideoScene[] | null;
  renders: Array<{ name: string; path: string; size: number; modifiedMs: number }>;
}

export const detectAgentClis = () => invoke<AgentCliInfo[]>('agent_detect_clis');

export const startAgent = (params: { task: string; cli: AgentCliChoice; model?: string; approval: ApprovalMode; project: string }) =>
  invoke<AgentRunInfo>('agent_start', { params });

export const stopAgent = (runId: string) => invoke<boolean>('agent_stop', { runId });

export const pendingApprovals = (runId: string) => invoke<ApprovalRequest[]>('agent_pending_approvals', { runId });

export const decideApproval = (runId: string, approvalId: string, allow: boolean, note?: string) =>
  invoke<void>('agent_decide_approval', { runId, approvalId, allow, note });

export const projectSnapshot = (project: string) => invoke<ProjectSnapshot>('agent_project_snapshot', { project });

export const onAgentEvent = (handler: (event: AgentRawEvent) => void) =>
  listen<AgentRawEvent>('agent_event', (event) => handler(event.payload));

/** Rendered files live under .video-work, which the app allows on the asset protocol. */
export const previewSrc = (path: string) => convertFileSrc(path);

// ChatGPT connection (OpenAI Secure Tunnel). The API key is write-only from the UI: the view never contains it.
export const CHATGPT_RUN_ID = 'chatgpt';

export interface ChatgptConfigView {
  tunnelId: string;
  hasApiKey: boolean;
  apiKeyHint: string;
  autoStart: boolean;
  approval: ApprovalMode;
}

export interface ChatgptStatus {
  running: boolean;
  port: number;
  mcpUrl: string;
  status: null | {
    state: 'starting' | 'running' | 'mcp_only' | 'error' | 'stopped';
    toolCount: number;
    requestCount: number;
    lastRequestAt: string | null;
    lastTool: string | null;
    error: string | null;
    mcp: { port: number | null; url: string | null };
    tunnel: { state: string; tunnelId: string; source: string | null; error: string | null };
  };
  lastError: string | null;
  config: ChatgptConfigView;
  logPath: string;
}

export const chatgptStatus = () => invoke<ChatgptStatus>('chatgpt_status');

export const chatgptSaveConfig = (input: { tunnelId: string; apiKey?: string; clearApiKey?: boolean; autoStart: boolean; approval: ApprovalMode }) =>
  invoke<ChatgptConfigView>('chatgpt_save_config', { input });

export const chatgptStart = () => invoke<void>('chatgpt_start');

export const chatgptStop = () => invoke<void>('chatgpt_stop');

// Both credentials can only be created on the OpenAI platform; the card links straight to the right pages.
export const OPENAI_TUNNEL_CONSOLE_URL = 'https://platform.openai.com/settings/organization/tunnels';
export const OPENAI_API_KEY_CONSOLE_URL = 'https://platform.openai.com/api-keys';
export const OPENAI_TUNNEL_DOCS_URL = 'https://developers.openai.com/api/docs/guides/secure-mcp-tunnels';

/** System browser via the app's own allowlisted command; window.open as a last resort (e.g. plain `vite` dev). */
export const openExternalUrl = (url: string) =>
  invoke<void>('open_external_url', { url }).catch(() => {
    try {
      window.open(url, '_blank', 'noopener');
    } catch {
      // nothing else to try
    }
  });
