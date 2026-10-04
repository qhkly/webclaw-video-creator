import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { test } from 'node:test';
import { APP_ROOT } from '../mcp/context.mjs';
import { CHATGPT_RUN_ID, loadOrCreateToken, startBridge } from '../mcp/chatgpt-bridge.mjs';
import {
  DEFAULT_CONFIG,
  loadConfig,
  maskSecret,
  normalizeConfig,
  redactConfig,
  redactText,
  saveConfig,
  validTunnelId,
} from '../mcp/chatgpt-config.mjs';
import { DEFAULT_HTTP_PORT, PortInUseError, hostIsLoopback, originIsLoopback, resolvePort, startHttpMcp } from '../mcp/http.mjs';
import { createContext } from '../mcp/context.mjs';
import { createMcpServer } from '../mcp/protocol.mjs';
import { tools } from '../mcp/tools.mjs';
import {
  BIN_OVERRIDE_ENV,
  buildRunArgs,
  controlPlaneErrorMessage,
  parseLoopbackHealthUrl,
  tunnelClientCandidates,
  tunnelEnv,
} from '../mcp/tunnel-client.mjs';

const TUNNEL_ID = `tunnel_${'a1'.repeat(16)}`;
const API_KEY = 'sk-proj-SECRETsecretSECRET1234';

async function tempDir(prefix) {
  return mkdtemp(join(tmpdir(), prefix));
}

/** Bridge on an ephemeral port (the fixed 32159 may be taken by a running app on the dev machine). */
async function bridge(options = {}) {
  const stateDir = await tempDir('vc-chatgpt-state-');
  const workspace = await tempDir('vc-chatgpt-ws-');
  const started = await startBridge({ stateDir, workspace, port: 0, tunnel: false, ...options });
  let id = 0;
  const post = (body, headers = {}) =>
    fetch(started.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${started.token}`, ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });
  const rpc = async (method, params, headers) => {
    const response = await post({ jsonrpc: '2.0', id: ++id, method, params }, headers);
    assert.equal(response.status, 200);
    return response.json();
  };
  return { ...started, stateDir, workspace, post, rpc };
}

test('port policy: fixed 32159, AI Studio port 32149 refused', () => {
  assert.equal(DEFAULT_HTTP_PORT, 32159);
  assert.equal(resolvePort(), 32159);
  assert.equal(resolvePort('32160'), 32160);
  assert.throws(() => resolvePort(32149), /reserved for WebCode AI Studio/);
  assert.throws(() => resolvePort('32149'), /reserved/);
  assert.throws(() => resolvePort(70000), /invalid MCP port/);
});

test('HTTP MCP: initialize, tools/list (video tools only), read-only video tool', async () => {
  const b = await bridge();
  try {
    const init = await b.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
    assert.equal(init.result.protocolVersion, '2025-06-18');
    assert.equal(init.result.serverInfo.name, 'webclaw-video-creator');
    const initialized = await b.post({ jsonrpc: '2.0', method: 'notifications/initialized' });
    assert.equal(initialized.status, 202);

    const listed = await b.rpc('tools/list');
    const names = listed.result.tools.map((tool) => tool.name);
    assert.deepEqual(names, tools.map((tool) => tool.name));
    assert.ok(names.every((name) => name.startsWith('video_')), 'only video tools are exposed');
    for (const forbidden of ['studio_', 'session', 'git', 'computer', 'run_command']) {
      assert.ok(!names.some((name) => name.includes(forbidden)), `unexpected ${forbidden} tool`);
    }

    const status = await b.rpc('tools/call', { name: 'video_project_status', arguments: {} });
    assert.equal(status.result.isError, undefined);
    assert.equal(status.result.structuredContent.workspace, b.workspace);
    assert.deepEqual(status.result.structuredContent.projects, []);
    const providers = await b.rpc('tools/call', { name: 'video_providers_list', arguments: {} });
    assert.ok(Array.isArray(providers.result.structuredContent.providers));

    const written = JSON.parse(await readFile(join(b.stateDir, 'status.json'), 'utf8'));
    assert.equal(written.state, 'mcp_only');
    assert.equal(written.mcp.port, b.port);
    assert.equal(written.tunnel.state, 'disabled');
  } finally {
    await b.stop();
  }
});

test('HTTP MCP: OpenAI stateless handshake (server/discover, 2026-07-28 resultType)', async () => {
  const b = await bridge();
  try {
    const discover = await b.rpc('server/discover');
    assert.equal(discover.result.resultType, 'complete');
    assert.ok(discover.result.supportedVersions.includes('2026-07-28'));
    assert.equal(discover.result._meta['io.modelcontextprotocol/serverInfo'].name, 'webclaw-video-creator');
    const listed = await b.rpc('tools/list', undefined, { 'MCP-Protocol-Version': '2026-07-28' });
    assert.equal(listed.result.resultType, 'complete');
    assert.ok(listed.result.tools.length > 0);
  } finally {
    await b.stop();
  }
});

test('HTTP MCP: auth, host/origin, method and parse guards', async () => {
  const b = await bridge();
  try {
    const noAuth = await fetch(b.url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"jsonrpc":"2.0","id":1,"method":"ping"}' });
    assert.equal(noAuth.status, 401);
    const wrong = await b.post({ jsonrpc: '2.0', id: 1, method: 'ping' }, { Authorization: 'Bearer nope' });
    assert.equal(wrong.status, 401);
    const evilOrigin = await b.post({ jsonrpc: '2.0', id: 1, method: 'ping' }, { Origin: 'https://evil.example' });
    assert.equal(evilOrigin.status, 403);
    const get = await fetch(b.url, { headers: { Authorization: `Bearer ${b.token}` } });
    assert.equal(get.status, 405);
    const garbage = await b.post('{not json');
    assert.equal(garbage.status, 400);
    assert.equal((await garbage.json()).error.code, -32700);
    const health = await fetch(`http://127.0.0.1:${b.port}/healthz`);
    assert.deepEqual(await health.json(), { ok: true, name: 'webclaw-video-creator' });

    assert.equal(hostIsLoopback('127.0.0.1:32159'), true);
    assert.equal(hostIsLoopback('localhost'), true);
    assert.equal(hostIsLoopback('[::1]:1'), true);
    assert.equal(hostIsLoopback('evil.example:32159'), false);
    assert.equal(hostIsLoopback(undefined), false);
    assert.equal(originIsLoopback(undefined), true);
    assert.equal(originIsLoopback('http://localhost:5173'), true);
    assert.equal(originIsLoopback('null'), false);
  } finally {
    await b.stop();
  }
});

