# Admin activity and reporting calendar

The Overview activity chart and DAU count the same thing: distinct installs
that checked in, including signed-out users and people who only read a balance.
They do not count ledger events or signed-in accounts. Repeated check-ins count
once per bucket; configured operator accounts are excluded from both metrics.

DAU is the current calendar day. WAU and MAU are distinct installs over the
current day plus the preceding 6 or 29 days; daily counts must not be summed.
The daily chart and these KPIs are computed in one SQL statement so concurrent
check-ins cannot make today's chart point disagree with DAU.

## Midnight and historical data

New reporting days start at midnight in `Asia/Kabul` (19:30 UTC). Weekly buckets
start on Monday. This is independent of the PostgreSQL session timezone and the
operator's browser timezone. The web dashboard refreshes at that midnight, in
addition to its regular polling and refresh on return from a hidden tab.

Migration 036 preserves `install_active_days` as UTC history and introduces
`install_active_hours`, keyed by install and Kabul-aligned hour. A UTC-aligned
hour would straddle Kabul midnight and is unsuitable. Check-in writes both
sources in one statement; repeated writes OR the usage flag.

`analytics_calendar.kabul_since` records the cutover day. The `admin_active_days`
view uses legacy UTC dates before that day and Kabul dates thereafter.
`admin_install_dates` uses the corresponding calendar for historical cohort
comparisons. Stats and growth expose `activity_timezone_since`, and the dashboard
discloses the historical boundary. Never reinterpret old UTC dates as precise
Kabul activity: the old records did not retain check-in times.

For a mid-day rollout, the migration seeds today's latest known check-in per
install, requiring matching UTC activity evidence so auth-only install stubs
are not counted. This preserves today's distinct-device count. It cannot
reconstruct earlier hourly activity; hourly history before
`analytics_calendar.started_at` is incomplete. Existing ledger events are not
used to fabricate missing check-ins.

## Users and follow-up

The people directory combines one row per signed-in account with one row per
signed-out install. These rows are not DAU or unique-person counts: an account
can have several devices, and a person can have several signed-out installs.
Unidentified installs are hidden by default, with explicit counts and a toggle.

The report reads all account and install queries from one read-only,
repeatable-read snapshot. A verified `installs.account_id` takes precedence.
For legacy installs missing that column's value, exactly one distinct active
credential account provides a fallback (migration 006 populated credentials
without backfilling the install link). These devices appear under their account,
including their timeline and telemetry, rather than as a second offline row.
Ambiguous/revoked credentials, names, and self-reported phone numbers do not
establish account ownership. Reinstalls without a surviving verified link remain
separate; the report never rewrites identities or device activity history.

Search matches names, shops, email addresses, and phone numbers, including
Persian/Arabic digits. Filters combine sign-in status, onboarding, check-in
recency, platform, language, acquisition source, app version, reported entries,
contact availability, and an inclusive install-date range. The historical
UTC/Kabul cutover applies to both displayed install dates and date filters.

"Needs follow-up" means completed onboarding, last seen at least seven elapsed
days ago, and a phone number or email address available. It is a review list,
not a predicted churn score. "Active" uses the preceding seven elapsed days;
"Today" uses the Kabul calendar day. The DAU/WAU/MAU cards retain their separate
calendar-based definitions above. No messages are sent by these views.

Only filter/sort/page-size preferences are stored in sessionStorage. Search
text, expanded identities, and API results are not persisted there.

On phones, profiles render as expandable cards. The desktop table and cohort
grid scroll only inside their own containers. Keep the Users table scroll
container positioned (`relative`): its absolutely positioned screen-reader-only
column label otherwise escapes clipping and adds blank page width. Narrow-screen
checks should compare the document's scroll width with its client width, including
expanded filters/details and long unbroken profile text, rather than hiding page
overflow globally.

Mobile background check-in resolves the current install ID on every run, since
an explicit account-switch wipe can replace `app_meta` while the root stays
mounted. Checks around the request prevent a replaced install from applying its
response to the new profile. This client fix takes effect with the next mobile
release; deploying the admin report does not update installed mobile binaries.

## Live updates

The dashboard uses the existing Go `coder/websocket` dependency. PostgreSQL and
the authenticated HTTP queries remain authoritative. No additional service,
package, environment variable, or realtime database migration is required.

The browser requests `POST /v1/admin/live-ticket` with its usual Bearer admin
key, then connects to `/v1/admin/live?ticket=...`. Tickets are random, single-use,
and expire after 30 seconds. The long-lived admin key must never be put in the
WebSocket URL or subprotocol. Ticket and connection counts are bounded. The
admin endpoints remain disabled when `ADMIN_API_KEY` is unset.

Server frames are `{"t":"ready"}`, `{"t":"invalidate"}`, and `{"t":"ping"}`;
the browser replies with `{"t":"pong"}`. Frames contain no personal or ledger
data. The browser coalesces notifications, refetches after connecting, retries
with backoff, and closes its connection when signing out. The header displays
"Live updates" only after the server's ready frame. Ordinary 60-second polling,
manual refresh, and the Kabul-midnight refresh remain available.

Notifications follow successful relevant HTTP mutations (check-ins, visits,
account/auth, vault, sync, and share changes), plus GET downloads. They are
best-effort hints, not a durable changefeed. Background jobs, direct SQL edits,
and writes on another backend replica are covered by polling. Like the current
mobile live-sync broker, the ticket store and fanout live in a single backend
process. Multiple replicas would need a shared broker and ticket store (or an
appropriate routing strategy). Proxying uses the existing backend WebSocket
support; keep `/v1/admin/live` outside response-compression middleware.

## Regression checks

From `apps/backend`, run `go test ./internal/admin ./internal/checkin` with
`POSTGRES_TEST_URL` pointing at a disposable test database. The test harness
resets its schema and applies migrations; never point it at application data.
Tests cover local midnight, operator exclusion, repeated/anonymous check-ins,
calendar cutover, and PostgreSQL session timezone independence.

From `apps/web`, run
`node --experimental-strip-types --test src/pages/admin/dates.test.ts src/pages/admin/users-model.test.ts src/pages/admin/live.test.ts`,
`bun run typecheck`, and `bun run build`.

The backend live-channel tests exercise authentication, ticket expiry/replay,
fanout, heartbeat, disconnect/shutdown, and routing through the logging/CORS
middleware. Frontend transport tests cover reconnects, burst coalescing,
in-flight refreshes, cleanup, and polling fallback.
