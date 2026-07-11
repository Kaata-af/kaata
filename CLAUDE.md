# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

@AGENTS.md

## Commands

- `bun dev` — backend (Go), web (Vite + React), mobile (Expo) running concurrently via `concurrently`. **Does not start Postgres** — a local Postgres on `:5432` is a prerequisite (see README "Prerequisites").
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

No test files exist in the repo yet.

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

### Update / announcement delivery without push

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

- **`apps/backend/.env.example`** — `POSTGRES_URL`, `BACKEND_PORT`, `MIGRATE_TO_BACKEND_URL` (optional, soft-migration), `APK_DOWNLOAD_URL` (target of `/v1/download` 302), `GOOGLE_WEB_CLIENT_ID` (Google sign-in audience), `APPLE_CLIENT_ID` (Apple sign-in audience = iOS bundle id; compiled default `af.kaata.app`, must match `apps/mobile/app.json` `ios.bundleIdentifier`), `JWT_SECRET` (session JWTs; legacy alias `SESSION_JWT_SECRET`), `ADMIN_API_KEY` + `OPERATOR_*` (admin dashboard), plus optional share-link origins and mesh signing keys (full docs in the file).
- **`apps/mobile/.env.example`** — `EXPO_PUBLIC_BACKEND_URL` (first-launch fallback only; documented above), `EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID`, `EXPO_PUBLIC_SOLO_STORE_MODE`. Sign in with Apple needs **no mobile env var** — the audience is the bundle id configured in `app.json` (`ios.usesAppleSignIn: true` + the `expo-apple-authentication` plugin).
- **`apps/mobile/eas.json`** — `env` blocks on `preview` / `production` profiles set `EXPO_PUBLIC_BACKEND_URL` + `EXPO_PUBLIC_SOLO_STORE_MODE` at build time.
- **`apps/web/.env.example`** — `VITE_BACKEND_URL`, `VITE_WHATSAPP_CONTACT_URL`, `VITE_APK_VERSION`, `VITE_APK_DOWNLOAD_URL`. All read from `apps/web/src/env.ts` with safe defaults.
- **`.env.production` at repo root** — Dokploy paste-source for all three services; per-app `.env.production` files mirror their slice.

### Phone is canonical identity

`apps/mobile/lib/phone.ts` normalizes any reasonable Afghan-mobile input to E.164 `+937XXXXXXXX`. `users.phone_e164` has a UNIQUE constraint. `createPerson` and `updatePerson` return discriminated `CreatePersonResult` / `UpdatePersonResult` unions so the search-or-create flow surfaces `phone_invalid` and `phone_conflict` errors with the conflicting user's name. **Do not add a code path that catches the constraint violation and silently writes NULL** — that's the v0-style behavior we explicitly moved away from. **One deliberate exception:** `archivePerson` nulls `users.phone_e164` inside the same transaction that sets `relationships.archived_at`, so the number is free for re-use when a shopkeeper later re-adds the same contact. Without this, removing Ahmad and re-adding him hits the UNIQUE constraint and is unfixable from the UI. Migration-001 records `phones_invalid_count` / `phones_conflict_count` to `app_meta` and the next check-in sends them as optional fields; the backend stores them on the `installs` row.

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

- **App is locked to LTR via `I18nManager.allowRTL(false)` + `forceRTL(false)`** at the top of `apps/mobile/app/_layout.tsx`. The UI was designed LTR (kaata. wordmark left, chevrons right, ping bar bottom, swipe "left = next" semantic) and auto-RTL on Persian/Dari/Arabic/Urdu locales breaks it. Don't remove this until a proper RTL design pass ships (queued with Persian translations — see `docs/backlog.md`). On Android, applying the lock takes effect on the _next_ launch — the current launch on an already-RTL device stays RTL.

- **INVARIANT: "I gave" is always on the RIGHT, "I received" on the LEFT** (see `apps/mobile/app/person/[id].tsx`). This is cultural — the right hand is the giving hand. The ordering must survive any future RTL implementation; if you add I18nManager-driven row-reverse anywhere, the actions row needs to opt out. Comment is inline at the row.

- **INVARIANT: the + (add) FAB stays on the RIGHT side of the home screen** (see `apps/mobile/app/index.tsx`). Same cultural reason as the give/receive row — actions originate from the right hand. The FAB is positioned with `right: 20` in `styles.fab`; under `I18nManager.swapLeftAndRightInRTL` this would auto-flip to the left. If full RTL is ever wired up, this FAB needs an explicit opt-out (e.g., hardcoded `position: "absolute"` + the right value via `I18nManager.isRTL`-aware logic that always lands on the right). Comment is inline at the JSX.

### Dev workflow quirks

- **Local Postgres only for dev.** `docker-compose.yml` exists at the repo root but is **production-only** and not used by `bun dev`. The `apps/backend/internal/db/db.go`'s `Open()` retries the Ping for 15 s, so it tolerates a slow-starting Postgres.
- **Phone testing via Expo Go**: `apps/mobile/.env.local` must set `EXPO_PUBLIC_BACKEND_URL=http://<LAN-IP>:8080`. `localhost` on the phone is the phone itself, not the dev machine.
- **EAS builds must run from `apps/mobile/`**, not the repo root. Running `eas build` from the root generates a bogus `@user/kaata-monorepo` project and uses a fresh keystore — existing installs cannot update without a full wipe. The saved keystore (`apps/mobile/eas.json` projectId `a612156b-…`) is irrecoverable if lost; never regenerate.
- **Prettier reformats files frequently** — quotes shift between `'` and `"` between sessions. Don't fight it; let the linter pass do its thing.

