import { applyForCurrentSession, type SessionSnapshot } from "./auth";
import { getDb, getInstallIdSync } from "./db-tx";
import type { AdminInviteAuthorization, AdminInviteGrant } from "./trust/admin-invite";

/** Sign the selected Admin role before sending its invitation. Publish the
 * existing owner chain so acceptance never needs the owner's phone online. */
export async function createAdminInviteAuthorization(
  vaultId: string,
  recipientAccountId: string,
  session: SessionSnapshot,
  guard: () => void,
): Promise<AdminInviteAuthorization> {
  const current = () => applyForCurrentSession(session, async () => guard());
  await current();
  if (!session.jwt || !session.accountId) throw new Error("not signed in");
  const [Crypto, keys, proof, backfill, signatures, grants, push, api] = await Promise.all([
    import("expo-crypto"), import("./mesh/device-key"), import("./trust/proof"),
    import("./trust/backfill"), import("./event-sig"), import("./trust/admin-invite"),
    import("./sync/push"), import("./vault-api"),
  ]);
  await current();
  const signer = await keys.getDeviceSigner();
  await current();
  const local = await applyForCurrentSession(session, async () => {
    guard();
    return (await getDb()).getFirstAsync<{
      id: string; name: string; currency: string; created_at: number;
      vault_trust_anchor_pubkey: string | null;
    }>("SELECT id,name,currency,created_at,vault_trust_anchor_pubkey FROM vaults WHERE id = ?", vaultId);
  });
  await current();
  if (local?.vault_trust_anchor_pubkey) {
    await api.createVaultOnServer({
      vault_id: local.id, name: local.name, currency: local.currency,
      created_at_ms: local.created_at,
      vault_trust_anchor_pubkey: local.vault_trust_anchor_pubkey,
    }, session);
  }
  await current();
  await backfill.ensureChainBackfill(vaultId);
  await current();
  const readOwner = async (publishedOnly = false) => {
    const state = await proof.getLocalMembershipState(vaultId, publishedOnly);
    await current();
    const device = state?.devices.get(signer.pubkey_b64);
    const member = device ? state?.members.get(device.account_id) : null;
    return state?.hasGenesis && device && !device.removed && device.device_id === getInstallIdSync() &&
      member && !member.removed && member.role === "owner" ? { member, device } : null;
  };
  for (let attempt = 0; attempt < 5; attempt++) {
    const result = await push.pushEvents(vaultId);
    await current();
    if (result.rejected || (!result.pushed && !result.duplicates)) break;
  }
  const source = await readOwner();
  const published = await readOwner(true);
  if (!source || !published || source.device.account_id !== published.device.account_id)
    throw new api.ApiError(409, "admin_invite_unavailable", "Owner proof is waiting for sync");
  const unsentMembership = await applyForCurrentSession(session, async () => {
    guard();
    return (await getDb()).getFirstAsync(
      `SELECT 1 AS pending FROM event_log WHERE vault_id = ?
        AND event_type IN ('vault_member_added','vault_member_role_changed','vault_member_removed',
          'vault_device_added','vault_device_removed') AND applied_at IS NOT NULL
        AND quarantine_reason IS NULL AND tombstone_reason IS NULL
        AND server_acked_at IS NULL LIMIT 1`, vaultId,
    );
  });
  await current();
  if (unsentMembership)
    throw new api.ApiError(409, "admin_invite_unavailable", "Owner proof is waiting for sync");
  const lastMembership = await applyForCurrentSession(session, async () => {
    guard();
    return (await getDb()).getFirstAsync<{ latest: number | null }>(
      `SELECT MAX(hlc_physical_ms) AS latest FROM event_log WHERE vault_id = ?
        AND event_type IN ('vault_member_added','vault_member_role_changed','vault_member_removed',
          'vault_device_added','vault_device_removed') AND applied_at IS NOT NULL
        AND quarantine_reason IS NULL AND tombstone_reason IS NULL`, vaultId,
    );
  });
  await current();
  const issued = Math.max(Date.now(), (lastMembership?.latest ?? 0) + 1);
  const grant: AdminInviteGrant = {
    domain: grants.ADMIN_INVITE_GRANT_DOMAIN,
    grant_id: Crypto.randomUUID(), vault_id: vaultId, from_account_id: session.accountId,
    ...(source.device.account_id !== session.accountId
      ? { from_chain_account_id: source.device.account_id } : {}),
    recipient_account_id: recipientAccountId,
    role: "manager", issued_at_ms: issued,
    expires_at_ms: issued + grants.MAX_ADMIN_INVITE_LIFETIME_MS,
  };
  const signature = await signer.sign(grants.adminInviteGrantBytes(grant, signatures.canonicalize));
  await current();
  if (!await readOwner())
    throw new api.ApiError(409, "admin_invite_unavailable", "Owner proof changed before invitation");
  let binary = "";
  for (const byte of signature) binary += String.fromCharCode(byte);
  return { grant, signer_device_pubkey: signer.pubkey_b64, sig_b64: btoa(binary) };
}
