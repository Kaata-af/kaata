// Run the installed Expo localization plugin through native introspection.
// This checks the native build contract, not a second JS model of RTL policy.
// Introspection never writes native projects, preferences, or ledger files.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { compileModsAsync } from "@expo/config-plugins";
import type { ExpoConfig } from "expo/config";

const projectRoot = resolve(__dirname, "../..");
const app = JSON.parse(readFileSync(resolve(projectRoot, "app.json"), "utf8")).expo;
const localization = app.plugins.find(
  (plugin: string | [string, unknown]) =>
    Array.isArray(plugin) && plugin[0] === "expo-localization",
);
assert.ok(localization, "the native localization plugin must remain configured");
const options = localization[1];
assert.equal(options.supportsRTL, false);
assert.equal(options.forcesRTL, false);
assert.deepEqual(options.supportedLocales, ["en", "fa", "ps"]);

const pluginRoot = dirname(require.resolve("expo-localization/package.json"));
const withLocalization = require(resolve(pluginRoot, "plugin/build/withExpoLocalization")).default;

async function inspect(config: ExpoConfig, pluginOptions: typeof options) {
  const native = await compileModsAsync(
    withLocalization({ ...config, _internal: { projectRoot } }, pluginOptions),
    {
      projectRoot,
      platforms: ["android", "ios"],
      introspect: true,
      ignoreExistingNativeFiles: true,
    },
  );
  return native._internal!.modResults as {
    android: {
      manifest: { manifest: { application: Array<{ $: Record<string, string> }> } };
      strings: { resources: { string?: Array<{ $: { name: string }; _: string }> } };
    };
    ios: { infoPlist: Record<string, unknown> };
  };
}

async function main() {
  const native = await inspect(structuredClone(app), options);
  const application = native.android.manifest.manifest.application[0].$;
  assert.equal(
    application["android:supportsRtl"],
    "false",
    "Android must start LTR even with an old forced-RTL preference",
  );
  assert.equal(application["android:localeConfig"], "@xml/locales_config");
  assert.equal(
    native.android.strings.resources.string?.find(
      (entry) => entry.$.name === "ExpoLocalization_supportsRTL",
    )?._,
    "false",
    "Expo native initialization must not re-enable RTL from the phone language",
  );
  assert.equal(native.ios.infoPlist.ExpoLocalization_supportsRTL, false);
  assert.equal(
    native.ios.infoPlist.ExpoLocalization_forcesRTL,
    false,
    "iOS must also clear historical forceRTL(true), which overrides allowRTL(false)",
  );
  assert.deepEqual(native.ios.infoPlist.CFBundleLocalizations, ["en", "fa", "ps"]);

  // Negative control: the old supportedLocales-only config really produces
  // native RTL support. The plugin also omits forcesRTL:false by default,
  // making the explicit iOS Info.plist key above necessary for old installs.
  const previous = structuredClone(app);
  delete previous.ios.infoPlist.ExpoLocalization_forcesRTL;
  const oldNative = await inspect(previous, { supportedLocales: options.supportedLocales });
  assert.equal(oldNative.android.manifest.manifest.application[0].$["android:supportsRtl"], "true");
  assert.equal(oldNative.ios.infoPlist.ExpoLocalization_forcesRTL, undefined);

  console.log(
    "PASS RTL native startup: actual Expo plugin emits Android LTR manifest/resource, iOS allow/force false, and keeps English/Dari/Pashto; old config reproduces unsafe defaults without modifying app data",
  );
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
