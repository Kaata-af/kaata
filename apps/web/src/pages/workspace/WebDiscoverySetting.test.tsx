import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { WebDiscoveryControl } from "./WebDiscoverySetting";
import { webProfileCopy } from "./web-profile-copy";
import type { Lang } from "../../lib/i18n";
import type { WebDiscoveryState } from "../../lib/web-discovery-flow";

const known: WebDiscoveryState = { enabled: false, loading: false, saving: false, error: null };
const render = (state = known, online = true, lang: Lang = "en") =>
  renderToStaticMarkup(
    <WebDiscoveryControl
      state={state}
      lang={lang}
      online={online}
      disabled={false}
      onChange={() => {}}
      onRetry={() => {}}
    />,
  );

test("privacy control never paints unknown as OFF; confirmed switches save independently of form submit", () => {
  assert.doesNotMatch(render({ ...known, enabled: null, loading: true }), /role="switch"/);
  assert.match(render(), /type="button" role="switch"[^>]*aria-checked="false"/);
  assert.match(render({ ...known, enabled: true }), /aria-checked="true"/);
  assert.match(render(known, false), /role="switch"[^>]*disabled/);
  assert.match(render({ ...known, saving: true }), /role="switch"[^>]*disabled/);
});

test("EN, FA and PS show honest uncertainty and a read-only recovery action", () => {
  for (const lang of ["en", "fa", "ps"] as const) {
    const markup = render({ ...known, enabled: null, error: "save" }, true, lang);
    assert.ok(markup.includes(webProfileCopy[lang].discoverySaveError));
    assert.ok(markup.includes(webProfileCopy[lang].discoveryRetry));
    assert.match(markup, /role="alert"/);
    assert.doesNotMatch(markup, /role="switch"/);
    assert.match(markup, /type="button"/);
  }
});
