// Date rendering for both calendar systems the app supports.
//
// Solar Hijri uses AFGHAN month names — the zodiac set (حمل … حوت), not the
// Iranian names (فروردین …) that ICU ships for `fa`. That distinction is the
// single most important thing in this file: same calendar, same day numbering,
// different vocabulary, and the Iranian names are wrong for this audience.
//
// The conversion is pure JS on purpose. Hermes DOES compile Intl in on both
// platforms (RN 0.86.2 sets HERMES_ENABLE_INTL on Android and Apple), so this
// is not a capability workaround — it is a determinism one. ICU would give us
// Iranian month names to throw away, and its output can drift with the OEM's
// ICU version; a bill date must render identically on every device forever.
// The core is the standard jalaali-js algorithm (MIT, Behrang Noruzi Niya).
//
// ---------------------------------------------------------------------------
// THE FOUR COMBINATIONS. Calendar picks which months exist; language picks how
// they are written (see lib/calendar.ts for the rationale):
//
//                    ENGLISH UI        PERSIAN UI
//     Gregorian      5 Aug 2026        ۵ اگست ۲۰۲۶
//     Solar Hijri    5 Asad 1405       ۵ اسد ۱۴۰۵
//
// All four are DAY-FIRST and structurally identical, which is why the English
// Gregorian form is "5 Aug 2026" and not the US "Aug 5, 2026" this file used
// to emit from toLocaleDateString. Two English date shapes existed before
// (that one, plus format.ts's own hand-rolled "5 Aug 2026"); they are now one.
//
// The web/SSR bill pages render the same four combinations via ICU
// (CustomerView.tsx fmtDate, templates.go fmtDate) — keep the three in visual
// lockstep, and see __dev__/jalali-selftest.ts for the golden vectors that
// catch a drift between them.
// ---------------------------------------------------------------------------

import type { Calendar } from "./calendar";

export const AFGHAN_MONTHS = [
  "حمل",
  "ثور",
  "جوزا",
  "سرطان",
  "اسد",
  "سنبله",
  "میزان",
  "عقرب",
  "قوس",
  "جدی",
  "دلو",
  "حوت",
] as const;

// Latin transliteration of the same twelve Afghan months, for a Solar Hijri
// date in an ENGLISH UI. Without this, picking Solar Hijri with English
// strings would hand an English reader a date in Arabic script.
export const AFGHAN_MONTHS_LATIN = [
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
] as const;

// Gregorian month abbreviations. The English set moved here from format.ts so
// all four month tables live together and can't drift apart.
export const GREGORIAN_MONTHS_EN = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

// Dari names for the GREGORIAN months — the Afghan forms (اگست, not the
// Iranian اوت; جنوری, not ژانویه). Needed for the Gregorian + Persian UI
// corner, which had no representation before: format.ts rendered English
// abbreviations to Persian readers on the argument that Gregorian-with-English
// -months is an Afghan commerce convention. That stays available — it is what
// an English UI gives you — but a Persian UI now reads in Persian.
export const GREGORIAN_MONTHS_FA = [
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
] as const;

const FA_DIGITS = "۰۱۲۳۴۵۶۷۸۹";
export function faDigits(v: number | string): string {
  return String(v).replace(/\d/g, (d) => FA_DIGITS[Number(d)]);
}

// ---- jalaali-js core (gregorian → jalali) ----------------------------------

const BREAKS = [
  -61, 9, 38, 199, 426, 686, 756, 818, 1111, 1181, 1210, 1635, 2060, 2097, 2192, 2262, 2324, 2394,
  2456, 3178,
];

// jalaali-js uses TRUNCATING division (~~), not floor — they differ on
// negative operands (e.g. gm-8 for January), and the algorithm's constants
// are calibrated for truncation. Do not "fix" these to Math.floor.
function div(a: number, b: number): number {
  return Math.trunc(a / b);
}

function mod(a: number, b: number): number {
  return a - Math.trunc(a / b) * b;
}

function g2d(gy: number, gm: number, gd: number): number {
  let d =
    div((gy + div(gm - 8, 6) + 100100) * 1461, 4) +
    div(153 * mod(gm + 9, 12) + 2, 5) +
    gd -
    34840408;
  d = d - div(div(gy + 100100 + div(gm - 8, 6), 100) * 3, 4) + 752;
  return d;
}

function jalCal(jy: number): { leap: number; gy: number; march: number } {
  const bl = BREAKS.length;
  const gy = jy + 621;
  let leapJ = -14;
  let jp = BREAKS[0];
  if (jy < jp || jy >= BREAKS[bl - 1]) {
    throw new Error(`invalid jalali year ${jy}`);
  }
  let jump = 0;
  for (let i = 1; i < bl; i += 1) {
    const jm = BREAKS[i];
    jump = jm - jp;
    if (jy < jm) break;
    leapJ = leapJ + div(jump, 33) * 8 + div(mod(jump, 33), 4);
    jp = jm;
  }
  let n = jy - jp;
  leapJ = leapJ + div(n, 33) * 8 + div(mod(n, 33) + 3, 4);
  if (mod(jump, 33) === 4 && jump - n === 4) leapJ += 1;
  const leapG = div(gy, 4) - div((div(gy, 100) + 1) * 3, 4) - 150;
  const march = 20 + leapJ - leapG;
  if (jump - n < 6) n = n - jump + div(jump + 4, 33) * 33;
  let leap = mod(mod(n + 1, 33) - 1, 4);
  if (leap === -1) leap = 4;
  return { leap, gy, march };
}

