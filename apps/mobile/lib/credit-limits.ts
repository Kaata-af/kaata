import { type CreditPolicy, creditExceeded, validCreditPolicy } from "./credit-policy";
export { type CreditPolicy, creditExceeded, validCreditPolicy } from "./credit-policy";
import { cacheCreditPolicies } from "./credit-policy-cache";
import type { SQLiteTx } from "./db-tx";
import { getActiveVaultIdSyncMaybe, getDb } from "./db-tx";
import {
  applyForCurrentSession,
  applyForUnchangedLocalSession,
  captureCurrentSession,
  type SessionSnapshot,
} from "./auth";
import { getBackendUrl } from "./api";
import { readVaultRole } from "./use-vault-role";
import { toMinorUnits } from "./money";
import { signedEntryMinorSumSql } from "./money-sql";
import { emitCreditPoliciesChanged } from "./credit-policy-events";
import { Mutex } from "./util/mutex";
import { resolveAccountIdCandidates } from "./effective-account";

export class ClerkCloudEnrollmentRequiredError extends Error {}
export class CreditOnlineSaveRequiredError extends Error {}
async function requirePolicyResponse(res: Response, action: string): Promise<void> {
  if (res.ok) return;
  const problem = (await res.json().catch(() => null)) as { error_code?: string } | null;
  if (problem?.error_code === "clerk_cloud_enrollment_required")
    throw new ClerkCloudEnrollmentRequiredError("Every clerk must sign in and sync first");
  throw new Error(`Credit policy ${action} ${res.status}`);
}

const policyWrites = new Map<string, Mutex>();
const policyVersions = new Map<string, number>();
function policyMutex(vaultId: string): Mutex {
  let mutex = policyWrites.get(vaultId);
  if (!mutex) {
    mutex = new Mutex();
    policyWrites.set(vaultId, mutex);
  }
  return mutex;
}
function changed(vaultId: string): void {
  policyVersions.set(vaultId, (policyVersions.get(vaultId) ?? 0) + 1);
  emitCreditPoliciesChanged(vaultId);
}

export async function relationshipForCredit(
  personId: string,
  vaultId = getActiveVaultIdSyncMaybe(),
): Promise<string> {
  if (!vaultId) throw new Error("No active kaata");
  const db = await getDb();
  const row = await db.getFirstAsync<{ id: string }>(
    "SELECT id FROM relationships WHERE vault_id=? AND user_b_id=? AND archived_at IS NULL ORDER BY created_at DESC LIMIT 1",
    vaultId,
    personId,
  );
  if (!row) throw new Error("Customer no longer available");
  return row.id;
}

export async function readCreditPolicy(
  relationshipId: string,
  vaultId = getActiveVaultIdSyncMaybe(),
): Promise<CreditPolicy | null> {
  if (!vaultId) return null;
  const db = await getDb();
  return db.getFirstAsync<CreditPolicy>(
    "SELECT relationship_id,max_collect_minor,max_pay_minor,mode,updated_at_ms FROM customer_credit_limits WHERE vault_id=? AND relationship_id=?",
    vaultId,
    relationshipId,
  );
}

export async function creditBalanceInTx(
  tx: SQLiteTx,
  vaultId: string,
  relationshipId: string,
): Promise<number> {
  const link = await tx.getFirstAsync<{ tab_id: string; role: "a" | "b"; linked_at: number }>(
    "SELECT tab_id,role,linked_at FROM tab_links WHERE vault_id=? AND relationship_id=? ORDER BY (closed_at IS NULL) DESC,linked_at DESC LIMIT 1",
    vaultId,
    relationshipId,
  );
  const local = await tx.getFirstAsync<{ balance: number }>(
    `SELECT ${signedEntryMinorSumSql("e", "e.disputed_at IS NULL AND (? IS NULL OR e.created_at > ?)")} AS balance FROM entries e WHERE e.vault_id=? AND e.relationship_id=?`,
    link?.linked_at ?? null,
    link?.linked_at ?? null,
    link?.linked_at ?? null,
    link?.linked_at ?? null,
    vaultId,
    relationshipId,
  );
  let balance = local?.balance ?? 0;
  if (link) {
    const tab = await tx.getFirstAsync<{ balance: number }>(
      "SELECT COALESCE(SUM(CASE WHEN direction='a_to_b' THEN amount_minor ELSE -amount_minor END),0) AS balance FROM tab_entries WHERE tab_id=? AND kind<>'void' AND voided_by_entry_id IS NULL AND status<>'disputed'",
      link.tab_id,
    );
    balance += (link.role === "a" ? 1 : -1) * (tab?.balance ?? 0);
  }
  if (!Number.isSafeInteger(balance)) throw new RangeError("Unsafe credit balance");
  return balance;
}

