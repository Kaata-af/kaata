import { tIn, type LocaleCode } from "../i18n";
import type { TabEntryMeta } from "../tabs/types";

export function recordStatus(tab: TabEntryMeta | undefined, locale: LocaleCode): string {
  if (!tab) return tIn(locale, "export.record.private");
  if (tab.local_pending) {
    if (tab.voided) return tIn(locale, "export.record.cancellationAwaitingSync");
    if (tab.status === "accepted") return tIn(locale, "export.record.acceptanceAwaitingSync");
    if (tab.status === "disputed") return tIn(locale, "export.record.rejectionAwaitingSync");
  }
  return tIn(
    locale,
    tab.voided
      ? "export.record.cancelled"
      : tab.status === "accepted"
        ? "export.record.accepted"
        : tab.status === "disputed"
          ? "export.record.rejected"
          : "export.record.pending",
  );
}

/** Absolute server times are exported with UTC explicitly, not as a business date. */
export function evidenceTime(ms: number | null | undefined): string {
  return ms != null && Number.isFinite(ms) ? new Date(ms).toISOString() : "";
}

export const EVIDENCE_KEYS = [
  "export.record.status",
  "export.record.sync",
  "export.record.tabId",
  "export.record.author",
  "export.record.authorId",
  "export.record.authorRole",
  "export.record.recordedAt",
  "export.record.reviewer",
  "export.record.reviewerId",
  "export.record.reviewerParty",
  "export.record.reviewerRole",
  "export.record.reviewedAt",
  "export.record.reviewVersion",
  "export.record.reason",
  "export.record.cancelledBy",
  "export.record.cancelledById",
  "export.record.cancelledAt",
  "export.record.cancellationId",
  "export.record.seq",
  "export.record.rev",
] as const;

export function evidenceCells(tab: TabEntryMeta | undefined, locale: LocaleCode): string[] {
  if (!tab) return [recordStatus(tab, locale), ...EVIDENCE_KEYS.slice(1).map(() => "")];
  // A queued offline review is intent, not a server-recorded acknowledgement.
  const reviewed = !tab.local_pending && tab.status !== "pending";
  return [
    recordStatus(tab, locale),
    tIn(locale, tab.local_pending ? "export.record.awaitingSync" : "export.record.saved"),
    tab.tab_id ?? "",
    tab.author_name ?? "",
    tab.author_account_id ?? "",
    tab.author_member_role ?? "",
    tab.seq != null && tab.seq > 0 ? evidenceTime(tab.recorded_at) : "",
    reviewed ? (tab.reviewer_name ?? "") : "",
    reviewed ? (tab.reviewer_account_id ?? "") : "",
    reviewed ? (tab.reviewer_party ?? "") : "",
    reviewed ? (tab.reviewer_member_role ?? "") : "",
    reviewed ? evidenceTime(tab.status_at) : "",
    reviewed ? (tab.review_semantics_version ?? "") : "",
    tab.dispute_reason ?? "",
    !tab.local_pending ? (tab.cancelled_by_name ?? "") : "",
    !tab.local_pending ? (tab.cancelled_by_account_id ?? "") : "",
    !tab.local_pending ? evidenceTime(tab.cancelled_at) : "",
    !tab.local_pending ? (tab.cancellation_entry_id ?? "") : "",
    tab.seq != null && tab.seq > 0 ? String(tab.seq) : "",
    tab.rev != null && tab.rev > 0 ? String(tab.rev) : "",
  ];
}
