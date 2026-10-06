// WebClaw Video Creator account service (Cloudflare Worker).
//
// The desktop app holds only the user's own Auth login; this Worker holds the
// webclaw-store credential the app must never ship. It does three things:
//   1. verifies the auth.qhkly.com idToken and opens a revocable app session;
//   2. answers membership by asking the store with its own credential;
//   3. renews / revokes those sessions.
//
// Contract consumed by src-tauri/src/commands/account_commands.rs; see
// account-service/README.md and docs/account-membership.md.

import { authConfigured, splitList, verifyIdToken } from './jwt.js';
import { checkMembership, productSlug, storeConfigured } from './membership.js';
import { bearer, createSession, deleteSession, readSession, sessionsConfigured } from './sessions.js';

const MAX_BODY_BYTES = 16 * 1024;

const baseHeaders = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
};

const json = (body, status = 200, extra = {}) => new Response(JSON.stringify(body), { status, headers: { ...baseHeaders, ...extra } });
const fail = (status, error) => json({ error }, status);

/**
 * CORS. The desktop app calls from native code and sends no Origin, so by default no
 * browser origin is allowed: a page cannot use a stolen session through a visitor's
 * browser, and cross-origin reads get no CORS grant. ALLOWED_ORIGINS (comma-separated,
 * exact https origins) opens it for a future web client.
 */
const corsFor = (request, env) => {
  const origin = request.headers.get('Origin');
  if (!origin) return { allowed: true, headers: {} };
  if (!splitList(env.ALLOWED_ORIGINS).includes(origin)) return { allowed: false, headers: {} };
  return {
    allowed: true,
    headers: {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Headers': 'Authorization, Content-Type',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Max-Age': '600',
      Vary: 'Origin',
    },
  };
};

const readJson = async (request) => {
  if (!(request.headers.get('Content-Type') || '').toLowerCase().includes('application/json')) return { error: 'content_type_must_be_json' };
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) return { error: 'body_too_large' };
  try {
    const value = JSON.parse(text);
    return value && typeof value === 'object' && !Array.isArray(value) ? { value } : { error: 'invalid_json' };
  } catch {
    return { error: 'invalid_json' };
  }
};

const misconfigured = (env) => {
  const missing = [];
  if (!authConfigured(env)) missing.push('AUTH_JWT_PUBLIC_KEY_URL|AUTH_JWT_PUBLIC_KEY_PEM');
  if (!storeConfigured(env)) missing.push('STORE_BASE_URL|STORE_CLIENT_ID|STORE_CLIENT_SECRET');
  if (!sessionsConfigured(env)) missing.push('SESSIONS (KV)');
  return missing;
};

const wrongProduct = (env, value) => value !== undefined && value !== null && value !== productSlug(env);

const routes = {
  'GET /healthz': async (_request, env) => {
    const missing = misconfigured(env);
    // Names of missing settings only; never values.
    return json({ ok: missing.length === 0, service: 'webclaw-video-creator-account', product: productSlug(env), missing }, missing.length ? 503 : 200);
  },

  /** idToken → app session (+ membership when the store answers). */
  'POST /v1/session': async (request, env) => {
    const body = await readJson(request);
    if (body.error) return fail(400, body.error);
    const { idToken, product } = body.value;
    if (wrongProduct(env, product)) return fail(400, 'unknown_product');
    if (typeof idToken !== 'string' || !idToken) return fail(400, 'id_token_required');

    const identity = await verifyIdToken(idToken, env);
    if (!identity.ok) {
      if (identity.keyFailure) return fail(503, 'auth_unavailable');
      console.warn(`[session] idToken rejected: ${identity.reason}`);
      return fail(401, 'invalid_id_token');
    }
    const now = Math.floor(Date.now() / 1000);
    const session = await createSession(env, { sub: identity.userId, email: identity.email, authAt: now });
    const membership = await checkMembership(env, identity.userId, { fresh: true });
    return json({
      token: session.token,
      expiresAt: session.expiresAt,
      ...(membership.ok ? { membership: membership.membership } : {}),
    });
  },

  /** The store's answer for the session's user. 401 = sign in again; 503 = fail closed. */
  'GET /v1/membership': async (request, env, url) => {
    if (wrongProduct(env, url.searchParams.get('product'))) return fail(400, 'unknown_product');
    const session = await readSession(env, bearer(request));
    if (!session) return fail(401, 'invalid_session');
    const result = await checkMembership(env, session.sub, { fresh: url.searchParams.get('fresh') === '1' });
    if (!result.ok) return fail(503, 'membership_unavailable');
    return json(result.membership);
  },

  /** Rotate the token; the original login time (and so the max age) carries over. */
  'POST /v1/session/renew': async (request, env) => {
    const token = bearer(request);
    const session = await readSession(env, token);
    if (!session) return fail(401, 'invalid_session');
    const renewed = await createSession(env, { sub: session.sub, email: session.email, authAt: session.authAt });
    if (!renewed) return fail(401, 'reauth_required');
    await deleteSession(env, token);
    return json({ token: renewed.token, expiresAt: renewed.expiresAt });
  },

  /** Idempotent: unknown or already-revoked tokens also answer ok. */
  'POST /v1/session/revoke': async (request, env) => {
    await deleteSession(env, bearer(request));
    return json({ ok: true });
  },
};

const handle = async (request, env) => {
  const url = new URL(request.url);
  const cors = corsFor(request, env);
  if (!cors.allowed) return fail(403, 'origin_not_allowed');
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors.headers });

  const route = routes[`${request.method} ${url.pathname}`];
  if (!route) {
    const known = Object.keys(routes).some((key) => key.endsWith(` ${url.pathname}`));
    return fail(known ? 405 : 404, known ? 'method_not_allowed' : 'not_found');
  }
  if (url.pathname.startsWith('/v1/') && misconfigured(env).length) {
    console.error(`[config] missing: ${misconfigured(env).join(', ')}`);
    return fail(503, 'service_misconfigured');
  }
  const response = await route(request, env, url);
  for (const [name, value] of Object.entries(cors.headers)) response.headers.set(name, value);
  return response;
};

export default {
  async fetch(request, env) {
    try {
      return await handle(request, env);
    } catch (error) {
      // Never echo internals (or anything derived from env) to the client.
      console.error(`[unhandled] ${error?.stack || error}`);
      return fail(500, 'internal_error');
    }
  },
};