test('remote calls cannot bypass approval: writes wait for the app, decline is reported', async () => {
  const b = await bridge({ env: { VIDEO_CREATOR_APPROVAL_TIMEOUT_MS: '5000' } });
  try {
    assert.equal(b.approval.mode, 'ask');
    assert.ok(b.approval.dir.endsWith(join('.agent', 'runs', CHATGPT_RUN_ID, 'approvals')));
    const scene = { id: 's1', title: 'Hi', text: 'Hi', narration: 'Hi', template: 'TitleSlide', duration: 2, props: { title: 'Hi' } };
    const pending = b.rpc('tools/call', { name: 'video_scenes_save', arguments: { project: 'demo', scenes: [scene] } });
    // Decline as the app would (agent_decide_approval writes <id>.decision.json).
    const { readdir } = await import('node:fs/promises');
    let request;
    for (let i = 0; i < 100 && !request; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      request = (await readdir(b.approval.dir).catch(() => [])).find((name) => name.endsWith('.request.json'));
    }
    assert.ok(request, 'approval request was written');
    await writeFile(join(b.approval.dir, request.replace('.request.json', '.decision.json')), JSON.stringify({ allow: false }));
    const result = await pending;
    assert.equal(result.result.isError, true);
    assert.match(result.result.content[0].text, /declined video_scenes_save/);

    // Read-only tools never ask.
    const status = await b.rpc('tools/call', { name: 'video_project_status', arguments: {} });
    assert.equal(status.result.isError, undefined);
  } finally {
    await b.stop();
  }
});

