import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";

// Tiny home-rolled i18n for the funnel site, mirroring the mobile app's
// approach (lib/i18n.ts there): two flat string tables with identical keys,
// no framework. Persian follows the same Afghan-Dari vocabulary rules as
// mobile — تلفون not تلفن, دکان not مغازه, کاتا for the product.
//
// Language resolution: localStorage("kaata_lang") → browser language
// (fa/prs → fa) → en. The choice persists; the <html> element's lang/dir
// follow the active language so the whole page flips to RTL for Persian.

export type Lang = "en" | "fa";

const LANG_KEY = "kaata_lang";

const en = {
  // Header / nav
  "nav.product": "Product",
  "nav.how": "How it works",
  "nav.download": "Download",
  "nav.getApp": "Get the app",

  // Hero
  "hero.title.line1": "Run your shop",
  "hero.title.line2": "on trust.",
  "hero.sub":
    "A quiet ledger between you and the people you trust. Track what they owe you, what you owe them, and send a friendly reminder over WhatsApp in two taps.",
  "hero.cta": "Download for Android",
  "hero.how": "See how it works ↓",
  "hero.points": "Free forever · Works offline · No account",

  // Feature sections
  "feature.offline.eyebrow": "Built for the bazaar",
  "feature.offline.title": "A quiet tally that works offline.",
  "feature.offline.body":
    "Your kaata book lives on your phone. Add people, record what you gave and what you received — all without a connection. No account, no cloud, no setup. Your data stays where it belongs.",
  "feature.ping.eyebrow": "The killer feature",
  "feature.ping.title": "A reminder, two taps away.",
  "feature.ping.body":
    "Open a person, tap Ping. Kaata opens WhatsApp with a polite, pre-filled message — their name, your shop, their current balance. No copy-paste, no awkward typing. Just a friendly nudge, sent in seconds.",

  // Final CTA
  "cta.title.line1": "Stop chasing slips",
  "cta.title.line2": "of paper.",
  "cta.sub": "Free forever. No account, no card, no setup.",
  "cta.button": "Download for Android",

  // Footer
  "footer.tagline": "A quiet ledger between you and the people you trust. Built in Kabul.",
  "footer.product": "Product",
  "footer.download": "Download",
  "footer.how": "How it works",
  "footer.inside": "What's inside",
  "footer.company": "Company",
  "footer.contact": "Contact on WhatsApp",
  "footer.openSource": "Open source · Coming soon",
  "footer.copyright": "© 2026 Kaata · Made in Kabul.",

  // Download page
  "download.title": "Install Kaata",
  "download.sub": "Get the Android app now — the iPhone and Play Store versions are coming soon.",
  "download.step1": 'Tap "Download APK" above.',
  "download.step2": "Open the downloaded file.",
  "download.step3":
    'If your phone says it can\'t install unknown apps from this source, tap Settings, turn on "Allow from this source", then go back.',
  "download.step4": 'If Google Play Protect warns you, tap "More details", then "Install anyway".',
  "download.step5": "Tap Install.",
  "download.button": "Download APK · v{version}",
  "download.toast": "Starting download — install when ready.",
  "download.comingSoon": "Coming soon",
  "download.playStore": "Google Play",
  "download.appStore": "App Store",
  "download.stepsTitle": "How to install the APK",
  "download.waitlistTitle": "Want a heads-up?",
  "download.waitlistSub":
    "Leave your email and we'll tell you the moment the iPhone and Play Store apps are ready.",
  "download.waitlistEmailPlaceholder": "you@example.com",
  "download.waitlistButton": "Notify me",
  "download.waitlistSending": "Sending…",
  "download.waitlistDone": "You're on the list — we'll be in touch.",
  "download.waitlistError": "Couldn't sign you up. Please try again.",
  "download.waitlistInvalid": "Enter a valid email address.",

  // Not found
  "notFound.kicker": "404",
  "notFound.title": "This page doesn't exist.",
  "notFound.body":
    "The link may be old or mistyped. If someone sent you an invite, ask them for a fresh link.",
  "notFound.back": "Back to Kaata",

  // Cookie / privacy notice
  "consent.body": "We use a few anonymous signals to understand how kaata.af is used.",
  "consent.reject": "No thanks",
  "consent.accept": "Okay",

  // Customer view (stub)
  "customer.kicker": "Coming soon",
  "customer.title": "Customer kaata view",
  "customer.body":
    "Shopkeepers will be able to send a link like this one and you'll see your full kaata — balance, every entry, every payment — without installing the app.",
  "customer.back": "← Back to Kaata",

  // Invite landing
  "invite.loading": "Loading invitation",
  "invite.kicker": "Invitation",
  "invite.error.unavailable.title": "This invitation isn't available",
  "invite.error.unavailable.body":
    "It may have expired, been revoked, or already been accepted. Ask the person who invited you to send a new link.",
  "invite.error.rateLimited.title": "Too many tries",
  "invite.error.rateLimited.body":
    "We've throttled this link for the moment. Wait {wait} and try again, or ask the inviter to send a fresh link.",
  "invite.error.rateLimited.minutes": "about {count} minutes",
  "invite.error.rateLimited.fallbackWait": "a few minutes",
  "invite.error.network.title": "Can't reach Kaata",
  "invite.error.network.body":
    "Check your connection and try again. If the problem persists, ask the inviter to resend.",
  "invite.error.server.title": "Something went wrong",
  "invite.error.server.body":
    "Try again in a minute. If it keeps failing, ask the inviter to resend.",
  "invite.tryAgain": "Try again",
  "invite.backHome": "Back to Kaata",
  "invite.youreInvited": "You're invited",
  "invite.join": "Join {name}",
  "invite.asRole": "as {role}",
  "invite.role.owner": "owner",
  "invite.role.editor": "editor",
  "invite.role.viewer": "viewer",
  "invite.invitedBy": "Invited by",
  "invite.email": "Email",
  "invite.expires": "Expires",
  "invite.expires.expired": "expired",
  "invite.expires.minutes": "in {count} min",
  "invite.expires.hours": "in {count} h",
  "invite.expires.days": "in {count} d",
  "invite.expires.soon": "soon",
  "invite.openInApp": "Open in Kaata",
  "invite.downloadFallback": "Don't have Kaata yet? Download",
  "invite.afterInstall": 'After installing, return to this page and tap "Open in Kaata".',
  "invite.desktopHint": "Open Kaata on your phone, then paste this code into Pending invitations:",
  "invite.codeLabel": "Invitation code",
  "invite.privacyNote.view":
    "Kaata never shows your ledger to anyone outside the people you invite. Accepting this invitation lets you view this shop's entries on your device.",
  "invite.privacyNote.edit":
    "Kaata never shows your ledger to anyone outside the people you invite. Accepting this invitation lets you edit this shop's entries on your device.",
};

