import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const code = ts.transpileModule(
  readFileSync(new URL("../src/lib/analytics.ts", import.meta.url), "utf8"),
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } },
).outputText;

function fixture(pathname, search, referrer = "", providerToken = "") {
  const exports = {};
  const beacons = [];
  const storage = () => {
    const values = new Map();
    return {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, value),
    };
  };
  const window = {
    location: { pathname, search },
    localStorage: storage(),
    sessionStorage: storage(),
  };
  const navigator = {
    sendBeacon(url, body) {
      assert.equal(url, "https://api.example.test/v1/visit");
      beacons.push(body.text().then(JSON.parse));
      return true;
    },
  };
  new Function("require", "exports", "window", "navigator", "document", "Blob", "fetch", code)(
    (name) => {
      assert.equal(name, "../env");
      return {
        BACKEND_URL: "https://api.example.test",
        PLAY_STORE_URL: "https://play.google.com/store/apps/details?id=af.kaata.app",
        APP_STORE_URL: "https://apps.apple.com/us/app/kaata/id6789651127",
        APP_STORE_CAMPAIGN_PROVIDER_TOKEN: providerToken,
      };
    },
    exports,
    window,
    navigator,
    { referrer },
    Blob,
    () => {
      throw new Error("Unexpected fetch after successful beacon");
    },
  );
  return { exports, beacons, window };
}

test("capability routes never send marketing beacons or set an acquisition source", () => {
  for (const route of ["i", "v", "v2", "v3", "V3", "t", "v1/shared", "v1/tabs"]) {
    const app = fixture("/" + route + "/private-capability", "?secret=private-ticket&s=campaign");
    app.exports.fireVisitOnce();
    app.exports.fireStoreClick("play");
    assert.equal(app.beacons.length, 0);
    assert.equal(app.exports.getSource(), "");
    assert.equal(app.window.localStorage.getItem("kaata_source"), null);
  }
});

test("public routes retain the campaign slug and strip other query and referrer details", async () => {
  for (const pathname of ["/download", "/v2-news/article"]) {
    const app = fixture(
      pathname,
      "?s=campaign&secret=example-secret",
      "https://kaata.af/v3/private-capability?secret=value",
    );
    app.exports.fireVisitOnce();
    const [visit] = await Promise.all(app.beacons);
    assert.equal(visit.path, pathname + "?s=campaign");
    assert.equal(visit.referrer, "https://kaata.af");
    assert.equal(visit.source, "campaign");
  }
});

test("private workspace paths and query parameters never reach marketing analytics", () => {
  const app = fixture("/app/private-customer", "?email=private@example.test");
  app.exports.fireVisitOnce();
  app.exports.fireStoreClick("play");
  assert.equal(app.beacons.length, 0);
});

test("explicit acquisition links replace earlier attribution and reach Google Play", async () => {
  const app = fixture("/", "?s=shop-flyer");
  app.exports.fireVisitOnce();
  app.window.location.search = "?utm_source=facebook&utm_medium=paid_social&fbclid=ignored";
  app.exports.fireVisitOnce();
  app.exports.fireVisitOnce();
  assert.equal(app.exports.campaignDownloadPath(), "/download?s=facebook_ads");
  assert.equal(
    new URL(app.exports.campaignStoreHref("play")).searchParams.get("referrer"),
    "kaata_source=facebook_ads",
  );
  app.window.location.pathname = "/download";
  app.window.location.search = "?s=bill_share";
  app.exports.fireVisitOnce();
  app.exports.fireStoreClick("play");
  app.window.location.search = "";
  app.exports.fireVisitOnce();
  assert.deepEqual(
    (await Promise.all(app.beacons)).map((p) => [p.kind ?? "visit", p.source]),
    [
      ["visit", "shop-flyer"],
      ["visit", "facebook_ads"],
      ["visit", "bill_share"],
      ["store_click", "bill_share"],
    ],
  );
  assert.equal(
    new URL(app.exports.campaignStoreHref("play")).searchParams.get("referrer"),
    "kaata_source=bill_share",
  );
});

test("organic campaign tags work, and Facebook click IDs alone do not infer ads", async () => {
  const organic = fixture("/download", "?utm_source=instagram&utm_medium=organic_social");
  organic.exports.fireVisitOnce();
  assert.equal((await organic.beacons[0]).source, "organic_posts");
  const click = fixture("/download", "?fbclid=click-id");
  click.exports.fireVisitOnce();
  assert.equal((await click.beacons[0]).source, "");
  assert.equal(
    new URL(click.exports.campaignStoreHref("play")).searchParams.has("referrer"),
    false,
  );
});

test("App Store tagging requires a numeric public provider token and a known campaign", () => {
  const configured = fixture("/download", "?s=bill_share", "", "123456");
  const params = new URL(configured.exports.campaignStoreHref("appstore")).searchParams;
  assert.equal(params.get("pt"), "123456");
  assert.equal(params.get("ct"), "bill_share");
  assert.equal(params.get("mt"), "8");
  for (const [source, token] of [
    ["bill_share", ""],
    ["bill_share", "invalid"],
    ["local-flyer", "123456"],
  ]) {
    assert.equal(
      fixture("/download", `?s=${source}`, "", token).exports.campaignStoreHref("appstore"),
      "https://apps.apple.com/us/app/kaata/id6789651127",
    );
  }
});

