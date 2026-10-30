import {
  applyForCurrentSession,
  applyForUnchangedLocalSession,
  captureCurrentSession,
  type SessionSnapshot,
} from "./auth";
import { getBackendUrl } from "./api";
import { getActiveVaultIdSyncMaybe, getDb, type SQLiteTx } from "./db-tx";
import { readVaultRole } from "./use-vault-role";
import { resolveAccountIdCandidates } from "./effective-account";
import { currencyRequestHeaders, ensureCurrencySyncSupported } from "./currency-sync";
import { KAATA_DEFAULT_CREDIT_ID } from "./credit-policy";
import { emitCreditPoliciesChanged } from "./credit-policy-events";
import { Mutex } from "./util/mutex";
import { cacheCreditAlerts, readCreditAlertPolicyInTx } from "./credit-alert-cache";
import {
  creditAlertFingerprint,
  type CreditAlertBalances,
  type CreditAlertGroup,
  type CreditAlertPolicy,
  validCreditAlertPolicy,
} from "./credit-alert-policy";

export { type CreditAlertPolicy, type CreditAlertGroup } from "./credit-alert-policy";
export { cacheCreditAlerts, readCreditAlertPolicyInTx } from "./credit-alert-cache";

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

export async function readCreditAlertPolicy(
  relationshipId: string,
  vaultId = getActiveVaultIdSyncMaybe(),
): Promise<CreditAlertPolicy | null> {
  return vaultId ? readCreditAlertPolicyInTx(await getDb(), vaultId, relationshipId) : null;
}

export async function readCreditAlertSettings(relationshipId: string, vaultId: string) {
  const db = await getDb();
  const policy = await readCreditAlertPolicyInTx(db, vaultId, relationshipId);
  const defaultPolicy =
    relationshipId === KAATA_DEFAULT_CREDIT_ID
      ? null
      : await readCreditAlertPolicyInTx(db, vaultId, KAATA_DEFAULT_CREDIT_ID);
  return { policy, defaultPolicy, effective: policy ?? defaultPolicy };
}

export async function readEffectiveCreditAlertPolicy(
  relationshipId: string,
  vaultId = getActiveVaultIdSyncMaybe(),
): Promise<CreditAlertPolicy | null> {
  return vaultId ? (await readCreditAlertSettings(relationshipId, vaultId)).effective : null;
}

export type CreditAlertCustomer = {
  vault_id: string;
  relationship_id: string;
  person_id: string;
  policy: CreditAlertPolicy;
  sync_pending: boolean;
};

/** Caller applies its account/read-access guard and holds applyEventMutex when
 * combining these policies with balances in one observation. */
export async function listEffectiveCreditAlertCustomers(
  vaultId?: string,
): Promise<CreditAlertCustomer[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<{
    vault_id: string;
    relationship_id: string;
    person_id: string;
    policy_relationship_id: string;
    groups_json: string;
    updated_at_ms: number;
    sync_pending: number;
  }>(
    `SELECT r.vault_id,r.id AS relationship_id,r.user_b_id AS person_id,
       COALESCE(p.relationship_id,d.relationship_id) AS policy_relationship_id,
       COALESCE(p.groups_json,d.groups_json) AS groups_json,
       COALESCE(p.updated_at_ms,d.updated_at_ms) AS updated_at_ms,
       COALESCE(p.sync_pending,d.sync_pending) AS sync_pending
       FROM relationships r JOIN vaults v ON v.id=r.vault_id
       LEFT JOIN credit_alert_policies p ON p.vault_id=r.vault_id AND p.relationship_id=r.id AND p.deleted=0
       LEFT JOIN credit_alert_policies d ON d.vault_id=r.vault_id AND d.relationship_id=? AND d.deleted=0
       WHERE r.archived_at IS NULL AND v.archived_at IS NULL
         AND (p.relationship_id IS NOT NULL OR d.relationship_id IS NOT NULL)
         ${vaultId ? "AND r.vault_id=?" : ""}
       ORDER BY r.vault_id,r.id`,
    KAATA_DEFAULT_CREDIT_ID,
    ...(vaultId ? [vaultId] : []),
  );
  return rows.map((row) => {
    const policy = {
      relationship_id: row.policy_relationship_id,
      groups: JSON.parse(row.groups_json) as unknown,
      updated_at_ms: row.updated_at_ms,
    };
    if (!validCreditAlertPolicy(policy)) throw new Error("Invalid cached credit alert policy");
    return {
      vault_id: row.vault_id,
      relationship_id: row.relationship_id,
      person_id: row.person_id,
      policy,
      sync_pending: !!row.sync_pending,
    };
  });
}

