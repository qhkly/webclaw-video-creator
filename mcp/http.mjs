// Loopback HTTP transport for the Video Creator MCP server (Streamable HTTP,
// stateless JSON responses). It mounts the exact same server core as the stdio
// entry (protocol.mjs + tools.mjs), so ChatGPT sees only the video tools.
//
// Used by the OpenAI Secure Tunnel bridge: tunnel-client (local child process)
// forwards ChatGPT's MCP traffic to http://127.0.0.1:<port>/mcp with a Bearer
// token it reads from a 0600 file. Defense layers, outermost first:
//   loopback bind -> Host/Origin check (DNS rebinding) -> Bearer -> approval gate.
import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { STATELESS_PROTOCOL_VERSION, SERVER_INFO } from './protocol.mjs';

/** Video Creator's own fixed port. WebCode AI Studio owns 32149; never take it, even as a fallback. */
export const DEFAULT_HTTP_PORT = 32159;
export const RESERVED_PORTS = new Map([[32149, 'WebCode AI Studio MCP']]);
export const MCP_PATH = '/mcp';
export const HEALTH_PATH = '/healthz';
const MAX_BODY_BYTES = 4 * 1024 * 1024;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

export class PortInUseError extends Error {
  constructor(port, holder) {
    super(
      holder === 'video-creator'
        ? `端口 ${port} 已被另一个 Video Creator MCP 实例占用（先停止它） / Port ${port} is already used by another Video Creator MCP instance`
        : `端口 ${port} 已被其他程序占用，Video Creator 不会改用其他端口（尤其不会占用 AI Studio 的 32149）。请释放该端口或设置 VIDEO_CREATOR_MCP_PORT / Port ${port} is in use by another program`,
    );
    this.code = 'PORT_IN_USE';
    this.port = port;
    this.holder = holder;
  }
}

/** Validate a configured port. Throws on reserved/invalid ports instead of silently picking another. */
export function resolvePort(value = DEFAULT_HTTP_PORT) {
  const port = typeof value === 'string' && value.trim() !== '' ? Number(value) : value ?? DEFAULT_HTTP_PORT;
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`invalid MCP port: ${value}`);
  }
  if (RESERVED_PORTS.has(port)) {
    throw new Error(`port ${port} is reserved for ${RESERVED_PORTS.get(port)}; Video Creator uses ${DEFAULT_HTTP_PORT}`);
  }
  return port;
}

/**
 * Request handler around an MCP server core (createMcpServer). `token` is required:
 * the endpoint is never served unauthenticated, even on loopback.
 */
export function createHttpHandler({ server, token, log = () => {}, onRequest = () => {}, onResponse = () => {} }) {
  if (!token || typeof token !== 'string') {
    throw new Error('createHttpHandler requires a bearer token');
  }
  const expected = Buffer.from(`Bearer ${token}`);

  return async function handle(req, res) {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    if (!hostIsLoopback(req.headers.host) || !originIsLoopback(req.headers.origin)) {
      return sendJson(res, 403, { error: 'forbidden' });
    }
    if (url.pathname === HEALTH_PATH && req.method === 'GET') {
      // Deliberately unauthenticated and content-free: it only lets a second instance tell "our port" from "someone else's".
      return sendJson(res, 200, { ok: true, name: SERVER_INFO.name });
    }
    if (url.pathname !== MCP_PATH) {
      return sendJson(res, 404, { error: 'not found' });
    }
    if (!authorized(req.headers.authorization, expected)) {
      return sendJson(res, 401, { error: 'unauthorized' }, { 'WWW-Authenticate': 'Bearer' });
    }
    if (req.method !== 'POST') {
      // No server-initiated SSE stream and no sessions to DELETE: this endpoint is stateless.
      return sendJson(res, 405, { error: 'method not allowed' }, { Allow: 'POST' });
    }

    let message;
    try {
      message = JSON.parse(await readBody(req));
    } catch (failure) {
      if (failure.code === 'BODY_TOO_LARGE') {
        return sendJson(res, 413, rpcError(null, -32600, 'Request body too large'));
      }
      return sendJson(res, 400, rpcError(null, -32700, 'Parse error'));
    }

    const method = typeof message?.method === 'string' ? message.method : null;
    const tool = method === 'tools/call' ? message.params?.name : undefined;
    const args = method === 'tools/call' && message.params?.arguments && typeof message.params.arguments === 'object' ? message.params.arguments : undefined;
    onRequest({ id: message?.id, method, tool, arguments: args });
    // Progress notifications need a stream; in JSON mode they are dropped.
    const response = await server.handle(message, () => {});
    if (!response) {
      res.writeHead(202).end();
      return;
    }
    if (response.result && isStatelessEra(req, message)) {
      response.result = { resultType: 'complete', ...response.result };
    }
    if (response.error) {
      log(`rpc ${method ?? '?'} -> ${response.error.code} ${response.error.message}`);
    }
    onResponse({ id: message?.id, method, tool, arguments: args, response });
    sendJson(res, 200, response);
  };
}

