import type { Direction, PersonWithBalance } from "./types";

export const CUSTOMER_SORTS = [
  "recent",
  "name_asc",
  "name_desc",
  "amount_desc",
  "amount_asc",
  "date_desc",
  "date_asc",
] as const;
export type CustomerSort = (typeof CUSTOMER_SORTS)[number];
export type CustomerGroupFilter = "all" | "ungrouped" | string;
export type CustomerListPreference = { sort: CustomerSort; group: CustomerGroupFilter };
export const DEFAULT_CUSTOMER_LIST: CustomerListPreference = { sort: "recent", group: "all" };

export function parseCustomerListPreference(raw: string | null): CustomerListPreference {
  try {
    const value = JSON.parse(raw ?? "null");
    return {
      sort: CUSTOMER_SORTS.includes(value?.sort) ? value.sort : "recent",
      group: typeof value?.group === "string" && value.group ? value.group : "all",
    };
  } catch {
    return { ...DEFAULT_CUSTOMER_LIST };
  }
}

/** Settled people keep the side of their preceding balance. */
export function customerSide(p: PersonWithBalance): Direction {
  return p.balance > 0
    ? "collect"
    : p.balance < 0
      ? "pay"
      : p.last_entry_type === "debt"
        ? "pay"
        : "collect";
}

/** Sorting/filtering is presentation only: never modifies balances or input. */
export function selectCustomers<T extends PersonWithBalance>(
  people: readonly T[],
  direction: Direction,
  preference: CustomerListPreference,
  groupByPerson: Readonly<Record<string, string | null>>,
  locale: "en" | "fa",
): T[] {
  const byName = (a: T, b: T) =>
    a.name.localeCompare(b.name, locale, { sensitivity: "base" }) || a.id.localeCompare(b.id);
  const byDate = (a: T, b: T) => (b.last_entry_at ?? 0) - (a.last_entry_at ?? 0);
  return people
    .filter(
      (p) =>
        customerSide(p) === direction &&
        (preference.group === "all" ||
          (preference.group === "ungrouped"
            ? !groupByPerson[p.id]
            : groupByPerson[p.id] === preference.group)),
    )
    .sort((a, b) => {
      switch (preference.sort) {
        case "name_asc":
          return byName(a, b);
        case "name_desc":
          return -byName(a, b);
        case "amount_desc":
          return Math.abs(b.balance) - Math.abs(a.balance) || byName(a, b);
        case "amount_asc":
          return Math.abs(a.balance) - Math.abs(b.balance) || byName(a, b);
        case "date_desc":
          return byDate(a, b) || byName(a, b);
        case "date_asc":
          return -byDate(a, b) || byName(a, b);
        default:
          return (
            (a.is_settled === 1 ? 1 : 0) - (b.is_settled === 1 ? 1 : 0) ||
            byDate(a, b) ||
            byName(a, b)
          );
      }
    });
}
