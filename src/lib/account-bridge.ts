import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { AccountView, CheckoutPlan } from './membership';

export function getAccount() {
  return invoke<AccountView>('account_get');
}

export function startLogin(lang: string) {
  return invoke<AccountView>('account_start_login', { lang });
}

export function cancelLogin() {
  return invoke<AccountView>('account_cancel_login');
}

export function logout() {
  return invoke<AccountView>('account_logout');
}

/** `force` skips the 60 s throttle (manual refresh, after checkout). */
export function refreshAccount(force: boolean) {
  return invoke<AccountView>('account_refresh', { force });
}

/** Opens webclaw-store's checkout in the system browser; payment never happens in the app. */
export function openCheckout(plan: CheckoutPlan) {
  return invoke<void>('account_open_checkout', { plan });
}

export function openStoreAccount() {
  return invoke<void>('account_open_store_account');
}

export function onAccountChanged(callback: (account: AccountView) => void) {
  return listen<AccountView>('account_changed', (event) => callback(event.payload));
}
