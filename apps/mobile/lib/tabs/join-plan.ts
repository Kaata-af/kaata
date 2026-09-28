// apps/mobile/lib/tabs/join-plan.ts
//
// The decisions the shared-account JOIN screen (app/t/[token].tsx) makes
// before it asks the user anything, as pure functions over plain facts so
// selftest:tab-join can pin them without a database or a device:
//
//   planCurrency       — D9: a tab lives only in a kaata of its currency, and
//                        "you need a USD kaata" used to be a dead end (Matee:
//                        "even if I change my vault to usd I still get
//                        prompted"). Given every kaata's facts, sort them into
//                        already-matching / switchable / locked and say whether
//                        the one-tap default is a switch or a new kaata.
//   suggestJoinContact — the invitation comes from a phone number (the other
//                        party's account phone, WireParty.phone), so "who is
//                        this in your kaata?" usually has an answer before the
//                        list renders: an existing contact with that number,
//                        else a phone-book entry, else the invitation's own
//                        label + number.
//
// No react-native / expo imports: lib/contacts-sync's name/phone helpers,
// lib/digits and lib/phone's dial-code lookup only. The contact-list merge
// (kaata people + phone book) is lib/contacts-merge.ts, shared with person/new.

import { joinName, phoneKey, splitName } from "../contacts-sync";
import { toAsciiDigits } from "../digits";
import { inferCountryFromE164 } from "../phone";

// ---------------------------------------------------------------------------
// Currency (D9)

export type VaultFacts = {
  id: string;
  name: string;
  currency: string;
  /** entries rows with deleted_at IS NULL, across every contact. */
  liveEntries: number;
  /** Any tab_links row, open OR closed — a closed tab froze amounts in this currency too. */
  hasAnyTab: boolean;
  /** An open tab pins the currency (changeVaultCurrency → VaultHasOpenTabError). */
  hasOpenTab: boolean;
  /** The `vault.rename` gate — what vault/settings uses for its currency row. */
  canChangeCurrency: boolean;
};

export type CurrencyPlan = {
  /** currency === the tab's: joinable as-is. */
  matching: VaultFacts[];
  /** Could be switched to the tab's currency. `relabels` = the book is not
   *  empty (live tallies or any tab), so a switch relabels existing amounts
   *  without converting them and the screen must say so. */
  switchable: Array<{ vault: VaultFacts; relabels: boolean }>;
  /** Cannot be switched: an open tab pins it, or the role may not change settings. */
  locked: Array<{ vault: VaultFacts; reason: "open_tab" | "role" }>;
  /** The one-tap default. 'switch' only when nothing matches, exactly ONE
   *  kaata is switchable, it is empty (nothing to relabel) and nothing is
   *  locked; every other shape defaults to creating a kaata in the tab's
   *  currency, with the switch offered as a secondary row. */
  primary: "switch" | "create";
};

export function planCurrency(vaults: VaultFacts[], tabCurrency: string): CurrencyPlan {
  const matching: VaultFacts[] = [];
  const switchable: CurrencyPlan["switchable"] = [];
  const locked: CurrencyPlan["locked"] = [];
  for (const vault of vaults) {
    if (vault.currency === tabCurrency) {
      matching.push(vault);
    } else if (vault.hasOpenTab) {
      // Checked before the role: even a manager cannot switch under an open
      // tab, and "locked by a shared account" is the reason worth reading.
      locked.push({ vault, reason: "open_tab" });
    } else if (!vault.canChangeCurrency) {
      locked.push({ vault, reason: "role" });
    } else {
      switchable.push({ vault, relabels: vault.liveEntries > 0 || vault.hasAnyTab });
    }
  }
  const primary =
    matching.length === 0 &&
    switchable.length === 1 &&
    !switchable[0].relabels &&
    locked.length === 0
      ? "switch"
      : "create";
  return { matching, switchable, locked, primary };
}

// ---------------------------------------------------------------------------
// Contact suggestion

export type JoinSuggestion =
  /** A contact already in the chosen kaata with the invitation's number. */
  | { source: "kaata"; personId: string; name: string; phone: string | null }
  /** A phone-book entry with that number; joining creates the person from it. */
  | {
      source: "phone";
      firstName: string;
      lastName: string | null;
      name: string;
      phone: string | null;
      countryCode: string | null;
    }
  /** Nothing on the device knows the number: the other party's own label and
   *  number from the invitation. `phone` is null when the invitation carried
   *  none; `firstName` is "" when it carried no label (the screen must ask). */
  | {
      source: "invitation";
      firstName: string;
      lastName: string | null;
      name: string;
      phone: string | null;
      countryCode: string | null;
    };

