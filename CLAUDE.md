# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

@AGENTS.md

## Commands

- `bun dev` — backend (Go), web (Vite + React), mobile (Expo) running concurrently via `concurrently`. **Does not start Postgres** — a local Postgres on `:5432` is a prerequisite (see README "Prerequisites").
  - The mobile lane goes through `apps/mobile/scripts/dev-with-qr.mjs`, which exists **only** to get the Expo Go QR back. `concurrently` gives each child a pipe rather than the terminal, and `@expo/cli`'s `isInteractive()` is `!shouldReduceLogs() && !env.CI && process.stdout.isTTY` — false under a pipe, which sends `startAsync` down a branch that logs one `Waiting on <url>` line and never calls `printDevServerInfoAsync` (the QR). So the QR was never printed, not mangled. The wrapper echoes Expo's stdout untouched, takes the **port** from that banner (never guess it — 8081 may be taken, and a second Metro for the same project answers a probe just as convincingly) and the **host** from `lan-network`, the same package Expo's `getIpAddressAsync` uses (the banner says `localhost` in this branch, and on a machine with a VPN the tunnel adapter enumerates ahead of Wi-Fi, so neither the banner nor a naive first-non-internal-IPv4 is safe). When stdout IS a TTY it hands the terminal straight to Expo and prints nothing, so a standalone run is unchanged and you never get two QR codes. The interactive keys (`r`, `m`, `j`) cannot work under `bun dev` at all — concurrently owns stdin — so run `cd apps/mobile && npx expo start` when you need them.
- `bun format` — Prettier on JS/TS + `go fmt` on backend.
- Per-app:
  - `cd apps/backend && go run ./cmd/server` — backend only
  - `cd apps/backend && go build ./...` — compile check
  - `cd apps/web && bun run dev` — web only (Vite dev server on :3000, web uses Bun)
  - `cd apps/web && bun run build` — web prod build (outputs `apps/web/dist/`)
  - `cd apps/mobile && npm run start` — mobile only (**mobile uses npm**, not Bun — match what the root `dev` script does)
  - `cd apps/mobile && npx tsc --noEmit` — mobile typecheck
  - `cd apps/web && ./node_modules/.bin/tsc --noEmit` — web typecheck (plain `npx tsc` fails to resolve TypeScript installed by Bun; call the local binary directly)
  - Mobile package adds: `cd apps/mobile && npx expo install <pkg>` (not `npm install`) — Expo picks SDK-compatible versions.

### Tests

- **Mutual-tab follow-up:** `selftest:auth-redirect` covers sign-in redirects and restore/new-account separation; `selftest:notification-navigation` covers per-tally routing and access checks. Backend migration 042 and mobile migration 030 add identity metadata only. Do not infer historical authors from the party owner. New tally authors and notification actors use authenticated account names, never store labels; foreground OS presentation is silent, and self-delivery is filtered at enqueue/delivery/inbox. The shared-account badge is not phone verification. Deploy the backend before testing new author names on the phones; legacy records without authors remain unknown.

- **Backend (Go):** `cd apps/backend && go test ./...`. These run against a REAL Postgres — no mocks, because the schema, partial unique indexes and `ON CONFLICT` arbiters _are_ the behaviour under test. `internal/testutil.ConnectTestDB` resets `public` with `DROP SCHEMA` and replays the full migration chain, so it must NEVER be pointed at the dev database. It reads `POSTGRES_TEST_URL`, defaulting to `postgres://kaata:kaata@localhost:5432/kaata_test`; if that server is unreachable every DB-backed test SKIPS, so a green run means nothing until you check for `ok` vs `[no tests to run]`. The `kaata` role has no CREATEDB, so creating the database needs the superuser: `psql -h localhost -U postgres -c "CREATE DATABASE kaata_test OWNER kaata"`. Without the postgres password, the throwaway-cluster route works and touches nothing: `initdb -D <tmp> -U postgres --auth=trust`, `pg_ctl -D <tmp> -o "-p 55432" start`, create role + db there, then `POSTGRES_TEST_URL=postgres://kaata@localhost:55432/kaata_test go test ./...`, and `pg_ctl stop` after. Binaries live in `C:\Program Files\PostgreSQL\18\bin`.
- **Mobile:** `cd apps/mobile && npm run selftest:<name>` — `hlc`, `jalali`, `ingest`, `migration-014`, `money`, `person-save`, `device-key`, `attribution`, `tabs`, `notifications`, `inbox`, `tally-ui`, `invite-dialog`. Plain Node scripts against the real modules, no test runner. `jalali` shares its vectors with Go's `TestBillDateGoldenVectors` — add a case to one, add it to the other. `notifications` stubs only the native/network boundaries; it cannot verify APNs/FCM delivery or Swift execution. `tally-ui` checks rendered control/name/pill structure and layout constraints; native Yoga layout still needs phone testing.

## Architecture

### Monorepo layout

`apps/{mobile,web,backend}` are deployable units. The Go backend is not part of any JS workspace — `bun dev` simply `cd`s into each app. There is no `packages/` directory because nothing is shared between the three apps yet.

### Mobile-first, backend is a thin phone-home

The mobile app is local-first: every ledger feature (people, entries, balances, WhatsApp share) hits only SQLite. **The customer ledger never leaves the device** in v1. The only network call is `POST /v1/check-in` on every launch, non-blocking, 5-second timeout — used solely to:

1. Record an anonymous install (UUID generated locally on first run, persisted in `app_meta.install_id` forever)
2. Receive update + announcement metadata for the banner
3. Send opaque telemetry deltas (usage counters, has_onboarded, attribution IP for QR matching) — never customer ledger content
4. Send the shopkeeper's **OWN** self profile (`self_name` / `self_phone` / `shop_name`, from `getLocalSelf()`) so the admin dashboard can show who's using the app **regardless of sign-in** (operator outreach for churn interviews). Stored on the `installs` row (migration 028, latest-non-empty/COALESCE semantics). **Scope is the local-self user only — never customers/suppliers.** This is a deliberate narrowing of the old "no name/phone leaves the device without sign-in" stance; `apps/backend/internal/admin/users.go` also uses these as a fallback for signed-in accounts that never backed up a vault (snapshot identity still wins when present).

The check-in path lives in `apps/mobile/lib/api.ts` and `apps/mobile/app/_layout.tsx`'s `BackgroundCheckIn` component. The response is persisted to `app_meta` and consumed by `apps/mobile/components/UpdateBanner.tsx`. **`force_update` is held in memory only — never persisted** so an updated client cannot be falsely locked out by a stale flag.

### Two completely separate schemas

