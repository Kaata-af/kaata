import type { LocaleCode } from "./i18n";
import type { Direction, PersonWithBalance } from "./types";

// "Last tally · newest first" was dropped: it only differed from "Recent
// activity" by mixing settled customers in. A saved "date_desc" parses as
// "recent", which orders open customers identically.
export const CUSTOMER_SORTS = [
  "outstanding_name",
  "recent",
  "name_asc",
  "name_desc",
  "amount_desc",
  "amount_asc",
  "date_asc",
] as const;
export type CustomerSort = (typeof CUSTOMER_SORTS)[number];
export type CustomerGroupFilter = "all" | "ungrouped" | string | string[];
export type CustomerListPreference = { sort: CustomerSort; group: CustomerGroupFilter };
export const DEFAULT_CUSTOMER_LIST: CustomerListPreference = { sort: "recent", group: "all" };
export const DEFAULT_CUSTOMER_SEARCH: CustomerListPreference = {
  sort: "outstanding_name",
  group: "all",
};

/** Empty selection means All. Selecting several groups matches any of them. */
export function selectedCustomerGroupIds(filter: CustomerGroupFilter): string[] {
  if (filter === "all" || filter === "ungrouped") return [];
  return Array.isArray(filter) ? [...new Set(filter)].sort() : [filter];
}

export function availableCustomerGroupFilter(
  filter: CustomerGroupFilter,
  available: readonly { id: string }[],
): CustomerGroupFilter {
  if (filter === "all") return filter;
  // With no groups at all, "Ungrouped" is everyone: show it as no filter.
  if (filter === "ungrouped") return available.length ? filter : "all";
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
  return parsePreference(raw, DEFAULT_CUSTOMER_LIST);
}

/** Search has its own default without changing the home page's ordering. */
export function parseCustomerSearchPreference(raw: string | null): CustomerListPreference {
  return parsePreference(raw, DEFAULT_CUSTOMER_SEARCH);
}

function parsePreference(
  raw: string | null,
  fallback: CustomerListPreference,
): CustomerListPreference {
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
      sort: CUSTOMER_SORTS.includes(value?.sort) ? value.sort : fallback.sort,
      group: groupIds
        ? groupIds.length
          ? groupIds
          : "all"
        : typeof value?.group === "string" && value.group
          ? value.group
          : "all",
    };
  } catch {
    return { ...fallback };
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

/** A saved private contact without financial activity. Unknown shared data,
 * settled accounts and any known balance/history keep their financial side. */
export function isNeverTalliedCustomer(p: PersonWithBalance): boolean {
  return (
    p.last_entry_at == null &&
    p.last_entry_type == null &&
    p.balance === 0 &&
    p.is_settled !== 1 &&
    p.tab_id == null &&
    p.tab_unsynced !== 1
  );
}

/** Persian and Arabic-Indic digits as ASCII, so "۱۰" compares like "10". */
function asciiDigits(value: string): string {
  return value
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660));
}

// At most one collator per supported app language. Keep collation setup out
// of the sort's comparisons without changing the language or sensitivity.
const nameCollators = new Map<LocaleCode, Intl.Collator>();

function nameCollator(locale: LocaleCode): Intl.Collator {
  let collator = nameCollators.get(locale);
  if (!collator) {
    collator = new Intl.Collator(locale, { sensitivity: "base" });
    nameCollators.set(locale, collator);
  }
  return collator;
}

/** Number-aware name order: "Ahmad 2" before "Ahmad 10", "دکان ۲" before "دکان ۱۰". */
export function compareCustomerNames(a: string, b: string, locale: LocaleCode): number {
  const compare = nameCollator(locale).compare;
  const chunks = (value: string) => asciiDigits(value).match(/\d+|\D+/g) ?? [];
  const left = chunks(a);
  const right = chunks(b);
  for (let i = 0; i < Math.min(left.length, right.length); i++) {
    let order: number;
    if (/^\d/.test(left[i]) && /^\d/.test(right[i])) {
      // Compare as integers of any length: fewer significant digits is smaller.
      const x = left[i].replace(/^0+(?=\d)/, "");
      const y = right[i].replace(/^0+(?=\d)/, "");
      order = x.length - y.length || (x < y ? -1 : x > y ? 1 : 0);
    } else {
      order = compare(left[i], right[i]);
    }
    if (order !== 0) return order;
  }
  return left.length - right.length || compare(a, b);
}

