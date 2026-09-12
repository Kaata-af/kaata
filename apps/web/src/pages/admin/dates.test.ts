import assert from "node:assert/strict";
import { test } from "node:test";
import { msUntilReportingMidnight, reportingDay, reportingInstallDay } from "./dates.ts";

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
  assert.equal(reportingInstallDay("", "2026-09-13"), "");
  assert.equal(reportingInstallDay("not a timestamp", "2026-09-13"), "");
});

test("install dates preserve UTC history and switch precisely at the Kabul cutover", () => {
  const cutover = "2026-09-13";
  assert.equal(reportingInstallDay("2026-09-01T20:00:00Z", cutover), "2026-09-01");
  assert.equal(reportingInstallDay("2026-09-12T19:29:59.999Z", cutover), "2026-09-12");
  assert.equal(reportingInstallDay("2026-09-12T19:30:00.000Z", cutover), "2026-09-13");
  assert.equal(reportingInstallDay("2026-09-13T19:30:00.000Z", cutover), "2026-09-14");
  assert.equal(reportingInstallDay("2026-09-01T20:00:00Z"), "2026-09-02");
});

test("midnight refresh lands on 00:00 Kabul rather than 00:00 UTC or a browser-local day", () => {
  assert.equal(msUntilReportingMidnight(Date.parse("2026-09-13T19:29:59.999Z")), 1);
  assert.equal(msUntilReportingMidnight(Date.parse("2026-09-13T19:30:00.000Z")), 86_400_000);
  assert.equal(msUntilReportingMidnight(Date.parse("2026-09-13T00:00:00.000Z")), 70_200_000);
  assert.equal(msUntilReportingMidnight(Date.parse("2026-12-31T19:29:00.000Z")), 60_000);
});
