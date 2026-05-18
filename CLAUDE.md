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

No test files exist in the repo yet.

## Architecture

### Monorepo layout

`apps/{mobile,web,backend}` are deployable units. The Go backend is not part of any JS workspace — `bun dev` simply `cd`s into each app. There is no `packages/` directory because nothing is shared between the three apps yet.

### Mobile-first, backend is a thin phone-home

The mobile app is local-first: every ledger feature (customers, entries, balances, WhatsApp share) hits only SQLite. **Ledger data never leaves the device** in v0. The only network call is `POST /v1/check-in` on every launch, non-blocking, 5-second timeout — used solely to:

1. Record an anonymous install (UUID generated locally on first run, persisted in `app_meta.install_id` forever)
2. Receive update + announcement metadata for the banner

The check-in path lives in `apps/mobile/lib/api.ts` and `apps/mobile/app/_layout.tsx`'s `BackgroundCheckIn` component. The response is persisted to `app_meta` and consumed by `apps/mobile/components/UpdateBanner.tsx`. **`force_update` is held in memory only — never persisted** so an updated client cannot be falsely locked out by a stale flag.

### Two completely separate schemas

- **Mobile (SQLite)** — schema lives in `apps/mobile/lib/db.ts` as TypeScript-driven migrations. Has its own `schema_migrations` table. Migrations are async functions (`runMigration001`, `runMigration002`, …) gated by `hasRunMigration()`. **Migrations are append-only**: never modify a migration that's been applied — add a new `00X_…` migration that conditionally `ALTER`s.
- **Backend (Postgres)** — SQL files in `apps/backend/internal/db/migrations/`. `db.Migrate()` runs each `.sql` file once, tracked in its own `schema_migrations` table.

The two schemas have nothing in common. Ledger data lives only on mobile; the backend stores installs + releases + announcements only.

### "users + relationships" data model (mobile)

Post–migration-001, every entity — shopkeeper, customer, future supplier — is a `users` row. `relationships` rows bind two users with a `context` (`'customer' | 'supplier' | 'peer'`). `entries` reference `relationships`, not customers directly. This is the foundation for Phase 2 (mutual ledger / disputes / netting). Do not add a `customer_id` column on `entries` — that's the v0 model the migration is escaping from. View types `Customer` / `CustomerWithBalance` / `Shopkeeper` in `apps/mobile/lib/types.ts` keep v0-shaped field names so screens don't need to know about the underlying join.

### Update / announcement delivery without push

Workflow for shipping an update:

1. `INSERT INTO app_releases (...)` on the backend with a higher version + `apk_url` (or `play_store_url`)
2. Next mobile check-in returns the row in the `update` block
3. Mobile persists `latest_known_version` etc. to `app_meta`
4. `UpdateBanner` renders from `app_meta` — survives offline; dismissed-version is also stored in `app_meta`

Same flow for `announcements`. To switch distribution channels (e.g. APK link → Play Store) just insert a new row with the URL in the new column. The full ops playbook is `docs/architecture.md`.

### Phone is canonical identity

`apps/mobile/lib/phone.ts` normalizes any reasonable Afghan-mobile input to E.164 `+937XXXXXXXX`. `users.phone_e164` has a UNIQUE constraint. `createCustomer` and `updateCustomer` return discriminated `CreateCustomerResult` / `UpdateCustomerResult` unions so the new-customer screen surfaces `phone_invalid` and `phone_conflict` errors with the conflicting user's name. **Do not add a code path that catches the constraint violation and silently writes NULL** — that's the v0-style behavior we explicitly moved away from. Migration-001 records `phones_invalid_count` / `phones_conflict_count` to `app_meta` and the next check-in sends them as optional fields; the backend stores them on the `installs` row.

### Routing

Mobile uses `expo-router` (file-based). `apps/mobile/app/_layout.tsx` is the root: runs `initDb()` → `ensureInstallId()` → checks for a `getLocalSelf()` to decide between `/onboarding` and `/`. All screens render _inside_ the `AppMetaProvider` and the BackgroundCheckIn child, so any screen can read update/force-update state via `useAppMeta()`.

### Dev workflow quirks

- **Local Postgres only for dev.** `docker-compose.yml` exists at the repo root but is **production-only** and not used by `bun dev`. The `apps/backend/internal/db/db.go`'s `Open()` retries the Ping for 15 s, so it tolerates a slow-starting Postgres.
- **Phone testing via Expo Go**: `apps/mobile/.env.local` must set `EXPO_PUBLIC_BACKEND_URL=http://<LAN-IP>:8080`. `localhost` on the phone is the phone itself, not the dev machine.
- **Prettier reformats files frequently** — quotes shift between `'` and `"` between sessions. Don't fight it; let the linter pass do its thing.

### Where future Claude should look first

- Multi-shop / vaults support is planned but not built — see `docs/phase-2-roadmap.md` "Multi-shop / vaults" for the migration plan.
- `docs/refactor-notes.md` documents the v0 → v1 schema move (function signature changes, what stayed, what didn't).
- `docs/architecture.md` is the backend operations playbook — version comparison rules, release publishing SQL, force-update behavior.
