// SQLite adapter for the replication planner (Sync v2 M1). Thin by design:
// all decision logic lives in planner.ts (pure, self-tested); this module
// only runs queries.

import { getDb } from "../db-tx";
import { computeContiguous, type Vector } from "./planner";

export type FrontierReport = {
  /** Per author device: highest contiguous author_seq held. */
  vector: Vector;
  /** Non-contiguous held ranges per author (relay died mid-stream, or the
   *  replica was snapshot-bootstrapped and never held old history). */
  gaps: Array<{ device_id: string; from_seq: number; to_seq: number }>;
};

/**
 * Our state of knowledge for a vault, in ONE scan: per author device, the
 * contiguous frontier plus any gaps above it. Tombstoned/quarantined rows
 * still count as HELD — holding a row we refuse to apply is a trust
 * verdict, not a transfer gap; claiming not to hold it would just invite
 * pointless re-delivery.
 *
 * Rows with NULL author_seq (legacy mesh ingests whose author never told
 * us a seq) are invisible to the vector by definition — they remain
 * covered by the server_seq pull path until M3's epoch handling.
 *
 * JS-side aggregation is deliberate at ledger scale (a busy shop ≈ 100
 * events/day; this runs every ~60 sync cycles). Revisit with SQL-side
 * frontier computation if vaults ever approach ~100k events.
 */
export async function localFrontierReport(vaultId: string): Promise<FrontierReport> {
  const db = await getDb();
  const rows = await db.getAllAsync<{ device_id: string; author_seq: number }>(
    `SELECT device_id, author_seq
       FROM event_log
      WHERE vault_id = ? AND author_seq IS NOT NULL
      ORDER BY device_id ASC, author_seq ASC`,
    vaultId,
  );

  const perDevice = new Map<string, number[]>();
  for (const r of rows) {
    let list = perDevice.get(r.device_id);
    if (!list) {
      list = [];
      perDevice.set(r.device_id, list);
    }
    list.push(r.author_seq);
  }

  const vector: Vector = {};
  const gaps: FrontierReport["gaps"] = [];
  for (const [device, seqs] of perDevice) {
    const c = computeContiguous(seqs);
    vector[device] = c.frontier;
    for (const g of c.gaps) {
      gaps.push({ device_id: device, from_seq: g.from_seq, to_seq: g.to_seq });
    }
  }
  return { vector, gaps };
}
