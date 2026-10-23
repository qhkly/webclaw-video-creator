// Support widget integration: the app's runtime (src/lib/support.ts) + the vendored @webcode/support-ui
// against the REAL support Worker (see tests/support-harness.mjs). Covers message / attachment / human
// handoff / unread / account change / theme, plus the "no secrets" invariants.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import {
  APP, PNG_1X1, authSimulator, makeEnv, putAdminReply, skipReason, workerPatchedProducts,
} from './support-harness.mjs';
import {
  availabilityFromError, createSupportRuntime, probeSupport, supportThemeFromHost, ticketErrorCode,
} from '../src/lib/support.ts';

const require = createRequire(import.meta.url);
const { JSDOM } = require('jsdom');
const flush = async (n = 30) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };

if (workerPatchedProducts) {
  console.warn('# NOTE: the Worker in use does not list tenant "video-creator" yet; the harness registered it (cross-repo blocker 1 in docs/support-widget.md).');
}

// ---- Pure pieces: always run, no Worker needed ----

test('ticket error mapping drives the availability states', () => {
  assert.equal(ticketErrorCode({ code: 'reauth_required', message: 'x' }), 'reauth_required');
  assert.equal(ticketErrorCode('boom'), 'unavailable');
  assert.equal(availabilityFromError({ code: 'login_required' }), 'login_required');
  assert.equal(availabilityFromError({ code: 'reauth_required' }), 'reauth_required');
  assert.equal(availabilityFromError({ code: 'not_enabled' }), 'not_enabled');
  for (const code of ['rate_limited', 'unavailable', 'rejected', 'storage_failed']) assert.equal(availabilityFromError({ code }), 'unavailable');
});

test('probeSupport: ready only when a ticket can be had; failures never throw', async () => {
  assert.equal(await probeSupport(async () => ({ ticket: 'a.b.c', uid: 'u_x', expiresAt: 1 })), 'ready');
  assert.equal(await probeSupport(async () => { throw { code: 'not_enabled' }; }), 'not_enabled');
  assert.equal(await probeSupport(async () => { throw new Error('network'); }), 'unavailable');
});

test('theme follows the app: accent hex only, radius clamped, colour scheme from <html data-theme>', () => {
  const dom = new JSDOM('<!doctype html><html></html>');
  const root = dom.window.document.documentElement;
  root.style.setProperty('--accent', '#6366f1');
  root.style.setProperty('--r-md', '10px');
  assert.deepEqual(supportThemeFromHost(dom.window.document), { primary: '#6366f1', colorScheme: 'document', radius: 10 });
  root.style.setProperty('--accent', 'red; } body { display:none');
  root.style.setProperty('--r-md', '99px');
  const hostile = supportThemeFromHost(dom.window.document);
  assert.equal(hostile.primary, undefined, 'a non-hex accent is never forwarded');
  assert.equal(hostile.radius, 28);
});

// ---- Real Worker ----

function setup({ mode = 'ticket_only' } = {}) {
  const auth = authSimulator();
  const h = makeEnv({ SUPPORT_TICKET_TENANTS: auth.tenants(mode) });
  const dom = new JSDOM('<!doctype html><html data-theme="light"><head><title>Video Creator</title></head><body></body></html>', { pretendToBeVisual: true });
  const state = { user: auth.uidOf(1), requests: 0, fail: null };
  const requestTicket = async () => {
    state.requests++;
    if (state.fail) throw state.fail;
    return auth.mint(state.user);
  };
  const unread = [];
  const rt = createSupportRuntime({
    requestTicket, document: dom.window.document, lang: 'zh-CN', origin: 'https://support.test',
    fetch: h.fetch, push: 'none', onUnreadChange: (n) => unread.push(n),
  });
  const session = rt.session;
  const shadow = () => rt.widget.shadowRoot;
  return { auth, h, dom, state, rt, session, unread, shadow };
}
// The widget does this when it opens; tests that talk to the session directly start it first.
async function begin(t) {
  t.session.start();
  await flush(60);
}
const threadCount = (h, uid) => h.db.prepare('SELECT COUNT(*) AS n FROM messages WHERE app = ? AND uid = ?').get(APP, uid).n;

