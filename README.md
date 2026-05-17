# Kaata

Track customer credit (kaata / نسیه) for Afghan shopkeepers. The shopkeeper opens the app, adds a customer, records what they took on credit, marks payments as they come in — and that's it. No paper notebook to lose, no disputes about what's owed.

This monorepo contains:

- **`apps/mobile/`** — Expo React Native app. The shopkeeper's tool. v0 ledger is fully offline (SQLite); a single non-blocking phone-home on launch checks for updates and announcements.
- **`apps/backend/`** — Go API server. Single endpoint in v0: `POST /v1/check-in`. Records anonymous installs and serves update + announcement metadata.
- **`apps/web/`** — Next.js 15 landing page + APK download page (`/` and `/download`).
- **`docs/`** — Operations manual (release/announcement publishing, version comparison, force-update flow).

## Quickstart

### Prerequisites

A local Postgres running on `:5432` with a `kaata` user and `kaata` database matching the connection string in `apps/backend/.env.example` (default: `postgres://kaata:kaata_dev@localhost:5432/kaata?sslmode=disable`). One-time setup if you don't have one:

```sql
CREATE USER kaata WITH PASSWORD 'kaata_dev';
CREATE DATABASE kaata OWNER kaata;
```

The repo also ships a `docker-compose.yml`, but that's a **production-style** stack and is _not_ used by `bun dev` — local dev runs against your host Postgres so Docker Desktop doesn't have to be open.

### All three apps at once

```
bun dev
```

This runs the backend (Go), web (Next.js), and mobile (Expo) via `concurrently`. To run a single app instead, see below.

### Backend only

```
cd apps/backend
cp .env.example .env
go mod tidy
go run cmd/server/main.go
```

Smoke check:

```
curl http://localhost:8080/v1/health
```

### Web only

```
cd apps/web
bun install
bun dev
```

Visit http://localhost:3000

### Mobile only

```
cd apps/mobile
npm install
npx expo start --clear
```

Scan the QR with Expo Go. The default `BACKEND_URL` is `http://localhost:8080`. To test against your dev machine from a physical phone on the same Wi-Fi, override it with your LAN IP:

```
# apps/mobile/.env.local
EXPO_PUBLIC_BACKEND_URL=http://192.168.1.5:8080
```

## How the mobile → backend check-in works

On every launch, the mobile app:

1. Initializes SQLite, runs migrations.
2. Generates a UUID install ID on first run and stores it in `app_meta` (never changes).
3. Renders the UI immediately — the ledger is local-first and never blocks on the network.
4. In the background (5 s timeout), fires `POST /v1/check-in` with the install ID, app version, platform, and locale.
5. Stores returned update/announcement metadata in `app_meta` and shows a dismissible banner on the home screen.
6. If `force_update: true` comes back (client version below `min_supported_version`), redirects to a non-dismissible update-prompt screen.

See [docs/architecture.md](docs/architecture.md) for the full operations manual: how to publish a release, publish an announcement, the version comparison rules, and the force-update flow.

## Status

v0 — local-first ledger + minimal backend phone-home. Customer-view web page, sync, and analytics are deferred to v1.
