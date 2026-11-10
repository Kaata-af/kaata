import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { WebAccounts } from "./WebUsageCard";
import { parseWebUsage, type WebUsage } from "./web-usage";

const report: WebUsage = {
  generated_at: "2026-11-10T10:00:00Z",
  tracking_started_at: "2026-11-09T06:15:00Z",
  recent_accounts: 3,
  first_sign_ins_7d: 10,
  first_sign_ins_previous_7d: 6,
  days: [
    { day: "2026-11-08", active_accounts: null, first_sign_ins: 2, is_partial: false },
    { day: "2026-11-09", active_accounts: 0, first_sign_ins: 1, is_partial: true },
    { day: "2026-11-10", active_accounts: 3, first_sign_ins: 0, is_partial: true },
  ],
};

test("recent browser check-ins link to the matching users and first sign-ins show the previous period", () => {
  const html = renderToStaticMarkup(
    <WebAccounts stats={{ web_accounts_total: 31, web_active_7d: 14 }} usage={report} />,
  );
  assert.match(html, /Recently on web<\/dt><dd[^>]*>3<\/dd>/);
  assert.match(html, /href="#users\?view=web-recent"[^>]*>View recent web users/);
  assert.match(html, /Visible browser check-in in the last 5 minutes/);
  assert.match(html, /First web sign-ins · 7 days<\/dt><dd[^>]*>10<\/dd>/);
  assert.match(html, /Previous 7 days · 6/);
  assert.match(html, /Active on web · 7 days<\/dt><dd[^>]*>14<\/dd>/);
});

test("active web history preserves unobserved days, true zeros, and partial coverage", () => {
  assert.equal(parseWebUsage(report).days[0]?.active_accounts, null);
  const html = renderToStaticMarkup(<WebAccounts stats={{}} usage={report} />);
  assert.match(html, /Nov 8, 2026<\/th><td[^>]*>—<\/td><td[^>]*>2<\/td>/);
  assert.match(html, /Nov 9, 2026<\/th><td[^>]*>0<span[^>]*>partial<\/span><\/td>/);
  assert.match(html, /Daily activity tracking began Nov 9, 2026, 10:45 Kabul time/);
  assert.throws(() =>
    parseWebUsage({ ...report, days: [{ ...report.days[0], active_accounts: undefined }] }),
  );
  assert.throws(() => parseWebUsage({ ...report, recent_accounts: -1 }));
});

test("missing tracking metadata keeps browser presence unknown while showing first sign-ins", () => {
  const usage = parseWebUsage({
    ...report,
    tracking_started_at: "",
    recent_accounts: 0,
    days: [report.days[0]],
  });
  const html = renderToStaticMarkup(<WebAccounts stats={{}} usage={usage} />);
  assert.match(html, /Recently on web<\/dt><dd[^>]*>—<\/dd>/);
  assert.match(html, /Daily browser activity is unavailable for this period/);
  assert.match(html, /First web sign-ins · 7 days<\/dt><dd[^>]*>10<\/dd>/);
  assert.doesNotMatch(html, /View recent web users/);
});
