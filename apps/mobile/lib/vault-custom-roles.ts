import { getBackendUrl } from "./api";
import { applyForCurrentSession, captureCurrentSession, type SessionSnapshot } from "./auth";
import { getAppMetaInTx, getDb, setAppMetaInTx } from "./db-tx";
import { Mutex } from "./util/mutex";
import {
  customRoleCacheKey,
  isCustomVaultRole,
  type CustomVaultRole,
} from "./vault-custom-role-policy";

export { customRolePermissionsForPreset } from "./vault-custom-role-policy";
export type {
  CustomRolePermission,
  CustomRolePreset,
  CustomVaultRole,
} from "./vault-custom-role-policy";

export type CustomRoleSnapshot = {
  roles: CustomVaultRole[];
  assignments: { account_id: string; role_id: string }[];
  effective_role: CustomVaultRole | null;
};
type RoleDraft = Omit<CustomVaultRole, "id">;

export class CustomRoleError extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = "CustomRoleError";
  }
}

const requests = new Mutex();

async function request(
  session: SessionSnapshot,
  path: string,
  method: "GET" | "POST" | "PUT" | "DELETE" = "GET",
  body?: RoleDraft | { role_id: string | null },
): Promise<unknown> {
  if (!session.jwt || !session.accountId) throw new CustomRoleError("sign_in_required");
  const base = await getBackendUrl();
  await applyForCurrentSession(session, async () => {});
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${session.jwt}`,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    if (!response.ok) {
      const failure = await response.json().catch(() => null);
      const reason = failure?.error_code ?? failure?.reason ?? failure?.error;
      throw new CustomRoleError(
        typeof reason === "string" ? reason : `custom_role_${response.status}`,
      );
    }
    return response.status === 204 ? null : await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

function pathFor(vaultId: string): string {
  return `/v1/vaults/${encodeURIComponent(vaultId)}`;
}

function parseSnapshot(value: unknown): CustomRoleSnapshot {
  const result = value as Partial<CustomRoleSnapshot> | null;
  if (
    !result ||
    !Array.isArray(result.roles) ||
    !result.roles.every(isCustomVaultRole) ||
    !Array.isArray(result.assignments) ||
    !result.assignments.every(
      (row) =>
        row &&
        typeof row.account_id === "string" &&
        typeof row.role_id === "string" &&
        result.roles!.some((role) => role.id === row.role_id),
    ) ||
    (result.effective_role !== null && !isCustomVaultRole(result.effective_role))
  ) {
    throw new CustomRoleError("invalid_custom_roles_response");
  }
  return result as CustomRoleSnapshot;
}

export async function readCustomRoles(
  vaultId: string,
  expected?: SessionSnapshot,
): Promise<CustomRoleSnapshot> {
  const session = expected ?? (await captureCurrentSession());
  return requests.runExclusive(async () => {
    const result = parseSnapshot(await request(session, `${pathFor(vaultId)}/custom-roles`));
    const { applyEventMutex } = await import("./projection");
    const changed = await applyForCurrentSession(session, () =>
      applyEventMutex.runExclusive(async () => {
        const db = await getDb();
        const key = customRoleCacheKey(vaultId, session.accountId!);
        const previous = await getAppMetaInTx(db, key);
        const next = JSON.stringify(result.effective_role);
        if ((previous ?? "null") === next) return false;
        await setAppMetaInTx(db, key, next);
        return true;
      }),
    );
    if (changed) {
      const { invalidateVaultRoleCache } = await import("./use-vault-role");
      invalidateVaultRoleCache(vaultId);
    }
    return result;
  });
}

export async function saveCustomRole(
  vaultId: string,
  draft: RoleDraft,
  roleId?: string,
  expected?: SessionSnapshot,
): Promise<void> {
  const session = expected ?? (await captureCurrentSession());
  const path = `${pathFor(vaultId)}/custom-roles`;
  await requests.runExclusive(() =>
    roleId
      ? request(session, `${path}/${encodeURIComponent(roleId)}`, "PUT", draft)
      : request(session, path, "POST", draft),
  );
}

export async function deleteCustomRole(
  vaultId: string,
  roleId: string,
  expected?: SessionSnapshot,
): Promise<void> {
  const session = expected ?? (await captureCurrentSession());
  await requests.runExclusive(() =>
    request(session, `${pathFor(vaultId)}/custom-roles/${encodeURIComponent(roleId)}`, "DELETE"),
  );
}

export async function assignCustomRole(
  vaultId: string,
  accountId: string,
  roleId: string | null,
  expected?: SessionSnapshot,
): Promise<void> {
  const session = expected ?? (await captureCurrentSession());
  await requests.runExclusive(() =>
    request(
      session,
      `${pathFor(vaultId)}/members/${encodeURIComponent(accountId)}/custom-role`,
      "PUT",
      { role_id: roleId },
    ),
  );
}
