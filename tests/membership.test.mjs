import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  FREE_LIMITS,
  MEMBERSHIP_POLICY,
  PAID_FEATURES,
  allowsResolution,
  planLimits,
  accountLabel,
  canPurchase,
  featureAccess,
  formatDate,
  membershipBadge,
} from '../src/lib/membership.ts';

const user = { authUserId: 'usr_0123456789abcdef01234567', email: 'a@example.com', name: null, image: null };

function account(patch = {}) {
  return {
    loginStatus: 'idle',
    loginError: null,
    loginUrl: null,
    user,
    membership: null,
    membershipCheckedAt: null,
    phase: 'fresh',
    entitled: false,
    limits: FREE_LIMITS,
    serviceConfigured: true,
    lastError: null,
    productSlug: 'webclaw-video-creator',
    plans: ['pro-monthly', 'pro-yearly'],
    ...patch,
  };
}

const membership = (patch = {}) => ({
  member: true,
  known: true,
  planSlug: 'pro-yearly',
  status: 'active',
  renewal: 'auto',
  expiresAt: '2027-06-15T00:00:00.000Z',
  currentPeriodEnd: null,
  benefits: { watermarkFree: true, maxExportHeight: 2160, aiDirector: true, aiCutCleanup: true, commercialUse: true },
  ...patch,
});


const PRO_LIMITS = { maxExportHeight: 2160, watermark: false, aiDirector: true, aiCutCleanup: true, commercialUse: true };
const pro = (patch = {}) => account({ entitled: true, membership: membership(), limits: PRO_LIMITS, ...patch });

test('gating is on and every paid feature is closed for the free plan', () => {
  assert.equal(MEMBERSHIP_POLICY.enforce, true);
  for (const feature of PAID_FEATURES) {
    assert.notEqual(featureAccess(feature, null), 'allowed', feature);
    assert.notEqual(featureAccess(feature, account({ user: null, phase: 'signedOut', limits: FREE_LIMITS })), 'allowed', feature);
    assert.notEqual(featureAccess(feature, account({ limits: FREE_LIMITS })), 'allowed', feature);
    assert.equal(featureAccess(feature, pro()), 'allowed', feature);
  }
});

test('access reason: sign in, upgrade, or unavailable — never a silent allow', () => {
  const f = 'agent.director';
  assert.equal(featureAccess(f, null), 'unavailable');
  assert.equal(featureAccess(f, account({ user: null, phase: 'signedOut', limits: FREE_LIMITS })), 'signIn');
  assert.equal(featureAccess(f, account({ phase: 'sessionExpired', limits: FREE_LIMITS })), 'signIn');
  assert.equal(featureAccess(f, account({ membership: membership({ member: false }), limits: FREE_LIMITS })), 'upgrade');
  assert.equal(featureAccess(f, account({ phase: 'cached', membership: membership({ member: false }), limits: FREE_LIMITS })), 'upgrade');
  for (const phase of ['unconfigured', 'offline', 'error']) {
    assert.equal(featureAccess(f, account({ phase, limits: FREE_LIMITS })), 'unavailable', phase);
  }
  // Member whose benefits lack this capability: upgrade, not allowed.
  assert.equal(featureAccess(f, pro({ limits: { ...PRO_LIMITS, aiDirector: false } })), 'upgrade');
  // Turning enforcement off (tests / future) opens everything.
  assert.equal(featureAccess(f, null, { enforce: false, paidFeatures: new Set(PAID_FEATURES) }), 'allowed');
});

test('features map onto the plan limits the commands enforce', () => {
  const at = (limits) => account({ entitled: true, membership: membership(), limits });
  assert.equal(featureAccess('export.1080p', at({ ...FREE_LIMITS, maxExportHeight: 1080 })), 'allowed');
  assert.equal(featureAccess('export.4k', at({ ...FREE_LIMITS, maxExportHeight: 1080 })), 'upgrade');
  assert.equal(featureAccess('export.noWatermark', at({ ...FREE_LIMITS, watermark: false })), 'allowed');
  assert.equal(featureAccess('cutter.aiCleanup', at({ ...FREE_LIMITS, aiCutCleanup: true })), 'allowed');
  assert.equal(allowsResolution(FREE_LIMITS, '720p'), true);
  assert.equal(allowsResolution(FREE_LIMITS, '1080p'), false);
  assert.equal(allowsResolution(PRO_LIMITS, '4K'), true);
});

