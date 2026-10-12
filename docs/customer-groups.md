# Customer groups and home sorting

Groups are optional, with several groups per customer **inside a kaata**. The same
person can have different groups in another kaata. Group labels organize the
list; they grant no access, change no balance, and do not appear on public bills.

This follows the lightweight named-contact grouping in [Google Contacts](https://support.google.com/contacts/answer/30970)
and the customer category selection described by [Zoho Books](https://www.zoho.com/uk/books/kb/contacts/group-customers.html).
Overlapping groups fit practical distinctions such as Family and West neighborhood
without creating duplicate customers. They remain flat, optional labels with no
extra hierarchy or permanent row of filter chips.

## Interface

The home tabs share one small **Sort & filter** button. Its sheet selects a sort
and optional groups. Sorting defaults to the previous behavior: open accounts
first, then most recent tally, then name. Explicit name, amount and date choices
have both directions. Amount sorts the absolute current balance, so "largest"
has the same meaning on both the Collect and Pay sides. Date means the latest
tally date, including shared-tab activity. Ties use name and person ID.

All/Ungrouped/custom groups filter the customer list. Selecting multiple custom
groups uses **any selected group (OR)**: someone in Family or West neighborhood
appears once, including someone in both. All and Ungrouped are exclusive modes;
unchecking the last custom group returns to All. The hero amount and active
customer count still describe the entire side. A filtered-count explanation
states that totals include everyone. Local per-kaata preferences remember the
chosen sort/filter. Removing a selected group drops just that selection; if none
remain, the list returns to All. Legacy saved single-group filters still load.

Group management sits behind the sheet. Customer group selection lives in the
person menu/edit controls. That screen uses checkmarks and one Done action to
save the complete selection. Editors, managers and owners may create, rename,
remove and assign groups. Clerks/viewers may sort and filter but cannot edit
the shared classification. Existing person-create authority is unchanged.

## Persistence and sync

Mobile migration 035 creates `customer_groups(vault_id,id)` and a nullable
`relationships.group_id`. UUID group identities survive renames. Signed events
`group_created`, `group_renamed`, `group_archived` and `person_group_set` use the
existing event log, push/pull, mesh, membership authorization and HLC machinery.
Backend groups require no extra relational table or migration.

Append-only mobile migration 037 adds `relationships.group_ids` as JSON, backfilled
from each old `group_id`. No customer, tally, balance or old HLC changes. The
existing signed `person_group_set` event and schema version remain unchanged;
new payloads add sorted unique `group_ids` (up to 100), and `group_id` mirrors
the first ID or null for compatibility. A mismatched mirror, malformed set or
unknown group is refused. Signed historical payloads are never rewritten.

Name and assignment are HLC registers. An archive is a retained tombstone;
concurrent rename/create cannot revive it. Archived groups and their dormant
assignments remain in recovery data, but active lists omit archived memberships.
Customers keep their other active groups; those with none become Ungrouped.
Removing a group never deletes a customer or tally. Group assignment
does not advance the relationship's legacy archive timestamp/register.

Group commands bind the initiating session and active kaata, serialize their
local append with sign-in/out, recheck after prerequisite SQL inside the append
transaction, and revalidate live target/group prerequisites. The session
generation also rejects an A→B→A account switch while a command is waiting. Remote
assignment/create ordering retries missing prerequisites via quarantine. Each
permission layer requires editor rank. New group/assignment events count as
user ledger data, so recoverable sync failures do not permanently discard them.

The complete membership set shares the existing `group_id` HLC register. A later
explicit selection wins as one set; independent concurrent changes to that same
customer do not union automatically. Older clients show only the mirrored first
group, and their later assignment replaces the set with zero or one membership.
Update editing devices before using multiple groups, and deploy the new backend
projection before sharing these assignments through cloud sync.

Go projection/snapshots carry groups, additive `group_ids` and exact group field HLCs. Mobile recovery
seeds them before relationships; old snapshots with omitted additive fields
remain supported. Full local SQLite backups include the tables automatically.
The backend must be updated before shared cloud group synchronization can work.
The matching projection deployed for the 34/54 testing update; update editing
phones to that release before using multiple cloud groups.

## Checks

`selftest:customer-groups` exercises the actual migration and group SQL with
in-memory SQLite, real appliers and mobile role-gate queries, scoped assignment,
archive behavior, stale/new HLC races, missing prerequisites, account/kaata
change during a command, every sort direction, non-mutating filters, shared
Go/TS projection corpus and exact snapshot seed registers. Native IO/append
scheduling are replaced; it does not access live data.

The suite also covers the real 037 backfill SQL, two simultaneous memberships,
per-group counts, canonical sets, no-op reordering, legacy complete-set edits,
OR filters without duplicate people, saved single/multi-filter compatibility and
old/new snapshot membership expansion. The actual customer assignment screen
checks drafts, explicit Done, repeated save taps, live refresh, route changes and
viewer/scope guards.

The production session capture/guard/mutex declarations run in the fixture
against synthetic SecureStore/account cache. It covers an account switch that
returns to its original account ID, queued session mutation during append, and
an active-kaata change during prerequisite SQL.

The same suite runs the actual sheet and data hook against controlled native
boundaries. It checks rapid close/reopen, stopped animation callbacks, reduced
motion, duplicate Manage taps, canceled navigation after a context change,
late account/kaata reads and unmount cleanup. The home badge uses one batched
policy query and pure row statuses; it does not start a request for each row.

Focused Go tests exercise projection/snapshot round-trip, logical HLC frontier,
wrong-vault/malformed assignment refusal, Dari joining characters, and actual
editor permission matrix. The shared projection corpus includes the new group
case and all older cases.

`go test ./internal/sync -run 'TestCustomerGroups|TestMultipleCustomerGroups|TestProjectionCorpus' -count=1`
passed. These are pure projection/permission checks; no database-backed Go
tests are included in that focused command.

Still to check on devices: sheet scroll/back/keyboard behavior in English/Dari;
empty group and settled-only results; switching kaatas with different saved
sorts; another editor renaming/removing/assigning a group while the screen is
open; shared sync, offline replay and a fresh cloud restore.

Concurrent offline creation of the same label can create two independent
groups: local commands prevent a duplicate active name, but there is no global
unique-name lock. Their UUIDs/assignments remain intact; rename either group to
distinguish them. Groups are flat and allow multiple selections.
