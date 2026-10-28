import assert from "node:assert/strict";
import { test } from "node:test";
import type { WebEntry, WebPerson } from "../../lib/web-ledger";
import {
  amountInput,
  balanceMap,
  entryDate,
  entryTimestamp,
  localDateValue,
  minorUnits,
  money,
  peopleInView,
  statementCSV,
  totals,
} from "./model";

function person(id: string, extra: Partial<WebPerson> = {}): WebPerson {
  return {
    relationship_id: id,
    user_id: id,
    name: id,
    phone_e164: null,
    default_entry_currency: null,
    archived_at: null,
    read_only: false,
    read_only_reason: null,
    ...extra,
  };
}
function entry(
  id: string,
  person: string,
  amount: string,
  extra: Partial<WebEntry> = {},
): WebEntry {
  return {
    id,
    relationship_id: person,
    amount_afn: amount,
    currency: "AFN",
    type: "debt",
    note: null,
    created_at: 1700000000000,
    updated_at: 1700000000000,
    current_event_id: id,
    is_deleted: false,
    read_only: false,
    settled_at: null,
    ...extra,
  };
}

test("ledger totals preserve cents, direction, and currency without adding shared or archived balances", () => {
  const rows = [
    entry("a", "Ahmad", "0.10"),
    entry("b", "Ahmad", "0.20"),
    entry("c", "Wahid", "12.34", { type: "payment" }),
    entry("d", "Ahmad", "100", { currency: "USD" }),
    entry("e", "Ahmad", "999", { is_deleted: true }),
    entry("f", "Shared", "900"),
    entry("g", "Archived", "100"),
  ];
  const people = [
    person("Ahmad"),
    person("Wahid"),
    person("Shared", { read_only: true, read_only_reason: "shared_tab" }),
    person("Archived", { archived_at: 1 }),
  ];
  const balances = balanceMap(rows, "AFN");
  assert.equal(balances.get("Ahmad"), 30n);
  assert.deepEqual(totals(people, balances), { collect: 30n, pay: 1234n });
  assert.equal(balanceMap(rows, "USD").get("Ahmad"), 10000n);
  assert.equal(money(100_000_000_000_031n), "1,000,000,000,000.31");
  assert.equal(minorUnits("-12.34"), -1234n);
});

test("Dari and Arabic amounts accept cents and reject ambiguous grouping or rounding", () => {
  assert.equal(amountInput("۱۲٫۳۴"), "12.34");
  assert.equal(amountInput("١٢,٥"), "12.50");
  assert.equal(amountInput(".29"), "0.29");
  for (const invalid of ["0", "-1", "1,234", "1.234", "1e3", "Infinity", "10000000000"])
    assert.equal(amountInput(invalid), null);
});

test("unknown shared balances cannot appear settled and contact search normalizes local digits", () => {
  const people = [
    person("Ahmad", { phone_e164: "+93700123456" }),
    person("Shared", { read_only: true, read_only_reason: "shared_tab" }),
  ];
  assert.deepEqual(
    peopleInView(people, new Map(), "", "settled").map((p) => p.name),
    ["Ahmad"],
  );
  assert.equal(peopleInView(people, new Map(), "۷۰۰", "all")[0].name, "Ahmad");
});

test("CSV exports full private history across currencies and neutralizes spreadsheet formulas", () => {
  const contact = person("a", { name: '=HYPERLINK("bad")' });
  const csv = statementCSV(contact, [
    entry("1", "a", "10.50", { note: '+danger,\nquoted"' }),
    entry("2", "a", "5", { currency: "USD", type: "payment" }),
    entry("3", "a", "99", { is_deleted: true }),
    entry("4", "other", "999"),
  ]);
  assert.ok(csv.includes("'" + '=HYPERLINK(""bad"")'));
  assert.ok(csv.includes("'+danger,"));
  assert.ok(csv.includes('"10.50","AFN"'));
  assert.ok(csv.includes('"5","USD"'));
  assert.ok(!csv.includes('"99"') && !csv.includes('"999"'));
  assert.throws(() => statementCSV(person("shared", { read_only_reason: "shared_tab" }), []));
});

test("entry dates reject rollover and future dates while preserving local calendar days", () => {
  assert.equal(entryDate("2026-02-30"), null);
  assert.equal(entryDate("9999-01-01"), null);
  assert.equal(entryDate("garbage"), null);
  const value = entryDate("2020-02-29");
  assert.notEqual(value, null);
  assert.equal(localDateValue(value!), "2020-02-29");
});

test("new entries after a same-day settlement retain their time and stable retry identity", () => {
  const openedAt = new Date(2020, 1, 29, 17, 30).getTime();
  const settledAt = new Date(2020, 1, 29, 14, 0).getTime();
  const first = entryTimestamp("2020-02-29", openedAt);
  assert.equal(first, openedAt);
  assert.ok(first! > settledAt);
  assert.equal(entryTimestamp("2020-02-29", openedAt), first);
  const original = new Date(2020, 1, 29, 16, 15).getTime();
  assert.equal(entryTimestamp("2020-02-29", openedAt, original), original);
  assert.equal(entryTimestamp("2020-02-28", openedAt), entryDate("2020-02-28"));
});
