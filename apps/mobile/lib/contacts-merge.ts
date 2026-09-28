// apps/mobile/lib/contacts-merge.ts
//
// The ONE merge of "people already in a kaata" with "the device phone book"
// that both contact pickers render: the home Add/find screen
// (app/person/new.tsx) and the shared-account join screen (app/t/[token].tsx).
// It began life as a pair of useMemos inside person/new; the join screen then
// grew its own list from the kaata's contacts alone, and the two drifted
// (Matee: "my contacts aren't listed ... make it more like the contacts list
// on the homepage"). Pure — no React, no react-native, no expo — so
// selftest:tab-join pins it against a verbatim copy of the old memo pair.
//
// Rules, in the order they apply:
//   1. Dedup the phone book against the kaata by phoneKey (last 8 digits, so
//      +93 / leading-0 / spacing variants collapse): a device contact whose
//      number is already a kaata person is never offered as "add".
//      Phone-less device contacts cannot be deduped and pass through.
//   2. A query (first / last / phone digits) filters BOTH halves through
//      searchContacts; an empty query leaves each list as given (the caller
//      orders people by recency).
//   3. The device half is capped at DEVICE_LIST_CAP rows because each section
//      renders as one bordered card, not a virtualized list; the caller shows
//      t('personAdd.moreContacts') when `deviceTruncated`.
//   4. Section titles switch with the query: Recent / All contacts at rest,
//      Matches / From your phone while searching. Keys only — no i18n here.

import { phoneKey } from "./contacts-sync";
import { toAsciiDigits } from "./digits";
import { PHONE_SEARCH_MIN_DIGITS, searchContacts } from "./search";

// Max device contacts rendered in the "All contacts" card at once. The list is
// a plain card (not virtualized), so a huge phone book would jank; typing
// filters well under this. A truncation hint shows when the book is larger.
export const DEVICE_LIST_CAP = 80;

/** One row in the merged list. App people open on tap; device contacts are
 *  created (and added to the ledger) on tap. */
export type MergedRow<P, D> = { kind: "app"; person: P } | { kind: "device"; contact: D };

export type MergedSection<P, D> = {
  key: "app" | "device";
  titleKey:
    | "personAdd.section.matches"
    | "personAdd.section.recent"
    | "personAdd.section.fromPhone"
    | "personAdd.section.allContacts";
  data: Array<MergedRow<P, D>>;
};

/**
 * Merge a kaata's people with the device phone book into the sections the
 * pickers render. `first` / `last` are the two name inputs (matched by field,
 * see searchContacts) and `phoneDigits` the number input; person/new trims the
 * names and floors the phone query at PHONE_SEARCH_MIN_DIGITS before its memos
 * ran, and the same normalisation is applied here — idempotent for that
 * caller, and it keeps a caller that hands over raw input on the same rules.
 */
export function mergeContactSections<
  P extends { name: string; phone: string | null },
  D extends { name: string; phone: string | null },
>(args: {
  people: P[];
  deviceContacts: D[];
  first: string;
  last: string;
  phoneDigits: string;
  cap?: number;
}): { sections: MergedSection<P, D>[]; deviceTruncated: boolean } {
  const cap = args.cap ?? DEVICE_LIST_CAP;
  const first = args.first.trim();
  const last = args.last.trim();
  const digits = toAsciiDigits(args.phoneDigits).replace(/\D/g, "");
  const phoneDigits = digits.length >= PHONE_SEARCH_MIN_DIGITS ? digits : "";
  const querying = first.length > 0 || last.length > 0 || phoneDigits.length > 0;

  // Phone keys of people already in this kaata, to dedup the device book
  // against the ledger (never offer to add someone you already have).
  const appPhoneKeys = new Set<string>();
  for (const p of args.people) {
    const k = phoneKey(p.phone);
    if (k) appPhoneKeys.add(k);
  }
  const dedupedDevice = args.deviceContacts.filter((c) => {
    const k = phoneKey(c.phone);
    return !k || !appPhoneKeys.has(k);
  });

  const sections: MergedSection<P, D>[] = [];
  const appMatches = querying ? searchContacts(first, last, phoneDigits, args.people) : args.people;
  if (appMatches.length > 0) {
    sections.push({
      key: "app",
      titleKey: querying ? "personAdd.section.matches" : "personAdd.section.recent",
      data: appMatches.map((person) => ({ kind: "app", person })),
    });
  }
  const deviceFull = querying
    ? searchContacts(first, last, phoneDigits, dedupedDevice)
    : dedupedDevice;
  const deviceShown = deviceFull.slice(0, cap);
  if (deviceShown.length > 0) {
    sections.push({
      key: "device",
      titleKey: querying ? "personAdd.section.fromPhone" : "personAdd.section.allContacts",
      data: deviceShown.map((contact) => ({ kind: "device", contact })),
    });
  }
  return { sections, deviceTruncated: deviceFull.length > deviceShown.length };
}

/**
 * Route ONE search box onto the two axes mergeContactSections takes. person/new
 * has separate name and phone inputs, so each query lands on its own filter; a
 * single box (the join screen) has to decide by content, because searchContacts
 * ANDs the two filters — a number handed to both (`first: "0700", phoneDigits:
 * "0700"`) matched nobody, since no NAME contains those digits. A query that is
 * nothing but digits (Latin or Persian/Arabic-Indic), spaces and phone
 * punctuation is a phone query, floored at PHONE_SEARCH_MIN_DIGITS exactly like
 * person/new's phone field (below the floor it is no filter, not a name);
 * everything else is a first-name query, whose loose whole-name fallback in
 * scoreNameFielded still finds a last name.
 */
export function splitSearchQuery(query: string): {
  first: string;
  last: string;
  phoneDigits: string;
} {
  const q = query.trim();
  const ascii = toAsciiDigits(q);
  if (/^[\s\d+().-]+$/.test(ascii)) {
    const digits = ascii.replace(/\D/g, "");
    return {
      first: "",
      last: "",
      phoneDigits: digits.length >= PHONE_SEARCH_MIN_DIGITS ? digits : "",
    };
  }
  return { first: q, last: "", phoneDigits: "" };
}
