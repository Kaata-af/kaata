import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { I18nProvider } from "../../lib/i18n";
import type { WebProStatus } from "../../lib/web-pro";
import { WebProBanner, WebProHeaderLink } from "./WebPro";

const trial: WebProStatus = {
  status: "trial",
  access: "trial_open",
  subscription_expires_at: null,
  checkout_ready: false,
  checkout_hosts: [],
  pending_order_id: null,
  plans: [],
};

function render(status: WebProStatus | null, failed = false) {
  return renderToStaticMarkup(
    <I18nProvider>
      <MemoryRouter>
        <header>
          <WebProHeaderLink status={status} failed={failed} />
        </header>
        <WebProBanner status={status} />
      </MemoryRouter>
    </I18nProvider>,
  );
}

test("paid and complimentary Pro each get one compact subscription link and no card", () => {
  const expiry = "2026-12-07T12:00:00Z";
  for (const paidExpiry of [expiry, null]) {
    const html = render({
      ...trial,
      status: "active",
      subscription_expires_at: expiry,
      paid_expires_at: paidExpiry,
    });
    assert.match(html, /<header><a [^>]*href="\/app\/subscription"[^>]*>Pro<\/a><\/header>/);
    assert.doesNotMatch(html, /web-pro-banner|Free trial|>Subscribe</);
  }
});

test("the workspace only shows the subscribe card after trial status is confirmed", () => {
  assert.equal(render(null), "<header></header>");
  const unavailable = render(null, true);
  assert.match(unavailable, /href="\/app\/subscription"[^>]*>Your subscription</);
  assert.doesNotMatch(unavailable, /web-pro-banner|Free trial/);
  const html = render(trial);
  assert.match(html, /<header><\/header><section class="web-pro-banner"/);
  assert.match(html, /href="\/app\/subscription"[^>]*>Subscribe</);
});
