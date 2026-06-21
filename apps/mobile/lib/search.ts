// Tiny fuzzy match scorer. Tuned for short contact-name strings (1–4 words).
// Higher score = better match. 0 = no match (filter out).

import { toAsciiDigits } from "./digits";

// NFKD + diacritic strip + lowercase + whitespace collapse, so that "Áhmad"
// matches "ahmad" and "  Ahmad  Khan " matches "ahmad khan".
export function normalize(s: string): string {
  return s.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().trim().replace(/\s+/g, " ");
}

function isSubsequence(needle: string, haystack: string): boolean {
  let i = 0;
  for (let j = 0; j < haystack.length && i < needle.length; j++) {
    if (haystack[j] === needle[i]) i++;
  }
  return i === needle.length;
}

// Tiers, in priority order:
//   exact       — query equals name (after normalization)
//   prefix      — name starts with query
//   word-start  — any whitespace-separated word in name starts with query
//   substring   — name contains query somewhere
//   subsequence — every char of query appears in name in order (handles
//                 abbreviations like "ak" → "Ahmad Khan")
// Shorter names get a tiebreaker bonus (fewer extraneous characters).
export function scoreMatch(query: string, name: string): number {
  const q = normalize(query);
  if (!q) return 0;
  return scoreNormalized(q, name);
}

// Same scorer, but the query is already normalized. Used by searchContacts so a
// big phone book isn't re-normalizing the (identical) query thousands of times
// per keystroke — only the per-item name is normalized in the loop.
function scoreNormalized(q: string, name: string): number {
  const n = normalize(name);
  if (n === q) return 10_000;
  if (n.startsWith(q)) return 5_000 - n.length;
  if (n.split(" ").some((w) => w.startsWith(q))) return 2_000 - n.length;
  if (n.includes(q)) return 1_000 - n.length;
  if (isSubsequence(q, n)) return 200 - n.length;
  return 0;
}

// Filter + sort. Stable on equal scores via name order.
export function searchPeople<T extends { name: string }>(query: string, people: T[]): T[] {
  if (!normalize(query)) return people;
  const scored = people.map((p) => ({ p, s: scoreMatch(query, p.name) })).filter((x) => x.s > 0);
  scored.sort((a, b) => b.s - a.s || a.p.name.localeCompare(b.p.name));
  return scored.map((x) => x.p);
}

// Boost so a FIELD match (first→first, last→last) always outranks a loose
// whole-name fallback. Larger than any scoreNormalized tier (max 10_000).
const FIELD_MATCH_BONUS = 100_000;

// Field-aware name score. The add screen has separate First / Last inputs, so a
// query typed in the LAST-name field must rank people whose LAST name matches
// ("Omar Safi", "Marwa Safi") ABOVE people whose FIRST name happens to match
// ("Safi Ullah Rahimi") — the old whole-name scorer did the opposite. fq/lq are
// already normalized. The item's stored name is split on the first space into
// (first token, rest) — good enough for "First Last(+)" names. A field that
// matches its column gets FIELD_MATCH_BONUS; if neither field matches we fall
// back to a loose whole-name match (lower, no bonus) so a contact is still
// findable, just below the precise matches.
function scoreNameFielded(fq: string, lq: string, fullName: string): number {
  const n = normalize(fullName);
  const sp = n.indexOf(" ");
  const first = sp === -1 ? n : n.slice(0, sp);
  const last = sp === -1 ? "" : n.slice(sp + 1);
  if (fq && lq) {
    const fs = scoreNormalized(fq, first);
    const ls = scoreNormalized(lq, last);
    if (fs > 0 && ls > 0) return FIELD_MATCH_BONUS + fs + ls;
    return scoreNormalized(normalize(`${fq} ${lq}`), n); // loose fallback
  }
  if (lq) {
    const ls = scoreNormalized(lq, last);
    if (ls > 0) return FIELD_MATCH_BONUS + ls;
    return scoreNormalized(lq, n); // loose fallback (e.g. matches a first name)
  }
  const fs = scoreNormalized(fq, first);
  if (fs > 0) return FIELD_MATCH_BONUS + fs;
  return scoreNormalized(fq, n);
}

// Field-aware name-AND/OR-phone search for the add screen. The first-name and
// last-name inputs each drive matching against the corresponding part of a
// contact's name (see scoreNameFielded); the phone field (ASCII digits, "" =
// off) matches as a substring of the item's phone digits. Name filter and phone
// filter are ANDed. Empty everything → input list unchanged (caller orders by
// recency). Works over both app people and device contacts.
export function searchContacts<T extends { name: string; phone?: string | null }>(
  firstQuery: string,
  lastQuery: string,
  phoneQuery: string,
  items: T[],
): T[] {
  const fq = normalize(firstQuery);
  const lq = normalize(lastQuery);
  const pq = toAsciiDigits(phoneQuery ?? "").replace(/\D/g, "");
  if (!fq && !lq && !pq) return items;
  const scored: { item: T; s: number }[] = [];
  for (const it of items) {
    if (pq) {
      const d = toAsciiDigits(it.phone ?? "").replace(/\D/g, "");
      if (!d || !d.includes(pq)) continue;
    }
    let nameScore = 0;
    if (fq || lq) {
      nameScore = scoreNameFielded(fq, lq, it.name);
      if (nameScore <= 0) continue;
    }
    scored.push({ item: it, s: nameScore });
  }
  scored.sort((a, b) => b.s - a.s || a.item.name.localeCompare(b.item.name));
  return scored.map((x) => x.item);
}

// Strict equality after normalization — used to decide whether the Done key
// should open an existing person or create a new one.
export function hasExactMatch<T extends { name: string }>(
  query: string,
  people: T[],
): T | undefined {
  const q = normalize(query);
  if (!q) return undefined;
  return people.find((p) => normalize(p.name) === q);
}