/** Read every denomination needed by a rule from pending-inclusive financial
 * projections. Held/deferred admission intents do not enter this reader. */
export async function creditAlertBalancesInTx(
  tx: SQLiteTx,
  vaultId: string,
  relationshipId: string,
  groups: readonly CreditAlertGroup[],
): Promise<CreditAlertBalances> {
  const { creditAlertBalancesInTx: read } = await import("./credit-limits");
  return read(tx, vaultId, relationshipId, groups);
}

async function requireAuthority(vaultId: string, relationshipId: string, session: SessionSnapshot) {
  if (relationshipId === KAATA_DEFAULT_CREDIT_ID && !session.jwt) {
    const { CreditOnlineSaveRequiredError } = await import("./credit-limits");
    throw new CreditOnlineSaveRequiredError("Default credit alerts require an online save");
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
      throw new Error("Shared credit alerts require sign-in and an online save");
  }
}

async function request(
  vaultId: string,
  session: SessionSnapshot,
  method: "GET" | "PUT" | "DELETE",
  policy?: CreditAlertPolicy,
  relationshipId?: string,
): Promise<{ body: unknown; revision: number }> {
  const base = await getBackendUrl();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    if (method !== "GET") await ensureCurrencySyncSupported(base, session.jwt!, controller.signal);
    const res = await fetch(
      `${base}/v1/sync/credit-alerts?vault_id=${encodeURIComponent(vaultId)}${relationshipId ? `&relationship_id=${encodeURIComponent(relationshipId)}` : ""}`,
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
    if (!res.ok) throw new Error(`Credit alert ${method} ${res.status}`);
    const rawRevision = res.headers.get("X-Kaata-Credit-Updated-At");
    const revision = rawRevision != null && /^\d+$/.test(rawRevision) ? Number(rawRevision) : NaN;
    if (!Number.isSafeInteger(revision) || revision < 0)
      throw new Error("Invalid credit alert revision response");
    if (method === "DELETE") {
      if (res.status !== 204) throw new Error("Invalid credit alert reset response");
      return { body: null, revision };
    }
    return { body: await res.json(), revision };
  } finally {
    clearTimeout(timer);
  }
}

async function saveInner(vaultId: string, policy: CreditAlertPolicy, session: SessionSnapshot) {
  if (!validCreditAlertPolicy(policy)) throw new Error("Invalid credit alert policy");
  await requireAuthority(vaultId, policy.relationship_id, session);
  let saved = { ...policy, updated_at_ms: Date.now() };
  if (session.jwt) {
    const { pushEvents } = await import("./sync/push");
    await pushEvents(vaultId);
    const { body, revision } = await request(vaultId, session, "PUT", policy);
    if (
      !validCreditAlertPolicy(body) ||
      body.updated_at_ms !== revision ||
      body.relationship_id !== policy.relationship_id ||
      creditAlertFingerprint(body) !== creditAlertFingerprint(policy)
    )
      throw new Error("Invalid credit alert response");
    saved = body;
  }
  await applyForUnchangedLocalSession(session, async () => {
    const { applyEventMutex } = await import("./projection");
    const db = await getDb();
    await applyEventMutex.runExclusive(() =>
      db.withTransactionAsync(async () => {
        await db.runAsync(
          `INSERT INTO credit_alert_policies(vault_id,relationship_id,groups_json,updated_at_ms,sync_pending)
           VALUES(?,?,?,?,?) ON CONFLICT(vault_id,relationship_id) DO UPDATE SET groups_json=excluded.groups_json,
           updated_at_ms=excluded.updated_at_ms,sync_pending=excluded.sync_pending,deleted=0
           WHERE credit_alert_policies.sync_pending=1 OR credit_alert_policies.updated_at_ms<=excluded.updated_at_ms`,
          vaultId,
          saved.relationship_id,
          JSON.stringify(saved.groups),
          saved.updated_at_ms,
          session.jwt ? 0 : 1,
        );
      }),
    );
    changed(vaultId);
  });
  return saved;
}

