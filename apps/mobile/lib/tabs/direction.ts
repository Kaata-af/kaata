// apps/mobile/lib/tabs/direction.ts
//
// The one place the ABSOLUTE wire direction (a_to_b / b_to_a, D4) meets the
// app's RELATIVE entry vocabulary ('debt' = I gave, 'payment' = I received).
// Pure — no react-native, no SQLite — so `npm run selftest:tabs` loads it
// directly and pins it against apps/_shared/tab-vectors.json, the same vectors
// the Go side runs. Balance rule (§2): rows with kind IN ('entry','opening')
// and voided_by_entry_id IS NULL count; the source of the direction gave value
// (balance up), the target received (balance down); rejected (wire: disputed) tallies do not count.

import type { EntryType } from "../types";
import type { TabDirection, TabEntryKind, TabRole } from "./types";

/** The party value moved FROM. */
export function sourceOf(direction: TabDirection): TabRole {
  return direction === "a_to_b" ? "a" : "b";
}

/** The party value moved TO. */
export function otherRole(role: TabRole): TabRole {
  return role === "a" ? "b" : "a";
}

/**
 * Party `role`'s view of a wire direction: 'debt' ("I gave") when the role is
 * the source, 'payment' ("I received") when it is the target. The SAME row
 * therefore maps to opposite types on the two phones — which is the point.
 */
export function entryTypeFor(role: TabRole, direction: TabDirection): EntryType {
  return sourceOf(direction) === role ? "debt" : "payment";
}

/** Inverse of entryTypeFor: what party `role` puts on the wire for its own tally. */
export function directionFor(role: TabRole, type: EntryType): TabDirection {
  const source = type === "debt" ? role : otherRole(role);
  return source === "a" ? "a_to_b" : "b_to_a";
}

/** The subset of a tab row the balance depends on. */
export type BalanceRow = {
  direction: TabDirection;
  amount_minor: number;
  kind: TabEntryKind;
  status?: "pending" | "accepted" | "disputed";
  voided_by_entry_id: string | null;
};

/**
 * Signed hundredths contributed by one row to party `role`'s balance. Zero for
 * void rows AND for the originals they cancelled (§3.1: both are excluded), so
 * a voided pair nets to nothing without special-casing at the call site.
 */
export function signedMinorFor(role: TabRole, e: BalanceRow): number {
  if (e.kind === "void" || e.voided_by_entry_id != null || e.status === "disputed") return 0;
  return sourceOf(e.direction) === role ? e.amount_minor : -e.amount_minor;
}

/** Party `role`'s balance in hundredths. Positive = the other party owes them. */
export function tabBalanceMinor(role: TabRole, rows: Iterable<BalanceRow>): number {
  let total = 0;
  for (const row of rows) {
    total += signedMinorFor(role, row);
    if (!Number.isSafeInteger(total)) throw new RangeError("Tab balance exceeds safe cents range");
  }
  return total;
}

/**
 * SQL aggregate mirroring signedMinorFor over `alias` (a tab_entries alias),
 * for the JOINs in lib/db.ts. `roleExpr` is the SQL expression yielding the
 * viewer's role — a column reference like `tl.role` or a literal `'a'`. The
 * result is integer hundredths; callers divide by 100.0 exactly as they do
 * with signedEntryMinorSumSql. The selftest pins the text AND executes it
 * against the vectors, so a change here must move both.
 */
export function tabBalanceSql(roleExpr: string, alias = "te"): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(alias)) {
    throw new Error("Invalid tab_entries alias");
  }
  // A qualified column (tl.role) or a quoted role literal; nothing else is a
  // role expression, and rejecting here keeps this a fragment, not an injection point.
  if (!/^(?:[A-Za-z_][A-Za-z0-9_]*\.)?[A-Za-z_][A-Za-z0-9_]*$|^'[ab]'$/.test(roleExpr)) {
    throw new Error("Invalid tab role expression");
  }
  const p = `${alias}.`;
  const live = `${p}kind IN ('entry','opening') AND ${p}voided_by_entry_id IS NULL AND ${p}status <> 'disputed'`;
  const gave = `${p}direction = CASE WHEN ${roleExpr} = 'a' THEN 'a_to_b' ELSE 'b_to_a' END`;
  return `COALESCE(SUM(CASE
    WHEN ${live} AND ${gave} THEN ${p}amount_minor
    WHEN ${live} THEN -${p}amount_minor
    ELSE 0 END), 0)`;
}
