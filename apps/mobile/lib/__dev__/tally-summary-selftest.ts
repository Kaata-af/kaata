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
