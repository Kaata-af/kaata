# Architecture & Operations

This documents Kaata's check-in compatibility and announcements. For the current store-testing and production workflow, see the release/deploy section in CLAUDE.md. Other backend modules, including cloud sync and mutual accounts, have their own design documents.

## Check-in protocol

The mobile app fires a single non-blocking request on every launch:

```
POST /v1/check-in
Content-Type: application/json

{
  "install_id": "uuid-string",
  "app_version": "0.1.0",
  "platform": "android",
  "device_locale": "en-US"
}
```

Response:

```
{
  "server_time": "2026-05-17T12:00:00Z",
  "latest_version": "0.2.0",
  "force_update": false,
  "update": {
    "version": "0.2.0",
    "apk_url": null,
    "play_store_url": "https://play.google.com/store/apps/details?id=af.kaata.app",
    "release_notes": "Bug fixes."
  },
  "announcement": {
    "id": 12,
    "title": "Kaata is now on Play Store!",
    "body": "Install from Play Store for automatic updates.",
    "cta_label": "Open Play Store",
    "cta_url": "https://play.google.com/store/apps/details?id=af.kaata.app"
  }
}
```

`update` and `announcement` are explicitly `null` when there's nothing to report.

## Server-side logic

The handler in `apps/backend/internal/checkin/`:

1. **Validate** — `install_id` must parse as a UUID. `app_version` and `platform` must be present.
2. **UPSERT install** — insert a new row in `installs` or, on conflict, update `last_seen_at`, `app_version`, `platform`, `device_locale`, and increment `check_in_count`.
3. **Look up the active release** — `SELECT * FROM app_releases WHERE platform = $1 AND is_active = TRUE ORDER BY published_at DESC LIMIT 1`.
4. **Compute response fields**:
   - `latest_version` ← `app_releases.version`, or echo the client's version when no release row exists.
   - `force_update` ← `client.app_version < app_releases.min_supported_version`.
   - `update` block ← present when `client.app_version < app_releases.version`; otherwise `null`.
5. **Pick an announcement** — iterate active, unexpired announcements in published_at DESC order; pick the first one whose `min_app_version`/`max_app_version` window (where set) covers the client. At most one is returned.

## Version comparison

Versions are dotted decimals like `"0.2.1"` or `"1.10.3"`. The backend (`cmpSemver` in `apps/backend/internal/checkin/service.go`) compares component-by-component as integers. Missing components default to 0; non-numeric suffixes in a component (e.g. `"0.2.1-rc1"`) are stripped before parsing.

This means `"0.10.0" > "0.2.0"` correctly (lexicographic comparison would invert). We do **not** parse pre-release tags — `"1.0.0-beta" == "1.0.0"` per this rule. If you need real semver semantics later, replace `cmpSemver` with a tested library.

## Store delivery

Build the production profile and submit to TestFlight and Play closed testing.
After two-phone testing and explicit approval, promote those same builds through
their stores. See CLAUDE.md for the EAS and store promotion commands.

Historical `app_releases` data and the check-in response shape remain for client
compatibility; they are not a publishing workflow. Current app update actions
always open the official store. Existing `/v1/download` links redirect to
`/download`, preserving the QR source parameter and analytics.

## Publishing an announcement

```sql
INSERT INTO announcements (
  title, body, cta_label, cta_url,
  min_app_version, max_app_version, expires_at
) VALUES (
  'Kaata is on Play Store!',
  'Install Kaata from the Play Store for automatic updates.',
  'Open Play Store',
  'https://play.google.com/store/apps/details?id=af.kaata.app',
  '0.1.0', NULL,
  NOW() + INTERVAL '60 days'
);
```

- Use `min_app_version` / `max_app_version` to target a specific range; leave NULL for unrestricted.
- The mobile client shows at most one announcement at a time (the most recent active match), but persists/dismisses by `id`, so cycling announcements works as expected.
- To pull an announcement before its `expires_at`, set `is_active = FALSE`.

## Force-update flow

- The blocking screen lives at `app/update-prompt.tsx` in the mobile app. It cannot be dismissed; the only action is "Install update," which opens the platform’s official store via `Linking.openURL`.
- `force_update` is held in memory only — never persisted to `app_meta`. An updated client that hasn't yet checked in will not be falsely locked out.
- Because the app is offline-capable, `force_update` cannot be enforced when there is no network. The next successful check-in re-enforces it.
- The Stack screen for `/update-prompt` has `gestureEnabled: false` and `headerShown: false`. Android hardware back closes the app rather than dismissing the screen, which is acceptable for v0 — the user simply cannot reach the rest of the app without installing.

## Mobile-side persistence model

The mobile app's local SQLite has an `app_meta` key-value table that holds:

