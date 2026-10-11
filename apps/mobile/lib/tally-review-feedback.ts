import type { TabEntryStatus } from "./tabs/types";
import type { Entry } from "./types";

type ReviewState = { status: TabEntryStatus; tabId?: string };
export type ReviewSnapshot = Map<string, ReviewState>;
export type TallyReviewChange = { entry: Entry; status: "accepted" | "disputed" };

/** Compare already displayed tallies with confirmed server decisions. A cold
 * load is a baseline, and optimistic decisions remain pending until acked. */
export function compareTallyReviews(
  previous: ReviewSnapshot | null,
  entries: Entry[],
): { snapshot: ReviewSnapshot; changes: TallyReviewChange[] } {
  const snapshot: ReviewSnapshot = new Map();
  const changes: TallyReviewChange[] = [];
  for (const entry of entries) {
    const tab = entry.tab;
    if (!tab || tab.voided || tab.kind === "void") continue;
    const before = previous?.get(entry.id);
    const sameTab = before?.tabId === tab.tab_id;
    const status =
      tab.local_pending && sameTab && before?.status === "pending" ? "pending" : tab.status;
    snapshot.set(entry.id, { status, tabId: tab.tab_id });
    if (
      sameTab &&
      before?.status === "pending" &&
      !tab.local_pending &&
      (tab.status === "accepted" || tab.status === "disputed")
    ) {
      changes.push({ entry, status: tab.status });
    }
  }
  return { snapshot, changes };
}
