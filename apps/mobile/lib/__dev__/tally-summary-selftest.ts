import assert from "node:assert/strict";
import { summarizeTallyFlows } from "../tally-summary";
import type { Entry } from "../types";

const tally = (
  id: string,
  amount: number,
  type: Entry["type"] = "debt",
  overrides: Partial<Entry> = {},
): Entry => ({
  id,
  relationship_id: "r",
  type,
  amount_afn: amount,
  note: null,
  created_at: 1,
  updated_at: 1,
  deleted_at: null,
  proposed_by_user_id: null,
  accepted_at: null,
  disputed_at: null,
  disputed_reason: null,
  settled_at: null,
  ...overrides,
});
const entryMeta = {
  tab_id: "tab",
  seq: 1,
  created_by: "a",
  by: "me",
  dispute_reason: null,
  other_label: "Peer",
  status: "accepted",
  kind: "entry",
  voided: false,
  local_pending: false,
} as const;

assert.deepEqual(summarizeTallyFlows([]), {
  gave: { count: 0, amount: 0 },
  received: { count: 0, amount: 0 },
});
const preLink = tally("pre", 10.01, "payment", { settled_at: 2 });
const entries = [
  tally("a", 0.1),
  tally("b", 0.2),
  tally("c", 12.34, "payment"),
  tally("pending", 5, "debt", { tab: { ...entryMeta, status: "pending", local_pending: true } }),
  tally("opening", 500, "debt", { tab: { ...entryMeta, kind: "opening" } }),
  tally("reject", 60, "payment", { tab: { ...entryMeta, status: "disputed" } }),
  tally("local-reject", 60, "debt", { disputed_at: 3 }),
  tally("voided", 70, "debt", { tab: { ...entryMeta, voided: true } }),
  tally("void", 70, "payment", { tab: { ...entryMeta, kind: "void" } }),
  tally("deleted", 80, "debt", { deleted_at: 2 }),
  preLink,
  preLink,
];
const before = JSON.stringify(entries);
assert.deepEqual(summarizeTallyFlows(entries), {
  gave: { count: 3, amount: 5.3 },
  received: { count: 2, amount: 22.35 },
});
assert.equal(JSON.stringify(entries), before, "summary cannot mutate ledger evidence");
assert.throws(
  () => summarizeTallyFlows([tally("bad", 0.001)]),
  RangeError,
  "never round a corrupt sub-cent tally",
);
console.log(
  "PASS flow totals: exact cents, known pre-link history, pending, rejected/cancelled/opening/deleted and duplicate exclusion",
);

// Audit #23: the summary beside the balance stays as small as the balance side.
// One line per direction, the app's own "I gave / I received" words, nothing
// for a contact without tallies.
{
  const { compileUI, jsx, nodes } = require("./ui-fixture") as typeof import("./ui-fixture");
  const { TallyFlowSummary } = compileUI("../../components/TallyFlowSummary", {
    "react/jsx-runtime": { jsx, jsxs: jsx },
    "react-native": {
      StyleSheet: { create: (s: any) => s },
      Text: "Text",
      View: "View",
    },
    "../lib/colors": { colors: {} },
    "../lib/currency": { getCurrentCurrencySymbol: () => "AFN" },
    "../lib/direction": {
      rowDir: (rtl: boolean) => ({ flexDirection: rtl ? "row-reverse" : "row" }),
    },
    "../lib/format": { formatAmount: (n: number) => String(n) },
    "../lib/fonts": { fonts: {}, monoLineHeight: () => 20, sansLineHeight: () => 18 },
    "../lib/i18n": {
      t: (key: string, vars?: Record<string, unknown>) => `${key}(${vars?.count ?? ""})`,
    },
    "../lib/jalali": { faDigits: (s: string) => s },
  });
  const empty = { gave: { count: 0, amount: 0 }, received: { count: 0, amount: 0 } };
  assert.equal(TallyFlowSummary({ summary: empty, isRTL: false }), null, "no rows of zeros");
  const tree = TallyFlowSummary({
    summary: { gave: { count: 3, amount: 1500 }, received: { count: 1, amount: 200 } },
    isRTL: false,
  });
  const lines = nodes(tree).filter((n: any) => n.props.accessible === true);
  assert.equal(lines.length, 2, "one accessible line per direction");
  for (const line of lines) {
    assert.equal(line.props.style[1].flexDirection, "row", "label and amount share one line");
    assert.ok(line.props.accessibilityHint, "the explanation is announced on each line");
  }
  assert.ok(tree.props.style.maxWidth === "50%", "never wider than half the header row");
}
console.log("PASS flow summary: one line per direction, no empty rows, half-row cap, spoken hint");
