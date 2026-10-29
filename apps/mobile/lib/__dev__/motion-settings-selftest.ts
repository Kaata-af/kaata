import assert from "node:assert/strict";
import { compileUI, deferred, jsx, nodes, settleUI, uiHooks } from "./ui-fixture";
import type { MotionMode } from "../motion-preference";

const language = compileUI("../i18n", {
  "expo-localization": { getLocales: () => [{ languageCode: "en" }] },
  "./db": { getAppMeta: async () => null },
}) as typeof import("../i18n");

function fixture(locale: "en" | "fa" | "ps", initialized = true) {
  language.setLocale(locale);
  const hooks = uiHooks();
  let mode: MotionMode = "auto";
  let ready = initialized;
  let focused = true;
  let reducedBySystem = false;
  const calls: MotionMode[] = [];
  const messages: { text: string; tone: string }[] = [];
  const saves: ReturnType<typeof deferred<void>>[] = [];
  const component = compileUI("../../components/MotionPreferenceSetting", {
    react: hooks.react,
    "react/jsx-runtime": { jsx, jsxs: jsx, Fragment: "Fragment" },
    "expo-router": { useIsFocused: () => focused },
    "../lib/direction": { useIsRTL: () => locale !== "en" },
    "../lib/i18n": language,
    "../lib/motion-preference": {
      useMotionPreference: () => ({
        mode,
        initialized: ready,
        effectiveReducedMotion: reducedBySystem || mode === "reduced",
        setMode: (next: MotionMode) => {
          calls.push(next);
          const old = mode;
          mode = next;
          const save = deferred<void>();
          saves.push(save);
          return save.promise.catch((error) => {
            mode = old;
            throw error;
          });
        },
      }),
    },
    "./OptionSheet": { OptionSheet: "OptionSheet" },
    "./SettingsScreen": { NavRow: "NavRow" },
    "./Toast": {
      useToast: () => ({ push: (text: string, tone: string) => messages.push({ text, tone }) }),
    },
  });
  const render = () => hooks.render(() => component.MotionPreferenceSetting());
  const row = () => nodes(hooks.tree).find((node) => node.type === "NavRow")!;
  const sheet = () => nodes(hooks.tree).find((node) => node.type === "OptionSheet")!;
  const open = () => {
    row().props.onPress();
    render();
    assert.equal(sheet().props.visible, true);
    return sheet();
  };
  render();
  return {
    hooks,
    render,
    row,
    sheet,
    open,
    calls,
    messages,
    saves,
    setReady: (value: boolean) => {
      ready = value;
      render();
    },
    setFocused: (value: boolean) => {
      focused = value;
      render();
    },
    setSystemReduced: (value: boolean) => {
      reducedBySystem = value;
      render();
    },
  };
}

async function main() {
  for (const locale of ["en", "fa", "ps"] as const) {
    const current = fixture(locale);
    assert.equal(current.row().props.label, language.t("settings.motion.label"));
    assert.equal(current.row().props.trailing, language.t("settings.motion.option.auto"));
    assert.equal(current.row().props.disabled, false);
    assert.equal(current.row().props.isRTL, locale !== "en");
    const sheet = current.open();
    assert.equal(sheet.props.isRTL, locale !== "en");
    assert.deepEqual(
      sheet.props.options.map((item: any) => item.key),
      ["auto", "full", "reduced"],
    );
    for (const option of sheet.props.options) {
      assert.ok(option.label && option.hint);
      assert.equal(
        option.label.startsWith("settings.motion."),
        false,
        "Translated option labels exist",
      );
      assert.equal(
        option.hint.startsWith("settings.motion."),
        false,
        "Translated option hints exist",
      );
    }
    sheet.props.onSelect("invalid");
    assert.deepEqual(current.calls, []);
    assert.equal(current.sheet().props.visible, true);
    sheet.props.onSelect("reduced");
    sheet.props.onSelect("full");
    current.render();
    assert.deepEqual(current.calls, ["reduced"], "Only one save can start before the UI commits");
    assert.equal(current.sheet().props.visible, false);
    assert.equal(current.row().props.trailing, language.t("settings.motion.option.reduced"));
    assert.equal(current.row().props.disabled, true);
    current.row().props.onPress();
    current.render();
    assert.equal(current.sheet().props.visible, false, "Saving row cannot reopen its sheet");
    current.saves[0].resolve();
    await settleUI();
    current.render();
    assert.equal(current.row().props.disabled, false);
    assert.deepEqual(current.messages, []);

    const same = current.open();
    same.props.onSelect("reduced");
    current.render();
    assert.equal(current.sheet().props.visible, false);
    assert.equal(current.calls.length, 1, "Selecting current preference performs no write");

    const old = current.open();
    old.props.onDismiss();
    current.render();
    const newer = current.open();
    old.props.onSelect("full");
    old.props.onDismiss();
    current.render();
    assert.equal(current.calls.length, 1, "A closed presentation stays retired after reopening");
    assert.equal(current.sheet().props.visible, true);
    newer.props.onSelect("auto");
    current.saves[1].reject(new Error("Fixture preference write failed"));
    await settleUI();
    current.render();
    assert.equal(current.row().props.trailing, language.t("settings.motion.option.reduced"));
    assert.deepEqual(current.messages, [
      { text: language.t("settings.motion.saveFailed"), tone: "error" },
    ]);
    assert.equal(current.row().props.disabled, false, "A failed preference can be retried");

    current.setSystemReduced(true);
    current.open().props.onSelect("full");
    current.saves[2].resolve();
    await settleUI();
    current.render();
    assert.equal(current.row().props.trailing, language.t("settings.motion.option.full"));
    assert.equal(
      current.calls.at(-1),
      "full",
      "System preference does not erase the user's stored choice",
    );

    const departing = current.open();
    departing.props.onSelect("auto");
    current.hooks.unmount();
    const toastCount = current.messages.length;
    departing.props.onSelect("reduced");
    current.saves[3].reject(new Error("Fixture departed write failed"));
    await settleUI();
    assert.equal(current.messages.length, toastCount, "No toast after leaving this screen");
    assert.equal(current.hooks.lateWrites, 0);
  }

  const loading = fixture("en", false);
  assert.equal(loading.row().props.disabled, true);
  loading.row().props.onPress();
  loading.render();
  assert.equal(loading.sheet().props.visible, false);
  loading.setReady(true);
  loading.open();

  const hidden = fixture("en");
  const oldPresentation = hidden.open();
  hidden.setFocused(false);
  oldPresentation.props.onSelect("reduced");
  hidden.render();
  assert.equal(hidden.sheet().props.visible, false);
  assert.equal(hidden.calls.length, 0, "A hidden settings screen cannot start a preference write");
  hidden.setFocused(true);
  hidden.open();
  oldPresentation.props.onSelect("reduced");
  assert.equal(hidden.calls.length, 0, "A focus ABA transition retires the old sheet");
  hidden.sheet().props.onSelect("reduced");
  hidden.setFocused(false);
  hidden.saves[0].reject(new Error("Fixture background save failed"));
  await settleUI();
  assert.deepEqual(hidden.messages, [], "A failure stays quiet after navigating away");
  console.log(
    "PASS motion settings: device preference choices and EN/FA/PS hints, RTL, pending load/save, immediate selection, duplicate/stale/reopened/unmounted guards, no-op current mode, failure feedback and retry",
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
