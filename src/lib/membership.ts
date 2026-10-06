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

/**
 * What this install may do right now, computed by the Rust side from the store's benefits
 * (account_commands.rs `limits_for`) and enforced there and in the Node sidecars / MCP tools.
 * The UI only mirrors it. Same shape as scripts/lib/plan.mjs.
 */
export interface PlanLimits {
  /** Short side of the exported frame in pixels: 720 (free) … 2160 (4K). */
  maxExportHeight: number;
  watermark: boolean;
  aiDirector: boolean;
  aiCutCleanup: boolean;
  /** Licensing only; nothing technical depends on it. */
  commercialUse: boolean;
}

export const FREE_LIMITS: Readonly<PlanLimits> = Object.freeze({
  maxExportHeight: 720,
  watermark: true,
  aiDirector: false,
  aiCutCleanup: false,
  commercialUse: false,
});

export interface AccountView {
  loginStatus: 'idle' | 'pending' | 'error';
  loginError: string | null;
  loginUrl: string | null;
  user: AccountUser | null;
  membership: Membership | null;
  membershipCheckedAt: number | null;
  phase: MembershipPhase;
  entitled: boolean;
  limits: PlanLimits;
  serviceConfigured: boolean;
  lastError: string | null;
  productSlug: string;
  plans: CheckoutPlan[];
}

/** The account's limits, validated field by field; no account / anything odd → free. */
export function planLimits(account: AccountView | null | undefined): PlanLimits {
  const raw = account?.limits;
  if (!raw || typeof raw !== 'object') return FREE_LIMITS;
  const height = raw.maxExportHeight;
  return {
    maxExportHeight: Number.isInteger(height) ? Math.min(2160, Math.max(720, height)) : 720,
    watermark: raw.watermark !== false,
    aiDirector: raw.aiDirector === true,
    aiCutCleanup: raw.aiCutCleanup === true,
    commercialUse: raw.commercialUse === true,
  };
}

/** Pro-only capabilities. Free keeps manual editing, preview and 720p watermarked export. */
export const PAID_FEATURES = ['agent.director', 'cutter.aiCleanup', 'export.1080p', 'export.4k', 'export.noWatermark'] as const;
export type PaidFeature = (typeof PAID_FEATURES)[number];

export interface MembershipPolicy {
  enforce: boolean;
  paidFeatures: ReadonlySet<PaidFeature>;
}

export const MEMBERSHIP_POLICY: MembershipPolicy = {
  enforce: true,
  paidFeatures: new Set<PaidFeature>(PAID_FEATURES),
};

/** Which plan limit each feature needs. */
const FEATURE_ALLOWED: Record<PaidFeature, (limits: PlanLimits) => boolean> = {
  'agent.director': (l) => l.aiDirector,
  'cutter.aiCleanup': (l) => l.aiCutCleanup,
  'export.1080p': (l) => l.maxExportHeight >= 1080,
  'export.4k': (l) => l.maxExportHeight >= 2160,
  'export.noWatermark': (l) => !l.watermark,
};

/** Render presets and the short side they need. */
export const RESOLUTION_HEIGHT = { '720p': 720, '1080p': 1080, '4K': 2160 } as const;

export function allowsResolution(limits: PlanLimits, resolution: keyof typeof RESOLUTION_HEIGHT): boolean {
  return RESOLUTION_HEIGHT[resolution] <= limits.maxExportHeight;
}

/** allowed | signIn: needs an account | upgrade: needs membership | unavailable: can't tell right now. */
export type FeatureAccess = 'allowed' | 'signIn' | 'upgrade' | 'unavailable';

export function featureAccess(feature: PaidFeature, account: AccountView | null, policy: MembershipPolicy = MEMBERSHIP_POLICY): FeatureAccess {
  if (!policy.enforce || !policy.paidFeatures.has(feature)) return 'allowed';
  if (FEATURE_ALLOWED[feature](planLimits(account))) return 'allowed';
  if (!account) return 'unavailable';
  if (!account.user || account.phase === 'sessionExpired') return 'signIn';
  // Entitled but the benefit is missing, or a definitive "no" from the service: upgrade.
  if (account.entitled || account.phase === 'fresh' || (account.phase === 'cached' && account.membership?.member === false)) return 'upgrade';
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
