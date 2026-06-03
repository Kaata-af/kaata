import { getLocales } from "expo-localization";
import { fonts } from "./fonts";

// Tiny home-rolled i18n. Two reasons we didn't pull in i18next / react-i18next:
//   1. kaata has ~30-50 strings total — overkill ratio.
//   2. We're locked LTR (see app/_layout.tsx) and don't need framework-level
//      RTL plumbing yet. When that changes, swap to a real lib.
//
// How to add Persian/Dari strings:
//   1. Translate the values in `fa` below. Keys MUST match `en` exactly.
//   2. Missing keys fall back to English — half-translated UI doesn't break.
//   3. When rendering a string in Persian, also swap fontFamily to one of the
//      `fonts.fa*` weights (Vazirmatn) — Inter has no Arabic glyphs.
//
// Detection: device-locale-driven for now (no in-app override). When we add
// a language toggle in Settings, it'll write to app_meta.locale_override and
// this module will check that first.

// Source-of-truth English strings. All other locales must use the same keys.
const en = {
  // Onboarding
  "onboarding.subtitle": "A quiet ledger between you and the people you trust.",
  "onboarding.name.label": "Your name",
  "onboarding.name.placeholder": "Sultan",
  "onboarding.shop.label": "Store or business name",
  "onboarding.shop.placeholder": "Shop Sultan",
  "onboarding.continue": "Continue",
  "onboarding.nameRequired": "Name required",

  // Home
  "home.tab.collect": "To collect",
  "home.tab.pay": "To pay",
  "home.total.label.collect": "To collect",
  "home.total.label.pay": "To pay",
  "home.empty.collect.title": "Nothing to collect yet",
  "home.empty.collect.subtitle": "Tap the + button to add someone you keep accounts with.",
  "home.empty.pay.title": "You owe no one yet",
  "home.empty.pay.subtitle":
    "When you take goods or borrow money, log it from that person's page and they'll appear here.",
  "home.from.someone": "from {count} person",
  "home.from.many": "from {count} people",
  "home.empty.noOneYet": "no one here yet",
  "home.empty.allSettled": "everyone settled",

  // Person detail
  "person.action.iGave": "I gave",
  "person.action.iReceived": "I received",
  "person.balance.theyOwe": "THEY OWE YOU",
  "person.balance.youOwe": "YOU OWE THEM",
  "person.balance.settled": "SETTLED",
  "person.empty.title": "No entries yet",
  "person.empty.subtitle":
    'Tap "I gave" when money or goods leave your hand, "I received" when they come in.',
  "person.ping": "Ping {name} on WhatsApp",
  "person.delete.title": "Delete this entry?",
  "person.delete.description":
    "The amount stops counting toward this person's balance. You can't undo this from here.",
  "person.delete.confirm": "Delete",

  // Person edit / add
  "personEdit.title": "Edit person",
  "personEdit.name.label": "Name",
  "personEdit.phone.label": "WhatsApp number",
  "personEdit.save": "Save changes",
  "personAdd.title": "Add or find person",
  "personAdd.cancel": "Cancel",
  "personAdd.name.placeholder": "Type to search or add",
  "personAdd.pickContact": "or pick from your contacts",
  "personAdd.add": "Add {name}",
  "personAdd.phone.hint": "Needed to send pings on WhatsApp.",
  "personAdd.phone.invalid": "Couldn't read that phone number. Try +93 70 123 4567.",
  "personAdd.phone.conflict": "Phone already used by {name}",

  // Entry
  "entry.amount.label": "Amount (AFN)",
  "entry.note.label": "Note",
  "entry.save": "Save",
  "entry.invalidAmount": "Enter a valid amount",
  "entry.saved": "Entry saved",
  "entry.updated": "Entry updated",
  "entry.deleted": "Entry deleted",
  "entry.saveFailed": "Couldn't save. Try again.",

  // Settings
  "settings.title": "Settings",
  "settings.name.label": "Your name",
  "settings.shop.label": "Store or business name",
  "settings.shop.hint": "Leave blank if you don't have one.",
  "settings.save": "Save changes",
  "settings.saved": "Saved",

  // Common
  "common.cancel": "Cancel",
  "common.required": "*",
  "common.removed": "{name} removed",
  "common.remove": "Remove",
  "common.remove.title": "Remove {name}?",
  "common.remove.description":
    "They'll disappear from your list. Their entries stay on your device.",
} as const;

type Key = keyof typeof en;

// Persian/Dari translations. Fill in the right-hand values; keep keys exact.
// Empty strings fall back to English. Recommend hand-translating with a Dari
// speaker — machine translation tends to use Iranian Persian vocabulary
// (e.g., "tomans") that doesn't read right in Kabul / Afghan context.
const fa: Partial<Record<Key, string>> = {
  // TODO: paste Persian translations here. Examples to start the table:
  //   "onboarding.continue": "ادامه",
  //   "home.tab.collect": "وصول",
  //   "home.tab.pay": "پرداخت",
  //   "person.action.iGave": "دادم",
  //   "person.action.iReceived": "گرفتم",
};

const TABLES = { en, fa } as const;
type LocaleCode = keyof typeof TABLES;

// Active locale, computed once at module load. The current launch's strings
// reflect this. When we add a manual override toggle, this will read from
// app_meta first.
function pickLocale(): LocaleCode {
  const first = getLocales()[0];
  const lang = (first?.languageCode ?? "en").toLowerCase();
  // Dari (prs) and Persian (fa) both use the `fa` table.
  if (lang === "fa" || lang === "prs") return "fa";
  return "en";
}

let currentLocale: LocaleCode = pickLocale();

export function getLocale(): LocaleCode {
  return currentLocale;
}

export function isPersianScript(): boolean {
  return currentLocale === "fa";
}

// Returns the appropriate fontFamily for the active locale — Vazirmatn for
// Persian-script content, Inter for everything else. Use this when rendering
// user-facing text that shouldn't be hardcoded to Inter.
//
// Usage:
//   <Text style={{ fontFamily: fontFor("semi") }}>...</Text>
export function fontFor(weight: "regular" | "medium" | "semi" | "bold"): string {
  if (currentLocale === "fa") {
    const map = {
      regular: fonts.faRegular,
      medium: fonts.faMedium,
      semi: fonts.faSemi,
      bold: fonts.faBold,
    };
    return map[weight];
  }
  const map = {
    regular: fonts.sansRegular,
    medium: fonts.sansMedium,
    semi: fonts.sansSemi,
    bold: fonts.sansBold,
  };
  return map[weight];
}

// Look up a string for the active locale. Falls back to English if the key
// is missing from the localized table (e.g., during partial translation).
// `vars` substitutes `{placeholder}` tokens with their string values.
export function t(key: Key, vars?: Record<string, string | number>): string {
  const localized = TABLES[currentLocale][key];
  const template = (localized && localized.length > 0 ? localized : en[key]) ?? key;
  if (!vars) return template;
  return Object.entries(vars).reduce(
    (s, [k, v]) => s.replaceAll(`{${k}}`, String(v)),
    template,
  );
}

// Re-evaluate the locale after the user (eventually) toggles a manual
// override. Currently device-driven only.
export function refreshLocale(): void {
  currentLocale = pickLocale();
}
