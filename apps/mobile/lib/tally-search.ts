import { toAsciiDigits } from "./digits";

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
