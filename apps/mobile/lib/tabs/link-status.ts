import type { PersonWithBalance } from "../types";
import type { TabLink } from "./types";

export type SharedAccountStatus = "none" | "waiting" | "joined" | "declined";

type PersonLinkState = Partial<
  Pick<
    PersonWithBalance,
    "tab_id" | "tab_closed_at" | "tab_other_joined" | "tab_invitation_declined_at"
  >
> & { currency_balances?: readonly PersonLinkState[] };

/** Joined means the other person explicitly joined, not just that an invite exists. */
export function sharedAccountLinkStatus(
  link:
    | Pick<TabLink, "closed_at" | "other_joined_at" | "invitation_declined_at">
    | null
    | undefined,
): SharedAccountStatus {
  if (!link || link.closed_at != null) return "none";
  if (typeof link.other_joined_at === "number" && Number.isFinite(link.other_joined_at))
    return "joined";
  return link.invitation_declined_at != null ? "declined" : "waiting";
}

export function combinedSharedAccountStatus(
  statuses: readonly SharedAccountStatus[],
): SharedAccountStatus {
  if (statuses.includes("joined")) return "joined";
  if (statuses.includes("waiting")) return "waiting";
  return statuses.includes("declined") ? "declined" : "none";
}

/** Currency rows carry their own join state; the merged wrapper may mix fields. */
export function personSharedAccountStatus(person: PersonLinkState): SharedAccountStatus {
  const rows = person.currency_balances?.length ? person.currency_balances : [person];
  return combinedSharedAccountStatus(
    rows.map((row) => {
      if (!row.tab_id || row.tab_closed_at != null) return "none";
      if (row.tab_other_joined === 1) return "joined";
      return row.tab_invitation_declined_at != null ? "declined" : "waiting";
    }),
  );
}
