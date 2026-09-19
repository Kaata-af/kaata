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

- **Backend (Go):** `cd apps/backend && go test ./...`. These run against a REAL Postgres — no mocks, because the schema, partial unique indexes and `ON CONFLICT` arbiters _are_ the behaviour under test. `internal/testutil.ConnectTestDB` resets `public` with `DROP SCHEMA` and replays the full migration chain, so it must NEVER be pointed at the dev database. It reads `POSTGRES_TEST_URL`, defaulting to `postgres://kaata:kaata@localhost:5432/kaata_test`; if that server is unreachable every DB-backed test SKIPS, so a green run means nothing until you check for `ok` vs `[no tests to run]`. The `kaata` role has no CREATEDB, so creating the database needs the superuser: `psql -h localhost -U postgres -c "CREATE DATABASE kaata_test OWNER kaata"`. Without the postgres password, the throwaway-cluster route works and touches nothing: `initdb -D <tmp> -U postgres --auth=trust`, `pg_ctl -D <tmp> -o "-p 55432" start`, create role + db there, then `POSTGRES_TEST_URL=postgres://kaata@localhost:55432/kaata_test go test ./...`, and `pg_ctl stop` after. Binaries live in `C:\Program Files\PostgreSQL\18\bin`.
- **Mobile:** `cd apps/mobile && npm run selftest:<name>` — `hlc`, `jalali`, `ingest`, `migration-014`, `money`, `person-save`, `device-key`, `attribution`. Plain Node scripts against the real modules, no test runner. `jalali` shares its vectors with Go's `TestBillDateGoldenVectors` — add a case to one, add it to the other.

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

### Update / announcement delivery without push

**Retired for releases (2026-08, store-only distribution):** store installs update through Play / the App Store, and no `app_releases` row is inserted any more when a version ships — see "Release / deploy flow". The mechanism below still exists in code (the `apk` channel, announcements) and is described for completeness.

Workflow for shipping an update:

1. `INSERT INTO app_releases (...)` on the backend with a higher version + `apk_url` (or `play_store_url`)
2. Next mobile check-in returns the row in the `update` block
3. Mobile persists `latest_known_version` etc. to `app_meta`
4. `UpdateBanner` renders from `app_meta` — survives offline; dismissed-version is also stored in `app_meta`

Same flow for `announcements`. To switch distribution channels (e.g. APK link → Play Store) just insert a new row with the URL in the new column. The full ops playbook is `docs/architecture.md`.

### Backend URL soft-migration (`migrate_to_backend_url`)

The mobile app's backend URL is **not** hard-baked into the APK in a way that locks you in. Resolution at runtime is: `app_meta.backend_url_override` (if set) → `EXPO_PUBLIC_BACKEND_URL` (build-time default from `apps/mobile/eas.json`). The override is populated by the backend itself:

- Backend has env var `MIGRATE_TO_BACKEND_URL`. When non-empty, every check-in response includes `migrate_to_backend_url: "<that value>"`.
- Mobile sees it on the response, calls `setAppMeta("backend_url_override", value)`, and the _next_ check-in goes to the new URL.
- Send `""` (empty string) to explicitly clear an existing override on clients. Omit the field (nil) to leave the client's current setting alone.

To change the backend's domain in production: deploy the new backend at the new URL, set `MIGRATE_TO_BACKEND_URL=https://new-host` on the _old_ backend's env in Dokploy, watch installs migrate, then tear down the old backend after a migration window. **No mobile rebuild required.**

### Env vars (one place per concern)

