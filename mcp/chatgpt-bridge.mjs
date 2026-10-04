#!/usr/bin/env node
// ChatGPT connection for Video Creator: a loopback HTTP MCP server exposing only
// the video tools, plus OpenAI's tunnel-client so ChatGPT can reach it.
//
//   node mcp/chatgpt-bridge.mjs [--state-dir <dir>] [--workspace <dir>] [--port 32159] [--no-tunnel] [--parent-stdin]
//
//   ChatGPT custom MCP app -> api.openai.com -> tunnel-client (child process)
//                                            -> http://127.0.0.1:32159/mcp (this process)
//
// Independent from WebCode AI Studio: own port (never 32149), own state dir,
// own token, own tunnel-client child. The stdio entry (server.mjs) is untouched.
//
// State dir layout (Tauri passes <app config dir>/chatgpt):
//   config.json   { tunnelId, apiKey, autoStart, approval }  (0600, see chatgpt-config.mjs)
//   mcp-token     local Bearer injected by tunnel-client     (0600, stable across restarts)
//   status.json   live status for the UI (no secrets)
//   runtime/      per-run files: authorization (0600), health-url, tunnel.log, tunnel.pid
//   tools/        managed tunnel-client download cache
import { randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { createContext } from './context.mjs';
import { createMcpServer } from './protocol.mjs';
import { tools } from './tools.mjs';
import { DEFAULT_HTTP_PORT, startHttpMcp } from './http.mjs';
import { loadConfig, redactText, validTunnelId } from './chatgpt-config.mjs';
import {
  buildProbeArgs,
  buildRunArgs,
  controlPlaneErrorMessage,
  lastLine,
  parseLoopbackHealthUrl,
  resolveTunnelClient,
  runCapture,
  tunnelEnv,
} from './tunnel-client.mjs';

/** Approvals from remote calls land where the UI already looks (agent_pending_approvals with run id "chatgpt"). */
export const CHATGPT_RUN_ID = 'chatgpt';
const STARTUP_BUDGET_MS = 60_000;
const PROBE_TIMEOUT_MS = 20_000;

export function defaultStateDir(env = process.env) {
  return env.VIDEO_CREATOR_CHATGPT_DIR || join(homedir(), '.webclaw-video-creator', 'chatgpt');
}

export async function loadOrCreateToken(stateDir) {
  const path = join(stateDir, 'mcp-token');
  try {
    const existing = (await readFile(path, 'utf8')).trim();
    if (/^[0-9a-f]{64}$/.test(existing)) {
      return existing;
    }
  } catch {
    // first run
  }
  const token = randomBytes(32).toString('hex');
  await writePrivate(path, token);
  return token;
}

/**
 * Start the HTTP MCP endpoint and (when configured and enabled) the tunnel.
 * Resolves once the HTTP endpoint is listening; the tunnel comes up in the background.
 */
export async function startBridge({
  stateDir = defaultStateDir(),
  workspace,
  port = DEFAULT_HTTP_PORT,
  tunnel = true,
  env = process.env,
  log = () => {},
} = {}) {
  stateDir = resolve(stateDir);
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  const config = await loadConfig(join(stateDir, 'config.json'));
  const token = await loadOrCreateToken(stateDir);
  const secrets = [config.apiKey, token];
  const say = (message) => log(redactText(message, secrets));

  const ctx = createContext({ workspace });
  const approval = {
    dir: join(ctx.workspace, '.agent', 'runs', CHATGPT_RUN_ID, 'approvals'),
    mode: config.approval,
    timeoutMs: Number(env.VIDEO_CREATOR_APPROVAL_TIMEOUT_MS) || 10 * 60 * 1000,
    pollMs: 250,
  };
  const server = createMcpServer({ tools, ctx, approval, log: say });

  const status = {
    pid: process.pid,
    state: 'starting',
    startedAt: new Date().toISOString(),
    workspace: ctx.workspace,
    toolCount: tools.length,
    approval: { mode: approval.mode, runId: CHATGPT_RUN_ID },
    mcp: { port: null, url: null },
    tunnel: { state: 'stopped', tunnelId: config.tunnelId, source: null, error: null },
    requestCount: 0,
    lastRequestAt: null,
    lastTool: null,
    error: null,
  };
  let statusTimer = null;
  const statusPath = join(stateDir, 'status.json');
  const flushStatus = () => {
    clearTimeout(statusTimer);
    statusTimer = null;
    status.updatedAt = new Date().toISOString();
    status.state = deriveState(status);
    return writeAtomic(statusPath, JSON.stringify(status, null, 2)).catch(() => {});
  };
  // Request bursts coalesce into one write.
  const touchStatus = () => {
    statusTimer ??= setTimeout(flushStatus, 250);
  };

  let http;
  try {
    http = await startHttpMcp({
      server,
      token,
      port,
      log: say,
      onRequest: ({ tool }) => {
        status.requestCount += 1;
        status.lastRequestAt = new Date().toISOString();
        if (tool) {
          status.lastTool = tool;
          say(`tools/call ${tool}`);
        }
        touchStatus();
      },
    });
  } catch (failure) {
    status.error = failure.message;
    status.state = 'error';
    await flushStatus();
    throw failure;
  }
  status.mcp = { port: http.port, url: http.url };
  say(`MCP listening on ${http.url}; ${tools.length} video tools; approval ${approval.mode} via ${approval.dir}`);

  const runtimeDir = join(stateDir, 'runtime');
  let child = null;
  let stopping = false;

  if (!tunnel) {
    status.tunnel.state = 'disabled';
  } else if (!validTunnelId(config.tunnelId) || !config.apiKey) {
    status.tunnel.state = 'not_configured';
    status.tunnel.error = !config.tunnelId
      ? '未填写 Tunnel ID / Tunnel ID missing'
      : !validTunnelId(config.tunnelId)
        ? 'Tunnel ID 格式应为 tunnel_ + 32 位小写十六进制 / Tunnel ID must be tunnel_ + 32 lowercase hex'
        : '未保存 API Key / API key missing';
  } else {
    status.tunnel.state = 'starting';
    void launchTunnel().catch(async (failure) => {
      if (stopping) {
        return;
      }
      status.tunnel.state = 'error';
      status.tunnel.error = redactText(failure.message, secrets);
      say(`tunnel failed: ${status.tunnel.error}`);
      await killChild();
      await flushStatus();
    });
  }
  await flushStatus();

  async function launchTunnel() {
    const deadline = Date.now() + STARTUP_BUDGET_MS;
    await sweepOrphan(runtimeDir);
    await rm(runtimeDir, { recursive: true, force: true });
    await mkdir(runtimeDir, { recursive: true, mode: 0o700 });

    const binary = await resolveTunnelClient({ managedRoot: join(stateDir, 'tools', 'tunnel-client'), env, log: say });
    status.tunnel.source = binary.source;
    say(`tunnel-client: ${binary.source} ${binary.path}`);
    const childEnv = tunnelEnv(env, config);

    // A wrong key otherwise looks like "not ready after 60s"; the control plane answers 401 in seconds.
    const probe = await runCapture(binary.path, buildProbeArgs(config.tunnelId), { env: childEnv, timeoutMs: PROBE_TIMEOUT_MS });
    if (stopping) {
      return;
    }
    if (probe.code !== 0) {
      const detail = redactText(lastLine(probe.output), secrets);
      throw new Error(`${controlPlaneErrorMessage(probe.output)}${detail ? `（${detail}）` : ''}`);
    }

    const authorizationFile = join(runtimeDir, 'authorization');
    await writePrivate(authorizationFile, `Bearer ${token}`);
    const healthUrlFile = join(runtimeDir, 'health-url');
    const args = buildRunArgs({
      mcpUrl: http.url,
      authorizationFile,
      healthUrlFile,
      logFile: join(runtimeDir, 'tunnel.log'),
      pidFile: join(runtimeDir, 'tunnel.pid'),
    });
    child = spawn(binary.path, args, { env: childEnv, stdio: 'ignore', windowsHide: true });
    const exited = new Promise((resolveExit) => child.once('exit', (code, signal) => resolveExit({ code, signal })));
    child.once('error', (error) => say(`tunnel-client spawn error: ${error.message}`));
    exited.then(async ({ code, signal }) => {
      child = null;
      if (stopping) {
        return;
      }
      status.tunnel.state = 'error';
      status.tunnel.error ??= `tunnel-client 已退出 (${signal ?? code}) / tunnel-client exited`;
      say(status.tunnel.error);
      await flushStatus();
    });

    while (Date.now() < deadline) {
      if (stopping) {
        return;
      }
      if (!child) {
        throw new Error('tunnel-client 在就绪前退出，请检查 Tunnel ID、API Key 权限与网络 / tunnel-client exited before becoming ready');
      }
      const base = await readFile(healthUrlFile, 'utf8').then(parseLoopbackHealthUrl, () => null);
      if (base && (await fetch(`${base}/readyz`, { signal: AbortSignal.timeout(2000) }).then((r) => r.ok, () => false))) {
        status.tunnel.state = 'running';
        status.tunnel.error = null;
        say('tunnel-client ready');
        await flushStatus();
        return;
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, 300));
    }
    throw new Error('隧道在 60 秒内没有就绪，请检查网络/代理与 Tunnel 配置 / tunnel not ready within 60s');
  }

  async function killChild() {
    const running = child;
    if (!running) {
      return;
    }
    const gone = new Promise((resolveGone) => running.once('exit', resolveGone));
    running.kill('SIGTERM');
    const timer = setTimeout(() => running.kill('SIGKILL'), 3000);
    await gone;
    clearTimeout(timer);
  }

  async function stop() {
    if (stopping) {
      return;
    }
    stopping = true;
    await killChild();
    await http.close();
    await rm(runtimeDir, { recursive: true, force: true });
    status.tunnel.state = tunnel ? 'stopped' : 'disabled';
    status.mcp = { port: null, url: null };
    status.stoppedAt = new Date().toISOString();
    await flushStatus();
    say('stopped');
  }

  return { port: http.port, url: http.url, token, status, stop, approval };
}