- **Mobile (SQLite)** — schema lives in `apps/mobile/lib/db.ts` as TypeScript-driven migrations. Has its own `schema_migrations` table. Migrations are async functions (`runMigration001`, `runMigration002`, …) gated by `hasRunMigration()`. **Migrations are append-only**: never modify a migration that's been applied — add a new `00X_…` migration that conditionally `ALTER`s.
- **Backend (Postgres)** — SQL files in `apps/backend/internal/db/migrations/`. `db.Migrate()` runs each `.sql` file once, tracked in its own `schema_migrations` table.

The two schemas have nothing in common. Ledger data lives only on mobile; the backend stores installs + releases + announcements + web_visits (for QR attribution) only.

### "users + relationships" data model (mobile)

Every entity — shopkeeper (the local self), a person they owe / are owed by — is a `users` row. `relationships` rows bind two users with a `context` enum (`'customer' | 'supplier' | 'peer'`) — the column still exists for forward compatibility, but **migration 003 collapsed every active relationship to `'peer'`**. The UI is direction-free: there's no "customer flow" or "supplier flow"; every new contact gets a single `peer` relationship and the direction (To collect vs To pay) is derived from the running net balance per person, not stored. `entries` reference `relationships`, not people directly. Do not add a `customer_id` column on `entries` — that was the v0 model. View types are `Person` / `PersonWithBalance` (signed `balance`) / `Self` in `apps/mobile/lib/types.ts`.

Entry semantics: `entries.type` is still `'debt' | 'payment'` in the DB, but UI-wise:

- `'debt'` → "I gave" → balance += amount
- `'payment'` → "I received" → balance -= amount

The same vocabulary works whether the person is currently your debtor or your creditor.

### Decimal money amounts

`amount_afn` is a historical field name: values remain major units of the
vault's display currency, with up to two decimal places. Existing `100` still
means `100`, not `1.00`. Keep signed events, snapshots, and stored values in
these units; use `lib/money.ts` and `lib/money-sql.ts` for integer-hundredth
arithmetic. The backend uses `json.Number` for passive projection/snapshot
amounts. No migration or history rewrite is needed. All editing devices must
update before a shared kaata uses cents; old app edit code can turn `12.34`
into `1234`. See `docs/decimal-amounts.md` for rollout and regression checks.

### Mutual tab (Kaata 2.0)

A **tab** is one running account shared by two independent parties — a shopkeeper and
a counterparty, both signed in to the app. Either can add a tally; the other can
accept or reject it, and only the author can void it. Rejected tallies remain
visible but are EXCLUDED from both balances and new exports/bills. The wire enum
remains `disputed` for compatibility. Pending/accepted tallies count. The FIRST
accept/reject decision is final (409 `review_final`); identical retries are idempotent,
but even the rejection reason cannot be changed. Corrections require a NEW tally.
Enforce this under the backend row lock and in the local mutation transaction;
hide review controls on all non-pending rows. Existing frozen bill links never change. The normative
contract is `docs/mutual-tab-design.md` — every wire shape, table and signature lives
there, and the decision letters (D1…D17) cited below are its table. Change that
document before changing the model.

- **The server is the source of truth, and the tab is NEVER mirrored into the vault
  event log (D2).** Mobile keeps a plain cache — `tab_links` / `tab_entries` /
  `tab_outbox` (migration 028) — and `lib/db.ts`'s read sites JOIN it. A mirror was
  tried on paper and fails four ways at once: the mirror event would be signed by
  THIS device and attributed to THIS account, so the counterparty's tally would be
  painted as yours; a viewer/clerk device could not mint it at all (role gate);
  `entry_deleted` is a sticky hidden tombstone, so a VISIBLE void is impossible; and
  mirrors enter the vault push outbox and replicate to members as shop-authored
  events. Two parties plus a server need no CRDT — that is the whole point.
- **The cursor rule: an op ack never advances `rev`.** `tab_links.rev` means "every
  row with rev ≤ this is cached", and only a PULL can promise that. An append/accept/
  dispute response carries ONE row plus the tab's current rev; the other party's rows
  written in between are not in it. Advancing the cursor on an ack skipped them
  permanently, because the pull that followed asked `after_rev=<ack rev>` and got
  nothing. Acks apply with `advanceCursor:false` (`lib/tabs/db.ts upsertTabFromWire`)
  and the pull after every flush starts from the untouched cursor; re-fetching the
  acked row is an idempotent upsert.
- **Closing a tab FREEZES it; it does not un-happen it (D8) — so no read site may
  filter on `closed_at IS NULL`.** Once a contact has ever been linked, its account is
  the tab's rows plus any local tallies written after the link, and the pre-link local
  rows stay excluded FOREVER because the tab's opening entry already carries their sum.
  Reverting a closed tab's contact to its bare local book does both halves of the
  damage at once: every tally of the shared months disappears from the contact, and the
  stale pre-link number reappears on the home screen as if it were today's. The read
  sites therefore join the open tab **or the most recent closed one**
  (`PERSON_BALANCE_SQL` / `TAB_LINK_JOIN` in `lib/db.ts`, `getLatestTabLinkForPerson`),
  while the WRITE paths keep using `getTabLinkForPerson` (open only) so a closed tab
  offers no verbs — a frozen row gets no long-press sheet rather than a menu of
  no-ops. `signedEntryMinorSumSql(alias, onlyWhen)`'s second argument exists for the
  `e.created_at > tl.linked_at` cut, so the sign-and-rounding rule is never re-derived.
  `selftest:tabs` case 14 pins the whole sequence: link → close → the balance holds →
  a new local tally adds on top of it.
- **Currency is fixed at creation and locks the kaata (D9).** A tab takes the
  creator's vault currency and can only be joined into a kaata with the same one; the
  app never computes a rate, so a mixed-currency balance would be a lie.
  `changeVaultCurrency` refuses while `vaultHasOpenTab(vaultId)` (`VaultHasOpenTabError`
  → `t('tab.currencyLocked')`), and the join screen offers to create a kaata in the
  tab's currency rather than bending either side.
- **The duplicate hint fires on the SAME absolute direction, not the opposite one
  (D17).** Both parties recording one cash handover is the settlement double-log: B
  pays A 500, A records "received" (`b_to_a`) and B records "gave" (`b_to_a`) — an
  identical pair that doubles the balance. Opposite directions are the ordinary
  goods-then-cash pair and net correctly. v1 is a warning toast within ±24 h, not a
  handshake.
- **Shared accounts require a session JWT.** An invitation token only permits
  a signed-in first claim; it is not read/write authority. Once bound, forwarded
  links cannot replace the account. Migration 040's sticky `account_bound_once`
  flag prevents deleted accounts (FK SET NULL) from reopening old invitations.
  Vault members retain role-gated access: clerk+ appends, editor+ reviews.
