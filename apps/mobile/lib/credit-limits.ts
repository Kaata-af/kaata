import {
  type CreditPolicy,
  type CreditStatus,
  creditStatusForExposure,
  creditExceeded,
  KAATA_DEFAULT_CREDIT_ID,
  validCreditPolicy,
} from "./credit-policy";
export {
  type CreditPolicy,
  type CreditStatus,
  creditExceeded,
  KAATA_DEFAULT_CREDIT_ID,
  validCreditPolicy,
} from "./credit-policy";
import { cacheCreditPolicies } from "./credit-policy-cache";
import { readCreditAlertPolicyInTx } from "./credit-alert-cache";
import {
  creditAlertExceeded,
  type CreditAlertBalances,
  type CreditAlertGroup,
} from "./credit-alert-policy";
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
import { fromMinorUnits, toMinorUnits } from "./money";
import { signedEntryMinorSumSql } from "./money-sql";
import {
  getLedgerCurrencyCode,
  currencySqlLiteral,
  effectiveEntryCurrencySql,
  entryCurrencyMatchesSql,
  isValidCurrencyCode,
  requireCurrencyCode,
} from "./currency-scope";
import { emitCreditPoliciesChanged } from "./credit-policy-events";
import { Mutex } from "./util/mutex";
import { resolveAccountIdCandidates } from "./effective-account";
import {
  effectiveRecordedBalanceSql,
  historyReady,
  privateEntryCurrentSql,
  unjoinedOpeningPrivateAdjustmentSql,
} from "./tabs/history";
import type { TabLink } from "./tabs/types";
import { currencyRequestHeaders, ensureCurrencySyncSupported } from "./currency-sync";

export class ClerkCloudEnrollmentRequiredError extends Error {}
export class CreditOnlineSaveRequiredError extends Error {}
async function requirePolicyResponse(res: Response, action: string): Promise<void> {
  if (res.ok) return;
  const problem = (await res.json().catch(() => null)) as { error_code?: string } | null;
  if (
    problem?.error_code === "clerk_cloud_enrollment_required" ||
    problem?.error_code === "staff_cloud_enrollment_required"
  )
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
  currencyCode = getLedgerCurrencyCode(),
): Promise<CreditPolicy | null> {
  if (!vaultId) return null;
  const db = await getDb();
  if (relationshipId === KAATA_DEFAULT_CREDIT_ID) {
    const row = await db.getFirstAsync<CreditPolicy>(
      "SELECT ? AS relationship_id,currency,max_collect_minor,max_pay_minor,mode,updated_at_ms,restrict_editors FROM kaata_credit_defaults WHERE vault_id=? AND currency=?",
      KAATA_DEFAULT_CREDIT_ID,
      vaultId,
      currencyCode,
    );
    return row ? { ...row, restrict_editors: !!row.restrict_editors } : null;
  }
  const row = await db.getFirstAsync<CreditPolicy>(
    "SELECT relationship_id,currency,max_collect_minor,max_pay_minor,mode,updated_at_ms,restrict_editors FROM customer_credit_limits WHERE vault_id=? AND relationship_id=? AND currency=?",
    vaultId,
    relationshipId,
    currencyCode,
  );
  return row ? { ...row, restrict_editors: !!row.restrict_editors } : null;
}

export type CreditCurrencySettings = {
  currency: string;
  policy: CreditPolicy | null;
  defaultPolicy: CreditPolicy | null;
};

/** Settings include disabled denominations that still have history or a rule.
 * A customer's explicit rule stays distinct from the inherited Kaata default. */
