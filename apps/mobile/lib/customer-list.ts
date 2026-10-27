import type { LocaleCode } from "./i18n";
import type { Direction, PersonWithBalance } from "./types";

// "Last tally · newest first" was dropped: it only differed from "Recent
// activity" by mixing settled customers in. A saved "date_desc" parses as
// "recent", which orders open customers identically.
export const CUSTOMER_SORTS = [
  "recent",
  "outstanding_name",
  "name_asc",
  "name_desc",
  "amount_desc",
  "amount_asc",
  "date_asc",
] as const;
export type CustomerSort = (typeof CUSTOMER_SORTS)[number];
export const CUSTOMER_BALANCE_FILTERS = ["all", "collect", "pay"] as const;
export type CustomerBalanceFilter = (typeof CUSTOMER_BALANCE_FILTERS)[number];
export type CustomerGroupFilter = "all" | "ungrouped" | string | string[];
export type CustomerListPreference = {
  sort: CustomerSort;
  group: CustomerGroupFilter;
  direction?: CustomerBalanceFilter;
  currency?: string;
};
export const DEFAULT_CUSTOMER_LIST: CustomerListPreference = {
  sort: "recent",
  group: "all",
  direction: "all",
};
export const DEFAULT_CUSTOMER_SEARCH: CustomerListPreference = {
  sort: "outstanding_name",
  group: "all",
  direction: "all",
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

function normalizeCustomerCurrency(currency: unknown): string | undefined {
  if (typeof currency !== "string") return undefined;
  const code = currency.trim().toUpperCase();
  return code !== "ALL" && /^[A-Z]{3}$/.test(code) ? code : undefined;
}

export function availableCustomerCurrencyFilter(
  currency: string | undefined,
  codes: readonly string[],
): string | undefined {
  const code = normalizeCustomerCurrency(currency);
  return code && codes.some((available) => normalizeCustomerCurrency(available) === code)
    ? code
    : undefined;
}

/** A specific denomination is a projection of an actual currency row. Missing
 * rows never become foreign-currency zeros, including for never-tallied people. */
export function filterCustomerCurrencyRows<T extends PersonWithBalance>(
  people: readonly T[],
  currency?: string,
): T[] {
  const code = normalizeCustomerCurrency(currency);
  if (!code) return [...people];
  return people.flatMap((person) => {
    const rows = person.currency_balances ?? [person];
    const row = rows.find((candidate) => normalizeCustomerCurrency(candidate.currency) === code);
    if (!row) return [];
    return [
      {
        ...person,
        ...row,
        id: person.id,
        name: person.name,
        phone: person.phone,
        created_at: person.created_at,
        archived_at: person.archived_at,
        currency: code,
        currency_balances: [row],
        // Optional metadata must also come from this denomination: an absent
        // value cannot inherit another currency's shared or settled state.
        tab_confirmed_balance: row.tab_confirmed_balance,
        tab_recorded_balance: row.tab_recorded_balance,
        tab_pending_balance: row.tab_pending_balance,
        tab_pending_count: row.tab_pending_count,
        tab_close_pending: row.tab_close_pending,
        tab_account_name: row.tab_account_name,
        tab_unsynced: row.tab_unsynced,
        last_entry_type: row.last_entry_type,
        is_settled: row.is_settled,
        selection_totals: row.selection_totals,
      },
    ];
  });
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

/** The unified homepage starts with recent activity. Its old search preference
 * could save the search default during an unrelated group change, so migrate
 * that implicit order once while retaining groups and other chosen sorts. */
export function parseHomeCustomerListPreference(
  raw: string | null,
  legacySearchRaw: string | null,
): CustomerListPreference {
  if (raw !== null) return parseCustomerListPreference(raw);
  const preference = parseCustomerListPreference(legacySearchRaw);
  return preference.sort === DEFAULT_CUSTOMER_SEARCH.sort
    ? { ...preference, sort: DEFAULT_CUSTOMER_LIST.sort }
    : preference;
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
    const currency = normalizeCustomerCurrency(value?.currency);
    return {
      sort: CUSTOMER_SORTS.includes(value?.sort) ? value.sort : fallback.sort,
      direction: CUSTOMER_BALANCE_FILTERS.includes(value?.direction) ? value.direction : "all",
      ...(currency ? { currency } : {}),
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
  const directionBalance =
    p.balance || ((p.tab_pending_count ?? 0) > 0 ? (p.tab_pending_balance ?? 0) : 0);
  return directionBalance > 0
    ? "collect"
    : directionBalance < 0
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
 * coarse match tier, except an explicit amount sort orders confirmed amounts
 * first and uses relevance only to break equal amounts/status tiers. */
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
  if (person.currency_balances?.length)
    return Math.min(...person.currency_balances.map(outstandingTier));
  // A restored shared ledger's cached balance is unknown, whether it says 500
  // or zero. Keep it between verified balances and confirmed settled contacts.
  if (person.tab_unsynced === 1) return 1;
  return (person.tab_pending_count ?? 0) > 0 || (person.balance !== 0 && person.is_settled !== 1)
    ? 0
    : 2;
}

/** Each known denomination can qualify independently. Pending deltas and the
 * merged parent's unknown flag do not replace a currency's confirmed balance. */
function matchesBalanceFilter(
  person: PersonWithBalance,
  direction?: CustomerBalanceFilter,
): boolean {
  if (direction !== "collect" && direction !== "pay") return true;
  const rows = person.currency_balances?.length ? person.currency_balances : [person];
  return rows.some(
    (row) =>
      row.tab_unsynced !== 1 &&
      row.is_settled !== 1 &&
      Number.isFinite(row.balance) &&
      (direction === "collect" ? row.balance > 0 : row.balance < 0),
  );
}

function amountSortRow(person: PersonWithBalance): PersonWithBalance {
  const rows = person.currency_balances;
  return rows?.length === 1 ? rows[0] : person;
}

function amountSortTier(person: PersonWithBalance): number {
  const row = amountSortRow(person);
  // An unknown cached balance has no comparable magnitude. Pending deltas also
  // cannot turn a confirmed zero into an outstanding amount.
  if (row.tab_unsynced === 1 || !Number.isFinite(row.balance)) return 1;
  return row.balance !== 0 && row.is_settled !== 1 ? 0 : 2;
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
  const byAmount = (a: T, b: T, order: 1 | -1) => {
    const tierA = amountSortTier(a);
    const tierB = amountSortTier(b);
    return (
      tierA - tierB ||
      (tierA === 0
        ? order * (Math.abs(amountSortRow(a).balance) - Math.abs(amountSortRow(b).balance))
        : 0)
    );
  };
  // Date sorts keep explicitly settled contacts after open ones.
  const openFirst = (a: T, b: T) => (a.is_settled === 1 ? 1 : 0) - (b.is_settled === 1 ? 1 : 0);
  const selected = selectedCustomerGroupIds(preference.group);
  return filterCustomerCurrencyRows(people, preference.currency)
    .filter(
      (p) =>
        matches(p) &&
        matchesBalanceFilter(p, preference.direction) &&
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
      if (preference.sort === "amount_asc" || preference.sort === "amount_desc")
        return (
          byAmount(a, b, preference.sort === "amount_asc" ? 1 : -1) || relevance || byName(a, b)
        );
      if (relevance) return relevance;
      switch (preference.sort) {
        case "outstanding_name":
          return outstandingTier(a) - outstandingTier(b) || byName(a, b);
        case "name_asc":
          return byName(a, b);
        case "name_desc":
          return -byName(a, b);
        case "date_asc":
          return openFirst(a, b) || -byDate(a, b) || byName(a, b);
        default:
          return openFirst(a, b) || byDate(a, b) || byName(a, b);
      }
    });
}
