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

import { AFGHAN_MONTHS, AFGHAN_MONTHS_LATIN, formatCalendarDate, toJalali } from "../jalali";

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
