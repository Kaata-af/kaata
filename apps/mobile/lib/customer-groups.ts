import * as Crypto from "expo-crypto";
import { applyForUnchangedLocalSession, captureCurrentSession, type SessionSnapshot } from "./auth";
import {
  getAccountIdSync,
  getActiveVaultIdSyncMaybe,
  getDb,
  getInstallIdSync,
  getLocalSelfUserIdSync,
} from "./db-tx";
import { RoleGateRejectionError } from "./event-log";
import type { CustomerGroupEvent, PersonGroupSetEvent } from "./events";
import { normalizeGroupName, isValidGroupName } from "./group-name";
import { applyEvent } from "./projection";

export type CustomerGroup = { id: string; name: string; member_count: number };
export type CustomerGroupsState = {
  groups: CustomerGroup[];
  groupByPerson: Record<string, string | null>;
};

export async function readCustomerGroups(vaultId: string): Promise<CustomerGroupsState> {
  const db = await getDb();
  const groups = await db.getAllAsync<CustomerGroup>(
    `SELECT g.id,g.name,
    (SELECT COUNT(*) FROM relationships r WHERE r.vault_id=g.vault_id AND r.group_id=g.id
      AND r.archived_at IS NULL) AS member_count
    FROM customer_groups g WHERE g.vault_id=? AND g.archived_at IS NULL ORDER BY g.name,g.id`,
    vaultId,
  );
  const rows = await db.getAllAsync<{ user_id: string; group_id: string | null }>(
    `SELECT r.user_b_id AS user_id,
    g.id AS group_id FROM relationships r LEFT JOIN customer_groups g ON g.vault_id=r.vault_id
      AND g.id=r.group_id AND g.archived_at IS NULL WHERE r.vault_id=? AND r.archived_at IS NULL`,
    vaultId,
  );
  return { groups, groupByPerson: Object.fromEntries(rows.map((r) => [r.user_id, r.group_id])) };
}

function currentContext(vaultId: string) {
  if (getActiveVaultIdSyncMaybe() !== vaultId) throw new Error("group context changed");
  const self = getLocalSelfUserIdSync();
  if (!self) throw new Error("no local self");
  return { self, account: getAccountIdSync() };
}
async function appendGroupEvent(
  vaultId: string,
  targetId: string,
  eventType: CustomerGroupEvent["event_type"] | PersonGroupSetEvent["event_type"],
  payload: { name: string } | { group_id: string | null } | Record<string, never>,
  context: ReturnType<typeof currentContext>,
  session: SessionSnapshot,
) {
  if (getActiveVaultIdSyncMaybe() !== vaultId || getAccountIdSync() !== context.account)
    throw new Error("group context changed");
  const installId = getInstallIdSync();
  const event = {
    event_id: Crypto.randomUUID(),
    event_type: eventType,
    vault_id: vaultId,
    target_id: targetId,
    relationship_id: eventType === "person_group_set" ? targetId : null,
    hlc: { pms: 0, l: 0, did: installId },
    device_id: installId,
    author_user_id_local_only: context.self,
    actor_account_id: context.account,
    payload_schema: 1,
    appended_at: 0,
    server_acked_at: null,
    rejected_at: null,
    origin: "local",
    payload,
  } as CustomerGroupEvent | PersonGroupSetEvent;
  const result = await applyForUnchangedLocalSession(session, () =>
    applyEvent(event, {
      origin: "local",
      preflightAbort: async (tx) => {
        if (getActiveVaultIdSyncMaybe() !== vaultId || getAccountIdSync() !== context.account)
          throw new Error("group context changed");
        if (eventType === "person_group_set") {
          const rel = await tx.getFirstAsync<{ id: string }>(
            "SELECT id FROM relationships WHERE vault_id=? AND id=? AND archived_at IS NULL",
            vaultId,
            targetId,
          );
          if (!rel) throw new Error("person missing");
          const groupId = (payload as { group_id: string | null }).group_id;
          if (
            groupId !== null &&
            !(await tx.getFirstAsync(
              "SELECT id FROM customer_groups WHERE vault_id=? AND id=? AND archived_at IS NULL",
              vaultId,
              groupId,
            ))
          )
            throw new Error("group missing");
        } else if (
          eventType !== "group_created" &&
          !(await tx.getFirstAsync(
            "SELECT id FROM customer_groups WHERE vault_id=? AND id=? AND archived_at IS NULL",
            vaultId,
            targetId,
          ))
        ) {
          throw new Error("group missing");
        }
        if (getActiveVaultIdSyncMaybe() !== vaultId || getAccountIdSync() !== context.account)
          throw new Error("group context changed");
        return false;
      },
    }),
  );
  if (!result.applied) {
    if (result.reason === "role_gate" && result.role_gate)
      throw new RoleGateRejectionError(result.role_gate);
    throw new Error("group event was not applied");
  }
}

export async function saveCustomerGroup(
  vaultId: string,
  id: string | null,
  input: string,
): Promise<string> {
  const context = currentContext(vaultId),
    name = normalizeGroupName(input);
  if (!isValidGroupName(name)) throw new Error("invalid_group_name");
  const session = await captureCurrentSession();
  const db = await getDb();
  const existing = await readCustomerGroups(vaultId);
  if (
    existing.groups.some(
      (g) => g.id !== id && g.name.toLocaleLowerCase() === name.toLocaleLowerCase(),
    )
  )
    throw new Error("duplicate_group_name");
  if (id) {
    const group = await db.getFirstAsync<{ name: string }>(
      "SELECT name FROM customer_groups WHERE vault_id=? AND id=? AND archived_at IS NULL",
      vaultId,
      id,
    );
    if (!group) throw new Error("group missing");
    if (group.name === name) return id;
  }
  const groupId = id ?? Crypto.randomUUID();
  await appendGroupEvent(
    vaultId,
    groupId,
    id ? "group_renamed" : "group_created",
    { name },
    context,
    session,
  );
  return groupId;
}
export async function archiveCustomerGroup(vaultId: string, id: string): Promise<void> {
  const context = currentContext(vaultId);
  const session = await captureCurrentSession();
  await appendGroupEvent(vaultId, id, "group_archived", {}, context, session);
}
export async function assignCustomerGroup(
  vaultId: string,
  personId: string,
  groupId: string | null,
): Promise<void> {
  const context = currentContext(vaultId);
  const session = await captureCurrentSession();
  const db = await getDb();
  const rel = await db.getFirstAsync<{ id: string; group_id: string | null }>(
    "SELECT id,group_id FROM relationships WHERE vault_id=? AND user_b_id=? AND archived_at IS NULL",
    vaultId,
    personId,
  );
  if (!rel) throw new Error("person missing");
  if (groupId !== null) {
    const group = await db.getFirstAsync<{ id: string }>(
      "SELECT id FROM customer_groups WHERE vault_id=? AND id=? AND archived_at IS NULL",
      vaultId,
      groupId,
    );
    if (!group) throw new Error("group missing");
  }
  if (rel.group_id === groupId) return;
  await appendGroupEvent(
    vaultId,
    rel.id,
    "person_group_set",
    { group_id: groupId },
    context,
    session,
  );
}