export async function listCreditCurrencySettings(
  relationshipId: string,
  vaultId: string,
): Promise<CreditCurrencySettings[]> {
  const [{ getEnabledCurrencies, getDefaultEntryCurrency }, { listLedgerCurrencies }, db] =
    await Promise.all([import("./currency"), import("./db"), getDb()]);
  const [preferred, enabled, recorded, rows] = await Promise.all([
    getDefaultEntryCurrency(vaultId),
    getEnabledCurrencies(vaultId),
    listLedgerCurrencies(vaultId),
    db.getAllAsync<CreditPolicy>(
      `SELECT relationship_id,currency,max_collect_minor,max_pay_minor,mode,updated_at_ms,restrict_editors
         FROM customer_credit_limits WHERE vault_id=? AND relationship_id=?
       UNION ALL
       SELECT ? AS relationship_id,currency,max_collect_minor,max_pay_minor,mode,updated_at_ms,restrict_editors
         FROM kaata_credit_defaults WHERE vault_id=?`,
      vaultId,
      relationshipId,
      KAATA_DEFAULT_CREDIT_ID,
      vaultId,
    ),
  ]);
  const own = new Map<string, CreditPolicy>();
  const defaults = new Map<string, CreditPolicy>();
  for (const row of rows) {
    if (!isValidCurrencyCode(row.currency)) continue;
    const policy = { ...row, restrict_editors: !!row.restrict_editors };
    if (row.relationship_id === relationshipId) own.set(row.currency, policy);
    if (row.relationship_id === KAATA_DEFAULT_CREDIT_ID) defaults.set(row.currency, policy);
  }
  const historical = [...new Set([...recorded, ...own.keys(), ...defaults.keys()])].sort((a, b) =>
    a.localeCompare(b),
  );
  return [...new Set([preferred, ...enabled, ...historical])]
    .filter(isValidCurrencyCode)
    .map((currency) => ({
      currency,
      policy: own.get(currency) ?? null,
      defaultPolicy:
        relationshipId === KAATA_DEFAULT_CREDIT_ID ? null : (defaults.get(currency) ?? null),
    }));
}

/** The customer's own limit, else the kaata default, else null. */
export async function readEffectiveCreditPolicy(
  relationshipId: string,
  vaultId = getActiveVaultIdSyncMaybe(),
  currencyCode = getLedgerCurrencyCode(),
): Promise<CreditPolicy | null> {
  return (
    (await readCreditPolicy(relationshipId, vaultId, currencyCode)) ??
    (relationshipId === KAATA_DEFAULT_CREDIT_ID
      ? null
      : await readCreditPolicy(KAATA_DEFAULT_CREDIT_ID, vaultId, currencyCode))
  );
}

export async function creditBalanceInTx(
  tx: SQLiteTx,
  vaultId: string,
  relationshipId: string,
  currencyCode = getLedgerCurrencyCode(),
): Promise<number> {
  const links = await tx.getAllAsync<TabLink>(
    "SELECT * FROM tab_links WHERE vault_id=? AND relationship_id=? AND currency=? ORDER BY CAST(history_order AS INTEGER) DESC,linked_at DESC",
    vaultId,
    relationshipId,
    currencyCode,
  );
  if (!historyReady(links)) throw new Error("shared_history_refresh_required");
  const link = links[0];
  const local = await tx.getFirstAsync<{ balance: number }>(
    `SELECT ${signedEntryMinorSumSql("e", `e.disputed_at IS NULL AND ${privateEntryCurrentSql("e")}`)} AS balance FROM entries e WHERE e.vault_id=? AND e.relationship_id=? AND ${entryCurrencyMatchesSql("e", currencyCode)}`,
    vaultId,
    relationshipId,
  );
  let balance = local?.balance ?? 0;
  if (link) {
    // An unused invitation's live opening proposes private rows still counted
    // above. Remove that overlap while keeping pending shared exposure.
    const tab = await tx.getFirstAsync<{ balance: number }>(
      `SELECT (${effectiveRecordedBalanceSql()}) - (${unjoinedOpeningPrivateAdjustmentSql("tl", "pe.disputed_at IS NULL")}) AS balance FROM tab_links tl WHERE tl.tab_id=?`,
      link.tab_id,
    );
    balance += tab?.balance ?? 0;
  }
  if (!Number.isSafeInteger(balance)) throw new RangeError("Unsafe credit balance");
  return balance;
}

/** Hold applyEventMutex across the full vector so a remote apply cannot mix
 * currencies from different financial projections. Unknown history is not 0. */