- **`apps/backend/.env.example`** — `POSTGRES_URL`, `BACKEND_PORT`, `MIGRATE_TO_BACKEND_URL` (optional, soft-migration), `APK_DOWNLOAD_URL` (the APK's canonical source; `/v1/download` serves it from a local disk cache with Range/resume support — see `internal/visit/apkcache.go` — and 302s to this URL only while the cache is cold; optional `APK_CACHE_DIR` overrides the cache location), `GOOGLE_WEB_CLIENT_ID` (Google sign-in audience), `APPLE_CLIENT_ID` (Apple sign-in audience = iOS bundle id; compiled default `af.kaata.app`, must match `apps/mobile/app.json` `ios.bundleIdentifier`), `JWT_SECRET` (session JWTs; legacy alias `SESSION_JWT_SECRET`), `ADMIN_API_KEY` + `OPERATOR_*` (admin dashboard), plus optional share-link origins and mesh signing keys (full docs in the file).
- **`apps/mobile/.env.example`** — `EXPO_PUBLIC_BACKEND_URL` (first-launch fallback only; documented above), `EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID`, `EXPO_PUBLIC_SOLO_STORE_MODE`. Sign in with Apple needs **no mobile env var** — the audience is the bundle id configured in `app.json` (`ios.usesAppleSignIn: true` + the `expo-apple-authentication` plugin).
- **`apps/mobile/eas.json`** — `env` blocks on `preview` / `production` profiles set `EXPO_PUBLIC_BACKEND_URL` + `EXPO_PUBLIC_SOLO_STORE_MODE` at build time.
- **`apps/web/.env.example`** — `VITE_BACKEND_URL`, `VITE_WHATSAPP_CONTACT_URL`, `VITE_APK_VERSION`, `VITE_APK_DOWNLOAD_URL`. All read from `apps/web/src/env.ts` with safe defaults.
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
- `docs/architecture.md` is the backend operations playbook — version comparison rules, release publishing SQL (`INSERT INTO app_releases`), force-update behavior.

### Release / deploy flow

Store-only since the Play listing went live (2026-08): Play Store for Android, App Store for iOS. The sideload APK, the GitHub Release asset, the Dokploy `APK_DOWNLOAD_URL` / `VITE_APK_*` args and the `INSERT INTO app_releases` update-banner rows are **retired** and no longer part of a release. (The code paths still exist for the `apk` channel; `docs/architecture.md` describes them for history.) Every release goes to the testing tracks first, gets checked on both of Matee's phones, and is promoted from there.

1. **Bump all three by hand** in `apps/mobile/app.json`: `version`, `android.versionCode` and `ios.buildNumber` (e.g. `1.1.0`/`36`/`16` → `1.1.1`/`37`/`17`). versionCode MUST increase and App Store Connect rejects a repeated buildNumber. **No profile auto-increments** — `appVersionSource` is `"local"`; `autoIncrement` was removed (2026-08-09) because EAS bumped at BUILD time and wrote `app.json` back, so the commit never matched the artifact. Order is bump → commit → build. Matee commits and tags himself; Claude edits, builds and submits.

   **`eas.json` takes NO comments.** It is strict JSON validated against a schema; any unknown key — including a `_comment` string — fails the build with `"eas.json is not valid"`. Document build/submit config decisions here instead.

2. **One build, both platforms, straight to the testing tracks** (must run from `apps/mobile/`; running from the repo root would create a bogus project with a fresh keystore — see Dev workflow quirks):

   ```
   eas build --profile production --platform all --auto-submit-with-profile testing --non-interactive
   ```

   Check the log says `Using Keystore from configuration` (never `Creating`). The `testing` submit profile puts Android on the Play **closed testing** track (`alpha`; `internal` = Internal testing, `beta` = Open testing) and uploads iOS to TestFlight. Both use the same `production` BUILD profile; only the destination differs. A phone joins the closed test once via `https://play.google.com/apps/testing/af.kaata.app` (its Google account must be on the track's tester list), then Play offers the build as a normal update; never sideload an APK over a Play install — different signing, it would wipe the ledger.

3. **Promote Android** once the phones check out. `eas submit --profile production` is refused for a versionCode that is already on a track ("You've already submitted this version") — Play treats it as one release to promote, and EAS has no promote command. `apps/mobile/scripts/play-promote.mjs` is that button via the Edits API, run from `apps/mobile/`:

   ```
   npm run promote:android -- --dry-run          # shows what would move, discards the edit
   npm run promote:android                        # alpha -> production, 100%
   npm run promote:android -- --rollout 0.2       # staged rollout instead
   ```

   It reads the package + versionCode from `app.json` and authenticates with the SAME service account EAS Submit uses (`kaata-eas-deploy@…`), expected at `credentials/google-service-account.json` (gitignored; Matee keeps the original under Documents/Security/Kaata) or passed with `--key`. Release notes on the closed-testing release travel with it. Play still runs its own review before the production rollout goes live. The manual equivalent is Play Console → Testing → Closed testing → alpha → the release → Promote release → Production.

4. **iOS — actually submit for review.** ⚠️ **`eas submit` never submits an iOS build for App Store review.** EAS Submit implements binary _upload_ only; every iOS flag it has is TestFlight-only. The `submit.production.ios` and `submit.testing.ios` blocks are byte-identical for this reason, and the CLI's "✔ Submitted your app to App Store Connect!" means TestFlight. **It has already cost two releases — 1.0.7 and 1.0.8 were built, uploaded and committed, and never reached a single user.** The second half is `apps/mobile/scripts/asc-submit.mjs`, run from `apps/mobile/` once `--status` shows the build `VALID`:

   ```
   npm run submit:ios -- --status                                # what's live, what's stranded
   npm run submit:ios -- --notes-file notes.txt --dry-run        # preflight, no writes
   npm run submit:ios -- --notes-file notes.txt                  # create/reuse version, attach build, submit
   npm run submit:ios -- --notes-file notes.txt --supersede      # previous train still in review: cancel it first
   ```

   It reads version + buildNumber from `app.json` and the ASC API key from the `eas.json` submit profile. It creates the App Store version (ASC copies description, keywords, screenshots and review contact forward), attaches the matching build, writes "What's New", and submits; `--manual` holds at Pending Developer Release. `--status` lists any train that exists as a build but has no App Store version — the 1.0.7/1.0.8 failure, surfaced. **`--supersede`** is for the case that recurs when a fix lands while the previous version is still `WAITING_FOR_REVIEW`: ASC allows ONE non-live version per platform, so the script cancels that review submission, renames the version to `app.json`'s, waits for it to read editable (`DEVELOPER_REJECTED`; ASC is eventually consistent, so a plain re-run may be needed), then continues. Never rename a version Apple has already approved.

   Write "What's New" against the last version that **actually shipped** on that platform, not the last one built; `--status` shows which. Needs `credentials/AuthKey_*.p8`, which is **gitignored** — re-download it from App Store Connect → Users and Access → Integrations on a fresh clone.

5. **Tag** `v<version>` on the bump commit and push it (Matee).

### Analytics queries (Postgres on production)

Admin activity charts and DAU both count distinct check-in installs, including read-only and signed-out use. Reporting rolls over at **midnight Asia/Kabul**, independent of the server/browser timezone. Migration 036 preserves earlier UTC daily history explicitly; do not reinterpret those date-only rows as Kabul timestamps or switch the chart back to synced ledger events. See `docs/admin-analytics.md` for the calendar cutover, shared reporting views, and regression checks.

Admin live updates reuse Go's existing `coder/websocket` dependency and a separate admin invalidation stream. Connect with a single-use 30-second ticket obtained through the existing Bearer-protected HTTP endpoint; never put the long-lived admin key in a WebSocket URL. Keep authenticated HTTP queries, 60-second polling, and the Kabul-midnight refresh authoritative. The in-process broker/ticket store assumes one backend replica; no Redis or new realtime service is required. See `docs/admin-analytics.md` for protocol and limits.

The `web_visits` (kind `'visit'` / `'download'`, with `source` + IP) and `installs` (`has_onboarded`, `usage_*`, `attribution_method`) tables hold the full funnel. Query via `docker exec -it kaata-database-<suffix> psql -U kaata -d kaata`. The `web_visits.ip` + 60-min window is how the backend stamps `installs.source` on first check-in (QR attribution); see `apps/backend/internal/checkin/service.go`.
