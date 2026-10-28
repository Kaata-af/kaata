import type { SQLiteTx } from "./db-tx";
import type { HLC } from "./hlc";
import { isValidCurrencyCode } from "./currency-scope";
import { toMinorUnits } from "./money";
import { parseFieldHLCs, serializeFieldHLCs } from "./projection/field-hlc";

/** Accepted server money for an entry restored by an older app. This is
 * projection metadata, never a replacement event or rewritten signature. */
export type EntryCurrencyBaseline = {
  id: string;
  amount_afn: number;
  currency: string;
  original_currency?: string | null;
  amount_hlc: HLC;
  amount_event_id?: string;
  is_deleted?: boolean | 0 | 1;
};

const syntheticAmountSql = (alias: string) =>
  `CASE WHEN json_valid(${alias}.field_hlcs) THEN NOT COALESCE(
    json_type(${alias}.field_hlcs,'$.amount_afn.pms')='integer'
    AND json_extract(${alias}.field_hlcs,'$.amount_afn.pms') BETWEEN 1 AND 9007199254740991
    AND json_type(${alias}.field_hlcs,'$.amount_afn.l')='integer'
    AND json_extract(${alias}.field_hlcs,'$.amount_afn.l') BETWEEN 0 AND 9007199254740991
    AND json_type(${alias}.field_hlcs,'$.amount_afn.did')='text'
    AND json_extract(${alias}.field_hlcs,'$.amount_afn.did')<>'',0) ELSE 1 END`;

// Applied, unacknowledged money may be this device's edit or an offline mesh
// peer's edit. A server baseline cannot replace either before it is accepted.
const unpublishedMoneySql = (entryAlias: string) => `EXISTS (
  SELECT 1 FROM event_log e WHERE e.vault_id=${entryAlias}.vault_id
    AND e.target_id=${entryAlias}.id AND e.applied_at IS NOT NULL
    AND e.server_acked_at IS NULL AND e.rejected_at IS NULL
    AND e.tombstone_reason IS NULL AND (
      e.event_type='entry_created' OR (e.event_type='entry_amended' AND
        CASE WHEN json_valid(e.payload_json) THEN
          json_type(e.payload_json,'$.changes.amount_afn') IS NOT NULL OR
          json_type(e.payload_json,'$.changes.type') IS NOT NULL OR
          json_type(e.payload_json,'$.changes.currency') IS NOT NULL
        ELSE 1 END)))`;

/** Older snapshots used updated_at for every field, with an empty device ID.
 * Keep requesting precise money only while live rows retain that placeholder.
 * Unpublished rows still count: a later acknowledgement makes them repairable. */
export async function needsEntryCurrencyBaselines(tx: SQLiteTx, vaultId: string): Promise<boolean> {
  const row = await tx.getFirstAsync<{ one: number }>(
    `SELECT 1 AS one FROM entries x WHERE x.vault_id=?
      AND COALESCE(x.is_deleted,0)=0 AND x.deleted_at IS NULL
      AND ${syntheticAmountSql("x")} LIMIT 1`,
    vaultId,
  );
  return row != null;
}

export function validateEntryCurrencyBaselines(
  vaultId: string,
  rows: unknown,
): asserts rows is EntryCurrencyBaseline[] {
  if (typeof vaultId !== "string" || !vaultId || !Array.isArray(rows))
    throw new Error("Invalid entry currency baselines");
  const ids = new Set<string>();
  for (const row of rows) {
    const scoped = row as EntryCurrencyBaseline & { vault_id?: unknown };
    const clock = row?.amount_hlc;
    if (
      !row ||
      typeof row !== "object" ||
      typeof row.id !== "string" ||
      !row.id ||
      ids.has(row.id) ||
      (scoped.vault_id !== undefined && scoped.vault_id !== vaultId) ||
      typeof row.amount_afn !== "number" ||
      !Number.isFinite(row.amount_afn) ||
      row.amount_afn < 0 ||
      !isValidCurrencyCode(row.currency) ||
      (row.original_currency != null && !isValidCurrencyCode(row.original_currency)) ||
      (row.amount_event_id !== undefined &&
        (typeof row.amount_event_id !== "string" || !row.amount_event_id)) ||
      (row.is_deleted !== undefined &&
        row.is_deleted !== true &&
        row.is_deleted !== false &&
        row.is_deleted !== 0 &&
        row.is_deleted !== 1) ||
      !clock ||
      !Number.isSafeInteger(clock.pms) ||
      clock.pms <= 0 ||
      !Number.isSafeInteger(clock.l) ||
      clock.l < 0 ||
      typeof clock.did !== "string" ||
      !clock.did
    )
      throw new Error("Invalid entry currency baseline row");
    // Preserve existing major units, including lawful legacy zero amounts.
    // Reject fractional cents and unsafe numbers instead of rounding them.
    toMinorUnits(row.amount_afn);
    ids.add(row.id);
  }
}

/** Caller must hold applyEventMutex and a write transaction for the whole list.
 * Only older-snapshot placeholders are repaired. Independent fields, signed
 * history and pending/refused admission intents remain intact. The guarded
 * update also refuses a row changed since its read or unpublished meanwhile. */
export async function applyEntryCurrencyBaselines(
  tx: SQLiteTx,
  vaultId: string,
  rows: readonly EntryCurrencyBaseline[],
): Promise<number> {
  validateEntryCurrencyBaselines(vaultId, rows);
  let changed = 0;
  for (const baseline of rows) {
    if (baseline.is_deleted) continue;
    const current = await tx.getFirstAsync<{
      amount_afn: number;
      currency: string | null;
      original_currency: string | null;
      field_hlcs: string | null;
      updated_at: number;
      current_event_id: string | null;
    }>(
      `SELECT x.amount_afn,x.currency,x.original_currency,x.field_hlcs,x.updated_at,x.current_event_id FROM entries x
        WHERE x.id=? AND x.vault_id=? AND COALESCE(x.is_deleted,0)=0 AND x.deleted_at IS NULL
        AND ${syntheticAmountSql("x")} AND NOT ${unpublishedMoneySql("x")}`,
      baseline.id,
      vaultId,
    );
    if (!current) continue;
    const fields = parseFieldHLCs(current.field_hlcs);
    fields.amount_afn = { ...baseline.amount_hlc };
    const result = await tx.runAsync(
      `UPDATE entries AS x SET amount_afn=?,currency=?,original_currency=?,field_hlcs=?,updated_at=?,current_event_id=?
        WHERE x.id=? AND x.vault_id=? AND COALESCE(x.is_deleted,0)=0 AND x.deleted_at IS NULL
        AND x.field_hlcs IS ? AND x.amount_afn IS ? AND x.currency IS ? AND x.original_currency IS ?
        AND x.updated_at IS ? AND x.current_event_id IS ?
        AND ${syntheticAmountSql("x")} AND NOT ${unpublishedMoneySql("x")}`,
      baseline.amount_afn,
      baseline.currency,
      baseline.original_currency ?? current.original_currency,
      serializeFieldHLCs(fields),
      Math.max(current.updated_at, baseline.amount_hlc.pms),
      baseline.amount_hlc.pms > current.updated_at && baseline.amount_event_id
        ? baseline.amount_event_id
        : current.current_event_id,
      baseline.id,
      vaultId,
      current.field_hlcs,
      current.amount_afn,
      current.currency,
      current.original_currency,
      current.updated_at,
      current.current_event_id,
    );
    changed += result.changes;
  }
  return changed;
}