- `install_id` — UUID generated on first launch
- `last_checkin_at` — unix ms of last successful check-in
- `latest_known_version`, `latest_known_apk_url`, `latest_known_play_store_url`, `latest_known_release_notes` — last update info we heard about (drives the banner offline)
- `latest_announcement_id`, `latest_announcement_title`, `latest_announcement_body`, `latest_announcement_cta_label`, `latest_announcement_cta_url` — last announcement we heard about
- `dismissed_update_version` — last version the user explicitly dismissed; banner stays hidden until a newer version arrives
- `dismissed_announcement_id` — last announcement id the user explicitly dismissed

## Historical v0 scope

Ledger data (shopkeeper, customers, entries) is **never** sent to the backend. Only the install ID, app version, platform, and locale leave the device. The backend has no schema for ledger data in v0.

## Admin dashboard (admin.kaata.af)

The operator analytics dashboard is **not a separate service**. It's the same
`kaata-web` bundle: the SPA checks `window.location.hostname` and, when the first
label is `admin`, renders the dashboard at `/` instead of the marketing site
(`IS_ADMIN_HOST` in `apps/web/src/App.tsx`). It reads `GET /v1/admin/{stats,users}`
on the **existing** backend (`api.kaata.af`, via `VITE_BACKEND_URL`). recharts is
code-split so it never ships in the public bundle, and `kaata.af/admin` is
retired — `/admin` on the public host is a 404.

**Backend gating.** The admin routes are wrapped in `AdminKeyMiddleware`
(`apps/backend/internal/httpx/admin_auth.go`): when `ADMIN_API_KEY` is unset the
whole group **404s** (no admin surface at all). When set, every request needs
`Authorization: Bearer <ADMIN_API_KEY>` (constant-time compared). `OPERATOR_ACCOUNT_IDS`
(CSV of `accounts.id`) filters your own accounts out of the aggregates;
`OPERATOR_IPS` (CSV) drops your own web visits. Anonymous installs (never signed
in) **cannot** be operator-filtered (no account, no stored IP).

**One-time setup:**

1. **Cloudflare DNS** — add an `admin` record mirroring whatever `kaata.af`/`www`
   points at. ⚠️ Set it to **DNS only (grey cloud)** first: Dokploy/Traefik issues
   the Let's Encrypt cert over an HTTP-01 challenge on `:80`, which the orange-cloud
   proxy intercepts. Once the cert issues, flip it back to **Proxied (orange)** to
   match `kaata.af`.
2. **Dokploy → `kaata-web` Application → Domains** — add `admin.kaata.af`, path `/`,
   same container port as the existing `kaata.af` entry, HTTPS on (Let's Encrypt).
   Then **redeploy `kaata-web`** so the latest admin code is built. No build-arg
   change needed (`VITE_BACKEND_URL=https://api.kaata.af` already set). **Do NOT**
   set `VITE_ADMIN_API_KEY` — it would bake the secret into the public JS. The
   dashboard uses a paste-once login (stored in the admin subdomain's `localStorage`).
3. **Dokploy → `kaata-backend` Application → Environment** — set
   `ADMIN_API_KEY=$(openssl rand -hex 32)` and
   `OPERATOR_ACCOUNT_IDS=<your account uuid>`, then **redeploy** (env-only changes
   don't auto-trigger). Look up your account id with:
   ```sql
   SELECT id, email, name FROM accounts WHERE LOWER(email) = LOWER('<your-google-email>');
   ```

**Verify:**

```
curl -s -o /dev/null -w "%{http_code}\n" https://api.kaata.af/v1/admin/stats               # expect 401 (or 404 if key unset)
curl -s -o /dev/null -w "%{http_code}\n" -H "Authorization: Bearer <KEY>" \
  "https://api.kaata.af/v1/admin/stats?bucket=day&points=30"                                # expect 200
```

Then open `https://admin.kaata.af`, paste the key once. The dashboard shows the
funnel, DAU/WAU/MAU, retention, language split, source attribution, a signed-in
users drill-down (identity + kaatas + tally counts + last-seen), and a "Not
signed in" table of anonymous installs (telemetry only — no name/phone, because
the ledger never leaves the device without sign-in + sync).

## Operational sanity checks

```sql
-- How many installs have phoned home today?
SELECT COUNT(*) FROM installs WHERE last_seen_at > NOW() - INTERVAL '24 hours';

-- Distribution of app versions in the wild
SELECT app_version, COUNT(*) FROM installs GROUP BY app_version ORDER BY 2 DESC;

-- Active announcements
SELECT id, title, min_app_version, max_app_version, expires_at
FROM announcements WHERE is_active = TRUE AND (expires_at IS NULL OR expires_at > NOW())
ORDER BY published_at DESC;
```