export async function creditAlertBalancesInTx(
  tx: SQLiteTx,
  vaultId: string,
  relationshipId: string,
  groups: readonly CreditAlertGroup[],
): Promise<CreditAlertBalances> {
  const balances: Record<string, number | null> = {};
  const currencies = new Set(groups.flatMap((group) => group.conditions.map((c) => c.currency)));
  for (const currency of currencies) {
    try {
      balances[currency] = await creditBalanceInTx(tx, vaultId, relationshipId, currency);
    } catch (error) {
      if (!(error instanceof Error) || error.message !== "shared_history_refresh_required")
        throw error;
      balances[currency] = null;
    }
  }
  return balances;
}

async function effectiveCreditAlertInTx(tx: SQLiteTx, vaultId: string, relationshipId: string) {
  return (
    (await readCreditAlertPolicyInTx(tx, vaultId, relationshipId)) ??
    (await readCreditAlertPolicyInTx(tx, vaultId, KAATA_DEFAULT_CREDIT_ID))
  );
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
    "SELECT relationship_id,currency,max_collect_minor,max_pay_minor,mode,updated_at_ms,restrict_editors FROM customer_credit_limits WHERE vault_id=? AND sync_pending=1",
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
      await ensureCurrencySyncSupported(base, session.jwt, controller.signal);
      const res = await fetch(
        `${base}/v1/sync/credit-limits?vault_id=${encodeURIComponent(vaultId)}`,
        {
          method: "PUT",
          headers: {
            ...(await currencyRequestHeaders(await getDb(), vaultId)),
            Authorization: `Bearer ${session.jwt}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ ...p, restrict_editors: !!p.restrict_editors }),
          signal: controller.signal,
        },
      );
      await requirePolicyResponse(res, "publish");
      const saved = (await res.json()) as CreditPolicy;
      saved.currency ??= p.currency;
      if (
        !validCreditPolicy(saved) ||
        saved.relationship_id !== p.relationship_id ||
        saved.currency !== p.currency
      )
        throw new Error("Invalid credit response");
      await applyForCurrentSession(session, async () => {
        const { applyEventMutex } = await import("./projection");
        await applyEventMutex.runExclusive(() =>
          db.withTransactionAsync(async () => {
            await db.runAsync(
              "UPDATE customer_credit_limits SET max_collect_minor=?,max_pay_minor=?,mode=?,updated_at_ms=?,restrict_editors=?,sync_pending=0 WHERE vault_id=? AND relationship_id=? AND currency=? AND sync_pending=1 AND updated_at_ms=?",
              saved.max_collect_minor,
              saved.max_pay_minor,
              saved.mode,
              saved.updated_at_ms,
              Number(!!saved.restrict_editors),
              vaultId,
              p.relationship_id,
              p.currency!,
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
      {
        headers: {
          ...(await currencyRequestHeaders(await getDb(), vaultId)),
          Authorization: `Bearer ${session.jwt}`,
        },
        signal: controller.signal,
      },
    );
    if (!res.ok) throw new Error(`Credit policy fetch ${res.status}`);
    const policies = (await res.json()) as CreditPolicy[];
    if (!Array.isArray(policies)) throw new Error("Invalid credit policies");
    await applyForCurrentSession(session, async () => {
      const { applyEventMutex } = await import("./projection");
      const db = await getDb();
      let cacheChanged = false;
      await applyEventMutex.runExclusive(() =>
        db.withTransactionAsync(async () => {
          if ((policyVersions.get(vaultId) ?? 0) !== version) return;
          cacheChanged = await cacheCreditPolicies(db, vaultId, policies, startedAt);
        }),
      );
      if (cacheChanged) emitCreditPoliciesChanged(vaultId);
    });
  } finally {
    clearTimeout(timer);
  }
}

/** A clerk tally a limit stopped, as the server recorded it. */
export type CreditRefusal = {
  currency?: string;
  relationship_id: string;
  type: "debt" | "payment";
  amount_minor: number;
  actor_account_id: string;
  actor_name: string;
  refused_at_ms: number;
};
const refusalCache = new Map<string, { at: number; jwt: string; rows: CreditRefusal[] }>();

/** The last 30 days of clerk tallies a limit stopped, for the owner and
 *  managers who set limits (audit #24: they never heard of them). Server
 *  state only, never cached on disk; anyone else, or an older server, gets
 *  an empty list. One request a minute per kaata and session at most. */
export async function fetchCreditRefusals(
  vaultId: string,
  expected?: SessionSnapshot,
  currencyCode = getLedgerCurrencyCode(),
): Promise<CreditRefusal[]> {
  const session = expected ?? (await captureCurrentSession());
  if (!session.jwt) return [];
  const role = await readVaultRole(vaultId, session.accountId);
  if (role !== "owner" && role !== "manager") return [];
  const cacheKey = `${vaultId}:${currencyCode}`;
  const cached = refusalCache.get(cacheKey);
  if (cached && cached.jwt === session.jwt && Date.now() - cached.at < 60_000) return cached.rows;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const res = await fetch(
      `${await getBackendUrl()}/v1/sync/credit-refusals?vault_id=${encodeURIComponent(vaultId)}&currency=${encodeURIComponent(currencyCode)}`,
      {
        headers: {
          ...(await currencyRequestHeaders(await getDb(), vaultId)),
          Authorization: `Bearer ${session.jwt}`,
        },
        signal: controller.signal,
      },
    );
    if (!res.ok) return cached?.jwt === session.jwt ? cached.rows : [];
    const body = (await res.json()) as { refusals?: unknown };
    const rows = (Array.isArray(body?.refusals) ? body.refusals : []).filter(
      (r): r is CreditRefusal =>
        !!r &&
        typeof r === "object" &&
        typeof (r as CreditRefusal).relationship_id === "string" &&
        ((r as CreditRefusal).type === "debt" || (r as CreditRefusal).type === "payment") &&
        Number.isSafeInteger((r as CreditRefusal).amount_minor) &&
        typeof (r as CreditRefusal).actor_name === "string" &&
        Number.isSafeInteger((r as CreditRefusal).refused_at_ms),
    );
    const db = await getDb();
    const legacy =
      (
        await db.getFirstAsync<{ currency: string }>(
          "SELECT COALESCE(legacy_currency,currency,'AFN') AS currency FROM vaults WHERE id=?",
          vaultId,
        )
      )?.currency ?? "AFN";
    const scoped = rows
      .map((row) => ({ ...row, currency: row.currency ?? legacy }))
      .filter((row) => row.currency === currencyCode);
    refusalCache.set(cacheKey, { at: Date.now(), jwt: session.jwt, rows: scoped });
    return scoped;
  } catch {
    return cached?.jwt === session.jwt ? cached.rows : [];
  } finally {
    clearTimeout(timer);
  }
}

export async function saveCreditPolicy(
  vaultId: string,
  p: CreditPolicy,
  expected?: SessionSnapshot,
  currencyCode?: string,
): Promise<CreditPolicy> {
  p = {
    ...p,
    currency: requireCurrencyCode(currencyCode ?? p.currency ?? getLedgerCurrencyCode()),
  };
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
  const kaataDefault = p.relationship_id === KAATA_DEFAULT_CREDIT_ID;
  // The kaata default is a shared rule other phones must receive: always online.
  if ((p.mode === "clerk_block" || kaataDefault) && !session.jwt)
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
    members.some(
      (m) =>
        (m.role === "clerk" || (p.restrict_editors && m.role === "editor")) &&
        m.revoked_at == null &&
        /^local:/.test(m.account_id),
    )
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
      await ensureCurrencySyncSupported(base, session.jwt, controller.signal);
      const res = await fetch(
        `${base}/v1/sync/credit-limits?vault_id=${encodeURIComponent(vaultId)}`,
        {
          method: "PUT",
          headers: {
            ...(await currencyRequestHeaders(await getDb(), vaultId)),
            Authorization: `Bearer ${session.jwt}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(p),
          signal: controller.signal,
        },
      );
      await requirePolicyResponse(res, "save");
      saved = (await res.json()) as CreditPolicy;
      saved.currency ??= p.currency;
      if (
        !validCreditPolicy(saved) ||
        saved.relationship_id !== p.relationship_id ||
        saved.currency !== p.currency
      )
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
        if (kaataDefault) {
          await db.runAsync(
            "INSERT INTO kaata_credit_defaults(vault_id,currency,max_collect_minor,max_pay_minor,mode,updated_at_ms,restrict_editors) VALUES(?,?,?,?,?,?,?) ON CONFLICT(vault_id,currency) DO UPDATE SET max_collect_minor=excluded.max_collect_minor,max_pay_minor=excluded.max_pay_minor,mode=excluded.mode,updated_at_ms=excluded.updated_at_ms,restrict_editors=excluded.restrict_editors WHERE kaata_credit_defaults.updated_at_ms<=excluded.updated_at_ms",
            vaultId,
            saved.currency!,
            saved.max_collect_minor,
            saved.max_pay_minor,
            saved.mode,
            saved.updated_at_ms,
            Number(!!saved.restrict_editors),
          );
          return;
        }
        await db.runAsync(
          "INSERT INTO customer_credit_limits(vault_id,relationship_id,currency,max_collect_minor,max_pay_minor,mode,updated_at_ms,restrict_editors,sync_pending) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(vault_id,relationship_id,currency) DO UPDATE SET max_collect_minor=excluded.max_collect_minor,max_pay_minor=excluded.max_pay_minor,mode=excluded.mode,updated_at_ms=excluded.updated_at_ms,restrict_editors=excluded.restrict_editors,sync_pending=excluded.sync_pending WHERE customer_credit_limits.updated_at_ms<=excluded.updated_at_ms OR customer_credit_limits.sync_pending=1",
          vaultId,
          saved.relationship_id,
          saved.currency!,
          saved.max_collect_minor,
          saved.max_pay_minor,
          saved.mode,
          saved.updated_at_ms,
          Number(!!saved.restrict_editors),
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
): CreditStatus {
  const minor = toMinorUnits(balance);
  const cap = minor > 0 ? p?.max_collect_minor : p?.max_pay_minor;
  const exposure = Math.abs(minor);
  return creditStatusForExposure(cap, exposure);
}

export async function readCreditPoliciesForPeople(
  vaultId: string,
  currencyCode = getLedgerCurrencyCode(),
): Promise<Record<string, CreditPolicy>> {
  const db = await getDb();
  // Each customer's own limit, else the kaata default (so home colours a
  // customer the default covers too).
  const rows = await db.getAllAsync<CreditPolicy & { person_id: string }>(
    `SELECT r.user_b_id AS person_id,${currencySqlLiteral(currencyCode)} AS currency,
            CASE WHEN p.relationship_id IS NOT NULL THEN p.relationship_id ELSE ? END AS relationship_id,
            CASE WHEN p.relationship_id IS NOT NULL THEN p.max_collect_minor ELSE d.max_collect_minor END AS max_collect_minor,
            CASE WHEN p.relationship_id IS NOT NULL THEN p.max_pay_minor ELSE d.max_pay_minor END AS max_pay_minor,
            CASE WHEN p.relationship_id IS NOT NULL THEN p.mode ELSE d.mode END AS mode,
            CASE WHEN p.relationship_id IS NOT NULL THEN p.updated_at_ms ELSE d.updated_at_ms END AS updated_at_ms,
            CASE WHEN p.relationship_id IS NOT NULL THEN p.restrict_editors ELSE d.restrict_editors END AS restrict_editors
       FROM relationships r
       LEFT JOIN customer_credit_limits p ON p.vault_id=r.vault_id AND p.relationship_id=r.id AND p.currency=${currencySqlLiteral(currencyCode)}
       LEFT JOIN kaata_credit_defaults d ON d.vault_id=r.vault_id AND d.currency=${currencySqlLiteral(currencyCode)}
      WHERE r.vault_id=? AND r.archived_at IS NULL
        AND (p.relationship_id IS NOT NULL OR d.vault_id IS NOT NULL)`,
    KAATA_DEFAULT_CREDIT_ID,
    vaultId,
  );
  return Object.fromEntries(
    rows.map((r) => [r.person_id, { ...r, restrict_editors: !!r.restrict_editors }]),
  );
}

export async function creditWarning(
  personId: string,
  type: "debt" | "payment",
  amount: number,
  vaultId = getActiveVaultIdSyncMaybe(),
  currencyCode = getLedgerCurrencyCode(),
): Promise<boolean> {
  if (!vaultId) return false;
  const { applyEventMutex } = await import("./projection");
  const db = await getDb();
  return applyEventMutex.runExclusive(async () => {
    const relationshipId = await relationshipForCredit(personId, vaultId);
    const policy = await readEffectiveCreditPolicy(relationshipId, vaultId, currencyCode);
    const alerts = await effectiveCreditAlertInTx(db, vaultId, relationshipId);
    if (!policy && !alerts?.groups.length) return false;
    const before = await creditAlertBalancesInTx(db, vaultId, relationshipId, [
      ...(alerts?.groups ?? []),
      { direction: "collect", conditions: [{ currency: currencyCode, threshold_minor: 1 }] },
    ]);
    const balance = before[currencyCode];
    if (balance == null) return false;
    const afterBalance = balance + (type === "debt" ? 1 : -1) * toMinorUnits(amount);
    const after = {
      ...before,
      [currencyCode]: afterBalance,
    };
    return (
      creditExceeded(policy, balance, afterBalance) || creditAlertExceeded(alerts, before, after)
    );
  });
}

/** The same check for an edit (audit #24): the stored amount is already in
 *  the balance, so only the change moves it. A row the balance leaves out
 *  (rejected) cannot push it over by being edited. */
export async function creditWarningForEdit(
  entryId: string,
  amount: number,
  vaultId = getActiveVaultIdSyncMaybe(),
  targetCurrency?: string,
): Promise<boolean> {
  if (!vaultId) return false;
  const { applyEventMutex } = await import("./projection");
  const db = await getDb();
  return applyEventMutex.runExclusive(async () => {
    const row = await db.getFirstAsync<{
      relationship_id: string;
      type: "debt" | "payment";
      amount_afn: number;
      disputed_at: number | null;
      currency: string;
    }>(
      `SELECT relationship_id,type,amount_afn,disputed_at,${effectiveEntryCurrencySql("entries")} AS currency FROM entries WHERE id=? AND vault_id=?`,
      entryId,
      vaultId,
    );
    if (!row || row.disputed_at != null) return false;
    const destination = targetCurrency ?? row.currency;
    const sign = row.type === "debt" ? 1 : -1;
    const alerts = await effectiveCreditAlertInTx(db, vaultId, row.relationship_id);
    const changedCurrencies = [...new Set([row.currency, destination])];
    const before = await creditAlertBalancesInTx(db, vaultId, row.relationship_id, [
      ...(alerts?.groups ?? []),
      {
        direction: "collect",
        conditions: changedCurrencies.map((currency) => ({ currency, threshold_minor: 1 })),
      },
    ]);
    const after = { ...before };
    for (const code of changedCurrencies) {
      const balance = before[code];
      if (balance == null) continue;
      const change =
        (code === destination ? sign * toMinorUnits(amount) : 0) -
        (code === row.currency ? sign * toMinorUnits(row.amount_afn) : 0);
      after[code] = balance + change;
      const policy = await readEffectiveCreditPolicy(row.relationship_id, vaultId, code);
      if (creditExceeded(policy, balance, after[code]!)) return true;
    }
    return creditAlertExceeded(alerts, before, after);
  });
}

export type CreditIntent = {
  currency?: string;
  id: string;
  type: "debt" | "payment";
  amount_afn: number;
  note: string | null;
  created_at: number;
  admission_status: "pending" | "refused";
  mutation?: "edit" | "delete" | "accept" | "dispute" | "void";
};
export async function listCreditIntents(
  personId: string,
  vaultId = getActiveVaultIdSyncMaybe(),
  currencyCode = getLedgerCurrencyCode(),
  options?: { allCurrencies?: boolean },
): Promise<CreditIntent[]> {
  if (!vaultId) return [];
  const rel = await relationshipForCredit(personId, vaultId);
  const db = await getDb();
  const entryCurrency =
    "COALESCE(json_extract(e.payload_json,'$.changes.currency'),json_extract(e.payload_json,'$.currency'),x.currency,(SELECT COALESCE(v.legacy_currency,v.currency,'AFN') FROM vaults v WHERE v.id=e.vault_id),'AFN')";
  const rows = await db.getAllAsync<{
    currency: string;
    event_id: string;
    payload_json: string;
    status: "pending" | "refused";
    event_type: string;
    appended_at: number;
    entry_type: "debt" | "payment" | null;
    entry_amount: number | null;
    entry_note: string | null;
  }>(
    `SELECT ${entryCurrency} AS currency,i.event_id,e.payload_json,e.event_type,e.appended_at,i.status,x.type AS entry_type,x.amount_afn AS entry_amount,x.note AS entry_note FROM credit_admission_intents i JOIN event_log e ON e.event_id=i.event_id LEFT JOIN entries x ON x.id=e.target_id AND x.vault_id=e.vault_id WHERE i.vault_id=? AND i.relationship_id=? AND e.server_acked_at IS NULL ${options?.allCurrencies ? "" : `AND ${entryCurrency}=${currencySqlLiteral(currencyCode)}`} ORDER BY e.appended_at DESC`,
    vaultId,
    rel,
  );
  const out: CreditIntent[] = rows.map((r) => {
    const p = JSON.parse(r.payload_json);
    return {
      id: r.event_id,
      currency: r.currency,
      type: p.type ?? p.changes?.type ?? r.entry_type ?? "debt",
      amount_afn: p.amount_afn ?? p.changes?.amount_afn ?? r.entry_amount ?? 0,
      note: p.note ?? p.changes?.note ?? r.entry_note,
      created_at: p.occurred_at_ms ?? r.appended_at,
      admission_status: r.status,
      ...(r.event_type === "entry_amended"
        ? { mutation: "edit" as const }
        : r.event_type === "entry_deleted"
          ? { mutation: "delete" as const }
          : {}),
    };
  });
  const tabCurrencyFilter = options?.allCurrencies ? "" : " AND l.currency=?";
  const tabParams = options?.allCurrencies ? [vaultId, rel] : [vaultId, rel, currencyCode];
  const ops = await db.getAllAsync<{
    currency: string;
    id: string;
    payload: string;
    role: "a" | "b";
    created_at: number;
    admission_status: "pending" | "refused";
    op: "append" | "accept" | "dispute" | "void";
    entry_direction: string | null;
    entry_amount_minor: number | null;
    entry_note: string | null;
  }>(
    `SELECT l.currency,o.id,o.payload,l.role,o.created_at,'pending' AS admission_status,o.op,x.direction AS entry_direction,x.amount_minor AS entry_amount_minor,x.note AS entry_note FROM tab_outbox o JOIN tab_links l ON l.tab_id=o.tab_id LEFT JOIN tab_entries x ON x.id=json_extract(o.payload,'$.entry_id') AND x.tab_id=o.tab_id WHERE l.vault_id=? AND l.relationship_id=?${tabCurrencyFilter} AND ((o.op='append' AND NOT EXISTS(SELECT 1 FROM tab_entries e WHERE e.id=o.id)) OR (o.op IN ('accept','dispute','void') AND COALESCE(x.local_action_pending,0)=0)) UNION ALL SELECT l.currency,o.id,o.payload,l.role,o.created_at,'refused' AS admission_status,o.op,x.direction AS entry_direction,x.amount_minor AS entry_amount_minor,x.note AS entry_note FROM tab_failed_ops o JOIN tab_links l ON l.tab_id=o.tab_id LEFT JOIN tab_entries x ON x.id=json_extract(o.payload,'$.entry_id') AND x.tab_id=o.tab_id WHERE l.vault_id=? AND l.relationship_id=?${tabCurrencyFilter} AND o.op IN ('append','accept','dispute','void') AND o.reason='credit_limit_exceeded'`,
    ...tabParams,
    ...tabParams,
  );
  for (const o of ops) {
    const p = JSON.parse(o.payload);
    const direction = p.direction ?? o.entry_direction;
    out.push({
      id: o.id,
      currency: o.currency,
      type: (o.role === "a" ? direction === "a_to_b" : direction === "b_to_a") ? "debt" : "payment",
      amount_afn: p.amount == null ? fromMinorUnits(o.entry_amount_minor ?? 0) : Number(p.amount),
      note: p.note ?? o.entry_note,
      created_at: p.occurred_at_ms ?? o.created_at,
      admission_status: o.admission_status,
      ...(o.op !== "append" ? { mutation: o.op } : {}),
    });
  }
  return options?.allCurrencies
    ? [...new Map(out.map((row) => [row.id, row])).values()].sort(
        (a, b) => b.created_at - a.created_at || b.id.localeCompare(a.id),
      )
    : out;
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
