import assert from 'node:assert/strict';
import { mkdtemp, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { approvalFromEnv, needsApproval } from '../mcp/approval.mjs';
import { createContext } from '../mcp/context.mjs';
import { createMcpServer } from '../mcp/protocol.mjs';
const PRO_PLAN = { maxExportHeight: 2160, watermark: false, commercialUse: true };
import { tools } from '../mcp/tools.mjs';
import { parseAgentLine } from '../src/lib/agent-events.ts';

const SCENE = { id: 's1', title: 'T', text: '', narration: 'n', template: 'TitleSlide', duration: 3, props: {} };

async function gatedServer(mode) {
  const workspace = await mkdtemp(join(tmpdir(), 'vc-approval-'));
  const dir = join(workspace, 'approvals');
  const server = createMcpServer({ tools, ctx: createContext({ workspace }), approval: { dir, mode, timeoutMs: 3000, pollMs: 20 }, readPlan: async () => PRO_PLAN });
  let id = 0;
  const call = (name, args) => server.handle({ jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name, arguments: args } }).then((r) => r.result);
  return { dir, call };
}

/** Answer the first approval request that shows up in `dir`. */
async function answer(dir, allow, note) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const requests = (await readdir(dir).catch(() => [])).filter((name) => name.endsWith('.request.json'));
    if (requests.length > 0) {
      const approvalId = requests[0].replace('.request.json', '');
      await writeFile(join(dir, `${approvalId}.decision.json`), JSON.stringify({ allow, note }));
      return approvalId;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('no approval request appeared');
}

test('approval policy: read-only never asks, paid always asks, local asks only in ask mode', () => {
  const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));
  assert.equal(needsApproval(byName.video_project_status, 'ask'), false);
  assert.equal(needsApproval(byName.video_scenes_save, 'auto'), false);
  assert.equal(needsApproval(byName.video_scenes_save, 'ask'), true);
  assert.equal(needsApproval({ name: 'x', cost: 'paid', annotations: {} }, 'auto'), true);
  for (const tool of tools.filter((item) => !item.annotations.readOnlyHint)) {
    assert.ok(['local', 'free-network', 'paid'].includes(tool.cost), `${tool.name} needs a cost class`);
  }
  assert.equal(approvalFromEnv({}), null, 'gate is off unless the host opts in');
  assert.deepEqual(approvalFromEnv({ VIDEO_CREATOR_APPROVAL_DIR: '/x', VIDEO_CREATOR_APPROVAL: 'bogus' }).mode, 'auto');
});

test('ask mode blocks a write tool until the user allows it', async () => {
  const { dir, call } = await gatedServer('ask');
  const pending = call('video_scenes_save', { project: 'p', scenes: [SCENE] });
  await answer(dir, true);
  const result = await pending;
  assert.equal(result.isError, undefined, result.content[0].text);
  assert.deepEqual(await readdir(dir), [], 'request and decision files are cleaned up');
});

test('a declined tool returns an actionable error and does not run', async () => {
  const { dir, call } = await gatedServer('ask');
  const pending = call('video_scenes_save', { project: 'p', scenes: [SCENE] });
  await answer(dir, false, 'not now');
  const result = await pending;
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /declined video_scenes_save: not now/);
  const status = await call('video_project_status', {});
  assert.deepEqual(status.structuredContent.projects, [], 'nothing was written');
});

test('a half-written decision file is retried, not treated as a failure', async () => {
  const { dir, call } = await gatedServer('ask');
  const pending = call('video_scenes_save', { project: 'p', scenes: [SCENE] });
  let requests = [];
  while (requests.length === 0) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    requests = (await readdir(dir).catch(() => [])).filter((name) => name.endsWith('.request.json'));
  }
  const decisionPath = join(dir, requests[0].replace('.request.json', '.decision.json'));
  // The server polls while the host is still writing: a truncated file must not count as a decision.
  await writeFile(decisionPath, '{"allo');
  await new Promise((resolve) => setTimeout(resolve, 100));
  await writeFile(decisionPath, JSON.stringify({ allow: true }));
  const result = await pending;
  assert.equal(result.isError, undefined, result.content[0].text);
  assert.deepEqual(await readdir(dir), []);
});

test('auto mode runs local tools without asking; read-only tools never ask', async () => {
  const { dir, call } = await gatedServer('auto');
  const saved = await call('video_scenes_save', { project: 'p', scenes: [SCENE] });
  assert.equal(saved.isError, undefined);
  const status = await call('video_project_status', {});
  assert.equal(status.structuredContent.projects[0].sceneCount, 1);
  assert.deepEqual(await readdir(dir).catch(() => []), []);
});

