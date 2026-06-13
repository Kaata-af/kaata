// lib/trust/revocation.ts
//
// M4: relocated out of lib/mesh/vmc.ts (deleted with the VMC retirement). The
// revocation_list is NOT a VMC concept — it is the local mirror of "who has
// been removed", fed by (a) the server check-in revocation delta
// (applyServerRevocations) and (b) the chain's vault_member_removed /
// vault_device_removed appliers (lib/projection/vault_members.ts). The CHAIN
// handshake (lib/mesh/anti-entropy.ts verifyPeerChain) reads isRevoked() as a
// cheap early reject + mid-session reverify. None of this depends on VMCs.

import { getDb } from "../db-tx";
import { getInstallIdSync } from "../db-tx";
import { getAppMeta, setAppMeta } from "../db";

const META_KEY_LAST_REVOCATION_SEEN = "last_revocation_seen_at_ms";

export type ServerRevocation = {
  vault_id: string;
  device_id: string;
  revoked_at_ms: number;
};

/**
 * Apply revocations announced in a check-in response. Idempotent: the UPSERT
 * on (vault_id, device_id) re-applying a known revocation is a no-op. If a
 * revocation targets THIS device, also DELETE the cached credential so we
 * don't keep retrying handshakes that will be refused.
 */
export async function applyServerRevocations(revocations: ServerRevocation[]): Promise<void> {
  if (revocations.length === 0) return;
  const db = await getDb();
  const myDeviceId = getInstallIdSync();
  // perVaultMaxPersisted tracks the largest revoked_at_ms we ACTUALLY
  // committed (post ON CONFLICT MIN), so the high-water mark we advance for
  // the next check-in never skips an older revocation the server later sends.
  const perVaultMaxPersisted: Record<string, number> = {};

  await db.withTransactionAsync(async () => {
    for (const r of revocations) {
      const before = await db.getFirstAsync<{ revoked_at: number }>(
        `SELECT revoked_at FROM revocation_list WHERE vault_id = ? AND device_id = ?`,
        r.vault_id,
        r.device_id,
      );
      await db.runAsync(
        `INSERT INTO revocation_list (vault_id, device_id, revoked_at)
         VALUES (?, ?, ?)
         ON CONFLICT (vault_id, device_id) DO UPDATE SET
           revoked_at = MIN(revocation_list.revoked_at, excluded.revoked_at)`,
        r.vault_id,
        r.device_id,
        r.revoked_at_ms,
      );
      const persisted = before ? Math.min(before.revoked_at, r.revoked_at_ms) : r.revoked_at_ms;
      if (r.device_id === myDeviceId) {
        await db.runAsync(
          `DELETE FROM vault_credentials WHERE vault_id = ? AND device_id = ?`,
          r.vault_id,
          myDeviceId,
        );
      }
      const prev = perVaultMaxPersisted[r.vault_id] ?? -Infinity;
      if (persisted > prev) perVaultMaxPersisted[r.vault_id] = persisted;
    }
  });

  const prev = await getLastRevocationSeenAtMs();
  let changed = false;
  for (const [vaultId, ms] of Object.entries(perVaultMaxPersisted)) {
    if (!(vaultId in prev) || ms > prev[vaultId]) {
      prev[vaultId] = ms;
      changed = true;
    }
  }
  if (changed) {
    await setAppMeta(META_KEY_LAST_REVOCATION_SEEN, JSON.stringify(prev));
  }
}

/** Read the per-vault high-water mark we send to the server on check-in. */
export async function getLastRevocationSeenAtMs(): Promise<Record<string, number>> {
  const raw = await getAppMeta(META_KEY_LAST_REVOCATION_SEEN);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const out: Record<string, number> = {};
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof v === "number") out[k] = v;
      }
      return out;
    }
  } catch {
    // fall through
  }
  return {};
}

/**
 * Whether a (vault_id, device_id) is revoked. Read by the chain handshake
 * before accepting a peer. A row with lifted_at IS NOT NULL means the device
 * was removed-then-re-added → treat as NOT revoked (ENG #8), so a re-paired
 * device isn't permanently rejected.
 */
export async function isRevoked(vaultId: string, deviceId: string): Promise<boolean> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ revoked_at: number; lifted_at: number | null }>(
    `SELECT revoked_at, lifted_at FROM revocation_list
      WHERE vault_id = ? AND device_id = ?`,
    vaultId,
    deviceId,
  );
  if (!row) return false;
  return row.lifted_at == null;
}
