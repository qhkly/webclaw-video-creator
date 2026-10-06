# Video Creator account service

Cloudflare Worker between the desktop app and webclaw-store. The app holds only the user's own
auth.qhkly.com login; this Worker holds the store credential, which must never ship in the app
(webclaw-store `docs/billing-api.md`, "WebClaw Video Creator").

```
App ──idToken──▶ POST /v1/session ──verify RS256 (aud=video-creator)──▶ KV session
App ──Bearer───▶ GET  /v1/membership ──Basic STORE_CLIENT_ID:SECRET──▶ store /api/v1/membership
```

The design follows two production services:

- **ccdub-speech-gateway** (Voice Master): Auth idToken verification and the store membership client.
  The rules are the same: RS256 only, explicit `aud` allowlist, `iss` and `exp` required, membership is never read from the token, only `member === true` counts, and the service fails closed.
- **ai-studio-web**: a server-issued app session so the user does not sign in every 15 minutes.
  Sessions here are opaque KV records rather than JWTs, so logout can actually revoke them.

## API

All responses are JSON with `Cache-Control: no-store`. Errors are `{ "error": "<code>" }`.

| Request | Success | Errors |
|---|---|---|
| `POST /v1/session` `{ idToken, product? }` | `{ token, expiresAt, membership? }` | 400 bad body / `unknown_product`, 401 `invalid_id_token`, 503 `auth_unavailable` |
| `GET /v1/membership?product=webclaw-video-creator[&fresh=1]` + Bearer | store membership: `{ productSlug, member, known, planSlug, status, renewal, expiresAt, currentPeriodEnd, gracePeriodEndsAt, benefits, checkedAt }` | 401 `invalid_session`, 503 `membership_unavailable` |
| `POST /v1/session/renew` + Bearer | `{ token, expiresAt }` (old token deleted) | 401 `invalid_session` / `reauth_required` |
| `POST /v1/session/revoke` + Bearer | `{ ok: true }` (idempotent) | — |
| `GET /healthz` | `{ ok, service, product, missing: [] }` | 503 with the **names** of missing settings |

Notes:

- `expiresAt` is in Unix seconds.
- Any `/v1/*` call returns 503 `service_misconfigured` while a required setting is missing.
- `membership` is omitted from the session response when the store is down. The session still opens.

Behaviour:

- **Sessions.** The token is `vcs_` followed by 32 random bytes. KV stores only `sha256(token)`.
  - TTL is 7 days (`SESSION_TTL_SECONDS`).
  - Renewal rotates the token, but never past 30 days from the original sign-in (`SESSION_MAX_AGE_SECONDS`). After that the user signs in through Auth again.
  - Revocation is eventually consistent across Cloudflare locations (KV, ≤ ~60 s).
- **Membership cache** (per isolate, as the store asks): positive answers 60 s, negative 15 s, failures never cached.
  - `fresh=1` bypasses the cache. The app sends it on manual refresh and while waiting for a checkout.
  - The store's answer must name this product and this user; otherwise the request fails closed.
- **CORS.** The app calls from native code and sends no `Origin`.
  - Requests with an `Origin` outside `ALLOWED_ORIGINS` (empty by default) get 403, and no CORS grant is ever sent to them.
- **Secrets.** Only `STORE_CLIENT_SECRET`, held as a Wrangler secret. Nothing derived from it is ever returned or logged.

## Deploy

Prerequisites (one-time; none of this is done yet):

1. **Store credential.** In webclaw-store, `BILLING_CLIENTS_VIDEO_CREATOR` with id `webclaw-video-creator`, scope `read:entitlements`, `productSlugs: ["webclaw-video-creator"]`. Generate its secret in the store's config center.
2. **Auth public client.** On auth.qhkly.com, `AUTH_CLIENTS_VIDEO_CREATOR` (public, PKCE, loopback redirects 18861–18863). See `../docs/account-membership.md`.

Then:

```bash
cd account-service
npm install
npx wrangler kv namespace create SESSIONS          # paste the id into wrangler.jsonc
npx wrangler secret put STORE_CLIENT_SECRET         # the store credential's secret
npm test
npm run deploy                                      # → https://webclaw-video-creator-account.<account>.workers.dev
curl https://webclaw-video-creator-account.<account>.workers.dev/healthz   # expect {"ok":true,…,"missing":[]}
```

**Production domain.** The planned domain is `video-api.qhkly.com`. It does **not exist yet**. To enable it, uncomment the `routes` entry in `wrangler.jsonc` and deploy again; `custom_domain` creates the DNS record in the qhkly.com zone. Then check that `https://video-api.qhkly.com/healthz` answers. Only after that, build the app against it:

```bash
VIDEO_CREATOR_ACCOUNT_API_URL=https://video-api.qhkly.com npm run tauri:build
```

The app accepts only https in release builds. It bakes the URL in at compile time and never contains any secret.

Optional:

- Set `notifyUrl` on the store credential later to receive `entitlement.changed` (not needed: queries are direct and cached for at most 60 s).
- Add Cloudflare rate limiting on `/v1/session` if abuse appears.

## Local development

```bash
cp .dev.vars.example .dev.vars    # fill STORE_CLIENT_SECRET (git-ignored)
npm run dev                       # http://127.0.0.1:8787
# app side, debug build only:
VIDEO_CREATOR_ACCOUNT_API_URL=http://127.0.0.1:8787 npm run tauri:dev
```

Tests (`npm test`, also part of the repo's root `npm test`) run the Worker in Node with a fake KV, a generated RSA key and a stubbed store.
