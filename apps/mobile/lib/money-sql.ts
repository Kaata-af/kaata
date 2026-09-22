// amount_afn keeps its original major-unit meaning: a stored 100 is still 100.
// SQLite's non-STRICT INTEGER affinity also preserves fractional numbers, so
// enabling cents needs no rewrite of legacy rows, snapshots, or signed events.
// Round EACH amount into integer hundredths before summing; rounding a floating
// SUM afterwards can leave zero-balance / settlement checks inconsistent.
/**
 * `onlyWhen` narrows WHICH rows the sum counts without re-deriving the sign
 * and rounding rule — the one thing every balance in the app must share. It
 * exists for the mutual tab: once a contact is linked, the local rows from
 * before the link are frozen OUT of the balance forever, because the tab's
 * opening entry already carries their sum and counting both would double it
 * (docs/mutual-tab-design.md D8). Rows after the link are ordinary local
 * tallies again once the tab is closed, and those still count.
 *
 * It is spliced into SQL verbatim, so it must be a literal composed in code —
 * never user input, exactly like `alias`.
 */
export function signedEntryMinorSumSql(alias = "", onlyWhen?: string): string {
  if (alias && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(alias)) {
    throw new Error("Invalid entry table alias");
  }
  const prefix = alias ? `${alias}.` : "";
  const minor = `CAST(ROUND(${prefix}amount_afn * 100) AS INTEGER)`;
  const live = `${prefix}deleted_at IS NULL${onlyWhen ? ` AND (${onlyWhen})` : ""}`;
  return `COALESCE(SUM(CASE
    WHEN ${live} AND ${prefix}type = 'debt' THEN ${minor}
    WHEN ${live} AND ${prefix}type = 'payment' THEN -${minor}
    ELSE 0 END), 0)`;
}
