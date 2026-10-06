import { Crown, ExternalLink, Loader2, LogIn, LogOut, RefreshCw, UserRound } from 'lucide-react';
import { useState } from 'react';
import { useI18n } from '../i18n';
import { accountLabel, canPurchase, formatDate, membershipBadge, type CheckoutPlan, type Feature, type FeatureAccess } from '../lib/membership';
import { useAccountStore, useFeatureAccess, usePlanLimits } from '../store/useAccountStore';
import { useVideoStore } from '../store/useVideoStore';

function BadgePill() {
  const { t } = useI18n();
  const account = useAccountStore((state) => state.account);
  const badge = membershipBadge(account);
  const tone = account?.entitled ? 'member' : badge === 'signedOut' || badge === 'free' ? 'muted' : 'warn';
  return <span className={`account-badge account-badge-${tone}`}>{t.account.badge[badge]}</span>;
}

function PendingLogin({ compact }: { compact?: boolean }) {
  const { t } = useI18n();
  const account = useAccountStore((state) => state.account);
  const cancelLogin = useAccountStore((state) => state.cancelLogin);
  const [copied, setCopied] = useState(false);
  return (
    <div className="account-pending">
      <span className="account-row">
        <Loader2 size={13} className="spin" />
        {t.account.signingIn}
      </span>
      <div className="account-actions">
        {account?.loginUrl && !compact && (
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() =>
              void navigator.clipboard
                .writeText(account.loginUrl ?? '')
                .then(() => setCopied(true))
                .catch(() => {})
            }
          >
            {copied ? t.account.copied : t.account.openLoginAgain}
          </button>
        )}
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => void cancelLogin()}>
          {t.account.cancel}
        </button>
      </div>
    </div>
  );
}

/** Compact account status in the side rail. Details and purchase live in Settings. */
export function AccountRailCard() {
  const { t, locale } = useI18n();
  const account = useAccountStore((state) => state.account);
  const busy = useAccountStore((state) => state.busy);
  const login = useAccountStore((state) => state.login);
  const setActivePage = useVideoStore((state) => state.setActivePage);
  const pending = account?.loginStatus === 'pending';

  return (
    <div className="rail-card account-rail">
      <div className="t">
        <UserRound size={14} />
        <span className="account-name">{account?.user ? accountLabel(account.user) : t.account.badge.signedOut}</span>
      </div>
      {pending ? (
        <PendingLogin compact />
      ) : account?.user ? (
        <div className="account-row account-rail-foot">
          <BadgePill />
          {canPurchase(account) && (
            <button type="button" className="btn btn-soft btn-sm" onClick={() => setActivePage('settings')}>
              <Crown size={13} />
              {t.account.upgrade}
            </button>
          )}
        </div>
      ) : (
        <button type="button" className="btn btn-primary btn-sm btn-block" disabled={busy} onClick={() => void login(locale)}>
          <LogIn size={13} />
          {t.account.signIn}
        </button>
      )}
    </div>
  );
}