const fa: Record<keyof typeof en, string> = {
  // Header / nav
  "nav.product": "امکانات",
  "nav.how": "طرز کار",
  "nav.download": "دانلود",
  "nav.getApp": "دریافت اپ",

  // Hero
  "hero.title.line1": "دکان خود را",
  "hero.title.line2": "با اعتماد بچرخانید.",
  "hero.sub":
    "یک کاتای آرام بین شما و کسانی که به آنها اعتماد دارید. ثبت کنید چه کسی به شما بدهکار است و شما به چه کسی، و با دو ضربه یادآوری دوستانه در واتساپ بفرستید.",
  "hero.cta": "دانلود برای اندروید",
  "hero.how": "ببینید چطور کار می‌کند ↓",
  "hero.points": "همیشه رایگان · بدون انترنت کار می‌کند · بدون حساب",

  // Feature sections
  "feature.offline.eyebrow": "ساخته‌شده برای بازار",
  "feature.offline.title": "حساب‌وکتابی آرام که بدون انترنت کار می‌کند.",
  "feature.offline.body":
    "کتاب کاتای شما روی تلفون خودتان می‌ماند. افراد را اضافه کنید و آنچه دادید و گرفتید را ثبت کنید — همه بدون انترنت. بدون حساب، بدون کلاد، بدون تنظیمات. داده‌های شما همان‌جا می‌ماند که باید باشد.",
  "feature.ping.eyebrow": "امکان اصلی",
  "feature.ping.title": "یادآوری، فقط با دو ضربه.",
  "feature.ping.body":
    "صفحهٔ شخص را باز کنید و پینگ را بزنید. کاتا واتساپ را با یک پیام مودبانه و آماده باز می‌کند — نام او، دکان شما و باقی‌ماندهٔ حساب. بدون کاپی‌پیست، بدون تایپ. فقط یک یادآوری دوستانه، در چند ثانیه.",

  // Final CTA
  "cta.title.line1": "دیگر دنبال",
  "cta.title.line2": "کاغذپاره‌ها نگردید.",
  "cta.sub": "همیشه رایگان. بدون حساب، بدون کارت، بدون تنظیمات.",
  "cta.button": "دانلود برای اندروید",

  // Footer
  "footer.tagline": "یک کاتای آرام بین شما و کسانی که به آنها اعتماد دارید. ساخته‌شده در کابل.",
  "footer.product": "محصول",
  "footer.download": "دانلود",
  "footer.how": "طرز کار",
  "footer.inside": "چه چیزی داخل آن است",
  "footer.company": "شرکت",
  "footer.contact": "تماس در واتساپ",
  "footer.openSource": "متن‌باز · به‌زودی",
  "footer.copyright": "© ۲۰۲۶ کاتا · ساخت کابل.",

  // Download page
  "download.title": "نصب کاتا",
  "download.sub": "همین حالا نسخهٔ اندروید را بگیرید — نسخهٔ آیفون و پلی‌ستور به‌زودی می‌آید.",
  "download.step1": "روی «دانلود APK» در بالا بزنید.",
  "download.step2": "فایل دانلودشده را باز کنید.",
  "download.step3":
    "اگر تلفون گفت از این منبع اجازهٔ نصب ندارد، روی «تنظیمات» بزنید، «اجازه از این منبع» را روشن کنید و برگردید.",
  "download.step4":
    "اگر گوگل پلی‌پروتکت هشدار داد، روی «جزئیات بیشتر» و بعد «به هر حال نصب شود» بزنید.",
  "download.step5": "روی نصب بزنید.",
  "download.button": "دانلود APK · نسخه {version}",
  "download.toast": "دانلود شروع شد — بعد از تکمیل نصب کنید.",
  "download.comingSoon": "به‌زودی",
  "download.playStore": "Google Play",
  "download.appStore": "App Store",
  "download.stepsTitle": "نحوهٔ نصب فایل APK",
  "download.waitlistTitle": "می‌خواهید باخبر شوید؟",
  "download.waitlistSub":
    "ایمیل‌تان را بگذارید تا همین که نسخهٔ آیفون و پلی‌ستور آماده شد، خبرتان کنیم.",
  "download.waitlistEmailPlaceholder": "you@example.com",
  "download.waitlistButton": "خبرم کن",
  "download.waitlistSending": "در حال ارسال…",
  "download.waitlistDone": "ثبت شد — به‌زودی در تماس می‌شویم.",
  "download.waitlistError": "ثبت نشد. دوباره تلاش کنید.",
  "download.waitlistInvalid": "یک ایمیل معتبر وارد کنید.",

  // Not found
  "notFound.kicker": "۴۰۴",
  "notFound.title": "این صفحه وجود ندارد.",
  "notFound.body":
    "شاید لینک قدیمی یا غلط نوشته شده باشد. اگر کسی برایتان دعوت‌نامه فرستاده، از او لینک تازه بخواهید.",
  "notFound.back": "برگشت به کاتا",

  // Cookie / privacy notice
  "consent.body": "از چند سیگنال ناشناس استفاده می‌کنیم تا بدانیم kaata.af چطور استفاده می‌شود.",
  "consent.reject": "نه تشکر",
  "consent.accept": "قبول",

  // Customer view (stub)
  "customer.kicker": "به‌زودی",
  "customer.title": "نمای کاتای مشتری",
  "customer.body":
    "دکان‌داران می‌توانند لینکی مثل همین را بفرستند و شما کاتای کامل خود را ببینید — باقی‌مانده، هر ثبت و هر پرداخت — بدون نصب اپ.",
  "customer.back": "← برگشت به کاتا",

  // Invite landing
  "invite.loading": "در حال بارگیری دعوت‌نامه",
  "invite.kicker": "دعوت‌نامه",
  "invite.error.unavailable.title": "این دعوت‌نامه در دسترس نیست",
  "invite.error.unavailable.body":
    "شاید منقضی شده، لغو شده یا قبلاً پذیرفته شده باشد. از کسی که شما را دعوت کرده لینک تازه بخواهید.",
  "invite.error.rateLimited.title": "تلاش‌های زیاد",
  "invite.error.rateLimited.body":
    "این لینک فعلاً محدود شده است. {wait} صبر کنید و دوباره امتحان کنید، یا از دعوت‌کننده لینک تازه بخواهید.",
  "invite.error.rateLimited.minutes": "حدود {count} دقیقه",
  "invite.error.rateLimited.fallbackWait": "چند دقیقه",
  "invite.error.network.title": "به کاتا دسترسی نیست",
  "invite.error.network.body":
    "اتصال خود را بررسی کنید و دوباره امتحان کنید. اگر مشکل ادامه داشت، از دعوت‌کننده بخواهید دوباره بفرستد.",
  "invite.error.server.title": "مشکلی پیش آمد",
  "invite.error.server.body":
    "یک دقیقه بعد دوباره امتحان کنید. اگر ادامه داشت، از دعوت‌کننده بخواهید دوباره بفرستد.",
  "invite.tryAgain": "دوباره امتحان کنید",
  "invite.backHome": "برگشت به کاتا",
  "invite.youreInvited": "شما دعوت شده‌اید",
  "invite.join": "به {name} بپیوندید",
  "invite.asRole": "به عنوان {role}",
  "invite.role.owner": "مالک",
  "invite.role.editor": "ویرایشگر",
  "invite.role.viewer": "بیننده",
  "invite.invitedBy": "دعوت از طرف",
  "invite.email": "ایمیل",
  "invite.expires": "انقضا",
  "invite.expires.expired": "منقضی شده",
  "invite.expires.minutes": "{count} دقیقه دیگر",
  "invite.expires.hours": "{count} ساعت دیگر",
  "invite.expires.days": "{count} روز دیگر",
  "invite.expires.soon": "به‌زودی",
  "invite.openInApp": "باز کردن در کاتا",
  "invite.downloadFallback": "هنوز کاتا ندارید؟ دانلود",
  "invite.afterInstall": "بعد از نصب، به همین صفحه برگردید و روی «باز کردن در کاتا» بزنید.",
  "invite.desktopHint":
    "کاتا را روی تلفون خود باز کنید و این کود را در «دعوت‌های در انتظار» وارد کنید:",
  "invite.codeLabel": "کود دعوت",
  "invite.privacyNote.view":
    "کاتا هرگز کاتای شما را به کسی بیرون از افراد دعوت‌شده نشان نمی‌دهد. با پذیرفتن این دعوت می‌توانید ثبت‌های این دکان را روی دستگاه خود ببینید.",
  "invite.privacyNote.edit":
    "کاتا هرگز کاتای شما را به کسی بیرون از افراد دعوت‌شده نشان نمی‌دهد. با پذیرفتن این دعوت می‌توانید ثبت‌های این دکان را روی دستگاه خود ویرایش کنید.",
};

