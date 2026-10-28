import { Headset, Loader2 } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { useI18n } from '../i18n';
import { requestSupportTicket } from '../lib/support-bridge';
import { createSupportRuntime, probeSupport, type SupportLang, type SupportRuntime } from '../lib/support';
import { useAccountStore } from '../store/useAccountStore';
import { useSupportStore } from '../store/useSupportStore';

const SUPPORT_ORIGIN = import.meta.env.DEV ? (import.meta.env.VITE_SUPPORT_ORIGIN as string | undefined) : undefined;

/**
 * Mounts the shared support widget while a user is signed in and Auth can issue them a ticket.
 * Renders nothing itself. Account switch / sign-out resets the thread; theme changes re-skin it.
 */
export function SupportHost() {
  const { locale, t } = useI18n();
  const userId = useAccountStore((state) => state.account?.user?.authUserId ?? null);
  const runtime = useRef<SupportRuntime | null>(null);
  const lang = useRef<SupportLang>(locale);
  const translations = useRef(t);
  lang.current = locale;
  translations.current = t;

  useEffect(() => {
    const { setAvailability, setUnread, setOpener } = useSupportStore.getState();
    setUnread(0);
    if (!userId) {
      setAvailability('login_required');
      setOpener(() => {});
      return undefined;
    }
    let disposed = false;
    setAvailability('checking');
    void probeSupport(requestSupportTicket).then((availability) => {
      if (disposed) return;
      setAvailability(availability);
      if (availability !== 'ready') return;
      const created = createSupportRuntime({
        requestTicket: requestSupportTicket,
        document,
        lang: lang.current,
        translate: (key) => key === 'humanWaitHint' ? translations.current.support.humanWaitHint : undefined,
        origin: SUPPORT_ORIGIN,
        onUnreadChange: setUnread,
      });
      runtime.current = created;
      setOpener(() => created.open());
    });
    const observer = new MutationObserver(() => runtime.current?.syncTheme());
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['style', 'data-theme'] });
    return () => {
      disposed = true;
      observer.disconnect();
      runtime.current?.destroy();
      runtime.current = null;
      setOpener(() => {});
      setUnread(0);
    };
  }, [userId]);

  useEffect(() => {
    runtime.current?.setLang(locale);
  }, [locale]);

  return null;
}

/** Settings entry: tells the user why support is or is not available and opens the widget. */
export function SupportSection() {
  const { t } = useI18n();
  const availability = useSupportStore((state) => state.availability);
  const unread = useSupportStore((state) => state.unread);
  const open = useSupportStore((state) => state.open);
  const login = useAccountStore((state) => state.login);
  const { locale } = useI18n();
  const note = t.support.state[availability];

  return (
    <div className="card settings-card support-section">
      <div className="account-head">
        <span className="field-label">
          <Headset size={14} />
          {t.support.title}
        </span>
        {unread > 0 && <span className="account-badge account-badge-warn">{t.support.unread(unread)}</span>}
      </div>
      <p className="account-desc">{t.support.desc}</p>
      <div className="account-actions">
        {availability === 'ready' && (
          <button type="button" className="btn btn-primary btn-sm" onClick={open}>
            {t.support.open}
          </button>
        )}
        {(availability === 'login_required' || availability === 'reauth_required') && (
          <button type="button" className="btn btn-primary btn-sm" onClick={() => void login(locale)}>
            {t.support.signIn}
          </button>
        )}
        {availability === 'checking' && <Loader2 size={14} className="spin" />}
      </div>
      <p className="account-desc" role="status">{note}</p>
    </div>
  );
}
