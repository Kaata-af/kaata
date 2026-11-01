// Execute the real recovery screen without bootstrapping storage or navigation.
// A stale native direction must lead to OS settings, never an app-data reset.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { bootText } from "../boot-copy";
import type { LocaleCode } from "../i18n";
import { flattenStyle, jsx, nodes, settleUI, uiHooks, type UINode } from "./ui-fixture";

const layout = ts.createSourceFile(
  "_layout.tsx",
  readFileSync(require.resolve("../../app/_layout"), "utf8"),
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX,
);
const required = new Set([
  "useBootCopy",
  "BootLanguagePicker",
  "BootScreen",
  "MigrationPrompt",
  "migrationStyles",
]);
const declarations = layout.statements.filter((statement) => {
  const name = ts.isFunctionDeclaration(statement)
    ? statement.name?.text
    : ts.isVariableStatement(statement)
      ? statement.declarationList.declarations[0]?.name.getText(layout)
      : undefined;
  return !!name && required.delete(name);
});
assert.equal(required.size, 0, "the recovery fixture must execute the real screen declarations");
const screenCode = ts.transpileModule(
  `${declarations.map((statement) => statement.getText(layout)).join("\n")}\nreturn MigrationPrompt;`,
  { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS } },
).outputText;

const words = (node: any): string =>
  Array.isArray(node)
    ? node.map(words).join("")
    : typeof node === "string"
      ? node
      : words(node?.props?.children ?? []);
function expand(node: any): any {
  if (Array.isArray(node)) return node.map(expand);
  if (!node || typeof node !== "object") return node;
  if (typeof node.type === "function") return expand(node.type(node.props));
  return { ...node, props: { ...node.props, children: expand(node.props.children) } };
}

async function main() {
  for (const os of ["android", "ios"] as const)
    for (const initialLocale of ["en", "fa", "ps"] as const) {
      const hooks = uiHooks();
      let settingsCalls = 0,
        splashHides = 0,
        rejectSettings = false;
      const warnings: unknown[][] = [];
      const forbidden = () => assert.fail("language recovery must not exit, restart or reset data");
      const globals = {
        ...hooks.react,
        Platform: { OS: os },
        Text: "Text",
        View: "View",
        ScrollView: "ScrollView",
        Pressable: "Pressable",
        StyleSheet: { create: (style: unknown) => style },
        colors: require("../colors").colors,
        getLocale: () => initialLocale,
        bootText,
        tIn: (locale: LocaleCode) => ({ en: "kaata.", fa: "کاتا.", ps: "کاټه." })[locale],
        SplashScreen: {
          hideAsync: async () => {
            splashHides++;
            if (initialLocale === "ps") throw new Error("Synthetic splash already hidden");
          },
        },
        Linking: {
          openSettings: async () => {
            settingsCalls++;
            if (rejectSettings) throw new Error("Synthetic settings unavailable");
          },
        },
        forceRestart: forbidden,
        BackHandler: { exitApp: forbidden },
        console: { warn: (...args: unknown[]) => warnings.push(args) },
      };
      const Screen = new Function("require", "exports", ...Object.keys(globals), screenCode)(
        (name: string) => {
          assert.equal(
            name,
            "react/jsx-runtime",
            "recovery needs no storage or native boot modules",
          );
          return { jsx, jsxs: jsx, Fragment: "Fragment" };
        },
        {},
        ...Object.values(globals),
      ) as () => UINode;
      const render = () => hooks.render(() => expand(Screen()));
      const buttons = () => nodes(hooks.tree).filter((node) => node.type === "Pressable");
      const settingsButton = (locale: LocaleCode) =>
        buttons().find((node) => words(node) === bootText(locale, "openAppSettings"));

      render();
      await settleUI();
      assert.equal(hooks.tree.type, "ScrollView", "recovery remains scrollable on short screens");
      assert.equal(flattenStyle(hooks.tree.props.contentContainerStyle).flexGrow, 1);
      assert.equal(splashHides, 1, "the held splash must not cover this early-return screen");
      assert.ok(words(hooks.tree).includes(bootText(initialLocale, "almostReady")));
      assert.ok(
        words(hooks.tree).includes(
          bootText(initialLocale, os === "android" ? "migrationAndroid" : "migrationInstructions"),
        ),
      );
      if (os === "android") {
        const button = settingsButton(initialLocale)!;
        assert.ok(button, "Android offers the non-destructive OS recovery action");
        assert.equal(button.props.accessibilityRole, "button");
        button.props.onPress();
        await settleUI();
        assert.equal(settingsCalls, 1);
        rejectSettings = true;
        button.props.onPress();
        await settleUI();
        assert.equal(settingsCalls, 2);
        assert.equal(
          warnings.length,
          1,
          "failed OS navigation is caught without crashing recovery",
        );
        render();
        assert.ok(settingsButton(initialLocale), "the recovery action survives a settings failure");
        rejectSettings = false;
      } else {
        assert.equal(settingsButton(initialLocale), undefined);
        assert.equal(buttons().length, 3, "iOS shows language choices and manual force-quit copy");
        assert.equal(settingsCalls, 0);
      }
      for (const locale of ["en", "fa", "ps"] as const) {
        const label = { en: "English", fa: "دری", ps: "پښتو" }[locale];
        buttons()
          .find((button) => words(button) === label)!
          .props.onPress();
        render();
        assert.ok(words(hooks.tree).includes(bootText(locale, "almostReady")));
        assert.equal(
          buttons().find((button) => words(button) === label)!.props.accessibilityState.selected,
          true,
        );
        if (os === "android") assert.ok(settingsButton(locale));
      }
      assert.equal(splashHides, 1, "changing recovery language does not rerun startup effects");
      hooks.unmount();
      await settleUI();
      assert.equal(hooks.lateWrites, 0);
    }
  console.log(
    "PASS language restart recovery: EN/FA/PS, OS settings without exit/reset, caught navigation failures, iOS manual guidance, independent language choices and splash release",
  );
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
