import { getLocales } from "expo-localization";
import { getAppMeta } from "./db";

// Tiny home-rolled i18n. Two reasons we didn't pull in i18next / react-i18next:
//   1. kaata has ~50 strings total — overkill ratio.
//   2. We're locked LTR (see app/_layout.tsx) and don't need framework-level
//      RTL plumbing yet. When that changes, swap to a real lib.
//
// Font switching is handled separately in lib/fonts.ts — when the device
// locale is fa/prs, every `fonts.sansBold` etc. reference resolves to
// Vazirmatn automatically. This module's only job is string lookup.
//
// In-app override:
//   Users can pick a language explicitly in Settings. That preference is
//   persisted in app_meta under "locale_pref" (values: 'system' | 'en' | 'fa').
//   On app start, `initLocaleFromPref()` is awaited before the first render
//   so the very first frame uses the chosen locale. `setLocale()` updates
//   the active locale at runtime for subsequent re-renders.
//
//   Font caveat: lib/fonts.ts evaluates the script choice ONCE at module
//   load based on device locale — it can't read app_meta synchronously. So
//   for users who override their device locale via this toggle, Persian
//   glyphs fall back to the system Arabic font until the next app launch.
//   This is rarely visible in practice (most Afghan users already have a
//   Persian device locale) but worth knowing.

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
  "person.sheet.edit": "Edit",
  "person.sheet.delete": "Delete",
  "person.row.noEntries": "no entries yet",
  "person.row.settled": "settled",

  // Person edit / add
  "personEdit.title": "Edit person",
  "personEdit.name.label": "Name",
  "personEdit.phone.label": "WhatsApp number",
  "personEdit.save": "Save changes",
  "personAdd.title": "Add or find person",
  "personAdd.name.placeholder": "Type to search or add",
  "personAdd.pickContact": "or pick from your contacts",
  "personAdd.add": "Add {name}",
  "personAdd.phone.hint": "Needed to send pings on WhatsApp.",
  "personAdd.phone.invalid": "Couldn't read that phone number. Try +93 70 123 4567.",
  "personAdd.phone.conflict": "Phone already used by {name}",
  "personAdd.section.matches": "Matches",
  "personAdd.section.recent": "Recent",
  "personAdd.noMatch": 'No one matches "{query}".',
  "personAdd.empty.title": "No one here yet",
  "personAdd.empty.subtitle": "Type a name above to add your first person.",
  "personAdd.rightAmount.new": "new",
  "personAdd.rightAmount.settled": "settled",
  "personAdd.personNotFound": "Person not found.",

  // Entry
  "entry.amount.label": "Amount (AFN)",
  "entry.note.label": "Note",
  "entry.note.placeholder": "Flour and tea",
  "entry.save": "Save",
  "entry.saveChanges": "Save changes",
  "entry.context.to": "to",
  "entry.context.from": "from",
  "entry.edit.title": "Edit · {verb}",
  "entry.edit.hint":
    'Direction can\'t be changed. To turn this into "{otherVerb}", delete this entry and add a new one.',
  "entry.notFound": "This entry no longer exists.",
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
  "settings.language.label": "Language",
  "settings.language.option.system": "System default",
  "settings.language.option.en": "English",
  "settings.language.option.fa": "دری",
  "settings.language.changed": "Language updated.",
  "settings.currency.label": "Default currency",
  "settings.currency.hint":
    "This relabels how amounts are shown. It does not convert existing entries.",
  "settings.currency.changed": "Currency updated.",
  "home.exit.hint": "Press back again to exit.",
  "entry.amount.labelTemplate": "Amount ({code})",

  // Country picker
  "country.title": "Choose country",
  "country.search": "Search by name or code",
  "country.noMatch": "No match.",

  // Contacts picker
  "contacts.title": "Pick from contacts",
  "contacts.search": "Search by name",
  "contacts.permission.title": "Contacts access needed",
  "contacts.permission.body":
    "Open your phone settings and allow Kaata to access contacts to use this shortcut.",
  "contacts.permission.button": "Open settings",
  "contacts.empty.none": "No contacts on this phone.",
  "contacts.empty.noMatch": 'No contact matches "{query}".',
  "contacts.noPhone": "no phone",

  // WhatsApp share — full message body sent to the customer.
  "share.greeting": "Salaam {name}.",
  "share.theyOwe.header": "Your kaata at {accountWith}:",
  "share.theyOwe.amount": "🔴 You owe: −{amount} {currency}",
  "share.theyOwe.cta": "Please settle when you can.",
  "share.youOwe.header": "Our kaata:",
  "share.youOwe.amount": "🟢 I owe you: +{amount} {currency}",
  "share.youOwe.cta": "I will settle soon.",
  "share.settled.line": "🤝 Our kaata is fully settled.",
  "share.settled.cta": "Thank you.",
  "share.footer": "— Sent via Kaata.af",

  // Brand
  "brand.wordmark": "kaata.",

  // Relative time formatting (used in row subtitles & entry timestamps).
  // {n} is the number; in Persian the unit follows the number, then "پیش"
  // (= "ago") closes the phrase.
  "format.justNow": "just now",
  "format.minutesAgo": "{n}m ago",
  "format.hoursAgo": "{n}h ago",
  "format.yesterday": "yesterday",
  "format.daysAgo": "{n}d ago",
  "format.weeksAgo": "{n}w ago",

  // Common
  "common.cancel": "Cancel",
  "common.back": "Back",
  "common.removed": "{name} removed",
  "common.remove": "Remove",
  "common.remove.title": "Remove {name}?",
  "common.remove.description":
    "They'll disappear from your list. Their entries stay on your device.",
} as const;

