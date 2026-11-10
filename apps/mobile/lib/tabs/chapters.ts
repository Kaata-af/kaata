import type { Entry } from "../types";
import type { TabSettlement } from "./types";

// Cancellation remains in the evidence/export cache, not the everyday list.
export function visibleTally(entry: Entry): boolean {
  return !entry.tab?.voided && entry.tab?.kind !== "void";
}

// Server sequence is the boundary, never a device clock or business date.
// An unsent/backdated tally must stay visible until the server records it.
export function afterSharedSettlement(
  entry: Entry,
  throughSeq: number,
  currentTabId?: string,
  settlementsByTab?: ReadonlyMap<string, readonly TabSettlement[]>,
): boolean {
  if (currentTabId && entry.tab?.tab_id && entry.tab.tab_id !== currentTabId) {
    const own = settlementsByTab?.get(entry.tab.tab_id);
    if (!own?.length) return true;
    throughSeq = Math.max(...own.map((settlement) => settlement.through_seq));
  }
  return !entry.tab || !entry.tab.seq || entry.tab.local_pending || entry.tab.seq > throughSeq;
}

export type SharedHistoryItem =
  | { kind: "entry"; entry: Entry }
  | { kind: "marker"; ms: number; settlement: TabSettlement };

export function sharedHistory(
  entries: Entry[],
  settlements: TabSettlement[],
  currentTabId?: string,
  settlementsByTab?: ReadonlyMap<string, readonly TabSettlement[]>,
): SharedHistoryItem[] {
  const markers = [...settlements].sort((a, b) => b.through_seq - a.through_seq);
  // Sequence numbers are local to a shared period. A line in the latest period
  // must never clear or hide an acknowledged row carried from an older one.
  const carried = currentTabId
    ? entries.filter(
        (entry) => entry.tab?.tab_id && entry.tab.tab_id !== currentTabId && visibleTally(entry),
      )
    : [];
  const carriedIds = new Set(carried.map((entry) => entry.id));
  const ordered = entries
    .filter((entry) => visibleTally(entry) && !carriedIds.has(entry.id))
    .sort((a, b) => {
      const sequence = (entry: Entry) =>
        !entry.tab || !entry.tab.seq || entry.tab.local_pending
          ? Number.MAX_SAFE_INTEGER
          : entry.tab.seq;
      return sequence(b) - sequence(a) || b.created_at - a.created_at || b.id.localeCompare(a.id);
    });
  const result: SharedHistoryItem[] = [];
  let marker = 0;
  for (const entry of ordered) {
    while (marker < markers.length && !afterSharedSettlement(entry, markers[marker].through_seq)) {
      const settlement = markers[marker++];
      result.push({ kind: "marker", ms: settlement.settled_at_ms, settlement });
    }
    result.push({ kind: "entry", entry });
  }
  // A cleared chapter may contain only cancelled tallies. Keep its marker
  // visible even though those originals are hidden from the everyday list.
  for (; marker < markers.length; marker++) {
    const settlement = markers[marker];
    result.push({ kind: "marker", ms: settlement.settled_at_ms, settlement });
  }
  const renderedPeriods = new Set<string>();
  for (const entry of carried) {
    const source = entry.tab!.tab_id!;
    const own = settlementsByTab?.get(source);
    if (!own?.length) result.push({ kind: "entry", entry });
    else if (!renderedPeriods.has(source)) {
      renderedPeriods.add(source);
      result.push(
        ...sharedHistory(
          carried.filter((row) => row.tab?.tab_id === source),
          [...own],
          source,
        ),
      );
    }
  }
  // A fully cancelled chapter still owns its original receipt, even when no
  // visible carried row remains to introduce that period in the timeline.
  if (settlementsByTab)
    for (const [source, own] of settlementsByTab) {
      if (
        source === currentTabId ||
        renderedPeriods.has(source) ||
        carried.some((entry) => entry.tab?.tab_id === source)
      )
        continue;
      result.push(...sharedHistory([], [...own], source));
    }
  return result;
}
