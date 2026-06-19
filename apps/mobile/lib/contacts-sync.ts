// apps/mobile/lib/contacts-sync.ts
//
// Keep the app's contacts "one with" the device phone book (Matee). When a person
// is added (or their number changed) in kaata, also write them to the phone's
// contacts — so the shopkeeper's ledger people and their real phone book stay in
// sync. The READ direction (picking a phone contact when adding) already works via
// ContactsPickerSheet; this is the WRITE-back direction.
//
// HARD RULES:
//   - BEST-EFFORT: never throw, never block the ledger write. A phone-book failure
//     (permission denied, OEM quirk) must not stop adding a customer.
//   - DEDUP: if a phone contact with this number already exists (e.g. the user
//     PICKED it from the book), do NOT create a duplicate.
//   - Fire-and-forget from the caller (don't await the result on the hot path).
//
// NEEDS-DEVICE-TEST: the actual phone-book write + WRITE_CONTACTS permission can
// only be confirmed on a real device.

import * as Contacts from "expo-contacts";

/** Normalize to comparable digits (drop +, spaces, dashes). */
function digitsOf(s: string): string {
  return (s ?? "").replace(/[^\d]/g, "");
}

/** True if a phone contact already has this number (last-8-digit match tolerates
 *  +93 / leading-0 differences). On any read failure returns false — we'd rather
 *  risk a rare duplicate than skip a wanted write. */
async function phoneExistsInBook(phoneE164: string): Promise<boolean> {
  try {
    const want = digitsOf(phoneE164).slice(-8);
    if (!want) return false;
    const { data } = await Contacts.getContactsAsync({
      fields: [Contacts.Fields.PhoneNumbers],
    });
    for (const c of data) {
      for (const pn of c.phoneNumbers ?? []) {
        const have = digitsOf(pn.number ?? "").slice(-8);
        if (have && have === want) return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}

/** Best-effort write of a kaata person into the device phone book. Safe to call
 *  fire-and-forget; never throws. No-op without a phone number or contacts write
 *  permission. */
export async function writePersonToPhoneBook(
  name: string,
  phoneE164: string | null,
): Promise<void> {
  try {
    const display = (name ?? "").trim();
    if (!phoneE164 || !display) return;

    const current = await Contacts.getPermissionsAsync();
    let granted = current.granted;
    if (!granted && current.canAskAgain) {
      granted = (await Contacts.requestPermissionsAsync()).granted;
    }
    if (!granted) return;

    if (await phoneExistsInBook(phoneE164)) return;

    await Contacts.addContactAsync({
      [Contacts.Fields.FirstName]: display,
      [Contacts.Fields.PhoneNumbers]: [{ label: "mobile", number: phoneE164, isPrimary: true }],
    } as Contacts.Contact);
  } catch (err) {
    if (__DEV__) console.warn("[contacts-sync] phone-book write skipped:", err);
  }
}