// Fixtures follow the shapes captured from real `claude -p --output-format stream-json` and `codex exec --json` runs.
test('Claude stream-json lines become timeline events', () => {
  const parse = (value) => parseAgentLine('claude_code', JSON.stringify(value));
  assert.deepEqual(parse({ type: 'system', subtype: 'init', session_id: 's', tools: ['mcp__video-creator__video_render'] }), [
    { kind: 'session', sessionId: 's', tools: ['video_render'] },
  ]);
  assert.deepEqual(parse({ type: 'system', subtype: 'thinking_tokens' }), []);
  assert.deepEqual(
    parse({ type: 'assistant', message: { content: [{ type: 'thinking' }, { type: 'text', text: '先看项目' }, { type: 'tool_use', id: 't1', name: 'mcp__video-creator__video_render', input: { project: 'p' } }] } }),
    [
      { kind: 'text', text: '先看项目' },
      { kind: 'tool_call', id: 't1', tool: 'video_render', args: { project: 'p' } },
    ],
  );
  const [result] = parse({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: '{"output":"/a.mp4"}' }] }] } });
  assert.equal(result.ok, true);
  assert.deepEqual(result.data, { output: '/a.mp4' });
  const [failed] = parse({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't2', is_error: true, content: 'declined' }] } });
  assert.equal(failed.ok, false);
  assert.deepEqual(parse({ type: 'result', subtype: 'success', is_error: false, result: 'DONE', total_cost_usd: 0.02, permission_denials: [] }), [
    { kind: 'done', ok: true, summary: 'DONE', costUsd: 0.02, denied: undefined },
  ]);
  assert.deepEqual(parseAgentLine('claude_code', 'not json'), []);
});

test('Codex exec --json lines become the same timeline events', () => {
  const parse = (value) => parseAgentLine('codex', JSON.stringify(value));
  assert.deepEqual(parse({ type: 'thread.started', thread_id: 'th' }), [{ kind: 'session', sessionId: 'th' }]);
  const call = { id: 'item_0', type: 'mcp_tool_call', server: 'video-creator', tool: 'video_providers_list', arguments: {}, result: null, error: null, status: 'in_progress' };
  assert.deepEqual(parse({ type: 'item.started', item: call }), [{ kind: 'tool_call', id: 'item_0', tool: 'video_providers_list', args: {} }]);
  const [done] = parse({ type: 'item.completed', item: { ...call, status: 'completed', result: { content: [{ type: 'text', text: '{"providers":[]}' }] } } });
  assert.deepEqual({ ok: done.ok, data: done.data }, { ok: true, data: { providers: [] } });
  const [errored] = parse({ type: 'item.completed', item: { ...call, status: 'failed', error: { message: 'boom' } } });
  assert.deepEqual({ ok: errored.ok, summary: errored.summary }, { ok: false, summary: 'boom' });
  assert.deepEqual(parse({ type: 'item.completed', item: { id: 'item_1', type: 'agent_message', text: 'DONE' } }), [{ kind: 'text', text: 'DONE' }]);
  assert.deepEqual(parse({ type: 'turn.completed', usage: {} }), [{ kind: 'done', ok: true }]);
  assert.deepEqual(parse({ type: 'turn.failed', error: { message: 'quota' } }), [{ kind: 'done', ok: false, summary: 'quota' }]);
});

test('tauri wrapper strips build config leaked from a parent Tauri app, keeps signing keys', async () => {
  const { sanitizeTauriEnv } = await import('../scripts/lib/tauri-env.mjs');
  const { env, removed } = sanitizeTauriEnv({
    TAURI_CONFIG: '{"build":{"devUrl":"http://127.0.0.1:1430"}}',
    TAURI_ENV_TARGET_TRIPLE: 'aarch64-apple-darwin',
    CARGO_MANIFEST_DIR: '/other/src-tauri',
    CARGO_PKG_NAME: 'webcode-ai-studio',
    TAURI_SIGNING_PRIVATE_KEY: 'k',
    CARGO_HOME: '/h/.cargo',
    PATH: '/bin',
  });
  assert.deepEqual(Object.keys(env).sort(), ['CARGO_HOME', 'PATH', 'TAURI_SIGNING_PRIVATE_KEY']);
  assert.ok(removed.includes('TAURI_CONFIG'));
});
