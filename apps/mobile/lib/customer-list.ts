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
export type CustomerGroupFilter = "all" | "ungrouped" | string | string[];
export type CustomerListPreference = { sort: CustomerSort; group: CustomerGroupFilter };
export const DEFAULT_CUSTOMER_LIST: CustomerListPreference = { sort: "recent", group: "all" };

/** Empty selection means All. Selecting several groups matches any of them. */
export function selectedCustomerGroupIds(filter: CustomerGroupFilter): string[] {
  if (filter === "all" || filter === "ungrouped") return [];
  return Array.isArray(filter) ? [...new Set(filter)].sort() : [filter];
}

export function availableCustomerGroupFilter(
  filter: CustomerGroupFilter,
  available: readonly { id: string }[],
): CustomerGroupFilter {
  if (filter === "all" || filter === "ungrouped") return filter;
  const valid = new Set(available.map((g) => g.id));
  const ids = selectedCustomerGroupIds(filter).filter((id) => valid.has(id));
  return ids.length ? ids : "all";
}

export function toggleCustomerGroupFilter(
  filter: CustomerGroupFilter,
  id: string,
): CustomerGroupFilter {
  const ids = selectedCustomerGroupIds(filter);
  const next = ids.includes(id) ? ids.filter((selected) => selected !== id) : [...ids, id].sort();
  return next.length ? next : "all";
}

export function parseCustomerListPreference(raw: string | null): CustomerListPreference {
  try {
    const value = JSON.parse(raw ?? "null");
    const groupIds = Array.isArray(value?.group)
      ? [
          ...new Set<string>(
            value.group.filter(
              (id: unknown) =>
                typeof id === "string" && id.length > 0 && id !== "all" && id !== "ungrouped",
            ),
          ),
        ]
          .sort()
          .slice(0, 100)
      : null;
    return {
      sort: CUSTOMER_SORTS.includes(value?.sort) ? value.sort : "recent",
      group: groupIds
        ? groupIds.length
          ? groupIds
          : "all"
        : typeof value?.group === "string" && value.group
          ? value.group
          : "all",
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
  groupByPerson: Readonly<Record<string, string | readonly string[] | null>>,
  locale: "en" | "fa",
): T[] {
  const byName = (a: T, b: T) =>
    a.name.localeCompare(b.name, locale, { sensitivity: "base" }) || a.id.localeCompare(b.id);
  const byDate = (a: T, b: T) => (b.last_entry_at ?? 0) - (a.last_entry_at ?? 0);
  const selected = selectedCustomerGroupIds(preference.group);
  return people
    .filter(
      (p) =>
        customerSide(p) === direction &&
        (preference.group === "all" ||
          (() => {
            const membership = groupByPerson[p.id];
            const ids = typeof membership === "string" ? [membership] : (membership ?? []);
            return preference.group === "ungrouped"
              ? ids.length === 0
              : selected.length === 0 || ids.some((id) => selected.includes(id));
          })()),
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
