import { create } from 'zustand';
import type { AgentCliChoice, AgentCliInfo, ApprovalMode, ApprovalRequest } from '../lib/agent-bridge';
import type { AgentCliId, AgentEvent } from '../lib/agent-events';

export type RunStatus = 'idle' | 'running' | 'done' | 'failed' | 'stopped';

export interface TimelineItem {
  key: string;
  event: AgentEvent | { kind: 'log'; text: string };
}

interface AgentStore {
  clis: AgentCliInfo[];
  cliChoice: AgentCliChoice;
  model: string;
  approvalMode: ApprovalMode;
  project: string;
  task: string;
  runId: string | null;
  runCli: AgentCliId | null;
  status: RunStatus;
  timeline: TimelineItem[];
  approvals: ApprovalRequest[];
  setClis: (clis: AgentCliInfo[]) => void;
  setCliChoice: (cliChoice: AgentCliChoice) => void;
  setModel: (model: string) => void;
  setApprovalMode: (approvalMode: ApprovalMode) => void;
  setProject: (project: string) => void;
  setTask: (task: string) => void;
  beginRun: (runId: string, cli: AgentCliId) => void;
  append: (event: TimelineItem['event']) => void;
  finishRun: (status: RunStatus) => void;
  setApprovals: (approvals: ApprovalRequest[]) => void;
}

let sequence = 0;

export const useAgentStore = create<AgentStore>((set) => ({
  clis: [],
  cliChoice: 'auto',
  model: '',
  approvalMode: 'auto',
  project: 'my-video',
  task: '',
  runId: null,
  runCli: null,
  status: 'idle',
  timeline: [],
  approvals: [],
  setClis: (clis) => set({ clis }),
  setCliChoice: (cliChoice) => set({ cliChoice }),
  setModel: (model) => set({ model }),
  setApprovalMode: (approvalMode) => set({ approvalMode }),
  setProject: (project) => set({ project }),
  setTask: (task) => set({ task }),
  beginRun: (runId, runCli) => set({ runId, runCli, status: 'running', timeline: [], approvals: [] }),
  append: (event) => set((state) => ({ timeline: [...state.timeline, { key: `e${sequence++}`, event }] })),
  finishRun: (status) => set({ status, approvals: [] }),
  setApprovals: (approvals) => set({ approvals }),
}));
