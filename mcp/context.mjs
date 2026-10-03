// Runtime context shared by every MCP tool: where the app lives, where the
// video workspace lives, and how to run the existing sidecar scripts / ffmpeg.
//
// Write rule: every file a tool *creates* must land inside the workspace.
// Read rule: user material (recordings, footage) may live anywhere, so reads
// accept absolute paths; relative paths resolve against the workspace.
import { access, constants, mkdir, realpath } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function createContext({ workspace } = {}) {
  const root = resolve(workspace || process.env.VIDEO_CREATOR_WORKSPACE || join(APP_ROOT, '.video-work'));
  return {
    appRoot: APP_ROOT,
    workspace: root,
    readPath(path) {
      if (!path || typeof path !== 'string') {
        throw new ToolError('path must be a non-empty string');
      }
      return isAbsolute(path) ? path : resolve(root, path);
    },
    writePath(path) {
      if (!path || typeof path !== 'string') {
        throw new ToolError('path must be a non-empty string');
      }
      const target = resolve(root, path);
      if (!isInside(root, target)) {
        throw new ToolError(`refusing to write outside the workspace: ${path}`);
      }
      return target;
    },
    /** writePath plus a symlink check: the nearest existing ancestor must really live inside the workspace. */
    async safeWritePath(path) {
      const target = this.writePath(path);
      const realRoot = await realpath(root).catch(() => root);
      let probe = dirname(target);
      while (!(await exists(probe)) && probe !== dirname(probe)) {
        probe = dirname(probe);
      }
      if (!isInside(realRoot, await realpath(probe), { allowSelf: true })) {
        throw new ToolError(`refusing to write through a link that leaves the workspace: ${path}`);
      }
      return target;
    },
    projectDir(projectId) {
      if (!isProjectId(projectId)) {
        throw new ToolError('project must match [A-Za-z0-9][A-Za-z0-9._-]{0,63}');
      }
      return join(root, 'projects', projectId);
    },
    async ensureDir(path) {
      await mkdir(path, { recursive: true });
      return path;
    },
  };
}

export function isProjectId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value);
}

/** True when `target` is strictly inside `root` (or equal to it when allowSelf). */
function isInside(root, target, { allowSelf = false } = {}) {
  const rel = relative(root, target);
  if (rel === '') {
    return allowSelf;
  }
  return !rel.startsWith('..') && !isAbsolute(rel);
}

/** Errors the agent can act on (bad input, missing file). Reported as tool results with isError=true. */
export class ToolError extends Error {}

export async function exists(path) {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/** FFMPEG_PATH env, then ffmpeg-static, then `ffmpeg` on PATH — the Cutter's resolver, shared. */
export { findFfmpeg } from '../scripts/lib/media.mjs';

/** Run a process without inheriting stdio (stdout belongs to the MCP transport). */
export function run(command, args, { cwd, onStdoutLine, signal } = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    let child;
    try {
      child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], signal });
    } catch (error) {
      rejectPromise(error);
      return;
    }
    let stdout = '';
    let stderr = '';
    let buffer = '';
    child.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      stdout += text;
      if (onStdoutLine) {
        buffer += text;
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() ?? '';
        lines.forEach(onStdoutLine);
      }
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', (error) => rejectPromise(new ToolError(`failed to start ${command}: ${error.message}`)));
    child.on('close', (code) => resolvePromise({ code, stdout, stderr }));
  });
}

/** Run one of the existing `scripts/*.mjs` sidecars exactly like the Tauri commands do (cwd = app root). */
export function runScript(ctx, script, args, options = {}) {
  return run(process.execPath, [join(ctx.appRoot, 'scripts', script), ...args], { ...options, cwd: ctx.appRoot });
}

/** The sidecars print JSON lines; return the last parseable one matching `predicate`. */
export function lastJsonLine(stdout, predicate = () => true) {
  const lines = stdout.trim().split(/\r?\n/).reverse();
  for (const line of lines) {
    try {
      const value = JSON.parse(line);
      if (predicate(value)) {
        return value;
      }
    } catch {
      // not JSON
    }
  }
  return null;
}

export function scriptError(script, result) {
  const parsed = lastJsonLine(result.stderr, (value) => value && typeof value.error === 'string');
  const lines = result.stderr.trim().split('\n');
  const errorLine = lines.findIndex((line) => /^\s*(\w*Error|error):/.test(line));
  const excerpt = errorLine >= 0 ? lines.slice(errorLine, errorLine + 3) : lines.slice(-5);
  const detail = parsed?.error || excerpt.join('\n').trim() || `exit code ${result.code}`;
  return new ToolError(`${script} failed: ${detail}`);
}
