/** Financial summaries are always expressed in one currency. Untagged legacy
 * rows inherit the caller's already-scoped book; explicitly tagged rows must
 * agree so unlike money can never cancel in a scalar total. */
export function assertSingleCurrency(
  rows: readonly { currency?: string | null }[],
  expected?: string,
): string | undefined {
  let code = expected;
  for (const row of rows) {
    if (!row.currency) continue;
    if (code && row.currency !== code) throw new Error("Cannot combine different currencies");
    code = row.currency;
  }
  return code;
}