/** Sorting/filtering is presentation only: never modifies balances or input. */
export function selectCustomers<T extends PersonWithBalance>(
  people: readonly T[],
  direction: Direction,
  preference: CustomerListPreference,
  groupByPerson: Readonly<Record<string, string | readonly string[] | null>>,
  locale: LocaleCode,
): T[] {
  return selectCustomerRows(
    people,
    (person) => !isNeverTalliedCustomer(person) && customerSide(person) === direction,
    preference,
    groupByPerson,
    locale,
    (person) => person.last_entry_at ?? 0,
  );
}

/** Neutral contacts follow the same groups and sort as the financial lists.
 * For recent/date order, creation replaces the tally date they do not have. */
export function selectNeverTalliedCustomers<T extends PersonWithBalance>(
  people: readonly T[],
  preference: CustomerListPreference,
  groupByPerson: Readonly<Record<string, string | readonly string[] | null>>,
  locale: LocaleCode,
): T[] {
  return selectCustomerRows(
    people,
    isNeverTalliedCustomer,
    preference,
    groupByPerson,
    locale,
    (person) => person.created_at,
  );
}

/** Search interleaves both financial sides and empty contacts. Relevance is a
 * coarse match tier, so literal matches stay above fuzzy suggestions while the
 * selected sort still orders equally relevant results. */
export function selectSearchCustomers<T extends PersonWithBalance>(
  people: readonly T[],
  preference: CustomerListPreference,
  groupByPerson: Readonly<Record<string, string | readonly string[] | null>>,
  locale: LocaleCode,
  relevanceById?: ReadonlyMap<string, number>,
): T[] {
  return selectCustomerRows(
    [...new Map(people.map((person) => [person.id, person])).values()],
    () => true,
    preference,
    groupByPerson,
    locale,
    (person) => person.last_entry_at ?? person.created_at,
    relevanceById,
  );
}

function outstandingTier(person: PersonWithBalance): number {
  // A restored shared ledger's cached balance is unknown, whether it says 500
  // or zero. Keep it between verified balances and confirmed settled contacts.
  if (person.tab_unsynced === 1) return 1;
  return person.balance !== 0 && person.is_settled !== 1 ? 0 : 2;
}

function selectCustomerRows<T extends PersonWithBalance>(
  people: readonly T[],
  matches: (person: T) => boolean,
  preference: CustomerListPreference,
  groupByPerson: Readonly<Record<string, string | readonly string[] | null>>,
  locale: LocaleCode,
  activityAt: (person: T) => number,
  relevanceById?: ReadonlyMap<string, number>,
): T[] {
  const byName = (a: T, b: T) =>
    compareCustomerNames(a.name, b.name, locale) || a.id.localeCompare(b.id);
  const byDate = (a: T, b: T) => activityAt(b) - activityAt(a);
  // Ascending amount/date sorts are for finding debts to chase; settled
  // customers (0, or an old closed account) must not bury the open ones.
  const openFirst = (a: T, b: T) => (a.is_settled === 1 ? 1 : 0) - (b.is_settled === 1 ? 1 : 0);
  const selected = selectedCustomerGroupIds(preference.group);
  return people
    .filter(
      (p) =>
        matches(p) &&
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
      const relevance = (relevanceById?.get(b.id) ?? 0) - (relevanceById?.get(a.id) ?? 0);
      if (relevance) return relevance;
      switch (preference.sort) {
        case "outstanding_name":
          return outstandingTier(a) - outstandingTier(b) || byName(a, b);
        case "name_asc":
          return byName(a, b);
        case "name_desc":
          return -byName(a, b);
        case "amount_desc":
          return Math.abs(b.balance) - Math.abs(a.balance) || byName(a, b);
        case "amount_asc":
          return openFirst(a, b) || Math.abs(a.balance) - Math.abs(b.balance) || byName(a, b);
        case "date_asc":
          return openFirst(a, b) || -byDate(a, b) || byName(a, b);
        default:
          return openFirst(a, b) || byDate(a, b) || byName(a, b);
      }
    });
}