/**
 * Listen on 127.0.0.1 only. An occupied port is reported (PortInUseError) — never
 * replaced by another port — after checking whether the holder is another Video Creator.
 */
export async function startHttpMcp({ server, token, port = DEFAULT_HTTP_PORT, log = () => {}, onRequest, onResponse } = {}) {
  const wanted = resolvePort(port);
  const httpServer = createServer(createHttpHandler({ server, token, log, onRequest, onResponse }));
  try {
    await new Promise((resolvePromise, rejectPromise) => {
      httpServer.once('error', rejectPromise);
      httpServer.listen(wanted, '127.0.0.1', () => {
        httpServer.off('error', rejectPromise);
        resolvePromise();
      });
    });
  } catch (failure) {
    if (failure.code === 'EADDRINUSE') {
      throw new PortInUseError(wanted, await identifyHolder(wanted));
    }
    throw failure;
  }
  const bound = httpServer.address().port;
  return {
    httpServer,
    port: bound,
    url: `http://127.0.0.1:${bound}${MCP_PATH}`,
    close: () => new Promise((resolvePromise) => {
      httpServer.close(() => resolvePromise());
      httpServer.closeAllConnections?.();
    }),
  };
}

/** 'video-creator' when our own health endpoint answers on that port, otherwise 'other'. */
export async function identifyHolder(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}${HEALTH_PATH}`, { signal: AbortSignal.timeout(1500) });
    const body = await response.json();
    return body?.name === SERVER_INFO.name ? 'video-creator' : 'other';
  } catch {
    return 'other';
  }
}

function isStatelessEra(req, message) {
  const header = req.headers['mcp-protocol-version'];
  const meta = message?.params?._meta?.['io.modelcontextprotocol/protocolVersion'];
  return header === STATELESS_PROTOCOL_VERSION || meta === STATELESS_PROTOCOL_VERSION;
}

function authorized(header, expected) {
  if (typeof header !== 'string') {
    return false;
  }
  const given = Buffer.from(header.trim());
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export function hostIsLoopback(host) {
  if (typeof host !== 'string' || host === '') {
    return false;
  }
  const name = host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.split(':')[0];
  return LOOPBACK_HOSTS.has(name.toLowerCase());
}

/** Browsers send Origin; a non-loopback page must never reach the endpoint. Non-browser clients send none. */
export function originIsLoopback(origin) {
  if (origin === undefined) {
    return true;
  }
  try {
    const { protocol, host } = new URL(origin);
    return (protocol === 'http:' || protocol === 'https:') && hostIsLoopback(host);
  } catch {
    return false;
  }
}

function readBody(req) {
  return new Promise((resolvePromise, rejectPromise) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      // Keep draining (but discard) so a 413 can still be written back.
      if (size <= MAX_BODY_BYTES) {
        chunks.push(chunk);
      }
    });
    req.on('end', () => {
      if (size > MAX_BODY_BYTES) {
        rejectPromise(Object.assign(new Error('body too large'), { code: 'BODY_TOO_LARGE' }));
        return;
      }
      resolvePromise(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', rejectPromise);
  });
}

function sendJson(res, status, body, headers = {}) {
  if (res.headersSent) {
    return;
  }
  const text = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers });
  res.end(text);
}

function rpcError(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}
