// Minimal MCP (JSON-RPC 2.0) server core: initialize / ping / tools/list / tools/call.
// Transport-agnostic so it can be unit-tested in-process and later mounted on
// HTTP (as webcode-ai-studio does) without touching tool code.
import { needsApproval, requestApproval } from './approval.mjs';
import { ToolError } from './context.mjs';
import { planFromEnv } from '../scripts/lib/plan.mjs';

export const SUPPORTED_PROTOCOL_VERSIONS = ['2025-06-18', '2025-11-25', '2025-03-26', '2024-11-05'];
/** Stateless MCP era used by the OpenAI tunnel ("discover first, then plain requests"; no initialize). */
export const STATELESS_PROTOCOL_VERSION = '2026-07-28';

export const SERVER_INFO = { name: 'webclaw-video-creator', title: 'WebClaw Video Creator', version: '0.1.0' };

export const SERVER_INSTRUCTIONS = [
  'Video Creator exposes atomic, mostly deterministic video tools. You (the agent) are the director:',
  'plan the video yourself, then compose these tools. They never call an LLM on your behalf.',
  'Start with video_project_status (workspace, projects, available providers) and video_brand_profile_get',
  '(creator voice, tone constraints, visual style, caption/music preferences, reusable assets) before writing scripts.',
  'High-quality autoproduce flow (preferred over ad-hoc tool chains): brief -> write a scene-first storyboard',
  '(one beat per scene, last scene a CTA/brand closer) -> video_director_plan (saves scenes, runs checks,',
  'inventories existing assets to reuse) -> audio first: video_tts_synthesize per scene (durations follow the real audio)',
  '-> video_director_preview (720p render + per-scene frames + contact sheet, attached as image content — actually look at them and critique what you see;',
  'video_director_frames re-reads any round/scene as images) -> video_director_review (record findings; revise flagged scenes only, not the whole film) -> repeat preview/review',
  '-> video_director_finalize (gate-checked full-quality render). Every director tool returns { phase, artifacts, nextStep }.',
  'Visual baseline: avoid runs of plain text cards — mix images/screenshots/B-roll with restrained motion',
  '(Ken Burns, spring entrances); check overflow, contrast and caption occlusion on the extracted frames.',
  'Conventions and Remotion know-how: docs/remotion-best-practices.md in the app repository.',
  'For visuals, video_image_generate (uses the user\'s ChatGPT image quota, needs approval) writes a PNG to the project assets and can attach it to a scene.',
  'Relative paths resolve inside the workspace; outputs are always written inside the workspace.',
].join(' ');

/**
 * Gating rule: who pays decides. The tools here run on the user's own agent CLI / ChatGPT login,
 * their own quotas and API keys, or this machine, so they are open on every plan. A tool's `cost`
 * is approval semantics only ('paid' = spends the user's own quota, always confirmed per call),
 * not a WebClaw plan requirement. A future tool that WebClaw pays for (a platform-hosted provider)
 * declares `planFeature: '<plan limit key>'` and is refused unless that limit is `true`.
 */
export const PRO_REQUIRED_MESSAGE =
  'This tool uses a WebClaw-paid service and needs WebClaw Video Creator Pro. ' +
  'Ask the user to sign in and upgrade in the app (Settings → Account & membership). ' +
  '该工具使用 WebClaw 代付的服务，需要 Pro：请在应用「设置 → 账户与会员」登录并升级后重试。';

/**
 * `readPlan` returns the plan limits (scripts/lib/plan.mjs). By default it reads the entitlement
 * file the app writes (VIDEO_CREATOR_ENTITLEMENT_FILE) on every call, so a membership change
 * applies to long-running servers too, and a missing or stale file means the free plan.
 */
