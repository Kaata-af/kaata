# Architecture & Operations

This is the operations manual for Kaata's v0 backend. The mobile app is offline-first; this doc covers everything that happens _server-side_ when the app phones home, and how to publish releases and announcements.

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
    "apk_url": "https://kaata.af/downloads/kaata-0.2.0.apk",
    "play_store_url": null,
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

## Publishing a new release

Insert into `app_releases`:

```sql
INSERT INTO app_releases (
  platform, version, min_supported_version,
  apk_url, play_store_url, release_notes, is_active
) VALUES (
  'android',
  '0.2.0',
  '0.1.0',
  'https://kaata.af/downloads/kaata-0.2.0.apk',
  NULL,
  'Adds WhatsApp share. Fixes balance calculation in detail view.',
  TRUE
);
```

Notes:

- `min_supported_version` is the floor: any client below it gets `force_update: true`. Bump it cautiously — it locks every install below that line out of the app.
- The backend picks the most recent active row. To roll back a bad release, set `is_active = FALSE` on it; the previous active row becomes current.
- Prefer inserting new rows over updating old ones — `app_releases` doubles as the audit log of every published version.

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

- The blocking screen lives at `app/update-prompt.tsx` in the mobile app. It cannot be dismissed; the only action is "Install update," which opens the APK URL (or Play Store URL if `apk_url` is null) via `Linking.openURL`.
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

## v0 scope reminder

Ledger data (shopkeeper, customers, entries) is **never** sent to the backend. Only the install ID, app version, platform, and locale leave the device. The backend has no schema for ledger data in v0.

## Operational sanity checks

```sql
-- How many installs have phoned home today?
SELECT COUNT(*) FROM installs WHERE last_seen_at > NOW() - INTERVAL '24 hours';

-- Distribution of app versions in the wild
SELECT app_version, COUNT(*) FROM installs GROUP BY app_version ORDER BY 2 DESC;

-- Current active release per platform
SELECT platform, version, min_supported_version, published_at
FROM app_releases WHERE is_active = TRUE
ORDER BY platform, published_at DESC;

-- Active announcements
SELECT id, title, min_app_version, max_app_version, expires_at
FROM announcements WHERE is_active = TRUE AND (expires_at IS NULL OR expires_at > NOW())
ORDER BY published_at DESC;
```
