import {
  applyForCurrentSession,
  applyForUnchangedLocalSession,
  captureCurrentSession,
  type SessionSnapshot,
} from "./auth";
import { getBackendUrl } from "./api";
import { getActiveVaultIdSyncMaybe, getDb } from "./db-tx";
import { readVaultRole } from "./use-vault-role";
import { resolveAccountIdCandidates } from "./effective-account";
import { currencyRequestHeaders, ensureCurrencySyncSupported } from "./currency-sync";
import { KAATA_DEFAULT_CREDIT_ID } from "./credit-policy";
import { emitCreditPoliciesChanged } from "./credit-policy-events";
import { Mutex } from "./util/mutex";
import {
  cacheCreditLimitNotifications,
  readCreditLimitNotificationPolicyInTx,
} from "./credit-limit-notification-cache";
import {
  type CreditLimitNotificationPolicy,
  validCreditLimitNotificationPolicy,
} from "./credit-limit-notification-policy";

export type {
  CreditLimitNotificationPolicy,
  CreditLimitNotificationSetting,
} from "./credit-limit-notification-policy";
export {
  cacheCreditLimitNotifications,
  readCreditLimitNotificationPolicyInTx,
  readCreditLimitNotificationSettingInTx,
} from "./credit-limit-notification-cache";

export class CreditLimitNotificationsUnsupportedError extends Error {
  constructor() {
    super("Credit limit notifications require a newer server");
  }
}

const writes = new Map<string, Mutex>();
const versions = new Map<string, number>();
function mutex(vaultId: string): Mutex {
  let value = writes.get(vaultId);
  if (!value) {
    value = new Mutex();
    writes.set(vaultId, value);
  }
  return value;
}
function changed(vaultId: string): void {
  versions.set(vaultId, (versions.get(vaultId) ?? 0) + 1);
  emitCreditPoliciesChanged(vaultId);
}

export async function loadCreditLimitNotificationSettings(vaultId: string, relationshipId: string) {
  const db = await getDb();
  const policy = await readCreditLimitNotificationPolicyInTx(db, vaultId, relationshipId);
  const defaultPolicy =
    relationshipId === KAATA_DEFAULT_CREDIT_ID
      ? null
      : await readCreditLimitNotificationPolicyInTx(db, vaultId, KAATA_DEFAULT_CREDIT_ID);
  return { policy, defaultPolicy, effective: policy ?? defaultPolicy };
}

async function requireAuthority(vaultId: string, relationshipId: string, session: SessionSnapshot) {
  if (relationshipId === KAATA_DEFAULT_CREDIT_ID && !session.jwt) {
    const { CreditOnlineSaveRequiredError } = await import("./credit-limits");
    throw new CreditOnlineSaveRequiredError("Default credit notifications require an online save");
  }
  const role = await readVaultRole(vaultId, session.accountId);
  if (role !== "owner" && role !== "manager") throw new Error("Manager required");
  const db = await getDb();
  const vault = await db.getFirstAsync<{ account_id: string | null }>(
    "SELECT account_id FROM vaults WHERE id=? AND archived_at IS NULL",
    vaultId,
  );
  if (!vault) throw new Error("Kaata unavailable");
  if (relationshipId !== KAATA_DEFAULT_CREDIT_ID) {
    const rel = await db.getFirstAsync<{ id: string }>(
      "SELECT id FROM relationships WHERE vault_id=? AND id=? AND archived_at IS NULL",
      vaultId,
      relationshipId,
    );
    if (!rel) throw new Error("Customer no longer available");
  }
  if (!session.jwt) {
    const mine = await resolveAccountIdCandidates(session.accountId);
    const members = await db.getAllAsync<{ account_id: string }>(
      "SELECT account_id FROM vault_members_mirror WHERE vault_id=?",
      vaultId,
    );
    if (vault.account_id != null || members.some((m) => !mine.includes(m.account_id)))
      throw new Error("Shared credit notifications require sign-in and an online save");
  }
}

