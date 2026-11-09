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
  "nav.pricing": "Pricing",

  // Hero
  "hero.title.line1": "Run your shop",
  "hero.title.line2": "on trust.",
  "hero.sub":
    "Kaata is a digital ledger for shopkeepers. Track what you give and receive, share accounts with people you trust, and send payment reminders over WhatsApp.",
  "hero.cta": "Download Kaata",
  "hero.how": "See how it works ↓",
  "hero.pricing": "Free forever",

  // Pricing
  "pricing.eyebrow": "Simple pricing",
  "pricing.title": "Use Kaata on your phone. Completely free.",
  "pricing.body":
    "Keep using the mobile app without paying. Pro is an optional subscription for working from your computer.",
  "pricing.free.badge": "Free forever",
  "pricing.free.name": "Kaata Mobile",
  "pricing.free.currency": "AFN",
  "pricing.free.period": "No trial",
  "pricing.free.body":
    "Your everyday accounts, on Android and iPhone. All the mobile features shown on this page are free.",
  "pricing.free.item1": "Automatic backups and sync",
  "pricing.free.item2": "Multiple businesses with separate ledgers",
  "pricing.free.item3": "Team access and permissions",
  "pricing.free.item4": "Offline personal ledgers and multiple currencies",
  "pricing.free.item5": "Shared tallies, approvals, notifications and reminders",
  "pricing.free.item6": "PDF / CSV statements and WhatsApp sharing",
  "pricing.free.note":
    "Sign in and connect to the internet for sharing, team access and backups. These are free too.",
  "pricing.free.cta": "Get the free app",
  "pricing.pro.badge": "Optional",
  "pricing.pro.name": "Kaata Web Pro",
  "pricing.pro.body":
    "For accounts at a desk: work in your browser, on Windows or on Mac, alongside your phone.",
  "pricing.pro.month": "month",
  "pricing.pro.year": "year",
  "pricing.pro.or": "or",
  "pricing.pro.account": "For your own Kaata Web account.",
  "pricing.pro.item1": "Your people and tallies, synced with your phone",
  "pricing.pro.item2": "A bigger screen for notes, history and credit limits",
  "pricing.pro.item3": "Multiple currencies and statement exports",
  "pricing.pro.payment": "Prepaid through HesabPay. No automatic renewal.",
  "pricing.pro.cta": "Try Kaata Web",
  "pricing.trial.title": "Web is in an open free trial.",
  "pricing.trial.body":
    "Every web feature is currently available without subscribing. No trial end date has been set.",
  "pricing.reassurance.title": "Happy working on your phone? You don’t need Pro.",
  "pricing.reassurance.body":
    "Adding customers, sharing tallies or inviting team members does not make the mobile app paid. Keep using it for free as your business grows.",
  "pricing.faq.title": "A few clear answers.",
  "pricing.faq.q1": "Is the free mobile app just a trial?",
  "pricing.faq.a1":
    "No. The mobile app is completely free, with no time-limited trial, subscription or payment card required. Download it and start a personal ledger without signing up.",
  "pricing.faq.q2": "When would Pro be useful?",
  "pricing.faq.a2":
    "When you also want to handle accounts at a computer, for example at an office or a bigger business. Company size does not decide the price. If your phone is enough, stay with the free mobile app.",
  "pricing.faq.q3": "Will I be charged automatically?",
  "pricing.faq.a3":
    "No. Pro is prepaid for one month or twelve months, and you choose whether to renew. Using the free app or starting the web trial does not trigger a payment.",

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
  "feature.businesses.eyebrow": "Manage Multiple Businesses",
  "feature.businesses.title": "A separate book for every business.",
  "feature.businesses.body":
    "Keep your shop, side business or partnership in its own Kaata. Switch between them from the home screen without mixing their accounts.",
  "feature.businesses.point1": "Keep each business’s people, tallies and balances separate.",
  "feature.businesses.point2": "Tap the Kaata name on the home screen to switch books.",
  "feature.businesses.point3": "Choose team access separately for each Kaata.",
  "feature.members.eyebrow": "Access Management",
  "feature.members.title": "Bring your team into the same Kaata.",
  "feature.members.body":
    "Sign in and invite someone to your Kaata with a link. They join on their own phone and can access this Kaata’s whole ledger, with the role you choose.",
  "feature.members.point1": "Editors can add, edit and delete entries.",
  "feature.members.point2": "Clerks can add entries without changing old records.",
  "feature.members.point3": "Viewers can read the ledger without making changes.",
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
  "feature.backup.eyebrow": "Automatic Backup",
  "feature.backup.title": "Phones get lost. Your kaata comes back.",
  "feature.backup.body":
    "Sign in to sync and restore your ledger with Kaata Cloud. You can also connect Google Drive in Backups to save a copy of eligible records in your own Drive and restore it on a new phone. Google sign-in and Drive backup are separate choices.",

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

  "comparison.eyebrow": "Compare ledger apps",
  "comparison.title": "A closer look at your options.",
  "comparison.caption": "Feature comparison of Kaata, ZoodHesab, Khatabook, DigiKhata and Baxak",
  "comparison.featureLabel": "Feature",
  "comparison.status.yes": "Included",
  "comparison.status.no": "Not included",
  "comparison.status.unknown": "Not confirmed",
  "comparison.csvNote":
    "CSV keeps your entries in a structured table you can open in Excel or prepare for a move to another system.",
  "comparison.reviewNote":
    "Cells marked * reflect Kaata’s product assessment. Numbered references link to the providers’ published information.",
  "comparison.reviewLink": "Kaata product assessment",
  "comparison.scrollHint":
    "Swipe or scroll sideways to compare all apps. The feature names stay in view.",
  "comparison.unknownNote":
    "A dash means the feature was not confirmed in the sources checked. It does not mean the app lacks it.",
  "comparison.scopeNote":
    "Features can vary by plan, platform and region. Check the provider for current details.",
  "comparison.badgeNote": "Badges clarify pricing or the platform confirmed by the linked source.",
  "comparison.reviewed": "Checked:",
  "comparison.sources": "Sources and scope",
  "comparison.sourceLink": "{brand}: {source}",
  "comparison.note.android": "Android",
  "comparison.note.iphone": "iPhone",
  "comparison.note.googleDrive": "Google Drive",
  "comparison.note.paid": "Paid",
  "comparison.note.freemium": "Free + paid features",
  "comparison.note.iphoneFreemium": "Free + paid features (iPhone)",
  "comparison.sourceKind.website": "Official website",
  "comparison.sourceKind.googlePlay": "Google Play listing",
  "comparison.sourceKind.appStore": "App Store listing",
  "comparison.sourceKind.privacy": "Privacy policy",
  "comparison.sourceKind.help": "Official help",
  "comparison.sourceKind.featureGuide": "Official feature guide",
  "comparison.sourceKind.features": "Official features",
  "comparison.sourceKind.terms": "Terms of service",
  "comparison.sourceKind.publishedCopy": "Official feature details",
  "comparison.feature.staff": "Team members with access roles",
  "comparison.feature.shared": "Two-sided shared tallies",
  "comparison.sharedNote":
    "Shared tallies mean a two-sided account with entry permissions and optional approval.",
  "comparison.feature.withoutAccount": "Start without registration",
  "comparison.feature.freeNoTrial": "Completely free, with no trial",
  "comparison.feature.csv": "Export ledger data as CSV",

  // Final CTA
  "cta.title.line1": "Stop chasing slips",
  "cta.title.line2": "of paper.",
  "cta.sub": "The mobile app is free. No trial, no card, no setup.",
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
  "download.sub": "Keep your daily accounts in your pocket.",
  "download.android.title": "For Android",
  "download.android.body": "Get the official app on Google Play.",
  "download.ios.title": "For iPhone",
  "download.ios.body": "Get the official app on the App Store.",
  "download.assurance": "No card. No trial. Start a personal ledger without signing up.",
  "download.appStoreButton": "Download on the App Store",
  "download.playStoreButton": "Get it on Google Play",
  "download.demo.title": "How to use Kaata",
  "download.demo.body": "Watch a quick guide, then start your first Kaata.",
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
  "mock.businesses.preview.label": "Kaata business switcher preview with fictional businesses",
  "mock.businesses.shop2": "Sultan Wholesale",
  "mock.businesses.shop3": "Sultan Personal",
  "menu.allKaatas": "All Kaatas",
  "menu.allKaatas.add": "Add a Kaata",
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
  "mock.members.list.caption": "Your Kaata team",
  "mock.members.invite.caption": "Choose their role",
  "mock.members.list.preview.label": "Kaata team members with fictional names and roles",
  "mock.members.invite.preview.label": "Kaata member invitation role options",
  "members.title": "Members",
  "members.section.members": "Members ({count})",
  "members.youSuffix": " (You)",
  "members.rolesHelp":
    "Admins manage staff and credit limits. Only owners appoint admins, transfer ownership or archive this Kaata.",
  "members.row.sendInvite": "Send invite link",
  "members.row.sendInvite.hint": "Email a join link — requires internet",
  "vaultSettings.row.transfer": "Transfer ownership",
  "vaultSettings.role.owner": "Owner",
  "vaultSettings.role.editor": "Editor",
  "vaultSettings.role.clerk": "Clerk",
  "vaultSettings.role.viewer": "Viewer",
  "invite.title": "Invite member",
  "invite.link.intro":
    "Create a link to share this Kaata. Send it to one person — they open it, sign in, and join.",
  "invite.section.role": "Role",
  "invite.role.editor.hint": "Add, edit, and delete entries",
  "invite.role.clerk.hint": "Add entries only — never edit or delete",
  "invite.role.viewer.hint": "Read-only access",
  "invite.link.editorDisclosure":
    "Editors can add, edit and delete tallies in this Kaata. In shared accounts they can also accept or reject the other side's tallies (final) and unlink the account.",
  "invite.managerNote":
    "Owners can appoint admins to manage staff and credit limits. Invite the person first, then open Members, tap their name and choose Make admin.",
  "invite.link.create": "Create link",
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
  "nav.pricing": "قیمت‌ها",

  // Hero
  "hero.title.line1": "دکان خود را",
  "hero.title.line2": "با اعتماد بچرخانید.",
  "hero.sub":
    "کاتا دفتر حساب دیجیتالی برای دکانداران است. داد و گرفت خود را ثبت کنید، با کسانی که به آن‌ها اعتماد دارید حساب مشترک داشته باشید و در واتساپ یادآوری پرداخت بفرستید.",
  "hero.cta": "دانلود کاتا",
  "hero.how": "ببینید چطور کار می‌کند ↓",
  "hero.pricing": "به همیشه رایگان",

  // Pricing
  "pricing.eyebrow": "قیمت‌گذاری ساده",
  "pricing.title": "کاتا را در تلفون‌تان استفاده کنید. کاملاً رایگان.",
  "pricing.body":
    "بدون پرداخت از اپ تلفون استفاده کنید. پرو یک اشتراک اختیاری برای کار در کمپیوتر است.",
  "pricing.free.badge": "به همیشه رایگان",
  "pricing.free.name": "کاتا در تلفون",
  "pricing.free.currency": "افغانی",
  "pricing.free.period": "بدون دورۀ آزمایشی",
  "pricing.free.body":
    "حساب‌های روزمرۀ شما، در اندروید و آیفون. همۀ امکانات اپ تلفون که در این صفحه می‌بینید، رایگان است.",
  "pricing.free.item1": "نسخۀ پشتیبان خودکار و همگام‌سازی",
  "pricing.free.item2": "چندین کاروبار با دفترهای حساب جداگانه",
  "pricing.free.item3": "دسترسی اعضای تیم و صلاحیت‌های‌شان",
  "pricing.free.item4": "دفتر حساب شخصی بدون انترنت و چندین واحد پول",
  "pricing.free.item5": "ثبت‌های مشترک، تأییدها، اعلان‌ها و یادآوری‌ها",
  "pricing.free.item6": "صورت‌حساب PDF / CSV و اشتراک‌گذاری در واتساپ",
  "pricing.free.note":
    "برای اشتراک‌گذاری، دسترسی تیم و نسخۀ پشتیبان، وارد حساب شوید و به انترنت وصل شوید. این امکانات هم رایگان است.",
  "pricing.free.cta": "اپ رایگان را بگیرید",
  "pricing.pro.badge": "اختیاری",
  "pricing.pro.name": "کاتای وب پرو",
  "pricing.pro.body": "برای حساب‌داری پشت میز: در کنار تلفون، در مرورگر، ویندوز یا مک کار کنید.",
  "pricing.pro.month": "ماه",
  "pricing.pro.year": "سال",
  "pricing.pro.or": "یا",
  "pricing.pro.account": "برای حساب کاتای وب شما.",
  "pricing.pro.item1": "اشخاص و ثبت‌های شما، همگام با تلفون",
  "pricing.pro.item2": "صفحۀ بزرگ‌تر برای یادداشت‌ها، تاریخچه و حد اعتبار",
  "pricing.pro.item3": "چندین واحد پول و صدور صورت‌حساب",
  "pricing.pro.payment": "پیش‌پرداخت از طریق حساب‌پی. تمدید خودکار ندارد.",
  "pricing.pro.cta": "کاتای وب را امتحان کنید",
  "pricing.trial.title": "دورۀ آزمایشی رایگان وب باز است.",
  "pricing.trial.body":
    "فعلاً همۀ امکانات وب بدون خرید اشتراک در دسترس است. تاریخی برای پایان دورۀ آزمایشی تعیین نشده است.",
  "pricing.reassurance.title": "کار در تلفون برای‌تان کافی است؟ به پرو نیاز ندارید.",
  "pricing.reassurance.body":
    "افزودن مشتری، اشتراک‌گذاری ثبت‌ها یا دعوت اعضای تیم، اپ تلفون را پولی نمی‌کند. با رشد کارتان هم رایگان از آن استفاده کنید.",
  "pricing.faq.title": "چند جواب روشن.",
  "pricing.faq.q1": "آیا اپ رایگان تلفون فقط یک دورۀ آزمایشی است؟",
  "pricing.faq.a1":
    "نخیر. اپ تلفون کاملاً رایگان است؛ دورۀ آزمایشی محدود ندارد و به اشتراک یا کارت پرداخت نیاز ندارد. آن را دانلود کنید و بدون ثبت‌نام، دفتر حساب شخصی‌تان را شروع کنید.",
  "pricing.faq.q2": "پرو چه وقت به کار می‌آید؟",
  "pricing.faq.a2":
    "وقتی می‌خواهید در کمپیوتر هم حساب‌ها را مدیریت کنید؛ مثلاً در دفتر یا یک شرکت بزرگ‌تر. اندازۀ شرکت قیمت را تعیین نمی‌کند. اگر تلفون برای‌تان کافی است، از اپ رایگان استفاده کنید.",
  "pricing.faq.q3": "آیا به‌طور خودکار از من پول گرفته می‌شود؟",
  "pricing.faq.a3":
    "نخیر. پرو برای یک ماه یا دوازده ماه پیش‌پرداخت می‌شود و تمدید آن به انتخاب شما است. استفاده از اپ رایگان یا شروع دورۀ آزمایشی وب، باعث پرداخت نمی‌شود.",

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
  "feature.businesses.eyebrow": "مدیریت چند کاروبار",
  "feature.businesses.title": "برای هر کاروبار، یک دفتر جدا.",
  "feature.businesses.body":
    "دکان، کاروبار جانبی یا شراکت خود را در کاتاهای جداگانه نگه دارید. از صفحۀ اصلی میان آن‌ها جابه‌جا شوید، بدون این‌که حساب‌های‌شان مخلوط شود.",
  "feature.businesses.point1": "اشخاص، ثبت‌ها و مانده‌های هر کاروبار را جدا نگه دارید.",
  "feature.businesses.point2": "برای عوض کردن دفتر، نام کاتا را در صفحۀ اصلی بزنید.",
  "feature.businesses.point3": "دسترسی اعضای تیم را برای هر کاتا جداگانه انتخاب کنید.",
  "feature.members.eyebrow": "مدیریت دسترسی",
  "feature.members.title": "همکاران خود را به همین کاتا دعوت کنید.",
  "feature.members.body":
    "وارد کاتا شوید و لینک دعوت را برای کسی بفرستید. او با تلفون خودش می‌پیوندد و با نقشی که شما انتخاب می‌کنید، به تمام حساب‌های این کاتا دسترسی پیدا می‌کند.",
  "feature.members.point1": "ویرایشگرها می‌توانند ثبت اضافه، ویرایش و حذف کنند.",
  "feature.members.point2": "ثبت‌کننده‌ها فقط ثبت تازه اضافه می‌کنند؛ سابقه را تغییر نمی‌دهند.",
  "feature.members.point3": "بیننده‌ها حساب‌ها را می‌بینند و تغییری نمی‌دهند.",
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
  "feature.backup.eyebrow": "نسخۀ پشتیبان خودکار",
  "feature.backup.title": "تلفون گم می‌شود. کاتای شما برمی‌گردد.",
  "feature.backup.body":
    "برای همگام‌سازی و بازیابی دفتر حساب خود با فضای ابری کاتا وارد حساب شوید. در بخش نسخه‌های پشتیبان می‌توانید گوگل درایو را هم وصل کنید تا یک نسخه از حساب‌های قابل پشتیبان‌گیری در درایو خودتان ذخیره و در تلفون نو بازیابی شود. ورود با گوگل و پشتیبان‌گیری در درایو دو گزینۀ جداگانه‌اند.",

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

  "comparison.eyebrow": "مقایسهٔ اپ‌های حساب‌وکتاب",
  "comparison.title": "گزینه‌های خود را روشن‌تر ببینید.",
  "comparison.caption": "مقایسهٔ امکانات Kaata، ZoodHesab، Khatabook، DigiKhata و Baxak",
  "comparison.featureLabel": "امکانات",
  "comparison.status.yes": "شامل است",
  "comparison.status.no": "شامل نیست",
  "comparison.status.unknown": "تأیید نشده",
  "comparison.csvNote":
    "CSV ثبت‌های شما را در یک جدول منظم نگه می‌دارد که می‌توانید در اکسل باز کنید یا برای انتقال به سیستم دیگری آماده سازید.",
  "comparison.reviewNote":
    "خانه‌هایی که با * نشانی شده‌اند، ارزیابی کاتا را نشان می‌دهند. منابع شماره‌دار به معلومات نشرشدۀ ارائه‌کنندگان پیوند دارند.",
  "comparison.reviewLink": "ارزیابی محصولات از سوی کاتا",
  "comparison.scrollHint":
    "برای مقایسهٔ همهٔ اپ‌ها، جدول را به پهلو بکشید. نام امکانات در دید می‌ماند.",
  "comparison.unknownNote":
    "خط تیره یعنی این امکان در منابع بررسی‌شده تأیید نشد؛ به این معنی نیست که اپ آن را ندارد.",
  "comparison.scopeNote":
    "امکانات ممکن است با پلان، سیستم‌عامل و منطقه فرق کند. جزئیات تازه را از ارائه‌کننده ببینید.",
  "comparison.badgeNote":
    "برچسب‌ها قیمت‌گذاری یا سیستم‌عاملی را روشن می‌سازند که منبع پیوندشده تأیید می‌کند.",
  "comparison.reviewed": "تاریخ بررسی:",
  "comparison.sources": "منابع و محدودهٔ مقایسه",
  "comparison.sourceLink": "{brand}: {source}",
  "comparison.note.android": "Android",
  "comparison.note.iphone": "iPhone",
  "comparison.note.googleDrive": "Google Drive",
  "comparison.note.paid": "پولی",
  "comparison.note.freemium": "امکانات رایگان و پولی",
  "comparison.note.iphoneFreemium": "امکانات رایگان و پولی (آیفون)",
  "comparison.sourceKind.website": "وب‌سایت رسمی",
  "comparison.sourceKind.googlePlay": "صفحهٔ گوگل پلی",
  "comparison.sourceKind.appStore": "صفحهٔ اپ استور",
  "comparison.sourceKind.privacy": "پالیسی محرمیت",
  "comparison.sourceKind.help": "راهنمای رسمی",
  "comparison.sourceKind.featureGuide": "راهنمای رسمی امکانات",
  "comparison.sourceKind.features": "امکانات رسمی",
  "comparison.sourceKind.terms": "شرایط استفاده",
  "comparison.sourceKind.publishedCopy": "جزئیات رسمی امکانات",
  "comparison.feature.staff": "اعضای تیم با صلاحیت‌های دسترسی",
  "comparison.feature.shared": "ثبت‌های مشترک میان دو طرف",
  "comparison.sharedNote":
    "ثبت‌های مشترک یعنی هر دو طرف یک حساب را دنبال می‌کنند، با صلاحیت ثبت و تأیید اختیاری.",
  "comparison.feature.withoutAccount": "شروع بدون ثبت‌نام",
  "comparison.feature.freeNoTrial": "کاملاً رایگان، بدون دورۀ آزمایشی",
  "comparison.feature.csv": "خروجی CSV از معلومات دفتر حساب",

  // Final CTA
  "cta.title.line1": "دیگر دنبال",
  "cta.title.line2": "کاغذپاره‌ها نگردید.",
  "cta.sub": "اپ تلفون رایگان است. بدون دورۀ آزمایشی، بدون کارت، بدون تنظیمات.",
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
  "download.sub": "حساب‌های روزمرۀ خود را در تلفون‌تان نگه دارید.",
  "download.android.title": "برای اندروید",
  "download.android.body": "اپ رسمی را از Google Play بگیرید.",
  "download.ios.title": "برای آیفون",
  "download.ios.body": "اپ رسمی را از App Store بگیرید.",
  "download.assurance":
    "بدون کارت، بدون دورۀ آزمایشی. دفتر حساب شخصی خود را بدون ثبت‌نام شروع کنید.",
  "download.appStoreButton": "دانلود از App Store",
  "download.playStoreButton": "دریافت از Google Play",
  "download.demo.title": "طرز استفاده از کاتا",
  "download.demo.body": "راهنمای کوتاه را ببینید، بعد اولین کاتای خود را شروع کنید.",
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
  "mock.businesses.preview.label": "پیش‌نمایش جابه‌جایی میان کاتاها با کاروبارهای فرضی",
  "mock.businesses.shop2": "عمده‌فروشی سلطان",
  "mock.businesses.shop3": "حساب شخصی سلطان",
  "menu.allKaatas": "همه کاتاها",
  "menu.allKaatas.add": "افزودن کاتا",
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
  "mock.members.list.caption": "اعضای کاتای شما",
  "mock.members.invite.caption": "نقش عضو را انتخاب کنید",
  "mock.members.list.preview.label": "پیش‌نمایش اعضای کاتا با نام‌ها و نقش‌های نمونه و خیالی",
  "mock.members.invite.preview.label": "پیش‌نمایش نقش‌های دعوت عضو در کاتا",
  "members.title": "اعضا",
  "members.section.members": "اعضا ({count})",
  "members.youSuffix": " (شما)",
  "members.rolesHelp":
    "مدیرها کارکنان و حد قرض را مدیریت می‌کنند. تنها مالک می‌تواند مدیر تعیین کند، مالکیت را انتقال دهد یا این کاتا را بایگانی کند.",
  "members.row.sendInvite": "ارسال لینک دعوت",
  "members.row.sendInvite.hint": "ارسال لینک پیوستن از طریق ایمیل — به اینترنت نیاز دارد",
  "vaultSettings.row.transfer": "انتقال مالکیت",
  "vaultSettings.role.owner": "مالک",
  "vaultSettings.role.editor": "ویرایشگر",
  "vaultSettings.role.clerk": "ثبت‌کننده",
  "vaultSettings.role.viewer": "بیننده",
  "invite.title": "دعوت عضو",
  "invite.link.intro":
    "یک لینک برای اشتراک این کاتا بسازید. آن را به یک نفر بفرستید — او لینک را باز می‌کند، وارد می‌شود و می‌پیوندد.",
  "invite.section.role": "نقش",
  "invite.role.editor.hint": "افزودن، ویرایش و حذف ثبت‌ها",
  "invite.role.clerk.hint": "فقط افزودن ثبت — بدون ویرایش و حذف",
  "invite.role.viewer.hint": "دسترسی فقط‌خواندنی",
  "invite.link.editorDisclosure":
    "ویرایشگرها می‌توانند در این کاتا ثبت اضافه، ویرایش و حذف کنند. در حساب‌های مشترک، ثبت‌های طرف مقابل را تأیید یا رد (نهایی) و حساب مشترک را قطع هم می‌توانند.",
  "invite.managerNote":
    "مالک می‌تواند برای مدیریت کارکنان و حد قرض مدیر تعیین کند. اول شخص را دعوت کنید، بعد در «اعضا» روی نامش بزنید و «مدیر کردن» را انتخاب کنید.",
  "invite.link.create": "ساختن لینک",
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
  "nav.pricing": "بیې",
  "hero.title.line1": "خپل دوکان وچلوئ",
  "hero.title.line2": "په باور.",
  "hero.sub":
    "کاټه د دوکاندارانو لپاره د حساب ډیجیټلي کتاب دی. ورکړې او ترلاسه کړې ثبت کړئ، له باوري خلکو سره حسابونه شریک کړئ او په WhatsApp کې د پیسو یادونې ولېږئ.",
  "hero.cta": "کاټه ښکته کړئ",
  "hero.how": "وګورئ چې څنګه کار کوي ↓",
  "hero.pricing": "د تل لپاره وړیا",

  // Pricing
  "pricing.eyebrow": "ساده بیې",
  "pricing.title": "کاتا په خپل موبایل کې وکاروئ. بشپړ وړیا.",
  "pricing.body":
    "د موبایل اپ له پیسو ورکولو پرته وکاروئ. پرو په کمپیوټر کې د کار لپاره یو اختیاري ګډون دی.",
  "pricing.free.badge": "د تل لپاره وړیا",
  "pricing.free.name": "کاتا په موبایل کې",
  "pricing.free.currency": "افغانۍ",
  "pricing.free.period": "ازمایښتي دوره نه لري",
  "pricing.free.body":
    "ستاسو ورځني حسابونه، په انډرایډ او آیفون کې. په دې پاڼه کې د موبایل اپ ښودل شوې ټولې اسانتیاوې وړیا دي.",
  "pricing.free.item1": "اتومات شاتړ او همغږي",
  "pricing.free.item2": "څو کاروبارونه له جلا حساب کتاب سره",
  "pricing.free.item3": "د ټیم لاسرسی او واکونه",
  "pricing.free.item4": "بې انټرنېټه شخصي حساب کتاب او بېلابېلې پیسې",
  "pricing.free.item5": "ګډې راکړې ورکړې، تاییدونه، خبرتیاوې او یادونې",
  "pricing.free.item6": "د PDF / CSV حساب پاڼې او په واټس‌اپ کې شریکول",
  "pricing.free.note":
    "د شریکولو، د ټیم د لاسرسي او بیک‌اپ لپاره خپل حساب ته ننوځئ او انټرنېټ سره ونښلئ. دا هم وړیا دي.",
  "pricing.free.cta": "وړیا اپ ترلاسه کړئ",
  "pricing.pro.badge": "اختیاري",
  "pricing.pro.name": "کاتا وېب پرو",
  "pricing.pro.body":
    "د مېز تر شا د حسابونو لپاره: د خپل موبایل تر څنګ په براوزر، وینډوز یا مک کې کار وکړئ.",
  "pricing.pro.month": "میاشت",
  "pricing.pro.year": "کال",
  "pricing.pro.or": "یا",
  "pricing.pro.account": "ستاسو د کاتا وېب حساب لپاره.",
  "pricing.pro.item1": "ستاسو کسان او راکړې ورکړې، له موبایل سره همغږي",
  "pricing.pro.item2": "د یادښتونو، تاریخچې او پور حدونو لپاره لویه پرده",
  "pricing.pro.item3": "بېلابېلې پیسې او د حساب پاڼو ایستل",
  "pricing.pro.payment": "د حساب‌پي له لارې مخکې پیسې ورکړئ. په خپله نه تمدیدېږي.",
  "pricing.pro.cta": "کاتا وېب وازمویئ",
  "pricing.trial.title": "د وېب وړیا ازمایښتي دوره پرانیستې ده.",
  "pricing.trial.body":
    "اوس د وېب ټولې اسانتیاوې د ګډون له اخیستلو پرته شته. د ازمایښتي دورې د پای نېټه نه ده ټاکل شوې.",
  "pricing.reassurance.title": "په موبایل کې کار مو بس دی؟ پرو ته اړتیا نه لرئ.",
  "pricing.reassurance.body":
    "د پېرودونکو زیاتول، د راکړو ورکړو شریکول یا د ټیم غړو رابلل د موبایل اپ لپاره فیس نه رامنځته کوي. د کاروبار له پراخېدو سره یې هم وړیا وکاروئ.",
  "pricing.faq.title": "څو روښانه ځوابونه.",
  "pricing.faq.q1": "ایا د موبایل وړیا اپ یوازې یوه ازمایښتي دوره ده؟",
  "pricing.faq.a1":
    "نه. د موبایل اپ بشپړ وړیا دی؛ ټاکلې ازمایښتي موده نه لري او ګډون یا د پیسو کارت ته اړتیا نشته. ډاونلوډ یې کړئ او له نوم لیکنې پرته شخصي حساب کتاب پیل کړئ.",
  "pricing.faq.q2": "پرو به څه وخت ګټور وي؟",
  "pricing.faq.a2":
    "کله چې غواړئ په کمپیوټر کې هم حسابونه سمبال کړئ، لکه په دفتر یا لوی کاروبار کې. د شرکت اندازه بیه نه ټاکي. که موبایل مو بس وي، وړیا موبایل اپ وکاروئ.",
  "pricing.faq.q3": "ایا په خپله به رانه پیسې واخیستل شي؟",
  "pricing.faq.a3":
    "نه. د پرو پیسې د یوې یا دولسو میاشتو لپاره مخکې ورکول کېږي او تاسو یې د تمدید پرېکړه کوئ. د وړیا اپ کارول یا د وېب ازمایښتي دورې پیلول د پیسو اخیستلو لامل نه کېږي.",
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
  "feature.businesses.eyebrow": "د څو کاروبارونو اداره",
  "feature.businesses.title": "د هر کاروبار لپاره جلا دفتر.",
  "feature.businesses.body":
    "خپل دوکان، بل کاروبار یا شراکت په جلا کاټو کې وساتئ. له اصلي پاڼې د هغوی ترمنځ واوړئ، پرته له دې چې حسابونه یې سره ګډ شي.",
  "feature.businesses.point1": "د هر کاروبار کسان، راکړې ورکړې او پاتې حساب جلا وساتئ.",
  "feature.businesses.point2": "د دفتر د بدلولو لپاره په اصلي پاڼه کې د کاټې نوم ووهئ.",
  "feature.businesses.point3": "د هرې کاټې لپاره د ټیم لاسرسی جلا وټاکئ.",
  "feature.members.eyebrow": "د لاسرسي مدیریت",
  "feature.members.title": "خپل همکاران همدې کاټې ته راوبلئ.",
  "feature.members.body":
    "کاټې ته ننوځئ او د بلنې لینک بل کس ته ولېږئ. هغه په خپل ټیلیفون کې ګډون کوي او د هغې ونډې له مخې چې تاسو یې ټاکئ، د همدې کاټې ټول حساب کتاب ته لاسرسی مومي.",
  "feature.members.point1": "سمونګر راکړې ورکړې زیاتولای، سمولای او ړنګولای شي.",
  "feature.members.point2": "کارکوونکي یوازې نوې راکړې ورکړې زیاتوي؛ پخوانۍ مخینه نه بدلوي.",
  "feature.members.point3": "کتونکي حساب کتاب لیدلای شي، خو بدلون نه شي راوستلای.",
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
  "feature.backup.eyebrow": "اتومات شاتړ",
  "feature.backup.title": "ټیلیفون ورکېږي. کاټه مو بېرته راځي.",
  "feature.backup.body":
    "خپل حساب ته ننوځئ څو د کاټه په کلاوډ کې خپل حسابونه همغږي او بېرته راواخلئ. د شاتړ په برخه کې Google Drive هم نښلولای شئ، څو د شاتړ وړ حسابونو کاپي په خپل ډرایو کې خوندي او په نوي ټیلیفون کې بېرته راواخلئ. له Google سره ننوتل او په ډرایو کې شاتړ جلا انتخابونه دي.",
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

  "comparison.eyebrow": "د حساب کتاب اپونه پرتله کړئ",
  "comparison.title": "خپل غوراوي ښه وپېژنئ.",
  "comparison.caption": "د Kaata، ZoodHesab، Khatabook، DigiKhata او Baxak د امکاناتو پرتله",
  "comparison.featureLabel": "امکان",
  "comparison.status.yes": "شامل دی",
  "comparison.status.no": "شامل نه دی",
  "comparison.status.unknown": "تایید نه شو",
  "comparison.csvNote":
    "CSV ستاسو ثبتونه په منظم جدول کې ساتي؛ په اېکسل کې یې پرانیستلی شئ یا بل سیستم ته د لېږد لپاره یې چمتو کولی شئ.",
  "comparison.reviewNote":
    "په * نښه شوې خانې د کاتا له خوا د محصولاتو ارزونه ښيي. شمېرې د وړاندې کوونکو خپرو شویو معلوماتو ته تړوني دي.",
  "comparison.reviewLink": "د کاتا له خوا د محصولاتو ارزونه",
  "comparison.scrollHint":
    "د ټولو اپونو د پرتله کولو لپاره جدول یوې خوا ته کش کړئ. د امکاناتو نومونه په لید کې پاتې کېږي.",
  "comparison.unknownNote":
    "کرښه یعنې دا امکان په کتل شویو سرچینو کې تایید نه شو؛ دا مانا نه لري چې اپ یې نه لري.",
  "comparison.scopeNote":
    "امکانات د پلان، سیستم او سیمې له مخې توپیر لرلای شي. د تازه جزیاتو لپاره له وړاندې کوونکي سره یې وګورئ.",
  "comparison.badgeNote": "نښې بیې یا هغه سیستم روښانوي چې تړلې سرچینې تایید کړی دی.",
  "comparison.reviewed": "د کتنې نېټه:",
  "comparison.sources": "سرچینې او د پرتله کولو لمن",
  "comparison.sourceLink": "{brand}: {source}",
  "comparison.note.android": "Android",
  "comparison.note.iphone": "iPhone",
  "comparison.note.googleDrive": "Google Drive",
  "comparison.note.paid": "پیسې غواړي",
  "comparison.note.freemium": "وړیا او په پیسو اسانتیاوې",
  "comparison.note.iphoneFreemium": "وړیا او په پیسو اسانتیاوې (آیفون)",
  "comparison.sourceKind.website": "رسمي وېبپاڼه",
  "comparison.sourceKind.googlePlay": "د Google Play پاڼه",
  "comparison.sourceKind.appStore": "د App Store پاڼه",
  "comparison.sourceKind.privacy": "د محرمیت تګلاره",
  "comparison.sourceKind.help": "رسمي لارښود",
  "comparison.sourceKind.featureGuide": "د امکاناتو رسمي لارښود",
  "comparison.sourceKind.features": "رسمي امکانات",
  "comparison.sourceKind.terms": "د کارولو شرطونه",
  "comparison.sourceKind.publishedCopy": "د امکاناتو رسمي جزیات",
  "comparison.feature.staff": "د ټیم غړي او د لاسرسي واکونه",
  "comparison.feature.shared": "د دواړو لورو ګډې راکړې ورکړې",
  "comparison.sharedNote":
    "ګډې راکړې ورکړې د دواړو لورو ګډ حساب دی، چې د ثبت واکونه او اختیاري تایید لري.",
  "comparison.feature.withoutAccount": "له نوم‌لیکنې پرته پیل",
  "comparison.feature.freeNoTrial": "بشپړ وړیا، بې ازمایښتي دورې",
  "comparison.feature.csv": "د حساب معلومات په CSV کې صادرول",
  "cta.title.line1": "د کاغذ په ټوټو پسې",
  "cta.title.line2": "ګرځېدل پرېږدئ.",
  "cta.sub": "د موبایل اپ وړیا دی. نه ازمایښتي دوره لري، نه کارت غواړي او نه تنظیم.",
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
  "download.sub": "خپل ورځني حسابونه په موبایل کې له ځان سره ولرئ.",
  "download.android.title": "د اندروید لپاره",
  "download.android.body": "رسمي اپ له Google Play څخه ترلاسه کړئ.",
  "download.ios.title": "د آیفون لپاره",
  "download.ios.body": "رسمي اپ له App Store څخه ترلاسه کړئ.",
  "download.assurance":
    "نه کارت غواړي، نه ازمایښتي دوره لري. له نوم لیکنې پرته شخصي حساب کتاب پیل کړئ.",
  "download.appStoreButton": "له App Store څخه یې ښکته کړئ",
  "download.playStoreButton": "له Google Play څخه یې ترلاسه کړئ",
  "download.demo.title": "د کاټې د کارولو لار",
  "download.demo.body": "لنډه لارښود ویډیو وګورئ، بیا خپله لومړۍ کاټه پیل کړئ.",
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
  "mock.businesses.preview.label": "د خیالي کاروبارونو ترمنځ د کاټې د بدلولو مخکتنه",
  "mock.businesses.shop2": "د سلطان عمده پلور",
  "mock.businesses.shop3": "د سلطان شخصي حساب",
  "menu.allKaatas": "ټولې کاټې",
  "menu.allKaatas.add": "کاټه ورزیاته کړئ",
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
  "mock.members.list.caption": "ستاسو د کاټې غړي",
  "mock.members.invite.caption": "د غړي ونډه وټاکئ",
  "mock.members.list.preview.label": "د کاټې د غړو مخکتنه له خیالي نومونو او ونډو سره",
  "mock.members.invite.preview.label": "د کاټې د غړي د بلنې د ونډو مخکتنه",
  "members.title": "غړي",
  "members.section.members": "غړي ({count})",
  "members.youSuffix": " (تاسو)",
  "members.rolesHelp":
    "سمبالوونکي کارکوونکي او د پور حدونه سمبالوي. یوازې خاوندان سمبالوونکي ټاکلای، مالکیت سپارلای او دا کاټه ارشیف کولای شي.",
  "members.row.sendInvite": "د بلنې لینک ولېږئ",
  "members.row.sendInvite.hint": "د ګډون لینک په برېښنالیک ولېږئ — انټرنېټ غواړي",
  "vaultSettings.row.transfer": "مالکیت ولېږدوئ",
  "vaultSettings.role.owner": "مالک",
  "vaultSettings.role.editor": "سمونګر",
  "vaultSettings.role.clerk": "کارکوونکی",
  "vaultSettings.role.viewer": "کتونکی",
  "invite.title": "غړي ته بلنه ورکړئ",
  "invite.link.intro":
    "د دې کاټې د شریکولو لپاره لینک جوړ کړئ. یوه کس ته یې ولېږئ — هغه به یې پرانیزي، ننوځي او ګډون به وکړي.",
  "invite.section.role": "ونډه",
  "invite.role.editor.hint": "راکړې ورکړې زیاتې، سمې او ړنګې کړئ",
  "invite.role.clerk.hint": "یوازې راکړې ورکړې زیاتول — سمول او ړنګول نشي کولای",
  "invite.role.viewer.hint": "یوازې د لیدلو لاسرسی",
  "invite.link.editorDisclosure":
    "سمونګر په دې کاټه کې راکړې ورکړې زیاتولای، سمولای او ړنګولای شي. په ګډو حسابونو کې د بل لوري راکړې ورکړې هم منلای یا ردولای شي؛ دا پرېکړه وروستۍ ده. د حساب اړیکه هم پرېکولای شي.",
  "invite.managerNote":
    "خاوندان د کارکوونکو او د پور د حدونو د سمبالولو لپاره سمبالوونکي ټاکلای شي. لومړی کس راوبلئ، بیا «غړي» پرانیزئ، د هغه نوم ووهئ او «سمبالوونکی یې کړئ» وټاکئ.",
  "invite.link.create": "لینک جوړ کړئ",
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