### Where future Claude should look first

- `docs/backlog.md` lists near-term deferred work. **The backup/restore item is no longer indefinitely deferred** — shopkeeper interviews validated it as the #1 ask; the next phase will likely ship either WhatsApp-share manual backup (cheap, no auth) or PIN-encrypted server backup (mid-cost, prepares for Phase 2 OTP). Persian-language translations are the #2 ask. Read backlog.md before building anything related.
- Multi-shop / vaults support is planned but not built — see `docs/phase-2-roadmap.md` "Multi-shop / vaults".
- `docs/refactor-notes.md` documents the v0 → v1 schema move (function signature changes, what stayed, what didn't).
- `docs/architecture.md` is the backend operations playbook — version comparison rules, release publishing SQL (`INSERT INTO app_releases`), force-update behavior.

### Release / deploy flow

**APK distribution is via GitHub Releases, NOT committed to the repo.** The APK now exceeds GitHub's 100 MB per-file git limit, so it CANNOT live in `apps/web/public/downloads/` (a push would be rejected). Release assets allow up to 2 GB; the web download button + the backend `/v1/download` 302 both point at the GitHub Release asset URL.

1. Bump **both** `version` AND `android.versionCode` in `apps/mobile/app.json` (e.g. `0.5.4`/`3` → `0.6.0`/`4`). versionCode MUST increase or the sideloaded APK won't install over the old one — the `preview` profile uses `appVersionSource: "local"` with **no** `autoIncrement` (only `production` auto-increments), so it's manual.
2. Build the APK from `apps/mobile/`: `bun apk --profile preview --local` (or `eas build --profile preview --platform android`) — **must be run from `apps/mobile/`** (see Dev workflow quirks). The `preview` profile points `EXPO_PUBLIC_BACKEND_URL` at `https://api.kaata.af`.
3. **Create a GitHub Release** at tag `v<version>` (tags are `v`-prefixed: `v0.5.1`, `v0.6.0`, …) and upload the artifact as the asset `kaata-<version>.apk`. Either `cd <repo> && gh release create v<version> <artifact>.apk --title "Kaata <version>" --notes "<notes>"` (gh creates the tag if absent), or the web UI ("Draft a new release" → pick/create the tag → upload). The stable asset URL is `https://github.com/Kaata-af/kaata/releases/download/v<version>/kaata-<version>.apk`. Do NOT add the APK to git.
4. In Dokploy, point both services at that asset URL: on `kaata-web` set build-args `VITE_APK_VERSION=<version>` AND `VITE_APK_DOWNLOAD_URL=https://github.com/Kaata-af/kaata/releases/download/v<version>/kaata-<version>.apk`; on `kaata-backend` set env `APK_DOWNLOAD_URL=https://github.com/Kaata-af/kaata/releases/download/v<version>/kaata-<version>.apk` and click **Redeploy** (env-only changes don't auto-trigger). Redeploy `kaata-web` too (build-arg change).
5. Commit + push the version bump (`apps/mobile/app.json`) and the `v<version>` tag. (No APK in the commit — it's a Release asset.)
6. Smoke test from outside any VPN:
   ```
   curl -sSL -o /dev/null -w "%{http_code}\n" https://github.com/Kaata-af/kaata/releases/download/v<version>/kaata-<version>.apk
   curl -sSL -o /dev/null -w "%{http_code} -> %{redirect_url}" https://api.kaata.af/v1/download
   ```
7. **`INSERT INTO app_releases`** via `docker exec -it kaata-database-<suffix> psql -U kaata -d kaata` so existing users see the UpdateBanner on next launch. Without this, only fresh downloads get the new version. The columns are `platform`, `version`, `min_supported_version`, `apk_url`, `play_store_url`, `release_notes` — there's **no `force_update` column**; force-update is computed at check-in time by comparing the client's version against `min_supported_version`. `apk_url` is the GitHub Release asset URL. For a non-forcing release, set `min_supported_version` to a version every existing install is at or above (e.g., `'0.1.0'`):
   ```sql
   INSERT INTO app_releases (platform, version, min_supported_version, apk_url, play_store_url, release_notes)
   VALUES ('android', '0.6.0', '0.1.0', 'https://github.com/Kaata-af/kaata/releases/download/v0.6.0/kaata-0.6.0.apk', NULL, 'Release notes here.');
   ```
   To force-update everyone below a version (only for critical fixes), set `min_supported_version` to that boundary.

### Analytics queries (Postgres on production)

The `web_visits` (kind `'visit'` / `'download'`, with `source` + IP) and `installs` (`has_onboarded`, `usage_*`, `attribution_method`) tables hold the full funnel. Query via `docker exec -it kaata-database-<suffix> psql -U kaata -d kaata`. The `web_visits.ip` + 60-min window is how the backend stamps `installs.source` on first check-in (QR attribution); see `apps/backend/internal/checkin/service.go`.