export function createMcpServer({ tools, ctx, approval = null, log = () => {}, readPlan = planFromEnv }) {
  const byName = new Map(tools.map((tool) => [tool.name, tool]));

  async function handle(message, notify = () => {}) {
    if (Array.isArray(message)) {
      // JSON-RPC batching was removed from MCP (2025-06-18); answer instead of dropping it silently.
      return error(null, -32600, 'Invalid Request: batch requests are not supported');
    }
    if (!message || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
      return message && 'id' in message ? error(message.id ?? null, -32600, 'Invalid Request') : null;
    }
    const isNotification = !('id' in message);
    try {
      const result = await dispatch(message, notify);
      return isNotification ? null : { jsonrpc: '2.0', id: message.id, result };
    } catch (failure) {
      if (isNotification) {
        log(`notification ${message.method} failed: ${failure.message}`);
        return null;
      }
      return error(message.id, failure.code ?? -32603, failure.message);
    }
  }

  async function dispatch({ method, params = {} }, notify) {
    switch (method) {
      case 'initialize': {
        const requested = params.protocolVersion;
        return {
          protocolVersion: SUPPORTED_PROTOCOL_VERSIONS.includes(requested) ? requested : SUPPORTED_PROTOCOL_VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: SERVER_INFO,
          instructions: SERVER_INSTRUCTIONS,
        };
      }
      case 'notifications/initialized':
      case 'notifications/cancelled':
        return {};
      case 'ping':
        return {};
      case 'server/discover':
        // OpenAI's control plane probes with a sessionless server/discover; shape mirrors webcodex/AI Studio.
        return {
          resultType: 'complete',
          ttlMs: 0,
          cacheScope: 'private',
          supportedVersions: [STATELESS_PROTOCOL_VERSION, '2025-11-25', '2025-06-18'],
          capabilities: { tools: { listChanged: false } },
          _meta: { 'io.modelcontextprotocol/serverInfo': { name: SERVER_INFO.name, version: SERVER_INFO.version } },
        };
      case 'tools/list':
        return { tools: tools.map(describeTool) };
      case 'tools/call':
        return callTool(params, notify);
      default:
        throw rpcError(-32601, `Method not found: ${method}`);
    }
  }

  async function callTool(params, notify) {
    const tool = byName.get(params?.name);
    if (!tool) {
      throw rpcError(-32602, `Unknown tool: ${params?.name}`);
    }
    const args = params.arguments ?? {};
    const progressToken = params._meta?.progressToken;
    const progress = (percent, message) => {
      if (progressToken !== undefined) {
        notify({
          jsonrpc: '2.0',
          method: 'notifications/progress',
          params: { progressToken, progress: percent, total: 100, message },
        });
      }
    };
    try {
      // Read on every call: export limits (video_render) and any platform-paid tool follow a
      // membership change without restarting the server.
      const plan = await readPlan();
      if (tool.planFeature && plan?.[tool.planFeature] !== true) {
        throw new ToolError(PRO_REQUIRED_MESSAGE);
      }
      validateArgs(tool.inputSchema, args);
      if (approval && needsApproval(tool, approval.mode)) {
        await requestApproval(approval, tool, args);
      }
      const value = await tool.handler(args, { ctx, progress, log, plan });
      return toolResult(value);
    } catch (failure) {
      if (!(failure instanceof ToolError)) {
        log(`tool ${tool.name} crashed: ${failure.stack || failure.message}`);
      }
      return { content: [{ type: 'text', text: failure.message }], isError: true };
    }
  }

  return { handle, tools };
}

/**
 * Tools/call result shape. Any handler (not just the director's) may attach
 * images for the calling model to actually see — useful when the client is a
 * remote agent that cannot read local paths (ChatGPT via the Secure Tunnel):
 * return `{ ...value, mcpImages: [{ data: base64, mimeType: 'image/jpeg', title? }] }`.
 * The key is stripped from structuredContent/text JSON and becomes, in order,
 * `{ type: 'image', data, mimeType }` blocks (each preceded by a text block
 * with its title, when given) ahead of the JSON text block.
 * Oversized images are dropped (never fail the call) with a note saying so.
 */
const IMAGE_MAX_BASE64 = 1_500_000; // ≈1.1 MB binary per image
const IMAGE_TOTAL_BASE64 = 6_000_000; // ≈4.5 MB binary per call

function toolResult(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const { mcpImages, ...rest } = source;
  const attached = [];
  let dropped = 0;
  let total = 0;
  for (const image of Array.isArray(mcpImages) ? mcpImages : []) {
    if (typeof image?.data !== 'string' || typeof image.mimeType !== 'string') {
      dropped += 1;
      continue;
    }
    if (image.data.length > IMAGE_MAX_BASE64 || total + image.data.length > IMAGE_TOTAL_BASE64) {
      dropped += 1;
      continue;
    }
    total += image.data.length;
    // Keep the handler's order and label each image, so the model can tell the
    // contact sheet from scene frames and pin findings on the right scene.
    if (typeof image.title === 'string' && image.title) {
      attached.push({ type: 'text', text: image.title });
    }
    attached.push({ type: 'image', data: image.data, mimeType: image.mimeType });
  }
  const content = [...attached, { type: 'text', text: JSON.stringify(rest, null, 2) }];
  if (dropped > 0) {
    content.push({
      type: 'text',
      text: `${dropped} attached image(s) were omitted (malformed or over the size cap); the local paths are in structuredContent.`,
    });
  }
  return { content, structuredContent: rest };
}

function describeTool(tool) {
  const described = {
    name: tool.name,
    title: tool.title,
    description: tool.description,
    inputSchema: tool.inputSchema,
  };
  if (tool.annotations) {
    described.annotations = tool.annotations;
  }
  return described;
}

/** Shallow JSON-schema check (required, type, enum) — enough to give the agent actionable errors. */
export function validateArgs(schema, args) {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) {
    throw new ToolError('arguments must be an object');
  }
  for (const key of schema.required ?? []) {
    if (args[key] === undefined) {
      throw new ToolError(`missing required argument: ${key}`);
    }
  }
  for (const [key, value] of Object.entries(args)) {
    const spec = schema.properties?.[key];
    if (!spec) {
      if (schema.additionalProperties === false) {
        throw new ToolError(`unknown argument: ${key}`);
      }
      continue;
    }
    if (spec.type && !matchesType(spec.type, value)) {
      throw new ToolError(`argument ${key} must be of type ${spec.type}`);
    }
    if (spec.enum && !spec.enum.includes(value)) {
      throw new ToolError(`argument ${key} must be one of: ${spec.enum.join(', ')}`);
    }
  }
}

function matchesType(type, value) {
  switch (type) {
    case 'array':
      return Array.isArray(value);
    case 'object':
      return typeof value === 'object' && value !== null && !Array.isArray(value);
    case 'integer':
      return Number.isInteger(value);
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    default:
      return typeof value === type;
  }
}

function rpcError(code, message) {
  return Object.assign(new Error(message), { code });
}

function error(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}
