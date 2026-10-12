import assert from "node:assert/strict";
import { test } from "node:test";
import { formatQamariDate, resolveBillCalendar, resolveQamariOffset } from "./customer-dates.ts";

const at = (y: number, m: number, d: number) => new Date(y, m - 1, d, 12).getTime();

test("Qamari bill dates match mobile and OG preview goldens in both scripts", () => {
  for (const [ms, en, fa] of [
    [at(2026, 8, 5), "20 Safar 1448", "۲۰ صفر ۱۴۴۸"],
    [at(2026, 3, 21), "2 Shawwal 1447", "۲ شوال ۱۴۴۷"],
    [at(2026, 12, 31), "21 Rajab 1448", "۲۱ رجب ۱۴۴۸"],
    [at(2026, 6, 16), "30 Dhu al-Hijjah 1447", "۳۰ ذوالحجه ۱۴۴۷"],
    [at(2026, 6, 17), "1 Muharram 1448", "۱ محرم ۱۴۴۸"],
    [at(2024, 7, 7), "30 Dhu al-Hijjah 1445", "۳۰ ذوالحجه ۱۴۴۵"],
    [at(2024, 7, 8), "1 Muharram 1446", "۱ محرم ۱۴۴۶"],
  ] as const) {
    assert.equal(formatQamariDate(ms, false), en);
    assert.equal(formatQamariDate(ms, true), fa);
  }
  assert.equal(formatQamariDate(at(622, 7, 19), false), "1 Muharram 1");
  assert.equal(formatQamariDate(at(622, 7, 18), false), null);
  assert.equal(formatQamariDate(Number.NaN, true), "");
});

// The frozen Qamari adjustment (audit #15). THE SAME LIST as mobile's
// QAMARI_OFFSET_GOLDEN and Go's TestQamariBillDateAndInlineGoldens. A date
// the shift moves before the epoch returns null: the caller then prints the
// unshifted Gregorian date.
test("the frozen Qamari adjustment moves bill dates like the app and the preview", () => {
  for (const [ms, offset, en, fa] of [
    [at(2026, 8, 5), -2, "18 Safar 1448", "۱۸ صفر ۱۴۴۸"],
    [at(2026, 8, 5), -1, "19 Safar 1448", "۱۹ صفر ۱۴۴۸"],
    [at(2026, 8, 5), 1, "21 Safar 1448", "۲۱ صفر ۱۴۴۸"],
    [at(2026, 8, 5), 2, "22 Safar 1448", "۲۲ صفر ۱۴۴۸"],
    [at(2026, 6, 16), 1, "1 Muharram 1448", "۱ محرم ۱۴۴۸"],
    [at(2026, 6, 17), -1, "30 Dhu al-Hijjah 1447", "۳۰ ذوالحجه ۱۴۴۷"],
    [at(622, 7, 18), 1, "1 Muharram 1", "۱ محرم ۱"],
  ] as const) {
    assert.equal(formatQamariDate(ms, false, offset), en);
    assert.equal(formatQamariDate(ms, true, offset), fa);
  }
  assert.equal(formatQamariDate(at(622, 7, 19), false, -1), null, "shifted before the epoch");
  for (const [raw, want] of [
    [undefined, 0],
    [2, 2],
    [-1, -1],
    [1.5, 0],
    [3, 0],
    ["1", 0],
  ] as const) {
    assert.equal(resolveQamariOffset(raw), want);
  }
});

test("the frozen explicit calendar wins while old/unknown bills keep their dates", () => {
  for (const rtl of [true, false]) {
    for (const calendar of ["gregorian", "jalali", "qamari"] as const) {
      assert.equal(resolveBillCalendar(calendar, rtl), calendar);
    }
    assert.equal(resolveBillCalendar(undefined, rtl), rtl ? "jalali" : "gregorian");
    assert.equal(resolveBillCalendar("unknown", rtl), rtl ? "jalali" : "gregorian");
  }
});