- **Restore uses `GET /v1/tabs/mine`.** Legacy unbound tabs may be claimed once
  with a session plus the saved party token. Never retry a refused JWT as an
  anonymous capability. A 401 must keep queued intent for a later signed-in retry.
- **Web `/t/{token}` is only an app-opening invitation.** No names, balances,
  financial previews, polling or mutation UI. Sign-in/join happen in the app;
  `/v/{token}` remains the separate read-only permanent bill. Preserve no-referrer
  headers and token redaction in request/analytics logs.
- **Mobile realtime** is `{"t":"tab_poke","tab_id"}` on the existing `/v1/sync/live`
  socket under an `acct:<id>` pseudo-key; pokes are lossy by design and the backstop is
  `startTabSyncLoop` (`<TabSync/>` in `_layout.tsx`). `lib/tabs/notify.ts` renews per-party Expo push subscriptions;
  `internal/tabs/push.go` delivers actor-and-amount alerts from a transactional outbox and
  checks receipts/revocations. Enable `TAB_PUSH_ENABLED` only after FCM/APNs native
  credentials are configured. Expo Go skips notifications; see `docs/kaata-2-testing.md`.
  Refused offline intent is retained in `tab_failed_ops` (migration 029), separately
  from the shared balance, and shown under the contact's “Not sent” fold.
- **Tests:** `cd apps/mobile && npm run selftest:tabs` (direction mapping, balances
  against `apps/_shared/tab-vectors.json`, outbox ordering/backoff, the wire merge) and
  `./node_modules/.bin/tsc --noEmit`; `cd apps/backend && go test ./internal/tabs/...`
  (real Postgres — `POSTGRES_TEST_URL`, never the dev DB). The balance vectors are
  shared between Go and mobile like the Jalali ones: add a case to one, add it to the
  other. `TestAppOnlyInvitation` checks the generic landing and script escaping.
- **Notification reviews** use locale-specific categories with Accept/Reject.
  Android receives action responses through TaskManager; iOS uses the local
  `kaata-notification-actions` module to persist the tap and grant bounded
  background time before JS queues it. Keep UIKit work on main. SQL receipts
  dedupe taps across foreground/headless/launch paths; `expected_rev` rejects
  stale actions. Payloads carry opaque IDs and revisions, never amounts, names
  or authentication tokens. Test real native builds: Expo Go and a JS bundle
  check cannot prove APNs/FCM delivery or Swift background execution.

### A kaata's name lives in TWO tables, and both projections must mirror it

`vaults.name` and `shop_profile.shop_name` are one user-perceived name. The vault switcher reads the first, the home header reads `COALESCE(shop_profile.shop_name, vaults.name)` (`getLocalSelf`), so a stale shop name **shadows** a correct vault name. A rename emits `vault_setting_set{key:"name"}` and nothing else — no `shop_profile_updated` is ever emitted for it — so **every applier that handles `vault_setting_set` must mirror onto the shop profile too**, under the same per-field HLC comparison a `shop_profile_updated` would use. Both sides now do: `apps/mobile/lib/projection/vault_settings.ts` and Go's `applyVaultSettingSet` (`internal/sync/project.go`).

The Go half is the one that bites, because that projection is what a **snapshot** is built from, and a snapshot is the entire starting state for a reinstalling device and for every new member. Without the mirror the snapshot carried the current name in `vault.name` and the pre-rename name in `shop_profile.shop_name`; the restore cursor is set past the rename event (`restore.ts` → `setLastPulledServerSeq`), so the rename is never pulled and the mobile mirror never runs to repair it. The wrong name was permanent on that device, and it bled into share text, PDF exports and sync notifications, which all read `shop_name`. Pinned by `TestRenameMirrorsOntoShopProfile`.

Related, same file: every table seeded by `restoreFromSnapshot` must get a `floorFieldHLCs(...)` value for its `field_hlcs` column. A NULL there floors every field to `FIELD_HLC_INIT`, so the next `*_updated` event wins the per-field comparison **even when it is older** than what was just restored. `shop_profile` was missing this while its three siblings had it.

Known and currently unreachable: `vault_settings` rows carry HLCs locally but are not in the snapshot wire, so a restored device has no floor for them. Server pull cannot deliver a pre-snapshot rename (cursor), but a mesh peer could, and it would be applied unconditionally and regress the name. Harmless while `MESH_PARKED` is true; fix before un-parking by putting `vault_settings` plus their HLCs into `SnapshotResponse`.

### PDF exports (`lib/export/pdf.ts`)

Rebuilt 2026-09 after a shopkeeper called the old statement ugly and unreadable, sending a competitor's document he preferred. The shape now is masthead → party card → summary cards → titled section → one table with a dark header band, row numbers and zebra striping. Rules worth keeping:

- **`print-color-adjust: exact` is load-bearing.** WebView print drops background colors by default, which renders the masthead and the table header band white-on-white. `thead { display: table-header-group }` likewise — these statements routinely run several pages and the column band must repeat.
- **The running-balance column is gone on purpose.** Three numeric columns competing for one glance was the clutter; the summary cards answer the balance question above the table. The CSV still carries it — that is a machine contract and was deliberately left alone.
- **Amounts are coloured by direction and never signed in rows.** "I gave" is garnet, "I received" is emerald, per `lib/colors.ts`. A sign there would encode the opposite axis, since a gave row increases what the customer owes. Signs appear only on balances, where they mean one thing.
- **`.num` (`direction:ltr; unicode-bidi:isolate`) is for numbers only.** Wrapping a localized DATE in it reorders the Dari date. Dates are prose; give them `dir="auto"`.
- **Isolate every item in a dot-separated meta line.** Without `unicode-bidi:isolate` per item, the bidi algorithm runs a date and the count after it together, so `۱۴۰۵ · ۴۸` renders as one nonsense number. The dot alone is not a boundary.
- **Never reuse a UI chip string carrying `·` in a document.** In Dari that middle dot lands against the date's leading digit and reads as a Persian zero: `۱۳ سنبله` became `۱۳۰ سنبله`. `export.doc.settledOn` spells the word out instead.
- Counts inside prose take the locale's digits (`countIn`); money and row indices stay Latin, matching the app and the reference document.

`npm run preview:pdf -- <outDir>` writes the exact HTML both builders hand to expo-print, using a Dari fixture with Afghan month names. Open it in a browser, or screenshot it with headless Chrome, and look — none of the failure modes above are catchable by assertion. `selftest:money` group 6 pins the decimal cents through the new amount cells and summary cards.

