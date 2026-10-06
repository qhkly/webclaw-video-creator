import { create } from 'zustand';
import * as bridge from '../lib/account-bridge';
import { PURCHASE_POLL_MS, PURCHASE_WATCH_MS, featureAccess, type AccountView, type CheckoutPlan, type FeatureAccess, type PaidFeature } from '../lib/membership';

interface AccountStore {
  account: AccountView | null;
  busy: boolean;
  error: string;
  /** Epoch ms until which we poll for a just-bought membership (0 = not watching). */
  purchaseWatchUntil: number;
  setAccount: (account: AccountView) => void;
  login: (lang: string) => Promise<void>;
  cancelLogin: () => Promise<void>;
  logout: () => Promise<void>;
  refresh: (force: boolean) => Promise<void>;
  checkout: (plan: CheckoutPlan) => Promise<void>;
  openStoreAccount: () => Promise<void>;
}

export const useAccountStore = create<AccountStore>((set, get) => {
  // Every action reports through `error` instead of throwing, so a missing backend
  // (plain `npm run dev` in a browser) degrades to a visible message.
  const run = async (action: () => Promise<AccountView | void>) => {
    set({ busy: true, error: '' });
    try {
      const account = await action();
      if (account) set({ account });
    } catch (error) {
      set({ error: String(error) });
    } finally {
      set({ busy: false });
    }
  };

  return {
    account: null,
    busy: false,
    error: '',
    purchaseWatchUntil: 0,
    setAccount: (account) => {
      // Membership arrived: stop the post-checkout watch.
      set(account.entitled ? { account, purchaseWatchUntil: 0 } : { account });
    },
    login: (lang) => run(() => bridge.startLogin(lang)),
    cancelLogin: () => run(() => bridge.cancelLogin()),
    logout: () =>
      run(async () => {
        set({ purchaseWatchUntil: 0 });
        return bridge.logout();
      }),
    refresh: async (force) => {
      try {
        get().setAccount(await bridge.refreshAccount(force));
      } catch (error) {
        set({ error: String(error) });
      }
    },
    checkout: (plan) =>
      run(async () => {
        await bridge.openCheckout(plan);
        set({ purchaseWatchUntil: Date.now() + PURCHASE_WATCH_MS });
      }),
    openStoreAccount: () => run(() => bridge.openStoreAccount()),
  };
});

/**
 * Wire the account to the app lifetime: initial load + membership check, backend
 * events, a re-check whenever the window regains focus (the user is back from the
 * browser after login or payment), and polling while a checkout is in flight.
 */
export function startAccountSync(): () => void {
  const store = useAccountStore;
  let disposed = false;
  let unlisten: (() => void) | undefined;

  void bridge
    .getAccount()
    .then((account) => {
      if (disposed) return;
      store.getState().setAccount(account);
      if (account.user) void store.getState().refresh(false);
    })
    .catch((error) => store.setState({ error: String(error) }));
  void bridge
    .onAccountChanged((account) => store.getState().setAccount(account))
    .then((stop) => {
      if (disposed) stop();
      else unlisten = stop;
    })
    .catch(() => {});

  const onFocus = () => {
    const { account, purchaseWatchUntil } = store.getState();
    if (account?.user) void store.getState().refresh(purchaseWatchUntil > Date.now());
  };
  const onVisibility = () => {
    if (document.visibilityState === 'visible') onFocus();
  };
  window.addEventListener('focus', onFocus);
  document.addEventListener('visibilitychange', onVisibility);

  const poll = window.setInterval(() => {
    const { account, purchaseWatchUntil } = store.getState();
    if (!purchaseWatchUntil) return;
    if (purchaseWatchUntil < Date.now() || !account?.user) {
      store.setState({ purchaseWatchUntil: 0 });
      return;
    }
    void store.getState().refresh(true);
  }, PURCHASE_POLL_MS);

  return () => {
    disposed = true;
    unlisten?.();
    window.removeEventListener('focus', onFocus);
    document.removeEventListener('visibilitychange', onVisibility);
    window.clearInterval(poll);
  };
}

export function useFeatureAccess(feature: PaidFeature): FeatureAccess {
  return useAccountStore((state) => featureAccess(feature, state.account));
}