test('message: type in the widget, send, AI/Worker stores it under the ticket uid only', { skip: skipReason }, async () => {
  const t = setup();
  t.rt.open();
  await flush();
  const box = t.shadow().querySelector('textarea');
  box.value = '导出 4K 时卡住了';
  box.dispatchEvent(new t.dom.window.Event('input', { bubbles: true }));
  await flush();
  t.shadow().querySelector('.send, [data-action="send"], button[type="submit"]')?.click();
  await flush(60);
  const row = t.h.db.prepare('SELECT uid, role, text_src FROM messages WHERE app = ?').get(APP);
  assert.equal(row.uid, t.auth.uidOf(1));
  assert.equal(row.role, 'user');
  assert.equal(row.text_src, '导出 4K 时卡住了');
  // The request carried a Bearer ticket, and no uid/sig/ticket in the URL or body.
  for (const r of t.h.seen) {
    assert.match(r.headers.authorization ?? '', /^Bearer [\w-]+\.[\w-]+\.[\w-]+$/, r.url);
    assert.ok(!/[?&](uid|sig|ts|token|ticket)=/.test(r.url), r.url);
    if (r.body) assert.ok(!/"(uid|sig|secret)"/.test(r.body), 'body has no identity or secret fields');
  }
  t.rt.destroy();
});

test('attachment: png goes up, is stored under this user only, and a forged key is refused', { skip: skipReason }, async () => {
  const t = setup();
  await begin(t);
  const blob = new Blob([PNG_1X1], { type: 'image/png' });
  const up = await t.session.upload(blob);
  assert.ok(up.key.includes(t.auth.uidOf(1)), 'key is namespaced by uid');
  await t.session.send({ text: '截图', files: [up.key], lang: 'zh-CN' });
  assert.equal(t.h.FILES.objs.size, 1);
  const forged = `${APP}/${t.auth.uidOf(2)}/forged.png`;
  await t.session.send({ text: 'x', files: [forged], lang: 'zh-CN' });
  const stored = t.h.db.prepare('SELECT files FROM messages WHERE text_src = ?').get('x');
  assert.ok(!String(stored.files ?? '').includes(forged), 'another user\'s key is dropped server-side');
  t.rt.destroy();
});

test('handoff to a human and back', { skip: skipReason }, async () => {
  const t = setup();
  await begin(t);
  await t.session.send({ text: '我想找人工', lang: 'zh-CN' });
  await t.session.requestHuman({ lang: 'zh-CN' });
  assert.equal(t.session.store.getState().supportMode, 'human_requested');
  const thread = t.h.db.prepare('SELECT ai_state, human_requested_at FROM threads WHERE app = ? AND uid = ?').get(APP, t.auth.uidOf(1));
  assert.equal(thread.ai_state, 'human');
  assert.ok(thread.human_requested_at, 'the Worker recorded the request');
  await t.session.resumeAi({ lang: 'zh-CN' });
  assert.equal(t.session.store.getState().supportMode, 'ai');
  t.rt.destroy();
});

test('unread: collapsed widget only counts (never reads); opening shows the reply and clears the badge', { skip: skipReason }, async () => {
  const t = setup();
  await begin(t);
  await t.session.send({ text: 'hi', lang: 'zh-CN' });
  await flush(80); // let the poll that send() triggers finish before collapsing
  t.session.setActive(false);
  putAdminReply(t.h.db, t.auth.uidOf(1), '您好，我是人工客服');
  await t.session.refresh();
  await flush();
  assert.equal(t.session.store.getState().unread, 1);
  assert.ok(t.h.seen.some((r) => r.url.includes('/api/unread')));
  const polledWhileCollapsed = t.h.seen.filter((r) => r.url.includes('/api/poll')).length;
  assert.equal(t.unread.at(-1), 1, 'host is told about the unread count');
  assert.equal(t.shadow().querySelector('.badge').hidden, false);
  t.rt.open();
  await flush(60);
  assert.ok(t.h.seen.filter((r) => r.url.includes('/api/poll')).length > polledWhileCollapsed, 'open polls');
  assert.equal(t.unread.at(-1), 0);
  assert.match(t.shadow().textContent, /人工客服/);
  t.rt.destroy();
});

