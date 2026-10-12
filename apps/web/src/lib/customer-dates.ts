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
export function formatQamariDate(ms: number, rtl: boolean, offsetDays = 0): string | null {
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
    rtl ? String(value).replace(/\d/g, (d) => "۰۱۲۳۴۵۶۷۸۹"[Number(d)]) : String(value);
  return `${num(day)} ${(rtl ? QAMARI_MONTHS_FA : QAMARI_MONTHS_EN)[monthIndex]} ${num(y)}`;
}
