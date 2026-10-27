// Exercise the installed React Native Pressability state machine with the real
// rows. Calling onLongPress/onPress directly misses the release-time prop check
// that caused search selection to undo itself when the finger lifted.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { colors } from "../colors";
import { compileUI, jsx, nodes, uiHooks } from "./ui-fixture";

const { transformSync } = require("@babel/core");
const pressabilityCode = transformSync(
  readFileSync(require.resolve("react-native/Libraries/Pressability/Pressability"), "utf8"),
  {
    babelrc: false,
    configFile: false,
    plugins: [
      require.resolve("babel-plugin-syntax-hermes-parser"),
      require.resolve("@babel/plugin-transform-flow-strip-types"),
      require.resolve("@babel/plugin-transform-modules-commonjs"),
    ],
  },
).code;

function loadPressability(os: "android" | "ios") {
  let timerId = 0;
  const timers = new Map<number, () => void>();
  const mocks: Record<string, any> = {
    "../../src/private/featureflags/ReactNativeFeatureFlags": {
      shouldPressibilityUseW3CPointerEventsForHover: () => false,
    },
    "../Components/Sound/SoundManager": { playTouchSound: () => undefined },
    "../ReactNative/UIManager": {
      measure: (_id: number, done: (...bounds: number[]) => void) => done(0, 0, 300, 60, 0, 0),
    },
    "../StyleSheet/Rect": { normalizeRect: (value: unknown) => value },
    "../Utilities/Platform": { OS: os },
    "./HoverState": { isHoverEnabled: () => false },
    "./PressabilityPerformanceEventEmitter.js": { emitEvent: () => undefined },
    invariant: (condition: boolean, message: string) => assert.ok(condition, message),
  };
  const module = { exports: {} as any };
  new Function("require", "module", "exports", "setTimeout", "clearTimeout", pressabilityCode)(
    (name: string) => {
      assert.ok(name in mocks, `Unexpected native Pressability dependency: ${name}`);
      return mocks[name];
    },
    module,
    module.exports,
    (run: () => void) => {
      timers.set(++timerId, run);
      return timerId;
    },
    (id: number) => timers.delete(id),
  );
  return {
    Pressability: module.exports.default,
    hold() {
      const pending = [...timers.values()];
      timers.clear();
      pending.forEach((run) => run());
    },
  };
}

function rowFixture(kind: "contact" | "tally") {
  const hooks = uiHooks();
  const react = { ...hooks.react, memo: (component: unknown) => component };
  const mocks = {
    react,
    "react/jsx-runtime": { jsx, jsxs: jsx, Fragment: "Fragment" },
    "react-native": {
      Pressable: "Pressable",
      View: "View",
      Text: "Text",
      StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
    },
    "@expo/vector-icons": { Ionicons: "Icon" },
    "./Button": { Button: "Button" },
    "./InitialAvatar": { InitialAvatar: "InitialAvatar" },
    "./SelectionMark": { SelectionMark: "SelectionMark" },
    "./SharedAccountBadge": { SharedAccountBadge: "SharedAccountBadge" },
    "./CreditStatusBadge": { CreditStatusBadge: "CreditStatusBadge" },
    "../lib/attribution": { chipActorFor: () => null },
    "../lib/calendar": { useCalendar: () => undefined },
    "../lib/colors": { colors },
    "../lib/currency": {
      getCurrentCurrencySymbol: () => "AFN",
      getCurrentCurrencyCode: () => "AFN",
      getCurrencyLabel: (code: string) => code,
    },
    "../lib/direction": {
      useIsRTL: () => false,
      rowDir: () => ({ flexDirection: "row" }),
      textDir: () => ({ textAlign: "left" }),
      trackingSafe: () => null,
    },
    "../lib/fonts": {
      fonts: {},
      sansLineHeight: (_size: number, height: number) => height,
    },
    "../lib/format": {
      formatAmount: String,
      formatRelative: () => "yesterday",
      formatTimestamp: () => "12:00",
    },
    "../lib/i18n": { t: (key: string) => key },
    "../lib/multi-currency-view": require("../multi-currency-view"),
    "../lib/tabs/link-status": require("../tabs/link-status"),
    "../lib/tokens": { icon: { row: 22 }, radius: { sm: 8, md: 12, pill: 999 } },
  };
  const Row =
    kind === "contact"
      ? compileUI("../../components/PersonRow", mocks).PersonRow
      : compileUI("../../components/EntryRow", mocks).EntryRow;
  const row = { id: "one", name: "Ahmad", balance: 10, amount: 10, type: "debt", created_at: 1 };
  let selecting = false,
    selected = false,
    disabled = false,
    starts = 0,
    toggles = 0,
    opens = 0;
  const toggle = () => {
    selected = !selected;
    toggles++;
  };
  const render = () => {
    const tree = hooks.render(() =>
      Row({
        person: row,
        entry: row,
        selecting,
        selected,
        disabled,
        selectionDisabled: disabled,
        onPress: () => (selecting ? toggle() : opens++),
        onToggleSelection: toggle,
        onLongPress: selecting
          ? undefined
          : () => {
              starts++;
              selecting = true;
              selected = true;
            },
      }),
    );
    const body = nodes(tree).find((node) => node.type === "Pressable");
    assert.ok(body, `${kind} has a tappable row`);
    return body.props;
  };
  return {
    render,
    get selected() {
      return selected;
    },
    get starts() {
      return starts;
    },
    get toggles() {
      return toggles;
    },
    get opens() {
      return opens;
    },
    disable() {
      disabled = true;
    },
  };
}