/** Settings → Account & membership: status, purchase entry, refresh, sign-out. */
export function AccountSection() {
  const { t, locale } = useI18n();
  const account = useAccountStore((state) => state.account);
  const busy = useAccountStore((state) => state.busy);
  const error = useAccountStore((state) => state.error);
  const watching = useAccountStore((state) => state.purchaseWatchUntil > 0);
  const { login, logout, refresh, checkout, openStoreAccount } = useAccountStore.getState();
  const user = account?.user ?? null;
  const membership = account?.membership ?? null;
  const pending = account?.loginStatus === 'pending';
  const phaseNote = account && account.phase in t.account.phaseNote ? t.account.phaseNote[account.phase as keyof typeof t.account.phaseNote] : null;
  const checkedAt = account?.membershipCheckedAt ? new Date(account.membershipCheckedAt * 1000).toLocaleString(locale) : null;
  const expires = account?.entitled ? (formatDate(membership?.expiresAt) ?? t.account.lifetimeValid) : null;

  return (
    <div className="card settings-card account-section">
      <div className="account-head">
        <span className="field-label">
          <Crown size={14} />
          {t.account.title}
        </span>
        {user && <BadgePill />}
      </div>
      <p className="account-desc">{t.account.desc}</p>

      {pending ? (
        <PendingLogin />
      ) : user ? (
        <div className="account-user">
          <div className="account-row">
            <UserRound size={15} />
            <strong className="account-name">{accountLabel(user)}</strong>
          </div>
          <dl className="account-facts">
            {expires && (
              <>
                <dt>{t.account.expiresAt}</dt>
                <dd>{expires}</dd>
              </>
            )}
            {checkedAt && (
              <>
                <dt>{t.account.checkedAt}</dt>
                <dd>{checkedAt}</dd>
              </>
            )}
          </dl>
          {account?.entitled && membership?.renewal === 'cancelled' && <p className="account-note">{t.account.cancelledNote}</p>}
        </div>
      ) : (
        <div className="account-row account-signin">
          <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void login(locale)}>
            <LogIn size={15} />
            {t.account.signIn}
          </button>
          <span className="account-desc">{t.account.signInHint}</span>
        </div>
      )}

      <PlanLimitsTable />

      {user && phaseNote && <p className="account-note">{phaseNote}</p>}
      {account?.loginError && <p className="account-error">{account.loginError}</p>}
      {account?.lastError && account.phase !== 'unconfigured' && <p className="account-error">{account.lastError}</p>}
      {error && <p className="account-error">{error}</p>}

      {user && canPurchase(account) && (
        <div className="account-plans">
          {(account?.plans ?? []).map((plan: CheckoutPlan) => (
            <button type="button" key={plan} className="account-plan" disabled={busy} onClick={() => void checkout(plan)}>
              <strong>{t.account.plans[plan]}</strong>
              <span>{t.account.planDesc[plan]}</span>
              <ExternalLink size={13} />
            </button>
          ))}
          <p className="account-desc">{t.account.priceNote}</p>
        </div>
      )}
      {watching && !account?.entitled && <p className="account-note">{t.account.awaitingPurchase}</p>}

      {user && (
        <div className="account-actions">
          <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void refresh(true)}>
            <RefreshCw size={13} />
            {t.account.refresh}
          </button>
          <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void openStoreAccount()}>
            <ExternalLink size={13} />
            {t.account.manageOrders}
          </button>
          <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void logout()}>
            <LogOut size={13} />
            {t.account.signOut}
          </button>
        </div>
      )}
    </div>
  );
}

/** What the current plan includes. Mirrors the limits the commands actually enforce. */
function PlanLimitsTable() {
  const { t } = useI18n();
  const limits = usePlanLimits();
  const l = t.account.limits;
  const height = limits.maxExportHeight >= 2160 ? '4K' : `${limits.maxExportHeight}p`;
  return (
    <div className="account-limits">
      <span className="field-label">{l.title}</span>
      <dl className="account-facts">
        <dt>{l.export}</dt>
        <dd>{height}</dd>
        <dt>{l.watermark}</dt>
        <dd>{limits.watermark ? l.watermarkOn : l.watermarkOff}</dd>
        <dt>{l.aiDirector}</dt>
        <dd>{l.ownCost}</dd>
        <dt>{l.aiCutCleanup}</dt>
        <dd>{l.local}</dd>
        <dt>{l.commercialUse}</dt>
        <dd>{limits.commercialUse ? l.commercialYes : l.commercialNo}</dd>
      </dl>
    </div>
  );
}

/** Inline notice for a gated feature. Renders nothing while the feature is allowed. */
export function FeatureGateNotice({ access, message }: { access: FeatureAccess; message?: string }) {
  const { t, locale } = useI18n();
  const login = useAccountStore((state) => state.login);
  const setActivePage = useVideoStore((state) => state.setActivePage);
  if (access === 'allowed') return null;
  return (
    <div className="feature-gate">
      <Crown size={14} />
      <span>{message ?? t.account.gate[access]}</span>
      {access === 'signIn' ? (
        <button type="button" className="btn btn-soft btn-sm" onClick={() => void login(locale)}>
          {t.account.gate.signInAction}
        </button>
      ) : (
        <button type="button" className="btn btn-soft btn-sm" onClick={() => setActivePage('settings')}>
          {t.account.gate.upgradeAction}
        </button>
      )}
    </div>
  );
}

export function useGate(feature: Feature) {
  const access = useFeatureAccess(feature);
  return { access, allowed: access === 'allowed' };
}