const TABLES: Record<Lang, Record<string, string>> = { en, fa };

const PAGE_TITLES: Record<Lang, string> = {
  en: "Kaata — A quiet ledger between you and the people you trust.",
  fa: "کاتا — یک کاتای آرام بین شما و کسانی که به آنها اعتماد دارید.",
};

export type TKey = keyof typeof en;

function detectInitialLang(): Lang {
  try {
    const stored = window.localStorage.getItem(LANG_KEY);
    if (stored === "en" || stored === "fa") return stored;
  } catch {
    // localStorage unavailable — fall through to browser detection
  }
  const langs =
    typeof navigator !== "undefined" ? (navigator.languages ?? [navigator.language]) : [];
  for (const l of langs) {
    const lower = (l ?? "").toLowerCase();
    // prs = Dari's own BCP-47 tag; fa covers Iranian Persian keyboards/locales.
    if (lower.startsWith("fa") || lower.startsWith("prs")) return "fa";
  }
  return "en";
}

type I18nValue = {
  lang: Lang;
  setLang: (lang: Lang) => void;
  isRTL: boolean;
  t: (key: TKey, vars?: Record<string, string | number>) => string;
};

const I18nContext = createContext<I18nValue | null>(null);

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(detectInitialLang);

  // Keep the document element in sync so native form controls, text
  // alignment defaults, scrollbars and the title all follow the language.
  useEffect(() => {
    document.documentElement.lang = lang;
    document.documentElement.dir = lang === "fa" ? "rtl" : "ltr";
    document.title = PAGE_TITLES[lang];
  }, [lang]);

  const setLang = useCallback((next: Lang) => {
    try {
      window.localStorage.setItem(LANG_KEY, next);
    } catch {
      // per-session only
    }
    setLangState(next);
  }, []);

  const value = useMemo<I18nValue>(
    () => ({
      lang,
      setLang,
      isRTL: lang === "fa",
      t: (key, vars) => {
        let s = TABLES[lang][key] ?? en[key] ?? key;
        if (vars) {
          for (const [k, v] of Object.entries(vars)) {
            s = s.replaceAll(`{${k}}`, String(v));
          }
        }
        return s;
      },
    }),
    [lang, setLang],
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nValue {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error("useI18n must be used inside <I18nProvider>");
  return ctx;
}