for (const os of ["android", "ios"] as const) {
  for (const kind of ["contact", "tally"] as const) {
    const fixture = rowFixture(kind);
    const { Pressability, hold } = loadPressability(os);
    const machine = new Pressability(fixture.render());
    const handlers = machine.getEventHandlers();
    const event = {
      currentTarget: 1,
      target: 1,
      nativeEvent: { pageX: 20, pageY: 20 },
      persist: () => undefined,
    };
    const refresh = () => machine.configure(fixture.render());
    const tap = () => {
      handlers.onResponderGrant(event);
      handlers.onResponderRelease(event);
      refresh();
    };

    tap();
    if (kind === "contact") assert.equal(fixture.opens, 1);
    else assert.equal(fixture.render().accessibilityState.expanded, true);

    handlers.onResponderGrant(event);
    hold();
    refresh(); // Entering selection removes the parent's start callback.
    assert.equal(fixture.starts, 1);
    assert.equal(fixture.selected, true);
    handlers.onResponderRelease(event);
    refresh();
    assert.equal(fixture.selected, true, `${os} ${kind}: release must retain the first selection`);
    assert.equal(fixture.toggles, 0, "The initiating gesture must not also run a normal tap");

    tap();
    assert.equal(fixture.selected, false, "The next ordinary tap is never swallowed");
    assert.equal(fixture.toggles, 1);
    handlers.onResponderGrant(event);
    hold();
    refresh();
    handlers.onResponderRelease(event);
    refresh();
    assert.equal(fixture.selected, true, "Holding an already selectable row toggles exactly once");
    assert.equal(fixture.toggles, 2);

    handlers.onClick(event); // TalkBack/VoiceOver activation has no press-in.
    refresh();
    assert.equal(fixture.selected, false, "Accessibility activation works after a hold");
    assert.equal(fixture.toggles, 3);
    handlers.onResponderGrant(event);
    handlers.onResponderTerminate(event); // A scroll cancels the gesture.
    refresh();
    assert.equal(fixture.toggles, 3);
    tap();
    assert.equal(fixture.toggles, 4, "A canceled gesture does not poison the next tap");

    fixture.disable();
    refresh();
    assert.equal(handlers.onStartShouldSetResponder(), false);
    handlers.onClick(event);
    assert.equal(fixture.toggles, 4, "Disabled rows reject touch and accessibility activation");
    machine.reset();
  }
}

console.log(
  "PASS selection gestures: real RN Pressability, Android/iOS, contact/tally, rerender before release, subsequent taps, hold-to-toggle, accessibility, canceled and disabled gestures",
);