// A local-only policy follows its kaata into cloud sync. Upload before replacing
// the cache with GET []; only owner/manager may publish it. Other members keep
// the intent visible locally, but it is not represented as server enforcement.
export async function uploadPendingCreditPolicies(
  vaultId: string,
  expected?: SessionSnapshot,
): Promise<void> {
  const session = expected ?? (await captureCurrentSession());
  return policyMutex(vaultId).runExclusive(() =>
    uploadPendingCreditPoliciesInner(vaultId, session),
  );
}
async function uploadPendingCreditPoliciesInner(
  vaultId: string,
  expected?: SessionSnapshot,
): Promise<void> {
  const session = expected ?? (await captureCurrentSession());
  if (!session.jwt) return;
  const role = await readVaultRole(vaultId, session.accountId);
  if (role !== "owner" && role !== "manager") return;
  const db = await getDb();
  const pending = await db.getAllAsync<CreditPolicy>(
    "SELECT relationship_id,max_collect_minor,max_pay_minor,mode,updated_at_ms FROM customer_credit_limits WHERE vault_id=? AND sync_pending=1",
    vaultId,
  );
  if (!pending.length) return;
  const { pushEvents } = await import("./sync/push");
  await pushEvents(vaultId);
  const base = await getBackendUrl();
  for (const p of pending) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    try {
      const res = await fetch(
        `${base}/v1/sync/credit-limits?vault_id=${encodeURIComponent(vaultId)}`,
        {
          method: "PUT",
          headers: { Authorization: `Bearer ${session.jwt}`, "Content-Type": "application/json" },
          body: JSON.stringify(p),
          signal: controller.signal,
        },
      );
      await requirePolicyResponse(res, "publish");
      const saved = (await res.json()) as CreditPolicy;
      if (!validCreditPolicy(saved) || saved.relationship_id !== p.relationship_id)
        throw new Error("Invalid credit response");
      await applyForCurrentSession(session, async () => {
        const { applyEventMutex } = await import("./projection");
        await applyEventMutex.runExclusive(() =>
          db.withTransactionAsync(async () => {
            await db.runAsync(
              "UPDATE customer_credit_limits SET max_collect_minor=?,max_pay_minor=?,mode=?,updated_at_ms=?,sync_pending=0 WHERE vault_id=? AND relationship_id=? AND sync_pending=1 AND updated_at_ms=?",
              saved.max_collect_minor,
              saved.max_pay_minor,
              saved.mode,
              saved.updated_at_ms,
              vaultId,
              p.relationship_id,
              p.updated_at_ms,
            );
          }),
        );
        changed(vaultId);
      });
    } finally {
      clearTimeout(timer);
    }
  }
}

export async function refreshCreditPolicies(
  vaultId: string,
  expected?: SessionSnapshot,
): Promise<void> {
  const session = expected ?? (await captureCurrentSession());
  if (!session.jwt) return;
  const startedAt = Date.now();
  await uploadPendingCreditPolicies(vaultId, session);
  const version = policyVersions.get(vaultId) ?? 0;
  const base = await getBackendUrl();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const res = await fetch(
      `${base}/v1/sync/credit-limits?vault_id=${encodeURIComponent(vaultId)}`,
      { headers: { Authorization: `Bearer ${session.jwt}` }, signal: controller.signal },
    );
    if (!res.ok) throw new Error(`Credit policy fetch ${res.status}`);
    const policies = (await res.json()) as CreditPolicy[];
    if (!Array.isArray(policies)) throw new Error("Invalid credit policies");
    await applyForCurrentSession(session, async () => {
      const { applyEventMutex } = await import("./projection");
      const db = await getDb();
      await applyEventMutex.runExclusive(() =>
        db.withTransactionAsync(async () => {
          if ((policyVersions.get(vaultId) ?? 0) !== version) return;
          await cacheCreditPolicies(db, vaultId, policies, startedAt);
        }),
      );
      emitCreditPoliciesChanged(vaultId);
    });
  } finally {
    clearTimeout(timer);
  }
}

