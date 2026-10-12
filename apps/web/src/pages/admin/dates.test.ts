import assert from "node:assert/strict";
import { test } from "node:test";
import { fmtDateTime, fmtDateTimeParts, msUntilReportingMidnight, reportingDay } from "./dates.ts";

test("date and time tokens match the one-line Kabul timestamp and never invent a time", () => {
  for (const value of [
    "2026-09-13T19:29:59.999Z",
    "2026-09-13T19:30:00.000Z",
    "2026-12-31T19:30:00.000Z",
    Date.parse("2026-10-11T08:05:00Z"),
  ]) {
    const { date, time } = fmtDateTimeParts(value);
    assert.equal(`${date}, ${time}`, fmtDateTime(value));
  }
  assert.deepEqual(fmtDateTimeParts("2026-10-11T08:05:00Z"), {
    date: "Oct 11, 2026",
    time: "12:35",
  });
  assert.deepEqual(fmtDateTimeParts("2026-09-13T19:30:00Z"), {
    date: "Sep 14, 2026",
    time: "00:00",
  });
  assert.deepEqual(fmtDateTimeParts("2026-09-13"), { date: "Sep 13, 2026", time: "" });
  assert.deepEqual(fmtDateTimeParts(""), { date: "—", time: "" });
  assert.deepEqual(fmtDateTimeParts("not a timestamp"), { date: "—", time: "" });
  assert.deepEqual(fmtDateTimeParts("2026-02-30"), { date: "—", time: "" });
});

test("operational timestamps include a 24-hour Kabul clock across midnight and year boundaries", () => {
  assert.equal(fmtDateTime("2026-09-13T19:29:59.999Z"), "Sep 13, 2026, 23:59");
  assert.equal(fmtDateTime("2026-09-13T19:30:00.000Z"), "Sep 14, 2026, 00:00");
  assert.equal(fmtDateTime("2026-12-31T19:30:00.000Z"), "Jan 1, 2027, 00:00");
  assert.equal(fmtDateTime("2026-09-13T12:30:00-07:00"), "Sep 14, 2026, 00:00");
  assert.equal(fmtDateTime(Date.parse("2026-10-11T08:05:00Z")), "Oct 11, 2026, 12:35");
});

test("missing timestamps stay unknown and date-only history does not invent a time", () => {
  assert.equal(fmtDateTime(""), "—");
  assert.equal(fmtDateTime("not a timestamp"), "—");
  assert.equal(fmtDateTime(Number.NaN), "—");
  assert.equal(fmtDateTime("2026-09-13"), "Sep 13, 2026");
  assert.equal(fmtDateTime("2028-02-29"), "Feb 29, 2028");
  assert.equal(fmtDateTime("2026-02-30"), "—");
});

test("reporting dates change at Kabul midnight, including across month and year boundaries", () => {
  assert.equal(reportingDay("2026-09-13T19:29:59.999Z"), "2026-09-13");
  assert.equal(reportingDay("2026-09-13T19:30:00.000Z"), "2026-09-14");
  assert.equal(reportingDay("2026-09-13T23:59:59.999Z"), "2026-09-14");
  assert.equal(reportingDay("2026-12-31T19:30:00.000Z"), "2027-01-01");
  assert.equal(reportingDay("2028-02-29T19:30:00.000Z"), "2028-03-01");
  assert.equal(reportingDay("2026-09-13T12:30:00-07:00"), "2026-09-14");
});

test("empty or invalid timestamps do not enter the install-date filter", () => {
  assert.equal(reportingDay(""), "");
  assert.equal(reportingDay("not a timestamp"), "");
  assert.equal(reportingDay(Number.NaN), "");
});

test("midnight refresh lands on 00:00 Kabul rather than 00:00 UTC or a browser-local day", () => {
  assert.equal(msUntilReportingMidnight(Date.parse("2026-09-13T19:29:59.999Z")), 1);
  assert.equal(msUntilReportingMidnight(Date.parse("2026-09-13T19:30:00.000Z")), 86_400_000);
  assert.equal(msUntilReportingMidnight(Date.parse("2026-09-13T00:00:00.000Z")), 70_200_000);
  assert.equal(msUntilReportingMidnight(Date.parse("2026-12-31T19:29:00.000Z")), 60_000);
});
