import { randomUUID } from "expo-crypto";
import { applyForCurrentSession, type SessionSnapshot } from "./auth";
import { getInstallIdSync } from "./db-tx";
import { signEvent } from "./event-sig";
import { getDevicePubkey, getDeviceSigner } from "./mesh/device-key";
import { peopleRequest } from "./people-connections";
import { TabApiError } from "./tabs/errors";

export type MemberReadmission = {
  invite_id: string;
  account_id: string;
  name: string;
  role: "editor" | "clerk" | "viewer";
  device_id: string;
  device_pubkey: string;
  after_ms: number;
};

const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
const DEVICE_KEY = /^[A-Za-z0-9+/]{43}=$/;
const isUUID = (value: unknown): value is string => typeof value === "string" && UUID.test(value);

function validRequest(row: MemberReadmission): boolean {
  return (
    !!row &&
    isUUID(row.invite_id) &&
    isUUID(row.account_id) &&
    isUUID(row.device_id) &&
    typeof row.device_pubkey === "string" &&
    DEVICE_KEY.test(row.device_pubkey) &&
    typeof row.name === "string" &&
    (row.role === "editor" || row.role === "clerk" || row.role === "viewer") &&
    Number.isSafeInteger(row.after_ms) &&
    row.after_ms >= 0 &&
    row.after_ms < Number.MAX_SAFE_INTEGER
  );
}

export async function listMemberReadmissions(
  vaultId: string,
  session: SessionSnapshot,
): Promise<MemberReadmission[]> {
  try {
    const result = await peopleRequest<{ requests: MemberReadmission[] }>(
      "GET",
      `/v1/vaults/${encodeURIComponent(vaultId)}/member-readmissions`,
      undefined,
      session,
    );
    if (!Array.isArray(result?.requests) || !result.requests.every(validRequest)) {
      throw new Error("Invalid member return requests");
    }
    return result.requests;
  } catch (error) {
    // An older server has no owner approval route.
    if (error instanceof TabApiError && error.status === 404) return [];
    throw error;
  }
}

export async function completeMemberReadmission(
  vaultId: string,
  request: MemberReadmission,
  session: SessionSnapshot,
  beforeDispatch: () => void,
): Promise<void> {
  const accountId = session.accountId;
  if (!accountId) throw new Error("An owner session is required");
  beforeDispatch();
  const ready = (await listMemberReadmissions(vaultId, session)).find(
    (row) => row.invite_id === request.invite_id,
  );
  if (
    !ready ||
    ready.account_id !== request.account_id ||
    ready.role !== request.role ||
    ready.device_id !== request.device_id ||
    ready.device_pubkey !== request.device_pubkey
  )
    throw new Error("The member return request changed");

  const signer = await getDeviceSigner();
  await applyForCurrentSession(session, async () => {});
  beforeDispatch();
  const deviceId = getInstallIdSync();
  const stamp = Math.max(Date.now(), ready.after_ms + 1);
  const admission = { account_id: ready.account_id, readmission_invite_id: ready.invite_id };
  const sign = async (eventType: string, target: string, logical: number, payload: unknown) => {
    const eventId = randomUUID();
    const event_sig_b64 = await signEvent(
      {
        event_id: eventId,
        event_type: eventType,
        vault_id: vaultId,
        target_id: target,
        relationship_id: null,
        device_id: deviceId,
        actor_account_id: accountId,
        payload,
        payload_schema: 1,
        hlc: { pms: stamp, l: logical, did: deviceId },
      },
      signer.sign,
    );
    return {
      event_id: eventId,
      event_type: eventType,
      schema_version: 1,
      target_id: target,
      actor_account_id: accountId,
      payload,
      hlc: { physical_ms: stamp, logical, device_id: deviceId },
      signer_device_pubkey: signer.pubkey_b64,
      event_sig_b64,
    };
  };
  const [member, device] = await Promise.all([
    sign("vault_member_added", ready.account_id, 0, { ...admission, role: ready.role }),
    sign("vault_device_added", ready.device_id, 1, {
      ...admission,
      device_id: ready.device_id,
      device_pubkey: ready.device_pubkey,
    }),
  ]);

  const result = await peopleRequest<{ accepted: { event_id: string }[] }>(
    "POST",
    "/v1/sync/member-readmission",
    {
      vault_id: vaultId,
      device_id: deviceId,
      readmission_invite_id: ready.invite_id,
      events: [member, device],
    },
    session,
    () => {
      beforeDispatch();
      if (getInstallIdSync() !== deviceId || getDevicePubkey() !== signer.pubkey_b64) {
        throw new Error("Owner device key changed");
      }
    },
  );
  const accepted = result?.accepted?.map((event) => event.event_id);
  if (
    accepted?.length !== 2 ||
    !accepted.includes(member.event_id) ||
    !accepted.includes(device.event_id)
  ) {
    throw new Error("Could not confirm the restored member and device");
  }
  await import("./sync/pull")
    .then(({ pullEvents }) => pullEvents(vaultId, session))
    .catch(() => {});
}
