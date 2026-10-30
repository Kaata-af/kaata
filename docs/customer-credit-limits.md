# Customer credit limits and staff permissions

Backend migrations must ship before a mobile build that uses their endpoints.
The original independent limits use backend migrations 062/063 and additive
mobile migration 040. Combined advisory alerts add backend migrations 073/074
and additive mobile migration 049. Existing signed role values and money
history stay compatible.

## Roles and authority

The stored `manager` role is displayed as **Admin**. Owners appoint admins.
Admins manage day-to-day work, credit limits, and staff below admin. An admin
cannot manage the owner or another admin. Archiving and ownership transfer
remain owner-only. Editors amend history; clerks only add new entries and
people; viewers read. Arbitrary reusable custom roles are not introduced.

Owner and admin may set a credit exception for a lower-ranked member:

- `inherit`: follow the customer policy and the member's role.
- `enforce`: obey every hard policy, including an editor under a clerks-only
  policy.
- `bypass`: allow that member to exceed hard limits.

Owners and admins always remain exempt from hard limits. A warn-only policy
always stays warning-only, including for a member with `enforce`.

Overrides are online server configuration, separate from signed membership
history. GET `/v1/vaults/{vault_id}/credit-permissions` returns accepted active
members and their current exceptions. PUT
`/v1/vaults/{vault_id}/members/{account_id}/credit-permission` accepts
`credit_limit_override`. The server rechecks active caller/target authority
under the shared admission lock. The row binds to the membership seat, so
removing and re-inviting someone does not retain a former exemption. A local
sentinel identity must sign in and sync before enforcement can be configured.

## Customer policy

Each customer relationship has two optional amounts for each currency:
maximum **they owe us** and maximum **we owe them**. Storage uses exact integer
hundredths. Blank means unlimited; zero forbids new exposure in that direction.
A customer's own policy wins over the kaata-wide default, including an explicit
warn-only policy. The default covers future customers and re-added contacts.
Currencies remain independent: an AFN limit never governs or converts a USD
balance. The Kaata default can also specify different limits and restriction
modes for every currency.

The credit-settings screen has a searchable currency selector when more than
one currency is available. It includes enabled currencies, ledger history, and
currencies with customer/default rules, so disabling a currency does not hide
its existing limit. Each currency keeps its own draft while switching. Save
applies only to the displayed currency and stays on a multi-currency form;
leaving with unsaved drafts requires confirmation. Customer settings display
the current exposure and remaining credit separately for each direction, using
the same pending-inclusive balance reader as enforcement. An inherited rule is
shown with its real values; saving it creates a customer-specific override for
that currency. Blank caps create an explicit unlimited override, not a reset to
inheritance. Independent limits do not have a policy-delete/reset API.

## Combined advisory alerts

The **Combined credit alerts** option within credit settings opens a separate
rule editor for a customer or Kaata defaults. An alert policy is an OR of up to
20 groups. A group contains 1–20 AND conditions, each using a distinct currency,
a positive exact threshold in integer hundredths, and one direction (`collect`
or `pay`). Alert comparisons are inclusive (`>=`), unlike the existing hard
admission check (`>`). These advisory rules never block recording, alter hard
caps, or convert/net money between currencies.

For example, four alternative collect rules can be:

- USD >= 10,000
- AFN >= 200,000
- USD >= 5,000 **AND** AFN >= 100,000
- USD >= 8,000 **AND** AFN >= 80,000

Each customer inherits the Kaata default independently, rather than pooling
customers' exposure. An own policy wins, including explicit `groups: []` (off).
**Use Kaata defaults** removes the customer override. Historical rule currencies
remain editable even if no longer enabled for new tallies. Amount edits keep
coherent drafts, and leaving unsaved changes requires confirmation. Owners and
admins can configure alerts; other roles see disabled controls. Live tally
warnings also apply to staff and use full before/after currency vectors,
including denomination-moving edits and pending shared exposure.

GET/PUT `/v1/sync/credit-alerts?vault_id=...` reads/saves policies; DELETE with
`relationship_id=...` restores inheritance. The zero relationship sentinel
addresses Kaata defaults. Snapshot `credit_alerts` is additive: an older server
omitting it cannot clear the new cache. Pending local rules upload before
refresh; reset/removal tombstones prevent stale snapshots from resurrecting
overrides. Configuration has its own authority lock and does not change signed
financial history or the older credit-limit endpoint.
Policy saves and resets use a monotonic per-vault server revision, including a
deletion watermark. Client wall-clock skew cannot pin a deleted override or
allow an older snapshot to restore it. Deliberate snapshot restore suspends
alert observation across the seed and replay tail, then starts a quiet baseline.

### Alert episodes and delivery

Owner/admin installations receive alerts according to global/customer
notification preferences, quiet hours, foreground preference, sound/vibration,
and OS permission. **Credit limit alerts** is its own notification category.
Only an intentional nonempty rule save may request OS permission; startup does
not prompt. A first observation or changed rule establishes a quiet baseline.
Each direction notifies on a clear-to-matched crossing, then stays latched
until the entire OR in that direction clears. Group order and save timestamps
do not reset a semantically unchanged rule. Unknown shared history is never
treated as zero and never rearms an alert. Muted/denied crossings are consumed,
so enabling notifications does not replay old debt.

