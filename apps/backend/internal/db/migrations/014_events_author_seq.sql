-- Sync v2 M1 (docs/sync-v2-architecture.md §5): per-device author sequences.
--
-- Every event gets an author sequence number: (device_id, author_seq) where
-- author_seq is a per-device monotonic counter assigned at append time on
-- the authoring device. HLC remains the MERGE order for projections;
-- author_seq is the TRANSFER bookkeeping that makes replication resumable
-- and gap-safe (a replica's state of knowledge becomes a small version
-- vector instead of an HLC frontier).
--
-- NULLable on purpose: rows pushed by pre-M1 clients have no author_seq.
-- Legacy rows gain seqs via DUPLICATE RE-ANNOUNCE: mobile backfills its own
-- log per device in HLC order, then a one-shot job re-pushes its already
-- acked history as ordinary push events (same event_id, now carrying
-- author_seq). The server routes those to duplicates[] via the event_id PK
-- and — when the stored row has author_seq IS NULL and the claimed
-- (vault, author device, seq) slot is free — adopts the announced seq with
-- an UPDATE inside the same vault-locked push transaction. If the slot is
-- already held by a different event, or the stored row already carries a
-- seq, the announce is a silent no-op (first value wins; still reported as
-- a duplicate, never seq_conflict). The server itself never invents
-- sequence numbers for legacy rows.
--
-- The partial unique index is the server-side integrity guarantee: one
-- (vault, author device, seq) slot belongs to exactly one event. device_id
-- here is always the AUTHOR's device — the push path stamps it from the
-- event's hlc.device_id (007's CHECK (device_id = hlc_device_id) enforces
-- the equality), NOT from the batch-level pushing device, which may be a
-- relay forwarding events authored elsewhere. The push path pre-checks the
-- slot inside the vault-locked transaction and rejects a colliding fresh
-- event with reason "seq_conflict" instead of tripping the index.

ALTER TABLE events
  ADD COLUMN IF NOT EXISTS author_seq BIGINT
  CHECK (author_seq IS NULL OR author_seq >= 1);

CREATE UNIQUE INDEX IF NOT EXISTS events_vault_device_author_seq
  ON events(vault_id, device_id, author_seq)
  WHERE author_seq IS NOT NULL;
