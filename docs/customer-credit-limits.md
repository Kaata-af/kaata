# Customer credit limits

Local development contract for the next release. These changes have not been
deployed or distributed. Mobile migration 034 and backend migration 056 are
additive; existing money and membership history remain unchanged.

## Meaning and authority

Each customer relationship in a kaata has two optional limits, in that kaata's
currency: maximum **they owe us** and maximum **we owe them**. Storage uses exact
integer hundredths, just like mutual tabs. Blank means unlimited; zero means no
new exposure in that direction. Limits are per relationship and kaata, not
global limits for the same contact across kaatas.

Owner and manager can configure limits. Editor, clerk and viewer cannot.
`credit.configure` is a separate permission; this feature adds no role.

`warn` permits a tally and warns when it increases exposure beyond a cap.
`clerk_block` refuses a clerk's tally that increases exposure beyond a cap.
Owner, manager and editor retain their existing write authority and can override
a cap. A direct mutual-tab party retains the existing party authority; the
clerk restriction applies to a clerk delegated through that party's kaata.
Existing lawful-at-event-HLC permissions also apply to delayed local events:
an owner/editor write authored before a demotion is not retroactively converted
into a clerk write.

The check compares each directional exposure before and after the proposed
tally. Repayment and exposure reduction remain allowed when a balance already
exceeds its cap. Crossing through zero must also respect the opposite cap;
repaying a debt can create new exposure on the other side.

## Balance

The balance includes local recorded debt/payment rows and the latest linked
mutual-tab period, including an unclosed period first. Accepted and pending
shared tallies count. Rejected/disputed, cancelled/voided and deleted tallies do
not count. Locally disputed rows are excluded as well.

A link opening absorbs local rows created at or before the frozen link
boundary. Only local rows created **after** `linked_at` join its balance. The
same rule remains after unlinking/closing. Party B sees the opposite sign of the
shared tab; both app and server use the same perspective. A credit intent is
not a financial row and never changes totals, statements, exports or balance.

Server admission sees the committed history known to the server, including
earlier accepted events in its current push transaction. It cannot include an
owner's unsent offline writes. Those later owner/editor writes can legitimately
move the balance beyond a cap. The restriction protects admission of clerk
writes, not an invariant that privileged authors can never exceed the limit.

## Connection and enrollment

Hard mode **always** requires sign-in and a successful online owner/manager
save, including a solo kaata. An anonymous solo founder can save warning-only
limits locally. This prevents a private hard-mode cache from silently making an
unregistered paired notebook disagree between devices. A shared kaata's policy
save requires the online authority as well.

For a cloud-connected kaata, **every new clerk tally** waits for authenticated
HTTPS admission, including warning-only and unlimited customers. An offline
device cannot safely infer that a stale or absent policy permits it to record
money. This is an intentional connection requirement for cloud clerks. Owner,
manager and editor retain their existing offline workflow. The server returns
admission directly; mesh receipt is not sufficient authority.

Pure local pairing retains its offline workflow only for a conservatively
observed local-CA notebook: a pinned anchor, valid local-sentinel identities for
all observed members/devices/legacy credentials, and no cloud account binding,
registration marker, HTTPS acknowledgment, applied cloud identity history or
hard policy. Missing, malformed or mixed metadata waits for server admission.
`registered_with_server_at = NULL` alone is insufficient: scanning a cloud
pairing QR deliberately leaves that field null.

This observed local state is not proof that no unseen phone has enrolled with
the cloud. Cloud enrollment and activation must synchronize across the kaata's
devices. Hard mode refuses active clerks still represented by local-sentinel
membership: each clerk must sign in and sync their cloud enrollment first.
The mobile save and authoritative server PUT both enforce this boundary; queued
policy publication cannot bypass it. The actionable refusal is
`clerk_cloud_enrollment_required`.

Signing out does not erase a device's persisted account binding or grant owner
authority. A null-actor local append resolves its own membership at the event's
HLC using persisted identity first, before local/retired aliases. Its role and
admission decision agree with its authenticated mesh copy.

## Intents and terminal results

A cloud clerk's local create is durably saved as an intent until admission. Its
event remains unapplied and does not create a financial row. A delegated
clerk's shared append similarly queues without an optimistic financial row.
The person screen shows these separately as waiting or refused, outside recorded
tallies. Refused shared credit attempts are excluded from the ordinary Not sent
list so they appear once.

The app attempts immediate admission and waits up to five seconds for feedback;
the durable queue survives slower connections, app restarts and later retries.
Background HTTPS results notify mounted intent lists immediately. Refusal means
the tally was not recorded. There is no cancellation or retry action that
pretends to reverse a possibly committed request; a new attempt uses a fresh ID.

The server persists a terminal credit refusal in the same transaction that
commits before returning its rejection. A delayed mesh copy, lost reply, later
cap increase or promotion cannot turn that same attempt into recorded money.
An aborted whole push transaction returns no final verdict, so retrying after
rollback is valid. Existing accepted retries remain idempotent only when their
immutable financial envelope and JSON payload match; a global event ID cannot
alias different money in another kaata or payload.

Fresh clerk entry IDs cannot reuse prior financial target IDs, including orphan
amendments. Global sorted entry-ID locks cover financial mutations, followed by
the kaata admission lock. This prevents concurrent cross-kaata ID reuse and
backdated creates from activating older amendments to evade a limit.

## Storage, sync and performance

Policies are server configuration separate from signed admission/history events.
GET is member scoped and returns authoritative `[]` when empty; PUT rechecks
accepted, unrevoked owner/manager authority inside its transaction and requires
a current customer relationship. Policy changes notify live kaata subscribers.
Completed server policy writes use the server timestamp; concurrent settings
follow the existing last-completed-write behavior, without a compare-and-swap UI.

Local warning policies carry `sync_pending`. First cloud publication occurs
before replacing the cache with GET and before issuing an invite. A stale GET
cannot erase an unpublished policy or overwrite a newer local save. Existing
and fresh cloud restore both receive current policies outside the age of a
cached ledger snapshot. Account/session/kaata guards prevent a late response
from painting or changing another context.

Credit admission shares a kaata lock between local event pushes and delegated
tab appends, serializing policy and known balance checks. No-cap/warning pushes
avoid a full projection fold. A hard-limit push loads its projection once and
folds all subsequently accepted mutations into it; backdated/equal-HLC events
invalidate it for sorted reload. Partial financial-ID lookup indexes avoid
scanning unrelated global history.

## Rollout and verification

Backend 056 must precede feature distribution. Update the participating apps
before enabling hard mode, then sync enrollment on each clerk device. Older
apps do not understand separate admission intents and can temporarily show
their old optimistic local view before a server refusal. Server enforcement is
still the final authority; the new app provides accurate waiting/refused UI.
An older backend cannot acknowledge a policy save: errors stay errors, and
pending local policy publication is retained.

Focused tests use real in-memory SQLite with shipped migration DDL and an
isolated localhost PostgreSQL cluster, never a production database. They cover
directional zero/unlimited caps, exact cents, over-cap repayment, crossing zero,
owner/manager permissions, local plus linked balances, pending/rejected/voided
states, concurrent local/tab admission, terminal peer retries, transaction
rollback, immutable duplicates, orphan amendment reuse, restore/cache races,
account changes, actual signed-out role resolution, local/mesh parity, cloud QR
null metadata, and hard-mode enrollment refusal.

The 100-clerk-write rolling regression completed admission in about 84 ms on
the developer's isolated database; this is a local measurement, not a network
latency promise. No physical-phone, airplane-mode, two-device enrollment,
screen-reader or Dari visual QA has been performed for this feature batch.
