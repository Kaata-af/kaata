import { applyForUnchangedLocalSession, captureCurrentSession, type SessionSnapshot } from "./auth";
import {
  getAccountIdSync,
  getActiveVaultIdSyncMaybe,
  getDb,
  getInstallIdSync,
  getLocalSelfUserIdSync,
} from "./db-tx";
import { effectiveEntryCurrencySql, isValidCurrencyCode } from "./currency-scope";
import { appendPersonEdit } from "./event-log";
import { applyEventMutex } from "./projection";

export type PersonCurrencyMutationOptions = {
  session?: SessionSnapshot;
  shouldContinue?: () => boolean;
  expectedDefaultCurrency?: string | null;
};

async function readPreference(vaultId: string, personId: string) {
  const db = await getDb();
  const row = await db.getFirstAsync<{ id: string; default_entry_currency: string | null }>(
    "SELECT id,default_entry_currency FROM relationships WHERE vault_id=? AND user_b_id=? AND archived_at IS NULL ORDER BY created_at DESC LIMIT 1",
    vaultId,
    personId,
  );
  return row
    ? {
        id: row.id,
        currency: isValidCurrencyCode(row.default_entry_currency)
          ? row.default_entry_currency
          : null,
      }
    : null;
}

/** Raw per-Kaata override. Null means automatically choose from this contact's history. */
export async function getPersonDefaultCurrency(
  vaultId: string,
  personId: string,
): Promise<string | null> {
  return applyEventMutex.runExclusive(
    async () => (await readPreference(vaultId, personId))?.currency ?? null,
  );
}

/** Disabled historical preferences remain stored without returning to future pickers. */
export function resolvePersonEntryCurrency(
  override: string | null,
  enabled: readonly string[],
  defaultCurrency: string,
  recordedCurrencies: readonly string[] = [],
): string {
  if (override !== null)
    return isValidCurrencyCode(override) && enabled.includes(override) ? override : defaultCurrency;
  const recorded = [...new Set(recordedCurrencies.filter(isValidCurrencyCode))];
  return recorded.length === 1 && enabled.includes(recorded[0]) ? recorded[0] : defaultCurrency;
}

/** Read only when beginning a new draft; a user's explicit draft choice wins afterward. */
export async function getPersonEntryCurrency(vaultId: string, personId: string): Promise<string> {
  return applyEventMutex.runExclusive(async () => {
    const { getDefaultEntryCurrency, getEnabledCurrencies } =
      require("./currency") as typeof import("./currency");
    const preference = await readPreference(vaultId, personId);
    const defaultCurrency = await getDefaultEntryCurrency(vaultId);
    const enabled = await getEnabledCurrencies(vaultId);
    const override = preference?.currency ?? null;
    if (!preference || override !== null || enabled.length <= 1)
      return resolvePersonEntryCurrency(override, enabled, defaultCurrency);
    const db = await getDb();
    // Read denomination metadata, not balances: settled/zero history still counts.
    // Shared bindings preserve their known currency even before their cache downloads.
    // Both sources are scoped to this active relationship, including closed history.
    const recorded = await db.getAllAsync<{ currency: string }>(
      `SELECT ${effectiveEntryCurrencySql("e")} AS currency FROM entries e
       WHERE e.vault_id=? AND e.relationship_id=? AND e.deleted_at IS NULL
       UNION
       SELECT currency FROM tab_links WHERE vault_id=? AND relationship_id=?`,
      vaultId,
      preference.id,
      vaultId,
      preference.id,
    );
    return resolvePersonEntryCurrency(
      override,
      enabled,
      defaultCurrency,
      recorded.map((row) => row.currency),
    );
  });
}

export async function changePersonDefaultCurrency(
  vaultId: string,
  personId: string,
  currency: string | null,
  expected: PersonCurrencyMutationOptions = {},
): Promise<void> {
  if (currency !== null && !isValidCurrencyCode(currency))
    throw new Error("Invalid contact default currency");
  const accountId = getAccountIdSync();
  const installId = getInstallIdSync();
  const self = getLocalSelfUserIdSync();
  const guard = () => {
    if (
      getActiveVaultIdSyncMaybe() !== vaultId ||
      getAccountIdSync() !== accountId ||
      getInstallIdSync() !== installId ||
      getLocalSelfUserIdSync() !== self ||
      expected.shouldContinue?.() === false
    )
      throw new Error("Contact edit changed scope");
  };
  guard();
  const session = expected.session ?? (await captureCurrentSession());
  guard();
  const db = await getDb();
  const rel = await db.getFirstAsync<{ id: string }>(
    "SELECT id FROM relationships WHERE vault_id=? AND user_b_id=? AND archived_at IS NULL ORDER BY created_at DESC LIMIT 1",
    vaultId,
    personId,
  );
  guard();
  if (!rel) throw new Error("The contact no longer exists in this Kaata");
  await applyForUnchangedLocalSession(session, () =>
    appendPersonEdit({
      userId: personId,
      relationshipId: rel.id,
      vaultId,
      defaultCurrency: currency,
      expectedDefaultCurrency: expected.expectedDefaultCurrency,
      expectedAccountId: accountId,
      shouldContinue: () => {
        guard();
        return true;
      },
    }),
  );
}
