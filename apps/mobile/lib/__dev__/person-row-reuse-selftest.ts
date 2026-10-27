// Run the real row through customer reuse. Native touch delivery and microtask
// ordering are controlled boundaries; this does not claim device gesture QA.
import assert from "node:assert/strict";
import { compileUI, flattenStyle, jsx, nodes, uiHooks, type UINode } from "./ui-fixture";
import type { PersonWithBalance } from "../types";
import { filterCustomerCurrencyRows } from "../customer-list";
import { personSharedAccountStatus } from "../tabs/link-status";

const hooks = uiHooks();
const queued: (() => void)[] = [];
const pressed: string[] = [],
  held: string[] = [];
let rowRTL = false;
const colors = require("../colors").colors;
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
    "../lib/colors": { colors },
    "../lib/currency": {
      getCurrentCurrencyCode: () => "AFN",
      getCurrencyLabel: (code: string) => code,
    },
    "../lib/multi-currency-view": require("../multi-currency-view"),
    "../lib/tabs/link-status": require("../tabs/link-status"),
    "../lib/direction": { useIsRTL: () => rowRTL, rowDir: () => ({}), textDir: () => ({}) },
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
  sharedStatus: undefined as ReturnType<typeof personSharedAccountStatus> | undefined,
  selecting: false,
  onPress: (person: PersonWithBalance) => pressed.push(person.id),
  onLongPress: (person: PersonWithBalance) => held.push(person.id),
};
let row: UINode;
const render = () => (row = hooks.render(() => PersonRow(props)));
const flush = () => {
  while (queued.length) queued.shift()!();
};
const reuse = (
  person: PersonWithBalance,
  selecting = false,
  sharedStatus?: ReturnType<typeof personSharedAccountStatus>,
) => {
  props = { ...props, person, selecting, sharedStatus };
  render();
};
const reset = () => {
  flush();
  pressed.length = 0;
  held.length = 0;
};
let checks = 0;

for (rowRTL of [false, true]) {
  for (const [tab, joined, waiting] of [
    [{}, false, false],
    [{ tab_id: "waiting", tab_closed_at: null, tab_other_joined: 0 }, false, true],
    [{ tab_id: "unknown", tab_closed_at: null }, false, true],
    [{ tab_id: "joined", tab_closed_at: null, tab_other_joined: 1 }, true, false],
    [{ tab_id: "closed", tab_closed_at: 100, tab_other_joined: 1 }, false, false],
    [
      {
        tab_id: "promoted-waiting",
        tab_closed_at: null,
        tab_other_joined: 1,
        currency_balances: [
          { ...a, currency: "AFN", tab_id: "old-joined", tab_closed_at: 100, tab_other_joined: 1 },
          {
            ...a,
            currency: "USD",
            tab_id: "actual-waiting",
            tab_closed_at: null,
            tab_other_joined: 0,
          },
        ],
      },
      false,
      true,
    ],
    [
      {
        tab_id: "waiting-root",
        tab_closed_at: null,
        tab_other_joined: 0,
        currency_balances: [
          { ...a, currency: "AFN", tab_id: "waiting-a", tab_closed_at: null, tab_other_joined: 0 },
          { ...a, currency: "USD", tab_id: "joined-b", tab_closed_at: null, tab_other_joined: 1 },
        ],
      },
      true,
      false,
    ],
  ] as const) {
    reuse({ ...a, ...tab } as PersonWithBalance);
    assert.equal(
      nodes(row!).some((node) => node.type === "SharedAccountBadge"),
      joined,
      "only a confirmed joined open currency account receives the blue badge",
    );
    const waitingText = nodes(row!).find(
      (node) => node.type === "Text" && String(node.props.children).includes("tab.chip.waiting"),
    );
    assert.equal(
      !!waitingText,
      waiting,
      "waiting and unknown membership remain explicit without a joined badge",
    );
    if (waitingText)
      assert.equal(
        flattenStyle(waitingText.props.style).color,
        colors.textSubtle,
        "waiting uses the neutral activity text color",
      );
    checks++;
  }
}
rowRTL = false;

for (rowRTL of [false, true]) {
  for (const status of ["joined", "waiting", "none"] as const) {
    const usd = { ...a, currency: "USD", balance: -25, tab_id: null };
    const contact = {
      ...a,
      currency: "AFN",
      currency_balances: [
        {
          ...a,
          currency: "AFN",
          balance: 100,
          tab_id: "afn-shared",
          tab_closed_at: status === "none" ? 100 : null,
          tab_other_joined: status === "joined" ? 1 : 0,
        },
        usd,
      ],
    } as PersonWithBalance;
    const projected = filterCustomerCurrencyRows([contact], "USD")[0];
    assert.equal(personSharedAccountStatus(projected), "none");
    const fullContactStatus = personSharedAccountStatus(contact);
    assert.equal(fullContactStatus, status);
    reuse(projected, false, fullContactStatus);
    assert.equal(
      nodes(row!).some((node) => node.type === "SharedAccountBadge"),
      status === "joined",
      "full-contact joined identity survives projection onto an unlinked USD balance",
    );
    assert.equal(
      JSON.stringify(row!).includes("tab.chip.waiting"),
      status === "waiting",
      "full-contact waiting identity survives projection without changing confirmed badge semantics",
    );
    const amounts = nodes(row!).filter(
      (node) => node.type === "Text" && node.props.accessibilityLabel,
    );
    assert.deepEqual(
      amounts.map((node) => node.props.children),
      ["25"],
    );
    assert.equal(amounts[0].props.accessibilityLabel, "home.tab.pay, 25 USD");
    assert.equal(
      JSON.stringify(row!).includes('"children":"AFN"'),
      false,
      "badge identity does not restore hidden AFN amounts",
    );
    checks++;
  }
}
const projectedWaiting = {
  ...a,
  currency: "USD",
  tab_id: "waiting-usd",
  tab_closed_at: null,
  tab_other_joined: 0,
} as PersonWithBalance;
reuse(projectedWaiting, false, "none");
assert.equal(
  JSON.stringify(row!).includes("tab.chip.waiting"),
  false,
  "an explicit none status is authoritative rather than falling back",
);
checks++;
rowRTL = false;

reuse({ ...a, balance: 0, tab_id: "shared", tab_pending: 0, tab_pending_count: 1 });
assert.ok(
  JSON.stringify(row!).includes("tab.row.awaiting"),
  "own pending loans remain visibly unconfirmed",
);
assert.ok(
  JSON.stringify(row!).includes("tab.chip.waiting"),
  "waiting to join does not replace outgoing unconfirmed review information",
);
reuse({ ...a, balance: 0, tab_id: "shared", tab_pending: 1, tab_pending_count: 2 });
assert.ok(
  JSON.stringify(row!).includes("tab.row.pending"),
  "incoming reviews keep the actionable subtitle",
);
assert.ok(
  !JSON.stringify(row!).includes("tab.row.awaiting"),
  "one subtitle avoids duplicate pending labels",
);
reuse({ ...a, tab_id: "shared", tab_unsynced: 1, tab_other_joined: 0 });
assert.ok(JSON.stringify(row!).includes("tab.chip.waiting"));
assert.ok(
  JSON.stringify(row!).includes("tab.row.notDownloaded"),
  "not-downloaded guidance survives the waiting prefix",
);
checks++;
reuse(a);
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