async function request(
  vaultId: string,
  session: SessionSnapshot,
  method: "GET" | "PUT" | "DELETE",
  policy?: CreditLimitNotificationPolicy,
  relationshipId?: string,
): Promise<{ body: unknown; revision: number }> {
  const base = await getBackendUrl();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    if (method !== "GET") await ensureCurrencySyncSupported(base, session.jwt!, controller.signal);
    const res = await fetch(
      `${base}/v1/sync/credit-limit-notifications?vault_id=${encodeURIComponent(vaultId)}${relationshipId ? `&relationship_id=${encodeURIComponent(relationshipId)}` : ""}`,
      {
        method,
        headers: {
          ...(await currencyRequestHeaders(await getDb(), vaultId)),
          Authorization: `Bearer ${session.jwt}`,
          ...(policy ? { "Content-Type": "application/json" } : {}),
        },
        ...(policy ? { body: JSON.stringify(policy) } : {}),
        signal: controller.signal,
      },
    );
    if (
      res.status === 404 ||
      (res.ok && res.headers.get("X-Kaata-Credit-Limit-Notifications") !== "1")
    )
      throw new CreditLimitNotificationsUnsupportedError();
    if (!res.ok) throw new Error(`Credit limit notification ${method} ${res.status}`);
    const rawRevision = res.headers.get("X-Kaata-Credit-Updated-At");
    const revision = rawRevision != null && /^\d+$/.test(rawRevision) ? Number(rawRevision) : NaN;
    if (!Number.isSafeInteger(revision) || revision < 0)
      throw new Error("Invalid credit limit notification revision response");
    if (method === "DELETE") {
      if (res.status !== 204) throw new Error("Invalid credit limit notification reset response");
      return { body: null, revision };
    }
    return { body: await res.json(), revision };
  } finally {
    clearTimeout(timer);
  }
}

async function saveInner(
  vaultId: string,
  policy: CreditLimitNotificationPolicy,
  session: SessionSnapshot,
) {
  if (!validCreditLimitNotificationPolicy(policy))
    throw new Error("Invalid credit limit notification policy");
  policy = {
    relationship_id: policy.relationship_id,
    enabled: policy.enabled,
    updated_at_ms: policy.updated_at_ms,
  };
  await requireAuthority(vaultId, policy.relationship_id, session);
  let saved = { ...policy, updated_at_ms: Date.now() };
  if (session.jwt) {
    const { pushEvents } = await import("./sync/push");
    await pushEvents(vaultId);
    const { body, revision } = await request(vaultId, session, "PUT", policy);
    if (
      !validCreditLimitNotificationPolicy(body) ||
      body.updated_at_ms !== revision ||
      body.relationship_id !== policy.relationship_id ||
      body.enabled !== policy.enabled
    )
      throw new Error("Invalid credit limit notification response");
    saved = body;
  }
  await applyForUnchangedLocalSession(session, async () => {
    const { applyEventMutex } = await import("./projection");
    const db = await getDb();
    await applyEventMutex.runExclusive(() =>
      db.withTransactionAsync(async () => {
        await db.runAsync(
          `INSERT INTO customer_credit_limit_notifications(vault_id,relationship_id,enabled,updated_at_ms,sync_pending)
           VALUES(?,?,?,?,?) ON CONFLICT(vault_id,relationship_id) DO UPDATE SET enabled=excluded.enabled,
           updated_at_ms=excluded.updated_at_ms,sync_pending=excluded.sync_pending,deleted=0
           WHERE customer_credit_limit_notifications.sync_pending=1 OR customer_credit_limit_notifications.updated_at_ms<=excluded.updated_at_ms`,
          vaultId,
          saved.relationship_id,
          Number(saved.enabled),
          saved.updated_at_ms,
          session.jwt ? 0 : 1,
        );
      }),
    );
    changed(vaultId);
  });
  return saved;
}

export async function saveCreditLimitNotifications(
  vaultId: string,
  policy: CreditLimitNotificationPolicy,
  expected?: SessionSnapshot,
): Promise<CreditLimitNotificationPolicy> {
  const session = expected ?? (await captureCurrentSession());
  // Freeze only public fields before waiting behind another write. Cached
  // sync metadata is never serialized as part of the server mutation.
  const copy = {
    relationship_id: policy.relationship_id,
    enabled: policy.enabled,
    updated_at_ms: policy.updated_at_ms,
  };
  return mutex(vaultId).runExclusive(() => saveInner(vaultId, copy, session));
}

