// Store and share-preview campaign. The reference is the founder's white/blue Persian
// Facebook artwork, with a yellow, blue, red footer and the original black K.
// Product UI and existing flyer/post templates keep their separate palettes.
const palette = {
  white: "#FFFFFF",
  ink: "#171717",
  blue: "#1683C5",
  yellow: "#FBBB19",
  red: "#F23C3D",
  muted: "#616161",
  paleBlue: "#F0F7FC",
};

const panels = [
  {
    slug: "home",
    label: "حساب و کتاب، ساده‌تر",
    head: "طلب و پرداخت،<br><em>در یک نگاه.</em>",
    description: "حساب هر ارز را جدا و روشن دنبال کنید.",
    scene: "screenHome",
  },
  {
    slug: "person-detail",
    label: "حساب هر مشتری",
    head: "هر معامله، ثبت.<br><em>هر حساب، روشن.</em>",
    description: "دادم، گرفتم و یادداشت مشتری؛ همه در یک‌جا.",
    scene: "screenPerson",
  },
  {
    slug: "add-entry",
    label: "ثبت آسان",
    head: "دادید یا گرفتید؟<br><em>همین حالا ثبت کنید.</em>",
    description: "با ماشین‌حساب داخلی، مبلغ را آسان حساب کنید.",
    scene: "screenEntry",
  },
  {
    slug: "search",
    label: "جستجوی سریع",
    head: "حساب دلخواه را،<br><em>زودتر پیدا کنید.</em>",
    description: "جستجو و فیلتر ارز، در همان صفحهٔ اصلی.",
    scene: "screenSearch",
  },
  {
    slug: "app-lock",
    label: "قفل اختیاری برنامه",
    head: "حساب‌های شما،<br><em>پشت قفل تلفن.</em>",
    description: "قفل برنامه را به انتخاب خود فعال کنید.",
    scene: "screenLock",
  },
  {
    slug: "reminder",
    label: "یادآوری حساب‌ها",
    head: "زمان پیگیری را<br><em>فراموش نکنید.</em>",
    description: "برای پیگیری حساب‌ها، یادآوری تنظیم کنید.",
    scene: "screenReminder",
  },
];

// Existing App Store slots remain supported. Android tablets use exact 9:16.
const formats = [
  {
    id: "play-phone",
    folder: "screenshots",
    width: 1080,
    height: 1920,
    platform: "android",
    kind: "phone",
    dpWidth: 393,
    dpHeight: 852,
  },
  {
    id: "iphone",
    folder: "iphone-6.1",
    width: 1206,
    height: 2622,
    platform: "ios",
    kind: "phone",
    dpWidth: 393,
    dpHeight: 852,
  },
  {
    id: "iphone-legacy",
    folder: "iphone-6.5",
    width: 1284,
    height: 2778,
    platform: "ios",
    kind: "phone",
    dpWidth: 393,
    dpHeight: 852,
  },
  {
    id: "tablet-7",
    folder: "tablet-screenshots/7-inch",
    width: 1260,
    height: 2240,
    platform: "android",
    kind: "tablet",
    dpWidth: 630,
    dpHeight: 1120,
  },
  {
    id: "tablet-10",
    folder: "tablet-screenshots/10-inch",
    width: 1620,
    height: 2880,
    platform: "android",
    kind: "tablet",
    dpWidth: 810,
    dpHeight: 1440,
  },
  {
    id: "ipad",
    folder: "ipad-13",
    width: 2048,
    height: 2732,
    platform: "ios",
    kind: "tablet",
    dpWidth: 1024,
    dpHeight: 1366,
  },
];

module.exports = { palette, panels, formats };
