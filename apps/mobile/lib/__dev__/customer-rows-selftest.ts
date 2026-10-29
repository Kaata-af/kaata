// Exercise the real scoped row-retention component. This checks React child
// identities and native visibility props; physical frame timing is a device test.
import assert from "node:assert/strict";
import type { PersonWithBalance } from "../types";
import { colors } from "../colors";
import { compileUI, flattenStyle, jsx, nodes, uiHooks, type UINode } from "./ui-fixture";

const a = { id: "a", name: "A", balance: 10 } as PersonWithBalance;
const b = { id: "b", name: "B", balance: -20 } as PersonWithBalance;
const c = { id: "c", name: "C", balance: 30 } as PersonWithBalance;
const universe = [a, b, c];
const children = (node: UINode): UINode[] =>
  [node.props.children].flat().filter((item) => item && typeof item === "object");
const wrappers = (tree: UINode) => children(tree);
const ids = (tree: UINode) => wrappers(tree).map((row: any) => row.key);
const hidden = (row: UINode) => flattenStyle(row.props.style)?.display === "none";
const visibleIds = (tree: UINode) =>
  wrappers(tree)
    .filter((row) => !hidden(row))
    .map((row: any) => row.key);
const personRow = (wrapper: UINode) => nodes(wrapper).find((node) => node.type === "PersonRow")!;
const rowFor = (tree: UINode, id: string) => wrappers(tree).find((row: any) => row.key === id)!;
const dividers = (tree: UINode) =>
  wrappers(tree)
    .flatMap(children)
    .filter((node) => node.type === "View" && flattenStyle(node.props.style)?.height === 1);
const assertMemoPropsEqual = (actual: UINode, expected: UINode, message: string) => {
  // React.memo's default comparison checks prop values with Object.is. A deep
  // comparison would miss a fresh person object that still rebuilds native text.
  assert.deepEqual(Object.keys(actual.props).sort(), Object.keys(expected.props).sort(), message);
  for (const key of Object.keys(expected.props))
    assert.ok(Object.is(actual.props[key], expected.props[key]), `${message}: ${key}`);
};

function fixture(platform: string, people = [a], complete = universe) {
  const hooks = uiHooks();
  const pressed: PersonWithBalance[] = [];
  const held: PersonWithBalance[] = [];
  const onPersonPress = (person: PersonWithBalance) => pressed.push(person);
  const onPersonLongPress = (person: PersonWithBalance) => held.push(person);
  const { CustomerRows } = compileUI("../../components/CustomerRows", {
    react: hooks.react,
    "react/jsx-runtime": {
      jsx: (type: any, props: any, key: string) => ({ ...jsx(type, props), key }),
      jsxs: (type: any, props: any, key: string) => ({ ...jsx(type, props), key }),
    },
    "react-native": {
      Platform: { OS: platform },
      StyleSheet: { create: (styles: any) => styles },
      View: "View",
    },
    "../lib/colors": { colors },
    "./PersonRow": { PersonRow: "PersonRow" },
  });
  let props: any = {
    people,
    creditByPerson: {},
    sharedStatusByPerson: {},
    onPersonPress,
    onPersonLongPress,
    retained: { scope: "account-a/book-a/AFN", people: complete },
  };
  let tree: UINode;
  const render = (patch: Record<string, unknown> = {}) => {
    props = { ...props, ...patch };
    return (tree = hooks.render(() => CustomerRows(props)));
  };
  render();
  return {
    render,
    hooks,
    pressed,
    held,
    onPersonPress,
    onPersonLongPress,
    get tree() {
      return tree;
    },
    get props() {
      return props;
    },
  };
}

const test = fixture("android");
assert.deepEqual(
  ids(test.tree),
  ["a"],
  "Never mount other accounts from the complete universe upfront",
);
const initialA = rowFor(test.tree, "a");
const initialPersonA = personRow(initialA);
const firstPress = personRow(initialA).props.onPress;
const firstLongPress = personRow(initialA).props.onLongPress;
const initialContent = test.tree.props.children;
test.render({ separated: true });
assert.equal(
  test.tree.props.children,
  initialContent,
  "Unrelated Home updates reuse the row subtree",
);

