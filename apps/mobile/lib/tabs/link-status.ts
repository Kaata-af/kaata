import type { PersonWithBalance } from "../types";
import type { TabLink } from "./types";

export type SharedAccountStatus = "none" | "waiting" | "joined";

type PersonLinkState = Partial<
  Pick<PersonWithBalance, "tab_id" | "tab_closed_at" | "tab_other_joined">
> & { currency_balances?: readonly PersonLinkState[] };

/** Joined means the other person explicitly joined, not just that an invite exists. */
export function sharedAccountLinkStatus(
  link: Pick<TabLink, "closed_at" | "other_joined_at"> | null | undefined,
): SharedAccountStatus {
  if (!link || link.closed_at != null) return "none";
  return typeof link.other_joined_at === "number" && Number.isFinite(link.other_joined_at)
    ? "joined"
    : "waiting";
}

/** Currency rows carry their own join state; the merged wrapper may mix fields. */
export function personSharedAccountStatus(person: PersonLinkState): SharedAccountStatus {
  const rows = person.currency_balances?.length ? person.currency_balances : [person];
  let waiting = false;
  for (const row of rows) {
    if (!row.tab_id || row.tab_closed_at != null) continue;
    if (row.tab_other_joined === 1) return "joined";
    waiting = true;
  }
  return waiting ? "waiting" : "none";
}