type Key = keyof typeof en;

// Afghan Dari translations. Curated for the Kabul / Mazar / Herat shopkeeper
// market — uses Afghan vernacular vocabulary (دکان not مغازه, تلفون not تلفن,
// مخاطب for contact, etc.) rather than Iranian Persian. Western digits (1-9)
// throughout, matching modern Afghan commerce.
//
// Missing keys fall back to English; half-translated UI doesn't break. Add a
// new key here as soon as you add it to the en table.
const fa: Partial<Record<Key, string>> = {
  // Onboarding
  "onboarding.subtitle": "یک دفتر آرام میان شما و کسانی که اعتماد دارید.",
  "onboarding.name.label": "نام شما",
  "onboarding.name.placeholder": "سلطان",
  "onboarding.shop.label": "نام دکان یا تجارت",
  "onboarding.shop.placeholder": "دکان سلطان",
  "onboarding.continue": "ادامه",
  "onboarding.nameRequired": "نام لازم است",

  // Home
  "home.tab.collect": "وصول",
  "home.tab.pay": "پرداخت",
  "home.total.label.collect": "قابل وصول",
  "home.total.label.pay": "قابل پرداخت",
  "home.empty.collect.title": "هنوز چیزی برای وصول نیست",
  "home.empty.collect.subtitle": "روی دکمه + بزنید تا کسی را اضافه کنید که با او حساب دارید.",
  "home.empty.pay.title": "هنوز از کسی قرضدار نیستید",
  "home.empty.pay.subtitle":
    "وقتی جنس می‌گیرید یا پول قرض می‌کنید، از صفحه آن شخص ثبت کنید — همین‌جا ظاهر می‌شود.",
  "home.from.someone": "از {count} نفر",
  "home.from.many": "از {count} نفر",
  "home.empty.noOneYet": "هنوز کسی نیست",
  "home.empty.allSettled": "همه تصفیه شده",

  // Person detail
  "person.action.iGave": "دادم",
  "person.action.iReceived": "گرفتم",
  "person.balance.theyOwe": "از شما قرضدار",
  "person.balance.youOwe": "از او قرضدار",
  "person.balance.settled": "تصفیه شده",
  "person.empty.title": "هنوز ثبتی نیست",
  "person.empty.subtitle":
    'وقتی پول یا جنس از دست‌تان می‌رود "دادم" را بزنید، وقتی به دست‌تان می‌آید "گرفتم".',
  "person.ping": "یادآوری به {name} در واتساپ",
  "person.delete.title": "این ثبت را حذف کنیم؟",
  "person.delete.description":
    "این مقدار دیگر در حساب این شخص محاسبه نمی‌شود. از اینجا قابل برگشت نیست.",
  "person.delete.confirm": "حذف",
  "person.sheet.edit": "ویرایش",
  "person.sheet.delete": "حذف",
  "person.row.noEntries": "هنوز ثبتی نیست",
  "person.row.settled": "تصفیه",

  // Person edit / add
  "personEdit.title": "ویرایش شخص",
  "personEdit.name.label": "نام",
  "personEdit.phone.label": "شماره واتساپ",
  "personEdit.save": "ذخیره تغییرات",
  "personAdd.title": "افزودن یا یافتن شخص",
  "personAdd.name.placeholder": "برای جستجو یا افزودن تایپ کنید",
  "personAdd.pickContact": "یا از مخاطبین تلفون انتخاب کنید",
  "personAdd.add": "افزودن {name}",
  "personAdd.phone.hint": "برای ارسال یادآوری در واتساپ لازم است.",
  "personAdd.phone.invalid": "این شماره را نتوانستم بخوانم. مثلاً +93 70 123 4567.",
  "personAdd.phone.conflict": "این شماره قبلاً برای {name} ثبت شده",
  "personAdd.section.matches": "نتایج",
  "personAdd.section.recent": "اخیر",
  "personAdd.noMatch": "هیچ‌کس با «{query}» مطابقت نمی‌کند.",
  "personAdd.empty.title": "هنوز کسی نیست",
  "personAdd.empty.subtitle": "نام را در بالا تایپ کنید تا اولین شخص را اضافه کنید.",
  "personAdd.rightAmount.new": "جدید",
  "personAdd.rightAmount.settled": "تصفیه",
  "personAdd.personNotFound": "این شخص پیدا نشد.",

  // Entry
  "entry.amount.label": "مقدار (AFN)",
  "entry.note.label": "یادداشت",
  "entry.note.placeholder": "آرد و چای",
  "entry.save": "ذخیره",
  "entry.saveChanges": "ذخیره تغییرات",
  "entry.context.to": "به",
  "entry.context.from": "از",
  "entry.edit.title": "ویرایش · {verb}",
  "entry.edit.hint":
    'جهت قابل تغییر نیست. برای تبدیل به "{otherVerb}" این ثبت را حذف کنید و یکی نو اضافه کنید.',
  "entry.notFound": "این ثبت دیگر وجود ندارد.",
  "entry.invalidAmount": "یک مقدار درست وارد کنید",
  "entry.saved": "ثبت شد",
  "entry.updated": "به‌روزرسانی شد",
  "entry.deleted": "حذف شد",
  "entry.saveFailed": "ذخیره نشد. دوباره امتحان کنید.",

  // Settings
  "settings.title": "تنظیمات",
  "settings.name.label": "نام شما",
  "settings.shop.label": "نام دکان یا تجارت",
  "settings.shop.hint": "اگر ندارید خالی بگذارید.",
  "settings.save": "ذخیره تغییرات",
  "settings.saved": "ذخیره شد",
  "settings.language.label": "زبان",
  "settings.language.option.system": "پیش‌فرض سیستم",
  "settings.language.option.en": "English",
  "settings.language.option.fa": "دری",
  "settings.language.changed": "زبان تغییر کرد.",
  "settings.currency.label": "ارز پیش‌فرض",
  "settings.currency.hint": "این فقط برچسب است. اعداد تغییر نمیکند.",
  "settings.currency.changed": "ارز تغییر کرد.",
  "home.exit.hint": "برای خروج دوباره برگشت را بزنید.",
  "entry.amount.labelTemplate": "مقدار ({code})",

  // Country picker
  "country.title": "انتخاب کشور",
  "country.search": "جستجو بر اساس نام یا کد",
  "country.noMatch": "موردی پیدا نشد.",

  // Contacts picker
  "contacts.title": "انتخاب از مخاطبین",
  "contacts.search": "جستجو بر اساس نام",
  "contacts.permission.title": "دسترسی به مخاطبین لازم است",
  "contacts.permission.body": "از تنظیمات تلفون اجازه دسترسی به مخاطبین را برای کاتا فعال کنید.",
  "contacts.permission.button": "باز کردن تنظیمات",
  "contacts.empty.none": "هیچ مخاطبی روی این تلفون نیست.",
  "contacts.empty.noMatch": "هیچ مخاطبی با «{query}» مطابقت نمی‌کند.",
  "contacts.noPhone": "بدون شماره",

  // WhatsApp share — full message body sent to the customer.
  "share.greeting": "سلام {name}.",
  "share.theyOwe.header": "کاتای شما در {accountWith}:",
  "share.theyOwe.amount": "🔴 بدهی شما: −{amount} {currency}",
  "share.theyOwe.cta": "لطفاً وقتی توانستید تصفیه کنید.",
  "share.youOwe.header": "کاتای ما:",
  "share.youOwe.amount": "🟢 قرضدار تان هستم: +{amount} {currency}",
  "share.youOwe.cta": "به‌زودی تصفیه می‌کنم.",
  "share.settled.line": "🤝 کاتای ما کاملاً تصفیه شده.",
  "share.settled.cta": "تشکر.",
  "share.footer": "پیام از طرف kaata.af",

  // Brand
  "brand.wordmark": "کاتا.",

  // Relative time formatting.
  "format.justNow": "همین حالا",
  "format.minutesAgo": "{n} دقیقه پیش",
  "format.hoursAgo": "{n} ساعت پیش",
  "format.yesterday": "دیروز",
  "format.daysAgo": "{n} روز پیش",
  "format.weeksAgo": "{n} هفته پیش",

  // Common
  "common.cancel": "لغو",
  "common.back": "برگشت",
  "common.removed": "{name} حذف شد",
  "common.remove": "حذف",
  "common.remove.title": "{name} حذف شود؟",
  "common.remove.description": "از لیست شما حذف می‌شود. ثبت‌های آن‌ها در دستگاه می‌ماند.",
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

// Subscribers for live locale updates. lib/direction.ts uses this to flip
// the layout direction when the user picks a new language in Settings —
// any component using useIsRTL() (or useLocale()) re-renders without an
// app restart. Notifications fire AFTER currentLocale is updated, so a
// subscriber's callback can re-read getLocale() and see the new value.
const localeListeners = new Set<() => void>();

function notifyLocaleChange(): void {
  // Snapshot the set so a listener that unsubscribes itself during
  // notification doesn't mutate the iteration target.
  for (const fn of [...localeListeners]) {
    try {
      fn();
    } catch (err) {
      // Listener bugs shouldn't break other listeners. Log and continue.
      console.warn("[i18n] locale listener threw", err);
    }
  }
}

export function subscribeLocale(fn: () => void): () => void {
  localeListeners.add(fn);
  return () => {
    localeListeners.delete(fn);
  };
}

export function getLocale(): LocaleCode {
  return currentLocale;
}

export function isPersianScript(): boolean {
  return currentLocale === "fa";
}

export type LocalePref = "system" | LocaleCode;

// Read the stored override from app_meta and apply it. Called by _layout.tsx
// during the async init phase, before the app reaches first render. If no
// override is set (or the value is 'system'), currentLocale stays at whatever
// pickLocale() chose at module load (the device locale).
//
// We notify subscribers after applying — the typical caller is the init
// effect, which runs BEFORE first render, so no consumers exist yet and the
// notify is a no-op. It's still correct to notify in case anything has
// already subscribed (e.g., a future provider that mounts above the gate).
export async function initLocaleFromPref(): Promise<void> {
  try {
    const pref = (await getAppMeta("locale_pref")) as LocalePref | null;
    if (pref === "en" || pref === "fa") {
      if (currentLocale !== pref) {
        currentLocale = pref;
        notifyLocaleChange();
      }
    }
    // 'system' or null → leave at device locale.
  } catch {
    // app_meta unreadable — fall back to device locale silently.
  }
}

// Imperatively change the active locale. Strings update on the next render
// for any component that reads them through t(). Caller is responsible for
// also persisting the choice (see setLocalePref in db.ts via app_meta).
//
// Subscribers (via subscribeLocale) are notified after the update — this is
// how lib/direction.ts's useIsRTL() re-renders consumers when language
// switches in Settings.
export function setLocale(pref: LocalePref): void {
  const next: LocaleCode = pref === "system" ? pickLocale() : pref;
  if (currentLocale === next) return;
  currentLocale = next;
  notifyLocaleChange();
}

// Look up a string for the active locale. Falls back to English if the key
// is missing from the localized table (e.g., during partial translation).
// `vars` substitutes `{placeholder}` tokens with their string values.
export function t(key: Key, vars?: Record<string, string | number>): string {
  const localized = TABLES[currentLocale][key];
  const template = (localized && localized.length > 0 ? localized : en[key]) ?? key;
  if (!vars) return template;
  return Object.entries(vars).reduce((s, [k, v]) => s.replaceAll(`{${k}}`, String(v)), template);
}

// Re-evaluate the locale after the user (eventually) toggles a manual
// override. Currently device-driven only.
export function refreshLocale(): void {
  currentLocale = pickLocale();
}
