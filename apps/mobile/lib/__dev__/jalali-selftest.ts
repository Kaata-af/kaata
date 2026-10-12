// Pure-function selftest for lib/jalali.ts. Run via:
//   cd apps/mobile && npm run selftest:jalali
// or
//   cd apps/mobile && npx tsx lib/__dev__/jalali-selftest.ts
//
// Exits 0 on success, 1 on any failed assertion.
// NOT imported by app code — excluded from production bundle by virtue of
// being in __dev__/ and unreferenced by any router/screen.
//
// WHY THIS EXISTS. The same date formatting is implemented THREE times, on
// purpose, because three runtimes need it and none can import the others:
//
//   apps/mobile/lib/jalali.ts                  (this one — hand-rolled)
//   apps/backend/internal/shared/jalali.go     (Go port, OG preview line)
//   apps/backend/internal/shared/templates.go  (inline JS, the in-page bill)
//   apps/web/src/pages/CustomerView.tsx        (React fallback twin)
//
// A bill rendered by one must read identically to the same bill rendered by
// another — they are the same document seen through different pipes. Nothing
// mechanically enforced that before this file: the four could drift and the
// only symptom would be a customer's WhatsApp preview disagreeing with the
// page it opens. The Go side pins the SAME vectors in jalali_test.go
// (TestBillDateGoldenVectors); keep the two lists in sync when adding cases.
//
// The Gregorian anchors below are real-world checkable, not merely recorded
// from this implementation: Nowruz (1 Hamal) is 21 March 2026 for 1405 and
// 21 March 2025 for 1404, and shifts to 20 March 2028 for 1407 because 1406
// is a leap year. If a refactor moves those, it broke the calendar.

import {
  AFGHAN_MONTHS,
  AFGHAN_MONTHS_LATIN,
  clampQamariOffset,
  formatCalendarDate,
  getQamariOffsetDays,
  setQamariOffsetDays,
  toJalali,
  toQamari,
} from "../jalali";

type TestResult = { name: string; ok: boolean; err?: string };
const results: TestResult[] = [];

function test(name: string, fn: () => void): void {
  try {
    fn();
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, err: err instanceof Error ? err.message : String(err) });
  }
}

