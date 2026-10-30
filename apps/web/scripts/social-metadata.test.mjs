import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const image = "https://kaata.af/og/kaata-fa-v1.png";
const tags = [...html.matchAll(/<meta\b[\s\S]*?>/g)].map(([tag]) =>
  Object.fromEntries(
    [...tag.matchAll(/([\w:.-]+)="([^"]*)"/g)].map(([, key, value]) => [key, value]),
  ),
);
const metadata = () =>
  new Map(
    tags
      .filter((tag) => tag.property || tag.name)
      .map((tag) => [tag.property ?? tag.name, tag.content]),
  );

test("static social metadata uses the Persian large-image preview without changing brand icons", () => {
  const meta = metadata();
  for (const key of ["og:title", "og:description", "twitter:title", "twitter:description"]) {
    assert.ok(meta.get(key).includes("برای همیشه رایگان"), key + " carries the requested promise");
    assert.ok(/[\u0600-\u06ff]/.test(meta.get(key)));
  }
  assert.equal(meta.get("og:image"), image);
  assert.equal(meta.get("og:image:secure_url"), image);
  assert.equal(meta.get("twitter:image"), image);
  assert.equal(meta.get("og:image:width"), "1200");
  assert.equal(meta.get("og:image:height"), "630");
  assert.equal(meta.get("og:image:type"), "image/png");
  assert.ok(meta.get("og:image:alt").includes("برای همیشه رایگان"));
  assert.equal(meta.get("twitter:image:alt"), meta.get("og:image:alt"));
  assert.equal(meta.get("twitter:card"), "summary_large_image");
  assert.equal(meta.get("og:locale"), "fa_AF");
  assert.deepEqual(
    tags.filter((tag) => tag.property === "og:locale:alternate").map((tag) => tag.content),
    ["en_US", "ps_AF"],
  );
  assert.ok(meta.get("robots").includes("max-image-preview:large"));
  assert.match(html, /rel="icon"[^>]+href="\/favicon\.png\?v=original"/);
  assert.match(html, /rel="apple-touch-icon"[^>]+href="\/apple-touch-icon\.png\?v=original"/);
  const organization = JSON.parse(
    /<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(html)[1],
  );
  assert.equal(organization.logo, "https://kaata.af/logo.png?v=original");
  for (const key of [
    "og:title",
    "og:description",
    "og:image",
    "og:locale",
    "twitter:card",
    "twitter:image",
  ])
    assert.equal(
      tags.filter((tag) => (tag.property ?? tag.name) === key).length,
      1,
      "no conflicting " + key + " tags",
    );
});

