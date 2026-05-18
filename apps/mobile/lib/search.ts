// Tiny fuzzy match scorer. Tuned for short contact-name strings (1–4 words).
// Higher score = better match. 0 = no match (filter out).

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
