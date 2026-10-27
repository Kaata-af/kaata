import type { Entry } from "../types";
import { balanceContribution, countsTowardBalance } from "../export/shared-record";
import type { TabLink } from "./types";
import { sumAmounts } from "../money";
import { tabConfirmedBalanceSql } from "./direction";

/** Scope binding order comes from the server, never a business/link date.
 * An accepted opening checkpoints older books; a pending/rejected opening
 * cannot erase their acknowledged debt. */
export function historyReady(links: readonly TabLink[]): boolean {
  const validOrder = (order: string | null | undefined) =>
    !!order && /^[1-9][0-9]*$/.test(order) && BigInt(order) <= 9223372036854775807n;
  if (links.length <= 1) return !links[0]?.history_order || validOrder(links[0].history_order);
  return (
    new Set(links.map((link) => link.history_order)).size === links.length &&
    links.every((link) => validOrder(link.history_order) && link.currency === links[0].currency)
  );
}

export function effectiveSharedPeriods(periods: readonly { link: TabLink; entries: Entry[] }[]): {
  current: Entry[];
  retainedIds: Set<string>;
} {
  if (!historyReady(periods.map((period) => period.link)))
    throw new Error("shared_history_refresh_required");
  const ordered = [...periods].sort((a, b) => {
    const left = BigInt(a.link.history_order ?? "0");
    const right = BigInt(b.link.history_order ?? "0");
    return left < right ? -1 : left > right ? 1 : 0;
  });
  let checkpoint = 0;
  for (let i = 0; i < ordered.length; i++)
    if (
      ordered[i].entries.some(
        (entry) => entry.tab?.kind === "opening" && countsTowardBalance(entry),
      )
    )
      checkpoint = i;
  const current: Entry[] = [];
  const retainedIds = new Set<string>();
  ordered.forEach((period, index) => {
    const latest = index === ordered.length - 1;
    for (const entry of period.entries) {
      if (
        latest ||
        (index >= checkpoint && countsTowardBalance(entry)) ||
        (!entry.tab?.voided && (entry.tab?.status === "pending" || entry.tab?.local_pending))
      ) {
        const pendingExcluded = index < checkpoint || (entry.tab?.kind === "opening" && !latest);
        current.push(
          entry.tab && !countsTowardBalance(entry) && pendingExcluded
            ? { ...entry, tab: { ...entry.tab, pending_balance_excluded: true } }
            : entry,
        );
        if (!latest) retainedIds.add(entry.id);
      }
    }
  });
  const previousConfirmed = sumAmounts(
    current.filter((entry) => retainedIds.has(entry.id)).map(balanceContribution),
  );
  for (let i = 0; i < current.length; i++) {
    const entry = current[i];
    if (
      !retainedIds.has(entry.id) &&
      entry.tab?.kind === "opening" &&
      !entry.tab.voided &&
      entry.tab.status !== "disputed" &&
      !countsTowardBalance(entry)
    )
      current[i] = {
        ...entry,
        tab: { ...entry.tab, pending_balance_adjustment: -previousConfirmed },
      };
  }
  return { current, retainedIds };
}

function scope(link: string, selected: string): string {
  return `${link}.vault_id = ${selected}.vault_id AND ${link}.relationship_id = ${selected}.relationship_id AND ${link}.currency = ${selected}.currency`;
}

export function unknownHistorySql(selected = "tl"): string {
  return `(SELECT COUNT(*) FROM tab_links uh WHERE ${scope("uh", selected)}) > 1
    AND (EXISTS(SELECT 1 FROM tab_links uh WHERE ${scope("uh", selected)}
      AND (uh.history_order IS NULL OR uh.currency <> ${selected}.currency))
      OR (SELECT COUNT(DISTINCT uh.history_order) FROM tab_links uh WHERE ${scope("uh", selected)})
        <> (SELECT COUNT(*) FROM tab_links uh WHERE ${scope("uh", selected)}))`;
}