export async function saveCreditPolicy(
  vaultId: string,
  p: CreditPolicy,
  expected?: SessionSnapshot,
): Promise<CreditPolicy> {
  const session = expected ?? (await captureCurrentSession());
  return policyMutex(vaultId).runExclusive(() => saveCreditPolicyInner(vaultId, p, session));
}
async function saveCreditPolicyInner(
  vaultId: string,
  p: CreditPolicy,
  expected?: SessionSnapshot,
): Promise<CreditPolicy> {
  if (!validCreditPolicy(p)) throw new Error("Invalid credit limit");
  const session = expected ?? (await captureCurrentSession());
  if (p.mode === "clerk_block" && !session.jwt)
    throw new CreditOnlineSaveRequiredError(
      "Hard credit limits require sign-in and an online save",
    );
  const role = await readVaultRole(vaultId, session.accountId);
  if (role !== "owner" && role !== "manager") throw new Error("Manager required");
  const authorityDb = await getDb();
  const authority = await authorityDb.getFirstAsync<{ account_id: string | null }>(
    "SELECT v.account_id FROM vaults v WHERE v.id=? AND v.archived_at IS NULL",
    vaultId,
  );
  if (!authority) throw new Error("Kaata unavailable");
  const ownIds = await resolveAccountIdCandidates(session.accountId);
  const members = await authorityDb.getAllAsync<{
    account_id: string;
    role: string;
    revoked_at: number | null;
  }>("SELECT account_id,role,revoked_at FROM vault_members_mirror WHERE vault_id=?", vaultId);
  if (
    !session.jwt &&
    (authority.account_id != null || members.some((m) => !ownIds.includes(m.account_id)))
  )
    throw new Error("Shared credit limits require sign-in and an online save");
  if (
    p.mode === "clerk_block" &&
    members.some((m) => m.role === "clerk" && m.revoked_at == null && /^local:/.test(m.account_id))
  )
    throw new ClerkCloudEnrollmentRequiredError("Every clerk must sign in and sync first");
  let saved = { ...p, updated_at_ms: Date.now() };
  if (session.jwt) {
    const { pushEvents } = await import("./sync/push");
    await pushEvents(vaultId);
    const base = await getBackendUrl();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    try {
      const res = await fetch(
        `${base}/v1/sync/credit-limits?vault_id=${encodeURIComponent(vaultId)}`,
        {
          method: "PUT",
          headers: { Authorization: `Bearer ${session.jwt}`, "Content-Type": "application/json" },
          body: JSON.stringify(p),
          signal: controller.signal,
        },
      );
      await requirePolicyResponse(res, "save");
      saved = (await res.json()) as CreditPolicy;
      if (!validCreditPolicy(saved) || saved.relationship_id !== p.relationship_id)
        throw new Error("Invalid credit response");
    } finally {
      clearTimeout(timer);
    }
  }
  await applyForUnchangedLocalSession(session, async () => {
    const { applyEventMutex } = await import("./projection");
    const db = await getDb();
    await applyEventMutex.runExclusive(() =>
      db.withTransactionAsync(async () => {
        await db.runAsync(
          "INSERT INTO customer_credit_limits(vault_id,relationship_id,max_collect_minor,max_pay_minor,mode,updated_at_ms,sync_pending) VALUES(?,?,?,?,?,?,?) ON CONFLICT(vault_id,relationship_id) DO UPDATE SET max_collect_minor=excluded.max_collect_minor,max_pay_minor=excluded.max_pay_minor,mode=excluded.mode,updated_at_ms=excluded.updated_at_ms,sync_pending=excluded.sync_pending WHERE customer_credit_limits.updated_at_ms<=excluded.updated_at_ms OR customer_credit_limits.sync_pending=1",
          vaultId,
          saved.relationship_id,
          saved.max_collect_minor,
          saved.max_pay_minor,
          saved.mode,
          saved.updated_at_ms,
          session.jwt ? 0 : 1,
        );
      }),
    );
    changed(vaultId);
  });
  return saved;
}

export function creditStatusForBalance(
  p: CreditPolicy | null | undefined,
  balance: number,
): "none" | "near" | "over" {
  const minor = toMinorUnits(balance);
  const cap = minor > 0 ? p?.max_collect_minor : p?.max_pay_minor;
  const exposure = Math.abs(minor);
  return cap != null && exposure > cap
    ? "over"
    : cap != null && exposure > 0 && exposure * 5 >= cap * 4
      ? "near"
      : "none";
}

