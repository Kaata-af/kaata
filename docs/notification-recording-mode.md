# Notification-only shared tallies

New clients can create a linked account with `recording_mode: "notify"`.
The mode is immutable. Omitted mode and all existing accounts remain `review`;
this feature never reclassifies an old tally or rewrites a recorded review.

In notification-only accounts, ordinary new tallies use `status: "recorded"`.
They count immediately, without Accept/Reject or counterparty-review evidence.
`confirmed_balance` remains accepted-only. `recorded_balance` includes accepted
and recorded entries; `pending_balance` remains proposals awaiting resolution.
The legacy `balance` field retains its pending-inclusive meaning.

The carried opening remains pending until the invited party actually joins.
Binding an account for recovery does not substitute for that Join. Join records
the live opening in the same revision, without reviewer fields or an acceptance
event. A withdrawn opening stays withdrawn. A joined recorded opening is a fixed
carry-over marker: corrections use ordinary new tallies. This prevents cancellation
from silently zeroing the original private book.

The author can withdraw an ordinary recorded tally with a durable void audit.
Recorded entries already covered by a settlement or carried into a later live
recorded/accepted opening stay fixed. Source cancellation and authoritative
opening creation take canonical source locks, so a concurrent Join/Accept
cannot mutate archived source after carrying it forward. A pending replacement
proposal alone does not freeze an earlier recorded source. Existing review
decisions remain final. Notification-only Accept/Reject calls are refused, and the
invited party must complete Join before recording its own new tallies.

Notification-only openings retain the creator's complete same-currency source
revision receipt. Join checks it under those source locks before recording any
opening or binding the invited party. Changed sources, or missing provenance,
return `opening_source_changed` without changing the invitation or either balance.
The sender can cancel the unused link and send a fresh one. Review-mode openings
keep their existing explicit approval contract.

Unused invitations preserve private source entries. Own recorded tallies and own
withdrawal audit rows do not prove counterparty participation. Closing an unused
invite can withdraw its copied pending opening; ordinary recorded tallies remain.
Credit exposure, prior-period checkpoints, relinking and zero-balance settlement
include recorded money without inventing acceptance.

## Compatibility and deployment

Deploy the compatible backend and additive migration 069 before clients create
notification-only links. Migration 070 supplies notification preferences.
`GET /v1/sync/capabilities` reports `notification_only_tallies` and
`notification_preferences` only on the matching server implementation.

Clients send `X-Kaata-Tab-Recording: 1`. Without it, creating, discovering,
reading, joining or mutating notification-only accounts returns HTTP 426 with
`recording_upgrade_required`. Review accounts keep their existing behavior.
Authorization runs before compatibility checks, so outsiders still receive the
uniform 404. Invitation HTML discloses the recording mode without financial data.

New clients must probe feature support before using the corresponding feature;
an older server must never become a silent fallback that drops notification
privacy preferences or changes the intended recording contract. Once notify
accounts exist, keep a compatible backend serving them rather than rolling back
to an implementation that cannot enforce that contract.

Backend regressions use disposable PostgreSQL databases. They cover preservation
of existing review history, guarded old clients, author cancellation, immutable
openings and settled chapters, private-source recovery, Join/Close races,
mixed review/notify checkpoints, and clerk credit admission.

## Personal notification settings

Open Notifications from the profile or Account settings, or Notification settings
from a contact's menu. These choices belong to the current account on this phone;
they are not ledger events and do not change anybody else's preferences. Contact
overrides apply across that contact's currencies in the selected Kaata. Only
edited fields are overridden, so other choices continue inheriting app defaults.
The global master pause always wins over a contact exception.

Recommended app defaults allow new tally, review, cancellation, connection and
reminder alerts. Previews show names without amounts; shared foreground banners
and quiet hours start off. Sound and Android vibration start on. Review buttons
require full previews, an actual pending review-mode tally and current authority.
iOS vibration follows the phone's notification settings. New links explicitly
offer notification-only recording; existing links keep their original mode.

Quiet hours follow the phone's local IANA timezone, including overnight windows
and daylight-saving transitions. Scheduled reminders bypass quiet hours by
default; turning that exception off checks the actual alarm time, including
future one-offs. Muting cancels native alert requests without deleting tasks.
Unmuting does not replay missed alerts. Inbox history remains available.

Registration sends the effective personal policy to the authenticated installation
subscription. Both enqueue and delivery check it. Legacy registrations that omit
preferences preserve their existing policy. New clients unregister obsolete
full-detail subscriptions if the server does not advertise preference support,
rather than silently claiming privacy choices were applied. The app shows pending
sync when shared-alert preferences cannot yet be applied remotely. Presentation
and local fallback also check the current account, policy generation and access.
