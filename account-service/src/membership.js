// Membership: ask webclaw-store, never the app.
//
//   GET {STORE_BASE_URL}/api/v1/membership?product=webclaw-video-creator&auth_user_id=<sub>
//   Authorization: Basic base64(STORE_CLIENT_ID:STORE_CLIENT_SECRET)   scope read:entitlements
//
// Same contract as ccdub-speech-gateway/src/voice-master/membership.js
// (webclaw-store docs/billing-api.md, "WebClaw Video Creator"):
//   - only `member === true` grants anything; the store already resolved which row counts;
//   - fail closed: timeout, any non-2xx, or a response about another product/user → unavailable;
//   - isolate cache: positive 60 s, negative 15 s, failures never cached; `fresh` bypasses it
//     (the user just came back from checkout).

const TIMEOUT_MS = 4000;
const POSITIVE_TTL_MS = 60 * 1000;
const NEGATIVE_TTL_MS = 15 * 1000;
const MAX_MEMO = 5000;

const memo = new Map(); // authUserId -> { membership, expiresAt }

export const resetMembershipCache = () => memo.clear();

export const productSlug = (env) => env.PRODUCT_SLUG || 'webclaw-video-creator';

export const storeConfigured = (env) => Boolean(env.STORE_BASE_URL && env.STORE_CLIENT_ID && env.STORE_CLIENT_SECRET);

/** Only the fields the app uses; nothing about the caller's credential or internal ids. */
const pick = (body) => ({
  productSlug: body.productSlug,
  member: body.member === true,
  known: body.known === true,
  planSlug: body.planSlug ?? null,
  status: body.status ?? null,
  renewal: body.renewal ?? null,
  expiresAt: body.expiresAt ?? null,
  currentPeriodEnd: body.currentPeriodEnd ?? null,
  gracePeriodEndsAt: body.gracePeriodEndsAt ?? null,
  benefits: body.member === true && body.benefits && typeof body.benefits === 'object' ? body.benefits : null,
  checkedAt: body.checkedAt ?? new Date().toISOString(),
});

/**
 * @returns {Promise<{ ok: true, membership: object } | { ok: false, reason: string }>}
 */
export const checkMembership = async (env, authUserId, { fresh = false } = {}) => {
  if (!storeConfigured(env)) return { ok: false, reason: 'store_not_configured' };
  const now = Date.now();
  const hit = memo.get(authUserId);
  if (!fresh && hit && hit.expiresAt > now) return { ok: true, membership: hit.membership };

  const slug = productSlug(env);
  const base = String(env.STORE_BASE_URL).replace(/\/$/, '');
  let body;
  try {
    const response = await fetch(
      `${base}/api/v1/membership?product=${encodeURIComponent(slug)}&auth_user_id=${encodeURIComponent(authUserId)}`,
      {
        headers: {
          Authorization: `Basic ${btoa(`${env.STORE_CLIENT_ID}:${env.STORE_CLIENT_SECRET}`)}`,
          Accept: 'application/json',
        },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      },
    );
    if (!response.ok) {
      console.error(`[membership] store HTTP ${response.status}`);
      return { ok: false, reason: `store_http_${response.status}` };
    }
    body = await response.json();
  } catch (error) {
    console.error(`[membership] store unreachable: ${error.message}`);
    return { ok: false, reason: 'store_unreachable' };
  }

  // The answer must be about this user and this product; anything else is a fault, not a "no".
  if (!body || typeof body.member !== 'boolean' || body.productSlug !== slug || body.authUserId !== authUserId) {
    console.error('[membership] store returned an unexpected shape');
    return { ok: false, reason: 'store_bad_shape' };
  }

  const membership = pick(body);
  if (memo.size >= MAX_MEMO) memo.delete(memo.keys().next().value);
  memo.set(authUserId, { membership, expiresAt: now + (membership.member ? POSITIVE_TTL_MS : NEGATIVE_TTL_MS) });
  return { ok: true, membership };
};
