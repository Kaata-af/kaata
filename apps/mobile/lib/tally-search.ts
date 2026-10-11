import { toAsciiDigits } from "./digits";
import type { Calendar } from "./calendar";
import { toMinorUnits } from "./money";

// Search normalization only. Never change the stored note: ZWNJs and script
// choices are part of what the author wrote, even when matching ignores them.
function normalizeNote(text: string): string {
  return toAsciiDigits(text)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f\u064b-\u065f\u0670]/g, "")
    .replace(/ي|ى/g, "ی")
    .replace(/ك/g, "ک")
    .replace(/[\u200c\u200d\u0640\u200e\u200f\u2066-\u2069]/g, "")
    .toLowerCase()
    .trim();
}

export type TallySearchOptions = { locale: "en" | "fa"; calendar: Calendar };

type SearchableTally = { note: string | null; amount_afn: number; created_at: number };
// Exact value matching makes 500 distinct from 5000. Accept the displayed
// comma grouping, Persian grouping/decimal marks and harmless decimal zeros.
// Never strip arbitrary punctuation: malformed grouping must not become money.
function searchAmountMinor(term: string): number | null {
  let amount = term.replace(/٫/g, ".");
  if (/^\d{1,3}(?:[,٬]\d{3})+(?:\.\d{1,2})?$/.test(amount)) {
    amount = amount.replace(/[,٬]/g, "");
  } else if (/^\d+,\d{1,2}$/.test(amount)) {
    amount = amount.replace(",", ".");
  }
  if (!/^(?:\d+(?:\.\d{0,2})?|\.\d{1,2})$/.test(amount)) return null;
  try {
    return toMinorUnits(Number(amount));
  } catch {
    return null;
  }
}

/** Each term matches the literal note or an exact amount. Dates have their
 * own explicit range control, so a query of 20 cannot match the 20th day. */
export function filterTallies<T extends SearchableTally>(
  entries: readonly T[],
  terms: readonly string[],
  _options?: TallySearchOptions,
): T[] {
  if (terms.length === 0) return [...entries];
  const queries = terms.map((term) => ({ term, amount: searchAmountMinor(term) }));
  return entries.filter((entry) => {
    const note = normalizeNote(entry.note ?? "");
    let amount: number | null = null;
    try {
      amount = Math.abs(toMinorUnits(entry.amount_afn));
    } catch {
      /* Invalid failed tally. */
    }
    return queries.every(
      (query) => note.includes(query.term) || (query.amount !== null && query.amount === amount),
    );
  });
}

export function noteSearchTerms(query: string): string[] {
  return normalizeNote(query).split(/\s+/).filter(Boolean);
}

// Every word must appear in the note; order and punctuation are literal.
// Keep ledger order and original objects, including pending/rejected metadata.
export function filterTalliesByNote<T extends { note: string | null }>(
  entries: readonly T[],
  terms: readonly string[],
): T[] {
  if (terms.length === 0) return [...entries];
  return entries.filter((entry) => {
    if (!entry.note) return false;
    const note = normalizeNote(entry.note);
    return terms.every((term) => note.includes(term));
  });
}
