// Solar Hijri (Jalali) date rendering with AFGHAN month names — the zodiac
// set (حمل … حوت), not the Iranian names (فروردین …). Pure JS on purpose:
// Hermes' Intl has spotty `-u-ca-persian` calendar support across platforms,
// and a settlement date must render identically everywhere. The conversion
// core is the standard jalaali-js algorithm (MIT, Behrang Noruzi Niya) —
// the same one the web surfaces get from ICU.
//
// Used for the settlement chapter lines on the person screen; the web/SSR
// share pages do the equivalent via Intl (CustomerView.tsx fmtDate,
// templates.go fmtDate) — keep the three in visual lockstep.

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

/** Gregorian ms-epoch → { jy, jm (1-12), jd } in the Solar Hijri calendar. */
export function toJalali(ms: number): { jy: number; jm: number; jd: number } {
  const dt = new Date(ms);
  return d2j(g2d(dt.getFullYear(), dt.getMonth() + 1, dt.getDate()));
}

/**
 * Locale-appropriate absolute date for ruled-off settlement lines:
 *   fa → Solar Hijri with Afghan month names, Persian digits ("۵ اسد ۱۴۰۵")
 *   en → Gregorian ("Aug 5, 2026")
 */
export function formatSettlementDate(ms: number, locale: "en" | "fa"): string {
  if (locale === "fa") {
    try {
      const { jy, jm, jd } = toJalali(ms);
      return `${faDigits(jd)} ${AFGHAN_MONTHS[jm - 1]} ${faDigits(jy)}`;
    } catch {
      /* fall through to gregorian */
    }
  }
  try {
    return new Date(ms).toLocaleDateString("en-US", {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  } catch {
    return new Date(ms).toISOString().slice(0, 10);
  }
}
