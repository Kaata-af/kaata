# Kaata web workspace

The first browser workspace lives at `/app` in the existing Vite application. It uses the same accounts, vault membership, event history, and sync admission rules as mobile. It requires an internet connection and a current browser with Ed25519 WebCrypto support over HTTPS (localhost works for development).

## First release

- Email or username/password sign-in, email-code signup, and password recovery.
- Google and Apple sign-in, using the existing backend provider configuration and the same accounts as mobile.
- List and switch kaatas; create a kaata.
- Search people, add a person, and edit name/phone.
- All currency balances shown together, with separate totals for each currency and collect/pay/settled filters across currencies. No page currency selector; a person's history includes every currency.
- People ordered by recent activity as on mobile: latest remaining entry date, or creation date before the first entry; explicitly settled people follow open accounts.
- Record “I gave” and “I received,” with amount, currency, note and date; edit/delete eligible private entries.
- Export a person's full private history as a CSV, with currencies kept separate and spreadsheet-formula injection prevented.
- English, Dari, Pashto, RTL, desktop and narrow layouts.

This release deliberately excludes reminders, contact import, shared-account actions/history, member administration, credit-limit configuration, settlement actions and offline browser editing. People ever linked to a mutual tab are clearly labeled and their incomplete local balances are excluded from totals. Use the phone app for these features. Archived kaatas are view-only for their owner; archived people are hidden. Settled chapters remain visible and immutable.

## Data and security

`GET /v1/sync/ledger?vault_id=...` reads current authorization, vault metadata, all events and tab bindings in one repeatable-read transaction. It folds the current event log, including events newer than any persisted snapshot. It does not expose a second source of ledger truth. Reads are authenticated, rate-limited and `no-store`. Exact decimal amounts are returned as strings; UI arithmetic uses integer hundredths, and totals never mix currencies.

Writes use the existing device registration, server witness and signed `/v1/sync/push` endpoints. The browser signs Ed25519 events with the same canonical encoding as mobile. Credit checks and role enforcement still run on the server. New kaatas include signed membership/device genesis, shop profile and currency-setting events. Editing reloads the current ledger and checks the prior entry revision; amendments carry only changed fields. Concurrent changes between that check and push retain the existing mobile last-writer-wins behavior, rather than a new compare-and-swap guarantee.

Every sign-in creates a fresh browser install ID so it cannot rebind a phone. JWTs, browser signing keys and a pending signed operation are confined to `sessionStorage`; sign-out revokes the server credential and clears them. Sessions are scoped to the browser tab and expire with the server credential; browsers may restore storage when reopening tabs, so sign out on shared computers. Passwords and provider ID tokens are never persisted. Keep CSP and HTTPS enabled; session storage is not protection against same-origin script compromise.

`GET /v1/auth/providers` exposes only public provider settings: `{google: {client_id} | null, apple: {start_url} | null}`. The backend is the single source of provider configuration. Google Identity Services returns a credential to the browser, which submits it to the existing `/v1/auth/google` token-verifying endpoint. Apple opens the existing backend authorization flow with a browser-specific signed state valid for ten minutes and a nonce. The browser sends its current origin as `return_origin`; the backend permits only `WEB_BASE_URL`, plus `https://www.kaata.af` when the configured site is `https://kaata.af`. The chosen origin is included in signed state and validated again on callback. Apple's registered callback stays `/v1/auth/apple/web/callback`; browser completion returns to `/app` on the initiating allowed origin with a fragment, while Android keeps its app deep link. Browser state and nonce checks bind completion to the sign-in attempt. The callback fragment is cleared before normal workspace navigation. Provider credentials do not belong in server URLs or analytics.

Before sending a mutation, its exact signed IDs are saved in the tab. A lost response can be retried without creating a duplicate record. The pending-save banner also recovers after reload. Explicit rejection clears the retry; uncertain network failures preserve it. Signing out with an unconfirmed save requires acknowledging that the retry will be lost and that the server might already have received the change. This is recovery for an in-flight online request, not an offline outbox.

The workspace subscribes to the existing live notification broker. An authenticated `POST /v1/sync/live-ticket` exchanges the session for an opaque, single-use ticket expiring after 30 seconds; `/v1/sync/web-live` consumes it and revalidates the session before upgrading. The browser never places its session JWT in a WebSocket URL. Native `/v1/sync/live` remains compatible.

Live messages contain invalidation hints, not ledger data. Visible tabs reload the kaata list and current authorized ledger, coalescing bursts for 250 ms and spacing automatic reads at least eight seconds apart. A notification during a read queues a follow-up; rate-limit responses defer reads until their retry window. Connecting/reconnecting also catches up missed changes, and membership changes reconnect the subscription. Account-level hints make newly created kaatas discoverable. Polling every 30 seconds and refresh on focus remain fallbacks; manual refresh is available. Background updates preserve open drafts. Unsynced phone changes appear after the phone uploads them. Revoked-access responses clear displayed ledger data and its open draft. Marketing analytics skip initial workspace visits and redact `/app` paths/query parameters.

## Deployment

Deploy backend and web from the same commit, backend first. There is no database migration for this feature. Keep the existing mesh signer configured: witnessed admission of another device needs it.

