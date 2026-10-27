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

function fixture(pathname, search) {
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
      return { BACKEND_URL: "https://api.example.test" };
    },
    exports,
    window,
    navigator,
    { referrer: "" },
    Blob,
    () => {
      throw new Error("Unexpected fetch after successful beacon");
    },
  );
  return { exports, beacons };
}

test("visit and store-click beacons redact all capability routes including historical bills", async () => {
  for (const route of ["i", "v", "v2", "v3", "t"]) {
    const app = fixture("/" + route + "/private-capability", "?secret=private-ticket&s=campaign");
    app.exports.fireVisitOnce();
    app.exports.fireVisitOnce();
    app.exports.fireStoreClick("play");
    const payloads = await Promise.all(app.beacons);
    assert.equal(
      payloads.length,
      2,
      "visit remains once per session; store click remains independent",
    );
    assert.ok(payloads.every((payload) => payload.path === "/" + route + "/:token"));
    assert.ok(payloads.every((payload) => payload.source === "campaign"));
    assert.ok(
      !JSON.stringify(payloads).includes("private-"),
      "neither token nor query reaches analytics",
    );
  }
});

test("ordinary routes retain their query and similar names do not match token prefixes", async () => {
  for (const pathname of ["/download", "/v2-news/article"]) {
    const app = fixture(pathname, "?s=campaign");
    app.exports.fireVisitOnce();
    assert.equal((await app.beacons[0]).path, pathname + "?s=campaign");
  }
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