test.render({ people: [] });
assert.deepEqual(ids(test.tree), ["a"], "A no-results filter preserves existing child identity");
assert.equal(rowFor(test.tree, "a").type, initialA.type);
assert.equal((rowFor(test.tree, "a") as any).key, (initialA as any).key);
assert.equal(hidden(test.tree), true, "No-results retains no visible card border or space");
const hiddenA = rowFor(test.tree, "a");
assert.equal(hiddenA.props.pointerEvents, "none");
assert.equal(hiddenA.props.accessibilityElementsHidden, true);
assert.equal(hiddenA.props.importantForAccessibility, "no-hide-descendants");
assertMemoPropsEqual(
  personRow(hiddenA),
  initialPersonA,
  "A no-results filter leaves unchanged PersonRow props memo-stable",
);
firstPress(a);
firstLongPress(a);
assert.equal(
  test.pressed.length,
  0,
  "Already retained press callbacks cannot open a filtered-out row",
);
assert.equal(test.held.length, 0, "Filtered-out rows cannot open selection/removal menus");

test.render({ people: [b] });
assert.deepEqual(ids(test.tree), ["b", "a"]);
assert.deepEqual(visibleIds(test.tree), ["b"]);
assert.equal(dividers(test.tree).length, 0, "Hidden siblings add no leading divider");
test.render({ people: universe });
assert.deepEqual(ids(test.tree), ["a", "b", "c"]);
assert.equal((rowFor(test.tree, "a") as any).key, (initialA as any).key);
assert.equal(personRow(rowFor(test.tree, "a")).props.onPress, firstPress);
assertMemoPropsEqual(
  personRow(rowFor(test.tree, "a")),
  initialPersonA,
  "Restoring all customers reuses the unchanged row's text subtree",
);
assert.equal(dividers(test.tree).length, 2);
assert.equal(hidden(test.tree), false);
test.render({ people: [c, a, b] });
assert.deepEqual(
  visibleIds(test.tree),
  ["c", "a", "b"],
  "Current requested sort order wins over cache order",
);
assert.equal(dividers(test.tree).length, 2);

const updatedA = { ...a, name: "Updated A", balance: 99, currency: "AFN" } as PersonWithBalance;
test.render({ people: [b], retained: { ...test.props.retained, people: [updatedA, b] } });
assert.deepEqual(
  ids(test.tree),
  ["b", "a"],
  "Deleted or moved-to-settled accounts are purged from the active universe",
);
assert.equal(
  personRow(rowFor(test.tree, "a")).props.person,
  updatedA,
  "Hidden rows use the latest authoritative record",
);
test.render({ people: [updatedA, b], retained: { ...test.props.retained, people: [updatedA] } });
assert.deepEqual(ids(test.tree), ["a"], "A stale visible snapshot cannot retain a removed account");
const projectedA = { ...updatedA, currency: "USD", balance: 5 } as PersonWithBalance;
test.render({ people: [projectedA] });
assert.equal(
  personRow(rowFor(test.tree, "a")).props.person,
  projectedA,
  "Visible currency-filter projections remain intact",
);
firstPress(a);
assert.equal(
  test.pressed.at(-1),
  projectedA,
  "Stable callbacks resolve the latest visible record instead of stale event data",
);
test.render({ selecting: true, selectedIds: new Set(["a"]), selectionBusy: true });
const selected = personRow(rowFor(test.tree, "a"));
assert.equal(selected.props.selecting, true);
assert.equal(selected.props.selected, true);
assert.equal(selected.props.disabled, true);
const beforeBusy = test.pressed.length;
firstPress(a);
firstLongPress(a);
assert.equal(test.pressed.length, beforeBusy);
assert.equal(test.held.length, 0);
test.render({ selectionBusy: false, onPersonLongPress: undefined });
assert.equal(personRow(rowFor(test.tree, "a")).props.onLongPress, undefined);
firstLongPress(a);
assert.equal(test.held.length, 0, "Role downgrade removes even an earlier retained menu callback");