/** Predicate for an acknowledged record in the effective carried book. */
export function effectiveConfirmedSql(
  entry = "te",
  link = "hl",
  selected = "tl",
  pending = false,
): string {
  return `${entry}.kind IN ('entry','opening') AND ${entry}.voided_by_entry_id IS NULL
    AND ${pending ? `(${entry}.status = 'pending' OR (${entry}.status = 'accepted' AND (${entry}.local_pending <> 0 OR COALESCE(${entry}.local_action_pending, 0) <> 0)))` : `${entry}.status = 'accepted' AND ${entry}.local_pending = 0 AND COALESCE(${entry}.local_action_pending, 0) = 0`}
    AND ${scope(link, selected)} AND ${link}.currency = ${selected}.currency
    AND ((${unknownHistorySql(selected)} AND ${link}.tab_id = ${selected}.tab_id)
      OR (NOT (${unknownHistorySql(selected)}) AND NOT EXISTS(
        SELECT 1 FROM tab_links cp JOIN tab_entries ce ON ce.tab_id = cp.tab_id
        WHERE ${scope("cp", selected)} AND cp.currency = ${selected}.currency
          AND CAST(cp.history_order AS INTEGER) > CAST(${link}.history_order AS INTEGER)
          AND ce.kind = 'opening' AND ce.status = 'accepted' AND ce.voided_by_entry_id IS NULL
          AND ce.local_pending = 0 AND COALESCE(ce.local_action_pending, 0) = 0)))`;
}

export function effectivePendingBalanceSql(selected = "tl"): string {
  const sign = `CASE WHEN te.direction = CASE WHEN hl.role = 'a' THEN 'a_to_b' ELSE 'b_to_a' END THEN te.amount_minor ELSE -te.amount_minor END`;
  const currentConfirmed = `(SELECT ${tabConfirmedBalanceSql(`${selected}.role`)} FROM tab_entries te WHERE te.tab_id=${selected}.tab_id)`;
  return `COALESCE((SELECT SUM(${sign}) FROM tab_links hl JOIN tab_entries te ON te.tab_id=hl.tab_id
    WHERE ${effectiveConfirmedSql("te", "hl", selected, true)} AND te.kind <> 'opening'),0)
    + COALESCE((SELECT SUM(${sign}) FROM tab_links hl JOIN tab_entries te ON te.tab_id=hl.tab_id
      WHERE hl.tab_id=${selected}.tab_id AND ${effectiveConfirmedSql("te", "hl", selected, true)} AND te.kind='opening'),0)
    - CASE WHEN EXISTS(SELECT 1 FROM tab_entries po WHERE po.tab_id=${selected}.tab_id AND po.kind='opening'
        AND po.voided_by_entry_id IS NULL AND (po.status='pending' OR (po.status='accepted' AND (po.local_pending<>0 OR COALESCE(po.local_action_pending,0)<>0))))
      THEN (${effectiveConfirmedBalanceSql(selected)} - ${currentConfirmed}) ELSE 0 END`;
}

export function effectiveConfirmedBalanceSql(selected = "tl"): string {
  return `COALESCE((SELECT SUM(CASE WHEN te.direction = CASE WHEN hl.role = 'a' THEN 'a_to_b' ELSE 'b_to_a' END
      THEN te.amount_minor ELSE -te.amount_minor END)
    FROM tab_links hl JOIN tab_entries te ON te.tab_id = hl.tab_id
    WHERE ${effectiveConfirmedSql("te", "hl", selected)}), 0)`;
}

/** Credit admission keeps pending-inclusive exposure, but a rejected or
 * withdrawn replacement opening cannot discard an older live balance. */
export function effectiveRecordedBalanceSql(selected = "tl"): string {
  return `COALESCE((SELECT SUM(CASE WHEN te.direction = CASE WHEN hl.role = 'a' THEN 'a_to_b' ELSE 'b_to_a' END
      THEN te.amount_minor ELSE -te.amount_minor END)
    FROM tab_links hl JOIN tab_entries te ON te.tab_id=hl.tab_id
    WHERE ${scope("hl", selected)} AND hl.currency=${selected}.currency
      AND te.kind IN ('entry','opening') AND te.status <> 'disputed' AND te.voided_by_entry_id IS NULL
      AND NOT EXISTS(SELECT 1 FROM tab_links cp JOIN tab_entries ce ON ce.tab_id=cp.tab_id
        WHERE ${scope("cp", selected)} AND cp.currency=${selected}.currency
          AND CAST(cp.history_order AS INTEGER) > CAST(hl.history_order AS INTEGER)
          AND ce.kind='opening' AND ce.status <> 'disputed' AND ce.voided_by_entry_id IS NULL)),0)`;
}
