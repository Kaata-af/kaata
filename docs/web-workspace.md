# Kaata web workspace

The first browser workspace lives at `/app` in the existing Vite application. It uses the same accounts, vault membership, event history, and sync admission rules as mobile. It requires an internet connection and a current browser with Ed25519 WebCrypto support over HTTPS (localhost works for development).

## First release

- Google and Apple sign-in only, using the existing backend provider configuration and the same accounts as mobile. The same provider screen handles new and existing accounts.
- List and switch kaatas; create a kaata.
- Search people, add a person, and edit name/phone.
- All currency balances shown together, with separate totals for each currency and collect/pay/settled filters across currencies. No page currency selector; a person's history includes every currency.
- People ordered by recent activity as on mobile: latest remaining entry date, or creation date before the first entry; explicitly settled people follow open accounts.
- Record “I gave” and “I received,” with amount, currency, note and date; edit/delete eligible private entries.
- Export a person's full private history as a CSV, with currencies kept separate and spreadsheet-formula injection prevented.
- Internal customer notes with signed saves and paged edit history. Notes remain private to the kaata team, including for linked customers; unavailable author attribution is shown as unknown.
- Per-currency credit limits and remaining-credit status, with owner/admin configuration for customer overrides and kaata defaults. Shared or incomplete exposure remains unavailable.
- The mobile app's exact calculator inside the tally form, plus explicit tally time selection.
- Search tally notes and exact amounts, filter by currency or inclusive Gregorian date ranges, and expand settled history. Given/received totals and exports always retain whole-history scope.
- Search all 155 currencies when creating a kaata, enable up to 64, and change future-entry defaults without relabeling saved money.
- English, Dari, Pashto, RTL, desktop and narrow layouts.

This release deliberately excludes reminders, contact import, shared-account financial actions/history, member administration, combined credit-alert rule configuration, settlement actions and offline browser editing. People ever linked to a mutual tab are clearly labeled and their incomplete local balances are excluded from totals; their internal team notes and credit settings remain available. Use the phone app for the excluded features. Archived kaatas are view-only for their owner; archived people are hidden. Settled chapters remain visible and immutable.

## Routes

| Route                  | Page                                    |
| ---------------------- | --------------------------------------- |
| `/app`                 | Authenticated workspace                 |
| `/app/subscription`    | Optional Web Pro plans and payment status |
| `/app/sign-in`         | Apple or Google sign-in                 |
| `/app/sign-up`         | Redirect to the provider sign-in screen |
| `/app/forgot-password` | Redirect to the provider sign-in screen |

The compact provider screen loads separately from the ledger. It has no email, password, verification-code or separate registration form. Provider discovery and SDK failures show retry options. Session guards replace the current entry when redirecting signed-out visitors to sign-in or signed-in visitors to the workspace; retired auth URLs also use replacement redirects. Unknown `/app/*` routes show a localized 404. Page titles follow the active route and language.

Auth history changes cancel pending sign-in, including browser Back, so a late response cannot open an account after the visitor leaves. The existing Apple `/app#...` return remains compatible: its fragment is removed before routing or provider scripts load, and completion is consumed once. Sign-out returns to `/app/sign-in` without replaying a completed Apple return.

## Data and security

Kaata Web Pro currently runs as an open free trial. The subscription banner and authenticated plan page do not restrict any workspace operation. Plans cost 200 AFN monthly or 2,000 AFN yearly, prepaid through HesabPay, with mobile subscriptions deferred. See [Web Pro](web-pro.md) for payment verification, renewal, deployment and operational checks.

`GET /v1/sync/ledger?vault_id=...` reads current authorization, vault metadata, all events and tab bindings in one repeatable-read transaction. It folds the current event log, including events newer than any persisted snapshot. It does not expose a second source of ledger truth. Reads are authenticated, rate-limited and `no-store`. Exact decimal amounts are returned as strings; UI arithmetic uses integer hundredths, and totals never mix currencies.

