import type { LocaleCode } from "./i18n";

// These static tables work even when startup cannot open the preference database.
const en = {
  settingUp: "Setting up your kaata…",
  almostReady: "Almost ready",
  migrationInstructions:
    "Please close kaata from your recent apps, then open it again. This is a one-time step for the new language settings to take effect.",
  closeKaata: "Close kaata",
  openDataFailed: "Couldn't open your Kaata data",
  reopenAndroid: "Please close kaata from your recent apps and open it again.",
  reopenIos:
    "Please force-quit kaata (swipe up from the bottom and flick it away) and open it again.",
  contactRecurring: "If it keeps happening, contact {SUPPORT_CONTACT}",
  tryAgain: "Try again",
  backupDamaged: "The backup on this phone is damaged too.",
  backupMissing: "No backup was found on this phone.",
  restoreFailed: "Restoring from the backup failed.",
  accountRecoveryFailed: "Recovery failed. Please contact support before reinstalling.",
  dataDamaged: "Your Kaata data is damaged",
  backupAvailable:
    "There is a backup on this phone{backupAge}. Restoring it brings your kaata back to that point.",
  restoreLocal: "Restore this phone's backup",
  accountRestoreAvailable:
    "This clears the damaged data on this phone, keeps local backups, and takes you to sign in again. After signing in, you can restore from your account.",
  restoreAccount: "Sign in to restore",
  reinstallWarning:
    "Please contact us before reinstalling — reinstalling erases the ledger on this phone.",
  backupAgeLessThanHour: " from less than an hour ago",
  backupAgeHours: " from {hours} hour{pluralSuffix} ago",
  backupAgeDays: " from {days} day{pluralSuffix} ago",
  startFailed: "Couldn't start",
  restartAndroid:
    "Tap the button to restart kaata. If that doesn't work, close it from your recent apps and open it again.",
  reopenIosShort:
    "Please force-quit kaata (swipe up from the bottom and flick it away) and open it again.",
  diagnosticsIntro: "If you contact support, share this:",
  diagnosticsStage: "stage:",
  diagnosticsError: "error:",
  sendSupport: "Send to {SUPPORT_CONTACT}",
  closeRestart: "Close & restart",
} as const;
export type BootKey = keyof typeof en;
const fa: Record<BootKey, string> = {
  settingUp: "در حال آماده‌سازی کاتای شما…",
  almostReady: "تقریباً آماده",
  migrationInstructions:
    "لطفاً کاتا را از برنامه‌های اخیر ببندید و دوباره باز کنید. این یک‌بار برای اعمال تنظیمات زبان جدید لازم است.",
  closeKaata: "بستن کاتا",
  openDataFailed: "داده‌های کاتای شما باز نشد",
  reopenAndroid: "لطفاً کاتا را از برنامه‌های اخیر ببندید و دوباره باز کنید.",
  reopenIos:
    "لطفاً کاتا را به‌طور کامل ببندید (از پایین صفحه به بالا بکشید و آن را کنار بزنید) و دوباره باز کنید.",
  contactRecurring: "اگر تکرار شد، با {SUPPORT_CONTACT} تماس بگیرید",
  tryAgain: "دوباره کوشش کنید",
  backupDamaged: "پشتیبان این تلفون هم آسیب دیده است.",
  backupMissing: "در این تلفون پشتیبانی پیدا نشد.",
  restoreFailed: "بازیابی از پشتیبان ناکام شد.",
  accountRecoveryFailed: "بازیابی ناکام شد. پیش از نصب دوباره با پشتیبانی تماس بگیرید.",
  dataDamaged: "داده‌های کاتای شما آسیب دیده",
  backupAvailable:
    "در این تلفون یک پشتیبان وجود دارد. با بازیابی آن، کاتای شما تا همان زمان برمی‌گردد.",
  restoreLocal: "بازیابی پشتیبان",
  accountRestoreAvailable:
    "این کار داده‌های آسیب‌دیدهٔ این تلفون را پاک می‌کند، پشتیبان‌های محلی را نگه می‌دارد و شما را به صفحهٔ ورود می‌برد. پس از ورود می‌توانید از حساب خود بازیابی کنید.",
  restoreAccount: "ورود برای بازیابی",
  reinstallWarning:
    "پیش از نصب دوباره با ما تماس بگیرید — نصب دوباره کتاب این تلفون را پاک می‌کند.",
  backupAgeLessThanHour: " از کمتر از یک ساعت پیش",
  backupAgeHours: " از {hours} ساعت پیش",
  backupAgeDays: " از {days} روز پیش",
  startFailed: "کاتا شروع نشد",
  restartAndroid:
    "روی دکمه بزنید تا کاتا دوباره راه‌اندازی شود. اگر کار نکرد، آن را از برنامه‌های اخیر ببندید و دوباره باز کنید.",
  reopenIosShort: "لطفاً کاتا را به‌طور کامل ببندید و دوباره باز کنید.",
  diagnosticsIntro: "اگر با پشتیبانی تماس می‌گیرید، این را بفرستید:",
  diagnosticsStage: "stage:",
  diagnosticsError: "error:",
  sendSupport: "به {SUPPORT_CONTACT} ارسال کنید",
  closeRestart: "بستن و راه‌اندازی",
};
const ps: Record<BootKey, string> = {
  settingUp: "ستاسو کاټه چمتو کېږي…",
  almostReady: "نږدې چمتو ده",
  migrationInstructions:
    "مهرباني وکړئ کاټه د وروستیو پرانیستل شوو اپونو له لېست څخه وتړئ او بیا یې پرانیزئ. دا کار د ژبې د نویو تنظیماتو د پلي کېدو لپاره یوازې یو ځل اړین دی.",
  closeKaata: "کاټه وتړئ",
  openDataFailed: "ستاسو د کاټه معلومات پرانیستل نه شول",
  reopenAndroid:
    "مهرباني وکړئ کاټه د وروستیو پرانیستل شوو اپونو له لېست څخه وتړئ او بیا یې پرانیزئ.",
  reopenIos:
    "مهرباني وکړئ کاټه په بشپړه توګه وتړئ (د پردې له بېخه پورته ګوته کش کړئ او کاټه له لېست څخه لرې کړئ) او بیا یې پرانیزئ.",
  contactRecurring: "که دا ستونزه بیا راپېښه شوه، له {SUPPORT_CONTACT} سره اړیکه ونیسئ.",
  tryAgain: "بیا هڅه وکړئ",
  backupDamaged: "د دې ټیلیفون بیک‌اپ هم خراب شوی دی.",
  backupMissing: "په دې ټیلیفون کې بیک‌اپ ونه موندل شو.",
  restoreFailed: "له بیک‌اپ څخه بېرته راګرځول ناکام شول.",
  accountRecoveryFailed:
    "بېرته راګرځول ناکام شول. مهرباني وکړئ له بیا نصبولو مخکې له ملاتړ سره اړیکه ونیسئ.",
  dataDamaged: "ستاسو د کاټه معلومات خراب شوي دي",
  backupAvailable:
    "په دې ټیلیفون کې بیک‌اپ شته{backupAge}. په بېرته راګرځولو سره به ستاسو کاټه د هماغه وخت حالت ته راوګرځي.",
  restoreLocal: "د دې ټیلیفون بیک‌اپ بېرته را وګرځوئ",
  accountRestoreAvailable:
    "دا کار په دې ټیلیفون کې خراب شوي معلومات پاکوي، ځايي بیک‌اپونه ساتي او تاسو بېرته د ننوتلو پاڼې ته بیایي. تر ننوتلو وروسته له خپل حساب څخه معلومات بېرته راګرځولی شئ.",
  restoreAccount: "د بېرته راګرځولو لپاره ننوځئ",
  reinstallWarning:
    "مهرباني وکړئ له بیا نصبولو مخکې له موږ سره اړیکه ونیسئ؛ بیا نصب کول د دې ټیلیفون حساب کتاب پاکوي.",
  backupAgeLessThanHour: " چې له یوه ساعت څخه لږ مخکې جوړ شوی",
  backupAgeHours: " چې {hours} ساعته مخکې جوړ شوی",
  backupAgeDays: " چې {days} ورځې مخکې جوړ شوی",
  startFailed: "کاټه پیل نه شوه",
  restartAndroid:
    "د کاټه د بیا پیلولو لپاره پر تڼۍ ووهئ. که کار یې ونه کړ، د وروستیو پرانیستل شوو اپونو له لېست څخه یې وتړئ او بیا یې پرانیزئ.",
  reopenIosShort: "مهرباني وکړئ کاټه په بشپړه توګه وتړئ او بیا یې پرانیزئ.",
  diagnosticsIntro: "که له ملاتړ سره اړیکه نیسئ، دا ورسره شریک کړئ:",
  diagnosticsStage: "پړاو:",
  diagnosticsError: "تېروتنه:",
  sendSupport: "{SUPPORT_CONTACT} ته یې واستوئ",
  closeRestart: "وتړئ او بیا یې پیل کړئ",
};
const TABLES = { en, fa, ps };

