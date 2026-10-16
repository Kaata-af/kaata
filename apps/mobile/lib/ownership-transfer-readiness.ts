import { getDb, getInstallIdSync } from "./db-tx";
import { getDeviceSigner } from "./mesh/device-key";
import { ensureChainBackfill } from "./trust/backfill";
import type { MembershipState } from "./trust/chain";
import { getLocalMembershipState } from "./trust/proof";

export class OwnershipSignerNotReadyError extends Error {
  readonly kind = "ownership_signer_not_ready" as const;
  constructor() {
    super("Ownership transfer is waiting for verified membership proof");
    this.name = "OwnershipSignerNotReadyError";
  }
}

function isActiveOwnerDevice(
  state: MembershipState | null,
  pubkey: string,
  requireCurrentInstall: boolean,
): boolean {
  if (!state?.hasGenesis) return false;
  const device = state.devices.get(pubkey);
  const member = device ? state.members.get(device.account_id) : null;
  return !!(
    device &&
    !device.removed &&
    (!requireCurrentInstall || device.device_id === getInstallIdSync()) &&
    member &&
    !member.removed &&
    member.role === "owner"
  );
}

/** Run before taking the session or event lock: repairing a rotated device's
 * admission can register its key and fetch a server witness. A visibility
 * mirror is never proof that the key signing the handover owns the kaata. */
export async function ensureOwnershipTransferSignerReady(
  vaultId: string,
  toAccountId: string,
): Promise<string> {
  // Repair first. In particular a retired anchor must not qualify a new,
  // unbound signing key just because both belong to this physical phone.
  const signer = await getDeviceSigner({ interactive: true });
  const db = await getDb();
  const vault = await db.getFirstAsync<{ vault_trust_anchor_pubkey: string | null }>(
    "SELECT vault_trust_anchor_pubkey FROM vaults WHERE id = ?",
    vaultId,
  );
  const ready = async (pubkey: string): Promise<boolean> => {
    const local = await getLocalMembershipState(vaultId);
    const target = local?.members.get(toAccountId);
    if (!local?.hasGenesis || !target || target.removed) return false;
    // The exact root device can issue the existing pair while offline. Every
    // other signer needs a published Owner admission and device binding first.
    const isAnchor = pubkey === vault?.vault_trust_anchor_pubkey;
    const authority = isAnchor ? local : await getLocalMembershipState(vaultId, true);
    // The original root key can survive a reinstall with a new install id.
    // Every ordinary device binding must name the install making the transfer.
    return isActiveOwnerDevice(authority, pubkey, !isAnchor);
  };
  if (
    (await ready(signer.pubkey_b64)) &&
    (await getDeviceSigner({ interactive: true })).pubkey_b64 === signer.pubkey_b64
  )
    return signer.pubkey_b64;

  // Backfill is best effort internally. Recheck even if it throws: another
  // in-flight admission may have finished while this attempt was waiting.
  try {
    await ensureChainBackfill(vaultId);
  } catch {
    // A failed repair cannot authorize a transfer; the proof check below does.
  }
  const current = await getDeviceSigner({ interactive: true });
  if (
    (await ready(current.pubkey_b64)) &&
    (await getDeviceSigner({ interactive: true })).pubkey_b64 === current.pubkey_b64
  )
    return current.pubkey_b64;
  throw new OwnershipSignerNotReadyError();
}
