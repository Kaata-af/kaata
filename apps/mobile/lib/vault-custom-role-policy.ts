import { getAppMetaInTx, type SQLiteTx } from "./db-tx";
import type { EventType } from "./events";
import { canPerformAction, type VaultAction, type VaultRole } from "./vault-roles";

const presetActions = {
  "entry.create": "entry.create",
  "entry.amend": "entry.amend",
  "entry.delete": "entry.delete",
  "person.add": "person.add",
  "person.edit": "person.rename",
  "group.manage": "group.manage",
  "tally_note.add": "tally_note.add",
  "tally_note.remove": "tally_note.remove",
  "vault.settings": "vault.rename",
  "vault.members": "vault.invite_member",
} as const satisfies Record<string, VaultAction>;

export type CustomRolePermission = keyof typeof presetActions;
export type CustomRolePreset = Exclude<VaultRole, "owner">;
export type CustomVaultRole = {
  id: string;
  name: string;
  base_role: CustomRolePreset;
  permissions: CustomRolePermission[];
};

export function customRolePermissionsForPreset(preset: CustomRolePreset): CustomRolePermission[] {
  return (Object.keys(presetActions) as CustomRolePermission[]).filter((permission) =>
    canPerformAction(preset, presetActions[permission]),
  );
}

export function isCustomVaultRole(value: unknown): value is CustomVaultRole {
  if (value === null || typeof value !== "object") return false;
  const { id, name, base_role, permissions } = value as Partial<CustomVaultRole>;
  if (
    typeof id !== "string" ||
    !id ||
    typeof name !== "string" ||
    !name ||
    (base_role !== "manager" &&
      base_role !== "editor" &&
      base_role !== "clerk" &&
      base_role !== "viewer") ||
    !Array.isArray(permissions)
  )
    return false;
  const allowed = customRolePermissionsForPreset(base_role);
  return permissions.every((permission) => allowed.includes(permission));
}

const eventPermissions: Partial<Record<EventType, CustomRolePermission>> = {
  entry_created: "entry.create",
  entry_amended: "entry.amend",
  entry_settled: "entry.amend",
  entry_deleted: "entry.delete",
  person_added: "person.add",
  person_renamed: "person.edit",
  person_phone_changed: "person.edit",
  person_default_currency_set: "person.edit",
  person_note_set: "person.edit",
  person_archived: "person.edit",
  person_unarchived: "person.edit",
  group_created: "group.manage",
  group_renamed: "group.manage",
  group_archived: "group.manage",
  person_group_set: "group.manage",
  tally_note_added: "tally_note.add",
  tally_note_removed: "tally_note.remove",
  shop_profile_updated: "vault.settings",
  vault_setting_set: "vault.settings",
  // Membership management is checked by the server. These signed event
  // types also carry self-admission and self-leave, which staff can still do.
};

const otherActions: Partial<Record<VaultAction, CustomRolePermission>> = {
  "person.rename": "person.edit",
  "person.change_phone": "person.edit",
  "person.set_default_currency": "person.edit",
  "person.archive": "person.edit",
  "person.set_group": "group.manage",
  "credit.configure": "vault.settings",
  "vault.rename": "vault.settings",
  "vault.invite_member": "vault.members",
  "vault.change_member_role": "vault.members",
};

export function customRoleCacheKey(vaultId: string, accountId: string): string {
  return `vault_custom_role:${vaultId}:${accountId}`;
}

type CachedCustomRole = CustomVaultRole | "unreadable" | null;

export async function readCachedCustomRole(
  db: SQLiteTx,
  vaultId: string,
  accountId: string | null,
): Promise<CachedCustomRole> {
  if (!accountId) return null;
  const raw = await getAppMetaInTx(db, customRoleCacheKey(vaultId, accountId));
  if (raw === null || raw === "null") return null;
  try {
    const role: unknown = JSON.parse(raw);
    return isCustomVaultRole(role) ? role : "unreadable";
  } catch {
    return "unreadable";
  }
}

export function customRoleAllowsAction(role: CachedCustomRole, action: VaultAction): boolean {
  const permission =
    otherActions[action] ??
    (Object.hasOwn(presetActions, action) ? (action as CustomRolePermission) : undefined);
  return (
    !permission || role === null || (role !== "unreadable" && role.permissions.includes(permission))
  );
}

export async function deniedCustomRoleForEvent(
  db: SQLiteTx,
  vaultId: string,
  accountId: string | null,
  type: EventType,
): Promise<CustomRolePreset | null> {
  const permission = eventPermissions[type];
  if (!permission || !accountId) return null;
  const role = await readCachedCustomRole(db, vaultId, accountId);
  if (role === null || (role !== "unreadable" && role.permissions.includes(permission)))
    return null;
  // Ownership can change while this device still has a cached staff role.
  const current = await db.getFirstAsync<{ role: VaultRole }>(
    `SELECT role FROM vault_members_mirror WHERE vault_id=? AND account_id=?
      AND accepted_at IS NOT NULL AND revoked_at IS NULL`,
    vaultId,
    accountId,
  );
  if (current?.role === "owner") return null;
  return role === "unreadable" ? "viewer" : role.base_role;
}