export function bootText(
  locale: LocaleCode,
  key: BootKey,
  vars?: Record<string, string | number>,
): string {
  let text: string = TABLES[locale][key];
  for (const [name, value] of Object.entries(vars ?? {}))
    text = text.replaceAll("{" + name + "}", String(value));
  return text;
}

export function formatBackupAge(at: number | null, locale: LocaleCode, now = Date.now()): string {
  if (at == null) return "";
  // File.modificationTime is in milliseconds in the current File API.
  const hours = Math.floor((now - at) / 3_600_000);
  if (!Number.isFinite(hours) || hours < 0) return "";
  if (hours < 1) return bootText(locale, "backupAgeLessThanHour");
  const days = Math.floor(hours / 24);
  const count = hours < 24 ? hours : days;
  const number =
    locale === "en" ? count : String(count).replace(/[0-9]/g, (d) => "۰۱۲۳۴۵۶۷۸۹"[Number(d)]);
  if (locale === "ps" && count === 1)
    return hours < 24 ? " چې یو ساعت مخکې جوړ شوی" : " چې یوه ورځ مخکې جوړ شوی";
  return bootText(locale, hours < 24 ? "backupAgeHours" : "backupAgeDays", {
    hours: number,
    days: number,
    pluralSuffix: locale === "en" && count !== 1 ? "s" : "",
  });
}