test("untagged visits ignore expired named acquisition but preserve legacy flyer pins", () => {
  const app = fixture("/download", "");
  const old = Date.now() - 31 * 24 * 60 * 60 * 1000;
  app.window.localStorage.setItem(
    "kaata_source",
    JSON.stringify({ source: "facebook_ads", ts: old }),
  );
  assert.equal(app.exports.getSource(), "");
  assert.equal(new URL(app.exports.campaignStoreHref("play")).searchParams.has("referrer"), false);
  app.window.localStorage.setItem(
    "kaata_source",
    JSON.stringify({ source: "shop-flyer", ts: old }),
  );
  assert.equal(app.exports.getSource(), "shop-flyer");
});

test("workspace documents have private headers and Google permissions do not expand public pages", () => {
  const config = readFileSync(new URL("../Caddyfile", import.meta.url), "utf8");
  const workspaceStart = config.indexOf("\t@workspace {");
  const workspaceEnd = config.indexOf("\n\t# Public, versioned preview", workspaceStart);
  const publicStart = config.indexOf("\n\t# Everything else:");
  const publicEnd = config.indexOf("\n\t# Backend unreachable", publicStart);
  assert.ok(workspaceStart > 0 && workspaceEnd > workspaceStart && publicStart > workspaceEnd);
  const workspace = config.slice(workspaceStart, workspaceEnd);
  const publicRoutes = config.slice(publicStart, publicEnd);
  assert.match(workspace, /@workspace \{\s+path \/app \/app\/\*\s+not host admin\.kaata\.af\s+\}/);
  assert.match(workspace, /handle @workspace \{/);
  assert.match(workspace, /try_files \{path\} \/index\.html/);
  assert.match(workspace, /Cache-Control "no-store"/);
  assert.match(workspace, /X-Robots-Tag "noindex, nofollow"/);
  assert.match(workspace, /Referrer-Policy "no-referrer"/);
  assert.match(workspace, /script-src 'self' https:\/\/accounts\.google\.com\/gsi\/client;/);
  assert.ok(publicRoutes.includes("script-src 'self';"));
  assert.ok(publicRoutes.includes("frame-src 'none';"));
  assert.ok(!publicRoutes.includes("accounts.google.com"));
});

function robotsGroups() {
  const groups = [];
  let current;
  for (const raw of readFileSync(new URL("../public/robots.txt", import.meta.url), "utf8").split(
    /\r?\n/,
  )) {
    const line = raw.replace(/#.*/, "").trim();
    const match = /^([^:]+):\s*(.*)$/.exec(line);
    if (!match) continue;
    const [, field, value] = match;
    const directive = field.trim().toLowerCase();
    if (directive === "user-agent") {
      if (!current || current.rules.length) groups.push((current = { agents: [], rules: [] }));
      current.agents.push(value.toLowerCase());
    } else if (current && (directive === "allow" || directive === "disallow") && value) {
      current.rules.push({ path: value, allow: directive === "allow" });
    }
  }
  return groups;
}

// Evaluate the literal-prefix rules used here. Specific user-agent groups
// replace the wildcard group; longest matching paths win, with Allow on ties.
function mayCrawl(groups, userAgent, path) {
  const agent = userAgent.toLowerCase();
  const ranked = groups.map((group) => ({
    group,
    rank: Math.max(
      -1,
      ...group.agents.map((product) =>
        product === "*" ? 0 : agent.includes(product) ? product.length : -1,
      ),
    ),
  }));
  const rank = Math.max(...ranked.map((row) => row.rank));
  const rules = ranked
    .filter((row) => row.rank === rank)
    .flatMap((row) => row.group.rules)
    .filter((rule) => path.startsWith(rule.path))
    .sort(
      (left, right) =>
        right.path.length - left.path.length || Number(right.allow) - Number(left.allow),
    );
  return rules[0]?.allow ?? true;
}

test("search robots retain token-page exclusions while only bill-preview crawlers get the narrow exception", () => {
  const groups = robotsGroups();
  assert.deepEqual(
    groups.map((group) => group.agents),
    [["*"], ["facebookexternalhit", "whatsapp"]],
    "no Facebot or AI-agent exception is introduced",
  );
  const tokenPaths = [
    "/i/private-invitation",
    "/v/private-bill",
    "/v2/private-bill",
    "/v3/private-bill",
    "/t/private-tab",
  ];
  for (const agent of [
    "*",
    "Googlebot",
    "Googlebot-Image",
    "Bingbot",
    "Facebot",
    "GPTBot",
    "ClaudeBot",
  ]) {
    for (const path of tokenPaths)
      assert.equal(mayCrawl(groups, agent, path), false, `${agent} must not crawl ${path}`);
    for (const path of ["/", "/download", "/og/kaata-fa-v1.png", "/og/kaata-bill-fa-v1.png"])
      assert.equal(
        mayCrawl(groups, agent, path),
        true,
        "public marketing pages and images remain public",
      );
  }
  for (const agent of ["facebookexternalhit/1.1", "WhatsApp/2.24.7", "WHATSAPP"]) {
    for (const path of [
      "/",
      "/download",
      "/og/kaata-fa-v1.png",
      "/og/kaata-bill-fa-v1.png",
      "/v/private-bill",
      "/v2/private-bill",
      "/v3/private-bill",
    ])
      assert.equal(
        mayCrawl(groups, agent, path),
        true,
        `${agent} can build the requested public/bill previews`,
      );
    for (const path of ["/i/private-invitation", "/t/private-tab"])
      assert.equal(
        mayCrawl(groups, agent, path),
        false,
        "a preview exception does not expose invitation or shared-tab crawls",
      );
  }
});
