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

// Combined name-OR-phone search for the add screen, where both the name fields
// and the phone field drive the same live list (Matee: "the phone field should
// act like the name field too"). Works over both app people and device contacts.
//   - nameQuery scores via scoreMatch on the name.
//   - phoneQuery (ASCII digits only; "" = no phone filter) matches as a substring
//     of the item's phone digits — typing "70123" finds +93 70 123 ....
//   - When BOTH are present an item must satisfy BOTH (so adding a name narrows a
//     phone match and vice-versa). When neither is present the input list is
//     returned unchanged (caller decides ordering, e.g. recency).
// Ranking follows the name score; phone-only matches sort by name.
export function searchContacts<T extends { name: string; phone?: string | null }>(
  nameQuery: string,
  phoneQuery: string,
  items: T[],
): T[] {
  const nq = normalize(nameQuery);
  const pq = toAsciiDigits(phoneQuery ?? "").replace(/\D/g, "");
  if (!nq && !pq) return items;
  const scored: { item: T; s: number }[] = [];
  for (const it of items) {
    let nameScore = 0;
    if (nq) {
      nameScore = scoreNormalized(nq, it.name);
      if (nameScore <= 0) continue;
    }
    if (pq) {
      const d = toAsciiDigits(it.phone ?? "").replace(/\D/g, "");
      if (!d || !d.includes(pq)) continue;
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