**"Save to phone" goes through `modules/kaata-save-file`, never a directory picker.** The old path used expo-file-system's `Directory.pickDirectoryAsync` on both platforms and was broken on both: since Android 11 the system forbids that picker from granting the Downloads folder or the storage root, so users were bounced between folders they could not choose ("keeps asking for a new folder"); and on iOS the round-trip crashed the app — SIGABRT from an uncaught JS exception during the tap's re-render, reproduced on 1.1.1 from the store, cause never symbolicated. The module writes to `MediaStore.Downloads` on Android (public Downloads, no picker, no permission on 10+; `E_UNSUPPORTED` below 10 and the caller opens the share sheet instead) and presents `UIDocumentPickerViewController(forExporting:asCopy:)` on iOS (the system Save-to-Files for one file; iOS does the copy). `saveExportFile` returns a `SaveOutcome` so the two call sites word the confirmation through one `savedMessage`. Failures are queued to the crash outbox with the stage (`export:save:pdf`) so the next launch can report what a dead process could not. Any selftest that loads `lib/export/data.ts` must stub `react-native` and `kaata-save-file` (see `money-selftest.ts`).

Two rules learned from the crash logs of that rewrite, both cheap to break again:

- **An Expo `AsyncFunction` that presents UI must end in `.runOnQueue(.main)`.** Expo runs async functions on `expo.modules.AsyncFunctionQueue`; `Utilities.currentViewController()` is MainActor-isolated and traps with SIGTRAP when called from there. Build 19 crashed on every export until the exporter moved to main.
- **Gesture callbacks are fatal if they throw.** With gesture-handler and NO Reanimated on the new architecture, `Gesture.Pan().onUpdate/.onEnd` are delivered synchronously from the native gesture; a JS exception inside them is `HermesRuntimeImpl::throwPendingError → __cxa_throw → abort`, not a red box. `AnimatedValue.setValue` throws on `undefined`, so never feed `e.translationX` straight in; coalesce, and add `.runOnJS(true)` (the home rail has always had it). The toast's swipe-to-dismiss lacked both and killed the app when a toast was tapped, since 2026-06.
- iOS has no exit-reason telemetry (`getLastExitReasons` is Android-only), so an iPhone crash leaves nothing in the App health report. Ask for the `.ips` from Settings → Privacy & Security → Analytics Data; the `exception.signal` and faulting thread name it in seconds (SIGABRT + hermesvm = JS throw made fatal; SIGTRAP + AsyncFunctionQueue = a Swift isolation assert).

**Where each export lives, and who it is for.** The customer downloads their OWN ledger from the bill link (`internal/shared/templates.go`, "Save as PDF"), which is the right channel — they already have it, and it needs no app. The in-app statement export is the SHOPKEEPER's copy, and it sits on the person screen, not the edit screen: exporting is a READ, and the edit pencil only renders when `canAmend`, so parking it there silently denied it to clerks and viewers who may read the ledger perfectly well.

**The bill page's Save-as-PDF uses the browser's own print pipeline** — no server-side PDF engine. Three things hold it up, all of which fail silently if removed: `print-color-adjust: exact` (browsers drop backgrounds, so the tinted direction chips and the balance print grey); a print rule that unwraps `.rnote` (notes are clipped to one line on screen with a "more" cue that print hides, so a clipped note loses what the entry was for); and the button forcing settled history OPEN before printing, because that history is a re-render rather than a CSS toggle — print CSS alone cannot reveal it, and a collapsed bill would print as a partial account, which the paper rule forbids. Preview it with `go test ./internal/shared/ -run TestWriteBillPreview -v -preview-out <dir>`; that test uses `html/template`, the same package the handler uses, because `text/template` emits `{{.Token}}` unquoted inside the script and previews a page that never ships.

### Store updates and announcements

App updates are delivered through Google Play and the App Store; the release
procedure is below. Check-in's historical update metadata remains readable for
older clients, but current update actions always open the platform's official
store. Announcements still use check-in and persist in `app_meta` for offline
display; see `docs/architecture.md`.

### Backend URL soft-migration (`migrate_to_backend_url`)

The mobile app's backend URL is **not** hard-baked into the APK in a way that locks you in. Resolution at runtime is: `app_meta.backend_url_override` (if set) → `EXPO_PUBLIC_BACKEND_URL` (build-time default from `apps/mobile/eas.json`). The override is populated by the backend itself:

- Backend has env var `MIGRATE_TO_BACKEND_URL`. When non-empty, every check-in response includes `migrate_to_backend_url: "<that value>"`.
- Mobile sees it on the response, calls `setAppMeta("backend_url_override", value)`, and the _next_ check-in goes to the new URL.
- Send `""` (empty string) to explicitly clear an existing override on clients. Omit the field (nil) to leave the client's current setting alone.

To change the backend's domain in production: deploy the new backend at the new URL, set `MIGRATE_TO_BACKEND_URL=https://new-host` on the _old_ backend's env in Dokploy, watch installs migrate, then tear down the old backend after a migration window. **No mobile rebuild required.**

### Env vars (one place per concern)

- **`apps/backend/.env.example`** — `POSTGRES_URL`, `BACKEND_PORT`, `MIGRATE_TO_BACKEND_URL` (optional, soft-migration), `GOOGLE_WEB_CLIENT_ID` (Google sign-in audience), `APPLE_CLIENT_ID` (Apple sign-in audience = iOS bundle id; compiled default `af.kaata.app`, must match `apps/mobile/app.json` `ios.bundleIdentifier`), `JWT_SECRET` (session JWTs; legacy alias `SESSION_JWT_SECRET`), `ADMIN_API_KEY` + `OPERATOR_*` (admin dashboard), plus optional share-link origins and mesh signing keys (full docs in the file).
- **`apps/mobile/.env.example`** — `EXPO_PUBLIC_BACKEND_URL` (first-launch fallback only; documented above), `EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID`, `EXPO_PUBLIC_SOLO_STORE_MODE`. Sign in with Apple needs **no mobile env var** — the audience is the bundle id configured in `app.json` (`ios.usesAppleSignIn: true` + the `expo-apple-authentication` plugin).
- **`apps/mobile/eas.json`** — `env` blocks on `preview` / `production` profiles set `EXPO_PUBLIC_BACKEND_URL` + `EXPO_PUBLIC_SOLO_STORE_MODE` at build time.
- **`apps/web/.env.example`** — `VITE_BACKEND_URL`, `VITE_WHATSAPP_CONTACT_URL`. All read from `apps/web/src/env.ts` with safe defaults.
- **`.env.production` at repo root** — Dokploy paste-source for all three services; per-app `.env.production` files mirror their slice.

### Phone is canonical identity

