import type { WebEntry } from "./web-ledger";
import { asciiDigits, localDateValue, minorUnits } from "../pages/workspace/model";

export type HistoryDatePreset = "all" | "today" | "last7" | "last30" | "month" | "custom";
export type HistoryFilters = {
  query: string;
  currency: string;
  preset: HistoryDatePreset;
  from: string;
  to: string;
};
export type HistoryCurrencySummary = {
  currency: string;
  given: bigint;
  received: bigint;
  givenCount: number;
  receivedCount: number;
};
export const EMPTY_HISTORY_FILTERS: HistoryFilters = {
  query: "",
  currency: "",
  preset: "all",
  from: "",
  to: "",
};

function normalizedText(text: string): string {
  return asciiDigits(text)
    .replace(/[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "")
    .trim()
    .toLocaleLowerCase();
}

/** Exact monetary search accepts the localized decimal/grouping formats that
 * people see in the ledger. Ambiguous malformed grouping is not guessed. */
export function historySearchAmount(text: string): bigint | null {
  let value = normalizedText(text).replace(/−/g, "-").replace(/٫/g, ".");
  if (/^-?\d{1,3}(?:[,٬]\d{3})+(?:\.\d{1,2})?$/.test(value)) value = value.replace(/[,٬]/g, "");
  else if (/^-?\d*,\d{0,2}$/.test(value)) value = value.replace(",", ".");
  if (/^-?\.\d{1,2}$/.test(value)) value = value.replace(".", "0.");
  if (value.endsWith(".")) value = value.slice(0, -1);
  if (!/^-?\d+(?:\.\d{1,2})?$/.test(value)) return null;
  return minorUnits(value);
}

export function historyMatchesQuery(entry: WebEntry, query: string): boolean {
  const needle = normalizedText(query);
  if (!needle) return true;
  const amount = historySearchAmount(needle);
  const note = normalizedText(entry.note ?? "");
  if (amount === null) return note.includes(needle);
  if (minorUnits(String(entry.amount_afn)) === amount) return true;
  // A numeric query may find a note's whole number, never part of a larger
  // amount such as 500 inside 1500. Non-numeric note searches stay ordinary text.
  return (note.match(/[-−]?\d[\d.,٬٫]*/g) ?? []).some(
    (token) => historySearchAmount(token) === amount,
  );
}

function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const timestamp = new Date(`${value}T12:00:00`).getTime();
  return Number.isFinite(timestamp) && localDateValue(timestamp) === value;
}

export function historyDateRange(
  filters: HistoryFilters,
  now = Date.now(),
): {
  from: string | null;
  to: string | null;
  valid: boolean;
} {
  if (filters.preset === "all") return { from: null, to: null, valid: true };
  if (filters.preset === "custom") {
    const from = filters.from || null,
      to = filters.to || null;
    return {
      from,
      to,
      valid: (!from || validDate(from)) && (!to || validDate(to)) && !(from && to && from > to),
    };
  }
  const date = new Date(now);
  const to = localDateValue(now);
  if (filters.preset === "last7") date.setDate(date.getDate() - 6);
  else if (filters.preset === "last30") date.setDate(date.getDate() - 29);
  else if (filters.preset === "month") date.setDate(1);
  return { from: localDateValue(date.getTime()), to, valid: true };
}

export function historyFiltersActive(filters: HistoryFilters): boolean {
  return !!(filters.query.trim() || filters.currency || filters.preset !== "all");
}

export function filterEntryHistory(
  entries: readonly WebEntry[],
  filters: HistoryFilters,
  now = Date.now(),
): WebEntry[] {
  const range = historyDateRange(filters, now);
  if (!range.valid) return [];
  return entries
    .filter((entry) => {
      if (entry.is_deleted || (filters.currency && entry.currency !== filters.currency))
        return false;
      const date = localDateValue(entry.created_at);
      if ((range.from && date < range.from) || (range.to && date > range.to)) return false;
      return historyMatchesQuery(entry, filters.query);
    })
    .sort((a, b) => b.created_at - a.created_at || b.id.localeCompare(a.id));
}

/** Totals describe the whole private history, independent of display filters.
 * Disputed records remain visible but do not contribute to money or counts. */
export function summarizeEntryHistory(entries: readonly WebEntry[]): HistoryCurrencySummary[] {
  const currencies = new Map<string, HistoryCurrencySummary>();
  for (const entry of entries) {
    if (entry.is_deleted || entry.disputed_at != null) continue;
    const row = currencies.get(entry.currency) ?? {
      currency: entry.currency,
      given: 0n,
      received: 0n,
      givenCount: 0,
      receivedCount: 0,
    };
    if (entry.type === "debt") {
      row.given += minorUnits(String(entry.amount_afn));
      row.givenCount++;
    } else {
      row.received += minorUnits(String(entry.amount_afn));
      row.receivedCount++;
    }
    currencies.set(entry.currency, row);
  }
  return [...currencies.values()].sort((a, b) => a.currency.localeCompare(b.currency));
}
