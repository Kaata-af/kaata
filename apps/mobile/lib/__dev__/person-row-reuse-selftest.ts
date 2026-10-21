// Run the real row through customer reuse. Native touch delivery and microtask
// ordering are controlled boundaries; this does not claim device gesture QA.
import assert from "node:assert/strict";
import { compileUI, jsx, uiHooks, type UINode } from "./ui-fixture";
import type { PersonWithBalance } from "../types";

const hooks = uiHooks();
const queued: (() => void)[] = [];
const pressed: string[] = [],
  held: string[] = [];
const { PersonRow } = compileUI(
  "../../components/PersonRow",
  {
    react: { ...hooks.react, memo: (component: unknown) => component },
    "react/jsx-runtime": { jsx, jsxs: jsx, Fragment: "Fragment" },
    "react-native": {
      Pressable: "Pressable",
      Text: "Text",
      View: "View",
      StyleSheet: { create: (styles: unknown) => styles },
    },
    "@expo/vector-icons": { Ionicons: "Icon" },
    "./SharedAccountBadge": { SharedAccountBadge: "SharedAccountBadge" },
    "./CreditStatusBadge": { CreditStatusBadge: "CreditStatusBadge" },
    "./SelectionMark": { SelectionMark: "SelectionMark" },
    "../lib/colors": { colors: {} },
    "../lib/currency": { getCurrentCurrencySymbol: () => "AFN" },
    "../lib/direction": { useIsRTL: () => false, rowDir: () => ({}), textDir: () => ({}) },
    "../lib/fonts": { fonts: {} },
    "../lib/format": { formatAmount: String, formatRelative: () => "recent" },
    "../lib/i18n": { t: (key: string) => key },
    "../lib/tokens": { icon: { row: 22 } },
  },
  { queueMicrotask: (work: () => void) => queued.push(work) },
);
const a = { id: "a", name: "A", balance: 10, is_settled: 0 } as PersonWithBalance;
const b = { id: "b", name: "B", balance: -20, is_settled: 0 } as PersonWithBalance;
let props = {
  person: a,
  selecting: false,
  onPress: (person: PersonWithBalance) => pressed.push(person.id),
  onLongPress: (person: PersonWithBalance) => held.push(person.id),
};
let row: UINode;
const render = () => (row = hooks.render(() => PersonRow(props)));
const flush = () => {
  while (queued.length) queued.shift()!();
};
const reuse = (person: PersonWithBalance, selecting = false) => {
  props = { ...props, person, selecting };
  render();
};
const reset = () => {
  flush();
  pressed.length = 0;
  held.length = 0;
};
let checks = 0;

render();
row!.props.onPressIn();
row!.props.onPressOut();
row!.props.onPress();
assert.deepEqual(pressed, ["a"], "Ordinary release remains active through synchronous onPress");
flush();
checks++;

for (const selecting of [false, true]) {
  reset();
  reuse(a, selecting);
  row!.props.onPressIn();
  reuse(b, selecting);
  row!.props.onLongPress();
  row!.props.onPressOut();
  row!.props.onPress();
  assert.deepEqual(pressed, [], "A held press cannot activate the replacement customer");
  assert.deepEqual(held, [], "A held long press cannot target the replacement customer");
  flush();
  checks++;

  row!.props.onPressIn();
  row!.props.onLongPress();
  assert.deepEqual(
    selecting ? pressed : held,
    ["b"],
    "A fresh hold preserves selection/action semantics after reuse",
  );
  row!.props.onPressOut();
  flush();
  checks++;
}

reset();
reuse(b);
row!.props.onPressIn();
row!.props.onPressOut();
row!.props.onPress();
assert.deepEqual(
  pressed,
  ["b"],
  "Fresh pointer activation uses the recycled row's current customer",
);
flush();
checks++;

reset();
reuse(a);
row!.props.onPressIn();
row!.props.onPressOut();
reuse(b);
row!.props.onPressIn();
flush(); // An earlier press's queued clear must not erase the newer press.
reuse(a);
row!.props.onPress();
row!.props.onLongPress();
assert.deepEqual(pressed, [], "Old queued clear cannot unbind a newer held press");
assert.deepEqual(held, [], "Long press retains the newer press's identity after old clear");
row!.props.onPressOut();
flush();
checks++;

reset();
reuse(b);
row!.props.onPress();
row!.props.onAccessibilityAction({ nativeEvent: { actionName: "longpress" } });
assert.deepEqual(pressed, ["b"], "Accessibility/keyboard activation works without a pointer token");
assert.deepEqual(held, ["b"], "Explicit accessibility long-press targets the current customer");
checks++;

reset();
reuse(a);
row!.props.onPressIn();
reuse(b);
row!.props.onAccessibilityAction({ nativeEvent: { actionName: "longpress" } });
assert.deepEqual(
  held,
  ["b"],
  "Explicit accessibility action is independent of a held pointer's old identity",
);
row!.props.onPressOut();
flush();
checks++;

reset();
const pending = queued.length;
row!.props.onPressIn();
row!.props.onPressOut();
hooks.unmount();
flush();
assert.equal(
  queued.length,
  pending,
  "Queued cleanup drains without adding deferred work after unmount",
);
assert.equal(hooks.lateWrites, 0, "Press cleanup never writes React state after unmount");
checks++;

console.log(
  `PASS person row reuse: ${checks} groups; press/hold identity, selection, accessibility, queued clear and cleanup`,
);