`apps/mobile/lib/phone.ts` normalizes national input using the selected country, or respects an explicit international prefix, to E.164. Afghan landlines and international contacts are supported; validation checks number shape, not reachability. Migration 007 removed the old global `users.phone_e164` UNIQUE constraint. `createPerson` / `updatePerson` check phone conflicts among active contacts within a vault and return discriminated results (`phone_invalid`, `phone_conflict`, `phone_is_self`). **Never silently replace a rejected phone number with NULL.** Archiving deliberately clears the phone only when no other active relationship still references that user. Save regressions, including Australian numbers and post-commit usage-counter failures, are covered by `cd apps/mobile && npm run selftest:person-save`. Usage counters are best effort and must never turn a committed contact or tally into a failed save. Unexpected contact-save diagnostics contain only an allowlisted code, stage, and timestamp in the local App health report; never store raw errors, phone numbers, names, or SQL there. Migration-001's legacy normalization counters remain separate and are sent at check-in.

### Device signing key: SecureStore seed + app_meta mirror must agree

Every local ledger write is Ed25519-signed inside `applyEvent` with the device key from `apps/mobile/lib/mesh/device-key.ts`. The private seed lives ONLY in expo-secure-store; the public key is mirrored in `app_meta.mesh_device_ed25519_pubkey` (inside `kaata.db`). **The two halves travel differently:** `plugins/withBackupRules.js` deliberately backs up `SQLite/` and excludes the SecureStore sharedprefs (Keystore-wrapped values cannot be decrypted on another device), so an Android phone that was restored from cloud backup, transferred device-to-device, or **uninstalled and reinstalled with Google backup on** boots with the mirror but no seed. Until 2026-09 nothing validated the pair: `ensureDeviceKey()` trusted the mirror, the sign call threw a plain Error mid-transaction, and every contact and tally failed with the generic "Couldn't save. Try again." forever (the cousin-in-Australia report, 2026-09-02). Do not tell such a user to reinstall; on Android that reproduces the state.

Rules that now hold, in priority order:

- **`ensureDeviceKey()` is the only cold path and it repairs.** No mirror → generate. Mirror + matching seed → warm. Mirror + seed for another pubkey → ADOPT the seed (convergent; never mints a third key after a half-landed repair). Mirror + missing/corrupt seed → generate and RETIRE the mirrored pubkey. A SecureStore read that THROWS does not repair (locked iOS keychain, Keystore hiccup); it surfaces as `DeviceKeyUnavailableError` — until it has thrown on three consecutive foreground launches/saves (`interactive: true` callers only; a Keystore blob that will never decrypt again), which is then treated as a lost seed. Concurrent cold callers share one in-flight promise; the transaction probe is re-taken around the app_meta write, and a transaction that slipped in leaves the caches cold so the next call converges through adopt.
- **Never repair inside a SQLite transaction.** `setAppMeta` is a bare statement on the shared connection and would join, and roll back with, whatever transaction is open. `ensureDeviceKey` refuses (`in_transaction`) when `isInTransactionSync()` is true; code that runs inside `applyEvent` or the sweep (role gate, `resolveAccountIdCandidates`) uses the read-only `readOwnDevicePubkeys()` / `isOwnDevicePubkey()` and never `ensureDeviceKey`. `applyEvent` takes a `getDeviceSigner()` snapshot BEFORE its transaction and signs with that snapshot only; `_layout.tsx` runs the check once at boot.
- **Retired pubkeys stay identity.** `app_meta.retired_device_pubkeys` feeds `buildLocalAccountId` candidates, the LOCAL trust-anchor carve-outs (role gate, transfer), and `reconcileVaultRegistrations`, so vaults and membership rows minted under the old key still resolve as "mine". REMOTE signature verification never consults it. `vaults.vault_trust_anchor_pubkey` is never rewritten, and `runGenesisBackfill` keeps its strict current-key compare on purpose (a genesis signed by the new key can never fold).
- **After a rotation:** `device_key_reregister_pending` makes the next check-in / sign-in re-POST the key (UPSERT by install_id); `device_key_rebind_pending` is expanded by `ensureChainBackfillAllVaults` into per-vault witnessed re-binds, which run only after the re-registration succeeded (the witness attests the server-registered key). Ordinary entry/person pushes are JWT-ACL'd server-side and work immediately. Known gap: a signed-in owner of a vault created before sign-in cannot re-bind through the witness (chain owner is the old sentinel); local writes and cloud sync still work, only mesh peers would quarantine.
- `npm run selftest:device-key` pins every branch above; `selftest:person-save` covers the "missing key → `EventSigningUnavailableError`, no rows" shape. The App health report prints a `Device key:` status line (never material).

### Calendar system (Gregorian vs Afghan Solar Hijri)

