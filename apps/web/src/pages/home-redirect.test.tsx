import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";

const require = createRequire(import.meta.url);
type Subscription = (changed: () => void) => () => void;

function evaluateModule(path: string, browser: object, imports: Record<string, unknown>) {
  const exports: Record<string, unknown> = {};
  const code = ts.transpileModule(readFileSync(new URL(path, import.meta.url), "utf8"), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      jsx: ts.JsxEmit.ReactJSX,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  new Function("require", "exports", "window", code)(
    (name: string) => {
      if (name in imports) return imports[name];
      if (name === "react/jsx-runtime") return require(name);
      throw new Error(`Unexpected module: ${name}`);
    },
    exports,
    browser,
  );
  return exports;
}

function savedSession(expires = Date.now() + 86_400_000): string {
  const account = "11111111-1111-4111-8111-111111111111";
  const install = "22222222-2222-4222-8222-222222222222";
  const claims = { account_id: account, install_id: install, exp: Math.floor(expires / 1000) };
  return JSON.stringify({
    session_jwt: `fixture.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.fixture`,
    account_id: account,
    install_id: install,
    default_vault_id: null,
    user: { has_password: false },
  });
}

function fixture(raw: string | null) {
  const values = new Map<string, string>();
  if (raw !== null) values.set("kaata_web_session_v2", raw);
  const storage = (map: Map<string, string>) => ({
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => map.set(key, value),
    removeItem: (key: string) => map.delete(key),
  });
  const destinations: string[] = [];
  const browser = Object.assign(new EventTarget(), {
    localStorage: storage(values),
    sessionStorage: storage(new Map()),
    location: {
      pathname: "/",
      search: "?next=https://untrusted.example/path&s=campaign",
      hash: "#product",
      replace: (destination: string) => destinations.push(destination),
    },
  });
  const store = evaluateModule("../lib/web-browser-storage.ts", browser, {});
  const auth = evaluateModule("../lib/web-auth.ts", browser, {
    "../env": { BACKEND_URL: "https://api.example.test" },
    "./web-browser-storage": store,
    "./web-shared-invite": evaluateModule("../lib/web-shared-invite.ts", browser, {}),
  });
  const routes = evaluateModule("../lib/web-routes.ts", browser, {});
  const redirected = { current: false };
  let effects: (() => void)[] = [];
  let observation!: {
    subscribe: Subscription;
    getSnapshot: () => boolean;
    getServerSnapshot: () => boolean;
  };
  const block = ({ children }: { children?: React.ReactNode }) =>
    React.createElement("div", null, children);
  const home = evaluateModule("./Home.tsx", browser, {
    react: {
      ...React,
      useRef: () => redirected,
      useEffect: (effect: () => void) => effects.push(effect),
      useSyncExternalStore: (
        subscribe: Subscription,
        getSnapshot: () => boolean,
        getServerSnapshot: () => boolean,
      ) => {
        observation = { subscribe, getSnapshot, getServerSnapshot };
        return getSnapshot();
      },
    },
    "react-router-dom": { Link: block },
    "../components/FeatureSection": { FeatureSection: block },
    "../components/BillMockups": { PhoneMockupBill: block },
    "../components/BusinessMockup": { PhoneMockupBusinesses: block },
    "../components/MemberMockups": { PhoneMockupMembers: block },
    "../components/ProductComparison": { ProductComparison: block },
    "../components/Pricing": { Pricing: block },
    "../components/Hero": {
      Hero: () => React.createElement("h1", null, "Marketing landing hero"),
    },
    "../components/PhoneMockups": {
      PhoneMockupOffline: block,
      PhoneMockupNotifications: block,
      PhoneMockupRestore: block,
      PhoneMockupShared: block,
      PhoneMockupWhatsApp: block,
    },
    "../components/SiteChrome": { SiteFooter: block, SiteHeader: block },
    "../lib/analytics": { campaignDownloadPath: () => "/download" },
    "../lib/i18n": { useI18n: () => ({ lang: "en", t: (key: string) => key }) },
    "../components/ui/button": { Button: block },
    "../components/ui/card": { Card: block },
    "../lib/web-auth": auth,
    "../lib/web-routes": routes,
  });
  return {
    destinations,
    browser,
    values,
    render: () => {
      effects = [];
      return renderToStaticMarkup(React.createElement(home.Home as React.FunctionComponent));
    },
    effects: () => effects.forEach((effect) => effect()),
    observation: () => observation,
  };
}

test("a valid saved sign-in replaces the whole document once without rendering marketing", () => {
  const f = fixture(savedSession());
  const html = f.render();
  assert.match(html, /role="status"/);
  assert.match(html, /Opening Kaata/);
  assert.doesNotMatch(html, /Marketing landing hero/);
  f.effects();
  f.effects(); // StrictMode's repeated effect must not replace history twice.
  assert.deepEqual(f.destinations, ["/app"]);
  assert.equal(f.observation().getSnapshot(), true);
  assert.equal(f.observation().getServerSnapshot(), false);
});

test("missing, expired, corrupt or mismatched saved sessions keep the public landing page", () => {
  for (const raw of [
    null,
    "null",
    savedSession(Date.now() - 1000),
    "not-json",
    JSON.stringify({ ...JSON.parse(savedSession()), account_id: "another-account" }),
  ]) {
    const f = fixture(raw);
    assert.match(f.render(), /Marketing landing hero/);
    f.effects();
    assert.deepEqual(f.destinations, []);
    assert.equal(f.observation().getSnapshot(), false);
  }
});

test("an open landing page notices another tab's sign-in and unsubscribes cleanly", () => {
  const f = fixture(null);
  assert.match(f.render(), /Marketing landing hero/);
  let changes = 0;
  const unsubscribe = f.observation().subscribe(() => changes++);
  f.values.set("kaata_web_session_v2", savedSession());
  const event = new Event("storage");
  Object.defineProperty(event, "key", { value: "kaata_web_session_v2" });
  f.browser.dispatchEvent(event);
  assert.equal(changes, 1);
  assert.equal(f.observation().getSnapshot(), true);
  f.browser.dispatchEvent(new Event("focus"));
  f.browser.dispatchEvent(new Event("pageshow"));
  assert.equal(changes, 3);
  assert.doesNotMatch(f.render(), /Marketing landing hero/);
  f.effects();
  assert.deepEqual(f.destinations, ["/app"]);
  unsubscribe();
  for (const type of ["kaata:web-session-changed", "focus", "pageshow"])
    f.browser.dispatchEvent(new Event(type));
  assert.equal(changes, 3);
});
