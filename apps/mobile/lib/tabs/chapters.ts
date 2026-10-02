import type { Entry } from "../types";
import type { TabSettlement } from "./types";

// Cancellation remains in the evidence/export cache, not the everyday list.
export function visibleTally(entry: Entry): boolean {
  return !entry.tab?.voided && entry.tab?.kind !== "void";
}

// Server sequence is the boundary, never a device clock or business date.
// An unsent/backdated tally must stay visible until the server records it.
export function afterSharedSettlement(entry: Entry, throughSeq: number): boolean {
  return !entry.tab || !entry.tab.seq || entry.tab.local_pending || entry.tab.seq > throughSeq;
}

export type SharedHistoryItem =
  | { kind: "entry"; entry: Entry }
  | { kind: "marker"; ms: number; settlement: TabSettlement };

export function sharedHistory(entries: Entry[], settlements: TabSettlement[]): SharedHistoryItem[] {
  const markers = [...settlements].sort((a, b) => b.through_seq - a.through_seq);
  const ordered = entries.filter(visibleTally).sort((a, b) => {
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
  return result;
}
