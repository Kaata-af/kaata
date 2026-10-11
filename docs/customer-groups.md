# Customer groups and home sorting

Groups are optional, with one group per customer **inside a kaata**. The same
person can have a different group in another kaata. Group labels organize the
list; they grant no access, change no balance, and do not appear on public bills.

This follows the lightweight named-contact grouping in [Google Contacts](https://support.google.com/contacts/answer/30970)
and the customer category selection described by [Zoho Books](https://www.zoho.com/uk/books/kb/contacts/group-customers.html).
One optional category avoids the tag chips, multiple selections and taxonomy
configuration those products can support. Kaata does not need those to organize
a shopkeeper's current customer list.

## Interface

The home tabs share one small **Sort & filter** button. Its sheet selects a sort
and an optional group. Sorting defaults to the previous behavior: open accounts
first, then most recent tally, then name. Explicit name, amount and date choices
have both directions. Amount sorts the absolute current balance, so "largest"
has the same meaning on both the Collect and Pay sides. Date means the latest
tally date, including shared-tab activity. Ties use name and person ID.

All/Ungrouped/custom groups filter the customer list. The hero amount and active
customer count still describe the entire side. A filtered-count explanation
states that totals include everyone. Local per-kaata preferences remember the
chosen sort/filter. Removing a selected group resets the list to All.

Group management sits behind the sheet. Customer group selection lives in the
person menu/edit controls. Editors, managers and owners may create, rename,
remove and assign groups. Clerks/viewers may sort and filter but cannot edit
the shared classification. Existing person-create authority is unchanged.

## Persistence and sync

Mobile migration 035 creates `customer_groups(vault_id,id)` and a nullable
`relationships.group_id`. UUID group identities survive renames. Signed events
`group_created`, `group_renamed`, `group_archived` and `person_group_set` use the
existing event log, push/pull, mesh, membership authorization and HLC machinery.
Backend groups require no extra relational table or migration.

Name and assignment are HLC registers. An archive is a retained tombstone;
concurrent rename/create cannot revive it. Archived groups and their dormant
assignments remain in recovery data, but active lists treat their customers as
Ungrouped. Removing a group never deletes a customer or tally. Group assignment
does not advance the relationship's legacy archive timestamp/register.

Group commands bind the initiating session and active kaata, serialize their
local append with sign-in/out, recheck after prerequisite SQL inside the append
transaction, and revalidate live target/group prerequisites. The session
generation also rejects an A→B→A account switch while a command is waiting. Remote
assignment/create ordering retries missing prerequisites via quarantine. Each
permission layer requires editor rank. New group/assignment events count as
user ledger data, so recoverable sync failures do not permanently discard them.

Go projection/snapshots carry groups and exact group field HLCs. Mobile recovery
seeds them before relationships; old snapshots with omitted additive fields
remain supported. Full local SQLite backups include the tables automatically.
The backend must be updated before shared cloud group synchronization can work;
this local building batch performs no deployment.

## Checks

`selftest:customer-groups` exercises the actual migration and group SQL with
in-memory SQLite, real appliers and mobile role-gate queries, scoped assignment,
archive behavior, stale/new HLC races, missing prerequisites, account/kaata
change during a command, every sort direction, non-mutating filters, shared
Go/TS projection corpus and exact snapshot seed registers. Native IO/append
scheduling are replaced; it does not access live data.

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

`go test ./internal/sync -run 'TestCustomerGroups|TestProjectionCorpus' -count=1`
passed. These are pure projection/permission checks; no database-backed Go
tests are included in that focused command.

Still to check on devices: sheet scroll/back/keyboard behavior in English/Dari;
empty group and settled-only results; switching kaatas with different saved
sorts; another editor renaming/removing/assigning a group while the screen is
open; shared sync, offline replay and a fresh cloud restore.

Concurrent offline creation of the same label can create two independent
groups: local commands prevent a duplicate active name, but there is no global
unique-name lock. Their UUIDs/assignments remain intact; rename either group to
distinguish them. Groups are flat and single-select in this version.
