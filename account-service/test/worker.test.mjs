import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import worker from '../src/index.js';
import { resetKeyCache } from '../src/jwt.js';
import { resetMembershipCache } from '../src/membership.js';
import { hashToken } from '../src/sessions.js';

const SECRET = 'store-secret-must-never-leak';
const SUB = 'usr_0123456789abcdef01234567';
const SLUG = 'webclaw-video-creator';

const b64url = (bytes) => Buffer.from(bytes).toString('base64url');
const enc = (obj) => b64url(Buffer.from(JSON.stringify(obj)));

const { privateKey, publicKey } = await crypto.subtle.generateKey(
  { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
  true,
  ['sign', 'verify'],
);
const otherKeys = await crypto.subtle.generateKey(
  { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
  true,
  ['sign', 'verify'],
);
const spki = Buffer.from(await crypto.subtle.exportKey('spki', publicKey)).toString('base64');
const PEM = `-----BEGIN PUBLIC KEY-----\n${spki.match(/.{1,64}/g).join('\n')}\n-----END PUBLIC KEY-----`;

const now = () => Math.floor(Date.now() / 1000);

async function idToken(claims = {}, { key = privateKey, alg = 'RS256' } = {}) {
  const header = enc({ alg, typ: 'JWT' });
  const payload = enc({ iss: 'auth.qhkly.com', aud: 'video-creator', sub: SUB, email: 'a@example.com', iat: now(), exp: now() + 900, ...claims });
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(`${header}.${payload}`));
  return `${header}.${payload}.${b64url(new Uint8Array(sig))}`;
}

function kv() {
  const map = new Map();
  return {
    map,
    async get(key, type) {
      const value = map.get(key);
      return value === undefined ? null : type === 'json' ? JSON.parse(value) : value;
    },
    async put(key, value) {
      map.set(key, value);
    },
    async delete(key) {
      map.delete(key);
    },
  };
}

let env;
let storeCalls;
let storeReply;
const realFetch = globalThis.fetch;

beforeEach(() => {
  resetKeyCache();
  resetMembershipCache();
  storeCalls = [];
  storeReply = (url) =>
    Response.json({ productSlug: SLUG, authUserId: new URL(url).searchParams.get('auth_user_id'), member: true, known: true, planSlug: 'pro-yearly',
      status: 'active', renewal: 'auto', expiresAt: '2027-10-06T00:00:00.000Z', currentPeriodEnd: '2027-10-06T00:00:00.000Z',
      gracePeriodEndsAt: null, benefits: { aiDirector: true, maxExportHeight: 2160 }, checkedAt: '2026-10-06T00:00:00.000Z' });
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    if (url.startsWith('https://store.test/')) {
      storeCalls.push({ url, auth: init.headers?.Authorization });
      return storeReply(url);
    }
    if (url === 'https://auth.test/api/auth/public-key') return Response.json({ publicKey: PEM });
    throw new Error(`unexpected fetch ${url}`);
  };
  env = {
    AUTH_JWT_PUBLIC_KEY_PEM: PEM,
    AUTH_JWT_ISSUER: 'auth.qhkly.com',
    AUTH_AUDIENCES: 'video-creator',
    STORE_BASE_URL: 'https://store.test',
    STORE_CLIENT_ID: SLUG,
    STORE_CLIENT_SECRET: SECRET,
    PRODUCT_SLUG: SLUG,
    SESSIONS: kv(),
  };
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

const call = (method, path, { body, token, headers = {} } = {}) =>
  worker.fetch(
    new Request(`https://video-api.test${path}`, {
      method,
      headers: {
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    }),
    env,
  );

async function openSession() {
  const res = await call('POST', '/v1/session', { body: { idToken: await idToken(), product: SLUG } });
  assert.equal(res.status, 200);
  return res.json();
}

test('session: valid idToken opens a hashed, revocable session with membership', async () => {
  const body = await openSession();
  assert.match(body.token, /^vcs_[A-Za-z0-9_-]{43}$/);
  assert.ok(body.expiresAt > now() + 6 * 24 * 3600);
  assert.equal(body.membership.member, true);
  assert.equal(body.membership.planSlug, 'pro-yearly');
  assert.deepEqual(body.membership.benefits, { aiDirector: true, maxExportHeight: 2160 });
  // KV holds only the hash, never the token.
  const keys = [...env.SESSIONS.map.keys()];
  assert.deepEqual(keys, [`session:${await hashToken(body.token)}`]);
  assert.ok(![...env.SESSIONS.map.values()].some((v) => v.includes(body.token)));
  // The store got the server-side Basic credential and the verified sub.
  assert.equal(storeCalls.length, 1);
  assert.equal(storeCalls[0].auth, `Basic ${btoa(`${SLUG}:${SECRET}`)}`);
  const storeUrl = new URL(storeCalls[0].url);
  assert.equal(storeUrl.pathname, '/api/v1/membership');
  assert.equal(storeUrl.searchParams.get('product'), SLUG);
  assert.equal(storeUrl.searchParams.get('auth_user_id'), SUB);
});

test('session: public key can come from the Auth URL', async () => {
  delete env.AUTH_JWT_PUBLIC_KEY_PEM;
  env.AUTH_JWT_PUBLIC_KEY_URL = 'https://auth.test/api/auth/public-key';
  await openSession();
});

test('session: rejects every idToken that is not for this app', async () => {
  const bad = [
    await idToken({ aud: 'voice-master' }),
    await idToken({ aud: SLUG }), // the store slug is not the Auth client id
    await idToken({ iss: 'webclaw-platform' }),
    await idToken({ exp: now() - 1 }),
    await idToken({ exp: undefined }),
    await idToken({ sub: '' }),
    await idToken({ nbf: now() + 600 }),
    await idToken({}, { key: otherKeys.privateKey }),
    (await idToken()).replace(/\.[^.]+$/, '.AAAA'),
    `${enc({ alg: 'none' })}.${enc({ iss: 'auth.qhkly.com', aud: 'video-creator', sub: SUB, exp: now() + 900 })}.`,
    'not-a-jwt',
  ];
  for (const token of bad) {
    const res = await call('POST', '/v1/session', { body: { idToken: token } });
    assert.equal(res.status, 401, token.slice(0, 40));
    assert.deepEqual(await res.json(), { error: 'invalid_id_token' });
  }
  assert.equal(env.SESSIONS.map.size, 0);
  assert.equal(storeCalls.length, 0);
});

test('session: bad requests', async () => {
  assert.equal((await call('POST', '/v1/session', { body: '{nope' })).status, 400);
  assert.equal((await call('POST', '/v1/session', { body: {} })).status, 400);
  assert.equal((await call('POST', '/v1/session', { body: { idToken: await idToken(), product: 'ccdub' } })).status, 400);
  const plain = await worker.fetch(new Request('https://video-api.test/v1/session', { method: 'POST', body: '{}' }), env);
  assert.equal(plain.status, 400);
  assert.equal((await call('POST', '/v1/session', { body: { idToken: 'x'.repeat(20000) } })).status, 400);
});

test('session: still opens when the store is down, just without membership', async () => {
  storeReply = () => new Response('boom', { status: 503 });
  const res = await call('POST', '/v1/session', { body: { idToken: await idToken() } });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(body.token);
  assert.equal('membership' in body, false);
});

test('membership: answers for the session user, caches positives, fresh bypasses', async () => {
  const { token } = await openSession();
  storeCalls = [];
  const first = await call('GET', `/v1/membership?product=${SLUG}`, { token });
  assert.equal(first.status, 200);
  const body = await first.json();
  assert.equal(body.member, true);
  assert.equal('authUserId' in body, false);
  // Cached (session open already fetched fresh and populated the cache).
  assert.equal(storeCalls.length, 0);
  await call('GET', `/v1/membership?product=${SLUG}&fresh=1`, { token });
  assert.equal(storeCalls.length, 1);
});

test('membership: non-members get member:false and no benefits', async () => {
  storeReply = (url) => Response.json({ productSlug: SLUG, authUserId: new URL(url).searchParams.get('auth_user_id'), member: false, known: false, benefits: { aiDirector: true } });
  const { token } = await openSession();
  const body = await (await call('GET', '/v1/membership?fresh=1', { token })).json();
  assert.equal(body.member, false);
  assert.equal(body.benefits, null);
});

test('membership: fails closed on store errors and foreign answers', async () => {
  const { token } = await openSession();
  const replies = [
    () => new Response('{}', { status: 401 }),
    () => new Response('{}', { status: 403 }),
    () => new Response('{}', { status: 404 }),
    () => new Response('{}', { status: 503 }),
    () => {
      throw new Error('timeout');
    },
    () => Response.json({ productSlug: SLUG, authUserId: SUB, member: 'true' }),
    () => Response.json({ productSlug: 'ccdub', authUserId: SUB, member: true }),
    () => Response.json({ productSlug: SLUG, authUserId: 'usr_someone_else', member: true }),
  ];
  for (const reply of replies) {
    storeReply = reply;
    const res = await call('GET', '/v1/membership?fresh=1', { token });
    assert.equal(res.status, 503);
    assert.deepEqual(await res.json(), { error: 'membership_unavailable' });
  }
});

test('membership: requires a live session', async () => {
  for (const token of [undefined, 'garbage', `vcs_${'A'.repeat(43)}`]) {
    assert.equal((await call('GET', '/v1/membership', { token })).status, 401);
  }
  assert.equal((await call('GET', '/v1/membership?product=ccdub', { token: 'x' })).status, 400);
});

test('renew rotates the token, revoke kills it', async () => {
  const { token } = await openSession();
  const renew = await call('POST', '/v1/session/renew', { token });
  assert.equal(renew.status, 200);
  const renewed = await renew.json();
  assert.notEqual(renewed.token, token);
  assert.equal((await call('GET', '/v1/membership', { token })).status, 401);
  assert.equal((await call('GET', '/v1/membership', { token: renewed.token })).status, 200);

  assert.equal((await call('POST', '/v1/session/revoke', { token: renewed.token })).status, 200);
  assert.equal((await call('GET', '/v1/membership', { token: renewed.token })).status, 401);
  // Idempotent.
  assert.equal((await call('POST', '/v1/session/revoke', { token: renewed.token })).status, 200);
  assert.equal(env.SESSIONS.map.size, 0);
});

test('renew cannot outlive the max session age; expired records are refused', async () => {
  const { token } = await openSession();
  const key = `session:${await hashToken(token)}`;
  const record = JSON.parse(env.SESSIONS.map.get(key));
  env.SESSIONS.map.set(key, JSON.stringify({ ...record, authAt: now() - 31 * 24 * 3600 }));
  const res = await call('POST', '/v1/session/renew', { token });
  assert.equal(res.status, 401);
  assert.deepEqual(await res.json(), { error: 'reauth_required' });

  env.SESSIONS.map.set(key, JSON.stringify({ ...record, exp: now() - 1 }));
  assert.equal((await call('GET', '/v1/membership', { token })).status, 401);
});

test('CORS: browsers are refused unless their origin is allowlisted', async () => {
  const foreign = await call('GET', '/healthz', { headers: { Origin: 'https://evil.example' } });
  assert.equal(foreign.status, 403);
  assert.equal(foreign.headers.get('Access-Control-Allow-Origin'), null);

  env.ALLOWED_ORIGINS = 'https://creator.qhkly.com';
  const ok = await call('GET', '/healthz', { headers: { Origin: 'https://creator.qhkly.com' } });
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get('Access-Control-Allow-Origin'), 'https://creator.qhkly.com');
  const preflight = await call('OPTIONS', '/v1/membership', { headers: { Origin: 'https://creator.qhkly.com' } });
  assert.equal(preflight.status, 204);
  assert.match(preflight.headers.get('Access-Control-Allow-Headers'), /Authorization/);

  const native = await call('GET', '/healthz');
  assert.equal(native.headers.get('Access-Control-Allow-Origin'), null);
  assert.equal(native.headers.get('Cache-Control'), 'no-store');
});

test('misconfiguration is reported by name, never by value', async () => {
  delete env.STORE_CLIENT_SECRET;
  const health = await call('GET', '/healthz');
  assert.equal(health.status, 503);
  const text = await health.text();
  assert.match(text, /STORE_CLIENT_SECRET/);
  assert.equal((await call('POST', '/v1/session', { body: { idToken: await idToken() } })).status, 503);

  env.STORE_CLIENT_SECRET = SECRET;
  const healthy = await call('GET', '/healthz');
  assert.equal(healthy.status, 200);
  assert.ok(!(await healthy.text()).includes(SECRET));
});

test('auth key outage is a 503, not a 401', async () => {
  delete env.AUTH_JWT_PUBLIC_KEY_PEM;
  env.AUTH_JWT_PUBLIC_KEY_URL = 'https://auth.test/down';
  const res = await call('POST', '/v1/session', { body: { idToken: await idToken() } });
  assert.equal(res.status, 503);
});

test('routing', async () => {
  assert.equal((await call('GET', '/nope')).status, 404);
  assert.equal((await call('GET', '/v1/session')).status, 405);
  assert.equal((await call('DELETE', '/v1/membership')).status, 405);
});

test('no response ever contains the store secret', async () => {
  const { token } = await openSession();
  for (const res of [
    await call('GET', '/v1/membership?fresh=1', { token }),
    await call('POST', '/v1/session/renew', { token }),
    await call('GET', '/healthz'),
  ]) {
    assert.ok(!(await res.text()).includes(SECRET));
  }
});
