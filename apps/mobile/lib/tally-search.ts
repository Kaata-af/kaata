import type { LocaleCode } from "./i18n";
import { toAsciiDigits } from "./digits";
import type { Calendar } from "./calendar";
import { toMinorUnits } from "./money";

// Search normalization only. Never change the stored note: ZWNJs and script
// choices are part of what the author wrote, even when matching ignores them.
function normalizeNote(text: string): string {
  return (
    toAsciiDigits(text)
      .normalize("NFKD")
      .replace(/[\u0300-\u036f\u064b-\u065f\u0670]/g, "")
      .replace(/ي|ى/g, "ی")
      .replace(/ك/g, "ک")
      // Heh forms: ۀ (NFKD leaves ە), ة and ھ all read as ه (audit #3).
      .replace(/[ۀەةھ]/g, "ه")
      .replace(/[\u200c\u200d\u0640\u200e\u200f\u2066-\u2069]/g, "")
      .toLowerCase()
      .trim()
  );
}

// "500" must not find "1500 bags": a number in a note matches whole (#16).
function noteHas(note: string, compactNote: string, term: string): boolean {
  if (/^\d+(?:[.,]\d+)?$/.test(term)) {
    const escaped = term.replace(/[.,]/g, (mark) => `\\${mark}`);
    return new RegExp(`(^|[^\\d.,])${escaped}($|[^\\d.,])`).test(note);
  }
  // A half-space typed as nothing ("میروم") still finds "می روم": compare the
  // note without spaces as well (the ZWNJ itself is already ignored).
  return note.includes(term) || compactNote.includes(term);
}

// A query term that is only the currency ("AFN", "؋") narrows nothing.
const CURRENCY_TERM = /^(?:afn|؋|افغانی|افغانۍ)$/;

export type TallySearchOptions = { locale: LocaleCode; calendar: Calendar };

type SearchableTally = { note: string | null; amount_afn: number; created_at: number };
// Exact value matching makes 500 distinct from 5000. Accept the displayed
// comma grouping, Persian grouping/decimal marks and harmless decimal zeros.
// Never strip arbitrary punctuation: malformed grouping must not become money.
function searchAmountMinor(term: string): number | null {
  // A trailing currency ("500؋", "500afn") is the amount (audit #16).
  let amount = term.replace(/٫/g, ".").replace(/(?:؋|afn)$/, "");
  if (/^\d{1,3}(?:[,٬،]\d{3})+(?:\.\d{1,2})?$/.test(amount)) {
    amount = amount.replace(/[,٬،]/g, "");
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
  const meaningful = terms.filter((term) => !CURRENCY_TERM.test(term));
  if (meaningful.length === 0) return [...entries];
  const queries = meaningful.map((term) => ({ term, amount: searchAmountMinor(term) }));
  return entries.filter((entry) => {
    const note = normalizeNote(entry.note ?? "");
    const compactNote = note.replace(/\s+/g, "");
    let amount: number | null = null;
    try {
      amount = Math.abs(toMinorUnits(entry.amount_afn));
    } catch {
      /* Invalid failed tally. */
    }
    return queries.every(
      (query) =>
        noteHas(note, compactNote, query.term) ||
        (query.amount !== null && query.amount === amount),
    );
  });
}

export function noteSearchTerms(query: string): string[] {
  return (
    normalizeNote(query)
      // "1 500" is one amount: join space-grouped thousands (audit #16).
      .replace(
        /(^|\s)(\d{1,3})((?: \d{3})+)(?=\s|$)/g,
        (_, lead, head, groups) => `${lead}${head}${groups.replace(/ /g, "")}`,
      )
      .split(/\s+/)
      .filter(Boolean)
  );
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
