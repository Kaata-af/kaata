import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { detectLanguage, isRtlLanguage, type Lang } from "./language";
export type { Lang } from "./language";

// Tiny home-rolled i18n for the funnel site, mirroring the mobile app's
// approach (lib/i18n.ts there): three flat string tables with identical keys,
// no framework. Persian follows the same Afghan-Dari vocabulary rules as
// mobile — تلفون not تلفن, دکان not مغازه, کاتا for the product.
//
// Language resolution: localStorage("kaata_lang") → browser language
// (ps → ps; fa/prs → fa) → en. The choice persists; the <html> element's lang/dir
// follow the active language so the whole page flips to RTL for Dari and Pashto.

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
  "nav.downloadApp": "Download the app",
  "nav.web": "Kaata Web",

  // Hero
  "hero.title.line1": "Run your shop",
  "hero.title.line2": "on trust.",
  "hero.sub":
    "Track what you gave and received. Share accounts with people you trust, follow updates in Kaata, and send reminders over WhatsApp.",
  "hero.cta": "Download Kaata",
  "hero.how": "See how it works ↓",
  "hero.points": "Free forever · Private tallies work offline · Start without sign-up",

  // Feature sections
  "feature.offline.eyebrow": "Built for the bazaar",
  "feature.offline.title": "A personal tally that works offline.",
  "feature.offline.body":
    "Your kaata book lives on your phone. Add people, record what you gave and what you received — in the shop, on the road, with no signal at all. No sign-up, no setup. Open the app and start writing.",
  "feature.shared.eyebrow": "Shared tallies",
  "feature.shared.title": "One account. A clear record for both.",
  "feature.shared.body":
    "Sign in and invite the other person to a shared account. Both of you can follow its tallies and balance from your own phones.",
  "feature.shared.point1": "Choose who can add tallies, or require approval for each tally.",
  "feature.shared.point2": "In approval mode, see what's pending and what's confirmed.",
  "feature.shared.point3": "Keep each currency's balance separate.",
  "feature.notifications.eyebrow": "In-app notifications",
  "feature.notifications.title": "Know when the account changes.",
  "feature.notifications.body":
    "Your in-app inbox keeps new tallies and review decisions together. Open a tally update to go straight to that entry and see its details.",
  "feature.notifications.point1": "Spot unread updates in one place.",
  "feature.notifications.point2": "Go from an update to the exact tally.",
  "feature.notifications.point3": "Set quiet hours and previews; adjust alerts for each contact.",
  "feature.bills.eyebrow": "Bills and statements",
  "feature.bills.title": "A clear bill. Ready to send.",
  "feature.bills.body":
    "Send a PDF with the entries and remaining balance, or share a bill link over WhatsApp. The link opens in a browser, with no app to install.",
  "feature.bills.point1": "Dates, notes and given/received amounts in one statement.",
  "feature.bills.point2": "Save or share PDF and CSV files.",
  "feature.bills.point3": "Bill links preserve a dated copy of the account.",
  "feature.ping.eyebrow": "WhatsApp reminders",
  "feature.ping.title": "A reminder, two taps away.",
  "feature.ping.body":
    "Open a person and tap the WhatsApp button at the top. Kaata opens WhatsApp with a polite, pre-filled message — their name, your shop, their balance, and a private link where they can see their full kaata without installing anything. No copy-paste, no awkward typing. A friendly nudge, sent in seconds.",
  "feature.backup.eyebrow": "Never lose the book",
  "feature.backup.title": "Phones get lost. Your kaata comes back.",
  "feature.backup.body":
    "A broken or stolen phone used to take the whole book with it — every name, every amount people owed you. Sign in with Google or Apple and Kaata automatically keeps a backup. On a new phone, sign in and everything returns: every person, every entry, every balance.",

  "extras.eyebrow": "For your everyday accounts",
  "extras.title": "More ways to keep your book in order.",
  "extras.currencies.title": "Each currency, its own balance.",
  "extras.currencies.body":
    "Keep AFN, USD and other currencies side by side without mixing their totals.",
  "extras.search.title": "Find the entry you need.",
  "extras.search.body": "Search notes or exact amounts, and narrow tallies by date.",
  "extras.reminders.title": "Remember when to follow up.",
  "extras.reminders.body":
    "Set a date to follow up with someone and keep due reminders together in Kaata.",
  "extras.lock.title": "App lock when you need it.",
  "extras.lock.body": "Use an optional app lock to keep your ledger private on your phone.",

  // Final CTA
  "cta.title.line1": "Stop chasing slips",
  "cta.title.line2": "of paper.",
  "cta.sub": "Free forever. No card, no fees, no setup.",
  "cta.button": "Download Kaata",

  // Footer
  "footer.tagline": "A personal ledger between you and the people you trust. Built in Kabul.",
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
  "footer.followTiktok": "Follow Kaata on TikTok",
  "footer.followYoutube": "Follow Kaata on YouTube",
  "footer.copyright": "© 2026 Kaata · Made in Kabul.",

  // Download page — official store badges.
  "download.title": "Install Kaata",
  "download.sub": "Get Kaata on Google Play for Android, or on the App Store for iPhone.",
  "download.appStoreButton": "Download on the App Store",
  "download.playStoreButton": "Get it on Google Play",
  "download.demo.title": "How to use Kaata",
  "download.demo.youtube": "Watch on YouTube",

  // Not found
  "notFound.kicker": "404",
  "notFound.title": "This page doesn't exist.",
  "notFound.body":
    "The link may be old or mistyped. If someone sent you an invite, ask them for a fresh link.",
  "notFound.back": "Back to Kaata",

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
  "invite.takeOwnership": "Take ownership of {name}",
  "invite.privacyNote.ownership":
    "Accept in the updated Kaata app using the email the owner invited. You will become the owner and they will stay as an Editor. Opening this page alone does not transfer ownership.",
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
  "share.footer": "— Sent via www.kaata.af",
  "home.tab.collect": "To collect",
  "home.tab.pay": "To pay",
  "home.total.label.collect": "To collect",
  "home.from.many": "from {count} people",
  "customers.search": "Search customers",
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
  "mock.preview.label": "Kaata app preview with fictional demo customers",
  "mock.shared.preview.label": "Kaata shared-account preview with fictional tallies",
  "mock.shared.acceptedAt": "1 Nov 2026 · 10:23 AM",
  "mock.notifications.preview.label": "Kaata notifications preview with fictional account updates",
  "tab.join.title": "Shared account",
  "tab.balance.confirmed": "Confirmed shared balance: {amount} {currency}",
  "tab.balance.pending": "{count} pending · net change {amount} {currency}",
  "tab.status.pending": "Pending",
  "tab.status.accepted": "Accepted",
  "tab.accept": "Accept",
  "tab.reject": "Reject",
  "tab.addedBy": "Added by {name}",
  "tab.reviewedBy": "Reviewed by {name}",
  "entry.by.self": "{name} (you)",
  "inbox.title": "Notifications",
  "inbox.markAll": "Mark all read",
  "format.minutesAgo": "{n}m ago",
  "format.justNow": "just now",
  "mock.notification.added": "{name} added a tally ({amount}). Accept or reject it.",
  "mock.notification.accepted": "Your tally ({amount}) was accepted by {name}.",
  "mock.notification.voided": "{name} voided a tally ({amount}).",
  "mock.bill.send.caption": "Send a statement",
  "mock.bill.receive.caption": "What the customer sees",
  "mock.bill.send.preview.label": "Kaata statement export options with fictional account data",
  "mock.bill.receive.preview.label": "Dated Kaata bill with fictional entries and balance",
  "mock.bill.dated": "Bill dated {date}",
  "mock.bill.owes": "owes",
  "mock.bill.transactions": "Transactions",
  "personEdit.export": "Export statement",
  "export.action.sharePdf": "Share as PDF",
  "export.action.shareCsv": "Share as CSV",
  "export.action.savePdf": "Save PDF to phone",
  "export.action.saveCsv": "Save CSV to phone",
  "mock.balance.title": "Balances",
  "mock.balance.pay": "To pay",
  "person.search.placeholder": "Search notes or amounts",
  "person.date.title": "Filter by date",
  "person.flows.received": "I received ({count})",
  "person.flows.gave": "I gave ({count})",
  "mock.owesYou": "Owes you",
  "mock.gave": "I gave",
  "mock.received": "I received",
  "mock.today": "today",
  "mock.payment": "Payment",
  "mock.supplies": "Store supplies",
  "mock.goods": "Rice and oil",
  "mock.entrySaved.title": "Entry saved",
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
  "nav.downloadApp": "دانلود اپ",
  "nav.web": "کاتای وب",

  // Hero
  "hero.title.line1": "دکان خود را",
  "hero.title.line2": "با اعتماد بچرخانید.",
  "hero.sub":
    "آنچه دادید و گرفتید را ثبت کنید. با کسانی که به آنها اعتماد دارید حساب مشترک داشته باشید، تغییرات را در کاتا دنبال کنید و در واتساپ یادآوری بفرستید.",
  "hero.cta": "دانلود کاتا",
  "hero.how": "ببینید چطور کار می‌کند ↓",
  "hero.points": "همیشه رایگان · ثبت‌های شخصی بدون انترنت · شروع بدون ثبت‌نام",

  // Feature sections
  "feature.offline.eyebrow": "ساخته‌شده برای بازار",
  "feature.offline.title": "حساب‌وکتابی شخصی که بدون انترنت کار می‌کند.",
  "feature.offline.body":
    "کتاب کاتای شما روی تلفون خودتان می‌ماند. افراد را اضافه کنید و آنچه دادید و گرفتید را ثبت کنید — در دکان، در راه، حتی بدون یک خط انترنت. بدون ثبت‌نام، بدون تنظیمات. اپ را باز کنید و شروع به نوشتن کنید.",
  "feature.shared.eyebrow": "حساب‌های مشترک",
  "feature.shared.title": "یک حساب؛ روشن برای هر دو.",
  "feature.shared.body":
    "وارد کاتا شوید و شخص مقابل را به یک حساب مشترک دعوت کنید. هر دوی شما ثبت‌ها و باقی‌ماندهٔ حساب را روی تلفون خود می‌بینید.",
  "feature.shared.point1": "انتخاب کنید چه کسی ثبت کند، یا برای هر ثبت تأیید بخواهید.",
  "feature.shared.point2": "در حالت تأیید، ثبت‌های در انتظار و تأییدشده را جدا ببینید.",
  "feature.shared.point3": "باقی‌ماندهٔ هر واحد پول جدا می‌ماند.",
  "feature.notifications.eyebrow": "اعلان‌های داخل اپ",
  "feature.notifications.title": "از تغییرات حساب خبر بمانید.",
  "feature.notifications.body":
    "ثبت‌های تازه و نتیجهٔ بررسی‌ها را در بخش اعلان‌های کاتا یک‌جا دنبال کنید. روی اعلان یک ثبت بزنید تا مستقیم همان ثبت را با جزئیاتش ببینید.",
  "feature.notifications.point1": "اعلان‌های ناخوانده را یک‌جا ببینید.",
  "feature.notifications.point2": "از اعلان، مستقیم به ثبت مربوط بروید.",
  "feature.notifications.point3":
    "ساعت‌های سکوت و جزئیات اعلان را انتخاب کنید؛ اعلان‌های هر شخص را تنظیم کنید.",
  "feature.bills.eyebrow": "بل و صورت‌حساب",
  "feature.bills.title": "بل روشن، آمادهٔ فرستادن.",
  "feature.bills.body":
    "ثبت‌ها و باقی‌ماندهٔ حساب را به شکل PDF بفرستید، یا لینک بل را در واتساپ شریک کنید. شخص مقابل می‌تواند لینک را در مرورگر و بدون نصب کاتا باز کند.",
  "feature.bills.point1": "تاریخ‌ها، یادداشت‌ها و مبلغ‌های «دادم» و «گرفتم» در یک صورت‌حساب.",
  "feature.bills.point2": "فایل‌های PDF و CSV را ذخیره کنید یا بفرستید.",
  "feature.bills.point3": "لینک بل یک نسخهٔ تاریخ‌دار از حساب را نگه می‌دارد.",
  "feature.ping.eyebrow": "یادآوری در واتساپ",
  "feature.ping.title": "یادآوری، فقط با دو ضربه.",
  "feature.ping.body":
    "صفحهٔ شخص را باز کنید و دکمهٔ واتساپ را در بالای صفحه بزنید. کاتا واتساپ را با یک پیام مودبانه و آماده باز می‌کند — نام او، دکان شما، باقی‌ماندهٔ حساب و یک لینک خصوصی که کاتای کامل خود را بدون نصب چیزی ببیند. بدون کاپی‌پیست، بدون تایپ. یک یادآوری دوستانه، در چند ثانیه.",
  "feature.backup.eyebrow": "کتاب هرگز گم نمی‌شود",
  "feature.backup.title": "تلفون گم می‌شود. کاتای شما برمی‌گردد.",
  "feature.backup.body":
    "پیش‌تر، شکستن یا گم شدن تلفون یعنی از بین رفتن تمام کتاب — هر نام و هر مبلغی که مردم از شما قرضدار بودند. با گوگل یا اپل وارد شوید تا کاتا به‌صورت خودکار نسخهٔ پشتیبان نگه دارد. روی تلفون نو وارد شوید و همه‌چیز برمی‌گردد: هر شخص، هر ثبت و هر باقی‌مانده.",

  "extras.eyebrow": "برای حساب‌وکتاب هر روز",
  "extras.title": "امکانات بیشتر برای حساب‌وکتاب روزانه.",
  "extras.currencies.title": "هر واحد پول، حساب جدا.",
  "extras.currencies.body":
    "حساب افغانی، دالر و ارزهای دیگر را نگه دارید؛ باقی‌ماندهٔ هر کدام جدا می‌ماند.",
  "extras.search.title": "ثبت مورد نیاز را پیدا کنید.",
  "extras.search.body": "یادداشت یا مبلغ مشخص را جستجو کنید و ثبت‌ها را بر اساس تاریخ محدود کنید.",
  "extras.reminders.title": "پیگیری حساب را فراموش نکنید.",
  "extras.reminders.body":
    "برای پیگیری حساب یک شخص تاریخ تعیین کنید و یادآوری‌های سررسیده را در کاتا یک‌جا ببینید.",
  "extras.lock.title": "قفل اپ، هر وقت لازم بود.",
  "extras.lock.body": "قفل اختیاری اپ را روشن کنید تا حساب‌وکتاب شما روی تلفون محفوظ بماند.",

  // Final CTA
  "cta.title.line1": "دیگر دنبال",
  "cta.title.line2": "کاغذپاره‌ها نگردید.",
  "cta.sub": "همیشه رایگان. بدون کارت، بدون فیس، بدون تنظیمات.",
  "cta.button": "دانلود کاتا",

  // Footer
  "footer.tagline": "یک کاتای شخصی بین شما و کسانی که به آنها اعتماد دارید. ساخته‌شده در کابل.",
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
  "footer.followTiktok": "کاتا را در تیک‌تاک دنبال کنید",
  "footer.followYoutube": "کاتا را در یوتیوب دنبال کنید",
  "footer.copyright": "© ۲۰۲۶ کاتا · ساخت کابل.",

  // Download page — store badges and video guide.
  "download.title": "نصب کاتا",
  "download.sub": "کاتا را برای اندروید از Google Play و برای آیفون از App Store بگیرید.",
  "download.appStoreButton": "دانلود از App Store",
  "download.playStoreButton": "دریافت از Google Play",
  "download.demo.title": "طرز استفاده از کاتا",
  "download.demo.youtube": "تماشا در یوتیوب",

  // Not found
  "notFound.kicker": "۴۰۴",
  "notFound.title": "این صفحه وجود ندارد.",
  "notFound.body":
    "شاید لینک قدیمی یا غلط نوشته شده باشد. اگر کسی برایتان دعوت‌نامه فرستاده، از او لینک تازه بخواهید.",
  "notFound.back": "برگشت به کاتا",

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
  "invite.takeOwnership": "مالکیت {name} را بگیرید",
  "invite.privacyNote.ownership":
    "در نسخهٔ تازهٔ کاتا، با ایمیلی که مالک دعوت کرده است وارد شوید و دعوت را بپذیرید. شما مالک می‌شوید و او به عنوان ویرایشگر می‌ماند. تنها باز کردن این صفحه مالکیت را انتقال نمی‌دهد.",
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
  "share.footer": "پیام از طرف www.kaata.af",
  "home.tab.collect": "وصول",
  "home.tab.pay": "پرداخت",
  "home.total.label.collect": "قابل وصول",
  "home.from.many": "از {count} نفر",
  "customers.search": "جستجوی مشتری‌ها",
  "format.yesterday": "دیروز",
  "format.daysAgo": "{n} روز پیش",
  "format.weeksAgo": "{n} هفته پیش",
  "mock.self.name": "سلطان",
  "mock.self.shop": "دکان سلطان",
  "mock.name.mahmood": "محمود",
  "mock.name.ahmad": "احمد",
  "mock.name.sultan": "سلطان",
  "mock.name.wahid": "وحید",
  "mock.preview.label": "پیش‌نمایش کاتا با مشتری‌های نمونه و خیالی",
  "mock.shared.preview.label": "پیش‌نمایش حساب مشترک کاتا با ثبت‌های نمونه و خیالی",
  "mock.shared.acceptedAt": "۱۰ عقرب ۱۴۰۵، ۱۰:۲۳ ق.ظ",
  "mock.notifications.preview.label": "پیش‌نمایش اعلان‌های کاتا با تغییرات نمونه و خیالی حساب",
  "tab.join.title": "حساب مشترک",
  "tab.balance.confirmed": "ماندهٔ تأییدشدهٔ مشترک: {amount} {currency}",
  "tab.balance.pending": "{count} در انتظار · تغییر خالص {amount} {currency}",
  "tab.status.pending": "در انتظار",
  "tab.status.accepted": "پذیرفته شده",
  "tab.accept": "تأیید",
  "tab.reject": "رد کردن",
  "tab.addedBy": "ثبت‌شده توسط {name}",
  "tab.reviewedBy": "بررسی‌کننده: {name}",
  "entry.by.self": "{name} (شما)",
  "inbox.title": "اعلان‌ها",
  "inbox.markAll": "همه خوانده شد",
  "format.minutesAgo": "{n} دقیقه پیش",
  "format.justNow": "همین حالا",
  "mock.notification.added": "{name} یک ثبت {amount} افزود. قبول یا رد کنید.",
  "mock.notification.accepted": "ثبت {amount} شما توسط {name} قبول شد.",
  "mock.notification.voided": "ثبت {amount} توسط {name} لغو شد.",
  "mock.bill.send.caption": "فرستادن صورت‌حساب",
  "mock.bill.receive.caption": "آنچه مشتری می‌بیند",
  "mock.bill.send.preview.label": "گزینه‌های فرستادن صورت‌حساب کاتا با حساب نمونه و خیالی",
  "mock.bill.receive.preview.label": "بل تاریخ‌دار کاتا با ثبت‌ها و باقی‌ماندهٔ نمونه و خیالی",
  "mock.bill.dated": "بل مورخ {date}",
  "mock.bill.owes": "قرضدار است",
  "mock.bill.transactions": "معاملات",
  "personEdit.export": "صورت حساب",
  "export.action.sharePdf": "ارسال به شکل PDF",
  "export.action.shareCsv": "ارسال به شکل CSV",
  "export.action.savePdf": "ذخیرهٔ PDF در تلفون",
  "export.action.saveCsv": "ذخیرهٔ CSV در تلفون",
  "mock.balance.title": "مجموع حساب‌ها",
  "mock.balance.pay": "قابل پرداخت",
  "person.search.placeholder": "جستجو: یادداشت یا مقدار",
  "person.date.title": "فیلتر بر اساس تاریخ",
  "person.flows.received": "گرفتم ({count})",
  "person.flows.gave": "دادم ({count})",
  "mock.owesYou": "از شما قرضدار",
  "mock.gave": "دادم",
  "mock.received": "گرفتم",
  "mock.today": "امروز",
  "mock.payment": "پرداخت",
  "mock.supplies": "جنس دکان",
  "mock.goods": "برنج و روغن",
  "mock.entrySaved.title": "ثبت شد",
  "mock.restored.title": "کاتا بازیابی شد.",
  "mock.restored.sub": "۴ نفر · ۱۳۲ ثبت · هر باقی‌مانده، دوباره روی همین تلفون.",
  "mock.whatsapp.reply": "تشکر، فردا انشاالله پرداخت می‌کنم.",
  "mock.whatsapp.messagePlaceholder": "پیام",
};

