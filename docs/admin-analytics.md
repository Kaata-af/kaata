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

## Users directory

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

"Active" uses the preceding seven elapsed days; "Today" uses the Kabul calendar
day. The DAU/WAU/MAU cards retain their separate calendar-based definitions
above. The Users directory is a reporting surface: it never shows tally
contents, and it sends nothing. Phone numbers, message templates and the
per-number contact log live in the Outreach section below.

The dashboard has no manual refresh control. Live invalidation over the admin
WebSocket, 60-second polling, refresh on return from a hidden tab, and the
Kabul-midnight invalidation keep every section current; the footer shows when
the numbers were generated.

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

## Outreach

The Outreach section (`apps/web/src/pages/admin/Outreach.tsx`, backend
`internal/admin/outreach.go`, migrations 044, 045 and 046) lists every phone number the
server knows, one row per normalized number, so the operator can message
people on WhatsApp by hand and record where each conversation stands.

Sources: shopkeeper numbers come from `installs.self_phone` and
`accounts.phone_e164`, aggregated per number (the latest install by
`last_seen_at` supplies platform, version, locale and source; counts and usage
are summed). Customer numbers come from the ledger events of every non-purged,
non-operator vault: the backend folds each vault's events into a
`sync.Projection` and reads each relationship's person and phone, so the list
never lags the way `vault_snapshots` can. A number found on both sides is one
row of kind `both`. Numbers are merged by their libphonenumber E.164 form when
that form is valid, so "+93 0700 000 001" and "+93 700 000 001" are one row,
one outreach history and one wa.me link; a number the plan rejects keeps its
plain `+digits` form. Outreach history recorded under a non-canonical key
before this merge is not re-keyed. Operator accounts, their installs and their
vaults are excluded. Customer numbers exist only for kaatas synced while
signed in.

