import { getAccountIdSync, getDb } from "../db-tx";
import { resolveAccountIdCandidates } from "../effective-account";

/** A revoked member's cached view is retained, but no longer needs polling.
 * Absence, pending membership and unreadable local proof never count as a
 * revocation. The server remains responsible for authorizing every request.
 * Reading afresh also resumes polling as soon as readmission is projected.
 */
export async function isTabVaultRevoked(vaultId: string): Promise<boolean> {
  try {
    const ids = await resolveAccountIdCandidates(getAccountIdSync());
    if (!ids.length) return false;
    const rows = await (
      await getDb()
    ).getAllAsync<{
      accepted_at: number | null;
      revoked_at: number | null;
    }>(
      `SELECT accepted_at, revoked_at FROM vault_members_mirror
       WHERE vault_id = ? AND account_id IN (${ids.map(() => "?").join(",")})`,
      vaultId,
      ...ids,
    );
    return (
      rows.length > 0 && rows.every((row) => row.accepted_at != null && row.revoked_at != null)
    );
  } catch {
    // This is only a polling optimization. Uncertain local state must never
    // prevent the server from repairing an accepted invitation's cache.
    return false;
  }
}