test('account change: the previous account\'s thread, unread and draft never reach the next one', { skip: skipReason }, async () => {
  const t = setup();
  await begin(t);
  await t.session.send({ text: '账号A的秘密', lang: 'zh-CN' });
  t.rt.open();
  await flush(60);
  assert.match(t.shadow().textContent, /账号A的秘密/);

  t.state.user = t.auth.uidOf(2); // another WebClaw account signs in
  t.rt.resetIdentity();
  await flush(80);
  await t.session.refresh();
  await flush(60);
  assert.equal(t.session.store.getState().identityKey, `${APP}|${t.auth.uidOf(2)}`);
  assert.ok(!t.shadow().textContent.includes('账号A的秘密'), 'old account\'s message is gone from the UI');
  assert.equal(threadCount(t.h, t.auth.uidOf(2)), 0);
  assert.equal(threadCount(t.h, t.auth.uidOf(1)), 1);
  t.rt.destroy();
});

test('sign-out: the host tears the widget down; without a ticket nothing can be read or written', { skip: skipReason }, async () => {
  const t = setup();
  await begin(t);
  await t.session.send({ text: 'before', lang: 'zh-CN' });
  // SupportHost's effect cleanup on logout: destroy the runtime. A new one needs a fresh ticket, which Rust refuses.
  t.rt.destroy();
  t.state.fail = { code: 'login_required', message: 'x' };
  assert.equal(await probeSupport(async () => { throw t.state.fail; }), 'login_required');
  const again = createSupportRuntime({
    requestTicket: async () => { throw t.state.fail; }, document: t.dom.window.document, lang: 'zh-CN',
    origin: 'https://support.test', fetch: t.h.fetch, push: 'none',
  });
  await assert.rejects(() => again.session.send({ text: 'after logout', lang: 'zh-CN' }));
  assert.equal(t.h.db.prepare('SELECT COUNT(*) AS n FROM messages WHERE text_src = ?').get('after logout').n, 0);
  again.destroy();
});

test('theme: accent and dark scheme follow the app without rebuilding the widget', { skip: skipReason }, async () => {
  const t = setup();
  const root = t.dom.window.document.documentElement;
  root.style.setProperty('--accent', '#e11d48');
  t.rt.syncTheme();
  const host = t.rt.widget.shadowRoot.host;
  const before = t.rt.widget.shadowRoot.firstElementChild;
  assert.match(String(t.rt.widget.getTheme().primary), /#e11d48/i);
  root.dataset.theme = 'dark';
  t.rt.syncTheme();
  await flush();
  assert.equal(t.rt.widget.shadowRoot.host, host);
  assert.equal(t.rt.widget.shadowRoot.firstElementChild, before, 'DOM not rebuilt');
  t.rt.destroy();
});

test('security: forged, cross-tenant and expired tickets are rejected by the Worker', { skip: skipReason }, async () => {
  const t = setup();
  const good = t.auth.mint(t.auth.uidOf(1));
  const call = (ticket) => t.h.fetch('https://support.test/api/poll?app=video-creator&since=0', { headers: { Authorization: `Bearer ${ticket}` } });
  assert.equal((await call(good.ticket)).status, 200);
  assert.equal((await call(t.auth.mint(t.auth.uidOf(1), { app: 'ccdub' }).ticket)).status, 401, 'other tenant\'s ticket');
  const [h, c, s] = good.ticket.split('.');
  assert.equal((await call(`${h}.${c}.${s.slice(0, -4)}AAAA`)).status, 401, 'tampered signature');
  assert.equal((await call(t.auth.mint(t.auth.uidOf(1), { ttl: -300 }).ticket)).status, 401, 'expired');
  const other = authSimulator();
  assert.equal((await call(other.mint(t.auth.uidOf(1)).ticket)).status, 401, 'signed by a different key');
  t.rt.destroy();
});
