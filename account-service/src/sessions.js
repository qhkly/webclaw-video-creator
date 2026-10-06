// App sessions: opaque random tokens, revocable, stored in KV by hash.
//
// Auth issues only a 15-minute identity token and no refresh token, so the desktop
// app needs its own session (same role as ai-studio-web's launcher token). Unlike a
// signed JWT it can be revoked: logout or rotation deletes the KV record.
//
//   token  = "vcs_" + base64url(32 random bytes)        — only the app holds it
//   key    = "session:" + hex(sha256(token))            — a KV dump yields no usable token
//   record = { sub, email, authAt, iat, exp }           — authAt: the original Auth login
//
// Renewal rotates the token but never moves `authAt`: after SESSION_MAX_AGE_SECONDS the
// user has to sign in through Auth again. KV is eventually consistent, so a revocation
// can take up to ~60 s to reach every edge location.

const DEFAULT_TTL = 7 * 24 * 3600;
const DEFAULT_MAX_AGE = 30 * 24 * 3600;
const KV_MIN_TTL = 60;

const toInt = (value, fallback) => {
  const n = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

export const sessionTtl = (env) => toInt(env.SESSION_TTL_SECONDS, DEFAULT_TTL);
export const sessionMaxAge = (env) => toInt(env.SESSION_MAX_AGE_SECONDS, DEFAULT_MAX_AGE);

const bytesToB64url = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export const hashToken = async (token) => {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
};

const keyFor = async (token) => `session:${await hashToken(token)}`;

const TOKEN_RE = /^vcs_[A-Za-z0-9_-]{43}$/;

export const sessionsConfigured = (env) => Boolean(env.SESSIONS);

/** Create a session. `authAt` (unix s) is kept across renewals. */
export const createSession = async (env, { sub, email = null, authAt }) => {
  const now = Math.floor(Date.now() / 1000);
  const hardLimit = authAt + sessionMaxAge(env);
  const exp = Math.min(now + sessionTtl(env), hardLimit);
  if (exp <= now) return null;
  const token = `vcs_${bytesToB64url(crypto.getRandomValues(new Uint8Array(32)))}`;
  const record = { sub, email, authAt, iat: now, exp };
  await env.SESSIONS.put(await keyFor(token), JSON.stringify(record), { expirationTtl: Math.max(exp - now, KV_MIN_TTL) });
  return { token, expiresAt: exp, record };
};

/** Bearer token → live session record, or null. */
export const readSession = async (env, token) => {
  if (typeof token !== 'string' || !TOKEN_RE.test(token)) return null;
  const record = await env.SESSIONS.get(await keyFor(token), 'json');
  if (!record || typeof record.sub !== 'string' || typeof record.exp !== 'number') return null;
  // KV expiry is lazy; the record's own exp is authoritative.
  return record.exp > Math.floor(Date.now() / 1000) ? record : null;
};

export const deleteSession = async (env, token) => {
  if (typeof token !== 'string' || !TOKEN_RE.test(token)) return;
  await env.SESSIONS.delete(await keyFor(token));
};

export const bearer = (request) => {
  const header = request.headers.get('Authorization') || '';
  return header.startsWith('Bearer ') ? header.slice(7).trim() : null;
};