A **global** display preference in `app_meta.calendar_pref` = `'auto' | 'gregorian' | 'jalali'`, owned by `apps/mobile/lib/calendar.ts` (module global + listener set + `useCalendar()`, modeled on `lib/i18n.ts`'s locale machinery). `'auto'` is the default and resolves to Jalali when the app language is Persian — byte-identical to the pre-setting behaviour, so upgrading moves nobody's dates.

**Calendar and language are independent axes.** Calendar picks _which months exist_; language picks _how they are written_:

|             | English UI    | Persian UI    |
| ----------- | ------------- | ------------- |
| Gregorian   | `5 Aug 2026`  | `۵ اگست ۲۰۲۶` |
| Solar Hijri | `5 Asad 1405` | `۵ اسد ۱۴۰۵`  |

All four are day-first. Before this, one boolean drove both, so "Dari language, Gregorian dates" was inexpressible.

- **Month names are the AFGHAN zodiac set** (حمل … حوت), never the Iranian names ICU ships for `fa` (فروردین …). Same calendar, same arithmetic, different vocabulary — this is the single easiest thing to get wrong. Four tables live together in `lib/jalali.ts`.
- **Render-time only.** Every stored timestamp stays epoch ms — SQLite, event payloads, the sync wire, bill snapshots. A Jalali value written to any of them is a bug.
- **Bills freeze their calendar.** `lib/share.ts` writes `calendar` into the `/v1/shared` snapshot at issue time, because the paper rule (`apps/backend/internal/shared/service.go`) makes a bill the recipient's permanent asset and the recipient has no settings of ours. Snapshots predating the setting lack the field; `resolveCalendar` (Go) and the equivalent ternary in `CustomerView.tsx` fall back to deriving it from `locale`, which is what those bills were originally rendered with. Never resolve a bill's calendar against the viewer.
- **Four implementations must stay in lockstep** — `lib/jalali.ts`, `internal/shared/jalali.go`, the inline `fmtDate` in `internal/shared/templates.go` (the primary renderer in production), and `CustomerView.tsx`. A customer sees two of them side by side: the WhatsApp link preview and the page it opens. `npm run selftest:jalali` and Go's `TestBillDateGoldenVectors` pin the SAME vectors — add a case to one, add it to the other.
- **`toJalali` throws on a non-finite timestamp, deliberately.** `jalCal`'s range check is `jy < lo || jy >= hi`, and both comparisons are false for NaN, so a corrupt ms used to sail through and render the literal string `"NaN undefined NaN"` into a bill.

### Routing

Mobile uses `expo-router` (file-based). `apps/mobile/app/_layout.tsx` is the root: it wraps the Stack in `GestureHandlerRootView` → `SafeAreaProvider` → `ToastProvider` → `AppMetaProvider`, runs `initDb()` → `ensureInstallId()` → checks for `getLocalSelf()` to decide between `/onboarding` and `/`. Stack-modal screens are `person/new`, `person/[id]/edit`, `entry/new`, `entry/[id]/edit`; a regular push screen is `settings` (reachable by tapping the identity row in the home header). Any screen can read toast state via `useToast()` / `useToastOffset()`, app-meta via `useAppMeta()`.

### Mobile UI patterns (non-obvious from a file scan)

These are coordination patterns that recur across screens and bit us once each. Reuse the patterns; don't rediscover the failure modes.

- **Home is a 2×screen-width swipe rail, not a single list.** `apps/mobile/app/index.tsx` loads all people via `listAllPeople()`, memoizes into `collectPeople` and `payPeople`, renders both lists side-by-side inside an `Animated.View` with `transform: translateX`. A pan gesture follows the finger via `.onUpdate((e) => translateX.setValue(...))`, commits on release based on **velocity OR drag distance** (500 px/s flick OR 30% screen-width drag), springs back below threshold. Tab taps animate through the same spring path via `useEffect([direction])`. Soft haptic on commit via `expo-haptics`. Don't reintroduce per-direction fetching — both lists derive from one query.

- **Bottom-anchored UI lifts for toasts via `useToastOffset()`** (`apps/mobile/components/Toast.tsx`). The ping bar on `person/[id]` and the home FAB both subscribe to this hook, which returns an `Animated.Value` that springs to `-(VIEWPORT_BOTTOM_MARGIN + TOAST_HEIGHT_SINGLE - BUTTON_OFFSET_ABOVE_SAFE_AREA + LIFT_GAP)` when any toast is visible and back to 0 when the queue empties. **Two math constraints:**
  - The insets cancel between the toast viewport (`bottom: 24 + insets.bottom`) and the lifted UI (whose visible bottom should also sit `X + insets.bottom` above the screen). The lift constant therefore has **no `insets.bottom` term**; adding one stacks 24-34px of phantom gap on real devices.
  - Any new bottom-anchored UI must have its visible bottom at `BUTTON_OFFSET_ABOVE_SAFE_AREA` (currently 20px) above the safe area; otherwise the lift is wrong. See the long comment block on `useToastOffset`.

- **BottomSheet defers action callbacks by 220ms.** `apps/mobile/components/BottomSheet.tsx` wraps each action's `onPress` in `setTimeout(handler, EXIT_DURATION_MS)` so the sheet's `<Modal>` fully unmounts before any follow-up `router.push` to another modal screen. Without this, two native modals stack in the same frame on Android and the second one renders blank-but-tappable — touches go through to the React tree but layout/paint never runs. Symptom: user taps Edit → sees a white page, taps fields → keyboard appears, taps Save → save fires. If you build a new action that doesn't navigate, the delay is harmless.

- **Edit screens focus inputs via `ref + setTimeout(280ms)`, not `autoFocus`.** `autoFocus` on a TextInput inside a modally-presented screen fires before the modal's slide-in animation finishes — focus succeeds but the soft keyboard never opens (Android specifically). The pattern is `useEffect(() => { if (loaded && found) { const t = setTimeout(() => ref.current?.focus(), 280); return () => clearTimeout(t); } }, [loaded, found])`. Gate on whatever async load state your screen has, so it doesn't fire on a "not found" branch.

- **Text line heights go through `sansLineHeight()` / `monoLineHeight()` (`lib/fonts.ts`) — never a raw number below the font's natural height.** The whole app renders in Vazirmatn (English included — see fonts.ts for why), whose metrics are 1.5625em (JetBrains Mono: 1.32em). Android trims the excess via `includeFontPadding:false`, so tight boxes look right there; iOS has no trim and **clips the glyph tops** (English caps beheaded, Dari marks gone — first hit on the home header). The helpers keep the designed tight value on Android and floor iOS at the natural height. System-font text (no `fontFamily`) is exempt. When a fixed-height container encodes a text height (e.g. `TOAST_HEIGHT_SINGLE`), check the iOS floor still fits before changing either side.

- **Toasts and dialogs are fully custom — `Alert.alert` is banned.** `BottomSheet`, `ConfirmDialog`, and the toast viewport all use RN `<Modal>` purely as portal transport; the visible UI is BlurView + Animated + custom Pressables with kaata fonts. `Alert` is not imported anywhere in `apps/mobile/**`; new code should use `useToast()` for transient feedback and `ConfirmDialog` (with the optional `description` prop) for confirmations. Note: the toast viewport itself is **not** wrapped in `<Modal>` — it's a plain absolute-positioned View at the ToastProvider's level, because Modal's native Dialog window on Android blocks all touches passing through even with `pointerEvents="box-none"`. Trade-off: toasts won't render above stack-modal screens; in-modal errors are queued and surface when the user returns to the parent. If a screen needs in-modal error UI, use inline error text below the relevant input.

- **`archivePerson` nulls `users.phone_e164` in its transaction** (see Phone canonical identity above). Don't refactor it without preserving this.

- **Member attribution: colour identifies a PERSON in exactly one place, and only in shared kaatas.** `colors.memberTints` (six soft-tint + strong-ink pairs) is the app's only per-person palette; everything else in `lib/colors.ts` still means direction or danger. The rules that hold it together: no tint may sit near emerald (collect) or garnet (pay), because a green-ish chip on a ledger row that encodes give/receive in colour is a lie; the tint is derived from the account id with an FNV hash (`memberTintFor`) so two members' phones never disagree about who is what colour; and `app/person/[id].tsx` gates the whole thing on `useMembersCount(vaultId) > 1`, so a solo kaata never even runs the query. The collapsed tally row shows a 20px chip ONLY when someone other than you last touched that entry — 20px is the 15px mono amount's line box, so turning attribution on costs zero row height — and the words ("Added by X · edited by Y") appear only when the row is tapped open. `lib/attribution.ts` resolves the author from `event_log(relationship_id, target_id, actor_account_id)`, falling back to `vault_device_registry` when the actor is NULL (pre-sign-in events; the local `account_bound` applier is a deliberate no-op). Self-identity must be matched against the FULL `resolveAccountIdCandidates` set, never one id, or a user's own pre-sign-in and post-key-rotation tallies get painted as a stranger's. `npm run selftest:attribution` pins all of it.

- **App is locked to LTR via `I18nManager.allowRTL(false)` + `forceRTL(false)`** at the top of `apps/mobile/app/_layout.tsx`. The UI was designed LTR (kaata. wordmark left, chevrons right, ping bar bottom, swipe "left = next" semantic) and auto-RTL on Persian/Dari/Arabic/Urdu locales breaks it. Don't remove this until a proper RTL design pass ships (queued with Persian translations — see `docs/backlog.md`). On Android, applying the lock takes effect on the _next_ launch — the current launch on an already-RTL device stays RTL.

- **INVARIANT: "I gave" is always on the RIGHT, "I received" on the LEFT** (see `apps/mobile/app/person/[id].tsx`). This is cultural — the right hand is the giving hand. The ordering must survive any future RTL implementation; if you add I18nManager-driven row-reverse anywhere, the actions row needs to opt out. Comment is inline at the row.

- **INVARIANT: the add/find FAB stays on the RIGHT side of the home screen** (see `apps/mobile/app/index.tsx`). Same cultural reason as the give/receive row — actions originate from the right hand. The FAB is positioned with `right: 20` in `styles.fab`; under `I18nManager.swapLeftAndRightInRTL` this would auto-flip to the left. If full RTL is ever wired up, this FAB needs an explicit opt-out (e.g., hardcoded `position: "absolute"` + the right value via `I18nManager.isRTL`-aware logic that always lands on the right). Comment is inline at the JSX.

- **The home FAB's mark is a rounded square, not a "+" — don't "fix" it back** (2026-08-11, Matee). The button opens `person/new`, which is equally where you FIND an existing contact and where you ADD one; a plus named only the second half. It is drawn as a bordered `View` (`styles.fabMark`), **not** an Ionicons glyph, because the mark _is_ its proportions — `HOME_MARK_SIZE` (42% of the button) and a corner radius expressed as a **ratio** of the mark, so a resize can't silently degrade the squircle. The button itself stays a circle. Known cost, deliberately accepted: a rounded square carries no verb (and an outlined square in a filled circle is the mobile STOP idiom), so the meaning is carried entirely by two other things that must survive future edits — the FAB's `accessibilityLabel` (`personAdd.title`, "Add or find person") and the copy that used to say "the + button", which now names the button's **position** instead (`onboardingSuccess.body`, `guide.p2`, `home.empty.collect.subtitle`, en + fa). "Bottom right" is literally true in Persian too, because the app is locked LTR. The web mockup (`apps/web/src/components/PhoneMockups.tsx`) and the store-screenshot generators (`ic.homeMark` in `docs/store-assets/gen-screens.js`, shared with `gen-tablet10.js`) hand-redraw this mark and drift silently — nothing tests any of the four.

### Dev workflow quirks

- **Local Postgres only for dev.** `docker-compose.yml` exists at the repo root but is **production-only** and not used by `bun dev`. The `apps/backend/internal/db/db.go`'s `Open()` retries the Ping for 15 s, so it tolerates a slow-starting Postgres.
- **Phone testing via Expo Go**: `apps/mobile/.env.local` must set `EXPO_PUBLIC_BACKEND_URL=http://<LAN-IP>:8080`. `localhost` on the phone is the phone itself, not the dev machine. A VPN on either the phone or the dev box also breaks Metro's LAN connection — turn it off or use `npx expo start --tunnel`.
  - **Never statically import `expo-notifications` from a module that loads at startup.** Importing it runs `DevicePushTokenAutoRegistration.fx`, which registers a push-token listener at module scope, and since SDK 53 that **throws on Android in Expo Go** ("Android Push notifications … was removed from Expo Go"). `index.js` imports `lib/mesh/bg-notify.ts` before any UI exists, so a static import there was a red screen at boot for every Expo Go session — for a feature that posts purely LOCAL notifications and never requests a push token. It now loads the module lazily and skips the subscription entirely under `isRunningInExpoGo()`. Dev and store builds are unaffected.
  - The two local native modules (`modules/kaata-gatt-server`, `modules/kaata-bt-classic`) resolve their native side lazily inside `getNative()`, so importing them in Expo Go is safe and only a _call_ would throw. Keep it that way; a top-level `requireNativeModule` in either would break Expo Go the same way.
  - Expo Go still cannot provide those native modules, so anything touching Bluetooth, the GATT server, or the memory/exit probe degrades there. For full parity use a development build: `eas build --profile development --platform android` (the profile already sets `developmentClient: true`), install the APK, then `npx expo start --dev-client`. Same fast refresh, no missing natives.
- **EAS builds must run from `apps/mobile/`**, not the repo root. Running `eas build` from the root generates a bogus `@user/kaata-monorepo` project and uses a fresh keystore — existing installs cannot update without a full wipe. The saved keystore (`apps/mobile/eas.json` projectId `a612156b-…`) is irrecoverable if lost; never regenerate.
- **Prettier reformats files frequently** — quotes shift between `'` and `"` between sessions. Don't fight it; let the linter pass do its thing.

### Where future Claude should look first

- `docs/backlog.md` lists near-term deferred work. **The backup/restore item is no longer indefinitely deferred** — shopkeeper interviews validated it as the #1 ask; the next phase will likely ship either WhatsApp-share manual backup (cheap, no auth) or PIN-encrypted server backup (mid-cost, prepares for Phase 2 OTP). Persian-language translations are the #2 ask. Read backlog.md before building anything related.
- Multi-shop / vaults support is planned but not built — see `docs/phase-2-roadmap.md` "Multi-shop / vaults".
- `docs/refactor-notes.md` documents the v0 → v1 schema move (function signature changes, what stayed, what didn't).
- `docs/architecture.md` is the backend operations playbook — check-in compatibility, announcements, version comparison and force-update behavior.

### Release / deploy flow

Distribution is through Google Play for Android and the App Store for iOS.
Every release goes to TestFlight and Play closed testing first, gets checked on
both of Matee's phones, and is promoted only after explicit approval. Pushing
`main` automatically redeploys the backend and web in Dokploy. No release
database writes or repository tags are required.

1. **Bump native build identifiers** in `apps/mobile/app.json`:
   `android.versionCode` and `ios.buildNumber` must increase for each upload.
   Keep `version` unchanged when iterating on the same testing release.
   `appVersionSource` is `"local"`; no profile auto-increments. Order is
   bump → verify → commit/push when authorized → build, so artifacts match
   their source commit. Use the existing project, signing keys and store credentials.

   **`eas.json` takes NO comments.** It is strict JSON validated against a schema; any unknown key — including a `_comment` string — fails the build with `"eas.json is not valid"`. Document build/submit config decisions here instead.

2. **One build, both platforms, straight to the testing tracks** (must run from `apps/mobile/`; running from the repo root would create a bogus project with a fresh keystore — see Dev workflow quirks):

   ```
   eas build --profile production --platform all --auto-submit-with-profile testing --non-interactive
   ```

   Invoke the store scripts directly with `node`, as below. PowerShell/npm can
   consume flags such as `--status`; never use that ambiguous wrapper for read-only checks.
   Set `EXPO_APPLE_TEAM_ID=2JPK69B8Z2` for non-interactive credential validation.
   Check the log says `Using Keystore from configuration` (never `Creating`). The `testing` submit profile puts Android on the Play **closed testing** track (`alpha`; `internal` = Internal testing, `beta` = Open testing) and uploads iOS to TestFlight. Both use the same `production` BUILD profile; only the destination differs. A phone joins the closed test once via `https://play.google.com/apps/testing/af.kaata.app` (its Google account must be on the track's tester list), then Play offers the build as a normal update. Keep installed app data intact; do not uninstall to test updates.

3. **Promote Android** once the phones check out. `eas submit --profile production` is refused for a versionCode that is already on a track ("You've already submitted this version") — Play treats it as one release to promote, and EAS has no promote command. `apps/mobile/scripts/play-promote.mjs` is that button via the Edits API, run from `apps/mobile/`:

   ```
   node scripts/play-promote.mjs --dry-run          # shows what would move, discards the edit
   node scripts/play-promote.mjs                        # alpha -> production, 100%
   node scripts/play-promote.mjs --rollout 0.2       # staged rollout instead
   ```

   It reads the package + versionCode from `app.json` and authenticates with the SAME service account EAS Submit uses (`kaata-eas-deploy@…`), expected at `credentials/google-service-account.json` (gitignored; Matee keeps the original under Documents/Security/Kaata) or passed with `--key`. Release notes on the closed-testing release travel with it. Play still runs its own review before the production rollout goes live. The manual equivalent is Play Console → Testing → Closed testing → alpha → the release → Promote release → Production.

4. **iOS — actually submit for review.** ⚠️ **`eas submit` never submits an iOS build for App Store review.** EAS Submit implements binary _upload_ only; every iOS flag it has is TestFlight-only. The `submit.production.ios` and `submit.testing.ios` blocks are byte-identical for this reason, and the CLI's "✔ Submitted your app to App Store Connect!" means TestFlight. **It has already cost two releases — 1.0.7 and 1.0.8 were built, uploaded and committed, and never reached a single user.** The second half is `apps/mobile/scripts/asc-submit.mjs`, run from `apps/mobile/` once `--status` shows the build `VALID`:

   ```
   node scripts/asc-submit.mjs --status                                # what's live, what's stranded
   node scripts/asc-submit.mjs --notes-file notes.txt --dry-run        # preflight, no writes
   node scripts/asc-submit.mjs --notes-file notes.txt                  # create/reuse version, attach build, submit
   node scripts/asc-submit.mjs --notes-file notes.txt --supersede      # previous train still in review: cancel it first
   ```

   It reads version + buildNumber from `app.json` and the ASC API key from the `eas.json` submit profile. It creates the App Store version (ASC copies description, keywords, screenshots and review contact forward), attaches the matching build, writes "What's New", and submits; `--manual` holds at Pending Developer Release. `--status` lists any train that exists as a build but has no App Store version — the 1.0.7/1.0.8 failure, surfaced. **`--supersede`** is for the case that recurs when a fix lands while the previous version is still `WAITING_FOR_REVIEW`: ASC allows ONE non-live version per platform, so the script cancels that review submission, renames the version to `app.json`'s, waits for it to read editable (`DEVELOPER_REJECTED`; ASC is eventually consistent, so a plain re-run may be needed), then continues. Never rename a version Apple has already approved.

   Write "What's New" against the last version that **actually shipped** on that platform, not the last one built; `--status` shows which. Needs `credentials/AuthKey_*.p8`, which is **gitignored** — re-download it from App Store Connect → Users and Access → Integrations on a fresh clone.

5. **Verify delivery** in TestFlight and the Play testing track. Record build identifiers and submission status; upload completion is not production approval.

### Analytics queries (Postgres on production)

Admin activity charts and DAU both count distinct check-in installs, including read-only and signed-out use. Reporting rolls over at **midnight Asia/Kabul**, independent of the server/browser timezone. Migration 036 preserves earlier UTC daily history explicitly; do not reinterpret those date-only rows as Kabul timestamps or switch the chart back to synced ledger events. See `docs/admin-analytics.md` for the calendar cutover, shared reporting views, and regression checks.

Admin live updates reuse Go's existing `coder/websocket` dependency and a separate admin invalidation stream. Connect with a single-use 30-second ticket obtained through the existing Bearer-protected HTTP endpoint; never put the long-lived admin key in a WebSocket URL. Keep authenticated HTTP queries, 60-second polling, and the Kabul-midnight refresh authoritative. The in-process broker/ticket store assumes one backend replica; no Redis or new realtime service is required. See `docs/admin-analytics.md` for protocol and limits.

The `web_visits` (kind `'visit'` / `'download'`, with `source` + IP) and `installs` (`has_onboarded`, `usage_*`, `attribution_method`) tables hold the full funnel. Query via `docker exec -it kaata-database-<suffix> psql -U kaata -d kaata`. The `web_visits.ip` + 60-min window is how the backend stamps `installs.source` on first check-in (QR attribution); see `apps/backend/internal/checkin/service.go`.

### Notification inbox and customer actions (2026-09-25)

Migration 041 adds append-only party-scoped notification history independently of the
push delivery queue. Reads and mark-read re-check current JWT/party/vault membership;
read state belongs to the account, not the installation. Home's bell previews five
notices; /notifications pages through all history. History begins with this migration,
not fabricated from old tallies' latest statuses. There is no ledger rewrite.

Alert copy now includes the party label and signed tally amount/currency (recipient's
balance perspective); no notes, balance or invitation credential. This supersedes the
old generic-only policy. Keep Privacy.tsx and data-safety notes aligned.

Android notification masks must NOT reuse the opaque launcher icon. The code-native
notification-icon.svg is rendered to a 96×96 white/transparent PNG by
scripts/render-notification-icon.cjs; --check verifies the checked-in asset. A native
Android rebuild is required. Existing APNs/FCM review actions stay unchanged.

Person actions live at the bottom (received LEFT, gave RIGHT in both locales).
WhatsApp ping, export, edit and shared-account management live in the ellipsis bottom
sheet. SharedAccountBadge is a blue shared-account marker, not verified identity.
Phone display uses LRI/PDI, not forced RTL or FSI alone; never persist isolates.
