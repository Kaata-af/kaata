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
