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
  // Brand wordmark — Latin in English, Dari script in Persian. Mirrors the
  // mobile app's brand.wordmark key and the door-to-door flyer.
  "brand.wordmark": "kaata.",

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
  "hero.cta": "Download Kaata",
  "hero.how": "See how it works ↓",
  "hero.points": "Free forever · Works without internet · No sign-up needed",

  // Feature sections
  "feature.offline.eyebrow": "Built for the bazaar",
  "feature.offline.title": "A quiet tally that works offline.",
  "feature.offline.body":
    "Your kaata book lives on your phone. Add people, record what you gave and what you received — in the shop, on the road, with no signal at all. No sign-up, no setup. Open the app and start writing.",
  "feature.ping.eyebrow": "The killer feature",
  "feature.ping.title": "A reminder, two taps away.",
  "feature.ping.body":
    "Open a person, tap Ping. Kaata opens WhatsApp with a polite, pre-filled message — their name, your shop, their balance, and a private link where they can see their full kaata without installing anything. No copy-paste, no awkward typing. A friendly nudge, sent in seconds.",
  "feature.backup.eyebrow": "Never lose the book",
  "feature.backup.title": "Phones get lost. Your kaata comes back.",
  "feature.backup.body":
    "A broken or stolen phone used to take the whole book with it — every name, every amount people owed you. Sign in with Google or Apple and Kaata quietly keeps a backup. On a new phone, sign in and everything returns: every person, every entry, every balance.",

  // Final CTA
  "cta.title.line1": "Stop chasing slips",
  "cta.title.line2": "of paper.",
  "cta.sub": "Free forever. No card, no fees, no setup.",
  "cta.button": "Download Kaata",

  // Footer
  "footer.tagline": "A quiet ledger between you and the people you trust. Built in Kabul.",
  "footer.product": "Product",
  "footer.download": "Download",
  "footer.how": "How it works",
  "footer.inside": "What's inside",
  "footer.company": "Company",
  "footer.contact": "Contact on WhatsApp",
  "footer.privacy": "Privacy",
  "footer.terms": "Terms",
  "footer.deleteAccount": "Delete account",
  "footer.followFacebook": "Follow Kaata on Facebook",
  "footer.followInstagram": "Follow Kaata on Instagram",
  "footer.copyright": "© 2026 Kaata · Made in Kabul.",

  // Download page — store badges only (the sideload APK flow retired when
  // Google Play went live).
  "download.title": "Install Kaata",
  "download.sub": "Get Kaata on Google Play for Android, or on the App Store for iPhone.",
  "download.appStoreButton": "Download on the App Store",
  "download.playStoreButton": "Get it on Google Play",

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

  // --- Landing-page phone mockups ---
  // These first keys are copied VERBATIM from apps/mobile/lib/i18n.ts so the
  // depicted WhatsApp message + home screen read EXACTLY like the real app.
  // KEEP IN SYNC if the mobile share.* / home.* / format.* strings change.
  "share.greeting": "Salaam {name}.",
  "share.theyOwe.header": "Your kaata at {accountWith}:",
  "share.theyOwe.amount": "🔴 You owe: −{amount} {currency}",
  "share.theyOwe.cta": "Please settle when you can.",
  "share.footer": "— Sent via Kaata.af",
  "home.tab.collect": "To collect",
  "home.tab.pay": "To pay",
  "home.total.label.collect": "To collect",
  "home.from.many": "from {count} people",
  "format.yesterday": "yesterday",
  "format.daysAgo": "{n}d ago",
  "format.weeksAgo": "{n}w ago",
  // Illustrative sample data + marketing captions (web-only, not in the app).
  "mock.self.name": "Sultan",
  "mock.self.shop": "Shop Sultan",
  "mock.name.mahmood": "Mahmood",
  "mock.name.ahmad": "Ahmad",
  "mock.name.sultan": "Sultan",
  "mock.name.wahid": "Wahid",
  "mock.offline": "Offline",
  "mock.entrySaved.title": "New entry saved.",
  "mock.entrySaved.sub": "On this device. No internet needed.",
  "mock.restored.title": "Kaata restored.",
  "mock.restored.sub": "4 people · 132 entries · every balance, back on this phone.",
  "mock.whatsapp.reply": "Thanks, will pay tomorrow inshaAllah.",
  "mock.whatsapp.messagePlaceholder": "Message",
};

