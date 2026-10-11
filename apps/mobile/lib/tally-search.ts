import { toAsciiDigits } from "./digits";
import type { Calendar } from "./calendar";
import {
  AFGHAN_MONTHS, AFGHAN_MONTHS_LATIN, GREGORIAN_MONTHS_EN, GREGORIAN_MONTHS_FA,
  QAMARI_MONTHS_EN, QAMARI_MONTHS_FA, formatCalendarDate, toJalali, toQamari,
} from "./jalali";
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
type DateFields = { year: number; month: number; day: number; names: string; monthKeys: string[] };
type SearchTerm =
  | { words: string[]; amount: number | null }
  | { words: string[]; date: { year: number; day: number; monthKey: string } };

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

const GREGORIAN_FULL_MONTHS_EN = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

const monthKey = (name: string) => normalizeNote(name).replace(/[\s'’]/g, "");
const KNOWN_MONTH_KEYS = new Set([
  ...AFGHAN_MONTHS, ...AFGHAN_MONTHS_LATIN,
  ...GREGORIAN_MONTHS_EN, ...GREGORIAN_MONTHS_FA, ...GREGORIAN_FULL_MONTHS_EN,
  ...QAMARI_MONTHS_EN, ...QAMARI_MONTHS_FA,
].map(monthKey));

function prepareTerms(terms: readonly string[]): SearchTerm[] {
  const prepared: SearchTerm[] = [];
  for (let i = 0; i < terms.length; i++) {
    let namedDate: SearchTerm | null = null;
    // Bind a recognizable day + month name + year into one date condition.
    // Otherwise an amount of 20 on 21 Safar could match "20 Safar 1448".
    if (/^\d{1,2}$/.test(terms[i]) && Number(terms[i]) >= 1 && Number(terms[i]) <= 31) {
      for (let last = i + 2; last < Math.min(terms.length, i + 5); last++) {
        const month = monthKey(terms.slice(i + 1, last).join(" "));
        if (/^\d+$/.test(terms[last]) && KNOWN_MONTH_KEYS.has(month)) {
          namedDate = {
            words: terms.slice(i, last + 1),
            date: { day: Number(terms[i]), year: Number(terms[last]), monthKey: month },
          };
          i = last;
          break;
        }
      }
    }
    prepared.push(namedDate ?? { words: [terms[i]], amount: searchAmountMinor(terms[i]) });
  }
  return prepared;
}

function dateFields(ms: number, options: TallySearchOptions): DateFields | null {
  const dt = new Date(ms);
  if (!Number.isFinite(dt.getTime())) return null;
  // Entries carry a local business date, exactly as EntryRow/formatDate use
  // it. UTC or Kabul conversion here would search a different day abroad.
  let year = dt.getFullYear(), month = dt.getMonth() + 1, day = dt.getDate();
  let resolvedCalendar = options.calendar;
  try {
    if (options.calendar === "jalali") {
      const j = toJalali(ms);
      year = j.jy; month = j.jm; day = j.jd;
    } else if (options.calendar === "qamari") {
      const q = toQamari(ms);
      year = q.hy; month = q.hm; day = q.hd;
    }
  } catch {
    // Same Gregorian fallback as the visible formatter outside its range.
    resolvedCalendar = "gregorian";
  }
  const rendered = [
    formatCalendarDate(ms, options.locale, options.calendar),
    formatCalendarDate(ms, options.locale === "fa" ? "en" : "fa", options.calendar),
  ];
  const fullMonth = resolvedCalendar === "gregorian" ? GREGORIAN_FULL_MONTHS_EN[month - 1] : "";
  const names = normalizeNote([...rendered, fullMonth].join(" "));
  const monthKeys = rendered.map((value) => monthKey(normalizeNote(value).split(/\s+/).slice(1, -1).join(" ")));
  if (fullMonth) monthKeys.push(monthKey(fullMonth));
  return { year, month, day, names, monthKeys };
}

function matchesDate(term: string, fields: DateFields): boolean {
  if (/^\d+(?:[./-]\d+){0,2}$/.test(term)) {
    const parts = term.split(/[./-]/).map(Number);
    const { year: y, month: m, day: d } = fields;
    // Numeric tokens match complete components (20 is not a partial 2026).
    if (parts.length === 1) return parts[0] === y || parts[0] === m || parts[0] === d;
    if (parts.length === 2) {
      return (parts[0] === d && parts[1] === m)
        || (parts[0] === m && parts[1] === y)
        || (parts[0] === y && parts[1] === m);
    }
    return (parts[0] === d && parts[1] === m && parts[2] === y)
      || (parts[0] === y && parts[1] === m && parts[2] === d);
  }
  // Qamari transliterations can contain apostrophes (Sha'ban). Both the
  // printed form and an apostrophe-free keyboard spelling are searchable.
  return fields.names.includes(term)
    || fields.names.replace(/['’]/g, "").includes(term.replace(/['’]/g, ""));
}

/** Single-box search: each term must match the note, exact amount or the
 * selected-calendar date. Terms may span fields, e.g. "rice 500 Aug".
 * English/Dari month aliases work in either UI language; numeric dates are
 * day-first or year-first in the SELECTED calendar, never a hidden calendar.
 * Input/output keep ledger ordering, object identities and stored data intact.
 */
export function filterTallies<T extends SearchableTally>(
  entries: readonly T[],
  terms: readonly string[],
  options: TallySearchOptions,
): T[] {
  if (terms.length === 0) return [...entries];
  const prepared = prepareTerms(terms);
  return entries.filter((entry) => {
    const note = normalizeNote(entry.note ?? "");
    let amount: number | null = null;
    try { amount = Math.abs(toMinorUnits(entry.amount_afn)); } catch { /* Invalid failed tally. */ }
    let date: DateFields | null | undefined;
    return prepared.every((query) => {
      if (query.words.every((word) => note.includes(word))) return true;
      if ("amount" in query && query.amount !== null && query.amount === amount) return true;
      // Compute the date at most once per entry and only when a term needs it.
      if (date === undefined) date = dateFields(entry.created_at, options);
      if (date === null) return false;
      if ("date" in query) {
        return query.date.day === date.day && query.date.year === date.year
          && date.monthKeys.includes(query.date.monthKey);
      }
      return matchesDate(query.words[0], date);
    });
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
