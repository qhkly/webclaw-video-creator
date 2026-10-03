// Module-level controller for agent runs: one event listener and one approval
// poller for the app's lifetime, so a run keeps streaming while the user works
// on other pages (scenes, cutter, export).
import { useAgentStore } from '../store/useAgentStore';
import { onAgentEvent, pendingApprovals, startAgent, stopAgent } from './agent-bridge';
import { parseAgentLine } from './agent-events';

const APPROVAL_POLL_MS = 700;
let listening: Promise<unknown> | null = null;
let pollTimer: number | undefined;
let stderrTail: string[] = [];
let sawDone = false;

export function ensureAgentListener() {
  listening ??= onAgentEvent((raw) => {
    const store = useAgentStore.getState();
    if (raw.runId !== store.runId || !store.runCli) {
      return;
    }
    if (raw.stream === 'stdout' && raw.line) {
      for (const event of parseAgentLine(store.runCli, raw.line)) {
        if (event.kind === 'done') {
          sawDone = true;
        }
        store.append(event);
      }
    } else if (raw.stream === 'stderr' && raw.line) {
      stderrTail = [...stderrTail, raw.line].slice(-12);
    } else if (raw.stream === 'exit') {
      stopPolling();
      if (store.status === 'stopped') {
        return;
      }
      const failed = raw.code !== 0;
      if (failed && !sawDone) {
        store.append({ kind: 'error', message: stderrTail.join('\n') || `CLI exited with code ${raw.code}` });
      }
      const lastDone = [...useAgentStore.getState().timeline].reverse().find((item) => item.event.kind === 'done');
      const ok = !failed && (!lastDone || (lastDone.event.kind === 'done' && lastDone.event.ok));
      store.finishRun(ok ? 'done' : 'failed');
    }
  }).catch((error) => {
    listening = null;
    throw error;
  });
  return listening;
}

export async function runAgentTask() {
  const store = useAgentStore.getState();
  await ensureAgentListener();
  const run = await startAgent({
    task: store.task,
    cli: store.cliChoice,
    model: store.model || undefined,
    approval: store.approvalMode,
    project: store.project.trim(),
  });
  stderrTail = [];
  sawDone = false;
  store.beginRun(run.runId, run.cli);
  startPolling(run.runId);
  return run;
}

export async function stopAgentTask() {
  const { runId, finishRun } = useAgentStore.getState();
  if (!runId) {
    return;
  }
  stopPolling();
  finishRun('stopped');
  await stopAgent(runId);
}

function startPolling(runId: string) {
  stopPolling();
  pollTimer = window.setInterval(() => {
    void pendingApprovals(runId)
      .then((approvals) => {
        if (useAgentStore.getState().runId === runId) {
          useAgentStore.getState().setApprovals(approvals);
        }
      })
      .catch(() => {});
  }, APPROVAL_POLL_MS);
}

function stopPolling() {
  if (pollTimer !== undefined) {
    window.clearInterval(pollTimer);
    pollTimer = undefined;
  }
}
