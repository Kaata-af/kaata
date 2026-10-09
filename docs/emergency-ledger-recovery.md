# Emergency ledger recovery (forensic re-import)

The kit under `apps/backend/scratch-reimport/` recovers a hard-deleted vault/account and re-imports it
under the user's current account. Built for the 2026-10-07 incident (a shopkeeper tapped "Delete account"
by accident, see memory `accidental-wipe-incident-2026-10-07`). Keep it until the account-deletion grace
window (`docs/account-deletion-grace-window.md`) ships — after that, accidental deletions self-heal on
re-sign-in and this is almost never needed.

> The `out/` directory this kit generates contains the customer's full ledger (names, phones, amounts) in
> plaintext. It is gitignored (`apps/backend/scratch-reimport/.gitignore`). Never commit it; purge it when
> the incident closes.

## When to use it

A vault's or account's rows were hard-deleted on the server (today `DELETE /v1/account` →
`delete_account.go` does this instantly) and the user wants their ledger back. It is **time-critical**:
deleted rows survive only as Postgres dead tuples until autovacuum runs, and in WAL segments / a base
backup until they rotate. Copy the data out first, investigate second.

## Prerequisites

- Read-only access to the prod DB. From this laptop: WSL Ubuntu → `ssh root@<prod>` → `docker exec <db
  container> psql -U kaata -d kaata`. Find the container with `docker ps -q -f name=kaata-database-nz3gqb`
  (the task-id suffix changes on restart; see memory `prod-db-access`).
- A throwaway Postgres 18 to rehearse against. Never point a test/rehearsal DB at prod; `testutil`
  DROPs schema `public`.
- The deleted data must still be physically present (dead tuples not yet vacuumed, or recoverable from WAL
  / a base backup). Once real backups ship (`docs/recovery-runbook.md`), restore from a backup instead of
  carving.

## Method (two phases)

**Phase 1 — recover the events (forensic, bespoke per incident).**
- Take a read-only `pg_basebackup` and copy `pg_wal` off the server; restore as a scratch cluster with
  `autovacuum=off`.
- Carve deleted heap tuples from the dropped pages (`pageinspect`, `pg_surgery heap_force_freeze`) and/or
  decode complete table projections from WAL full-page images. The 2026-10-07 run did both; the
  WAL-decoded snapshot was the complete oracle, the carve was a verified subset.
- Validate: every surviving **signed** event must agree with the decoded snapshot (same relationship,
  type, amount) before you trust the snapshot as the source of truth.

**Phase 2 — re-import (the reusable tool, `scratch-reimport/`).**
- `cmd/gen-reimport` + `reimport/reimport.go` generate a single-transaction `out/reimport.sql` that
  re-inserts the vault, an owner `vault_members` row, every recovered event verbatim, and an FK-closed
  `vault_snapshots` row built by the backend's own projection. `go run ./scratch-reimport/cmd/gen-reimport
  -jsonl <events.jsonl> -out ./scratch-reimport/out` (it defaults names/ids to the 2026-10-07 incident;
  override with flags, and generalize the hardcoded ids for any new incident).
- Rehearse before prod: `rehearsal/final_sql_test.go` runs the exact `out/reimport.sql` through the real
  handlers on the throwaway DB and asserts the restored snapshot, pull, cron no-op, witnessed re-bind,
  and rollback. `reimport/reimport_test.go` is the unit gate.
- Apply: `preflight-readonly.sql` → `reimport.sql` → `verify-after.sql` in the prod DB container, with a
  sha256 check on the copied file first. `rollback.sql` removes everything if needed.

## Load-bearing invariants (change the design doc, not just the code)

- **Anchor = the original device key (K1), never the new phone's key.** The mobile role gate authenticates
  the old signed history through the vault's pinned trust anchor; a wrong anchor quarantines everything.
- **`events.account_id` = NULL** (the deleted account can't satisfy the FK); **preserve
  `signed_actor_account_id`** by disabling the migration-050 trigger for the import transaction only —
  otherwise the trigger overwrites it and every signature fails on the phone.
- **The snapshot must be FK-closed**: reconstruct a `person_added` for every relationship that has tallies
  but lost its person, or `restoreFromSnapshot` aborts the whole vault in one transaction. Prefer rebuilding
  from the decoded oracle so folded events == the complete snapshot (the generator asserts this).
- **server_seq**: place reconstruction rows in the carve's gaps plus a margin above any seq a live device
  may have used, so later writes never collide.
- **Then the user signs out and signs in** with the same account; `recoverAllVaults` pulls the vault. There
  is no background discovery of new server vaults (see memory), so the sign-in is required.

## Limitations

- Phase 1 is bespoke; the carve/decode scripts from 2026-10-07 live in that session's scratchpad, not here.
- Recovery can be partial (the 2026-10-07 carve lost ~26% of raw rows before the WAL oracle filled them).
- The tool has the incident's vault/account ids as flag defaults; parameterize for any reuse.
- After the user has restored on their phone, a server rollback strands their local copy; the remedy is
  roll back + re-import, not rollback alone.
