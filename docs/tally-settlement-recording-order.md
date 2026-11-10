# Private settlements and editable tally dates

Private settlement membership uses immutable `recorded_at_ms`, not the editable
business date in `created_at`. A user may backdate a new tally or correct its
date without moving it into an already closed account. The selected business
date remains the date displayed, searched and exported on the tally.

The reported failure was an old settled 3,100 given/received pair, followed by
a newly recorded 2,660 given with a date before the old settlement and a new
2,660 received after it. The total was zero, but the business-date partition
made the open period nonzero and disabled settlement. Recording metadata was
introduced alongside editable dates, so those existing rows already contain
the information required to recover their correct periods. Legacy rows from
before editable dates retain their original creation-date fallback. Amounts,
chosen dates and signed historical events are not rewritten.

## Boundaries and safeguards

- New private entries advance their immutable recording time beyond the latest
  settlement for that relationship and currency, inside the write transaction
  before signing. Same-millisecond appends and a lagging device clock cannot
  put a new local tally behind a settlement it already knows about.
- Settlement rechecks the complete private balance at exact integer zero under
  the same write lock and includes every visible recording time and existing
  cutoff. Future business dates do not enlarge new settlement cutoffs.
- A fully known private ledger at zero can explicitly settle an older
  incoherent period. This writes a real new marker; it does not infer a settled
  state from zero alone or change older records/boundaries.
- Pending credit changes for the currency block settlement until their result
  is applied. Shared pending/unsynced/closing history remains protected, and
  genuine shared settlements retain their server-sequence rules.
- Edit/delete guards, currency moves, homepage status, period counts, customer
  disclosure, marker placement, CSV/PDF statements and web editing use the
  same recording-time membership. Currency balances remain independent.

## Shared settlements after unlinking and relinking

A shared settlement belongs to its original `tab_id` and `through_seq`. Changing
sharing mode creates a new period; the new period's sequence numbers cannot clear
older rows or reopen rows already covered by their original marker. Reconnecting
an empty period preserves the existing clearance without creating another marker.

Home and customer detail use the same per-currency clearance proof. Every source
must be covered by its own settlement or an acknowledged opening checkpoint;
an empty link or a legacy zero opening alone cannot clear unmarked activity.
Pending reviews/removals, queued changes, incomplete history, and new backdated
zero-net entries still prevent a settled status. Private rows recorded after the
last explicitly marked shared binding cannot inherit its clearance just because
a new binding moves those rows into the before-link history.

The expanded timeline and statements retain each original receipt once, with its
original actor, date, and sequence. A fully cancelled chapter can still expose
its receipt without inventing a tally count. Historical links remain available
for attribution and permitted actions; fully downloaded, resolved closed periods
do not need the active page's frequent sync polling.

These are reader changes, not a migration or a new settlement command. Reading
an older affected account repairs its presentation without moving tallies,
changing money, or rewriting settlement markers.

## Public bills and compatibility

New bill entries add optional `recorded_at_ms` beside the displayed `date`.
Both public web renderers use it for settlement membership; earlier permanent
bills without that metadata keep their original date fallback. Private
pre-link history anchors settlement markers to the corresponding entry IDs
using recording order. Rendering never modifies a stored bill.

There is no database migration or signed-ledger protocol change. Existing
snapshot/restore paths already retain recording metadata. Updated app readers
repair the reported partition when the account is opened; the app still needs
to be updated on devices running the old implementation. Matching web/server
renderers support the optional bill metadata.

## Regression coverage

Real SQLite tests cover the reported 3,100/2,660 case, explicit settlement,
backdated and future business dates, date edits, old-record protection,
multiple currencies, lagging/equal clocks, restore and out-of-order reads,
legacy incoherent cutoffs, and pending credit admission. Customer-screen
fixtures cover Android/iOS and LTR/RTL, disclosure, selection and settlement
recovery. Export/share fixtures retain every amount and displayed date. Go and
web tests check the web ledger and both permanent-bill renderers, including
legacy payloads and immutable snapshot preservation.