/** The picker country for a number that carries its own dial code; null lets
 *  the screen keep its default for a national-format number — the same rule
 *  person/new applies to a tapped phone-book contact. */
function countryFor(phone: string | null): string | null {
  const p = (phone ?? "").trim();
  return p.startsWith("+") ? inferCountryFromE164(toAsciiDigits(p)) : null;
}

/** ASCII digits only — the same extraction phoneKey (lib/contacts-sync) uses,
 *  so a Persian-digit phone-book number matches nowhere rather than here alone. */
function asciiDigitsOf(phone: string): string {
  return phone.replace(/\D/g, "");
}

/**
 * Two numbers are one person when both carry a dial code and EVERY digit
 * agrees — E.164 is exact, and "+61412345678" (Australia) and "+93712345678"
 * (Afghanistan) share their last 8 digits while being two people, which
 * matters here because a match on the preview stage is one tap from binding
 * the tab to that contact (D8: not undone without closing it). Only when one
 * side is national format ("0700123456" in the phone book against the
 * invitation's "+93700123456") does the last-8-digit phoneKey decide, as it
 * does for person/new's dedup.
 */
function sameNumber(candidate: string | null | undefined, other: string): boolean {
  const c = (candidate ?? "").trim();
  if (c.startsWith("+") && other.startsWith("+")) {
    const dc = asciiDigitsOf(c);
    return dc.length > 0 && dc === asciiDigitsOf(other);
  }
  const key = phoneKey(other);
  return key !== "" && phoneKey(c) === key;
}

/**
 * Who the invitation is from, as far as this device can tell. Matching is by
 * sameNumber: exact for two E.164 numbers, else by phoneKey (last 8 digits),
 * so "0700123456", "+93700123456" and "0093 700 123 456" are one number. A
 * kaata contact wins over the phone book; a kaata contact with that number
 * that already holds a tab (`linked`, open or closed — party b mints no
 * opening entry, so a second tab would zero its history) BLOCKS the
 * suggestion: the screen shows the list with the inert row instead. A
 * phone-book match keeps the book's NAME but, when the book holds the number
 * in national format, takes the invitation's E.164 number and its country —
 * the match already proved they are one number, and the book's "0412 000
 * 004" for a cousin abroad would otherwise be normalized against the install
 * default country and refused as invalid on the very number the card showed.
 * Without a usable number the label alone becomes an invitation-sourced
 * suggestion; without either there is nothing to suggest.
 */
export function suggestJoinContact(args: {
  otherPhone: string | null | undefined;
  otherLabel: string;
  candidates: Array<{ id: string; name: string; phone: string | null; linked: number }>;
  deviceContacts: Array<{
    id: string;
    firstName: string;
    lastName: string | null;
    name: string;
    phone: string | null;
  }>;
}): JoinSuggestion | null {
  const label = args.otherLabel.trim();
  const phone = (args.otherPhone ?? "").trim();
  const key = phoneKey(phone);
  if (!key) {
    if (!label) return null;
    const { firstName, lastName } = splitName(label);
    return {
      source: "invitation",
      firstName,
      lastName,
      name: joinName(firstName, lastName),
      phone: null,
      countryCode: null,
    };
  }
  const inKaata = args.candidates.filter((c) => sameNumber(c.phone, phone));
  if (inKaata.some((c) => c.linked !== 0)) return null;
  const person = inKaata[0];
  if (person) {
    return { source: "kaata", personId: person.id, name: person.name, phone: person.phone };
  }
  const book = args.deviceContacts.find((c) => sameNumber(c.phone, phone));
  if (book) {
    const bookPhone = (book.phone ?? "").trim();
    const usePhone = bookPhone.startsWith("+") || !phone.startsWith("+") ? book.phone : phone;
    return {
      source: "phone",
      firstName: book.firstName,
      lastName: book.lastName,
      name: book.name,
      phone: usePhone,
      countryCode: countryFor(usePhone),
    };
  }
  const { firstName, lastName } = splitName(label);
  return {
    source: "invitation",
    firstName,
    lastName,
    name: joinName(firstName, lastName),
    phone,
    countryCode: countryFor(phone),
  };
}
