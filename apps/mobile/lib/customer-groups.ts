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
import { canonicalGroupIds, groupIdsFromPayload, storedGroupIds } from "./group-memberships";
import { applyEvent } from "./projection";

export type CustomerGroup = { id: string; name: string; member_count: number };
export type CustomerGroupsState = {
  groups: CustomerGroup[];
  groupByPerson: Record<string, string | null>;
  groupsByPerson: Record<string, string[]>;
};

export async function readCustomerGroups(vaultId: string): Promise<CustomerGroupsState> {
  const db = await getDb();
  const groups = await db.getAllAsync<CustomerGroup>(
    `SELECT g.id,g.name,COALESCE(counts.member_count,0) AS member_count
    FROM customer_groups g LEFT JOIN (
      SELECT r.vault_id,m.value AS group_id,COUNT(DISTINCT r.id) AS member_count
      FROM relationships r JOIN json_each(COALESCE(r.group_ids,
        CASE WHEN r.group_id IS NULL THEN '[]' ELSE json_array(r.group_id) END)) m
      WHERE r.vault_id=? AND r.archived_at IS NULL GROUP BY r.vault_id,m.value
    ) counts ON counts.vault_id=g.vault_id AND counts.group_id=g.id
    WHERE g.vault_id=? AND g.archived_at IS NULL ORDER BY g.name,g.id`,
    vaultId,
    vaultId,
  );
  const rows = await db.getAllAsync<{
    user_id: string;
    group_id: string | null;
    group_ids: string | null;
  }>(
    `SELECT user_b_id AS user_id,group_id,group_ids FROM relationships
      WHERE vault_id=? AND archived_at IS NULL`,
    vaultId,
  );
  const activeGroups = new Set(groups.map((g) => g.id));
  const groupsByPerson = Object.fromEntries(
    rows.map((r) => [
      r.user_id,
      storedGroupIds(r.group_ids, r.group_id).filter((id) => activeGroups.has(id)),
    ]),
  );
  return {
    groups,
    groupsByPerson,
    groupByPerson: Object.fromEntries(
      Object.entries(groupsByPerson).map(([id, ids]) => [id, ids[0] ?? null]),
    ),
  };
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
  payload: { name: string } | PersonGroupSetEvent["payload"] | Record<string, never>,
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
          const groupIds = groupIdsFromPayload(payload as PersonGroupSetEvent["payload"]);
          for (const groupId of groupIds) {
            if (
              !(await tx.getFirstAsync(
                "SELECT id FROM customer_groups WHERE vault_id=? AND id=? AND archived_at IS NULL",
                vaultId,
                groupId,
              ))
            )
              throw new Error("group missing");
          }
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
  return assignCustomerGroups(vaultId, personId, groupId === null ? [] : [groupId]);
}

export async function assignCustomerGroups(
  vaultId: string,
  personId: string,
  input: readonly string[],
): Promise<void> {
  const context = currentContext(vaultId);
  const groupIds = canonicalGroupIds(input);
  const session = await captureCurrentSession();
  const db = await getDb();
  const rel = await db.getFirstAsync<{
    id: string;
    group_id: string | null;
    group_ids: string | null;
  }>(
    "SELECT id,group_id,group_ids FROM relationships WHERE vault_id=? AND user_b_id=? AND archived_at IS NULL",
    vaultId,
    personId,
  );
  if (!rel) throw new Error("person missing");
  for (const groupId of groupIds) {
    const group = await db.getFirstAsync<{ id: string }>(
      "SELECT id FROM customer_groups WHERE vault_id=? AND id=? AND archived_at IS NULL",
      vaultId,
      groupId,
    );
    if (!group) throw new Error("group missing");
  }
  if (JSON.stringify(storedGroupIds(rel.group_ids, rel.group_id)) === JSON.stringify(groupIds))
    return;
  await appendGroupEvent(
    vaultId,
    rel.id,
    "person_group_set",
    { group_id: groupIds[0] ?? null, group_ids: groupIds },
    context,
    session,
  );
}
