import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { bootText, formatBackupAge, type BootKey } from "../boot-copy";
import { compileUI } from "./ui-fixture";

let deviceLanguage = "ps";
let stored: string | null = null;
let unreadable = false;
const language = compileUI("../i18n", {
  "expo-localization": { getLocales: () => [{ languageCode: deviceLanguage }] },
  "./db": {
    getAppMeta: async () => {
      if (unreadable) throw new Error("Synthetic unreadable preference database");
      return stored;
    },
  },
}) as typeof import("../i18n");

const signature = (text: string) =>
  [...text.matchAll(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g)].map((m) => m[1]).sort();
const source = ts.createSourceFile(
  "i18n.ts",
  readFileSync(require.resolve("../i18n"), "utf8"),
  ts.ScriptTarget.Latest,
  true,
);
let keys: string[] = [];
function visit(node: ts.Node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(source) === "en") {
    let table = node.initializer!;
    while (ts.isAsExpression(table)) table = table.expression;
    assert.ok(ts.isObjectLiteralExpression(table));
    keys = table.properties.map((prop) => (prop.name as ts.StringLiteral).text);
  }
  ts.forEachChild(node, visit);
}
visit(source);

async function main() {
  assert.equal(
    language.getLocale(),
    "ps",
    "Pashto device starts in Pashto before preferences load",
  );
  for (const tag of ["ps", "ps-AF", "PS_AF"])
    assert.equal(language.localeFromLanguageTag(tag), "ps");
  for (const tag of ["fa", "fa-AF", "prs-AF"])
    assert.equal(language.localeFromLanguageTag(tag), "fa");
  assert.equal(language.localeFromLanguageTag("en-GB"), "en");
  assert.equal(language.localeFromLanguageTag("fr"), null);
  unreadable = true;
  await language.initLocaleFromPref();
  assert.equal(language.getLocale(), "ps", "failed database read retains safe device language");
  unreadable = false;

  let publications = 0;
  const unsubscribe = language.subscribeLocale(() => publications++);
  stored = "fa";
  await language.initLocaleFromPref();
  stored = "ps";
  await language.initLocaleFromPref();
  assert.equal(publications, 2, "Dari to Pashto publishes even though both use RTL");
  assert.equal(
    await language.getShareLangPref(),
    "ps",
    "Pashto message preference survives reload",
  );
  assert.equal(language.isPersianScript(), true);
  language.setLocale("en");
  const before = language.getLocale();
  assert.equal(language.tIn("ps", "tab.accept"), "ومنئ");
  assert.equal(
    language.getLocale(),
    before,
    "outgoing-language lookup does not change UI language",
  );
  assert.equal(language.isPersianScript(), false);
  deviceLanguage = "ps";
  language.setLocale("system");
  assert.equal(language.getLocale(), "ps");
  unsubscribe();

  assert.ok(keys.length >= 1491);
  for (const key of keys as Parameters<typeof language.t>[0][]) {
    const en = language.tIn("en", key),
      ps = language.tIn("ps", key);
    assert.ok(ps.trim() && ps !== key, `${key}: missing Pashto`);
    assert.deepEqual(signature(ps), signature(en), `${key}: changed placeholder names/repetitions`);
  }
  for (const locale of ["en", "fa", "ps"] as const) {
    assert.equal(
      language.isPlaceholderSelfName(
        "  " + language.tIn(locale, "recovery.selfPlaceholderName") + "  ",
      ),
      true,
    );
    assert.equal(/quiet|آرام|ارامه/i.test(language.tIn(locale, "onboarding.subtitle")), false);
  }
  assert.match(language.tIn("fa", "onboarding.subtitle"), /شخصی/);
  assert.match(language.tIn("ps", "onboarding.subtitle"), /شخصي/);
  assert.equal(language.isPlaceholderSelfName("Sultan"), false);

  const now = 10 * 86_400_000;
  assert.equal(formatBackupAge(null, "ps", now), "");
  assert.equal(formatBackupAge(now + 3_600_000, "ps", now), "");
  assert.equal(formatBackupAge(Number.NaN, "ps", now), "");
  assert.equal(formatBackupAge(now - 3_600_000, "en", now), " from 1 hour ago");
  assert.equal(formatBackupAge(now - 7_200_000, "en", now), " from 2 hours ago");
  assert.equal(formatBackupAge(now - 86_400_000, "en", now), " from 1 day ago");
  assert.equal(formatBackupAge(now - 86_400_000, "ps", now), " چې یوه ورځ مخکې جوړ شوی");
  assert.match(formatBackupAge(now - 172_800_000, "ps", now), /۲ ورځې/);
  for (const locale of ["en", "fa", "ps"] as const) {
    const age = formatBackupAge(now - 7_200_000, locale, now);
    assert.equal(
      /[{}]|ساعتهs/.test(age),
      false,
      "English plural suffix must not leak into another language",
    );
    assert.equal(
      bootText(locale, "contactRecurring", { SUPPORT_CONTACT: "support@kaata.af" }).includes(
        "support@kaata.af",
      ),
      true,
    );
    for (const key of [
      "restoreLocal",
      "restoreAccount",
      "reinstallWarning",
      "backupDamaged",
      "accountRecoveryFailed",
      "diagnosticsIntro",
    ] as BootKey[]) {
      assert.ok(bootText(locale, key).trim());
    }
  }
  assert.match(
    bootText("en", "accountRestoreAvailable"),
    /clears the damaged data.*keeps local backups.*sign in again/,
  );
  console.log(
    `PASS: ${keys.length} Pashto strings/placeholders; locale reload, RTL-language publication, independent message language, restore placeholders and database-independent recovery copy`,
  );
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