// Verbatim jalaali-js d2g — the gregorian triple is needed because d2j's
// leap adjustment reads the ORIGINAL year's jalCal result.
function d2g(jdn: number): { gy: number; gm: number; gd: number } {
  let j = 4 * jdn + 139361631;
  j = j + div(div(4 * jdn + 183187720, 146097) * 3, 4) * 4 - 3908;
  const i = div(mod(j, 1461), 4) * 5 + 308;
  const gd = div(mod(i, 153), 5) + 1;
  const gm = mod(div(i, 153), 12) + 1;
  const gy = div(j, 1461) - 100100 + div(8 - gm, 6);
  return { gy, gm, gd };
}

function d2j(jdn: number): { jy: number; jm: number; jd: number } {
  const gy = d2g(jdn).gy;
  let jy = gy - 621;
  const r = jalCal(jy);
  const jdn1f = g2d(gy, 3, r.march);
  let jd: number;
  let jm: number;
  let k = jdn - jdn1f;
  if (k >= 0) {
    if (k <= 185) {
      jm = 1 + div(k, 31);
      jd = mod(k, 31) + 1;
      return { jy, jm, jd };
    }
    k -= 186;
  } else {
    jy -= 1;
    k += 179;
    if (r.leap === 1) k += 1;
  }
  jm = 7 + div(k, 30);
  jd = mod(k, 30) + 1;
  return { jy, jm, jd };
}

/** Gregorian ms-epoch → { jy, jm (1-12), jd } in the Solar Hijri calendar.
 *
 *  Throws on an unusable timestamp, which every caller already handles (they
 *  all wrap this in try/catch and fall back to Gregorian). The explicit guard
 *  is load-bearing: jalCal's range check is `jy < lo || jy >= hi`, and BOTH
 *  comparisons are false when jy is NaN — so a NaN sailed straight through the
 *  throw and came out the far side as `AFGHAN_MONTHS[NaN - 1]`, i.e. the
 *  literal string "NaN undefined NaN" rendered into a customer's bill. The
 *  CSV export's shamsiDate had the same hole ("NaN-NaN-NaN"). Caught by
 *  __dev__/jalali-selftest.ts. */
export function toJalali(ms: number): { jy: number; jm: number; jd: number } {
  const dt = new Date(ms);
  const gy = dt.getFullYear();
  if (!Number.isFinite(gy)) throw new Error(`unusable timestamp ${ms}`);
  return d2j(g2d(gy, dt.getMonth() + 1, dt.getDate()));
}

/**
 * THE absolute-date formatter. Calendar chooses the month set, locale chooses
 * the script and digits; the result is day-first in all four combinations.
 *
 * Deliberately PURE — it reads no module state, so the Go port and the golden
 * vectors can exercise it directly. Callers that want the user's current
 * setting go through lib/format.ts's formatDate, which does the wiring.
 */
export function formatCalendarDate(ms: number, locale: "en" | "fa", calendar: Calendar): string {
  const fa = locale === "fa";
  const num = (v: number): string => (fa ? faDigits(v) : String(v));

  if (calendar === "jalali") {
    try {
      const { jy, jm, jd } = toJalali(ms);
      return `${num(jd)} ${(fa ? AFGHAN_MONTHS : AFGHAN_MONTHS_LATIN)[jm - 1]} ${num(jy)}`;
    } catch {
      // jalCal throws outside jy ∈ [-61, 3178). A garbage timestamp must not
      // take a list row down with it — fall through to Gregorian.
    }
  }

  const d = new Date(ms);
  const m = d.getMonth();
  // An Invalid Date yields NaN here, which would index the table as undefined
  // and render "undefined" into a bill. Empty string is the honest answer.
  if (Number.isNaN(m)) return "";
  return `${num(d.getDate())} ${(fa ? GREGORIAN_MONTHS_FA : GREGORIAN_MONTHS_EN)[m]} ${num(d.getFullYear())}`;
}

/**
 * Absolute date for ruled-off settlement lines and exports. Same formatter;
 * the separate name is kept because those callers thread an EXPLICIT locale
 * (an export or a bill can be in a different language than the app UI).
 *
 * Note this used to derive the calendar from the locale — fa implied Jalali.
 * It no longer does: the calendar is the user's setting and is passed in.
 */
export function formatSettlementDate(ms: number, locale: "en" | "fa", calendar: Calendar): string {
  return formatCalendarDate(ms, locale, calendar);
}
