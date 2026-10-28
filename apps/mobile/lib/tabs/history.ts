import type { Entry } from "../types";
import { balanceContribution, countsTowardBalance } from "../export/shared-record";
import type { TabLink } from "./types";
import { sumAmounts } from "../money";
import { tabFinancialBalanceSql } from "./direction";
import { effectiveEntryCurrencySql } from "../currency-scope";
import { entryRecordedAtSql } from "../entry-date";
import { signedEntryMinorSumSql } from "../money-sql";

/** Server-confirmed untouched invitation; missing metadata is not evidence. */
export function isUnjoinedInvitation(link: TabLink): boolean {
  return link.role === "a" && link.other_joined_at == null && link.unjoined_invitation === 1;
}

export function unjoinedInvitationSql(link = "tl"): string {
  return `(${link}.role='a' AND ${link}.other_joined_at IS NULL AND COALESCE(${link}.unjoined_invitation,0)=1 AND NOT EXISTS (
    SELECT 1 FROM tab_entries proof WHERE proof.tab_id=${link}.tab_id
      AND (proof.created_by='b' OR
        (proof.kind IN ('entry','opening') AND proof.status IN ('accepted','disputed') AND proof.local_pending=0
          AND COALESCE(proof.local_action_pending,0)=0))))`;
}

/** Invitations do not absorb the creator's private book. Use the latest real
 * shared period, in server binding order, rather than a newer unused invite. */
export function privateEntryCurrentSql(entry = "e"): string {
  return `${entryRecordedAtSql(entry)} > COALESCE((SELECT boundary.linked_at FROM tab_links boundary
    WHERE boundary.vault_id=${entry}.vault_id AND boundary.relationship_id=${entry}.relationship_id
      AND boundary.currency=${effectiveEntryCurrencySql(entry)} AND NOT ${unjoinedInvitationSql("boundary")}
    ORDER BY CAST(boundary.history_order AS INTEGER) DESC,boundary.linked_at DESC,boundary.tab_id DESC LIMIT 1),-1)`;
}

export function privateEntryBeforeCurrentLinkSql(entry = "pe", selected = "tl"): string {
  return `${privateEntryCurrentSql(entry)} AND ${entryRecordedAtSql(entry)}<=${selected}.linked_at`;
}

export function retainedPrivateHistorySql(selected = "tl"): string {
  return `(${unjoinedInvitationSql(selected)} AND EXISTS(SELECT 1 FROM entries pe
    WHERE pe.vault_id=${selected}.vault_id AND pe.relationship_id=${selected}.relationship_id
      AND ${effectiveEntryCurrencySql("pe")}=${selected}.currency AND pe.deleted_at IS NULL
      AND ${privateEntryBeforeCurrentLinkSql("pe", selected)})
    AND NOT EXISTS(SELECT 1 FROM tab_entries proposed WHERE proposed.tab_id=${selected}.tab_id
      AND proposed.kind='opening' AND proposed.status<>'disputed' AND proposed.voided_by_entry_id IS NULL
      AND (CASE WHEN proposed.direction=CASE WHEN ${selected}.role='a' THEN 'a_to_b' ELSE 'b_to_a' END
        THEN proposed.amount_minor ELSE -proposed.amount_minor END)
        <> ((${effectiveFinancialBalanceSql(selected)})
          - (SELECT ${tabFinancialBalanceSql(`${selected}.role`)} FROM tab_entries te WHERE te.tab_id=${selected}.tab_id)
          + (${unjoinedOpeningPrivateAdjustmentSql(selected)}))))`;
}

/** Editing can resume only after the server has closed the invitation and
 * retired its copied opening. Optimistic close alone can still race Join. */
export function releasedPrivateHistorySql(selected = "tl"): string {
  return `(${selected}.closed_at IS NOT NULL AND ${unjoinedInvitationSql(selected)}
    AND NOT EXISTS(SELECT 1 FROM tab_outbox closing WHERE closing.tab_id=${selected}.tab_id AND closing.op='close')
    AND NOT EXISTS(SELECT 1 FROM tab_entries opening WHERE opening.tab_id=${selected}.tab_id
      AND opening.kind='opening' AND opening.status='pending' AND opening.voided_by_entry_id IS NULL))`;
}

/** A pending opening proposes the very private money still recorded locally.
 * Subtract only the pre-invitation source, never later local tallies. */
