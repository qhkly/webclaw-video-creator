// Approval gate enforced by the tool provider itself, so it behaves the same
// whichever CLI (Claude Code, Codex, …) is directing. Active only when the host
// (the Video Creator app) sets VIDEO_CREATOR_APPROVAL_DIR; plain CLI use keeps
// relying on the CLI's own permission system.
//
// Channel: the server writes <dir>/<id>.request.json and waits for the host to
// write <dir>/<id>.decision.json = { "allow": boolean, "note"?: string }.
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { exists, ToolError } from './context.mjs';

export const APPROVAL_MODES = ['auto', 'ask'];

export function approvalFromEnv(env = process.env) {
  const dir = env.VIDEO_CREATOR_APPROVAL_DIR;
  if (!dir) {
    return null;
  }
  return {
    dir,
    mode: APPROVAL_MODES.includes(env.VIDEO_CREATOR_APPROVAL) ? env.VIDEO_CREATOR_APPROVAL : 'auto',
    timeoutMs: Number(env.VIDEO_CREATOR_APPROVAL_TIMEOUT_MS) || 15 * 60 * 1000,
    pollMs: 250,
  };
}

/**
 * Read-only tools never ask. Paid generation always asks. Everything else (local
 * or free-network work) asks only in "ask" mode.
 */
export function needsApproval(tool, mode) {
  if (tool.annotations?.readOnlyHint) {
    return false;
  }
  if (tool.cost === 'paid') {
    return true;
  }
  return mode === 'ask';
}

export async function requestApproval(approval, tool, args) {
  await mkdir(approval.dir, { recursive: true });
  const id = randomUUID();
  const requestPath = join(approval.dir, `${id}.request.json`);
  const decisionPath = join(approval.dir, `${id}.decision.json`);
  await writeFile(
    requestPath,
    JSON.stringify({ id, tool: tool.name, title: tool.title, cost: tool.cost ?? 'local', arguments: args, createdAt: new Date().toISOString() }, null, 2),
  );
  const deadline = Date.now() + approval.timeoutMs;
  try {
    while (Date.now() < deadline) {
      if (await exists(decisionPath)) {
        const decision = JSON.parse(await readFile(decisionPath, 'utf8'));
        if (decision.allow === true) {
          return;
        }
        throw new ToolError(`The user declined ${tool.name}${decision.note ? `: ${decision.note}` : ''}. Do not retry it unchanged; adjust the plan or ask the user.`);
      }
      await new Promise((resolve) => setTimeout(resolve, approval.pollMs));
    }
    throw new ToolError(`No approval for ${tool.name} within ${Math.round(approval.timeoutMs / 1000)}s; treat it as declined.`);
  } finally {
    await rm(requestPath, { force: true });
    await rm(decisionPath, { force: true });
  }
}