Local-only/pending rules use a durable device/account-scoped observation latch.
Synced rules use server delivery once that installation confirms remote
registration; this avoids issuing two native alerts for one crossing. Account,
installation, current accepted owner/admin seat, archived customer/vault, and
current policy are checked before delivery or navigation. An old account's
notification cannot open its data under a new session.

The server uses the existing opt-in Expo push transport and scans subscribed
vaults about every 15 seconds under the same credit lock used by admission.
Remote delivery requires the existing `TAB_PUSH_ENABLED=true` setting and the
app's native push credentials. Registrations renew on foreground/settings
changes; confirmed server ownership lasts for its 30-day subscription lease.
Background registration never holds up local ledger observation. Ordinary
customers inherit global notification preferences without a repeated payload;
only personal exceptions are registered individually.
Delivery jobs are durable and retried; the external provider call runs after
the database locks are released, so a slow push service cannot block tallies.
This observes committed balances at scan
time; a threshold crossed and fully reversed between scans can go unobserved.
No every-mutation notification guarantee is made. The provider receives generic
localized text and only `kind: credit_alert` plus a random opaque `event_key`.
Customer names, amounts, currencies, ledger IDs, account IDs, and policy details
stay on the server. An authenticated installation-bound event endpoint resolves
the customer privately when the notification is opened, refreshing the phone's
target customer/rules when needed. Tests use a local fake
push provider and isolated databases, never real customer notifications.

The screen offers three choices:

- Warn only: show near/over-limit status and live amount warnings without
  restricting recording.
- Restrict clerks: hard limits apply to clerks unless an individual exception
  changes that rule.
- Restrict editors and clerks: the same hard limits also cover editors.

The wire/storage mode remains `warn | clerk_block`; the additive boolean
`restrict_editors` widens the hard policy to editors. Missing means false on
older policies. A legacy PUT omitting the field preserves its saved value,
preventing an older app from silently weakening an editor restriction.

Warning status is separate from money direction: near-limit and over-limit
badges use the existing amber/red status language. Repayments remain allowed
above a cap. Crossing through zero checks the cap in the opposite direction.
Limits govern exposure increases rather than an invariant that privileged
staff can never move the balance above a cap.

## Enforcement and offline behavior

The server is authoritative. Admission identifies the actual authenticated
author (and a bound shared-account member), never a relaying account or a
claimed wire identity. Existing lawful-at-event-HLC role checks remain in force.
Current member exceptions are read from the active membership seat.

Private creates, monetary amendments, and deletions are checked using their
actual projected before/after exposure, including LWW and sticky deletions.
Shared appends, disputes, voids, and binding/link-period changes use the same
admission lock. Pending shared entries already count, so acceptance has zero
exposure delta. Safe unchanged bindings and exposure reductions remain allowed.
Sorted entry locks precede the kaata admission lock; policy and override writes
serialize with financial admission.

Staff continue to record offline for unlimited/warn-only customers. A known
hard policy covering that member holds new financial changes as durable intents
until HTTPS acknowledgement. Private edits/deletions leave the original tally
unchanged while waiting. Restricted shared review/cancel operations likewise
queue without changing recorded money. Pending and refused operations remain
visible after restart; duplicate pending gestures do not queue twice. Mesh
receipt does not authorize money, and relaxing a policy does not apply an
already deferred attempt early.

A hard rule set elsewhere may not yet be cached. If the server refuses an
optimistic change, its event ID stays refused even after promotion or a cap
increase. The phone restores the entry from lawful history. Snapshot-seeded
entries may lack their original creation event, so unacknowledged amendments
and deletions retain local before-images in `credit_mutation_baselines`.
Recovery uses the earliest retained image and surviving applied evidence,
preserving independent notes, field clocks, review flags, and sequential
refusal behavior. Missing historical evidence from pre-upgrade clients never
justifies deleting a snapshot entry blindly.

New-tally refusals are visible to owner/admin in the existing last-30-days
refusal feed. Refused edits/deletions are terminal and visible to the staff
member, but are omitted from that feed rather than described as new loans.

## Persistence and rollout

Customer/default caches retain `restrict_editors`; server snapshots include it.
Member exceptions refresh with normal credit sync and while the members screen
is open. Failed/missing endpoints do not clear cached exceptions or claim a
successful save. Cache writes serialize and use session guards. Local full
SQLite backups include the additive tables; cloud restore refreshes current
server configuration separately from the age of ledger snapshots.

Deploy backend migrations 062/063 and server first, then update participating
staff apps and sync enrollment before enabling editor restrictions. Older apps
remain subject to server refusal but can temporarily show their earlier
optimistic UI and lack the new before-image recovery. No mandatory version
floor is added by this feature. Hard-mode saves require sign-in and online
confirmation; an older backend cannot falsely acknowledge an unsupported save.

Focused regression suites use real in-memory SQLite, shipped migration DDL,
and an isolated localhost PostgreSQL cluster. They cover authority, seat
lifecycle, editor/member exceptions, exact directional caps, repayments,
concurrency, terminal retries, snapshot recovery, signed-out/remote identity,
pending shared operations, and cache/session boundaries. Physical-phone,
airplane-mode, two-device enrollment, screen-reader, and visual device QA remain
release checks.