async function deleteInner(vaultId: string, relationshipId: string, session: SessionSnapshot) {
  await requireAuthority(vaultId, relationshipId, session);
  const revision = session.jwt
    ? (await request(vaultId, session, "DELETE", undefined, relationshipId)).revision
    : Date.now();
  await applyForUnchangedLocalSession(session, async () => {
    const { applyEventMutex } = await import("./projection");
    const db = await getDb();
    await applyEventMutex.runExclusive(() =>
      db.withTransactionAsync(async () => {
        await db.runAsync(
          `INSERT INTO customer_credit_limit_notifications(vault_id,relationship_id,enabled,updated_at_ms,sync_pending,deleted)
           VALUES(?,?,0,?,?,1) ON CONFLICT(vault_id,relationship_id) DO UPDATE SET enabled=0,
           updated_at_ms=excluded.updated_at_ms,sync_pending=excluded.sync_pending,deleted=1
           WHERE customer_credit_limit_notifications.sync_pending=1 OR customer_credit_limit_notifications.updated_at_ms<=excluded.updated_at_ms`,
          vaultId,
          relationshipId,
          revision,
          session.jwt ? 0 : 1,
        );
      }),
    );
    changed(vaultId);
  });
}

export async function deleteCreditLimitNotifications(
  vaultId: string,
  relationshipId: string,
  expected?: SessionSnapshot,
): Promise<void> {
  const session = expected ?? (await captureCurrentSession());
  await mutex(vaultId).runExclusive(() => deleteInner(vaultId, relationshipId, session));
}

export async function uploadPendingCreditLimitNotifications(
  vaultId: string,
  expected?: SessionSnapshot,
): Promise<void> {
  const session = expected ?? (await captureCurrentSession());
  if (!session.jwt) return;
  await mutex(vaultId).runExclusive(async () => {
    const role = await readVaultRole(vaultId, session.accountId);
    if (role !== "owner" && role !== "manager") return;
    const db = await getDb();
    const pending = await db.getAllAsync<{ relationship_id: string; deleted: number }>(
      "SELECT relationship_id,deleted FROM customer_credit_limit_notifications WHERE vault_id=? AND sync_pending=1",
      vaultId,
    );
    for (const row of pending) {
      if (row.deleted) await deleteInner(vaultId, row.relationship_id, session);
      else {
        const policy = await readCreditLimitNotificationPolicyInTx(
          db,
          vaultId,
          row.relationship_id,
        );
        if (policy) await saveInner(vaultId, policy, session);
      }
    }
  });
}

export async function refreshCreditLimitNotifications(
  vaultId = getActiveVaultIdSyncMaybe(),
  expected?: SessionSnapshot,
): Promise<void> {
  const session = expected ?? (await captureCurrentSession());
  if (!session.jwt || !vaultId) return;
  try {
    await uploadPendingCreditLimitNotifications(vaultId, session);
    const version = versions.get(vaultId) ?? 0;
    const { body: policies, revision } = await request(vaultId, session, "GET");
    if (
      !Array.isArray(policies) ||
      policies.some((p) => !validCreditLimitNotificationPolicy(p) || p.updated_at_ms > revision)
    )
      throw new Error("Invalid credit limit notification response");
    await applyForCurrentSession(session, async () => {
      const { applyEventMutex } = await import("./projection");
      const db = await getDb();
      let updated = false;
      await applyEventMutex.runExclusive(() =>
        db.withTransactionAsync(async () => {
          if ((versions.get(vaultId) ?? 0) !== version) return;
          updated = await cacheCreditLimitNotifications(
            db,
            vaultId,
            policies as CreditLimitNotificationPolicy[],
            revision,
            true,
          );
        }),
      );
      if (updated) changed(vaultId);
    });
  } catch (error) {
    // A mixed-version installation can still read/save ordinary limits.
    // Explicit notification saves propagate this error instead of pretending.
    if (!(error instanceof CreditLimitNotificationsUnsupportedError)) throw error;
  }
}
