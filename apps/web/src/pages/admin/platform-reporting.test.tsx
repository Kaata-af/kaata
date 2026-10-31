import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { Stats, UserRow } from "./api";
import { RecentInstalls } from "./ActivityInsights";
import { AccountDetail } from "./UsersDetails";
import { WebAccounts } from "./Overview";

test("account detail shows the full platform set while version belongs to the latest installation", () => {
  const html = renderToStaticMarkup(
    <AccountDetail
      u={
        {
          name: "Ahmad",
          platform: "web",
          platforms: ["ios", "android", "web"],
          app_version: "web",
          install_count: 2,
          web_session_count: 3,
          kaatas: [],
        } as unknown as UserRow
      }
    />,
  );
  assert.match(html, /Platforms<\/dt><dd[^>]*>Android · iOS · Web/);
  assert.match(html, /Latest platform<\/dt><dd[^>]*>Web<\/dd>/);
  assert.doesNotMatch(html, /vweb/);
  assert.match(html, /Linked app installations<\/dt><dd[^>]*>2/);
  assert.match(html, /Browser sessions<\/dt><dd[^>]*>3/);
});

test("a web platform in an older latest-installs response is identified correctly", () => {
  const html = renderToStaticMarkup(
    <RecentInstalls
      stats={
        {
          latest_installs: [
            {
              install_id: "old-web-session",
              name: "Ahmad",
              platform: "web",
              installed_at: "2026-10-31T08:00:00Z",
              first_seen_at: "2026-10-31T08:00:00Z",
            },
          ],
        } as Stats
      }
    />,
  );
  assert.match(html, />Web<\/p>/);
  assert.doesNotMatch(html, /Platform unknown/);
});

test("web account metrics remain separate from installs and rollout unknowns never become zero", () => {
  const html = renderToStaticMarkup(
    <WebAccounts stats={{ web_accounts_total: 12, web_active_7d: 5 }} />,
  );
  assert.match(html, /Web accounts/);
  assert.match(html, /Active on web · 7 days/);
  assert.match(html, />12<\/dd>/);
  assert.match(html, />5<\/dd>/);
  assert.match(html, /counted once across browsers/);
  const pending = renderToStaticMarkup(<WebAccounts stats={{}} />);
  assert.equal((pending.match(/>—<\/dd>/g) ?? []).length, 2);
  assert.doesNotMatch(pending, />0<\/dd>/);
});
