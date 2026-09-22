# Kaata Backlog

Concrete near-term work that isn't blocking the v0 launch but is known and
deliberately deferred. Distinct from `phase-2-roadmap.md` (long-term
architectural vision) — this is "stuff we'll build in the next few weeks
once we've watched real shopkeepers use the v0 APK."

---

## Mutual tab / shared account (Kaata 2.0)

**Status:** SHIPPED-IN-PROGRESS. Contract: `docs/mutual-tab-design.md` (normative —
every wire shape, table and signature). Backend `internal/tabs` + migration 037,
mobile `lib/tabs/*` + migration 028, the person-screen UI, the join deep link
(`kaata://t/<token>`) and the local notification are built. This entry is the
follow-up list, from §6 of that document plus what the build itself surfaced.
Remaining work is **ops and polish, not architecture** — do not redesign the model
here, change the design doc first.

**Must ship with the public feature:**

1. ~~**Close → purge.**~~ **Resolved 2026-09-22, no work needed.** Closing was
   reframed as a FREEZE, not a deletion (D8): a closed tab's rows stay, still count
   toward the contact's balance, and simply stop accepting writes — because reverting
   a contact to its pre-link local book would erase months of shared tallies AND put a
   months-old number on the home screen. `Privacy.tsx` now says exactly that, so there
   is no promise left to keep. A purge would need its own product decision (both
   parties' copies die together) before any cron.
2. **App Links / Universal Links** (§6.2). Today a tab link opens the web page and the
   page offers "Open in Kaata" (`kaata://t/<token>`; Android via
   `intent://…S.browser_fallback_url`). Verified https links need
   `android.intentFilters` + `/.well-known/assetlinks.json` (Play App Signing SHA-256
   from Play Console → App integrity), `ios.associatedDomains` + an AASA file (Team ID
   `2JPK69B8Z2`, and Caddy must serve it as `application/json`). Native rebuild.

**Next, in rough value order:**

3. **Push notifications** (§6.1). v1 is local-only: a phone learns about the other
   party's tallies when it pulls (foreground, poke, 60 s sweep), so a backgrounded
   phone can be minutes late and a killed one hears nothing until launch. Real push
   needs Matee to create the Firebase project on GCP `987359341353`, register
   `af.kaata.app`, drop `google-services.json` into `apps/mobile/`, upload an FCM V1
   service-account key and an APNs key via `eas credentials`. Then:
   `installs.expo_push_token` + registration on check-in, an `internal/push` Expo
   sender with a receipts sweep, `tab_parties.install_id` (already stored) as the
   target.
4. **Settlement handshake** (D17 v2). v1 only warns when both parties record the same
   amount in the same direction within 24 h ("Ahmad already recorded this"). A real
   two-tap settlement ritual — and a tab-level "we are square" marker, since a linked
   contact deliberately cannot use the local settle-up chapter — is the next honest
   step.
5. **Admin dashboard: tab counts** (§6.4). How many tabs exist, how many have a joined
   party b, how many tallies flow through them. Today the only way to know if anyone
   uses the feature is a manual `psql` count.
6. **Mesh gap.** A tab is server-only by design (D1) and transmits nothing over the
   nearby-phone mesh. Harmless while `MESH_PARKED=true`; decide what a tab means for an
   offline-first mesh before un-parking.

**Known rough edges (product calls, not bugs):**

- A signed-out phone keeps its party token in SQLite only, so a reinstall loses access
  to its tabs (D10 — documented). Signing in fixes it permanently via `GET /v1/tabs/mine`.
- The join screen's "New contact" form normalizes the phone against the install's
  default country (an explicit `+`/`00` prefix still wins). person/new's country picker
  is not reachable there; add it if a foreign counterparty ever shows up in feedback.
- A contact linked before it was ever settled can still show the "NOT SETTLED" chip at
  balance zero. Cosmetic, worth a look with real data.
- **Settle-up is permanently unavailable on a contact that has ever been linked**, even
  after the tab is closed. Chapters are a local-book ritual and a tab's rows are not
  partitionable by a line drawn before the tab existed; offering it would also mean two
  definitions of "the balance" (the header's, which is tab-aware, and
  `appendEntrySettled`'s preflight, which can only see local rows). Revisit only with a
  tab-aware preflight.
- **Re-linking a contact hides the PREVIOUS tab's rows.** Each new tab's opening entry
  carries the displayed balance forward, so the old tab's tallies are already inside it
  and counting them again would double the account — the read sites therefore resolve
  exactly one link. The arithmetic is right and pinned (`selftest:tabs` case 15), but
  the earlier shared period then has no surface in the app; it still exists on the
  server and at its `/t/` link. If re-linking turns out to be common, give it a second
  fold beside "Before linking" rather than changing the balance rule.
- **Party b cannot join onto a contact that already holds a tab, open or frozen**
  (`TabAlreadyLinkedError`). Party b mints no opening entry, so a second tab there would
  silently zero the frozen balance. Party a's re-link is fine and is the supported path.

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

**Status:** BUILT (2026-06). Operator dashboard at `admin.kaata.af` (also
`kaata.af/admin`): funnel, DAU/WAU/MAU, retention, language split, source
attribution, and a users drill-down (names/emails/kaatas/tally counts +
last-seen). Backend `GET /v1/admin/{stats,users}` gated by `ADMIN_API_KEY`
(routes 404 when unset); operator's own data filtered via `OPERATOR_ACCOUNT_IDS`.
Per-day activity from `install_active_days` + `installs.app_locale`. recharts,
code-split. The notes below are the original deferral rationale, kept for history.

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

## Bulk import / export (so people can do real accounting)

**Status:** deferred (validated 2026-06 — schema is accounting-grade; a few
prerequisites must land before the feature ships). Read this before building it.

**The core schema is sound — do NOT rebuild it:**

- Money keeps major-unit values in `entries.amount_afn`, including cents;
  arithmetic uses integer hundredths. Do not rescale historical values or
  rewrite signed events. See [decimal-amounts.md](decimal-amounts.md).
- Each entry already carries a real, editable **transaction date**
  (`occurred_at_ms` in the event payload) distinct from `created_at` — so
  importing historical rows can keep their true dates.
- Direction (`debt`=I gave / `payment`=I received), free-text note, soft-delete,
  and the immutable `event_log` audit trail are all present.

**Prerequisites to land BEFORE the import feature (cheap now, painful to
retrofit once real ledgers exist):**

1. **Deterministic import event_ids (BLOCKER, code not schema).** Events get
   random `event_id`s (`Crypto.randomUUID`, lib/event-log.ts) and dedup is by
   `event_id`, so re-running an import file (or a retry/double-tap) **silently
   doubles the ledger**. The import path MUST mint deterministic ids — UUIDv5
   over (vault_id + a stable per-row natural key) — so INSERT-OR-IGNORE makes
   re-import a true no-op. Also reuse-or-skip people by phone (createPerson
   already returns `phone_conflict`; import must not blindly append `person_added`).
2. **Per-entry currency.** `vaults.currency` is only a display label (no
   conversion). Append-only migration: `ALTER TABLE entries ADD COLUMN currency
TEXT` (nullable = vault default → existing rows untouched) + add to the
   entry_created/amended payload. Ship the column now even without a conversion
   engine, so mixed-currency import/export is lossless.
3. **Reference number / source id.** Append-only migration: `entries.reference_no
TEXT` (+ `source_external_id` for import provenance), both nullable + in the
   payload. Needed for reconciliation and to preserve a source system's IDs.

**Export** has no schema blocker — only single-person WhatsApp text share exists
today (lib/share.ts). Build a CSV export (avoid xlsx — no RN binary support):
query the projected entries, **sort by `occurred_at_ms`** (never `created_at`/HLC),
compute running balance per person app-side, write via expo-file-system + Share.
Add a paged query for large vaults (listEntries/listAllPeople load everything).

**Do NOT backdate the HLC** — `hlc_physical_ms` is the causal merge/ordering
clock, not the business date. `occurred_at_ms` is the authoritative transaction
date for all sorting, reports, and export.

**Deferred within this (not required for v1):** category/tag, opening-balance
entry type, partial/installment settlement (`entry_settled` is reserved). Add
nullable columns when interviews demand them.

Full analysis: the schema-import-export-fitness workflow (2026-06).

---

## Notes on what's NOT on this list

- Multi-shop / vaults → see `phase-2-roadmap.md` (different cadence, real
  architectural prep work).
- Customer-side mutual ledger → BUILT, see "Mutual tab / shared account" above and
  `docs/mutual-tab-design.md`. `phase-2-roadmap.md` described the ambition; the design
  doc is what shipped.
- `kaata.af/v/:token` customer-facing view → already stubbed at the route,
  to be built as part of Phase 1.5 (no backend dependency, can ship
  anytime).