export function unjoinedOpeningPrivateAdjustmentSql(selected = "tl", privateExtra = "1"): string {
  return `CASE WHEN ${unjoinedInvitationSql(selected)} AND EXISTS(SELECT 1 FROM tab_entries opening
    WHERE opening.tab_id=${selected}.tab_id AND opening.kind='opening'
      AND opening.status<>'disputed' AND opening.voided_by_entry_id IS NULL)
    THEN (SELECT ${signedEntryMinorSumSql("pe", `${privateEntryBeforeCurrentLinkSql("pe", selected)} AND (${privateExtra})`)}
      FROM entries pe WHERE pe.vault_id=${selected}.vault_id AND pe.relationship_id=${selected}.relationship_id
        AND ${effectiveEntryCurrencySql("pe")}=${selected}.currency AND pe.deleted_at IS NULL)
    ELSE 0 END`;
}

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
  financial = false,
): string {
  return `${entry}.kind IN ('entry','opening') AND ${entry}.voided_by_entry_id IS NULL
    AND ${pending ? `(${entry}.status = 'pending' OR (${entry}.status IN ('accepted','recorded') AND (${entry}.local_pending <> 0 OR COALESCE(${entry}.local_action_pending, 0) <> 0)))` : `${entry}.status ${financial ? "IN ('accepted','recorded')" : "= 'accepted'"} AND ${entry}.local_pending = 0 AND COALESCE(${entry}.local_action_pending, 0) = 0`}
    AND ${scope(link, selected)} AND ${link}.currency = ${selected}.currency
    AND ((${unknownHistorySql(selected)} AND ${link}.tab_id = ${selected}.tab_id)
      OR (NOT (${unknownHistorySql(selected)}) AND NOT EXISTS(
        SELECT 1 FROM tab_links cp JOIN tab_entries ce ON ce.tab_id = cp.tab_id
        WHERE ${scope("cp", selected)} AND cp.currency = ${selected}.currency
          AND CAST(cp.history_order AS INTEGER) > CAST(${link}.history_order AS INTEGER)
          AND ce.kind = 'opening' AND ce.status IN ('accepted','recorded') AND ce.voided_by_entry_id IS NULL
          AND ce.local_pending = 0 AND COALESCE(ce.local_action_pending, 0) = 0)))`;
}

export function effectiveFinancialSql(entry = "te", link = "hl", selected = "tl"): string {
  return effectiveConfirmedSql(entry, link, selected, false, true);
}

export function effectivePendingBalanceSql(selected = "tl"): string {
  const sign = `CASE WHEN te.direction = CASE WHEN hl.role = 'a' THEN 'a_to_b' ELSE 'b_to_a' END THEN te.amount_minor ELSE -te.amount_minor END`;
  const currentConfirmed = `(SELECT ${tabFinancialBalanceSql(`${selected}.role`)} FROM tab_entries te WHERE te.tab_id=${selected}.tab_id)`;
  return `COALESCE((SELECT SUM(${sign}) FROM tab_links hl JOIN tab_entries te ON te.tab_id=hl.tab_id
    WHERE ${effectiveConfirmedSql("te", "hl", selected, true)} AND te.kind <> 'opening'),0)
    + COALESCE((SELECT SUM(${sign}) FROM tab_links hl JOIN tab_entries te ON te.tab_id=hl.tab_id
      WHERE hl.tab_id=${selected}.tab_id AND ${effectiveConfirmedSql("te", "hl", selected, true)} AND te.kind='opening'),0)
    - CASE WHEN EXISTS(SELECT 1 FROM tab_entries po WHERE po.tab_id=${selected}.tab_id AND po.kind='opening'
        AND po.voided_by_entry_id IS NULL AND (po.status='pending' OR (po.status IN ('accepted','recorded') AND (po.local_pending<>0 OR COALESCE(po.local_action_pending,0)<>0))))
      THEN (${effectiveFinancialBalanceSql(selected)} - ${currentConfirmed}) ELSE 0 END
    - (${unjoinedOpeningPrivateAdjustmentSql(selected)})`;
}

export function effectiveConfirmedBalanceSql(selected = "tl"): string {
  return `COALESCE((SELECT SUM(CASE WHEN te.direction = CASE WHEN hl.role = 'a' THEN 'a_to_b' ELSE 'b_to_a' END
      THEN te.amount_minor ELSE -te.amount_minor END)
    FROM tab_links hl JOIN tab_entries te ON te.tab_id = hl.tab_id
    WHERE ${effectiveConfirmedSql("te", "hl", selected)}), 0)`;
}

export function effectiveFinancialBalanceSql(selected = "tl"): string {
  return `COALESCE((SELECT SUM(CASE WHEN te.direction = CASE WHEN hl.role = 'a' THEN 'a_to_b' ELSE 'b_to_a' END
      THEN te.amount_minor ELSE -te.amount_minor END)
    FROM tab_links hl JOIN tab_entries te ON te.tab_id = hl.tab_id
    WHERE ${effectiveFinancialSql("te", "hl", selected)}), 0)`;
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
