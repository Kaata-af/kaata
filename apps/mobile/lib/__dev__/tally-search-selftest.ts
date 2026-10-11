import assert from "node:assert/strict";
import { filterTalliesByNote, noteSearchTerms } from "../tally-search";

const entries = [
  { id: "new", note: "Rice for home, café delivery", amount: 200 },
  { id: "pending", note: "كرایهٔ دكان ۱۲۳", amount: 100, status: "pending" },
  { id: "old", note: "خرید می‌رود", amount: 50, settled: true },
  { id: "rejected", note: "Rice [returned]", amount: 20, status: "disputed" },
  { id: "blank", note: null, amount: 500 },
];
function ids(query: string) {
  return filterTalliesByNote(entries, noteSearchTerms(query)).map((e) => e.id);
}
assert.deepEqual(
  ids("  "),
  entries.map((e) => e.id),
);
assert.deepEqual(ids("RICE"), ["new", "rejected"]);
assert.deepEqual(ids("delivery cafe"), ["new"]);
assert.deepEqual(ids("rice shop"), []);
assert.deepEqual(ids("[returned]"), ["rejected"]);
assert.deepEqual(ids(".*"), [], "query punctuation must never act as a regex");
assert.deepEqual(ids("کرایه دکان ١٢٣"), ["pending"]);
assert.deepEqual(ids("کرایه 123"), ["pending"]);
assert.deepEqual(ids("میرود"), ["old"], "ZWNJ-free queries match original notes");
assert.deepEqual(ids("می رود"), ["old"]);
assert.deepEqual(ids("delivery\nRICE"), ["new"]);
assert.deepEqual(ids("none"), [], "null-note tallies do not match a real query");
assert.equal(filterTalliesByNote(entries, noteSearchTerms("کرایه"))[0], entries[1]);
assert.equal(entries[2].note, "خرید می‌رود", "search must not rewrite a Dari note");
assert.equal(
  entries.reduce((sum, e) => sum + e.amount, 0),
  870,
);
console.log(
  "PASS: note search across history, literal terms, Dari letters/digits/ZWNJs and unchanged ledger order/data",
);