Writes use the existing device registration, server witness and signed `/v1/sync/push` endpoints. The browser signs Ed25519 events with the same canonical encoding as mobile. Credit checks and role enforcement still run on the server. New kaatas include signed membership/device genesis, shop profile and currency-setting events. Editing reloads the current ledger and checks the prior entry revision; amendments carry only changed fields. Concurrent changes between that check and push retain the existing mobile last-writer-wins behavior, rather than a new compare-and-swap guarantee.

Customer notes use `person_note_set` with a 2,000-code-point limit and revision checks before signing. Relationship-scoped `/v1/sync/person-notes` pages expose private revisions in signed-clock order, without changing mobile's existing recovery stream. Claimed actor fields are not treated as verified author identity. Customer notes are never added to statement exports. Independent credit settings reuse authenticated GET/PUT `/v1/sync/credit-limits`; fresh-policy checks catch known conflicts but do not provide atomic compare-and-swap. Blank caps mean unlimited, zero means no new exposure, and currencies never net or convert. Disputed entries are excluded from financial totals. The additive `credit_balances_complete` marker gates web exposure calculations during mixed-version deployments.

The calculator and currency catalog are imported from the same platform-independent mobile modules used by the release. The web Docker context includes only those explicit domain files, their pure money/digit dependencies, the web app and shared palette. No native runtime or private mobile environment files are included.

Every sign-in creates a fresh browser install ID so it cannot rebind a phone. JWTs, browser signing keys and a pending signed operation are confined to `sessionStorage`; sign-out revokes the server credential and clears them. Sessions are scoped to the browser tab and expire with the server credential; browsers may restore storage when reopening tabs, so sign out on shared computers. Provider ID tokens are never persisted. Keep CSP and HTTPS enabled; session storage is not protection against same-origin script compromise.

`GET /v1/auth/providers` exposes only public provider settings: `{google: {client_id} | null, apple: {start_url} | null}`. The backend is the single source of provider configuration. Google Identity Services returns a credential to the browser, which submits it to the existing `/v1/auth/google` token-verifying endpoint. Apple opens the existing backend authorization flow with a browser-specific signed state valid for ten minutes and a nonce. The browser sends its current origin as `return_origin`; the backend permits only `WEB_BASE_URL`, plus `https://www.kaata.af` when the configured site is `https://kaata.af`. The chosen origin is included in signed state and validated again on callback. Apple's registered callback stays `/v1/auth/apple/web/callback`; browser completion returns to `/app` on the initiating allowed origin with a fragment, while Android keeps its app deep link. Browser state and nonce checks bind completion to the sign-in attempt. The callback fragment is cleared before normal workspace navigation. Provider credentials do not belong in server URLs or analytics.

Before sending a mutation, its exact signed IDs are saved in the tab. A lost response can be retried without creating a duplicate record. The pending-save banner also recovers after reload. Explicit rejection clears the retry; uncertain network failures preserve it. Signing out with an unconfirmed save requires acknowledging that the retry will be lost and that the server might already have received the change. This is recovery for an in-flight online request, not an offline outbox.

The workspace subscribes to the existing live notification broker. An authenticated `POST /v1/sync/live-ticket` exchanges the session for an opaque, single-use ticket expiring after 30 seconds; `/v1/sync/web-live` consumes it and revalidates the session before upgrading. The browser never places its session JWT in a WebSocket URL. Native `/v1/sync/live` remains compatible.

Live messages contain invalidation hints, not ledger data. Visible tabs reload the kaata list and current authorized ledger, coalescing bursts for 250 ms and spacing automatic reads at least eight seconds apart. A notification during a read queues a follow-up; rate-limit responses defer reads until their retry window. Connecting/reconnecting also catches up missed changes, and membership changes reconnect the subscription. Account-level hints make newly created kaatas discoverable. Polling every 30 seconds and refresh on focus remain fallbacks; manual refresh is available. Background updates preserve open drafts. Unsynced phone changes appear after the phone uploads them. Revoked-access responses clear displayed ledger data and its open draft. Marketing analytics skip initial workspace visits and redact `/app` paths/query parameters.

