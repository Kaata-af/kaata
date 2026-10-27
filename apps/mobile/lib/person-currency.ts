import { applyForUnchangedLocalSession, captureCurrentSession, type SessionSnapshot } from "./auth";
import {
  getAccountIdSync,
  getActiveVaultIdSyncMaybe,
  getDb,
  getInstallIdSync,
  getLocalSelfUserIdSync,
} from "./db-tx";
import { isValidCurrencyCode } from "./currency-scope";
import { appendPersonEdit } from "./event-log";
import { applyEventMutex } from "./projection";

export type PersonCurrencyMutationOptions = {
  session?: SessionSnapshot;
  shouldContinue?: () => boolean;
  expectedDefaultCurrency?: string | null;
};

async function readPreference(vaultId: string, personId: string): Promise<string | null> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ default_entry_currency: string | null }>(
    "SELECT default_entry_currency FROM relationships WHERE vault_id=? AND user_b_id=? AND archived_at IS NULL ORDER BY created_at DESC LIMIT 1",
    vaultId,
    personId,
  );
  return isValidCurrencyCode(row?.default_entry_currency) ? row.default_entry_currency : null;
}

/** Raw per-Kaata override. Null means follow the Kaata default. */
export async function getPersonDefaultCurrency(
  vaultId: string,
  personId: string,
): Promise<string | null> {
  return applyEventMutex.runExclusive(() => readPreference(vaultId, personId));
}

/** Disabled historical preferences remain stored without returning to future pickers. */
export function resolvePersonEntryCurrency(
  override: string | null,
  enabled: readonly string[],
  defaultCurrency: string,
): string {
  return override !== null && isValidCurrencyCode(override) && enabled.includes(override)
    ? override
    : defaultCurrency;
}

/** Read only when beginning a new draft; a user's explicit draft choice wins afterward. */
export async function getPersonEntryCurrency(vaultId: string, personId: string): Promise<string> {
  return applyEventMutex.runExclusive(async () => {
    const { getDefaultEntryCurrency, getEnabledCurrencies } =
      require("./currency") as typeof import("./currency");
    const override = await readPreference(vaultId, personId);
    const defaultCurrency = await getDefaultEntryCurrency(vaultId);
    const enabled = await getEnabledCurrencies(vaultId);
    return resolvePersonEntryCurrency(override, enabled, defaultCurrency);
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
