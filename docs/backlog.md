# Kaata Backlog

Concrete near-term work that isn't blocking the v0 launch but is known and
deliberately deferred. Distinct from `phase-2-roadmap.md` (long-term
architectural vision) — this is "stuff we'll build in the next few weeks
once we've watched real shopkeepers use the v0 APK."

---

## Manual export / restore (defense-in-depth for local data)

**Status:** deferred. Build after 3-5 real shopkeepers have used the v0 APK
for a week and we know what they actually want.

**Why we don't have it yet:** Android Auto Backup is enabled by default in
Expo SDK 54 (verified `android:allowBackup="true"` in prebuilt AndroidManifest)
and covers the majority case — a user with a Google account + standard
phone settings gets their SQLite ledger encrypted-backed-up to their own
Google Drive ~once a day, restored automatically on reinstall.

**Why we still need it eventually:**

- A meaningful slice of Afghan Android users don't have Google accounts or
  have backup disabled. For them, the auto-backup safety net doesn't exist.
- Auto-backup is opaque. A shopkeeper whose entire customer ledger is in
  this app can't _see_ whether their data is safe — they have to trust
  invisible cloud magic. A visible artifact (a file, a WhatsApp message
  to themselves) is more reassuring.
- Auto-backup has ~24h cadence and only runs on charger + WiFi + idle.
  Same-day data could be lost if the phone is destroyed before that night's
  backup window.

**Likely shape (subject to user feedback):**

- One screen, two buttons: "Export ledger" and "Restore from file."
- Export: dump the SQLite file (or a JSON snapshot — TBD based on what
  shopkeepers say they want) to phone storage. Offer to share via WhatsApp
  to themselves immediately.
- Import: file picker → confirm → replace local DB. Show entries count
  before/after to make the swap obvious.

**Why JSON might be better than raw SQLite:**

- Human-readable when opened. Shopkeeper sees "Ahmad: -1,250 AFN" and
  recognizes their book.
- Future-portable across schema versions if we ever break things.
- Smaller files for WhatsApp transmission.
- Tradeoff: importing requires schema-aware logic instead of a file copy.

**Hard decision needed before building:** PDF summary vs. machine-readable
backup. They serve different users. PDF = "I want a printout of my book
for my records." JSON/SQLite = "I want to be able to restore this onto a
new phone." Likely we want both; watch the shopkeepers and find out which
they ask for first.

---

## Manual source-tagging admin endpoint

**Status:** deferred. Build whenever the attribution gaps start mattering.

The deferred-deep-link attribution flow we shipped (`/v1/visit` →
`/v1/check-in` IP-match within 60 minutes) covers the case where someone
clicks a link on the kaata.af landing and installs from the same network
within an hour. It doesn't cover:

- Someone showing the APK to a shopkeeper in person, copying it via USB,
  bluetooth, or WhatsApp file-share. No web visit, no IP-match window, no
  attribution data.
- Long-tail installs where the browse-and-install gap is days, not minutes.

The fix is a small admin endpoint that lets us stamp a `source` onto an
install_id retroactively — e.g., when the user themselves tells us "I
gave Sultan the APK at the bazaar last Tuesday" we POST that fact and
fill in the column. Cheap to build (single authenticated route, single
UPDATE statement), but only worth it once we have ≥1 attribution gap
worth labeling.

---

## Admin dashboard

**Status:** deferred. Build whenever we want to _look_ at the data
without writing SQL by hand.

All the data we'd want to see is already being captured:
`installs.installed_at`, `last_seen_at`, `last_activity_at`,
`has_onboarded`, `usage_entries_created`, `usage_customers_added`,
`usage_shares_sent`, `source`, `attribution_method`,
`migration_001_phones_invalid` / `_conflict`.

For v0 launch, `psql` queries against Dokploy's managed Postgres are
sufficient. A real dashboard becomes worthwhile when we have ≥20
installs and `SELECT *` no longer fits on a screen.

Likely surface: a `/admin` route on the web app (behind a simple shared
secret / basic auth — auth is fine for the operator-only case), reading
from `VITE_BACKEND_URL` against a new admin endpoint group on the Go
backend.

---

## Notes on what's NOT on this list

- Multi-shop / vaults → see `phase-2-roadmap.md` (different cadence, real
  architectural prep work).
- Customer-side mutual ledger → see `phase-2-roadmap.md`, that's Phase 2.
- `kaata.af/v/:token` customer-facing view → already stubbed at the route,
  to be built as part of Phase 1.5 (no backend dependency, can ship
  anytime).
