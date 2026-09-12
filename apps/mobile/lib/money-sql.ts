// amount_afn keeps its original major-unit meaning: a stored 100 is still 100.
// SQLite's non-STRICT INTEGER affinity also preserves fractional numbers, so
// enabling cents needs no rewrite of legacy rows, snapshots, or signed events.
// Round EACH amount into integer hundredths before summing; rounding a floating
// SUM afterwards can leave zero-balance / settlement checks inconsistent.
export function signedEntryMinorSumSql(alias = ""): string {
  if (alias && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(alias)) {
    throw new Error("Invalid entry table alias");
  }
  const prefix = alias ? `${alias}.` : "";
  const minor = `CAST(ROUND(${prefix}amount_afn * 100) AS INTEGER)`;
  return `COALESCE(SUM(CASE
    WHEN ${prefix}deleted_at IS NULL AND ${prefix}type = 'debt' THEN ${minor}
    WHEN ${prefix}deleted_at IS NULL AND ${prefix}type = 'payment' THEN -${minor}
    ELSE 0 END), 0)`;
}