const ps: Record<keyof typeof en, string> = {
  "brand.wordmark": "کاټه.",
  "nav.product": "کاټه",
  "nav.how": "څنګه کار کوي",
  "nav.download": "ښکته کول",
  "nav.getApp": "اپ ترلاسه کړئ",
  "nav.downloadApp": "اپ ښکته کړئ",
  "nav.web": "کاتا وېب",
  "hero.title.line1": "خپل دوکان وچلوئ",
  "hero.title.line2": "په باور.",
  "hero.sub":
    "هغه څه ثبت کړئ چې مو ورکړي او ترلاسه کړي دي. له باوري خلکو سره ګډ حسابونه ولرئ، په کاټه کې بدلونونه تعقیب کړئ او د WhatsApp له لارې یادونې ولېږئ.",
  "hero.cta": "کاټه ښکته کړئ",
  "hero.how": "وګورئ چې څنګه کار کوي ↓",
  "hero.points": "تل وړیا · شخصي راکړې ورکړې بې انټرنېټه · له نوم لیکنې پرته پیل",
  "feature.offline.eyebrow": "د بازار لپاره جوړه شوې",
  "feature.offline.title": "یوه شخصي کاټه چې بې انټرنېټه هم کار کوي.",
  "feature.offline.body":
    "ستاسو د کاټې کتاب ستاسو په ټیلیفون کې دی. خلک ورزیات کړئ، هغه څه ولیکئ چې مو ورکړي او ترلاسه کړي دي — په دوکان کې، په لاره کې، حتی چې هېڅ شبکه هم نه وي. نوم لیکنې او تنظیم ته اړتیا نشته. اپ خلاص کړئ او لیکل پیل کړئ.",
  "feature.shared.eyebrow": "ګډ حسابونه",
  "feature.shared.title": "یو ګډ حساب، دواړو ته روښانه.",
  "feature.shared.body":
    "کاټې ته ننوځئ او بل کس ګډ حساب ته راوبلئ. دواړه کولی شئ په خپلو ټیلیفونونو کې راکړې ورکړې او پاتې حساب وګورئ.",
  "feature.shared.point1": "وټاکئ چې څوک ثبت کولی شي، یا د هرې راکړې ورکړې لپاره تایید وغواړئ.",
  "feature.shared.point2": "د تایید په حالت کې، په تمه او تایید شوې راکړې ورکړې جلا وګورئ.",
  "feature.shared.point3": "د پیسو د هر واحد پاتې حساب جلا وساتئ.",
  "feature.notifications.eyebrow": "د اپ دننه خبرتیاوې",
  "feature.notifications.title": "د حساب له بدلونونو خبر اوسئ.",
  "feature.notifications.body":
    "نوې راکړې ورکړې او د بیاکتنو پایلې د کاټې په خبرتیاوو کې یوځای وګورئ. د یوې راکړې ورکړې پر خبرتیا ټک وکړئ او هماغه ثبت له جزیاتو سره پرانیزئ.",
  "feature.notifications.point1": "نالوستې خبرتیاوې په یوه ځای کې ووینئ.",
  "feature.notifications.point2": "له خبرتیا څخه اړوندې راکړې ورکړې ته ورشئ.",
  "feature.notifications.point3":
    "د چوپتیا ساعتونه او د خبرتیا جزیات وټاکئ؛ د هر کس خبرتیاوې تنظیم کړئ.",
  "feature.bills.eyebrow": "بلونه او د حساب پاڼې",
  "feature.bills.title": "روښانه بل، لېږلو ته چمتو.",
  "feature.bills.body":
    "راکړې ورکړې او پاتې حساب د PDF په بڼه ولېږئ، یا د WhatsApp له لارې د بل لینک شریک کړئ. بل کس کولی شي لینک په خپل براوزر کې د کاټې له نصبولو پرته پرانیزي.",
  "feature.bills.point1": "نېټې، یادښتونه او د ورکړل شویو او ترلاسه شویو پیسو مبلغونه یوځای.",
  "feature.bills.point2": "د PDF او CSV فایلونه خوندي یا شریک کړئ.",
  "feature.bills.point3": "د بل لینک د حساب یوه نېټه لرونکې نسخه ساتي.",
  "feature.ping.eyebrow": "د WhatsApp یادونې",
  "feature.ping.title": "یوه یادونه، په دوو ټکونو.",
  "feature.ping.body":
    "د یوه کس حساب خلاص کړئ او په سر کې د WhatsApp تڼۍ ووهئ. کاټه WhatsApp له یوه مؤدب او چمتو پیغام سره خلاصوي — د هغه کس نوم، ستاسو دوکان، پاتې حساب او یو شخصي لینک چې پکې خپله ټوله کاټه د اپ له نصبولو پرته لیدلی شي. کاپي او پیسټ یا د پیغام لیکلو زحمت ته اړتیا نشته. یوه دوستانه یادونه په څو شېبو کې لېږل کېږي.",
  "feature.backup.eyebrow": "د حساب کتاب مو مه ورکوئ",
  "feature.backup.title": "ټیلیفون ورکېږي. کاټه مو بېرته راځي.",
  "feature.backup.body":
    "پخوا د ټیلیفون په ماتېدو یا غلا کېدو ټول حساب کتاب ورسره ورکېده — هر نوم او هره اندازه پیسې چې خلک مو پوروړي وو. له Google یا Apple سره ننوځئ او کاټه به په خپله شاتړ ساتي. په نوي ټیلیفون کې ننوځئ او هر څه بېرته راځي: هر کس، هره راکړه ورکړه او هر پاتې حساب.",
  "extras.eyebrow": "د ورځني حساب کتاب لپاره",
  "extras.title": "د حساب کتاب نورې ګټورې اسانتیاوې.",
  "extras.currencies.title": "د پیسو هر واحد، خپل جلا حساب.",
  "extras.currencies.body": "افغانۍ، ډالر او نورې پیسې یوځای وساتئ؛ د هرې یوې پاتې حساب جلا وي.",
  "extras.search.title": "اړونده راکړه ورکړه ومومئ.",
  "extras.search.body": "یادښتونه یا ټاکلي مبلغونه ولټوئ او راکړې ورکړې د نېټې له مخې چاڼ کړئ.",
  "extras.reminders.title": "د حساب د تعقیب وخت مه هېروئ.",
  "extras.reminders.body":
    "د حساب د تعقیب نېټه وټاکئ او هغه یادونې چې وخت یې رسېدلی، په کاټه کې یوځای وګورئ.",
  "extras.lock.title": "د اړتیا پر وخت اپ قلف کړئ.",
  "extras.lock.body": "د اپ اختیاري قلف وکاروئ او خپل حساب کتاب په ټیلیفون کې شخصي وساتئ.",
  "cta.title.line1": "د کاغذ په ټوټو پسې",
  "cta.title.line2": "ګرځېدل پرېږدئ.",
  "cta.sub": "تل وړیا. نه کارت غواړي، نه فیس او نه تنظیم.",
  "cta.button": "کاټه ښکته کړئ",
  "footer.tagline": "ستاسو او د هغو خلکو ترمنځ یوه شخصي کاټه چې باور پرې لرئ. په کابل کې جوړه شوې.",
  "footer.product": "کاټه",
  "footer.download": "ښکته کول",
  "footer.how": "څنګه کار کوي",
  "footer.inside": "څه پکې شته",
  "footer.company": "شرکت",
  "footer.contact": "په WhatsApp کې اړیکه ونیسئ",
  "footer.privacy": "محرمیت",
  "footer.terms": "شرطونه",
  "footer.deleteAccount": "حساب ړنګ کړئ",
  "footer.followFacebook": "کاټه په Facebook کې تعقیب کړئ",
  "footer.followInstagram": "کاټه په Instagram کې تعقیب کړئ",
  "footer.followTiktok": "کاټه په TikTok کې تعقیب کړئ",
  "footer.followYoutube": "کاټه په YouTube کې تعقیب کړئ",
  "footer.copyright": "© 2026 کاټه · په کابل کې جوړه شوې.",
  "download.title": "کاټه نصب کړئ",
  "download.sub":
    "د Android لپاره کاټه له Google Play او د iPhone لپاره یې له App Store څخه ترلاسه کړئ.",
  "download.appStoreButton": "له App Store څخه یې ښکته کړئ",
  "download.playStoreButton": "له Google Play څخه یې ترلاسه کړئ",
  "download.demo.title": "د کاټې د کارولو لار",
  "download.demo.youtube": "په YouTube کې یې وګورئ",
  "notFound.kicker": "404",
  "notFound.title": "دا پاڼه نشته.",
  "notFound.body":
    "ښايي لینک زوړ وي یا ناسم لیکل شوی وي. که چا بلنه درلېږلې وي، له هغه څخه نوی لینک وغواړئ.",
  "notFound.back": "بېرته کاټې ته",
  "invite.loading": "بلنه پورته کېږي",
  "invite.kicker": "بلنه",
  "invite.error.unavailable.title": "دا بلنه د کارولو وړ نه ده",
  "invite.error.unavailable.body":
    "ښايي موده یې تېره شوې وي، بېرته اخیستل شوې وي یا لا دمخه منل شوې وي. له بلونکي کس څخه نوی لینک وغواړئ.",
  "invite.error.rateLimited.title": "ډېرې هڅې شوې دي",
  "invite.error.rateLimited.body":
    "د اوس لپاره مو د دې لینک کارول محدود کړي دي. {wait} صبر وکړئ او بیا هڅه وکړئ، یا له بلونکي کس څخه نوی لینک وغواړئ.",
  "invite.error.rateLimited.minutes": "شاوخوا {count} دقیقې",
  "invite.error.rateLimited.fallbackWait": "څو دقیقې",
  "invite.error.network.title": "له کاټې سره اړیکه نه نیول کېږي",
  "invite.error.network.body":
    "خپله انټرنېټي اړیکه وګورئ او بیا هڅه وکړئ. که ستونزه دوام وکړي، له بلونکي کس څخه وغواړئ چې بلنه بیا ولېږي.",
  "invite.error.server.title": "یوه ستونزه پېښه شوه",
  "invite.error.server.body":
    "یوه دقیقه وروسته بیا هڅه وکړئ. که بیا هم کار ونه کړي، له بلونکي کس څخه وغواړئ چې بلنه بیا ولېږي.",
  "invite.tryAgain": "بیا هڅه وکړئ",
  "invite.backHome": "بېرته کاټې ته",
  "invite.youreInvited": "تاسو ته بلنه درکړل شوې",
  "invite.join": "له {name} سره یوځای شئ",
  "invite.takeOwnership": "د {name} مالکیت واخلئ",
  "invite.privacyNote.ownership":
    "د کاټې په نوې نسخه کې د هغه ایمیل له لارې بلنه ومنئ چې مالک ورته بلنه لېږلې ده. تاسو به مالک شئ او پخوانی مالک به سمونګر پاتې شي. یوازې د دې پاڼې پرانیستل مالکیت نه لېږدوي.",
  "invite.asRole": "د {role} په توګه",
  "invite.role.owner": "مالک",
  "invite.role.editor": "سمونګر",
  "invite.role.viewer": "کتونکی",
  "invite.invitedBy": "بلنه درکوونکی",
  "invite.email": "ایمیل",
  "invite.expires": "د پای وخت",
  "invite.expires.expired": "موده تېره شوې",
  "invite.expires.minutes": "په {count} دقیقو کې",
  "invite.expires.hours": "په {count} ساعتونو کې",
  "invite.expires.days": "په {count} ورځو کې",
  "invite.expires.soon": "ژر",
  "invite.openInApp": "په کاټه کې یې خلاص کړئ",
  "invite.downloadFallback": "لا کاټه نه لرئ؟ ښکته یې کړئ",
  "invite.afterInstall": "تر نصبولو وروسته دې پاڼې ته بېرته راشئ او «په کاټه کې یې خلاص کړئ» ووهئ.",
  "invite.desktopHint":
    "په خپل ټیلیفون کې کاټه خلاصه کړئ، بیا دا کوډ په «ناځوابو بلنو» کې پیسټ کړئ:",
  "invite.codeLabel": "د بلنې کوډ",
  "invite.privacyNote.view":
    "کاټه ستاسو حساب کتاب یوازې هغو خلکو ته ښيي چې تاسو ورته بلنه ورکړې ده. د دې بلنې په منلو تاسو کولی شئ د دې دوکان راکړې ورکړې په خپل ټیلیفون کې وګورئ.",
  "invite.privacyNote.edit":
    "کاټه ستاسو حساب کتاب یوازې هغو خلکو ته ښيي چې تاسو ورته بلنه ورکړې ده. د دې بلنې په منلو تاسو کولی شئ د دې دوکان راکړې ورکړې په خپل ټیلیفون کې سمې کړئ.",
  "share.greeting": "سلام {name}.",
  "share.theyOwe.header": "له {accountWith} سره ستاسو کاټه:",
  "share.theyOwe.amount": "🔴 ستاسو پور: −{amount} {currency}",
  "share.theyOwe.cta": "مهرباني وکړئ چې وس مو وشو، حساب تصفیه کړئ.",
  "share.footer": "— د www.kaata.af له لارې لېږل شوی",
  "home.tab.collect": "د اخیستلو پیسې",
  "home.tab.pay": "د ورکولو پیسې",
  "home.total.label.collect": "د اخیستلو پیسې",
  "home.from.many": "له {count} کسانو څخه",
  "customers.search": "پېرودونکي ولټوئ",
  "format.yesterday": "پرون",
  "format.daysAgo": "{n} ورځې مخکې",
  "format.weeksAgo": "{n} اوونۍ مخکې",
  "mock.self.name": "سلطان",
  "mock.self.shop": "د سلطان دوکان",
  "mock.name.mahmood": "محمود",
  "mock.name.ahmad": "احمد",
  "mock.name.sultan": "سلطان",
  "mock.name.wahid": "وحید",
  "mock.preview.label": "د کاټې مخکتنه له خیالي بېلګه پېرودونکو سره",
  "mock.shared.preview.label": "د کاټې د ګډ حساب مخکتنه له خیالي راکړو ورکړو سره",
  "mock.shared.acceptedAt": "۱۰ لړم ۱۴۰۵، ۱۰:۲۳ له غرمې مخکې",
  "mock.notifications.preview.label": "د کاټې د خبرتیاوو مخکتنه له خیالي حسابي بدلونونو سره",
  "tab.join.title": "ګډ حساب",
  "tab.balance.confirmed": "تایید شوی ګډ پاتې حساب: {amount} {currency}",
  "tab.balance.pending": "{count} په تمه · خالص بدلون {amount} {currency}",
  "tab.status.pending": "په تمه",
  "tab.status.accepted": "ومنل شوه",
  "tab.accept": "ومنئ",
  "tab.reject": "رد کړئ",
  "tab.addedBy": "د {name} له خوا زیاته شوې",
  "tab.reviewedBy": "د {name} له خوا بیاکتل شوې",
  "entry.by.self": "{name} (تاسو)",
  "inbox.title": "خبرتیاوې",
  "inbox.markAll": "ټولې د لوستل شویو په نښه کړئ",
  "format.minutesAgo": "{n} دقیقې مخکې",
  "format.justNow": "همدا اوس",
  "mock.notification.added": "{name} یوه راکړه ورکړه ({amount}) زیاته کړه. ویې منئ یا یې رد کړئ.",
  "mock.notification.accepted": "ستاسو راکړه ورکړه ({amount}) د {name} له خوا ومنل شوه.",
  "mock.notification.voided": "{name} یوه راکړه ورکړه ({amount}) لغوه کړه.",
  "mock.bill.send.caption": "د حساب پاڼه ولېږئ",
  "mock.bill.receive.caption": "پېرودونکی څه ویني",
  "mock.bill.send.preview.label": "د خیالي حساب لپاره د کاټې د حساب پاڼې د صادرولو غوراوي",
  "mock.bill.receive.preview.label": "د کاټې نېټه لرونکی بل له خیالي راکړو ورکړو او پاتې حساب سره",
  "mock.bill.dated": "د {date} نېټې بل",
  "mock.bill.owes": "پوروړی دی",
  "mock.bill.transactions": "راکړې ورکړې",
  "personEdit.export": "د حساب پاڼه صادره کړئ",
  "export.action.sharePdf": "د PDF په بڼه یې شریک کړئ",
  "export.action.shareCsv": "د CSV په بڼه یې شریک کړئ",
  "export.action.savePdf": "PDF په ټیلیفون کې خوندي کړئ",
  "export.action.saveCsv": "CSV په ټیلیفون کې خوندي کړئ",
  "mock.balance.title": "د حسابونو ټولیز",
  "mock.balance.pay": "ورکونکې پیسې",
  "person.search.placeholder": "یادښتونه یا پیسې ولټوئ",
  "person.date.title": "د نېټې له مخې چاڼ کړئ",
  "person.flows.received": "ترلاسه کړل ({count})",
  "person.flows.gave": "ورکړل ({count})",
  "mock.owesYou": "ستاسو پوروړی دی",
  "mock.gave": "ورکړل",
  "mock.received": "ترلاسه کړل",
  "mock.today": "نن",
  "mock.payment": "ورکړه",
  "mock.supplies": "د دوکان توکي",
  "mock.goods": "وریجې او غوړي",
  "mock.entrySaved.title": "راکړه ورکړه خوندي شوه",
  "mock.restored.title": "کاټه بېرته راستانه شوه.",
  "mock.restored.sub": "4 کسان · 132 راکړې ورکړې · هر پاتې حساب بېرته په همدې ټیلیفون کې.",
  "mock.whatsapp.reply": "مننه، سبا به یې ان شاء الله درکړم.",
  "mock.whatsapp.messagePlaceholder": "پیغام",
};