test('planLimits fails closed field by field', () => {
  assert.deepEqual(planLimits(null), FREE_LIMITS);
  assert.deepEqual(planLimits(account({ limits: undefined })), FREE_LIMITS);
  assert.deepEqual(planLimits(pro()), PRO_LIMITS);
  assert.deepEqual(
    planLimits(account({ limits: { maxExportHeight: '2160', watermark: 'false', aiDirector: 1, aiCutCleanup: 'yes', commercialUse: null } })),
    FREE_LIMITS,
  );
  assert.equal(planLimits(account({ limits: { ...PRO_LIMITS, maxExportHeight: 99999 } })).maxExportHeight, 2160);
});

test('badge reflects plan and phase', () => {
  assert.equal(membershipBadge(null), 'checking');
  assert.equal(membershipBadge(account({ user: null, phase: 'signedOut' })), 'signedOut');
  assert.equal(membershipBadge(account({ entitled: true, membership: membership() })), 'member');
  assert.equal(membershipBadge(account({ entitled: true, membership: membership({ planSlug: 'lifetime' }) })), 'lifetime');
  assert.equal(membershipBadge(account({ entitled: true, membership: membership({ planSlug: 'trial' }) })), 'trial');
  assert.equal(membershipBadge(account({ membership: membership({ member: false }) })), 'free');
  assert.equal(membershipBadge(account({ phase: 'cached' })), 'checking');
  assert.equal(membershipBadge(account({ phase: 'sessionExpired' })), 'sessionExpired');
  assert.equal(membershipBadge(account({ phase: 'unconfigured' })), 'unavailable');
  assert.equal(membershipBadge(account({ phase: 'offline', membership: membership() })), 'unavailable');
});

test('purchase entry: non-members, trials and cancelled subscriptions can buy', () => {
  assert.equal(canPurchase(null), false);
  assert.equal(canPurchase(account({ user: null })), false);
  assert.equal(canPurchase(account()), true);
  assert.equal(canPurchase(account({ entitled: true, membership: membership() })), false);
  assert.equal(canPurchase(account({ entitled: true, membership: membership({ planSlug: 'trial' }) })), true);
  assert.equal(canPurchase(account({ entitled: true, membership: membership({ renewal: 'cancelled' }) })), true);
  // WeChat Pay: one-time, expires, extended by paying again.
  assert.equal(canPurchase(account({ entitled: true, membership: membership({ renewal: 'one_time' }) })), true);
  // A permanent legacy lifetime grant needs nothing more.
  assert.equal(canPurchase(account({ entitled: true, membership: membership({ planSlug: 'lifetime', renewal: 'one_time', expiresAt: null }) })), false);
});

test('display helpers', () => {
  assert.equal(accountLabel(user), 'a@example.com');
  assert.equal(accountLabel({ ...user, email: null, name: 'Ann' }), 'Ann');
  assert.equal(accountLabel({ ...user, email: null }), 'usr_012345…');
  assert.equal(formatDate('2027-06-15T00:00:00.000Z'), '2027-06-15');
  assert.equal(formatDate(null), null);
  assert.equal(formatDate('nope'), null);
});

test('every account command the UI invokes is registered in the Tauri handler', () => {
  const bridge = readFileSync(new URL('../src/lib/account-bridge.ts', import.meta.url), 'utf8');
  const lib = readFileSync(new URL('../src-tauri/src/lib.rs', import.meta.url), 'utf8');
  const handler = lib.slice(lib.indexOf('generate_handler!['));
  const invoked = [...bridge.matchAll(/invoke<[^>]+>\('([a-z_]+)'/g)].map((m) => m[1]);
  assert.ok(invoked.length >= 7);
  for (const name of invoked) {
    assert.match(handler, new RegExp(`\\b${name},`), name);
  }
});
