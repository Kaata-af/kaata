# Customer credit limits and staff permissions

Local development contract. These changes have not been deployed. Backend
migrations 062 and 063 must ship before the updated mobile app; mobile migration
040 is additive. Existing signed role values and money history stay compatible.

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

Each customer relationship has two optional amounts in the kaata's currency:
maximum **they owe us** and maximum **we owe them**. Storage uses exact integer
hundredths. Blank means unlimited; zero forbids new exposure in that direction.
A customer's own policy wins over the kaata-wide default, including an explicit
warn-only policy. The default covers future customers and re-added contacts.

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
