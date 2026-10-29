import { isValidCurrencyCode } from "./currency-scope";
import { toMinorUnits } from "./money";
import type { EntryType } from "./types";

export type TallyDirectionFilter = "all" | "received" | "gave";
export type TallySort = "recent" | "date_asc" | "amount_desc" | "amount_asc";
export type TallyListFilter = {
  direction: TallyDirectionFilter;
  currencies: string[];
  sort: TallySort;
};

export const DEFAULT_TALLY_LIST_FILTER: TallyListFilter = {
  direction: "all",
  currencies: [],
  sort: "recent",
};

export function normalizeTallyCurrencies(currencies: unknown): string[] {
  return [
    ...new Set(
      (Array.isArray(currencies) ? currencies : [currencies])
        .filter((code): code is string => typeof code === "string")
        .map((code) => code.trim().toUpperCase())
        .filter(isValidCurrencyCode),
    ),
  ].sort();
}

/** Amounts can only be compared within one denomination, never by exchange rate. */
export function tallyAmountSortAvailable(
  filter: Pick<TallyListFilter, "currencies">,
  availableCodes: readonly string[],
): boolean {
  const available = normalizeTallyCurrencies(availableCodes);
  const selected = normalizeTallyCurrencies(filter.currencies);
  return selected.length === 1
    ? available.includes(selected[0])
    : selected.length === 0 && available.length === 1;
}

export function normalizeTallyListFilter(
  filter: Partial<TallyListFilter> | null | undefined,
  availableCodes: readonly string[],
): TallyListFilter {
  const available = normalizeTallyCurrencies(availableCodes);
  const direction =
    filter?.direction === "received" || filter?.direction === "gave" ? filter.direction : "all";
  const currencies = normalizeTallyCurrencies(filter?.currencies).filter((code) =>
    available.includes(code),
  );
  const sort =
    filter?.sort === "date_asc" || filter?.sort === "amount_asc" || filter?.sort === "amount_desc"
      ? filter.sort
      : "recent";
  const next = { direction, currencies, sort } as TallyListFilter;
  return sort.startsWith("amount_") && !tallyAmountSortAvailable(next, available)
    ? { ...next, sort: "recent" }
    : next;
}

type FilterableTally = { type: EntryType; currency?: string };
function entryCurrency(entry: { currency?: string }, fallbackCurrency?: string): string | null {
  const code = entry.currency ?? fallbackCurrency;
  return isValidCurrencyCode(code) ? code : null;
}

/** Filtering is a view only. Preserve every matching status and original row. */
export function filterTallyEntries<T extends FilterableTally>(
  entries: readonly T[],
  filter: Pick<TallyListFilter, "direction" | "currencies">,
  fallbackCurrency: string,
): T[] {
  const currencies = normalizeTallyCurrencies(filter.currencies);
  const type =
    filter.direction === "received" ? "payment" : filter.direction === "gave" ? "debt" : null;
  return entries.filter(
    (entry) =>
      (type == null || entry.type === type) &&
      (!currencies.length || currencies.includes(entryCurrency(entry, fallbackCurrency) ?? "")),
  );
}

export class TallyAmountSortCurrencyError extends Error {
  constructor() {
    super("Choose one currency before sorting tallies by amount");
    this.name = "TallyAmountSortCurrencyError";
  }
}

type SortableTally = { amount_afn: number; created_at: number; currency?: string };

/** Stable view ordering; zeros and invalid failed amounts never lead amount sorts. */
export function sortTallyEntries<T extends SortableTally>(
  entries: readonly T[],
  sort: TallySort,
  fallbackCurrency?: string,
): T[] {
  const byAmount = sort === "amount_asc" || sort === "amount_desc";
  if (byAmount) {
    const codes = new Set(entries.map((entry) => entryCurrency(entry, fallbackCurrency)));
    if (codes.has(null) || codes.size > 1) throw new TallyAmountSortCurrencyError();
  }
  const rows = entries.map((entry, index) => {
    let amount: number | null = null;
    if (byAmount)
      try {
        amount = Math.abs(toMinorUnits(entry.amount_afn));
      } catch {
        // Failed local records remain visible, after valid comparable amounts.
      }
    return { entry, index, amount };
  });
  rows.sort((a, b) => {
    if (byAmount) {
      const rank = (minor: number | null) => (minor == null ? 2 : minor === 0 ? 1 : 0);
      const bucket = rank(a.amount) - rank(b.amount);
      if (bucket) return bucket;
      if (a.amount != null && b.amount != null && a.amount !== b.amount)
        return sort === "amount_asc" ? a.amount - b.amount : b.amount - a.amount;
    }
    const aValid = Number.isFinite(a.entry.created_at),
      bValid = Number.isFinite(b.entry.created_at);
    if (aValid !== bValid) return aValid ? -1 : 1;
    if (aValid && a.entry.created_at !== b.entry.created_at)
      return sort === "date_asc"
        ? a.entry.created_at - b.entry.created_at
        : b.entry.created_at - a.entry.created_at;
    return a.index - b.index;
  });
  return rows.map((row) => row.entry);
}

/** A card selects its side and currency; tapping that exact choice clears both. */
export function toggleTallyCardFilter(
  filter: TallyListFilter,
  direction: Exclude<TallyDirectionFilter, "all">,
  currency: string,
  availableCodes: readonly string[],
): TallyListFilter {
  const available = normalizeTallyCurrencies(availableCodes);
  const current = normalizeTallyListFilter(filter, available);
  if (!available.includes(currency)) return current;
  const scoped = available.length > 1;
  const same =
    current.direction === direction &&
    (!scoped || (current.currencies.length === 1 && current.currencies[0] === currency));
  return normalizeTallyListFilter(
    {
      ...current,
      direction: same ? "all" : direction,
      currencies: scoped && !same ? [currency] : [],
    },
    available,
  );
}

/** Repeated list swipes keep their side and widen it to every contact currency. */
export function swipeTallyDirection(
  filter: TallyListFilter,
  direction: Exclude<TallyDirectionFilter, "all">,
  availableCodes: readonly string[] = [],
): TallyListFilter {
  return normalizeTallyListFilter({ ...filter, direction, currencies: [] }, availableCodes);
}