export async function readCreditPoliciesForPeople(
  vaultId: string,
): Promise<Record<string, CreditPolicy>> {
  const db = await getDb();
  const rows = await db.getAllAsync<CreditPolicy & { person_id: string }>(
    "SELECT r.user_b_id AS person_id,p.relationship_id,p.max_collect_minor,p.max_pay_minor,p.mode,p.updated_at_ms FROM customer_credit_limits p JOIN relationships r ON r.id=p.relationship_id AND r.vault_id=p.vault_id WHERE p.vault_id=? AND r.archived_at IS NULL",
    vaultId,
  );
  return Object.fromEntries(rows.map((r) => [r.person_id, r]));
}

export async function creditWarning(
  personId: string,
  type: "debt" | "payment",
  amount: number,
  vaultId = getActiveVaultIdSyncMaybe(),
): Promise<boolean> {
  if (!vaultId) return false;
  const relationshipId = await relationshipForCredit(personId, vaultId);
  const policy = await readCreditPolicy(relationshipId, vaultId);
  if (!policy) return false;
  const db = await getDb();
  const before = await creditBalanceInTx(db, vaultId, relationshipId);
  return creditExceeded(policy, before, before + (type === "debt" ? 1 : -1) * toMinorUnits(amount));
}

export type CreditIntent = {
  id: string;
  type: "debt" | "payment";
  amount_afn: number;
  note: string | null;
  created_at: number;
  admission_status: "pending" | "refused";
};
export async function listCreditIntents(
  personId: string,
  vaultId = getActiveVaultIdSyncMaybe(),
): Promise<CreditIntent[]> {
  if (!vaultId) return [];
  const rel = await relationshipForCredit(personId, vaultId);
  const db = await getDb();
  const rows = await db.getAllAsync<{
    event_id: string;
    payload_json: string;
    status: "pending" | "refused";
  }>(
    "SELECT i.event_id,e.payload_json,i.status FROM credit_admission_intents i JOIN event_log e ON e.event_id=i.event_id WHERE i.vault_id=? AND i.relationship_id=? AND e.server_acked_at IS NULL ORDER BY e.appended_at DESC",
    vaultId,
    rel,
  );
  const out: CreditIntent[] = rows.map((r) => {
    const p = JSON.parse(r.payload_json);
    return {
      id: r.event_id,
      type: p.type,
      amount_afn: p.amount_afn,
      note: p.note,
      created_at: p.occurred_at_ms,
      admission_status: r.status,
    };
  });
  const ops = await db.getAllAsync<{
    id: string;
    payload: string;
    role: "a" | "b";
    created_at: number;
    admission_status: "pending" | "refused";
  }>(
    "SELECT o.id,o.payload,l.role,o.created_at,'pending' AS admission_status FROM tab_outbox o JOIN tab_links l ON l.tab_id=o.tab_id WHERE l.vault_id=? AND l.relationship_id=? AND o.op='append' AND NOT EXISTS(SELECT 1 FROM tab_entries e WHERE e.id=o.id) UNION ALL SELECT o.id,o.payload,l.role,o.created_at,'refused' AS admission_status FROM tab_failed_ops o JOIN tab_links l ON l.tab_id=o.tab_id WHERE l.vault_id=? AND l.relationship_id=? AND o.op='append' AND o.reason='credit_limit_exceeded'",
    vaultId,
    rel,
    vaultId,
    rel,
  );
  for (const o of ops) {
    const p = JSON.parse(o.payload);
    out.push({
      id: o.id,
      type: (o.role === "a" ? p.direction === "a_to_b" : p.direction === "b_to_a")
        ? "debt"
        : "payment",
      amount_afn: Number(p.amount),
      note: p.note,
      created_at: p.occurred_at_ms ?? o.created_at,
      admission_status: o.admission_status,
    });
  }
  return out;
}

export async function finishCreditAdmission(
  eventId: string,
  vaultId: string,
): Promise<"recorded" | "pending" | "refused"> {
  const { pushEvents } = await import("./sync/push");
  try {
    await Promise.race([pushEvents(vaultId), new Promise((resolve) => setTimeout(resolve, 5000))]);
  } catch {
    /* durable intent remains */
  }
  const db = await getDb();
  const row = await db.getFirstAsync<{
    server_acked_at: number | null;
    rejected_at: number | null;
  }>("SELECT server_acked_at,rejected_at FROM event_log WHERE event_id=?", eventId);
  if (row?.server_acked_at) {
    const { sweepVaultNow } = await import("./projection/sweep");
    await sweepVaultNow(vaultId);
    return "recorded";
  }
  return row?.rejected_at ? "refused" : "pending";
}
