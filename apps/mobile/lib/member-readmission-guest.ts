// Returning members need a fresh owner-signed membership AND exact phone
// binding. A consent response or server witness cannot lift chain removals.
import { applyForCurrentSession, type SessionSnapshot } from "./auth";
import { getDb, getInstallIdSync } from "./db-tx";
import { getDevicePubkey, ensureDeviceKey } from "./mesh/device-key";
import {
  getLocalMembershipState,
  loadLocalMembershipEvents,
  PROOF_BUNDLE_CAP,
} from "./trust/proof";
import { type AcceptInviteResult } from "./vault-api";

/** Require this exact approval, not a surviving proof from an earlier join. */
export async function isMemberReadmissionPublished(
  result: AcceptInviteResult,
  session: SessionSnapshot,
): Promise<boolean> {
  return applyForCurrentSession(session, async () => {
    if (
      !result.member_readmission ||
      result.readmission_pending ||
      !session.accountId ||
      result.readmission_device_id !== getInstallIdSync() ||
      result.readmission_device_pubkey !== getDevicePubkey() ||
      !result.readmission_member_event_id ||
      !result.readmission_device_event_id ||
      !result.readmission_invite_id
    )
      return false;
    // A truncated prefix may omit a later removal. Never use it as authority.
    if (
      (await loadLocalMembershipEvents(result.vault_id, PROOF_BUNDLE_CAP + 1)).length >
      PROOF_BUNDLE_CAP
    )
      return false;
    const events = await loadLocalMembershipEvents(result.vault_id, PROOF_BUNDLE_CAP, true);
    const memberEvent = events.find(
      (event) => event.event_id === result.readmission_member_event_id,
    );
    const deviceEvent = events.find(
      (event) => event.event_id === result.readmission_device_event_id,
    );
    const memberPayload = memberEvent?.payload as Record<string, unknown> | undefined;
    const devicePayload = deviceEvent?.payload as Record<string, unknown> | undefined;
    if (
      !memberEvent ||
      !deviceEvent ||
      !memberPayload ||
      !devicePayload ||
      memberEvent.event_type !== "vault_member_added" ||
      deviceEvent.event_type !== "vault_device_added" ||
      memberPayload.account_id !== session.accountId ||
      devicePayload.account_id !== session.accountId ||
      memberPayload.readmission_invite_id !== result.readmission_invite_id ||
      devicePayload.readmission_invite_id !== result.readmission_invite_id ||
      !["editor", "clerk", "viewer"].includes(String(memberPayload.role)) ||
      devicePayload.device_id !== result.readmission_device_id ||
      devicePayload.device_pubkey !== result.readmission_device_pubkey ||
      memberPayload.witness ||
      devicePayload.witness ||
      memberEvent.signer_device_pubkey !== deviceEvent.signer_device_pubkey
    )
      return false;
    for (const publishedOnly of [true, false]) {
      const state = await getLocalMembershipState(result.vault_id, publishedOnly);
      const member = state?.members.get(session.accountId);
      const device = state?.devices.get(result.readmission_device_pubkey!);
      if (
        !state?.hasGenesis ||
        !member ||
        member.removed ||
        !device ||
        device.removed ||
        device.account_id !== session.accountId ||
        device.device_id !== result.readmission_device_id ||
        state.conflicts.some(
          (conflict) =>
            conflict.event_id === memberEvent.event_id ||
            conflict.event_id === deviceEvent.event_id,
        )
      )
        return false;
    }
    return true;
  });
}

/** Explicit recovery also runs when another (or no) Kaata is active. */
export async function recoverMemberReadmission(
  result: AcceptInviteResult,
  session: SessionSnapshot,
): Promise<{ ready: boolean; archived: boolean }> {
  if (!result.member_readmission || result.readmission_pending)
    return { ready: false, archived: false };
  await applyForCurrentSession(session, () => ensureDeviceKey());
  if (
    result.readmission_device_id !== getInstallIdSync() ||
    result.readmission_device_pubkey !== getDevicePubkey()
  )
    return { ready: false, archived: false };
  const { prepareMemberReadmissionVault } = await import("./recovery");
  if (!(await prepareMemberReadmissionVault(result.vault_id, session)))
    return { ready: false, archived: false };
  const { pullEvents } = await import("./sync/pull");
  await pullEvents(result.vault_id, session, { deferProjection: true });
  if (!(await isMemberReadmissionPublished(result, session)))
    return { ready: false, archived: false };
  const { sweepVaultNow } = await import("./projection/sweep");
  await applyForCurrentSession(session, () => sweepVaultNow(result.vault_id));
  if (!(await isMemberReadmissionPublished(result, session)))
    return { ready: false, archived: false };
  return applyForCurrentSession(session, async () => {
    const db = await getDb();
    const projected = await db.getFirstAsync<{ count: number }>(
      `SELECT COUNT(*) AS count FROM event_log
      WHERE vault_id = ? AND event_id IN (?,?) AND applied_at IS NOT NULL
        AND quarantine_reason IS NULL AND tombstone_reason IS NULL AND server_acked_at IS NOT NULL`,
      result.vault_id,
      result.readmission_member_event_id!,
      result.readmission_device_event_id!,
    );
    const visible = await db.getFirstAsync<{ one: number }>(
      `SELECT 1 AS one FROM vault_members_mirror
      WHERE vault_id = ? AND account_id = ? AND accepted_at IS NOT NULL AND revoked_at IS NULL`,
      result.vault_id,
      session.accountId!,
    );
    if (
      projected?.count !== 2 ||
      !visible ||
      getDevicePubkey() !== result.readmission_device_pubkey
    )
      return { ready: false, archived: false };
    const row = await db.getFirstAsync<{ archived_at: number | null }>(
      "SELECT archived_at FROM vaults WHERE id = ?",
      result.vault_id,
    );
    return { ready: !!row, archived: row?.archived_at != null };
  });
}