function eq(actual: unknown, expected: unknown, what: string): void {
  if (actual !== expected) {
    throw new Error(`${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

// Noon LOCAL, deliberately: every formatter here reads local wall-clock
// getters (entries carry a business date — see export/data.ts), so a midnight
// timestamp would make these assertions depend on the runner's timezone.
const at = (y: number, m: number, d: number): number => new Date(y, m - 1, d, 12, 0, 0).getTime();

// ---- conversion anchors ---------------------------------------------------

test("Nowruz 1405 is 21 March 2026", () => {
  const j = toJalali(at(2026, 3, 21));
  eq(`${j.jy}/${j.jm}/${j.jd}`, "1405/1/1", "jalali triple");
});

test("the day before Nowruz closes the previous year at 29 Hut", () => {
  const j = toJalali(at(2026, 3, 20));
  eq(`${j.jy}/${j.jm}/${j.jd}`, "1404/12/29", "jalali triple");
});

test("Nowruz 1404 is 21 March 2025", () => {
  const j = toJalali(at(2025, 3, 21));
  eq(`${j.jy}/${j.jm}/${j.jd}`, "1404/1/1", "jalali triple");
});

test("Nowruz 1407 shifts to 20 March 2028 (1406 is a leap year)", () => {
  const j = toJalali(at(2028, 3, 20));
  eq(`${j.jy}/${j.jm}/${j.jd}`, "1407/1/1", "jalali triple");
});

// ---- the four combinations ------------------------------------------------
//
// calendar picks the month set, locale picks the script — and every one of the
// four is DAY-FIRST, which is the property that makes them read as one family.

const GOLDEN: ReadonlyArray<{
  ms: number;
  jalaliEn: string;
  jalaliFa: string;
  gregEn: string;
  gregFa: string;
}> = [
  {
    ms: at(2026, 8, 5),
    jalaliEn: "14 Asad 1405",
    jalaliFa: "۱۴ اسد ۱۴۰۵",
    gregEn: "5 Aug 2026",
    gregFa: "۵ اگست ۲۰۲۶",
  },
  {
    ms: at(2026, 3, 21),
    jalaliEn: "1 Hamal 1405",
    jalaliFa: "۱ حمل ۱۴۰۵",
    gregEn: "21 Mar 2026",
    gregFa: "۲۱ مارچ ۲۰۲۶",
  },
  {
    ms: at(2026, 12, 31),
    jalaliEn: "10 Jadi 1405",
    jalaliFa: "۱۰ جدی ۱۴۰۵",
    gregEn: "31 Dec 2026",
    gregFa: "۳۱ دسمبر ۲۰۲۶",
  },
];

for (const g of GOLDEN) {
  const label = new Date(g.ms).toDateString();
  test(`${label} · jalali + en`, () =>
    eq(formatCalendarDate(g.ms, "en", "jalali"), g.jalaliEn, "out"));
  test(`${label} · jalali + fa`, () =>
    eq(formatCalendarDate(g.ms, "fa", "jalali"), g.jalaliFa, "out"));
  test(`${label} · gregorian + en`, () =>
    eq(formatCalendarDate(g.ms, "en", "gregorian"), g.gregEn, "out"));
  test(`${label} · gregorian + fa`, () =>
    eq(formatCalendarDate(g.ms, "fa", "gregorian"), g.gregFa, "out"));
}

// ---- vocabulary guards ----------------------------------------------------

test("month tables are twelve entries each", () => {
  eq(AFGHAN_MONTHS.length, 12, "AFGHAN_MONTHS length");
  eq(AFGHAN_MONTHS_LATIN.length, 12, "AFGHAN_MONTHS_LATIN length");
});

test("Afghan zodiac names, never the Iranian set", () => {
  // The single most important property in this file: same calendar, same
  // arithmetic, different vocabulary. ICU would hand us فروردین for fa, which
  // is wrong for this audience.
  eq(AFGHAN_MONTHS[0], "حمل", "first month");
  eq(AFGHAN_MONTHS[11], "حوت", "last month");
  if ((AFGHAN_MONTHS as readonly string[]).includes("فروردین")) {
    throw new Error("Iranian month names leaked into AFGHAN_MONTHS");
  }
});

// ---- robustness -----------------------------------------------------------

test("an unusable timestamp yields empty string, never 'undefined'", () => {
  eq(formatCalendarDate(Number.NaN, "en", "gregorian"), "", "NaN gregorian");
  eq(formatCalendarDate(Number.NaN, "fa", "jalali"), "", "NaN jalali");
});

test("a year outside the algorithm's range falls back to Gregorian, not a throw", () => {
  // jalCal throws outside jy ∈ [-61, 3178); the formatter must absorb that
  // rather than take a bill row down with it.
  const far = at(9999, 6, 1);
  const out = formatCalendarDate(far, "en", "jalali");
  if (out.length === 0) throw new Error("expected a Gregorian fallback, got empty");
  eq(out, "1 Jun 9999", "fallback shape");
});

// Islamic civil anchors, checked against Unicode ICU's named islamic-civil
// calendar rather than the differing observational/Umm al-Qura conventions.
const QAMARI_GOLDEN = [
  { ms: at(2026, 8, 5), en: "20 Safar 1448", fa: "۲۰ صفر ۱۴۴۸" },
  { ms: at(2026, 3, 21), en: "2 Shawwal 1447", fa: "۲ شوال ۱۴۴۷" },
  { ms: at(2026, 12, 31), en: "21 Rajab 1448", fa: "۲۱ رجب ۱۴۴۸" },
  { ms: at(2026, 6, 16), en: "30 Dhu al-Hijjah 1447", fa: "۳۰ ذوالحجه ۱۴۴۷" },
  { ms: at(2026, 6, 17), en: "1 Muharram 1448", fa: "۱ محرم ۱۴۴۸" },
  { ms: at(2024, 7, 7), en: "30 Dhu al-Hijjah 1445", fa: "۳۰ ذوالحجه ۱۴۴۵" },
  { ms: at(2024, 7, 8), en: "1 Muharram 1446", fa: "۱ محرم ۱۴۴۶" },
];
for (const g of QAMARI_GOLDEN) {
  test(`${new Date(g.ms).toDateString()} · qamari + en`, () =>
    eq(formatCalendarDate(g.ms, "en", "qamari"), g.en, "out"));
  test(`${new Date(g.ms).toDateString()} · qamari + fa`, () =>
    eq(formatCalendarDate(g.ms, "fa", "qamari"), g.fa, "out"));
}

// The Qamari adjustment (audit #15). THE SAME LIST is pinned in Go's
// TestQamariBillDateAndInlineGoldens (both the Go and the inline-JS renderer)
// and web's customer-dates.test: add a case to one, add it to the others.
// A date the shift moves before the epoch falls back to its own, unshifted,
// Gregorian date.
const QAMARI_OFFSET_GOLDEN = [
  { ms: at(2026, 8, 5), offset: -2, en: "18 Safar 1448", fa: "۱۸ صفر ۱۴۴۸" },
  { ms: at(2026, 8, 5), offset: -1, en: "19 Safar 1448", fa: "۱۹ صفر ۱۴۴۸" },
  { ms: at(2026, 8, 5), offset: 1, en: "21 Safar 1448", fa: "۲۱ صفر ۱۴۴۸" },
  { ms: at(2026, 8, 5), offset: 2, en: "22 Safar 1448", fa: "۲۲ صفر ۱۴۴۸" },
  { ms: at(2026, 6, 16), offset: 1, en: "1 Muharram 1448", fa: "۱ محرم ۱۴۴۸" },
  { ms: at(2026, 6, 17), offset: -1, en: "30 Dhu al-Hijjah 1447", fa: "۳۰ ذوالحجه ۱۴۴۷" },
  { ms: at(622, 7, 19), offset: -1, en: "19 Jul 622", fa: "۱۹ جولای ۶۲۲" },
  { ms: at(622, 7, 18), offset: 1, en: "1 Muharram 1", fa: "۱ محرم ۱" },
];
for (const g of QAMARI_OFFSET_GOLDEN) {
  test(`${new Date(g.ms).toDateString()} · qamari offset ${g.offset}`, () => {
    eq(formatCalendarDate(g.ms, "en", "qamari", g.offset), g.en, "en");
    eq(formatCalendarDate(g.ms, "fa", "qamari", g.offset), g.fa, "fa");
  });
}

test("the phone's Qamari adjustment is the default, whole days within ±2", () => {
  setQamariOffsetDays(1);
  try {
    eq(formatCalendarDate(at(2026, 8, 5), "en", "qamari"), "21 Safar 1448", "formatter default");
    eq(
      JSON.stringify(toQamari(at(2026, 8, 5))),
      JSON.stringify({ hy: 1448, hm: 2, hd: 21 }),
      "toQamari",
    );
    eq(formatCalendarDate(at(2026, 8, 5), "en", "qamari", 0), "20 Safar 1448", "explicit wins");
    eq(
      formatCalendarDate(at(2026, 8, 5), "en", "jalali"),
      "14 Asad 1405",
      "other calendars untouched",
    );
  } finally {
    setQamariOffsetDays(0);
  }
  setQamariOffsetDays(5);
  eq(getQamariOffsetDays(), 0, "out of range is no adjustment");
  eq(clampQamariOffset("-2"), -2, "an app_meta string");
  eq(clampQamariOffset("1.5"), 0, "whole days only");
  eq(clampQamariOffset(null), 0, "absent");
  eq(Object.is(clampQamariOffset(-0), 0), true, "never -0");
});

test("Qamari Friday epoch and invalid/pre-epoch fallback", () => {
  eq(JSON.stringify(toQamari(at(622, 7, 19))), JSON.stringify({ hy: 1, hm: 1, hd: 1 }), "epoch");
  eq(formatCalendarDate(at(622, 7, 18), "en", "qamari"), "18 Jul 622", "pre-epoch");
  eq(formatCalendarDate(Number.NaN, "en", "qamari"), "", "invalid timestamp");
  eq(formatCalendarDate(Number.POSITIVE_INFINITY, "fa", "qamari"), "", "infinite timestamp");
});

test("Qamari arithmetic agrees with ICU across a full 30-year cycle", () => {
  // Intl is only an independent TEST oracle. Production never depends on it.
  const oracle = new Intl.DateTimeFormat("en-US-u-ca-islamic-civil", {
    year: "numeric",
    month: "numeric",
    day: "numeric",
  });
  const d = new Date(at(2023, 7, 19)); // 1 Muharram 1445
  for (let n = 0; n < 10631; n++) {
    const parts = oracle.formatToParts(d);
    const get = (name: string) => Number(parts.find((p) => p.type === name)?.value);
    const q = toQamari(d.getTime());
    eq(`${q.hy}/${q.hm}/${q.hd}`, `${get("year")}/${get("month")}/${get("day")}`, d.toDateString());
    // Civil date increments also cover daylight-saving transitions on hosts
    // with DST. Adding fixed milliseconds would silently skip/duplicate days.
    d.setDate(d.getDate() + 1);
  }
});

// ---- report ---------------------------------------------------------------

let failed = 0;
for (const r of results) {
  if (r.ok) {
    console.log(`  ok    ${r.name}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${r.name}\n        ${r.err}`);
  }
}
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed === 0 ? 0 : 1);
