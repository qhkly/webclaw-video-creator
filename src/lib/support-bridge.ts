import { invoke } from '@tauri-apps/api/core';
import type { SupportTicket } from './support';

/**
 * Short-lived support ticket minted by auth.qhkly.com for the signed-in user. The Rust side owns the
 * rotating grant; rejections are `{ code, message, retryAfter }` (see `ticketErrorCode`).
 */
export function requestSupportTicket() {
  return invoke<SupportTicket>('support_ticket');
}
