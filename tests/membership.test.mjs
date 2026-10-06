import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  MEMBERSHIP_POLICY,
  PAID_FEATURES,
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

const enforced = { enforce: true, paidFeatures: new Set(PAID_FEATURES) };

test('shipped policy does not gate anything (paid features are a pending product decision)', () => {
  assert.equal(MEMBERSHIP_POLICY.enforce, false);
  for (const feature of PAID_FEATURES) {
    for (const value of [null, account({ user: null, phase: 'signedOut' }), account()]) {
      assert.equal(featureAccess(feature, value), 'allowed');
    }
  }
});

test('enforced policy: sign in, upgrade, or unavailable — never a silent allow', () => {
  const f = 'export.4k';
  assert.equal(featureAccess(f, null, enforced), 'unavailable');
  assert.equal(featureAccess(f, account({ user: null, phase: 'signedOut' }), enforced), 'signIn');
  assert.equal(featureAccess(f, account({ phase: 'sessionExpired' }), enforced), 'signIn');
  assert.equal(featureAccess(f, account({ entitled: true, membership: membership() }), enforced), 'allowed');
  assert.equal(featureAccess(f, account({ membership: membership({ member: false }) }), enforced), 'upgrade');
  assert.equal(featureAccess(f, account({ phase: 'cached', membership: membership({ member: false }) }), enforced), 'upgrade');
  for (const phase of ['unconfigured', 'offline', 'error']) {
    assert.equal(featureAccess(f, account({ phase }), enforced), 'unavailable', phase);
  }
  // Features outside the paid list stay open even when enforcing.
  assert.equal(featureAccess(f, account({ user: null }), { enforce: true, paidFeatures: new Set() }), 'allowed');
});

test('enforced policy: gates read the store benefits, not just membership', () => {
  const member = (benefits) => account({ entitled: true, membership: membership({ benefits }) });
  assert.equal(featureAccess('export.4k', member({ maxExportHeight: 2160 }), enforced), 'allowed');
  assert.equal(featureAccess('export.4k', member({ maxExportHeight: 1080 }), enforced), 'upgrade');
  assert.equal(featureAccess('export.4k', member({ maxExportHeight: '2160' }), enforced), 'upgrade');
  assert.equal(featureAccess('agent.director', member({ aiDirector: true }), enforced), 'allowed');
  // Missing field or missing benefits = not granted.
  assert.equal(featureAccess('agent.director', member({}), enforced), 'upgrade');
  assert.equal(featureAccess('agent.director', member(null), enforced), 'upgrade');
  assert.equal(featureAccess('agent.director', member({ aiDirector: 'yes' }), enforced), 'upgrade');
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
