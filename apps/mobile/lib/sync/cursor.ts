// Per-vault pull cursor. The sync_state table is keyed by vault_id and stores
// the highest server_seq we've already pulled-and-applied. Migration 008
// creates the table; reads are guarded by COALESCE so a missing row reads as 0.
//
// We deliberately keep this read/write outside of any larger transaction —
// the scheduler updates it AFTER the batch transaction that applied the
// events has committed, which means the worst case on a crash is re-pulling
// a batch we already have (applyEvent is INSERT OR IGNORE-idempotent on
// event_id, so this is harmless).

import { getDb } from "../db-tx";

export async function getLastPulledServerSeq(vaultId: string): Promise<number> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ last_pulled_server_seq: number | null }>(
    "SELECT last_pulled_server_seq FROM sync_state WHERE vault_id = ?",
    vaultId,
  );
  return row?.last_pulled_server_seq ?? 0;
}

export async function setLastPulledServerSeq(vaultId: string, seq: number): Promise<void> {
  const db = await getDb();
  const now = Date.now();
  await db.runAsync(
    `INSERT INTO sync_state (vault_id, last_pulled_server_seq, last_pull_at, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(vault_id) DO UPDATE SET
       last_pulled_server_seq = excluded.last_pulled_server_seq,
       last_pull_at = excluded.last_pull_at,
       updated_at = excluded.updated_at`,
    vaultId,
    seq,
    now,
    now,
  );
}

// markPushDone stamps last_push_at without touching the pull cursor.
export async function markPushDone(vaultId: string): Promise<void> {
  const db = await getDb();
  const now = Date.now();
  await db.runAsync(
    `INSERT INTO sync_state (vault_id, last_pulled_server_seq, last_push_at, updated_at)
     VALUES (?, 0, ?, ?)
     ON CONFLICT(vault_id) DO UPDATE SET
       last_push_at = excluded.last_push_at,
       updated_at = excluded.updated_at`,
    vaultId,
    now,
    now,
  );
}

// SyncIndicator is what the UI "Last synced X" widget reads.
export type SyncIndicator = {
  lastPullAt: Date | null;
  lastPushAt: Date | null;
  lastPulledServerSeq: number;
};

export async function getSyncIndicator(vaultId: string): Promise<SyncIndicator> {
  const db = await getDb();
  const row = await db.getFirstAsync<{
    last_pulled_server_seq: number | null;
    last_pull_at: number | null;
    last_push_at: number | null;
  }>(
    "SELECT last_pulled_server_seq, last_pull_at, last_push_at FROM sync_state WHERE vault_id = ?",
    vaultId,
  );
  return {
    lastPullAt: row?.last_pull_at ? new Date(row.last_pull_at) : null,
    lastPushAt: row?.last_push_at ? new Date(row.last_push_at) : null,
    lastPulledServerSeq: row?.last_pulled_server_seq ?? 0,
  };
}