Test data is excluded by source, never inferred: the operator presses
"Exclude book" or "Exclude owner" in the Books list, or "Exclude this book",
"Exclude this account" or "Exclude this install" in a row's details, which
writes one row to `outreach_exclusions` (kind + UUID + reason). An excluded
book drops only its own listing from each number, so a number that also
appears in a legitimate book stays, with that book's listing only; a number is
removed only when no source is left. An excluded book also leaves its owner's
aggregates (it no longer counts toward that shopkeeper's kaatas, people,
tallies, receivable and payable totals or last tally), and the supplier and
wholesaler flags of the numbers it listed are recomputed without it. An
excluded account drops the account's own number and every book it owns
(`vaults.owner_account_id`), the way `OPERATOR_ACCOUNT_IDS` does: each owned
book is dropped before the fold exactly like an excluded book (no listings, no
owner totals, not in the Books list); a book the account is merely a member of
stays. Its exclusion label is the account's name or email, followed by
" · owns 1 book" or " · owns N books" when it owns any (every non-purged book
it owns, whatever else excludes it); an account with neither a name nor an
email is named by the first eight characters of its id instead. An excluded
install drops only its own shopkeeper contribution: excluding
one of two installs, or an install whose account has its own phone, keeps the
shopkeeper side (the row's details say so under the install list); a `both`
number becomes a customer once no shopkeeper source is left. Nothing is
excluded because of a currency or a name.

The "Excluded sources" card opens with the Books list: every non-purged book
whose people feed the directory — not operator-owned, not excluded, and not
owned by an excluded account — from the GET's `books`. A row shows the book's
name, currency and an Archived pill; the owner's name, email and phone; when
the book was created; its numbers (distinct normalized phones among its
listings), people (non-archived relationships) and tallies; its last activity
(last tally); and two actions with the usual inline reason (default "test
data"): "Exclude book", and "Exclude owner", which removes the owner's own
number and every book they own (its open reason form says so in one line above
the input). The list searches book name, owner name, email and phone (the
directory's phone matching) and sorts ("Sort books by") by Numbers, Last
activity, Created, Owner or Name. Numbers is the default and is the server's
own order, kept exactly as received: most numbers, then the newest last tally,
then name and vault id compared byte-wise (so "Zebra" precedes "apple"); the
page never re-derives it, and every other sort breaks its ties by that server
order too. It shows 25 books a page, and its count line ("N books · M numbers")
counts a number once however many of the shown books list it. An exclusion
moves the book from the Books list to the exclusions list under it at once,
then refetches; until the refetched list has arrived the exclusion counts as a
write in flight, so every write control on the page stays disabled and a number
whose only source was just excluded cannot be opened, sent or relabelled from
the stale list. Every exclusion keeps its Undo, which confirms with "Included
again: <label>".

Fold rule: per relationship, `debt` adds and `payment` subtracts, deleted
entries are excluded, and amounts are integer hundredths. A positive balance
means the person owes the shop (role `customer`), negative means the shop owes
them (`supplier`), zero is `settled`. A wholesaler is a customer number listed
in two or more books or recorded as a supplier anywhere. `mention_count` counts
those books: distinct books, not listings, so a book that lists a number twice
(two people saved with one phone) counts once. The page calls it "Books
listing it" (sort), "Min books listing it" / "Books ≥ N" (filter) and `books`
(CSV column).
A listing whose relationship is bound to a mutual tab is flagged `linked`; its
balance is the vault's local fold only (the tab's rows are not folded), so the
page labels it "Shared account" instead of presenting it as the live balance.

Statuses are `new`, `sent`, `replied`, `interested`, `installed`, `declined`,
`do_not_contact`, `no_whatsapp` and `invalid`. Every open, send, reply, skip,
retry, status change and note edit is an append-only row in `outreach_touches`
(kinds `opened`, `sent`, `replied`, `skipped`, `retry`, `status`, `note`); the
page shows the latest 20 per number as a timeline. Follow-up due means status `sent`, contacted 48 hours ago or
more, no reply. Converted means an install with that number was first seen
after the contact. Both flags are computed server-side and read as-is by the
page; the client never re-derives them.

The prospecting views (All, Prospects, Shopkeepers, Customers, Wholesalers,
To contact) hide customer numbers that are archived in every book that lists
them; the tracking views (Awaiting outcome, Follow-ups due, Sent, Replied,
Interested, Installed, Declined, Unreachable) show them, so a conversation in progress never drops out of its queue. The
summary cards and the pipeline strip are counted client-side over the same
preset filters, so a card always equals the list it opens; only the "Today"
line comes from the server's touch counts, which include every touch recorded
since Kabul midnight, also for numbers whose source has been excluded since.

**Opened is not sent.** Opening a chat — a row's WhatsApp button, "Open
next", "Open chat again" or the second half of "Sent & next" — is always
recorded before the chat opens: the page creates the tab in the click, records
`opened` with the row's version, and points the tab at wa.me only after the
server accepted the record; a refused or failed record closes the tab. The
page has no wa.me links, only buttons, so a middle-click or "open in new tab"
cannot open an unrecorded chat. Copy message records `opened` too: the
clipboard write happens in the click, then `opened` is recorded the same way,
with the row's version, so a message pasted into WhatsApp by hand lands in the
strip like an opened chat; a copy the browser refuses records nothing, and a
copy whose record fails says so. `opened` sets `pending_since` and never
counts a message. A pending contact sits in the "Awaiting outcome" strip,
longest wait first, across every view and every reload, until the operator
records one outcome: Sent, Not on WhatsApp, Invalid number or Skip for now.
Skip for now is offered only for a first contact; any other pending row
(status not New, or a number already recorded as sent) offers "Close — nothing
sent" instead, which records the same skip with that reason. "Sent & next"
picks the next row of the current view before anything opens (an empty view
opens no tab), records Sent, then opens that row the same way; a failed save
never advances and never opens a chat.

Two paths count a message. The version-checked outcome `sent` (the strip's
Sent and Sent & next, or a row's Sent box) counts every message, first or
follow-up: every outcome carries `expected_version`,
`outreach_contacts.version` is bumped by every write, and a mismatch is 409
`stale outcome` with nothing written, so a double click, a retried request
after a lost response, or a second dashboard tab cannot count one message
twice. The page answers a 409 by refetching, never by retrying; a stale
version reads "Changed elsewhere — refreshed. Check the row and try again.",
since any write (a note, a language, a status from another tab) moves the
version, not only this outcome. Bulk "Mark
sent" (`mark` with `contacted: true`) records only a FIRST message: it counts
a row only if it is New, Not on WhatsApp or Invalid and was never recorded as
sent (`contact_count` 0), leaves every other row untouched and reports it as
skipped, so repeating it never counts anything twice. The row Sent box is
ticked whenever a send is on record and cannot be unticked; a further message
to the same number is recorded by opening the chat and pressing Sent in
"Awaiting outcome". The status menu relabels a row and never counts a
message; any status other than New ends the wait (clears "Awaiting outcome"
and a same-day skip), as does a reply, while New keeps it, so resetting a row
cannot silently drop a chat opened without an outcome. A `mark` that combines
`status` with `contacted: true` or `replied: true` is rejected whole (400
`invalid body`), so a status change is always its own request.

Declined and Do not contact refuse `opened`, `sent`, `no_whatsapp` and
`invalid` server-side (409 `contact stopped`, nothing written) until the
status changes; such a row shows "Stopped" instead of the WhatsApp button.
Skip always works, so a pending chat can always be closed. Not-on-WhatsApp
and Invalid rows offer only Retry. A stop is lifted only from the row's own
status menu, one row at a time: that request carries `lift_stop: true`. A
`mark` that would move a Declined or Do-not-contact row to any other status
without `lift_stop` leaves the row untouched and reports it as skipped, so a
bulk status action, which never sends the flag, cannot put a stopped number
back in the queue ("change them one at a time", the page says). Setting or
re-setting a stop always applies, and a reply or a note on a stopped row is
recorded without lifting it.

The prospect queue is the Prospects view, which a fresh tab opens on:
customer-only numbers (no install matched that number), status New, never
messaged, a valid number, a mobile number (the numbering plan's `mobile` or
`fixed_line_or_mobile`; a landline or an unknown type is not a prospect), not
archived everywhere, not awaiting an outcome, not skipped today, Afghanistan
unless the country filter says otherwise. Open
next and Prospects are first contact only, and "never messaged" is the
state's `never_messaged` flag, which the server computes over the whole
touch log (not the 20 touches the page shows): a number counts as never
messaged only if it was never recorded as sent and every chat ever opened for
it was resolved as nothing sent (Skip for now, Retry, Not on WhatsApp or
Invalid number). A chat still awaiting its outcome, or one that was opened and
then only relabelled (Interested, then New, say), counts as messaged, because
a message may have gone out; so does a number with any recorded send, even
after a reset to New. The "Messaged before" filter ("Never messaged" /
"Messaged or opened") shows the same split. Facing an older backend without
the flag, the page assumes messaged whenever a send, an open or a pending chat
is on record. Do-not-contact, declined, not-on-WhatsApp and invalid numbers
are never New, and excluded sources are gone server-side, so none of them can
be opened from the queue. "Skip for now" hides a number until the next Kabul
reporting day. `no_whatsapp` and `invalid` stay out until the operator
presses Retry, which puts the number back to New; the queue offers it again
only if it was never messaged, otherwise it is opened by hand. Retry is
refused (409 `not retryable`) for any other status.

Each preset opens in its own order. Prospects, Customers and Wholesalers sort
by last tally, newest first; a tie goes to the number more books list
(`mention_count`, distinct books, most first, in either direction), then to
the phone, and numbers with no tally at all come last. Every other view, and
the default one, sorts by last seen. Applying a preset — its tab, its summary
card, a `#outreach?view=` link, or the Prospects view a fresh tab opens on —
sets its filters and its sort; a sort picked afterwards holds until a preset
is applied again, and the highlighted tab still follows the filters alone. The
view's description under the search states its order ("Newest tally first.")
only while that order is the current sort. The
"Installed after contact" card applies the default order. The session-storage
key is `kaata_admin_outreach_filters_v3`, so a view stored before this order
existed is dropped rather than restored.

Message language. The session-wide choice is the outreach setting
`pref.message_lang` — `fa` (Dari), `en` (English) or `auto` (each shop's app
language) — picked in the Queue card and Dari when unset or unknown; the
backend stores it and never interprets it. A per-number choice,
`outreach_contacts.lang` (migration 046: `''`, `en` or `fa`, enforced by a
CHECK), set in a row's details, wins over it. For one number the message uses
its own `lang` when set, else the session's Dari or English, else (Auto) the
locale rule: Dari for a `fa` or `prs` locale (the shopkeeper's own install,
else the first listing owner's install), English otherwise. The template is
`template.<audience>.<lang>`, which is what `opened` and `sent` record. A
per-number choice is a `mark` with `lang`: it bumps the version like every
write but writes no touch (a preference, not an outreach event), and a
lang-only mark applies to a stopped row without lifting the stop. A `lang`
follows its row: whenever a mark skips a row — a `contacted` mark on a row that
is not sendable or was already messaged, or a status mark that would lift a
stop without `lift_stop` — the row keeps its `lang` too, a stopped row
included. The page toasts success only when the mark's answer carries the
requested `lang`; a backend from before migration 046 answers without it, and
the page says "Language not saved — the server is on an older version; reload
after the deploy."

An open chat keeps the language it was opened in. While a contact awaits an
outcome, `sent` — the strip's Sent, the row's Sent box, or the first half of
Sent & next — records the template key of the contact's newest `opened` touch,
not today's resolution, because the text prefilled in the WhatsApp tab is what
went out, whatever the session or the number's own language says by then. When
the newest `opened` touch names no template (or none is among the 20 touches
the page receives), Sent falls back to today's resolution and the strip shows
that language. The strip names the opened language ("opened in Dari") and adds
"· reopens in English" (or the reverse) when "Open chat again" would now use
the other; on a pending row the per-number select says the chat was opened in
that language and that a change applies to the next message.

The Queue card's next line, the "Awaiting outcome" strip, each row's WhatsApp
and Copy message buttons (a small "Dari" / "English" label before them, and
the language at the end of their accessible names) and a row's message preview
show which language the message will use, and the CSV carries the stored
`lang`. The page holds no language of its own, so every tab and device writes
the same message.

Number validity comes from libphonenumber's numbering-plan metadata
(`github.com/nyaruka/phonenumbers`, pinned in `go.mod`): every contact carries
`number.valid`, `possible`, `type` (mobile, fixed line, ...), `region` and the
national format. Open next skips invalid numbers; a row's WhatsApp button
stays as a manual override and warns that the plan calls the number invalid.
Validity says nothing about whether the number uses WhatsApp; that is the
`no_whatsapp` outcome, which only the operator can observe. Bumping the
library bumps the metadata.

Endpoints, all inside the admin-key group: `GET /v1/admin/outreach` (every
contact's `outreach` state carries `never_messaged` and `lang`; the result
carries `books`, never null, one row per book feeding the list with
`vault_id`, `name`, `currency`, `archived`, `created_at`, `owner_account_id`,
`owner_name`, `owner_email`, `owner_phone`, `member_count`, `people`,
`numbers`, `tallies` and `last_tally_at`, ordered by numbers, then last tally,
name and vault id; the page reads a missing `books` as empty and a missing
`lang` as `''`);
`POST /v1/admin/outreach/mark` with
`{phones[], status?, note?, contacted?, replied?, template_key?, lift_stop?, lang?}`
(phones only in the body, never in the path, up to 500 per call; absent fields
are left alone; `status` together with `contacted` or `replied` is 400
`invalid body`; `lang` other than `''`, `en` or `fa` is 400 `invalid lang`,
and the page sends it only for one number, from that row's language menu),
answering `{updated, skipped}`: `updated` is every requested
phone's current state in input order, `skipped` the phones the mark left
untouched (a `contacted` mark: not New, Not on WhatsApp or Invalid, or already
recorded as sent; a status mark: Declined or Do not contact without
`lift_stop`); `POST /v1/admin/outreach/outcome` with
`{phone, outcome, expected_version?, template_key?, reason?}` for ONE contact,
where outcome is `opened`, `sent`, `no_whatsapp`, `invalid`, `skip` or `retry`,
`expected_version` is required for everything but `opened` (the page sends it
with `opened` too), the answer is `{state}`, and a 409 is `stale outcome`,
`contact stopped` or `not retryable`; `POST /v1/admin/outreach/exclude` with
`{kind, id, excluded, reason?}` (kind `vault`, `account` or `install`, id a
UUID), answering the full `{exclusions}` list; `POST /v1/admin/outreach/setting`
with `{key, value}`, where an empty value deletes the row. Every POST triggers
the live invalidation so other open dashboards refresh; a 4xx does not. The
page gives every POST 20 seconds; with no answer by then it stops waiting,
says "No answer from the server in 20 s — refresh before trying again." and
never retries, since the write may still have landed (it refetches once the
request settles).

Settings keys: `template.shopkeeper.en|fa` and `template.customer.en|fa`
(placeholders `{name}`, `{shop}`, `{link}`; the link always ends up alone on
its own line), `slug.shopkeeper` (default `wa-shop`), `slug.customer` (default
`wa-cust`), `pref.message_lang` (`fa`, `en` or `auto`; Dari when unset). The
old `pref.auto_mark` key is retired: opening a chat never
marks it sent any more, so there is nothing to switch off. Message links are `https://kaata.af/download?s=<slug>`, so an
install that follows a message is attributed like a flyer scan: the slug is
stamped only when the install's first check-in comes from the same IP within
60 minutes of the visit. Someone who taps the link on mobile data and installs
later, or from another network, is not attributed; the `converted` flag
(install after contact) is the broader signal.

Only enum/number preferences are stored in sessionStorage; search text, phone
numbers, notes and the row selection are not, and neither is anything about
the message language, which lives on the server. The Books list's search,
order and page are not stored at all.

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
account/auth, vault, sync, and share changes, and the four outreach POSTs:
mark, outcome, exclude and setting), plus GET downloads. They are
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
`node --experimental-strip-types --test src/pages/admin/dates.test.ts src/pages/admin/users-model.test.ts src/pages/admin/outreach-model.test.ts src/pages/admin/live.test.ts`,
`bun run typecheck`, and `bun run build`.

The backend live-channel tests exercise authentication, ticket expiry/replay,
fanout, heartbeat, disconnect/shutdown, and routing through the logging/CORS
middleware. Frontend transport tests cover reconnects, burst coalescing,
in-flight refreshes, cleanup, and polling fallback.
