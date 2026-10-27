import { applyForUnchangedLocalSession, captureCurrentSession, type SessionSnapshot } from "./auth";
import { getDb } from "./db-tx";
import { appendVaultSettingSet } from "./event-log";
import { applyEventMutex } from "./projection";

const KEY = "share_bill_links";

/** Existing books include bill links. Only an explicit saved OFF disables them. */
export async function getBillLinksEnabled(vaultId: string): Promise<boolean> {
  // The shared SQLite connection can expose another async transaction's
  // uncommitted value. Wait for projection commit/rollback before authorizing
  // bill creation, especially when a saved OFF is temporarily being changed.
  return applyEventMutex.runExclusive(async () => {
    const db = await getDb();
    const row = await db.getFirstAsync<{ value: string | null }>(
      "SELECT value FROM vault_settings WHERE vault_id=? AND key=?",
      vaultId,
      KEY,
    );
    return row?.value !== "false";
  });
}

/** Signed, per-Kaata preference using the ordinary manager/owner role gate. */
export async function changeBillLinksEnabled(
  vaultId: string,
  enabled: boolean,
  expected?: { session?: SessionSnapshot; shouldContinue?: () => boolean },
): Promise<void> {
  if (typeof vaultId !== "string" || !vaultId.trim() || typeof enabled !== "boolean")
    throw new Error("Invalid bill link preference");
  const session = expected?.session ?? (await captureCurrentSession());
  await applyForUnchangedLocalSession(session, async () => {
    const checkScope = () => {
      if (expected?.shouldContinue?.() === false)
        throw new Error("Bill link settings changed scope");
    };
    checkScope();
    await appendVaultSettingSet({
      targetVaultId: vaultId,
      key: KEY,
      value: enabled ? "true" : "false",
      preflight: async (tx) => {
        checkScope();
        const row = await tx.getFirstAsync<{ id: string }>(
          "SELECT id FROM vaults WHERE id=?",
          vaultId,
        );
        if (!row) throw new Error("The Kaata no longer exists");
        checkScope();
      },
    });
  });
}
