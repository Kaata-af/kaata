import type { Lang } from "./language";

// Frozen bill calendar: absent/unknown values retain the pre-setting behavior.
export type BillCalendar = "gregorian" | "jalali" | "qamari";

export function resolveBillCalendar(value: string | undefined, rtl: boolean): BillCalendar {
  return value === "gregorian" || value === "jalali" || value === "qamari"
    ? value
    : rtl
      ? "jalali"
      : "gregorian";
}

const QAMARI_MONTHS_EN = [
  "Muharram",
  "Safar",
  "Rabi al-Awwal",
  "Rabi al-Thani",
  "Jumada al-Awwal",
  "Jumada al-Thani",
  "Rajab",
  "Sha'ban",
  "Ramadan",
  "Shawwal",
  "Dhu al-Qadah",
  "Dhu al-Hijjah",
];
const QAMARI_MONTHS_FA = [
  "محرم",
  "صفر",
  "ربیع‌الاول",
  "ربیع‌الثانی",
  "جمادی‌الاول",
  "جمادی‌الثانی",
  "رجب",
  "شعبان",
  "رمضان",
  "شوال",
  "ذوالقعده",
  "ذوالحجه",
];

const QAMARI_MONTHS_PS = [
  "محرم",
  "صفر",
  "ربیع‌الاول",
  "ربیع‌الثاني",
  "جمادی‌الاول",
  "جمادی‌الثاني",
  "رجب",
  "شعبان",
  "رمضان",
  "شوال",
  "ذوالقعده",
  "ذوالحجه",
];

/** The bill's frozen Qamari adjustment (audit #15): whole days within ±2,
 * else none. Absent on older bills and other calendars; the snapshot is
 * untrusted JSON, so anything else counts as no adjustment. */
export function resolveQamariOffset(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && Math.abs(value) <= 2
    ? value + 0
    : 0;
}

/** Deterministic Islamic civil (Friday epoch), matching mobile toQamari and
 * server billDate, moved by the bill's Qamari adjustment. Return null for
 * pre-epoch dates (after the shift) so the caller uses the unshifted
 * Gregorian date; invalid dates return an empty string. No Intl calendar data
 * required.
 * https://github.com/unicode-org/icu/blob/main/icu4c/source/i18n/islamcal.cpp
 */
export function formatQamariDate(
  ms: number,
  language: Lang | boolean,
  offsetDays = 0,
): string | null {
  const lang = typeof language === "boolean" ? (language ? "fa" : "en") : language;
  const dt = new Date(ms);
  if (!Number.isFinite(dt.getTime())) return "";
  // Extract the viewer's local civil date, then map that triple to a UTC day.
  // setUTCFullYear also handles years 0..99 without Date.UTC's 1900 shortcut.
  const civil = new Date(0);
  civil.setUTCFullYear(dt.getFullYear(), dt.getMonth(), dt.getDate());
  civil.setUTCHours(0, 0, 0, 0);
  const days = Math.floor(civil.getTime() / 86_400_000) + 2440588 - 1948440 + offsetDays;
  if (days < 0) return null;
  const y = Math.floor((30 * days + 10646) / 10631);
  const yearStart = 354 * (y - 1) + Math.floor((3 + 11 * y) / 30);
  const monthIndex = Math.min(11, Math.ceil((days - 29 - yearStart) / 29.5));
  const day = days - yearStart - Math.ceil(29.5 * monthIndex) + 1;
  const num = (value: number) =>
    lang !== "en" ? String(value).replace(/\d/g, (d) => "۰۱۲۳۴۵۶۷۸۹"[Number(d)]) : String(value);
  return `${num(day)} ${{ en: QAMARI_MONTHS_EN, fa: QAMARI_MONTHS_FA, ps: QAMARI_MONTHS_PS }[lang][monthIndex]} ${num(y)}`;
}

const SOLAR_MONTHS: Record<Lang, readonly string[]> = {
  en: [
    "Hamal",
    "Sawr",
    "Jawza",
    "Saratan",
    "Asad",
    "Sunbula",
    "Mizan",
    "Aqrab",
    "Qaws",
    "Jadi",
    "Dalw",
    "Hut",
  ],
  fa: ["حمل", "ثور", "جوزا", "سرطان", "اسد", "سنبله", "میزان", "عقرب", "قوس", "جدی", "دلو", "حوت"],
  ps: [
    "وری",
    "غویی",
    "غبرګولی",
    "چنګاښ",
    "زمری",
    "وږی",
    "تله",
    "لړم",
    "لیندۍ",
    "مرغومی",
    "سلواغه",
    "کب",
  ],
};
const GREGORIAN_MONTHS: Record<Lang, readonly string[]> = {
  en: ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"],
  fa: [
    "جنوری",
    "فبروری",
    "مارچ",
    "اپریل",
    "می",
    "جون",
    "جولای",
    "اگست",
    "سپتمبر",
    "اکتوبر",
    "نومبر",
    "دسمبر",
  ],
  ps: [
    "جنوري",
    "فبروري",
    "مارچ",
    "اپرېل",
    "مې",
    "جون",
    "جولای",
    "اګست",
    "سپتمبر",
    "اکتوبر",
    "نومبر",
    "دسمبر",
  ],
};

/** Language supplies vocabulary; the bill's frozen calendar supplies arithmetic.
 * Viewer settings never reinterpret an existing bill. */
export function formatBillDate(
  ms: number,
  lang: Lang,
  calendar: BillCalendar,
  qamariOffset = 0,
): string {
  const num = (value: number | string) =>
    lang === "en" ? String(value) : String(value).replace(/\d/g, (d) => "۰۱۲۳۴۵۶۷۸۹"[Number(d)]);
  const dt = new Date(ms);
  if (!Number.isFinite(dt.getTime())) return "";
  if (calendar === "qamari") {
    const date = formatQamariDate(ms, lang, qamariOffset);
    if (date !== null) return date;
  }
  if (calendar === "jalali") {
    try {
      const parts = new Intl.DateTimeFormat("en-US-u-ca-persian", {
        year: "numeric",
        month: "numeric",
        day: "numeric",
      }).formatToParts(dt);
      const value = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
      const month = Number(value("month"));
      const year = value("year");
      const day = value("day");
      if (year && day && month >= 1 && month <= 12) {
        return `${num(day)} ${SOLAR_MONTHS[lang][month - 1]} ${num(year)}`;
      }
    } catch {
      // If ICU has no Persian calendar data, keep the date readable.
    }
  }
  return `${num(dt.getDate())} ${GREGORIAN_MONTHS[lang][dt.getMonth()]} ${num(dt.getFullYear())}`;
}

export function formatBillAmount(value: number, lang: Lang): string {
  try {
    return Math.abs(value).toLocaleString(
      { en: "en-US", fa: "fa-AF", ps: "ps-AF-u-nu-arabext" }[lang],
      {
        minimumFractionDigits: Number.isInteger(value) ? 0 : 2,
        maximumFractionDigits: 2,
      },
    );
  } catch {
    return String(Math.abs(value));
  }
}
