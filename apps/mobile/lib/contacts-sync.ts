// apps/mobile/lib/contacts-sync.ts
//
// Keep the app's contacts "one with" the device phone book (Matee). When a person
// is added (or their number changed) in kaata, also write them to the phone's
// contacts — so the shopkeeper's ledger people and their real phone book stay in
// sync. The READ direction (browsing/searching the phone book inline on the add
// screen) and the WRITE-back direction (saving a kaata person to the phone) both
// live here.
//
// HARD RULES:
//   - BEST-EFFORT: never throw, never block the ledger write. A phone-book failure
//     (permission denied, OEM quirk) must not stop adding a customer.
//   - DEDUP: if a phone contact with this number already exists (e.g. the user
//     tapped it from the inline list), do NOT create a duplicate.
//   - Fire-and-forget from the caller (don't await the result on the hot path).
//   - THE USER'S PHONE BOOK IS THEIRS. kaata may create a contact, and may keep
//     one it created in step with a later edit — but it must never overwrite a
//     name the user has since set themselves in Contacts, and must never drop
//     numbers it doesn't know about. See upsertPersonInPhoneBook.
//
// FIRST/LAST NAME: the phone Contacts app stores names as First + Last fields.
// kaata stores a single display_name, so we split on write (first word → First,
// the rest → Last) and read both fields back when browsing the book, so a contact
// round-trips with its structure intact. See splitName().
//
// NEEDS-DEVICE-TEST: the actual phone-book write + WRITE_CONTACTS permission can
// only be confirmed on a real device.

// "/legacy", NOT the bare "expo-contacts" root.
//
// Expo SDK 56 promoted a new class-based API to the root import and moved this
// function-style API to the subpath. The root still EXPORTS the old names with
// their old TypeScript signatures — but every body is now `throw
// errorOnLegacyMethodUse(...)`. So `getContactsAsync` and `addContactAsync`
// type-check exactly as before and throw at runtime, and both of this file's
// callers wrap their calls in try/catch, which means the import alone would
// have turned add-from-phone-book and write-back-to-phone-book into silently
// dead features with no build error anywhere.
//
// Migrating to the new class-based API is worthwhile but is its own change;
// this subpath is supported and preserves behaviour exactly.
import * as Contacts from "expo-contacts/legacy";

/** Normalize to comparable digits (drop +, spaces, dashes). */
function digitsOf(s: string): string {
  return (s ?? "").replace(/[^\d]/g, "");
}

/** Last-8-digit key for deduping a phone across +93 / leading-0 format variance.
 *  Empty string when there's no number (callers treat empty as "no match"). */
export function phoneKey(phone: string | null | undefined): string {
  return digitsOf(phone ?? "").slice(-8);
}

/** Split a single display name into (first, rest) the way the phone Contacts app
 *  expects. "Ahmad Khan Durrani" → first "Ahmad", last "Khan Durrani". A single
 *  word has no last name. Used both for the phone-book write and to seed the edit
 *  screen's two inputs from an existing display_name. */
export function splitName(full: string | null | undefined): {
  firstName: string;
  lastName: string | null;
} {
  const parts = (full ?? "").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { firstName: "", lastName: null };
  if (parts.length === 1) return { firstName: parts[0], lastName: null };
  return { firstName: parts[0], lastName: parts.slice(1).join(" ") };
}

/** Join first + last back into the single display_name kaata stores. */
export function joinName(firstName: string, lastName: string | null): string {
  return `${(firstName ?? "").trim()} ${(lastName ?? "").trim()}`.trim();
}

/** A single name token, with literal "null"/"undefined" garbage treated as
 *  empty. Some Android contact providers report a nameless contact's fields as
 *  the strings "null"/"null null" (the native layer stringifies null). */
function cleanToken(s: string | null | undefined): string {
  const t = (s ?? "").trim();
  const low = t.toLowerCase();
  return !t || low === "null" || low === "undefined" ? "" : t;
}

/** Clean a whole name string by dropping any "null"/"undefined" tokens. So
 *  "null null" → "", "null Safi" → "Safi", "Omar Safi" → "Omar Safi". */
function cleanName(s: string | null | undefined): string {
  return (s ?? "")
    .split(/\s+/)
    .map((p) => cleanToken(p))
    .filter(Boolean)
    .join(" ")
    .trim();
}

// A device phone-book entry, normalized for the inline add-screen list. `name` is
// the combined display string (what we show); firstName/lastName are kept apart
// for the phone-book round-trip + structured creation. `id` is the stable
// per-contact identifier used as the list key (so filtering/reordering doesn't
// shuffle React keys).
export type DeviceContact = {
  id: string;
  firstName: string;
  lastName: string | null;
  name: string;
  phone: string | null;
};

// Result of reading the phone book — carries the permission state so the add
// screen can show an "allow access" affordance instead of a silently empty list.
export type DeviceContactsResult = {
  contacts: DeviceContact[];
  granted: boolean;
  canAskAgain: boolean;
};

