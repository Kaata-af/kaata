import { getDb } from "./db-tx";

/** Internal staff metadata. Read separately so bills and shared-tally payloads
 * never acquire it through a serialized PersonWithBalance object. The caller
 * may already hold applyEventMutex for a consistent customer-page snapshot. */
export async function getPersonNote(vaultId: string, personId: string): Promise<string | null> {
  const row = await (
    await getDb()
  ).getFirstAsync<{ note: string | null }>(
    `SELECT note FROM relationships
      WHERE vault_id=? AND user_b_id=? AND archived_at IS NULL
      ORDER BY created_at DESC LIMIT 1`,
    vaultId,
    personId,
  );
  return row?.note ?? null;
}
