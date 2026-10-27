import type { SQLiteTx } from "./db-tx";
import { requireCurrencyCode } from "./currency-scope";

export class LegacyCurrencyMismatchError extends Error {
  readonly kind = "legacy_currency_mismatch" as const;
  constructor(
    readonly localCurrency: string,
    readonly backupCurrency: string,
  ) {
    super(
      `This book's original currency is ${localCurrency} on this device and ${backupCurrency} in its backup. Sync stopped to protect the amounts. Review the original currency before trying again.`,
    );
    this.name = "LegacyCurrencyMismatchError";
  }
}

/** A frozen legacy base cannot be reconciled by relabeling existing money.
 * Verify authoritative metadata before restoring, pulling or sweeping history. */
export async function assertLegacyCurrencyMatches(
  tx: Pick<SQLiteTx, "getFirstAsync">,
  vaultId: string,
  authoritativeLegacyCurrency?: string,
): Promise<void> {
  if (authoritativeLegacyCurrency === undefined) return; // Older, legacy-only server.
  const expected = requireCurrencyCode(authoritativeLegacyCurrency);
  const local = await tx.getFirstAsync<{ currency: string }>(
    "SELECT COALESCE(legacy_currency,currency,'AFN') AS currency FROM vaults WHERE id=?",
    vaultId,
  );
  if (local && local.currency !== expected)
    throw new LegacyCurrencyMismatchError(local.currency, expected);
}