/** Read the device phone book (name split into first/last + first number) for the
 *  WhatsApp-style inline contacts list on the add screen. Best-effort: returns an
 *  empty list (with the permission state) on no permission or any read error — the
 *  add screen still works (you can type a new name). Requests permission once if
 *  it can. */
export async function readDeviceContacts(): Promise<DeviceContactsResult> {
  try {
    let perm = await Contacts.getPermissionsAsync();
    if (!perm.granted && perm.canAskAgain) {
      perm = await Contacts.requestPermissionsAsync();
    }
    if (!perm.granted) {
      return { contacts: [], granted: false, canAskAgain: perm.canAskAgain };
    }
    const { data } = await Contacts.getContactsAsync({
      fields: [
        Contacts.Fields.Name,
        Contacts.Fields.FirstName,
        Contacts.Fields.LastName,
        Contacts.Fields.PhoneNumbers,
      ],
      sort: Contacts.SortTypes.FirstName,
    });
    const out: DeviceContact[] = [];
    const seen = new Set<string>();
    for (const c of data) {
      let firstName = cleanToken(c.firstName);
      let lastName = cleanToken(c.lastName) || null;
      // Skip nameless contacts (and the "null null" garbage some Android
      // providers emit for a contact with no name) — cleanName drops "null"
      // tokens, so an all-null contact resolves to "" and is skipped.
      const display = cleanName(c.name) || joinName(firstName, lastName);
      if (!display) continue;
      // Some Android contacts expose only the combined `name` (no structured
      // first/last). Derive the split so the phone-book round-trip still works.
      if (!firstName) {
        const s = splitName(display);
        firstName = s.firstName;
        lastName = lastName ?? s.lastName;
      }
      const phone = c.phoneNumbers?.[0]?.number?.trim() || null;
      // Dedup the book against itself by phone (the same person is often listed
      // twice). Phone-less contacts can't be deduped, so they all pass through.
      const k = phoneKey(phone);
      if (k) {
        if (seen.has(k)) continue;
        seen.add(k);
      }
      // Prefer the OS contact id (stable across list filtering); fall back to a
      // content key for the rare contact without one.
      const id = c.id ?? `${display}-${phone ?? ""}`;
      out.push({ id, firstName, lastName, name: display, phone });
    }
    return { contacts: out, granted: true, canAskAgain: perm.canAskAgain };
  } catch (err) {
    if (__DEV__) console.warn("[contacts-sync] readDeviceContacts failed:", err);
    return { contacts: [], granted: false, canAskAgain: true };
  }
}

/** The phone-book contact holding this number, or null. Last-8-digit match, so
 *  it tolerates +93 / leading-0 / spacing differences between how the number was
 *  saved in Contacts and how kaata normalizes it.
 *
 *  Returns the whole contact (not just a boolean) because the caller needs the
 *  id to UPDATE it, and the existing name to decide whether updating is safe —
 *  see upsertPersonInPhoneBook. On any read failure returns null: the caller
 *  then falls back to adding, which risks a rare duplicate rather than losing
 *  the write entirely. */