const fa: Record<keyof typeof en, string> = {
  // Header / nav
  "brand.wordmark": "کاتا.",

  "nav.product": "امکانات",
  "nav.how": "طرز کار",
  "nav.download": "دانلود",
  "nav.getApp": "دریافت اپ",

  // Hero
  "hero.title.line1": "دکان خود را",
  "hero.title.line2": "با اعتماد بچرخانید.",
  "hero.sub":
    "یک کاتای آرام بین شما و کسانی که به آنها اعتماد دارید. ثبت کنید چه کسی به شما بدهکار است و شما به چه کسی، و با دو ضربه یادآوری دوستانه در واتساپ بفرستید.",
  "hero.cta": "دانلود کاتا",
  "hero.how": "ببینید چطور کار می‌کند ↓",
  "hero.points": "همیشه رایگان · بدون انترنت کار می‌کند · بدون ثبت‌نام",

  // Feature sections
  "feature.offline.eyebrow": "ساخته‌شده برای بازار",
  "feature.offline.title": "حساب‌وکتابی آرام که بدون انترنت کار می‌کند.",
  "feature.offline.body":
    "کتاب کاتای شما روی تلفون خودتان می‌ماند. افراد را اضافه کنید و آنچه دادید و گرفتید را ثبت کنید — در دکان، در راه، حتی بدون یک خط انترنت. بدون ثبت‌نام، بدون تنظیمات. اپ را باز کنید و شروع به نوشتن کنید.",
  "feature.ping.eyebrow": "امکان اصلی",
  "feature.ping.title": "یادآوری، فقط با دو ضربه.",
  "feature.ping.body":
    "صفحهٔ شخص را باز کنید و پینگ را بزنید. کاتا واتساپ را با یک پیام مودبانه و آماده باز می‌کند — نام او، دکان شما، باقی‌ماندهٔ حساب و یک لینک خصوصی که کاتای کامل خود را بدون نصب چیزی ببیند. بدون کاپی‌پیست، بدون تایپ. یک یادآوری دوستانه، در چند ثانیه.",
  "feature.backup.eyebrow": "کتاب هرگز گم نمی‌شود",
  "feature.backup.title": "تلفون گم می‌شود. کاتای شما برمی‌گردد.",
  "feature.backup.body":
    "پیش‌تر، شکستن یا گم شدن تلفون یعنی از بین رفتن تمام کتاب — هر نام و هر مبلغی که مردم به شما بدهکار بودند. با گوگل یا اپل وارد شوید تا کاتا بی‌سروصدا نسخهٔ پشتیبان نگه دارد. روی تلفون نو وارد شوید و همه‌چیز برمی‌گردد: هر شخص، هر ثبت و هر باقی‌مانده.",

  // Final CTA
  "cta.title.line1": "دیگر دنبال",
  "cta.title.line2": "کاغذپاره‌ها نگردید.",
  "cta.sub": "همیشه رایگان. بدون کارت، بدون فیس، بدون تنظیمات.",
  "cta.button": "دانلود کاتا",

  // Footer
  "footer.tagline": "یک کاتای آرام بین شما و کسانی که به آنها اعتماد دارید. ساخته‌شده در کابل.",
  "footer.product": "محصول",
  "footer.download": "دانلود",
  "footer.how": "طرز کار",
  "footer.inside": "چه چیزی داخل آن است",
  "footer.company": "شرکت",
  "footer.contact": "تماس در واتساپ",
  "footer.privacy": "حریم خصوصی",
  "footer.terms": "شرایط استفاده",
  "footer.deleteAccount": "حذف حساب",
  "footer.followFacebook": "کاتا را در فیسبوک دنبال کنید",
  "footer.followInstagram": "کاتا را در اینستاگرام دنبال کنید",
  "footer.copyright": "© ۲۰۲۶ کاتا · ساخت کابل.",

  // Download page — store badges only.
  "download.title": "نصب کاتا",
  "download.sub": "کاتا را برای اندروید از Google Play و برای آیفون از App Store بگیرید.",
  "download.appStoreButton": "دانلود از App Store",
  "download.playStoreButton": "دریافت از Google Play",

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

  // --- Landing-page phone mockups (mirror of apps/mobile/lib/i18n.ts) ---
  "share.greeting": "سلام {name}.",
  "share.theyOwe.header": "کاتای شما با {accountWith}:",
  "share.theyOwe.amount": "🔴 قرض شما: −{amount} {currency}",
  "share.theyOwe.cta": "لطفاً وقتی توانستید تصفیه کنید.",
  "share.footer": "پیام از طرف kaata.af",
  "home.tab.collect": "وصول",
  "home.tab.pay": "پرداخت",
  "home.total.label.collect": "قابل وصول",
  "home.from.many": "از {count} نفر",
  "format.yesterday": "دیروز",
  "format.daysAgo": "{n} روز پیش",
  "format.weeksAgo": "{n} هفته پیش",
  "mock.self.name": "سلطان",
  "mock.self.shop": "دکان سلطان",
  "mock.name.mahmood": "محمود",
  "mock.name.ahmad": "احمد",
  "mock.name.sultan": "سلطان",
  "mock.name.wahid": "وحید",
  "mock.offline": "آفلاین",
  "mock.entrySaved.title": "ثبت جدید ذخیره شد.",
  "mock.entrySaved.sub": "روی همین دستگاه. بدون انترنت.",
  "mock.restored.title": "کاتا بازیابی شد.",
  "mock.restored.sub": "۴ نفر · ۱۳۲ ثبت · هر باقی‌مانده، دوباره روی همین تلفون.",
  "mock.whatsapp.reply": "تشکر، فردا انشاالله پرداخت می‌کنم.",
  "mock.whatsapp.messagePlaceholder": "پیام",
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
