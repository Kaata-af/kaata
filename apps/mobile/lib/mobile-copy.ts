import { getLocale, type LocaleCode } from "./i18n";

// Copy outside the main catalog, imported from the approved language review.
const COPY = {
  en: {
    "notification.sync.channel": "Synced updates",
    "notification.sync.description":
      "New entries synced from your account while Kaata was in the background.",
    "notification.sync.title": "New entries synced",
    "notification.sync.body": "Tap to open Kaata",
    "notification.sync.bodyNamed": "New entries synced — tap to open",
    "dialog.defaultConfirm": "OK",
    "pdf.poweredBy": "Powered by kaata. — kaata.af",
    "diagnostics.appVersion": "app {appVersion}",
    "diagnostics.build": " · build {buildNumber}",
    "diagnostics.devOnly": "DEV ONLY",
    "diagnostics.resetExplain":
      "Wipes kaata.db (all ledger + onboarding state) and reloads, so you land back on onboarding. Never ships — __DEV__ gated.",
    "diagnostics.resetArmed": "Tap again to wipe & reload",
    "diagnostics.reset": "Reset all data",
  },
  fa: {
    "notification.sync.channel": "تازه‌های همگام‌شده",
    "notification.sync.description": "ثبت‌های تازه از حساب شما در پس‌زمینهٔ کاتا همگام شد.",
    "notification.sync.title": "ثبت‌های تازه همگام شد",
    "notification.sync.body": "برای باز کردن کاتا بزنید",
    "notification.sync.bodyNamed": "ثبت‌های تازه همگام شد — برای باز کردن بزنید",
    "dialog.defaultConfirm": "باشد",
    "pdf.poweredBy": "با کاتا — kaata.af",
    "diagnostics.appVersion": "نسخهٔ اپ {appVersion}",
    "diagnostics.build": "، ساخت {buildNumber}",
    "diagnostics.devOnly": "فقط برای توسعه",
    "diagnostics.resetExplain":
      "kaata.db (همهٔ حساب‌ها و وضعیت تنظیمات اولیه) پاک و اپ دوباره باز می‌شود. فقط در نسخهٔ توسعه نمایش داده می‌شود.",
    "diagnostics.resetArmed": "برای پاک کردن و باز کردن دوباره، یک بار دیگر بزنید",
    "diagnostics.reset": "پاک کردن همهٔ اطلاعات",
  },
  ps: {
    "notification.sync.channel": "همغږي شوي بدلونونه",
    "notification.sync.description":
      "کله چې کاټه په شالید کې وه، نوي ثبتونه ستاسو له حساب څخه همغږي شول.",
    "notification.sync.title": "نوي ثبتونه همغږي شول",
    "notification.sync.body": "د کاټه د پرانیستلو لپاره ووهئ",
    "notification.sync.bodyNamed": "نوي ثبتونه همغږي شول؛ د پرانیستلو لپاره ووهئ",
    "dialog.defaultConfirm": "سمه ده",
    "pdf.poweredBy": "د کاټه په مرسته — kaata.af",
    "diagnostics.appVersion": "اپ {appVersion}",
    "diagnostics.build": " · نسخه {buildNumber}",
    "diagnostics.devOnly": "یوازې د پراختیا لپاره",
    "diagnostics.resetExplain":
      "kaata.db (ټول حساب کتاب او د لومړي ځل تنظیمات) پاکوي او اپ بیا پرانیزي، څو د لومړي ځل تنظیماتو ته ستانه شئ. یوازې د پراختیا په بڼه کې ښکاري.",
    "diagnostics.resetArmed": "د پاکولو او بیا پرانیستلو لپاره بیا ووهئ",
    "diagnostics.reset": "ټول معلومات بیا له پیله تنظیم کړئ",
  },
} as const;

export type MobileCopyKey = keyof typeof COPY.en;
export function tExtraIn(
  locale: LocaleCode,
  key: MobileCopyKey,
  vars?: Record<string, string | number>,
): string {
  let value: string = COPY[locale][key];
  for (const [name, replacement] of Object.entries(vars ?? {}))
    value = value.replaceAll(`{${name}}`, String(replacement));
  return value;
}
export function tExtra(key: MobileCopyKey, vars?: Record<string, string | number>): string {
  return tExtraIn(getLocale(), key, vars);
}