async function findContactByPhone(
  phoneE164: string,
): Promise<{ id: string; firstName: string; lastName: string; name: string } | null> {
  try {
    const want = digitsOf(phoneE164).slice(-8);
    if (!want) return null;
    const { data } = await Contacts.getContactsAsync({
      fields: [
        Contacts.Fields.PhoneNumbers,
        Contacts.Fields.Name,
        Contacts.Fields.FirstName,
        Contacts.Fields.LastName,
      ],
    });
    for (const c of data) {
      for (const pn of c.phoneNumbers ?? []) {
        const have = digitsOf(pn.number ?? "").slice(-8);
        if (have && have === want && c.id) {
          const firstName = (c.firstName ?? "").trim();
          const lastName = (c.lastName ?? "").trim();
          return {
            id: c.id,
            firstName,
            lastName,
            name: (c.name ?? joinName(firstName, lastName)).trim(),
          };
        }
      }
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Best-effort UPSERT of a kaata person into the device phone book, with the
 * name split across the Contacts app's First/Last fields. Safe to call
 * fire-and-forget; never throws. No-op without a phone number, without a name,
 * or without contacts permission.
 *
 * This used to be add-only: it bailed out via `phoneExistsInBook()` whenever the
 * number was already saved, so renaming a customer in kaata never reached the
 * phone book. Editing "Ahmad" to "Ahmad Khan" left the phone contact reading
 * "Ahmad" forever, and the two drifted apart from the first edit onward.
 *
 * `previousPhoneE164` matters when the NUMBER is what changed: we look the card
 * up by the OLD number, because the new one isn't in the book yet. Without it,
 * a number change created a SECOND contact and abandoned the first — a
 * duplicate carrying a stale name and a stale number.
 *
 * WHEN KAATA MAY OVERWRITE A NAME
 * -------------------------------
 * Only when the phone book still holds the name kaata last wrote (or a name
 * that matches what kaata knew this person as). If the user has since renamed
 * that contact in their own Contacts app — to "Ahmad Baba Shop", say — that is
 * a deliberate choice about THEIR data, and a ledger app has no business
 * stomping it. Pass `expectedExistingName` (the pre-edit kaata name) to enforce
 * that; when it doesn't match, the number is still repaired but the name is
 * left alone.
 *
 * Phone numbers are edited in place rather than replaced wholesale: a customer
 * may have home/work numbers kaata knows nothing about, and handing
 * updateContactAsync a fresh single-entry array would delete them.
 */
export async function upsertPersonInPhoneBook(
  firstName: string,
  lastName: string | null,
  phoneE164: string | null,
  opts?: { previousPhoneE164?: string | null; expectedExistingName?: string | null },
): Promise<void> {
  try {
    const first = (firstName ?? "").trim();
    const last = (lastName ?? "").trim();
    if (!phoneE164 || (!first && !last)) return;

    const current = await Contacts.getPermissionsAsync();
    let granted = current.granted;
    if (!granted && current.canAskAgain) {
      granted = (await Contacts.requestPermissionsAsync()).granted;
    }
    if (!granted) return;

    // Look up by the OLD number when the number itself is what changed — the
    // new one is not in the book yet. Falls back to the new number, which is
    // the create path and the no-change path.
    const lookupPhone = opts?.previousPhoneE164?.trim() || phoneE164;
    const existing = await findContactByPhone(lookupPhone);

    if (existing) {
      const nextName = joinName(first, last);
      // Has the user renamed this contact themselves since kaata last touched
      // it? Compare against what kaata believed the name was. Missing
      // expectation (the create path) means "don't rename", so an accidental
      // re-add can never rewrite an existing card's name.
      const expected = opts?.expectedExistingName?.trim() ?? null;
      const bookName = existing.name.trim();
      const mayRename =
        expected != null && (bookName === expected || bookName === "" || bookName === nextName);

      const patch: Parameters<typeof Contacts.updateContactAsync>[0] = { id: existing.id };
      let dirty = false;

      if (mayRename && bookName !== nextName) {
        patch.name = nextName;
        patch.firstName = first || last;
        // Explicitly clear the surname when the name collapsed to one word,
        // otherwise "Ahmad Khan" -> "Ahmad" leaves a stale "Khan" behind.
        patch.lastName = first && last ? last : "";
        dirty = true;
      }

      // Repair the number in place, preserving every OTHER number on the card
      // (home, work, a second mobile). Replacing the array wholesale would
      // delete contact data kaata never knew about.
      const wantDigits = digitsOf(phoneE164).slice(-8);
      const lookupDigits = digitsOf(lookupPhone).slice(-8);
      if (wantDigits && wantDigits !== lookupDigits) {
        const full = await Contacts.getContactByIdAsync(existing.id, [
          Contacts.Fields.PhoneNumbers,
        ]);
        const numbers = full?.phoneNumbers ?? [];
        if (numbers.length > 0) {
          patch.phoneNumbers = numbers.map((pn) =>
            digitsOf(pn.number ?? "").slice(-8) === lookupDigits
              ? { ...pn, number: phoneE164 }
              : pn,
          );
          dirty = true;
        }
      }

      if (dirty) await Contacts.updateContactAsync(patch);
      return;
    }

    await Contacts.addContactAsync({
      // contactType is REQUIRED on iOS and was the reason every write silently
      // failed there. The native module does:
      //     contact.contactType = data.contactType == "person"
      //       ? .person : .organization
      // and the field is a non-optional String that defaults to "" when the key
      // is absent — so an omitted contactType saved every customer as a COMPANY
      // card with a blank company name, which iOS Contacts does not show under
      // the person's name. Android hardcodes "person", which is why the same
      // code appeared to work there.
      contactType: Contacts.ContactTypes.Person,
      // Required by the Contact type; iOS derives the display name from
      // first/last, Android builds its own. Set so the cast below can go —
      // the old `as Contacts.Contact` is exactly what hid the missing
      // contactType from the compiler.
      name: joinName(first, last),
      // Contacts apps require a first name; fall back to the last name if a
      // single-field name somehow lands here as last-only.
      firstName: first || last,
      ...(first && last ? { lastName: last } : {}),
      phoneNumbers: [{ label: "mobile", number: phoneE164, isPrimary: true }],
    });
  } catch (err) {
    // Was __DEV__-only, which is how an iOS-wide failure survived to
    // production unnoticed: no toast, no log, no way to tell "already there"
    // from "broken". Keep it non-fatal (the ledger write already succeeded)
    // but always audible.
    console.warn("[contacts-sync] phone-book write failed:", err);
  }
}
