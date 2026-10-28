# Saved tally currency corrections

Currency can be corrected from the currency symbol beside the calculator result
in Edit Tally. Choices use the Kaata's enabled currencies, while retaining the
tally's current unit so a draft correction can be undone. The numeric amount
stays as entered; this is a correction, with no exchange-rate conversion.
The existing tally ID, recording time and audit history are preserved.

## Monetary consistency

- A correction is one signed `entry_amended` event containing both
  `changes.amount_afn` and `changes.currency`. Bare currency amendments are
  rejected before any fields are applied.
- Amount and currency share the amount field's HLC register. They win or lose
  together; note, type and business date retain their independent registers.
- Migration 044 adds nullable `entries.original_currency` metadata. It does not
  rewrite existing amounts, dates, currencies or events. The original unit is
  frozen on the first currency-aware amendment, including a losing amendment.
- An older phone's queued amount-only amendment still describes its original
  currency. If it wins the monetary register, its original unit wins with it.
  An updated phone includes the explicit current unit when subsequently editing
  the amount of a corrected tally.
- Snapshots include the original unit when present and the exact amount HLC.
  Recovery restores both, so a newer independent note cannot hide a valid
  monetary correction.

Older stored server snapshots recover missing monetary clocks from events at
their saved cursor without rewriting the snapshot or its history. Phones that
restored before this update request monetary baselines on a background pull.
Those baselines repair only unresolved snapshot clocks; they preserve independent
fields and skip unpublished recorded monetary changes. An ambiguous incoming
currency correction waits for that clock repair instead of being silently lost.

## Permissions and closed history

The ordinary editor permission is required. Save rechecks the original row,
active Kaata/account/session and current scope under the write lock. Stale forms
ask the user to reopen the tally. Both the original and destination currency's
settled periods and shared-account boundaries are protected. A destination that
was disabled while the form was open cannot be saved; an unchanged historical
currency remains editable even if it is no longer offered for new tallies.

Credit checks consider both currencies independently. Moving a debt can increase
the destination balance; moving a payment can increase the source balance.
Either applicable hard limit holds the entire edit for server admission. Pending
and refused edits retain their intended currency outside recorded balances.
Refusal restores the lawful row, including its unit, amount and independent
metadata.

## Compatibility and rollout

The server advertises `entry_currency_edit`. A client does not upload a correction
to an unsupported server: it retains that signed event and all following writes
in order, without changing their signatures or rejection/retry metadata.

Updated clients send `X-Kaata-Entry-Currency-Edit: 1`. An older client can keep
using books without currency corrections. A book containing a correction requires
an updated client to sync; older clients receive an update-required response
before receiving an event they could misinterpret. Their local records remain
on the phone. This applies to push, pull and snapshot recovery.

Foreground and Android background peer sync also negotiate authenticated
currency-edit support. Corrected books are not exchanged with an older peer.
Normal books retain the existing protocol. Capability checks apply at delta
boundaries, including changes arriving during an established session.

No store version bump, native application build, testing upload or production
release is part of this code change. The next testing binaries must include both
the JavaScript and Android native peer-sync changes. Physical-phone QA should
cover an edit, a currency correction, a second-device sync, and an older-client
update prompt using disposable records.

## Focused validation

From `apps/mobile`, `bun run selftest:entry-currency` covers signed SQLite writes,
rollback and stale scope, legacy replay, snapshot clocks, credit admission,
authenticated peer compatibility, old-server outbox retention and Edit Tally UI.
Also run the existing credit, restore, currency read-model, export, date and
language checks plus TypeScript checking. Backend tests in
`internal/sync/entry_currency_edit_test.go` require an isolated test database for
credit and HTTP compatibility cases; pure projection and shared corpus checks
do not replace those database tests.
