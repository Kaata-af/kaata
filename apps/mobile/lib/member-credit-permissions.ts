import { getBackendUrl } from "./api";
import { applyForCurrentSession, captureCurrentSession, type SessionSnapshot } from "./auth";
import { emitCreditPoliciesChanged } from "./credit-policy-events";
import { getDb } from "./db-tx";
import { Mutex } from "./util/mutex";

/** A member exception to the customer's chosen hard-limit rule. Warn-only
 * policies always remain warnings; owner/admin authority is never reduced. */
export type MemberCreditPermission = "inherit" | "enforce" | "bypass";
export class MemberCreditPermissionError extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = "MemberCreditPermissionError";
  }
}
type MemberCreditPermissionRow = {
  account_id: string;
  credit_limit_override: MemberCreditPermission;
  updated_at_ms: number;
};

const locks = new Map<string, Mutex>();
function lock(vaultId: string): Mutex {
  let mutex = locks.get(vaultId);
  if (!mutex) locks.set(vaultId, (mutex = new Mutex()));
  return mutex;
}

export function isMemberCreditPermission(value: unknown): value is MemberCreditPermission {
  return value === "inherit" || value === "enforce" || value === "bypass";
}

function validRow(value: unknown): value is MemberCreditPermissionRow {
  if (!value || typeof value !== "object") return false;
  const row = value as MemberCreditPermissionRow;
  return (
    typeof row.account_id === "string" &&
    row.account_id.length > 0 &&
    isMemberCreditPermission(row.credit_limit_override) &&
    Number.isSafeInteger(row.updated_at_ms) &&
    row.updated_at_ms >= 0
  );
}

async function request(
  session: SessionSnapshot,
  path: string,
  value?: MemberCreditPermission,
): Promise<unknown> {
  if (!session.jwt || !session.accountId) throw new Error("Sign in to change member permissions");
  await applyForCurrentSession(session, async () => {});
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const base = await getBackendUrl();
    const response = await fetch(`${base}${path}`, {
      method: value === undefined ? "GET" : "PUT",
      headers: {
        Authorization: `Bearer ${session.jwt}`,
        ...(value === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(value === undefined ? {} : { body: JSON.stringify({ credit_limit_override: value }) }),
      signal: controller.signal,
    });
    // Missing endpoints, refused access and network failures must never erase
    // an existing restriction or be presented as a successful save.
    if (!response.ok) {
      const failure = (await response.json().catch(() => null)) as {
        error_code?: unknown;
        reason?: unknown;
      } | null;
      const reason = typeof failure?.error_code === "string" ? failure.error_code : failure?.reason;
      throw new MemberCreditPermissionError(
        typeof reason === "string" ? reason : `member_credit_permission_${response.status}`,
      );
    }
    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

export async function readMemberCreditPermission(
  vaultId: string,
  accountId: string,
): Promise<MemberCreditPermission> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ credit_limit_override: string }>(
    "SELECT credit_limit_override FROM vault_member_credit_permissions WHERE vault_id=? AND account_id=?",
    vaultId,
    accountId,
  );
  if (!row) return "inherit";
  // A malformed cached exception must not accidentally grant a bypass.
  return isMemberCreditPermission(row.credit_limit_override)
    ? row.credit_limit_override
    : "enforce";
}

export async function refreshMemberCreditPermissions(
  vaultId: string,
  expected?: SessionSnapshot,
): Promise<void> {
  const session = expected ?? (await captureCurrentSession());
  if (!session.jwt) return;
  await lock(vaultId).runExclusive(async () => {
    const result = await request(
      session,
      `/v1/vaults/${encodeURIComponent(vaultId)}/credit-permissions`,
    );
    if (!Array.isArray(result) || !result.every(validRow))
      throw new Error("Invalid member credit permissions response");
    const rows = result as MemberCreditPermissionRow[];
    if (new Set(rows.map((row) => row.account_id)).size !== rows.length)
      throw new Error("Duplicate member credit permissions response");
    await applyForCurrentSession(session, async () => {
      const { applyEventMutex } = await import("./projection");
      const db = await getDb();
      await applyEventMutex.runExclusive(() =>
        db.withTransactionAsync(async () => {
          await db.runAsync(
            "DELETE FROM vault_member_credit_permissions WHERE vault_id=?",
            vaultId,
          );
          for (const row of rows) {
            await db.runAsync(
              "INSERT INTO vault_member_credit_permissions(vault_id,account_id,credit_limit_override,updated_at_ms) VALUES(?,?,?,?)",
              vaultId,
              row.account_id,
              row.credit_limit_override,
              row.updated_at_ms,
            );
          }
        }),
      );
      emitCreditPoliciesChanged(vaultId);
    });
  });
}

export async function saveMemberCreditPermission(
  vaultId: string,
  accountId: string,
  value: MemberCreditPermission,
  expected?: SessionSnapshot,
): Promise<void> {
  if (!isMemberCreditPermission(value)) throw new Error("Invalid member credit permission");
  const session = expected ?? (await captureCurrentSession());
  await lock(vaultId).runExclusive(async () => {
    const row = await request(
      session,
      `/v1/vaults/${encodeURIComponent(vaultId)}/members/${encodeURIComponent(accountId)}/credit-permission`,
      value,
    );
    if (!validRow(row) || row.account_id !== accountId || row.credit_limit_override !== value)
      throw new Error("Invalid saved member credit permission");
    await applyForCurrentSession(session, async () => {
      const { applyEventMutex } = await import("./projection");
      const db = await getDb();
      await applyEventMutex.runExclusive(() =>
        db.runAsync(
          "INSERT INTO vault_member_credit_permissions(vault_id,account_id,credit_limit_override,updated_at_ms) VALUES(?,?,?,?) ON CONFLICT(vault_id,account_id) DO UPDATE SET credit_limit_override=excluded.credit_limit_override,updated_at_ms=excluded.updated_at_ms WHERE vault_member_credit_permissions.updated_at_ms<=excluded.updated_at_ms",
          vaultId,
          row.account_id,
          row.credit_limit_override,
          row.updated_at_ms,
        ),
      );
      emitCreditPoliciesChanged(vaultId);
    });
  });
}