export const TABLES = { en, fa, ps };

const PAGE_TITLES: Record<Lang, string> = {
  en: "Kaata — A personal ledger between you and the people you trust.",
  fa: "کاتا — یک کاتای شخصی بین شما و کسانی که به آنها اعتماد دارید.",
  ps: "کاټه — ستاسو او د هغو خلکو ترمنځ یوه شخصي کاټه چې باور پرې لرئ.",
};

export type TKey = keyof typeof en;

function detectInitialLang(): Lang {
  let stored: string | null = null;
  try {
    stored = window.localStorage.getItem(LANG_KEY);
  } catch {
    // Storage can be unavailable; browser detection still works.
  }
  const languages =
    typeof navigator !== "undefined"
      ? navigator.languages?.length
        ? navigator.languages
        : [navigator.language]
      : [];
  return detectLanguage(stored, languages);
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
    document.documentElement.dir = isRtlLanguage(lang) ? "rtl" : "ltr";
    // Workspace routes own their page-specific titles, including on language
    // changes. A parent language effect must not overwrite the auth page title.
    if (!/^\/app(?:\/|$)/.test(window.location?.pathname ?? "")) document.title = PAGE_TITLES[lang];
    // Social previews intentionally keep the Persian copy/image in index.html.
    // Page title and search description still follow the visitor's UI language.
    document
      .querySelector('meta[name="description"]')
      ?.setAttribute("content", TABLES[lang]["hero.sub"]);
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
      isRTL: isRtlLanguage(lang),
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