function evaluate(file, dependencies, globals = {}) {
  const exports = {};
  const code = ts.transpileModule(readFileSync(new URL(file, import.meta.url), "utf8"), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      jsx: ts.JsxEmit.ReactJSX,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  new Function("require", "exports", ...Object.keys(globals), code)(
    (name) => {
      assert.ok(name in dependencies, "unexpected dependency " + name);
      return dependencies[name];
    },
    exports,
    ...Object.values(globals),
  );
  return exports;
}

test("UI language changes update document language/search copy while Persian social metadata stays fixed", () => {
  const meta = metadata();
  const social = () =>
    [...meta].filter(([key]) => key.startsWith("og:") || key.startsWith("twitter:"));
  const initialSocial = social();
  const document = {
    documentElement: { lang: "en", dir: "ltr" },
    title: /<title>(.*?)<\/title>/.exec(html)[1],
    querySelector(selector) {
      const match = /^meta\[(?:name|property)="([^"]+)"\]$/.exec(selector);
      if (!match || !meta.has(match[1])) return null;
      return {
        setAttribute: (name, value) => {
          assert.equal(name, "content");
          meta.set(match[1], value);
        },
      };
    },
  };
  const storage = new Map([["kaata_lang", "en"]]);
  const window = {
    location: { pathname: "/" },
    localStorage: {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, value),
    },
  };
  const unset = Symbol();
  let state = unset;
  let effects = [];
  const language = evaluate("../src/lib/language.ts", {});
  const app = evaluate(
    "../src/lib/i18n.tsx",
    {
      "./language": language,
      "react/jsx-runtime": { jsx: (type, props) => ({ type, props }) },
      react: {
        createContext: () => ({ Provider: "Provider" }),
        useState: (initial) => {
          if (state === unset) state = typeof initial === "function" ? initial() : initial;
          return [
            state,
            (value) => {
              state = value;
            },
          ];
        },
        useEffect: (effect) => effects.push(effect),
        useMemo: (compute) => compute(),
        useCallback: (callback) => callback,
        useContext: () => null,
      },
    },
    { document, window, navigator: { languages: ["en-US"] } },
  );
  const render = () => {
    const tree = app.I18nProvider({ children: null });
    const pending = effects;
    effects = [];
    pending.forEach((effect) => effect());
    return tree.props.value;
  };
  let context = render();
  for (const lang of ["ps", "fa", "en"]) {
    context.setLang(lang);
    context = render();
    assert.equal(context.lang, lang);
    assert.equal(context.t("brand.wordmark"), app.TABLES[lang]["brand.wordmark"]);
    assert.equal(document.documentElement.lang, lang);
    assert.equal(document.documentElement.dir, lang === "en" ? "ltr" : "rtl");
    assert.equal(storage.get("kaata_lang"), lang);
    assert.equal(meta.get("description"), app.TABLES[lang]["hero.sub"]);
    assert.ok(document.title.startsWith({ en: "Kaata", fa: "کاتا", ps: "کاټه" }[lang]));
    assert.deepEqual(
      social(),
      initialSocial,
      "social copy, locale and image must not follow the UI locale",
    );
  }

  window.location.pathname = "/app/sign-in";
  document.title = "کاتا · ورود";
  context.setLang("fa");
  context = render();
  assert.equal(document.title, "کاتا · ورود", "auth routes retain their page-specific title");
  assert.equal(document.documentElement.lang, "fa");
  assert.equal(document.documentElement.dir, "rtl");
  assert.equal(context.lang, "fa");
  assert.deepEqual(social(), initialSocial);
});

test("public social-image route keeps PNG MIME/cache headers and avoids SPA fallback", () => {
  const config = readFileSync(new URL("../Caddyfile", import.meta.url), "utf8");
  const start = config.indexOf("handle /og/*");
  const end = config.indexOf("# Everything else:", start);
  assert.ok(start > 0 && end > start);
  const route = config.slice(start, end);
  assert.match(route, /path \/og\/\*\.png/);
  assert.match(route, /file \{path\}/);
  assert.match(route, /Content-Type "image\/png"/);
  assert.match(route, /Content-Disposition "inline"/);
  assert.match(route, /Cache-Control "public, max-age=31536000, immutable"/);
  assert.match(route, /respond "Not found" 404/);
  assert.ok(
    !route.includes("try_files") && !route.includes("rewrite"),
    "missing images are not HTML previews",
  );
  assert.match(
    config,
    /@sharessr path \/v\/\* \/v2\/\* \/v3\/\* \/v1\/shared\/\* \/t\/\* \/v1\/tabs\/\*/,
  );
  assert.ok(config.includes("script-src 'self';"));
});

test("versioned social PNGs exist with the advertised dimensions", () => {
  for (const file of ["kaata-fa-v1.png", "kaata-bill-fa-v1.png"]) {
    const png = readFileSync(new URL("../public/og/" + file, import.meta.url));
    assert.equal(png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
    assert.equal(png.subarray(12, 16).toString(), "IHDR");
    assert.equal(png.readUInt32BE(16), 1200);
    assert.equal(png.readUInt32BE(20), 630);
    assert.equal(png.subarray(-8, -4).toString(), "IEND");
  }
});
