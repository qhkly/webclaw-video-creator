// Runs the REAL support Worker (webcode-support/worker/src/index.js) in-process for the app's tests:
// D1 -> node:sqlite, R2 -> in-memory map, events publish -> stub. The Worker lives in another repo;
// find it via SUPPORT_WORKER_SRC or the sibling checkout. No Worker => tests report SKIPPED (never "passed").
//
// Auth is simulated here, in test code only: an ephemeral ES256 key stands in for auth.qhkly.com and its
// public JWK goes into SUPPORT_TICKET_TENANTS exactly as the rollout runbook does. The app itself never signs.
//
// `video-creator` is not yet a tenant in the deployed Worker's products.js (see docs/support-widget.md,
// blocker 1). Until that lands upstream this harness registers it at load time and says so.
import { DatabaseSync } from 'node:sqlite';
import { existsSync, readFileSync } from 'node:fs';
import { generateKeyPairSync, sign, randomUUID } from 'node:crypto';
import { registerHooks } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const candidates = [
  process.env.SUPPORT_WORKER_SRC,
  path.resolve(here, '../../../../webcode-support/worker'), // <webcode>/webclaw-video-creator.worktrees/chatgpt/<id>/tests
  path.resolve(here, '../../webcode-support/worker'), // <webcode>/webclaw-video-creator/tests
].filter(Boolean);
export const WORKER_DIR = candidates.find((dir) => existsSync(path.join(dir, 'src/index.js')) && existsSync(path.join(dir, 'src/auth.js')));
export const skipReason = WORKER_DIR ? false : 'support Worker not found (set SUPPORT_WORKER_SRC=<webcode-support>/worker); real-Worker tests SKIPPED';

export const ORIGIN = 'https://support.test';
export const APP = 'video-creator';
export let workerPatchedProducts = false;
export let worker = null;

if (WORKER_DIR) {
  registerHooks({
    load(url, context, next) {
      if (url.endsWith('.html')) {
        const html = readFileSync(new URL(url), 'utf8');
        return { format: 'module', source: `export default ${JSON.stringify(html)};`, shortCircuit: true };
      }
      if (url.endsWith('/src/products.js')) {
        const result = next(url, context);
        const source = String(result.source);
        if (!source.includes("'video-creator'") && !source.includes('"video-creator"')) {
          workerPatchedProducts = true;
          const entry = `'${APP}': Object.freeze({ label: 'WebClaw Video Creator', name: 'WebClaw Video Creator', identity: 'WebClaw Video Creator, a desktop app for making videos', scope: 'redirect', terms: ['WebClaw Video Creator', 'Video Creator'] }),`;
          return { ...result, source: source.replace('export const PRODUCTS = Object.freeze({', `export const PRODUCTS = Object.freeze({\n  ${entry}`) };
        }
        return result;
      }
      return next(url, context);
    },
  });
  worker = (await import(pathToFileURL(path.join(WORKER_DIR, 'src/index.js')).href)).default;
}

function makeD1(schema) {
  const db = new DatabaseSync(':memory:');
  db.exec(schema);
  const exec = (sql, args, kind) => {
    const st = db.prepare(sql);
    if (kind === 'first') return st.get(...args) ?? null;
    if (kind === 'all') return { results: st.all(...args) };
    const r = st.run(...args);
    return { meta: { changes: r.changes, last_row_id: Number(r.lastInsertRowid) } };
  };
  const query = (sql, args = []) => ({
    sql, args, bind: (...v) => query(sql, v),
    first: async () => exec(sql, args, 'first'),
    all: async () => exec(sql, args, 'all'),
    run: async () => exec(sql, args, 'run'),
  });
  return {
    db,
    D1: {
      prepare: (sql) => query(sql),
      batch: async (stmts) => {
        db.exec('BEGIN');
        try { const out = stmts.map((s) => exec(s.sql, s.args, 'run')); db.exec('COMMIT'); return out; } catch (e) { db.exec('ROLLBACK'); throw e; }
      },
    },
  };
}