function deriveState(status) {
  if (status.stoppedAt) {
    return 'stopped';
  }
  if (status.error) {
    return 'error';
  }
  if (!status.mcp.port) {
    return 'starting';
  }
  switch (status.tunnel.state) {
    case 'running':
      return 'running';
    case 'starting':
      return 'starting';
    case 'error':
      return 'error';
    default:
      // HTTP MCP is up but nothing connects it to ChatGPT (tunnel off or not configured).
      return 'mcp_only';
  }
}

/** A tunnel-client left behind by a crashed bridge still polls with our tunnel id; stop it first. */
async function sweepOrphan(runtimeDir) {
  if (process.platform === 'win32') {
    return;
  }
  const pid = Number((await readFile(join(runtimeDir, 'tunnel.pid'), 'utf8').catch(() => '')).trim());
  if (!Number.isInteger(pid) || pid <= 1) {
    return;
  }
  try {
    // Only kill it if its argv points into our runtime dir — never an unrelated process that reused the pid.
    const command = execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' });
    if (command.includes('tunnel-client') && command.includes(runtimeDir)) {
      process.kill(pid, 'SIGTERM');
    }
  } catch {
    // not running
  }
}

async function writePrivate(path, contents) {
  await writeFile(path, contents, { mode: 0o600 });
  await chmod(path, 0o600);
}

async function writeAtomic(path, contents) {
  const staging = `${path}.${process.pid}.tmp`;
  await writeFile(staging, contents, { mode: 0o600 });
  await rename(staging, path);
}

function flag(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main() {
  const log = (message) => process.stderr.write(`[video-creator-chatgpt] ${new Date().toISOString()} ${message}\n`);
  let bridge;
  try {
    bridge = await startBridge({
      stateDir: flag('--state-dir'),
      workspace: flag('--workspace'),
      port: flag('--port') ?? process.env.VIDEO_CREATOR_MCP_PORT ?? DEFAULT_HTTP_PORT,
      tunnel: !process.argv.includes('--no-tunnel'),
      log,
    });
  } catch (failure) {
    log(`fatal: ${failure.message}`);
    process.exit(failure.code === 'PORT_IN_USE' ? 3 : 1);
  }
  const shutdown = async () => {
    await bridge.stop().catch((failure) => log(`stop failed: ${failure.message}`));
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  if (process.argv.includes('--parent-stdin')) {
    // The app holds our stdin; when it dies (even by SIGKILL) the pipe closes and we clean up the tunnel.
    process.stdin.on('end', shutdown);
    process.stdin.on('error', shutdown);
    process.stdin.resume();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  await main();
}