test('port conflict is reported, never silently moved', async () => {
  const blocker = createServer((req, res) => res.end('busy'));
  await new Promise((resolve) => blocker.listen(0, '127.0.0.1', resolve));
  const { port } = blocker.address();
  const server = createMcpServer({ tools, ctx: createContext({ workspace: await tempDir('vc-port-') }) });
  try {
    await assert.rejects(startHttpMcp({ server, token: 't'.repeat(64), port }), (error) => {
      assert.ok(error instanceof PortInUseError);
      assert.equal(error.code, 'PORT_IN_USE');
      assert.equal(error.port, port);
      assert.equal(error.holder, 'other');
      return true;
    });
  } finally {
    blocker.close();
  }

  const first = await bridge();
  try {
    await assert.rejects(startHttpMcp({ server, token: 't'.repeat(64), port: first.port }), (error) => error.holder === 'video-creator');
    const stateDir = await tempDir('vc-chatgpt-state-');
    await assert.rejects(startBridge({ stateDir, workspace: first.workspace, port: first.port, tunnel: false }), /PORT|端口/);
    const failed = JSON.parse(await readFile(join(stateDir, 'status.json'), 'utf8'));
    assert.equal(failed.state, 'error');
  } finally {
    await first.stop();
  }
});

test('tunnel config: normalize, 0600 persistence, redaction', async () => {
  assert.equal(validTunnelId(TUNNEL_ID), true);
  assert.equal(validTunnelId('tunnel_ABC'), false);
  assert.equal(validTunnelId(`tunnel_${'A1'.repeat(16)}`), false);
  assert.deepEqual(normalizeConfig(null), DEFAULT_CONFIG);
  assert.deepEqual(normalizeConfig({ tunnelId: ` ${TUNNEL_ID} `, apiKey: 1, autoStart: 'yes', approval: 'never', extra: true }), {
    tunnelId: TUNNEL_ID,
    apiKey: '',
    autoStart: false,
    approval: 'ask',
  });

  const dir = await tempDir('vc-config-');
  const path = join(dir, 'nested', 'config.json');
  assert.deepEqual(await loadConfig(path), DEFAULT_CONFIG);
  await saveConfig(path, { tunnelId: TUNNEL_ID, apiKey: API_KEY, autoStart: true, approval: 'auto' });
  if (process.platform !== 'win32') {
    assert.equal((await stat(path)).mode & 0o777, 0o600);
  }
  const loaded = await loadConfig(path);
  assert.equal(loaded.apiKey, API_KEY);

  const redacted = redactConfig(loaded);
  assert.deepEqual(redacted, { tunnelId: TUNNEL_ID, hasApiKey: true, apiKeyHint: 'sk-…1234', autoStart: true, approval: 'auto' });
  assert.ok(!JSON.stringify(redacted).includes('SECRET'));
  assert.equal(maskSecret(''), '');
  assert.equal(maskSecret('short'), '••••');
  assert.equal(redactConfig({}).hasApiKey, false);

  const line = redactText(`key=${API_KEY} other sk-abcdefghijkl Authorization: Bearer 0123456789abcdef`, [API_KEY]);
  assert.ok(!line.includes('SECRET'));
  assert.ok(!line.includes('sk-abcdefghijkl'));
  assert.ok(!line.includes('0123456789abcdef'));
});

test('bridge does not start the tunnel without a complete config, and never logs the key', async () => {
  const stateDir = await tempDir('vc-chatgpt-state-');
  await saveConfig(join(stateDir, 'config.json'), { tunnelId: 'bad', apiKey: API_KEY });
  const lines = [];
  const b = await startBridge({ stateDir, workspace: await tempDir('vc-ws-'), port: 0, log: (line) => lines.push(line) });
  try {
    assert.equal(b.status.tunnel.state, 'not_configured');
    assert.match(b.status.tunnel.error, /Tunnel ID/);
    const statusFile = await readFile(join(stateDir, 'status.json'), 'utf8');
    assert.ok(!statusFile.includes(API_KEY));
    assert.equal(JSON.parse(statusFile).state, 'mcp_only');
  } finally {
    await b.stop();
  }
  assert.ok(!lines.join('\n').includes(API_KEY));
  assert.ok(!lines.join('\n').includes(b.token));
  const token = await readFile(join(stateDir, 'mcp-token'), 'utf8');
  assert.equal(token, b.token);
  assert.equal(await loadOrCreateToken(stateDir), b.token, 'token is stable across restarts');
});

