// The selected ledger is a view of one currency, never an exchange rate.
let ledgerCurrency = "AFN";
const listeners = new Set<(code: string) => void>();

export function isValidCurrencyCode(code: unknown): code is string {
  return typeof code === "string" && /^[A-Z]{3}$/.test(code);
}

export function requireCurrencyCode(code: string): string {
  if (!isValidCurrencyCode(code)) throw new Error("Invalid currency code");
  return code;
}

export function getLedgerCurrencyCode(): string {
  return ledgerCurrency;
}

export function setLedgerCurrencyCode(code: string): void {
  requireCurrencyCode(code);
  if (ledgerCurrency === code) return;
  ledgerCurrency = code;
  for (const listener of listeners) listener(code);
}

export function subscribeLedgerCurrency(listener: (code: string) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function currencySqlLiteral(code: string): string {
  return `'${requireCurrencyCode(code)}'`;
}

function sqlAlias(alias: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(alias)) throw new Error("Invalid SQL alias");
  return alias;
}

/** Untagged signed history always belongs to the frozen original book currency.
 * The correlated fallback also works in read sites that do not join vaults. */
export function effectiveEntryCurrencySql(alias: string, vaultAlias?: string): string {
  const row = sqlAlias(alias);
  const legacy = vaultAlias
    ? `COALESCE(${sqlAlias(vaultAlias)}.legacy_currency, ${vaultAlias}.currency, 'AFN')`
    : `(SELECT COALESCE(cv.legacy_currency, cv.currency, 'AFN') FROM vaults cv WHERE cv.id = ${row}.vault_id)`;
  return `COALESCE(${row}.currency, ${legacy}, 'AFN')`;
}

export function entryCurrencyMatchesSql(alias: string, code = getLedgerCurrencyCode()): string {
  return `${effectiveEntryCurrencySql(alias)} = ${currencySqlLiteral(code)}`;
}
