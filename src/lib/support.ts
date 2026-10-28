// Shared customer-support widget (support.qhkly.com) glue. Pure (no Tauri imports) so node tests can load it.
//
// The widget itself is @webcode/support-ui (vendored tarball, not copied). This file only decides
// credentials, theme, language and lifecycle. Credentials come from the Rust side (`support_ticket`),
// which trades Auth's rotating support grant for a short ES256 ticket; nothing here signs or holds a
// secret. Cross-repo setup and open blockers: docs/support-widget.md.
import { createSupportClient, createSupportSession, hostCredentials } from '@webcode/support-ui';
import { createSupportWidget } from '@webcode/support-ui/widget';

/** Tenant name; must match Auth `SUPPORT_APPS` and the Worker's `products.js`. */
export const SUPPORT_APP = 'video-creator';

export type SupportAvailability = 'checking' | 'ready' | 'login_required' | 'reauth_required' | 'not_enabled' | 'unavailable';

export interface SupportTicket {
  ticket: string;
  uid: string;
  /** Unix seconds. */
  expiresAt: number;
}

export type RequestTicket = () => Promise<SupportTicket>;

/** Error code from the Rust `SupportError` (a thrown invoke rejection is the serialized object). */
export function ticketErrorCode(error: unknown): string {
  if (error && typeof error === 'object' && typeof (error as { code?: unknown }).code === 'string') {
    return (error as { code: string }).code;
  }
  return 'unavailable';
}

export function availabilityFromError(error: unknown): SupportAvailability {
  switch (ticketErrorCode(error)) {
    case 'login_required':
      return 'login_required';
    case 'reauth_required':
      return 'reauth_required';
    case 'not_enabled':
      return 'not_enabled';
    default:
      return 'unavailable';
  }
}

/** Ask once whether a ticket can be had. The Rust side caches it, so the widget's first call is free. */
export async function probeSupport(request: RequestTicket): Promise<SupportAvailability> {
  try {
    await request();
    return 'ready';
  } catch (error) {
    return availabilityFromError(error);
  }
}

export type SupportLang = 'zh-CN' | 'en-US';

export const SUPPORT_SUBTITLE = 'WebClaw Video Creator';

const HEX = /^#[0-9a-f]{3}([0-9a-f]{3})?$/i;

/** Accent from the app theme (ThemePanel writes --accent on <html>); falls back to the widget default. */
export function supportThemeFromHost(doc: Document): { primary?: string; colorScheme: 'document'; radius: number } {
  const win = doc.defaultView;
  const accent = win ? win.getComputedStyle(doc.documentElement).getPropertyValue('--accent').trim() : '';
  const radiusRaw = win ? win.getComputedStyle(doc.documentElement).getPropertyValue('--r-md').trim() : '';
  const radius = Number.parseInt(radiusRaw, 10);
  return {
    ...(HEX.test(accent) ? { primary: accent } : {}),
    // 'document' follows <html data-theme="light|dark">, which ThemePanel owns.
    colorScheme: 'document',
    radius: Number.isFinite(radius) ? Math.min(28, Math.max(0, radius)) : 10,
  };
}

export interface SupportRuntimeOptions {
  requestTicket: RequestTicket;
  document: Document;
  lang: SupportLang;
  /** Host translation lookup for keys such as the shared widget's humanWaitHint. */
  translate?: (key: string) => string | undefined;
  /** Defaults to https://support.qhkly.com; tests and debug builds point at a local Worker. */
  origin?: string;
  fetch?: typeof fetch;
  WebSocket?: unknown;
  push?: 'websocket' | 'none';
  onUnreadChange?: (count: number) => void;
  onOpenChange?: (open: boolean) => void;
  appVersion?: string;
}

export interface SupportRuntime {
  widget: SupportWidgetHandle;
  session: { resetIdentity: () => unknown; stop: () => void };
  open: () => void;
  close: () => void;
  isOpen: () => boolean;
  /** Re-read the host theme (accent, radius) after the user changed it. */
  syncTheme: () => void;
  setLang: (lang: SupportLang) => void;
  /** Sign-in / sign-out / account switch: drop the old account's thread and draft. */
  resetIdentity: () => void;
  destroy: () => void;
}

// The package ships plain JS; only the surface used here is typed.
export interface SupportWidgetHandle {
  open: () => void;
  close: () => void;
  isOpen?: () => boolean;
  setTheme: (theme: Record<string, unknown>) => void;
  setColorScheme: (scheme: string) => void;
  setSubtitle?: (text: string) => void;
  setLang?: (lang: string) => void;
  resetIdentity: () => unknown;
  destroy: () => void;
  [key: string]: unknown;
}

export function createSupportRuntime(options: SupportRuntimeOptions): SupportRuntime {
  const { document: doc, requestTicket } = options;
  const credentials = hostCredentials({ app: SUPPORT_APP, request: requestTicket });
  const client = createSupportClient({
    credentials,
    ...(options.origin ? { origin: options.origin } : {}),
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
  const session = createSupportSession({
    client,
    push: options.push ?? 'websocket',
    ...(options.WebSocket ? { WebSocket: options.WebSocket } : {}),
  });
  const lang = options.lang;
  let open = false;
  const widget = createSupportWidget({
    session,
    document: doc,
    mode: 'floating',
    lang,
    t: options.translate,
    subtitle: SUPPORT_SUBTITLE,
    theme: supportThemeFromHost(doc),
    attachments: { accept: 'image/png,image/jpeg,image/gif,image/webp,video/webm', maxFiles: 4 },
    meta: () => ({ app_version: options.appVersion ?? '' }),
    onUnreadChange: (count: number) => options.onUnreadChange?.(count),
    onOpenChange: (value: boolean) => {
      open = value;
      options.onOpenChange?.(value);
    },
  }) as SupportWidgetHandle;

  return {
    widget,
    session: session as unknown as SupportRuntime['session'],
    open: () => widget.open(),
    close: () => widget.close(),
    isOpen: () => open,
    syncTheme: () => widget.setTheme(supportThemeFromHost(doc)),
    setLang: (next) => {
      widget.setLang?.(next);
    },
    resetIdentity: () => void widget.resetIdentity(),
    destroy: () => widget.destroy(),
  };
}
