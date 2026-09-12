# Decimal amounts

Entries accept positive amounts with up to two decimal places, for every
supported vault currency. `12.50`, `.50`, Persian/Arabic digits and the Arabic
decimal separator are supported. A comma is accepted as a decimal separator
when followed by at most two digits; grouped or ambiguous pasted input is
rejected. Extra decimal places are rejected instead of rounded or truncated.
Whole-number formatting stays unchanged; fractional values show two places.
The entry maximum is `9,999,999,999.99` (the previous ten whole-number digits
plus cents). Changing a vault's currency still relabels its amounts without
conversion.

## Preservation contract

- `amount_afn` keeps its historical major-unit meaning in SQLite, event JSON,
  mesh/sync payloads and snapshots. Old `100` remains `100`. Do not multiply
  stored rows or old event payloads by 100.
- No schema migration or projection rebuild is required. The existing SQLite
  table is not STRICT; INTEGER affinity retains fractional numeric values.
  This is SQLite's documented [numeric affinity behavior](https://www.sqlite.org/datatype3.html#type_affinity).
- Never rewrite signed events. Entry IDs, notes, timestamps, tombstones, HLC
  winners and settlement boundaries remain intact. Snapshot-only base rows
  must remain usable even when the full entry event history is unavailable.
- Mobile calculations convert each amount to integer hundredths before
  addition/subtraction. SQL does the same per row before `SUM`; settlement
  guards compare that integer sum with zero. Formatting never truncates cents.
- Go projection and snapshot amounts use `json.Number`, preserving numeric
  JSON without coercing decimals to integers or large legacy integers to
  float64. No field-name or payload-schema change is needed.
- CSV, PDF, WhatsApp and shared bills preserve decimal values. Shared bill
  history collapse compares integer hundredths, so `0.10 + 0.20 - 0.30`
  settles exactly.

## Rollout

Deploy the backend projection/snapshot support before distributing the mobile
update. The previous backend can store a decimal event but skip it while
building the restore snapshot because its Go amount fields require integers.

**Update every device that edits a shared kaata before entering cents.** Old
mobile versions retain fractional numbers in their local database but truncate
their display; an old edit form can change `12.34` into `1234`, even during a
note edit. A payload-schema bump does not protect those versions because they
do not reject unknown schema numbers. Do not claim mixed-version editing is
safe or roll back to an integer-only client/backend after cents are in use.

An app update is required; a backend/web deployment alone does not add the
decimal keyboard to installed apps. Do not ask people to reinstall or clear
their data. Existing rolling SQLite backups and cloud restore remain in place.

## Validation

From `apps/mobile`, run `npm run selftest:money` and `npm run typecheck`.
The money self-test exercises parsing, arithmetic, actual entry projection,
signed event round trips, SQLite balances and backup preservation with synthetic
data. Backend decimal projection, JSONB/snapshot and shared bill tests run with
`go test -mod=readonly ./internal/sync ./internal/shared` from `apps/backend`;
set `POSTGRES_TEST_URL` to a disposable test database to include DB tests.

Before mobile release, check Android and iOS keyboards (English and Dari),
create/edit `0.01` and `12.50`, edit only the note on a decimal entry, settle
`0.10 + 0.20 - 0.30`, and verify sync/restore on two updated devices. Export
CSV/PDF and open a shared bill. Test update-over-install with an existing
whole-number ledger and verify its balances and history stay unchanged.