const oldScopePress = personRow(rowFor(test.tree, "a")).props.onPress;
test.render({ people: [b], retained: { scope: "account-b/book-b/AFN", people: universe } });
assert.deepEqual(ids(test.tree), ["b"], "New account/book scope starts with only its visible IDs");
test.render({
  people: [projectedA],
  retained: { scope: "account-a/book-a/AFN", people: universe },
});
const beforeABA = test.pressed.length;
oldScopePress(a);
assert.equal(
  test.pressed.length,
  beforeABA,
  "An old scope lease stays retired after an account/book ABA transition",
);
const livePress = personRow(rowFor(test.tree, "a")).props.onPress;
test.hooks.unmount();
livePress(a);
assert.equal(test.pressed.length, beforeABA, "Unmounted retained rows cannot navigate");

const ios = fixture("ios", universe);
ios.render({ people: [b] });
assert.deepEqual(ids(ios.tree), ["b"], "iOS keeps its existing row mount behavior");
assert.equal(personRow(rowFor(ios.tree, "b")).props.onPress, ios.onPersonPress);
assert.equal(personRow(rowFor(ios.tree, "b")).props.onLongPress, ios.onPersonLongPress);
const ordinary = fixture("android", universe);
ordinary.render({ retained: undefined, people: [b] });
assert.deepEqual(
  ids(ordinary.tree),
  ["b"],
  "Settled history without active-row retention preserves its existing lifecycle",
);

const multiA = {
  ...a,
  currency: "AFN",
  currency_balances: [
    { ...a, currency: "AFN" },
    { ...a, currency: "USD", balance: -5 },
  ],
} as PersonWithBalance;
const fullRecords = [multiA, b, c];
const filtering = fixture("android", fullRecords, fullRecords);
const mountedRows = new Map(
  wrappers(filtering.tree).map((wrapper: any) => [wrapper.key, personRow(wrapper)]),
);
for (const people of [[multiA, c], [b], [], fullRecords, [b], fullRecords]) {
  filtering.render({ people });
  const shown = new Set(people.map((person) => person.id));
  for (const wrapper of wrappers(filtering.tree)) {
    const id = (wrapper as any).key;
    assertMemoPropsEqual(
      personRow(wrapper),
      mountedRows.get(id)!,
      "Direction/empty/all filters preserve every unchanged single/multi-currency row's memo props",
    );
    assert.equal(hidden(wrapper), !shown.has(id));
    assert.equal(wrapper.props.pointerEvents, shown.has(id) ? "auto" : "none");
    assert.equal(wrapper.props.accessibilityElementsHidden, !shown.has(id));
    assert.equal(
      wrapper.props.importantForAccessibility,
      shown.has(id) ? "auto" : "no-hide-descendants",
    );
    const beforePress = filtering.pressed.length;
    const beforeHold = filtering.held.length;
    // Delayed native/assistive callbacks retained before the filter still
    // resolve against visible IDs, not the leaf's unchanged disabled prop.
    mountedRows.get(id)!.props.onPress(fullRecords.find((person) => person.id === id));
    mountedRows.get(id)!.props.onLongPress(fullRecords.find((person) => person.id === id));
    assert.equal(filtering.pressed.length, beforePress + (shown.has(id) ? 1 : 0));
    assert.equal(filtering.held.length, beforeHold + (shown.has(id) ? 1 : 0));
  }
}
filtering.render({ people: [b], selectionBusy: true });
const beforeBusyPress = filtering.pressed.length;
const beforeBusyHold = filtering.held.length;
for (const wrapper of wrappers(filtering.tree)) {
  const leaf = personRow(wrapper);
  assert.equal(leaf.props.disabled, true, "Real busy state disables visible and retained rows");
  leaf.props.onPress(leaf.props.person);
  leaf.props.onLongPress(leaf.props.person);
}
assert.equal(filtering.pressed.length, beforeBusyPress);
assert.equal(filtering.held.length, beforeBusyHold);
filtering.hooks.unmount();

console.log(
  "PASS customer rows: Android filter/empty/return memo-stable leaves without upfront mounting, hidden layout/touch/accessibility, current sort/dividers, authoritative update/delete/settled-universe pruning, currency projections, selection/role/stale/ABA/unmount guards, unchanged iOS and non-retained history",
);
