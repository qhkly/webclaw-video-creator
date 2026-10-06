// Account & membership model shared by the UI. Pure (no Tauri imports) so node tests can load it.
//
// The Rust side (src-tauri/src/commands/account_commands.rs) owns login, storage and the
// offline grace window, and hands the UI one `entitled` answer. This file only decides what
// the UI does with it. Contract and open product decisions: docs/account-membership.md.

export type MembershipPhase = 'signedOut' | 'unconfigured' | 'sessionExpired' | 'cached' | 'fresh' | 'offline' | 'error';

export interface AccountUser {
  authUserId: string;
  email: string | null;
  name: string | null;
  image: string | null;
}

/**
 * Machine-readable member benefits (webclaw-store VIDEO_CREATOR_BENEFITS). Fields may be added
 * later; a field the app cannot read counts as "not granted".
 */
export interface VideoCreatorBenefits {
  watermarkFree?: boolean;
  /** Export height limit in pixels; 2160 = 4K. */
  maxExportHeight?: number;
  aiDirector?: boolean;
  aiCutCleanup?: boolean;
  commercialUse?: boolean;
}

/** The store's /api/v1/membership answer for webclaw-video-creator. Only `member` decides access. */
export interface Membership {
  member: boolean;
  known: boolean;
  planSlug: string | null;
  status: string | null;
  renewal: 'auto' | 'cancelled' | 'one_time' | null;
  expiresAt: string | null;
  currentPeriodEnd: string | null;
  benefits: VideoCreatorBenefits | null;
}

/** Plans the store sells. Retired placeholders (trial / yearly / lifetime) still count when already owned. */
export type CheckoutPlan = 'pro-monthly' | 'pro-yearly';

export interface AccountView {
  loginStatus: 'idle' | 'pending' | 'error';
  loginError: string | null;
  loginUrl: string | null;
  user: AccountUser | null;
  membership: Membership | null;
  membershipCheckedAt: number | null;
  phase: MembershipPhase;
  entitled: boolean;
  serviceConfigured: boolean;
  lastError: string | null;
  productSlug: string;
  plans: CheckoutPlan[];
}

/**
 * Features that may be reserved for members. Which ones are paid is a product decision,
 * so enforcement ships OFF: with `enforce: false` every feature stays available and the
 * UI only shows the account / upgrade entry points. Flip `enforce` (and trim the list)
 * once pricing is decided; the gates are already wired at these call sites.
 */
export const PAID_FEATURES = ['export.4k', 'agent.director'] as const;
export type PaidFeature = (typeof PAID_FEATURES)[number];

export interface MembershipPolicy {
  enforce: boolean;
  paidFeatures: ReadonlySet<PaidFeature>;
}

export const MEMBERSHIP_POLICY: MembershipPolicy = {
  enforce: false,
  paidFeatures: new Set<PaidFeature>(PAID_FEATURES),
};

/** Which benefit each gated feature needs. Membership alone is not enough. */
const FEATURE_BENEFIT: Record<PaidFeature, (benefits: VideoCreatorBenefits | null | undefined) => boolean> = {
  'export.4k': (b) => typeof b?.maxExportHeight === 'number' && b.maxExportHeight >= 2160,
  'agent.director': (b) => b?.aiDirector === true,
};

/** allowed | signIn: needs an account | upgrade: needs membership | unavailable: can't tell right now. */
export type FeatureAccess = 'allowed' | 'signIn' | 'upgrade' | 'unavailable';

export function featureAccess(feature: PaidFeature, account: AccountView | null, policy: MembershipPolicy = MEMBERSHIP_POLICY): FeatureAccess {
  if (!policy.enforce || !policy.paidFeatures.has(feature)) return 'allowed';
  if (!account) return 'unavailable';
  if (!account.user || account.phase === 'sessionExpired') return 'signIn';
  if (account.entitled) return FEATURE_BENEFIT[feature](account.membership?.benefits) ? 'allowed' : 'upgrade';
  // A definitive "no" from the service means upgrade; anything else means we could not check.
  if (account.phase === 'fresh' || (account.phase === 'cached' && account.membership?.member === false)) return 'upgrade';
  return 'unavailable';
}

export type MembershipBadge = 'signedOut' | 'member' | 'lifetime' | 'trial' | 'free' | 'sessionExpired' | 'unavailable' | 'checking';

export function membershipBadge(account: AccountView | null): MembershipBadge {
  if (!account) return 'checking';
  if (!account.user) return 'signedOut';
  if (account.entitled) {
    const plan = account.membership?.planSlug;
    return plan === 'lifetime' ? 'lifetime' : plan === 'trial' ? 'trial' : 'member';
  }
  switch (account.phase) {
    case 'sessionExpired':
      return 'sessionExpired';
    case 'fresh':
      return 'free';
    case 'cached':
      return account.membership ? 'free' : 'checking';
    default:
      return 'unavailable';
  }
}

export function accountLabel(user: AccountUser | null): string {
  if (!user) return '';
  return user.email || user.name || `${user.authUserId.slice(0, 10)}…`;
}

/**
 * Show the purchase entry? Always for non-members. Members too when buying again makes sense:
 * a trial, a cancelled subscription (access runs until period end), or a one-time payment that
 * expires (WeChat Pay extends by paying again; it never auto-renews).
 */
export function canPurchase(account: AccountView | null): boolean {
  if (!account?.user) return false;
  if (!account.entitled) return true;
  const m = account.membership;
  return m?.planSlug === 'trial' || m?.renewal === 'cancelled' || (m?.renewal === 'one_time' && Boolean(m.expiresAt));
}

/** ISO date → yyyy-mm-dd for display; null for permanent / unknown. */
export function formatDate(value: string | null | undefined): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
}

/** After opening checkout, poll for the new membership this long. */
export const PURCHASE_WATCH_MS = 15 * 60 * 1000;
export const PURCHASE_POLL_MS = 15 * 1000;