function makeR2() {
  const objs = new Map();
  return {
    objs,
    async put(key, buf, opts = {}) { objs.set(key, { buf: new Uint8Array(buf), ...opts }); },
    async get(key) {
      const o = objs.get(key);
      if (!o) return null;
      return { body: o.buf, httpEtag: '"e"', writeHttpMetadata(h) { if (o.httpMetadata?.contentType) h.set('Content-Type', o.httpMetadata.contentType); } };
    },
    async list({ prefix }) { return { objects: [...objs.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key })), truncated: false }; },
    async delete(keys) { for (const k of [].concat(keys)) objs.delete(k); },
  };
}

const b64u = (buf) => Buffer.from(buf).toString('base64url');

/** Stand-in for auth.qhkly.com's ticket signer. Test-only: src/ never contains signing code. */
export function authSimulator({ kid = 'test-kid' } = {}) {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid, alg: 'ES256', use: 'sig' };
  const uidOf = (n) => 'u_' + String(n).padStart(22, 'A').slice(-22);
  function mint(uid, { app = APP, ttl = 600 } = {}) {
    const now = Math.floor(Date.now() / 1000);
    const header = b64u(JSON.stringify({ alg: 'ES256', typ: 'JWT', kid }));
    const claims = b64u(JSON.stringify({ iss: 'auth.qhkly.com', aud: 'support.qhkly.com', app, sub: uid, tier: 'user', plan: 'free', iat: now, exp: now + ttl, jti: randomUUID() }));
    const sig = sign('sha256', Buffer.from(`${header}.${claims}`), { key: privateKey, dsaEncoding: 'ieee-p1363' });
    return { ticket: `${header}.${claims}.${b64u(sig)}`, uid, expiresAt: now + ttl };
  }
  const tenants = (mode = 'ticket_only') => JSON.stringify({ '*': { iss: 'auth.qhkly.com', jwks: { keys: [jwk] } }, [APP]: { mode } });
  return { jwk, mint, uidOf, tenants };
}

/** One isolated Worker environment. */
export function makeEnv(over = {}) {
  const schema = readFileSync(path.join(WORKER_DIR, 'schema.sql'), 'utf8');
  const { db, D1 } = makeD1(schema);
  const FILES = makeR2();
  const env = { DB: D1, FILES, SIGN_SECRET: 'test-only-legacy-key', ADMIN_EMAILS: 'ops@example.com', ...over };
  const pending = [];
  const ctx = { waitUntil: (p) => pending.push(Promise.resolve(p).catch(() => {})) };
  const seen = []; // every request the client made: {url, method, headers, body}
  globalThis.fetch = async () => new Response('{}', { status: 503 }); // Worker-side outbound (LLM, events) stays offline
  const clientFetch = async (input, init = {}) => {
    const req = new Request(String(input), init);
    if (!req.url.startsWith(ORIGIN)) throw new Error(`unexpected url ${req.url}`);
    const headers = new Headers(req.headers);
    seen.push({ url: req.url, method: req.method, headers: Object.fromEntries(headers), body: typeof init.body === 'string' ? init.body : null });
    headers.set('CF-Connecting-IP', `10.0.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`);
    return worker.fetch(new Request(req, { headers }), env, ctx);
  };
  return { env, db, FILES, seen, fetch: clientFetch, async drain() { while (pending.length) await pending.shift(); } };
}

/** What the admin reply endpoint does to the DB: a message row plus the user's unread counter. */
export function putAdminReply(db, uid, text) {
  const id = Number(db.prepare(
    'INSERT INTO messages(app,uid,role,text_src,text_zh,text_out,lang,meta,created_at) VALUES(?,?,?,?,?,?,?,?,?)',
  ).run(APP, uid, 'admin', text, text, text, 'zh', null, Date.now()).lastInsertRowid);
  db.prepare('UPDATE threads SET unread_user = unread_user + 1, last_at = ? WHERE app = ? AND uid = ?').run(Date.now(), APP, uid);
  return id;
}

// 1x1 transparent PNG: the Worker identifies attachments by file header, not by the claimed type.
export const PNG_1X1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
