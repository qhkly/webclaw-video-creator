// Verify the identity JWT that auth.qhkly.com issues to the desktop app.
//
// Same rules as ccdub-speech-gateway's verifyAuthIdToken (Voice Master):
//   - RS256 only, against Auth's public key (inline PEM wins over the URL);
//   - `aud` must be in an explicit allowlist (the Auth client id `video-creator`,
//     NOT the store slug `webclaw-video-creator`) — every Auth login token verifies
//     against the same key, only `aud` tells products apart;
//   - `iss` must match, `exp` is required (identity tokens live 15 minutes);
//   - the token only says *who* the user is. Membership is never read from it.

const KEY_TTL_MS = 60 * 60 * 1000;
const keyMemo = new Map(); // url -> { key, expiresAt }

export const b64urlToBytes = (s) => {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(s.length / 4) * 4, '=');
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
};

const decodeJson = (segment) => JSON.parse(new TextDecoder().decode(b64urlToBytes(segment)));

export const splitList = (raw) =>
  String(raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

const importSpkiPem = (pem) => {
  const body = pem
    .replace(/-----BEGIN PUBLIC KEY-----/, '')
    .replace(/-----END PUBLIC KEY-----/, '')
    .replace(/\s+/g, '');
  return crypto.subtle.importKey(
    'spki',
    Uint8Array.from(atob(body), (c) => c.charCodeAt(0)),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify'],
  );
};

/** Auth's `GET /api/auth/public-key` → `{ publicKey: "<spki PEM>" }`, cached per isolate. */
const loadPublicKey = async (url) => {
  const cached = keyMemo.get(url);
  if (cached && cached.expiresAt > Date.now()) return cached.key;
  const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error(`public key fetch failed: ${response.status}`);
  const { publicKey } = await response.json();
  if (typeof publicKey !== 'string' || !publicKey.includes('BEGIN PUBLIC KEY')) {
    throw new Error('public key endpoint returned an unexpected shape');
  }
  const key = await importSpkiPem(publicKey);
  keyMemo.set(url, { key, expiresAt: Date.now() + KEY_TTL_MS });
  return key;
};

export const resetKeyCache = () => keyMemo.clear();

export const authConfigured = (env) => Boolean(env.AUTH_JWT_PUBLIC_KEY_PEM || env.AUTH_JWT_PUBLIC_KEY_URL);

/**
 * @returns {Promise<{ ok: true, userId: string, email: string | null, authTime: number | null } | { ok: false, reason: string, keyFailure?: boolean }>}
 */
export const verifyIdToken = async (token, env) => {
  if (!authConfigured(env)) return { ok: false, reason: 'auth public key not configured', keyFailure: true };
  if (typeof token !== 'string') return { ok: false, reason: 'missing token' };
  const parts = token.split('.');
  if (parts.length !== 3) return { ok: false, reason: 'malformed JWT' };

  let header;
  let payload;
  try {
    header = decodeJson(parts[0]);
    payload = decodeJson(parts[1]);
  } catch {
    return { ok: false, reason: 'undecodable JWT' };
  }
  if (header.alg !== 'RS256') return { ok: false, reason: `unsupported alg ${header.alg}` };

  let keys;
  try {
    keys = env.AUTH_JWT_PUBLIC_KEY_PEM
      ? [await importSpkiPem(env.AUTH_JWT_PUBLIC_KEY_PEM)]
      : [await loadPublicKey(env.AUTH_JWT_PUBLIC_KEY_URL)];
  } catch (error) {
    // Our failure, not the token's: the caller answers 503, not 401.
    console.error(`[jwt] public key unavailable: ${error.message}`);
    return { ok: false, reason: 'public key unavailable', keyFailure: true };
  }

  const signature = b64urlToBytes(parts[2]);
  const signed = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
  let verified = false;
  for (const key of keys) {
    if (await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, signature, signed)) {
      verified = true;
      break;
    }
  }
  if (!verified) return { ok: false, reason: 'bad signature' };

  const audiences = splitList(env.AUTH_AUDIENCES || 'video-creator');
  const auds = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!auds.some((aud) => audiences.includes(aud))) return { ok: false, reason: 'wrong audience' };
  if (payload.iss !== (env.AUTH_JWT_ISSUER || 'auth.qhkly.com')) return { ok: false, reason: 'wrong issuer' };

  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== 'number') return { ok: false, reason: 'missing exp' };
  if (payload.exp < now) return { ok: false, reason: 'expired' };
  if (typeof payload.nbf === 'number' && payload.nbf > now) return { ok: false, reason: 'not yet valid' };

  const userId = typeof payload.sub === 'string' ? payload.sub : '';
  if (!userId) return { ok: false, reason: 'missing sub' };
  return {
    ok: true,
    userId,
    email: typeof payload.email === 'string' ? payload.email : null,
    authTime: typeof payload.auth_time === 'number' ? payload.auth_time : null,
  };
};