## Deployment

Deploy backend and web from the same commit, backend first. The ledger parity features need no database migration; optional Web Pro adds migration `076_web_pro.sql`. Keep the existing mesh signer configured: witnessed admission of another device needs it.

- Existing backend `SESSION_JWT_SECRET` and database configuration continue to apply. Browser sign-in uses the configured Apple and Google providers.
- Set web build argument `VITE_BACKEND_URL` to the API origin.
- Google uses backend `GOOGLE_WEB_CLIENT_ID`, also used by mobile. No separate web client ID or web build argument is needed; remove obsolete `VITE_GOOGLE_WEB_CLIENT_ID` arguments. In Google Cloud, authorize both production origins (`https://kaata.af` and `https://www.kaata.af`) for that Web application client. Local testing requires `http://localhost` and the exact localhost port. The callback-based GIS flow does not need a separate Google redirect URI. Keep the existing consent branding and authorized domains current. See [Google's setup guide](https://developers.google.com/identity/gsi/web/guides/get-google-api-clientid).
- Apple uses backend `APPLE_SERVICES_ID` (the existing production Services ID is `af.kaata.auth`), the existing JWT secret, and valid HTTPS API/site origins. `WEB_BASE_URL` defaults to `https://kaata.af`; only for that canonical site, an empty `PUBLIC_API_BASE_URL` uses the fixed `https://api.kaata.af` Apple endpoint. Custom site origins require an explicit HTTPS API origin. Invalid explicit origins disable browser Apple sign-in; request Host headers never select the callback. In Apple Developer, associate the Services ID with the existing primary App ID `af.kaata.app` so users retain their Apple identity across platforms, register the relevant domains, and retain the exact return URL `https://api.kaata.af/v1/auth/apple/web/callback`. The new browser flow reuses that return URL. No additional Apple frontend ID, private key, or client secret is needed for this ID-token flow. Apple does not allow localhost or IP return URLs; use a registered HTTPS environment for real sign-in tests. See [Apple's web configuration guide](https://developer.apple.com/help/account/capabilities/configure-sign-in-with-apple-for-the-web) and [authorization requirements](https://developer.apple.com/documentation/signinwithapplerestapi/request-an-authorization-to-the-sign-in-with-apple-server).
- Caddy serves `/app` with its dedicated GIS CSP, no-store, no-referrer and noindex headers. The marketing-to-workspace link must perform a full document navigation so the browser receives that CSP. Marketing and admin pages retain their previous stricter CSP.
- Production supports both `https://kaata.af/app` and `https://www.kaata.af/app`. Apple begins and finishes on the same allowed origin so existing sessions, pending saves and the sign-in challenge remain in their original browser storage. There is no forced origin redirect or cross-origin session transfer.
- Direct `/app` reloads must fall back to the SPA shell. HTTPS is required for browser signing outside localhost. No new hosting service is needed.
- Auth routes also use the `/app/*` SPA fallback and private headers, so their direct links and reloads work without additional server endpoints.
- Preserve WebSocket upgrades for `/v1/sync/web-live`. The existing live broker and new ticket store are in-process and assume one backend instance. Multiple replicas need shared notification/ticket infrastructure (or appropriate routing); ordinary polling still works during live-channel outages.

## Verification

From the repository root:

```powershell
bun test ./apps/web/src
node --test apps/web/scripts/analytics-privacy.test.mjs apps/web/scripts/social-metadata.test.mjs
cd apps/web
bun run build
```

With a dedicated disposable PostgreSQL test database configured through `POSTGRES_TEST_URL`:

```powershell
cd apps/backend
go test ./internal/auth -count=1 -v
go test ./internal/sync ./internal/httpx -count=1
go test ./internal/vaults -run TestLiveInvalidation -count=1 -v
go test ./cmd/server
```

The database test harness resets its test schema. Never point it at a real application database. Without a reachable test database it skips integration tests; a skipped test is not a verified authorization path.

The mobile-parity update passed 262 web tests across 26 files, the production TypeScript/Vite build, and nine analytics/privacy and metadata checks. The full sync and HTTP middleware suites passed against disposable PostgreSQL, including note revision ordering, pagination, redaction, revoked access and unchanged mobile recovery signatures. Server compilation passed. The temporary database was stopped and removed afterward.

A disposable browser API with synthetic records verified real Ed25519-signed note, tally and currency saves, note history, independent AFN/USD credit-policy saves, country-based currency search, exact-amount search across settled history, currency/date filters and an inclusive single-day range. It also verified that disputed amounts do not enter balances, shared accounts keep private notes without fabricated exposure, viewers cannot edit, and the 390px Dari layout fits without horizontal overflow. A committed note followed by a simulated 503 response displayed the pending-save banner and sign-out warning; retry reused the event ID and produced exactly one revision. CSV tests verify localized current/settled/disputed status labels while preserving all history and formula neutralization. No real provider account or customer record was used.

Provider release checks passed all 233 web tests across 23 files, all nine analytics/privacy and social-metadata tests, and the full backend auth suite against disposable PostgreSQL. A local browser fixture using synthetic Apple credentials verified same-tab completion, immediate removal of the callback fragment, one exchange despite React StrictMode, sign-out without automatic re-entry, and cancellation. A failed Apple exchange displayed an unavailable error; a fresh sign-in attempt then succeeded, with the callback fragment removed in both cases. The real Google Identity Services library rendered its button in that fixture; Google rejected the unregistered `localhost:3004` origin as expected. These checks do not represent completed consent with a real Apple or Google account.

Production `/v1/auth/providers` returns both providers. The Apple button on `www.kaata.af` opens Kaata's branded Apple sign-in page, and browser Back restores an enabled login screen. Both `https://kaata.af` and `https://www.kaata.af` are now saved as authorized JavaScript origins on the existing Google OAuth client. In Chrome, Google's buttons on both origins open the real account chooser showing “to continue to kaata.af,” with no console errors. The popups were closed without selecting an account; no real OAuth consent or complete production provider sign-in was performed.

The OAuth-only release passed all 233 web tests and nine analytics/privacy and metadata checks. Auth, ledger and live-update test fixtures now sign in through Google; the web client has no email/password auth helpers. Browser QA verified that retired signup and recovery URLs redirect to `/app/sign-in`, with no credential fields or separate registration links. A disposable local API verified retry behavior for both an empty provider configuration and a 503 response, followed by recovery to the two provider buttons. The compact screen also passed a 390px Dari RTL check. Earlier synthetic Apple checks verified one exchange per start and sign-out without callback replay; no real provider account was used in these browser checks.

Local browser checks covered existing-account sign-in, existing kaata balances, adding a person, Dari decimal input, entry correction, separate USD/AFN totals, new kaata creation, and Dari layout at desktop and 390px widths. A real isolated API smoke also covered person edits, entry deletion, new-vault signed genesis, sign-out/re-sign-in, and fresh-device witness admission. Mock transport tests cover lost-response retries. Real Google/Apple consent and completed production sign-in, existing Apple-account continuity and a physical-phone round trip still need release-environment verification.

Live-update verification uses real PostgreSQL tests for ticket authentication/revocation, committed event delivery, account isolation, and post-commit kaata lifecycle notifications. Browser transport and refresh-queue tests cover reconnects, heartbeat loss, stale sessions, burst coalescing and rate-limit cooldowns. A disposable local WebSocket fixture verified automatic balance/history/customer changes, preservation of an unsaved draft, and catch-up after disconnection without manually refreshing.
