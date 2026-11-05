import type {
  WebTab,
  WebTabEntry,
  WebTabResponse,
  WebTabRole,
  WebTabSettlement,
} from "../../lib/web-tabs";
import type { WebEntry, WebLedger, WebPerson } from "../../lib/web-ledger";
import { csvCell, minorUnits } from "./model";
import type { SharedTalliesCopy } from "./shared-tallies-copy";

export function sharedContactActive(
  ledger: Pick<WebLedger, "archived_at_ms">,
  person: Pick<WebPerson, "archived_at">,
) {
  return ledger.archived_at_ms == null && person.archived_at == null;
}

export function sharedAccountCanStart(person: Pick<WebPerson, "shared" | "read_only_reason">) {
  if (person.shared) return !person.shared.tabs.some((tab) => tab.closed_at_ms == null);
  return person.read_only_reason !== "shared_tab";
}

export function sharedDirectionFor(role: WebTabRole, type: "debt" | "payment") {
  const source = type === "debt" ? role : role === "a" ? "b" : "a";
  return source === "a" ? ("a_to_b" as const) : ("b_to_a" as const);
}

export function sharedEntryActions(tab: WebTab, entry: WebTabEntry, throughSeq: number) {
  const cancelled = entry.kind === "void" || entry.voided_by_entry_id != null;
  return {
    review:
      !!tab.access?.review &&
      !cancelled &&
      entry.status === "pending" &&
      entry.created_by !== tab.you,
    void:
      !!tab.access?.void &&
      !cancelled &&
      entry.created_by === tab.you &&
      (entry.status === "pending" ||
        (entry.status === "recorded" && entry.kind !== "opening" && entry.seq > throughSeq)),
  };
}

export function sharedPeriodCanSettle(period: WebTabResponse, financial: string, pending: string) {
  const { tab, entries } = period;
  const throughSeq = Math.max(0, ...(period.settlements ?? []).map((item) => item.through_seq));
  return (
    !!tab.access?.settle &&
    minorUnits(financial) === 0n &&
    minorUnits(tab.recorded_balance[tab.you]) === 0n &&
    minorUnits(pending) === 0n &&
    !entries.some(
      (entry) =>
        entry.status === "pending" && entry.kind !== "void" && entry.voided_by_entry_id == null,
    ) &&
    entries.some((entry) => entry.seq > throughSeq && entry.kind !== "void")
  );
}

export type SharedHistoryItem =
  | { kind: "entry"; entry: WebTabEntry }
  | { kind: "settlement"; settlement: WebTabSettlement };

// Chapter boundaries follow server sequence, including backdated tallies.
export function sharedPeriodHistory(period: WebTabResponse): SharedHistoryItem[] {
  const entries = [...period.entries].sort((a, b) => b.seq - a.seq);
  const markers = [...(period.settlements ?? [])].sort((a, b) => b.through_seq - a.through_seq);
  const history: SharedHistoryItem[] = [];
  let marker = 0;
  for (const entry of entries) {
    while (marker < markers.length && entry.seq <= markers[marker].through_seq) {
      history.push({ kind: "settlement", settlement: markers[marker++] });
    }
    history.push({ kind: "entry", entry });
  }
  for (; marker < markers.length; marker++)
    history.push({ kind: "settlement", settlement: markers[marker] });
  return history;
}

export function sharedHistoryCSV(
  person: WebPerson,
  periods: readonly WebTabResponse[],
  privateEntries: readonly WebEntry[],
  copy: SharedTalliesCopy,
) {
  const rows: unknown[][] = [copy.exportColumns];
  const status = {
    pending: copy.pendingStatus,
    accepted: copy.accepted,
    disputed: copy.disputed,
    recorded: copy.recordedStatus,
  };
  for (const period of periods) {
    const { tab } = period;
    for (const entry of [...period.entries].sort((a, b) => a.seq - b.seq)) {
      const gave = (entry.direction === "a_to_b" ? "a" : "b") === tab.you;
      const type =
        entry.kind === "opening"
          ? copy.opening
          : entry.kind === "void"
            ? copy.void
            : gave
              ? copy.gave
              : copy.received;
      rows.push([
        person.name,
        copy.title,
        tab.id,
        tab.currency,
        new Date(entry.occurred_at_ms).toISOString(),
        type,
        entry.amount,
        entry.note,
        status[entry.status],
        entry.author_name ||
          tab.parties[entry.created_by]?.account_name ||
          tab.parties[entry.created_by]?.label ||
          "",
        entry.reviewer_name || "",
        entry.voids_entry_id,
        entry.voided_by_entry_id,
        entry.seq,
        entry.id,
      ]);
    }
    for (const settlement of period.settlements ?? []) {
      rows.push([
        person.name,
        copy.title,
        tab.id,
        tab.currency,
        new Date(settlement.settled_at_ms).toISOString(),
        copy.settled,
        "",
        "",
        copy.settled,
        settlement.actor_name,
        "",
        "",
        "",
        settlement.through_seq,
        settlement.id,
      ]);
    }
  }
  for (const entry of privateEntries
    .filter((item) => item.relationship_id === person.relationship_id && !item.is_deleted)
    .sort((a, b) => a.created_at - b.created_at || a.id.localeCompare(b.id))) {
    rows.push([
      person.name,
      copy.privateHistory,
      "",
      entry.currency,
      new Date(entry.created_at).toISOString(),
      entry.type === "debt" ? copy.gave : copy.received,
      String(entry.amount_afn),
      entry.note,
      entry.disputed_at != null
        ? copy.disputed
        : entry.settled_at != null
          ? copy.settled
          : copy.current,
      "",
      "",
      "",
      "",
      "",
      entry.id,
    ]);
  }
  return "\ufeff" + rows.map((row) => row.map(csvCell).join(",")).join("\r\n");
}
