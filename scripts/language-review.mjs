/** Review and implementation records only. Never changes application translations. */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const ts = require(path.join(root, "apps/mobile/node_modules/typescript"));
const reviewDir = path.join(root, "docs/language-review");
const catalogs = {
  mobile: "apps/mobile/lib/i18n.ts",
  web: "apps/web/src/lib/i18n.tsx",
};
const read = (file) => fs.readFileSync(path.join(root, file), "utf8").replace(/^\uFEFF/, "");
const readJson = (file) => JSON.parse(read(file));
const relative = (file) => path.relative(root, file).replaceAll("\\", "/");
const tokens = (text) =>
  [
    ...text.matchAll(
      /\{([A-Za-z_][A-Za-z0-9_]*)\}|%(?:\[\d+\])?[-+ #0]*(?:\d+|\*)?(?:\.\d+)?[a-zA-Z]/g,
    ),
  ]
    .map((m) => m[1] ?? m[0])
    .sort();
const hash = (file) =>
  createHash("sha256").update(read(file).replaceAll("\r\n", "\n")).digest("hex");
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const unwrap = (node) => {
  while (
    node &&
    (ts.isAsExpression(node) ||
      ts.isParenthesizedExpression(node) ||
      ts.isSatisfiesExpression(node))
  )
    node = node.expression;
  return node;
};
const lineAt = (sf, node) => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
const walk = (node, visit) => {
  visit(node);
  ts.forEachChild(node, (child) => walk(child, visit));
};
function staticString(node) {
  node = unwrap(node);
  if (node && ts.isStringLiteralLike(node)) return node.text;
  if (node && ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = staticString(node.left);
    const right = staticString(node.right);
    if (left !== null && right !== null) return left + right;
  }
  return null;
}
function parse(file) {
  const source = read(file);
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  return { source, sf };
}
function extractCatalog(surface, file) {
  const { source, sf } = parse(file);
  const tables = {};
  walk(sf, (node) => {
    if (!ts.isVariableDeclaration(node) || !["en", "fa", "ps"].includes(node.name.getText(sf)))
      return;
    const object = unwrap(node.initializer);
    if (!object || !ts.isObjectLiteralExpression(object)) return;
    const table = new Map();
    for (const prop of object.properties) {
      if (!ts.isPropertyAssignment(prop) || staticString(prop.initializer) === null)
        throw new Error(`Nonliteral catalog entry in ${file}:${lineAt(sf, prop)}`);
      const key = prop.name.text;
      if (table.has(key)) throw new Error(`Duplicate key ${surface}:${key}`);
      const comments = (ts.getLeadingCommentRanges(source, prop.pos) ?? [])
        .map((r) => source.slice(r.pos, r.end).replace(/^\/\/\s?/gm, ""))
        .join("\n");
      table.set(key, { text: staticString(prop.initializer), line: lineAt(sf, prop), comments });
    }
    tables[node.name.getText(sf)] = table;
  });
  if (!tables.en || !tables.fa) throw new Error(`Missing catalog in ${file}`);
  const keys = [
    ...new Set([...tables.en.keys(), ...tables.fa.keys(), ...(tables.ps?.keys() ?? [])]),
  ];
  return keys.map((key) => ({
    id: `${surface}:${key}`,
    key,
    current: {
      en: tables.en.get(key)?.text ?? null,
      fa: tables.fa.get(key)?.text ?? null,
      ps: tables.ps?.get(key)?.text ?? null,
    },
    proposed: { en: null, fa: null, ps: null },
    approved_locales: [],
    notes: "",
    placeholders: tokens(tables.en.get(key)?.text ?? tables.fa.get(key)?.text ?? ""),
    sources: ["en", "fa", "ps"]
      .filter((locale) => tables[locale]?.has(key))
      .map((locale) => ({ path: file, line: tables[locale].get(key).line, locale })),
    references: [],
    context: tables.en.get(key)?.comments ?? "",
  }));
}

const trackedFiles = () =>
  execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" })
    .split("\0")
    .filter(Boolean);
const isActive = (file) =>
  file.startsWith("apps/") &&
  !/(?:^|\/)(?:node_modules|__dev__|android|ios|scripts|dist|build)(?:\/|$)|\.(?:test|spec)\./.test(
    file,
  );
function findReferences(entries, files) {
  const byKey = new Map(entries.map((entry) => [entry.id, entry]));
  const dynamic = [];
  const languageFiles = [];
  for (const file of files.filter(isActive)) {
    if (!/\.(?:[cm]?[jt]sx?|go|json|xml|kt|swift|css|html)$/.test(file)) continue;
    const source = read(file);
    const lines = source.split(/\r?\n/);
    const matches = lines.flatMap((text, index) =>
      /\b(?:lang|locale|LocaleCode|LocalePref|ShareLangPref|isPersianScript|useIsRTL|useLocale|tIn|useI18n)\b|languageCode|languageTag|locale_pref|share_lang_pref|Accept-Language|JALALI_MONTHS|QAMARI_MONTHS|GREGORIAN_MONTHS/.test(
        text,
      )
        ? [{ line: index + 1, text: text.trim() }]
        : [],
    );
    if (matches.length) languageFiles.push({ path: file, matches });
    if (!/\.[jt]sx?$/.test(file) || Object.values(catalogs).includes(file)) continue;
    const surface = file.startsWith("apps/mobile/") ? "mobile" : "web";
    const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
    walk(sf, (node) => {
      if (ts.isStringLiteralLike(node)) {
        const entry = byKey.get(`${surface}:${node.text}`);
        if (entry) entry.references.push({ path: file, line: lineAt(sf, node) });
      }
      if (!ts.isCallExpression(node)) return;
      const name = node.expression.getText(sf);
      if (name !== "t" && name !== "tIn") return;
      const arg = node.arguments[name === "tIn" ? 1 : 0];
      if (!arg || ts.isStringLiteralLike(unwrap(arg))) return;
      dynamic.push({
        surface,
        path: file,
        line: lineAt(sf, node),
        expression: arg.getText(sf),
        note: "Computed key: literal references alone cannot prove usage coverage.",
      });
    });
  }
  return { dynamic, languageFiles };
}

function findCandidates(files) {
  const result = [];
  const machine =
    /^(?:https?:|[.#/]|[A-Z_\d]+$)|\b(?:SELECT|INSERT|UPDATE|CREATE TABLE|DELETE FROM|ALTER TABLE|console\.|rgba\(|hsl\()/;
  for (const file of files
    .filter(isActive)
    .filter((f) => /\.[jt]sx?$/.test(f) && !Object.values(catalogs).includes(f))) {
    const { sf, source } = parse(file);
    walk(sf, (node) => {
      if (!ts.isJsxText(node) && !ts.isStringLiteralLike(node)) return;
      const text = (
        ts.isJsxText(node) ? node.getText(sf).replace(/\s+/g, " ").trim() : node.text
      ).trim();
      if (!text || machine.test(text) || !/[A-Za-z\u0600-\u06ff]/.test(text)) return;
      let context;
      if (ts.isJsxText(node)) context = "visible JSX text";
      else if (ts.isJsxAttribute(node.parent)) {
        const name = node.parent.name.getText(sf);
        if (
          !/^(?:title|label|placeholder|accessibilityLabel|accessibilityHint|aria-label|alt|description|message)$/.test(
            name,
          )
        )
          return;
        context = `JSX ${name}`;
      } else if (
        ts.isPropertyAssignment(node.parent) &&
        /^(?:title|label|placeholder|accessibilityLabel|accessibilityHint|description|message|name|body|text)$/.test(
          node.parent.name.getText(sf),
        )
      )
        context = `object ${node.parent.name.getText(sf)}`;
      else {
        let parent = node.parent;
        for (let level = 0; level < 3 && parent; level++, parent = parent.parent) {
          if (
            ts.isCallExpression(parent) &&
            /(?:Alert\.alert|\.alert|\.confirm|showToast|setError|new Error|toast\.)/.test(
              parent.expression.getText(sf),
            )
          ) {
            context = `message call ${parent.expression.getText(sf)}`;
            break;
          }
          if (ts.isJsxExpression(parent) && /[\u0600-\u06ff]|[A-Za-z]+\s+[A-Za-z]+/.test(text)) {
            context = "JSX expression text";
            break;
          }
        }
      }
      if (!context) return;
      result.push({
        id: `candidate:${file}:${node.getStart(sf)}`,
        path: file,
        line: lineAt(sf, node),
        text,
        context,
        surrounding_source: source.slice(
          Math.max(0, node.getStart(sf) - 70),
          Math.min(source.length, node.end + 70),
        ),
        status: "needs_triage",
        note: "May duplicate an extracted review entry, example, or technical message. Resolve source usage before translating.",
      });
    });
  }
  return result;
}

const sections = [
  [
    "01-onboarding",
    [
      "onboarding",
      "recovery",
      "onboardingLanguage",
      "onboardingMode",
      "onboardingProfile",
      "onboardingKaata",
      "onboardingSuccess",
      "guide",
      "onboardingRestore",
      "onboardingCalendar",
    ],
  ],
  ["02-sign-in-and-security", ["auth", "accountPassword", "accountUsername"]],
  [
    "03-account-and-preferences",
    ["account", "preferences", "settings", "country", "updatePrompt", "updateBanner", "backupNag"],
  ],
  [
    "04-selection-home-and-search",
    ["selection", "home", "common", "customers", "search", "readonly"],
  ],
  [
    "05-people-and-contacts",
    ["person", "personEdit", "personAdd", "personFind", "peopleRemoved", "contacts"],
  ],
  ["06-groups-reminders-and-credit", ["groups", "reminders", "credit"]],
  ["07-entries-and-activity", ["entry", "projectionConflicts", "auditLog"]],
  ["08-menu-and-archived-kaatas", ["menu", "vaultArchived", "vaultPicker"]],
  ["09-members-and-ownership", ["members", "ownershipTransfer", "ownershipAccept"]],
  ["10-shared-accounts-and-notifications", ["tab", "inbox"]],
  ["11-invitations", ["invite", "inviteAccept"]],
  ["12-device-pairing", ["vaultPair", "vaultPairScan", "pairLink", "wifiUpgrade"]],
  ["13-kaata-settings-and-restore", ["vaultSettings", "vaultNew", "restore", "restoreProgress"]],
  ["14-messages-formatting-and-diagnostics", ["share", "brand", "format", "fgs", "diagnostics"]],
  ["15-statements-and-exports", ["export"]],
];

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  fs.writeFileSync(path.join(root, file), `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
function reviewFiles() {
  const folder = path.join(reviewDir, "review");
  return fs.existsSync(folder)
    ? fs
        .readdirSync(folder)
        .filter((name) => name.endsWith(".json"))
        .sort()
        .map((name) => relative(path.join(folder, name)))
    : [];
}
function exportReview() {
  if (reviewFiles().length)
    throw new Error(
      "Review files already exist. Refusing to overwrite review edits. Use validate to check them.",
    );
  const entries = Object.entries(catalogs).flatMap(([surface, file]) =>
    extractCatalog(surface, file),
  );
  const files = trackedFiles();
  const { dynamic, languageFiles } = findReferences(entries, files);
  const draftMaps = ["mobile-a.ps.json", "mobile-b.ps.json", "mobile-c.ps.json", "web.ps.json"].map(
    (name) => {
      const file = `docs/language-review/drafts/${name}`;
      return { surface: name.startsWith("mobile") ? "mobile" : "web", map: readJson(file) };
    },
  );
  for (const { surface, map } of draftMaps) {
    for (const [key, text] of Object.entries(map)) {
      const entry = entries.find((item) => item.id === `${surface}:${key}`);
      if (!entry || typeof text !== "string" || !text.trim())
        throw new Error(`Invalid Pashto draft ${surface}:${key}`);
      if (entry.proposed.ps !== null) throw new Error(`Duplicate Pashto draft ${entry.id}`);
      entry.proposed.ps = text;
    }
  }
  const grouped = new Map();
  for (const entry of entries) {
    if (!entry.proposed.ps) throw new Error(`Missing Pashto draft ${entry.id}`);
    const section = entry.id.startsWith("web:")
      ? "16-website"
      : sections.find(([, groups]) => groups.includes(entry.key.split(".")[0]))?.[0];
    if (!section) throw new Error(`Unassigned group ${entry.id}`);
    if (!grouped.has(section)) grouped.set(section, []);
    grouped.get(section).push(entry);
  }
  for (const [name, file] of [
    ["17-mobile-outside-catalog", "mobile-extra.json"],
    ["18-web-and-backend-outside-catalog", "web-backend-extra.json"],
  ]) {
    const rows = readJson(`docs/language-review/drafts/${file}`);
    grouped.set(
      name,
      rows.map((entry) => ({
        ...entry,
        approved_locales: [],
        notes: entry.notes ?? "",
        placeholders: tokens(entry.current.en ?? entry.current.fa ?? ""),
        references: entry.references ?? [],
      })),
    );
  }
  const manifest = [];
  for (const [section, rows] of [...grouped].sort(([a], [b]) => a.localeCompare(b))) {
    const file = `docs/language-review/review/${section}.json`;
    writeJson(file, {
      $schema: "../review.schema.json",
      format_version: 1,
      section,
      entries: rows,
    });
    manifest.push({ file, entries: rows.length });
  }
  const duplicateGroups = [];
  for (const locale of ["en", "fa"]) {
    const groups = new Map();
    for (const entry of entries) {
      const text = entry.current[locale];
      if (!groups.has(text)) groups.set(text, []);
      groups.get(text).push(entry.id);
    }
    for (const [text, ids] of groups)
      if (ids.length > 1) duplicateGroups.push({ locale, text, ids });
  }
  writeJson("docs/language-review/language-files.json", {
    note: "Tracked application files with language-related references; includes comments and technical code. Tests, generated native projects and development-only files excluded.",
    files: languageFiles,
  });
  writeJson("docs/language-review/dynamic-keys.json", {
    note: "Computed translation calls; references on review entries are exact literal matches, not an exhaustive runtime call graph.",
    calls: dynamic,
  });
  writeJson("docs/language-review/repeated-wording.json", {
    note: "Same current text may need different translations in different contexts. Review by ID; never apply global search/replace.",
    groups: duplicateGroups,
  });
  const allEntries = [...grouped.values()].flat();
  const sourcePaths = [
    ...new Set(allEntries.flatMap((entry) => entry.sources.map((loc) => loc.path))),
  ].sort();
  writeJson("docs/language-review/source-snapshot.json", {
    note: "SHA-256 of UTF-8 sources with LF line endings; detects source drift while reviews are in progress.",
    files: sourcePaths.map((file) => ({ path: file, sha256: hash(file) })),
  });
  writeJson("docs/language-review/hardcoded-candidates.json", {
    note: "Additional static copy audit queue, including legal/admin pages and some already-extracted text. Heuristic inventory, not approved translations; custom renderers and external/live content still need runtime review. IDs use snapshot character offsets and should be re-resolved by path and text.",
    entries: findCandidates(files),
  });
  writeJson("docs/language-review/current-placeholder-issues.json", {
    entries: allEntries
      .filter(
        (entry) =>
          entry.current.en &&
          entry.current.fa &&
          !equal(tokens(entry.current.en), tokens(entry.current.fa)),
      )
      .map((entry) => ({
        id: entry.id,
        en: tokens(entry.current.en),
        fa: tokens(entry.current.fa),
        note: "Existing source signatures differ; inspect format code and intent before applying edits.",
      })),
  });
  writeJson("docs/language-review/manifest.json", {
    format_version: 1,
    snapshot_date: "2026-10-19",
    source_commit: execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
    }).trim(),
    application_changed: false,
    locales: {
      en: "English",
      fa: "Dari / Persian (existing app code)",
      ps: "Pashto (proposed only; not enabled in app)",
    },
    review_rules: {
      proposed_null: "Keep current text when that locale is approved; Pashto must have text.",
      approved_locales:
        "Only these locale decisions may be applied later. Initially empty on every entry.",
      placeholders: "Preserve each named token exactly, including repetitions.",
      ids: "Keep IDs, current text, source locations and placeholders unchanged. Reply with IDs plus locale and corrected text, or edit proposed/approved_locales/notes.",
      source_locations: "One-based snapshot line numbers. Re-resolve by key before implementation.",
    },
    totals: {
      catalog: entries.length,
      mobile: entries.filter((e) => e.id.startsWith("mobile:")).length,
      web: entries.filter((e) => e.id.startsWith("web:")).length,
      supplemental: [...grouped]
        .filter(([s]) => s.startsWith("17-") || s.startsWith("18-"))
        .reduce((n, [, rows]) => n + rows.length, 0),
      review: [...grouped.values()].reduce((n, rows) => n + rows.length, 0),
      approved: 0,
    },
    files: manifest,
  });
  console.log(
    `Exported ${manifest.length} review files, ${entries.length} catalog entries, plus supplemental copy. No application files changed.`,
  );
}

function validateHistoricalExport() {
  const errors = [];
  const catalogEntries = Object.entries(catalogs).flatMap(([surface, file]) =>
    extractCatalog(surface, file),
  );
  const baselineExtras = ["mobile-extra.json", "web-backend-extra.json"].flatMap((name) =>
    readJson(`docs/language-review/drafts/${name}`),
  );
  const sourceEntries = new Map(
    [...catalogEntries, ...baselineExtras].map((entry) => [entry.id, entry]),
  );
  const seen = new Set();
  let count = 0,
    approved = 0;
  const files = reviewFiles();
  if (!files.length) throw new Error("No review files found.");
  const manifest = readJson("docs/language-review/manifest.json");
  for (const file of readJson("docs/language-review/source-snapshot.json").files) {
    if (hash(file.path) !== file.sha256)
      errors.push(`${file.path}: source changed since review snapshot; reconcile before applying`);
  }
  if (!equal(manifest.files.map((f) => f.file).sort(), files))
    errors.push("Manifest file list differs from review folder.");
  for (const file of files) {
    const document = readJson(file);
    if (document.format_version !== 1 || !Array.isArray(document.entries)) {
      errors.push(`${file}: invalid review format`);
      continue;
    }
    if (manifest.files.find((f) => f.file === file)?.entries !== document.entries.length)
      errors.push(`${file}: entry count differs from manifest`);
    for (const entry of document.entries) {
      count++;
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        errors.push(`${file}: invalid entry object`);
        continue;
      }
      if (typeof entry.id !== "string" || seen.has(entry.id))
        errors.push(`${file}: missing or duplicate ID ${entry.id}`);
      seen.add(entry.id);
      const source = sourceEntries.get(entry.id);
      const approvedLocales = Array.isArray(entry.approved_locales) ? entry.approved_locales : [];
      if (
        source &&
        (!equal(source.current, entry.current) ||
          source.key !== entry.key ||
          !equal(source.sources, entry.sources))
      )
        errors.push(`${entry.id}: source text or metadata has changed, or snapshot was edited`);
      if (!source) errors.push(`${entry.id}: unknown review ID`);
      const base = entry.current?.en ?? entry.current?.fa;
      if (typeof base !== "string") {
        errors.push(`${entry.id}: missing source text`);
        continue;
      }
      if (!equal(tokens(base), entry.placeholders))
        errors.push(`${entry.id}: placeholder metadata differs from source`);
      if (
        !Array.isArray(entry.approved_locales) ||
        new Set(entry.approved_locales).size !== entry.approved_locales.length ||
        entry.approved_locales.some((l) => !["en", "fa", "ps"].includes(l))
      )
        errors.push(`${entry.id}: invalid approved_locales`);
      for (const locale of ["en", "fa", "ps"]) {
        const proposed = entry.proposed?.[locale];
        if (proposed !== null && (typeof proposed !== "string" || !proposed.trim()))
          errors.push(`${entry.id}: invalid proposed ${locale} text`);
        if (typeof proposed === "string" && !equal(tokens(base), tokens(proposed)))
          errors.push(`${entry.id}: proposed ${locale} placeholders differ`);
        if (approvedLocales.includes(locale)) {
          approved++;
          if (typeof (proposed ?? entry.current?.[locale]) !== "string")
            errors.push(`${entry.id}: approved ${locale} has no text`);
        }
      }
      if (typeof entry.proposed?.ps !== "string" || !entry.proposed.ps.trim())
        errors.push(`${entry.id}: Pashto draft missing`);
      if (!Array.isArray(entry.sources) || !entry.sources.length)
        errors.push(`${entry.id}: source location missing`);
      for (const loc of Array.isArray(entry.sources) ? entry.sources : []) {
        if (!loc || typeof loc.path !== "string") {
          errors.push(`${entry.id}: invalid source location`);
          continue;
        }
        const resolved = path.resolve(root, loc.path);
        if (!resolved.startsWith(`${root}${path.sep}`) || !fs.existsSync(resolved)) {
          errors.push(`${entry.id}: invalid source path`);
          continue;
        }
        if (
          !Number.isInteger(loc.line) ||
          loc.line < 1 ||
          loc.line > fs.readFileSync(resolved, "utf8").split(/\r?\n/).length
        )
          errors.push(`${entry.id}: invalid source line`);
      }
    }
  }
  for (const id of sourceEntries.keys())
    if (!seen.has(id)) errors.push(`Missing catalog entry ${id}`);
  if (count !== manifest.totals.review) errors.push("Total review count differs from manifest");
  if (errors.length) {
    console.error(errors.join("\n"));
    process.exitCode = 1;
  } else
    console.log(
      `Valid: ${count} entries; all ${catalogEntries.length} catalog keys present; Pashto drafts, placeholders and source drift checked; ${approved} locale approvals. Application translations unchanged.`,
    );
}

const locales = ["en", "fa", "ps"];
const digest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const bindingCache = new Map();

function variable(file, name) {
  const cacheKey = `${file}:${name}`;
  if (bindingCache.has(cacheKey)) return bindingCache.get(cacheKey);
  const { sf } = parse(file);
  let found;
  walk(sf, (node) => {
    if (ts.isVariableDeclaration(node) && node.name.getText(sf) === name)
      found = { node: unwrap(node.initializer), sf };
  });
  if (!found) throw new Error(`${file}: variable ${name} not found`);
  bindingCache.set(cacheKey, found);
  return found;
}

// Stable semantic selectors replace historical line numbers. For small Go/HTML
// composed messages, fragments are evidence only; application tests check their
// interpolation and actor/amount ordering. No full-file hashes are used here.
function readBinding(binding) {
  const resolved = path.resolve(root, binding.path);
  if (!resolved.startsWith(`${root}${path.sep}`)) throw new Error("Invalid runtime source path");
  if (binding.kind === "ts") {
    const { node: start, sf } = variable(binding.path, binding.variable);
    let node = start;
    if (binding.record) {
      if (!ts.isArrayLiteralExpression(node)) throw new Error("Expected record array");
      node = node.elements
        .map(unwrap)
        .find(
          (item) =>
            ts.isObjectLiteralExpression(item) &&
            item.properties.some(
              (prop) =>
                ts.isPropertyAssignment(prop) &&
                prop.name.text === binding.record.field &&
                staticString(prop.initializer) === binding.record.value,
            ),
        );
    }
    for (const key of binding.keys ?? []) {
      node = unwrap(node);
      if (ts.isArrayLiteralExpression(node)) node = node.elements[key];
      else if (ts.isObjectLiteralExpression(node)) {
        const prop = node.properties.find((p) => ts.isPropertyAssignment(p) && p.name.text === key);
        node = prop?.initializer;
      } else throw new Error(`Missing runtime selector ${key}`);
      if (!node) throw new Error(`Missing runtime selector ${key}`);
    }
    const text = staticString(node);
    if (text === null) throw new Error("Runtime selector is not a static string");
    return { text, line: lineAt(sf, node) };
  }
  if (binding.kind === "json") {
    let value = readJson(binding.path);
    for (const key of binding.keys) value = value?.[key];
    if (typeof value !== "string") throw new Error("Missing JSON translation");
    return { text: value, line: 1 };
  }
  if (binding.kind === "xml") {
    const source = read(binding.path);
    const match = source.match(new RegExp(`<string name="${binding.name}">([^<]*)</string>`));
    if (!match) throw new Error("Missing Android string resource");
    return {
      text: match[1].replaceAll("&amp;", "&").replaceAll("&lt;", "<").replaceAll("&gt;", ">"),
      line: source.slice(0, match.index).split("\n").length,
    };
  }
  if (binding.kind === "fragments") {
    const source = read(binding.path);
    const decoded = [];
    if (/\.[jt]sx?$/.test(binding.path))
      walk(parse(binding.path).sf, (node) => {
        if (ts.isStringLiteralLike(node)) decoded.push(node.text);
      });
    for (const match of source.matchAll(/"(?:\\.|[^"\\])*"/g)) {
      try {
        decoded.push(JSON.parse(match[0]));
      } catch {
        /* Go escapes may differ. */
      }
    }
    const evidence = [source, ...decoded];
    if (
      !binding.fragments?.length ||
      binding.fragments.some((part) => !evidence.some((s) => s.includes(part)))
    )
      throw new Error("Runtime message fragments changed or disappeared");
    const at = source.indexOf(binding.fragments[0]);
    return { text: binding.text, line: at < 0 ? 1 : source.slice(0, at).split("\n").length };
  }
  throw new Error(`Unknown runtime binding ${binding.kind}`);
}

function loadImplementation() {
  bindingCache.clear();
  const baseline = readJson("docs/language-review/review-baseline.json");
  const ledger = readJson("docs/language-review/implementation.json");
  const documents = reviewFiles().map((file) => ({ file, ...readJson(file) }));
  const runtime = Object.entries(catalogs).flatMap(([surface, file]) =>
    extractCatalog(surface, file),
  );
  return { baseline, ledger, documents, runtime };
}

function implementationErrors({ baseline, ledger, documents, runtime }, checkSources = true) {
  const errors = [];
  const immutable = new Map(baseline.entries.map((entry) => [entry.id, entry]));
  const applied = new Map();
  const seen = new Set();
  for (const entry of ledger.entries) {
    if (applied.has(entry.id)) errors.push(`Duplicate implementation ID ${entry.id}`);
    applied.set(entry.id, entry);
  }
  if (
    immutable.size !== baseline.entries.length ||
    digest(baseline.entries) !== ledger.snapshot.entries_sha256
  )
    errors.push("Immutable review baseline changed or contains duplicate IDs");
  if (ledger.snapshot.original_entries !== 1828 || baseline.original_entries !== 1828)
    errors.push("Original 1,828-row snapshot provenance changed");
  const immutableFields = [
    "id",
    "key",
    "current",
    "sources",
    "placeholders",
    "references",
    "context",
  ];
  for (const document of documents) {
    if (document.format_version !== 1 || !Array.isArray(document.entries)) {
      errors.push(`${document.file}: invalid review format`);
      continue;
    }
    for (const entry of document.entries) {
      if (!entry || typeof entry !== "object" || typeof entry.id !== "string") {
        errors.push(`${document.file}: invalid review entry`);
        continue;
      }
      if (seen.has(entry.id)) errors.push(`Duplicate review ID ${entry.id}`);
      seen.add(entry.id);
      const original = immutable.get(entry.id);
      const implementation = applied.get(entry.id);
      const approvedLocales = Array.isArray(entry.approved_locales) ? entry.approved_locales : [];
      const placeholderList = Array.isArray(entry.placeholders) ? entry.placeholders : [];
      if (!original || !implementation) {
        errors.push(`${entry.id}: unknown review ID`);
        continue;
      }
      for (const field of immutableFields)
        if (!equal(entry[field], original[field]))
          errors.push(`${entry.id}: immutable snapshot ${field} changed`);
      if (implementation.review_file !== document.file)
        errors.push(`${entry.id}: review file mapping changed`);
      if (
        !Array.isArray(entry.approved_locales) ||
        new Set(entry.approved_locales).size !== entry.approved_locales.length ||
        entry.approved_locales.some((l) => !locales.includes(l))
      )
        errors.push(`${entry.id}: invalid approved_locales`);
      const base = entry.current?.en ?? entry.current?.fa;
      if (typeof base !== "string" || !equal(tokens(base), entry.placeholders))
        errors.push(`${entry.id}: snapshot placeholder metadata changed`);
      for (const lang of locales) {
        const proposed = entry.proposed?.[lang];
        if (proposed !== null && (typeof proposed !== "string" || !proposed.trim()))
          errors.push(`${entry.id}: invalid proposed ${lang} text`);
        const removed = implementation.placeholder_exceptions?.[lang]?.removed ?? [];
        const signature = placeholderList.filter((token) => !removed.includes(token));
        if (typeof proposed === "string" && !equal(tokens(proposed), signature))
          errors.push(`${entry.id}: proposed ${lang} placeholders differ`);
        if (
          approvedLocales.includes(lang) &&
          typeof (proposed ?? entry.current?.[lang]) !== "string"
        )
          errors.push(`${entry.id}: approved ${lang} has no text`);
      }
      if (typeof entry.proposed?.ps !== "string" || !entry.proposed.ps.trim())
        errors.push(`${entry.id}: Pashto decision missing`);
      if (
        !Array.isArray(entry.sources) ||
        !entry.sources.length ||
        entry.sources.some(
          (loc) =>
            !loc || typeof loc.path !== "string" || !Number.isInteger(loc.line) || loc.line < 1,
        )
      )
        errors.push(`${entry.id}: invalid historical source location`);
      if (digest(implementation.effective) !== implementation.text_sha256)
        errors.push(`${entry.id}: implementation text fingerprint changed`);
      if (checkSources && !implementation.catalog)
        for (const binding of implementation.runtime_sources) {
          try {
            const actual = readBinding(binding);
            if (actual.text !== implementation.effective[binding.locale])
              errors.push(
                `${entry.id}: runtime ${binding.locale} differs from implementation ledger`,
              );
          } catch (error) {
            errors.push(`${entry.id}: ${binding.locale} source drift: ${error.message}`);
          }
        }
    }
  }
  for (const id of immutable.keys()) if (!seen.has(id)) errors.push(`Missing review entry ${id}`);
  for (const id of applied.keys())
    if (!immutable.has(id)) errors.push(`Unknown implementation ID ${id}`);
  const catalogIDs = new Set();
  for (const entry of runtime) {
    if (catalogIDs.has(entry.id)) errors.push(`Duplicate runtime catalog ID ${entry.id}`);
    catalogIDs.add(entry.id);
    const expected = applied.get(entry.id);
    if (!expected?.catalog || !seen.has(entry.id)) {
      errors.push(`Unreviewed runtime catalog ID ${entry.id}`);
      continue;
    }
    if (!equal(entry.current, expected.effective))
      errors.push(`${entry.id}: current catalog source drift from implementation ledger`);
    for (const lang of locales) {
      if (typeof entry.current[lang] !== "string" || !entry.current[lang].trim())
        errors.push(`${entry.id}: missing runtime ${lang} translation`);
      else {
        const removed = expected.placeholder_exceptions?.[lang]?.removed ?? [];
        if (
          !equal(
            tokens(entry.current.en).filter((token) => !removed.includes(token)),
            tokens(entry.current[lang]),
          )
        )
          errors.push(`${entry.id}: runtime ${lang} placeholders differ`);
      }
    }
  }
  for (const entry of ledger.entries.filter((entry) => entry.catalog))
    if (!catalogIDs.has(entry.id)) errors.push(`Missing current catalog key ${entry.id}`);
  for (const surface of Object.keys(catalogs)) {
    if (
      runtime.filter((entry) => entry.id.startsWith(surface + ":")).length !==
      ledger.catalogs[surface].keys
    )
      errors.push(`${surface}: current catalog count differs from implementation ledger`);
  }
  if (
    documents.length !== ledger.review_files.length ||
    !equal(documents.map((d) => d.file).sort(), [...ledger.review_files].sort())
  )
    errors.push("Review file list differs from implementation ledger");
  return errors;
}

function validateImplementation() {
  if (!fs.existsSync(path.join(reviewDir, "implementation.json")))
    return validateHistoricalExport();
  const state = loadImplementation();
  const errors = implementationErrors(state);
  for (const [file, expected] of Object.entries(state.ledger.snapshot.artifact_sha256))
    if (hash(file) !== expected) errors.push(`${file}: historical snapshot artifact changed`);
  if (errors.length) {
    console.error(errors.join("\n"));
    process.exitCode = 1;
    return;
  }
  const pending = state.documents
    .flatMap((d) => d.entries)
    .filter((entry) => {
      const applied = state.ledger.entries.find((e) => e.id === entry.id);
      return entry.approved_locales.some(
        (lang) => (entry.proposed[lang] ?? entry.current[lang]) !== applied.approved_text[lang],
      );
    });
  console.log(
    `Valid: ${state.baseline.original_entries} historical rows + ${state.baseline.entries.length - state.baseline.original_entries} supplemental rows; ${state.ledger.catalogs.mobile.keys} mobile and ${state.ledger.catalogs.web.keys} web keys complete in en/fa/ps. IDs, immutable snapshot, placeholders, approvals and implementation source text checked. ${pending.length} corrected review decisions await reconciliation.`,
  );
}

function selftestImplementation() {
  const original = loadImplementation();
  const clean = implementationErrors(original);
  if (clean.length)
    throw new Error(`Cannot run guard checks on invalid records:\n${clean.join("\n")}`);
  const probes = [
    [
      "duplicate IDs",
      (s) => s.documents[0].entries.push(structuredClone(s.documents[0].entries[0])),
    ],
    [
      "removed placeholders",
      (s) => {
        const entry = s.documents.flatMap((d) => d.entries).find((e) => e.placeholders.length);
        entry.proposed.ps = entry.proposed.ps.replace(/\{[^}]+\}/, "");
      },
    ],
    [
      "edited snapshot text",
      (s) => {
        s.documents[0].entries[0].current.en += " changed";
      },
    ],
    ["unknown approval locale", (s) => s.documents[0].entries[0].approved_locales.push("xx")],
    ["missing catalog review row", (s) => s.documents[0].entries.shift()],
    [
      "runtime source drift",
      (s) => {
        s.runtime[0].current.en += " changed";
      },
    ],
    [
      "missing Pashto catalog translation",
      (s) => {
        s.runtime[0].current.ps = null;
      },
    ],
    [
      "edited implementation fingerprint",
      (s) => {
        s.ledger.entries[0].effective.ps += " changed";
      },
    ],
  ];
  for (const [name, mutate] of probes) {
    const state = structuredClone(original);
    mutate(state);
    if (!implementationErrors(state, false).length) throw new Error(`Guard failed: ${name}`);
  }
  console.log(`Passed ${probes.length} negative guard cases without modifying any files.`);
}

export { extractCatalog, readBinding, digest, hash, tokens };

const command = process.argv[2] ?? "validate";
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (command === "export") exportReview();
  else if (command === "validate") validateImplementation();
  else if (command === "selftest") selftestImplementation();
  else if (command === "inventory") {
    const files = trackedFiles();
    const entries = findCandidates(files);
    writeJson("docs/language-review/hardcoded-candidates.json", {
      note: "Additional static copy audit queue, including legal/admin pages and some already-extracted text. Heuristic inventory, not approved translations; custom renderers and external/live content still need runtime review. IDs use snapshot character offsets and should be re-resolved by path and text.",
      entries,
    });
    console.log(`Inventoried ${entries.length} hardcoded copy candidates.`);
  } else
    throw new Error("Usage: node scripts/language-review.mjs [export|validate|selftest|inventory]");
}
