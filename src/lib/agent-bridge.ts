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