test('tunnel-client invocation keeps secrets out of argv and drops broader OpenAI keys', () => {
  const args = buildRunArgs({ mcpUrl: 'http://127.0.0.1:32159/mcp', authorizationFile: '/s/auth', healthUrlFile: '/s/h', logFile: '/s/l', pidFile: '/s/p' });
  assert.deepEqual(args.slice(0, 5), ['run', '--mcp.server-url', 'url=http://127.0.0.1:32159/mcp,channel=main', '--mcp.extra-headers', 'Authorization: file:/s/auth']);
  assert.ok(!args.join(' ').includes('sk-'));
  const env = tunnelEnv({ PATH: '/bin', OPENAI_API_KEY: 'sk-big', OPENAI_ADMIN_KEY: 'sk-admin' }, { tunnelId: TUNNEL_ID, apiKey: API_KEY });
  assert.equal(env.CONTROL_PLANE_API_KEY, API_KEY);
  assert.equal(env.CONTROL_PLANE_TUNNEL_ID, TUNNEL_ID);
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.equal(env.OPENAI_ADMIN_KEY, undefined);

  assert.equal(parseLoopbackHealthUrl('http://127.0.0.1:5555/\n'), 'http://127.0.0.1:5555');
  assert.equal(parseLoopbackHealthUrl('http://evil.example:5555'), null);
  assert.equal(parseLoopbackHealthUrl('http://127.0.0.1:5555/x'), null);
  assert.match(controlPlaneErrorMessage('401 invalid_api_key'), /API Key/);
  assert.match(controlPlaneErrorMessage('dial tcp: i/o timeout'), /网络/);
});

test('tunnel-client candidates: override, own cache, AI Studio cache (read-only), PATH', () => {
  const candidates = tunnelClientCandidates({
    env: { [BIN_OVERRIDE_ENV]: '/custom/tc', PATH: ['/a', '/b'].join(delimiter) },
    platform: 'darwin',
    arch: 'arm64',
    home: '/Users/me',
    managedRoot: '/state/tools/tunnel-client',
  });
  assert.deepEqual(candidates.map((candidate) => candidate.kind), ['override', 'managed', 'ai-studio', 'path', 'path']);
  assert.equal(candidates[1].path, join('/state/tools/tunnel-client', '0.0.12', 'darwin-arm64', 'tunnel-client'));
  assert.match(candidates[2].path, /com\.jiayiqiu\.webcode-ai-studio/);
  assert.equal(candidates[1].sha256, candidates[2].sha256);
  assert.equal(tunnelClientCandidates({ env: {}, platform: 'sunos', arch: 'x64' }).length, 0);
});

test('stdio MCP regression: server.mjs still speaks newline JSON-RPC', async () => {
  const workspace = await tempDir('vc-stdio-');
  const child = spawn(process.execPath, [join(APP_ROOT, 'mcp', 'server.mjs'), '--workspace', workspace], { stdio: ['pipe', 'pipe', 'pipe'] });
  const responses = [];
  let buffer = '';
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    const lines = buffer.split('\n');
    buffer = lines.pop();
    responses.push(...lines.filter(Boolean).map((line) => JSON.parse(line)));
  });
  const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'video_project_status', arguments: {} } });
  child.stdin.end();
  await new Promise((resolve) => child.on('close', resolve));
  const byId = new Map(responses.map((response) => [response.id, response]));
  assert.equal(byId.get(1).result.serverInfo.name, 'webclaw-video-creator');
  assert.equal(byId.get(2).result.tools.length, tools.length);
  assert.equal(byId.get(3).result.structuredContent.workspace, workspace);
  assert.equal(responses.length, 3, 'notification produced no response');
});