export async function saveCreditAlertPolicy(
  vaultId: string,
  policy: CreditAlertPolicy,
  expected?: SessionSnapshot,
): Promise<CreditAlertPolicy> {
  const session = expected ?? (await captureCurrentSession());
  // Freeze the submitted draft before waiting on another configuration write.
  const copy = JSON.parse(JSON.stringify(policy)) as CreditAlertPolicy;
  return mutex(vaultId).runExclusive(() => saveInner(vaultId, copy, session));
}

export async function deleteCreditAlertPolicy(
  vaultId: string,
  relationshipId: string,
  expected?: SessionSnapshot,
): Promise<void> {
  const session = expected ?? (await captureCurrentSession());
  await mutex(vaultId).runExclusive(async () => {
    await requireAuthority(vaultId, relationshipId, session);
    const revision = session.jwt
      ? (await request(vaultId, session, "DELETE", undefined, relationshipId)).revision
      : null;
    await applyForUnchangedLocalSession(session, async () => {
      const { applyEventMutex } = await import("./projection");
      const db = await getDb();
      await applyEventMutex.runExclusive(() =>
        db.withTransactionAsync(async () => {
          // Keep a cache-only tombstone so a snapshot requested before reset
          // cannot resurrect the customer's old override after the DELETE.
          if (revision != null)
            await db.runAsync(
              `INSERT INTO credit_alert_policies(vault_id,relationship_id,groups_json,updated_at_ms,sync_pending,deleted)
             VALUES(?,?,'[]',?,0,1) ON CONFLICT(vault_id,relationship_id) DO UPDATE SET
             groups_json='[]',updated_at_ms=excluded.updated_at_ms,sync_pending=0,deleted=1
             WHERE credit_alert_policies.sync_pending=1 OR credit_alert_policies.updated_at_ms<=excluded.updated_at_ms`,
              vaultId,
              relationshipId,
              revision,
            );
          else
            await db.runAsync(
              `INSERT INTO credit_alert_policies(vault_id,relationship_id,groups_json,updated_at_ms,sync_pending,deleted)
             VALUES(?,?,'[]',0,0,1) ON CONFLICT(vault_id,relationship_id) DO UPDATE SET
             groups_json='[]',updated_at_ms=CASE WHEN credit_alert_policies.sync_pending=0 THEN credit_alert_policies.updated_at_ms ELSE 0 END,sync_pending=0,deleted=1`,
              vaultId,
              relationshipId,
            );
        }),
      );
      changed(vaultId);
    });
  });
}

export async function uploadPendingCreditAlerts(
  vaultId: string,
  expected?: SessionSnapshot,
): Promise<void> {
  const session = expected ?? (await captureCurrentSession());
  if (!session.jwt) return;
  await mutex(vaultId).runExclusive(async () => {
    const role = await readVaultRole(vaultId, session.accountId);
    if (role !== "owner" && role !== "manager") return;
    const db = await getDb();
    const pending = await db.getAllAsync<{ relationship_id: string }>(
      "SELECT relationship_id FROM credit_alert_policies WHERE vault_id=? AND sync_pending=1 AND deleted=0",
      vaultId,
    );
    for (const row of pending) {
      const policy = await readCreditAlertPolicyInTx(db, vaultId, row.relationship_id);
      if (policy) await saveInner(vaultId, policy, session);
    }
  });
}

export async function refreshCreditAlerts(
  vaultId: string,
  expected?: SessionSnapshot,
): Promise<void> {
  const session = expected ?? (await captureCurrentSession());
  if (!session.jwt) return;
  await uploadPendingCreditAlerts(vaultId, session);
  const version = versions.get(vaultId) ?? 0;
  const { body: policies, revision } = await request(vaultId, session, "GET");
  if (
    !Array.isArray(policies) ||
    policies.some((p) => !validCreditAlertPolicy(p) || p.updated_at_ms > revision)
  )
    throw new Error("Invalid credit alert response");
  await applyForCurrentSession(session, async () => {
    const { applyEventMutex } = await import("./projection");
    const db = await getDb();
    let updated = false;
    await applyEventMutex.runExclusive(() =>
      db.withTransactionAsync(async () => {
        if ((versions.get(vaultId) ?? 0) !== version) return;
        // The complete observation uses the server's revision and our local
        // version guard. A newer snapshot cache is protected by the cutoff.
        updated = await cacheCreditAlerts(
          db,
          vaultId,
          policies as CreditAlertPolicy[],
          revision,
          true,
        );
      }),
    );
    // A second in-flight GET must not overwrite this newer observation.
    if (updated) changed(vaultId);
  });
}