- Existing backend `SESSION_JWT_SECRET`, database and mail configuration continue to apply. Email signup/reset requires the existing mail service; existing password sign-in works without mail.
- Set web build argument `VITE_BACKEND_URL` to the API origin.
- Google uses backend `GOOGLE_WEB_CLIENT_ID`, also used by mobile. No separate web client ID or web build argument is needed; remove obsolete `VITE_GOOGLE_WEB_CLIENT_ID` arguments. In Google Cloud, authorize both production origins (`https://kaata.af` and `https://www.kaata.af`) for that Web application client. Local testing requires `http://localhost` and the exact localhost port. The callback-based GIS flow does not need a separate Google redirect URI. Keep the existing consent branding and authorized domains current. See [Google's setup guide](https://developers.google.com/identity/gsi/web/guides/get-google-api-clientid).
- Apple uses backend `APPLE_SERVICES_ID` (the existing production Services ID is `af.kaata.auth`), the existing JWT secret, and valid HTTPS API/site origins. `WEB_BASE_URL` defaults to `https://kaata.af`; only for that canonical site, an empty `PUBLIC_API_BASE_URL` uses the fixed `https://api.kaata.af` Apple endpoint. Custom site origins require an explicit HTTPS API origin. Invalid explicit origins disable browser Apple sign-in; request Host headers never select the callback. In Apple Developer, associate the Services ID with the existing primary App ID `af.kaata.app` so users retain their Apple identity across platforms, register the relevant domains, and retain the exact return URL `https://api.kaata.af/v1/auth/apple/web/callback`. The new browser flow reuses that return URL. No additional Apple frontend ID, private key, or client secret is needed for this ID-token flow. Apple does not allow localhost or IP return URLs; use a registered HTTPS environment for real sign-in tests. See [Apple's web configuration guide](https://developer.apple.com/help/account/capabilities/configure-sign-in-with-apple-for-the-web) and [authorization requirements](https://developer.apple.com/documentation/signinwithapplerestapi/request-an-authorization-to-the-sign-in-with-apple-server).
- Caddy serves `/app` with its dedicated GIS CSP, no-store, no-referrer and noindex headers. The marketing-to-workspace link must perform a full document navigation so the browser receives that CSP. Marketing and admin pages retain their previous stricter CSP.
- Production supports both `https://kaata.af/app` and `https://www.kaata.af/app`. Apple begins and finishes on the same allowed origin so existing sessions, pending saves and the sign-in challenge remain in their original browser storage. There is no forced origin redirect or cross-origin session transfer.
- Direct `/app` reloads must fall back to the SPA shell. HTTPS is required for browser signing outside localhost. No new hosting service is needed.
- Preserve WebSocket upgrades for `/v1/sync/web-live`. The existing live broker and new ticket store are in-process and assume one backend instance. Multiple replicas need shared notification/ticket infrastructure (or appropriate routing); ordinary polling still works during live-channel outages.

## Verification

From the repository root:

```powershell
bun test ./apps/web/src/lib/web-auth.test.ts ./apps/web/src/lib/web-apple.test.ts ./apps/web/src/lib/web-google.test.ts ./apps/web/src/lib/web-ledger.test.ts ./apps/web/src/lib/web-ledger-protocol.test.ts ./apps/web/src/lib/web-live.test.ts ./apps/web/src/lib/web-refresh.test.ts ./apps/web/src/pages/workspace/model.test.ts
node --test apps/web/scripts/analytics-privacy.test.mjs apps/web/scripts/social-metadata.test.mjs
cd apps/web
bun run build
```

With a dedicated disposable PostgreSQL test database configured through `POSTGRES_TEST_URL`:

```powershell
cd apps/backend
go test ./internal/auth -count=1 -v
go test ./internal/sync -run 'TestWebLedger|TestPopulateWebLedger|TestWebLive|TestLiveTicket|TestLiveMembership|TestLive_' -count=1 -v
go test ./internal/vaults -run TestLiveInvalidation -count=1 -v
go test ./cmd/server
```

The database test harness resets its test schema. Never point it at a real application database. Without a reachable test database it skips integration tests; a skipped test is not a verified authorization path.

Provider release checks passed all 233 web tests across 23 files, all nine analytics/privacy and social-metadata tests, and the full backend auth suite against disposable PostgreSQL. A local browser fixture using synthetic Apple credentials verified same-tab completion, immediate removal of the callback fragment, one exchange despite React StrictMode, sign-out without automatic re-entry, and cancellation. A failed Apple exchange displayed an unavailable error; a fresh sign-in attempt then succeeded, with the callback fragment removed in both cases. The real Google Identity Services library rendered its button in that fixture; Google rejected the unregistered `localhost:3004` origin as expected. These checks do not represent completed consent with a real Apple or Google account.

Local browser checks covered existing-account sign-in, existing kaata balances, adding a person, Dari decimal input, entry correction, separate USD/AFN totals, new kaata creation, and Dari layout at desktop and 390px widths. A real isolated API smoke also covered person edits, entry deletion, new-vault signed genesis, sign-out/re-sign-in, and fresh-device witness admission. Mock transport tests cover lost-response retries. A read-only production Apple authorization request reached Apple's sign-in page with the existing Services ID and callback; this does not verify a completed sign-in. Real Google/Apple consent, existing Apple-account continuity, cancellation/retry on the deployed browser flow, live email delivery and a physical-phone round trip still need release-environment verification.

Live-update verification uses real PostgreSQL tests for ticket authentication/revocation, committed event delivery, account isolation, and post-commit kaata lifecycle notifications. Browser transport and refresh-queue tests cover reconnects, heartbeat loss, stale sessions, burst coalescing and rate-limit cooldowns. A disposable local WebSocket fixture verified automatic balance/history/customer changes, preservation of an unsaved draft, and catch-up after disconnection without manually refreshing.
