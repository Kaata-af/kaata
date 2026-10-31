import assert from "node:assert/strict";
import { test } from "node:test";
import type { WebEntry, WebPerson } from "../../lib/web-ledger";
import {
  amountInput,
  balanceMap,
  defaultPersonEntryCurrency,
  entryDate,
  entryTimestamp,
  localDateValue,
  localTimeValue,
  minorUnits,
  money,
  personBalances,
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

test("disputed tallies stay in history but never inflate balances or credit exposure", () => {
  const rows = [
    entry("normal", "A", "12.34"),
    entry("disputed", "A", "999", { disputed_at: 10 }),
    entry("payment", "A", "2.34", { type: "payment" }),
  ];
  assert.equal(balanceMap(rows).get("A")?.get("AFN"), 1000n);
  assert.equal(rows.length, 3);
});

test("explicit tally times preserve untouched milliseconds and reject impossible or future times", () => {
  const original = new Date(2025, 2, 15, 10, 42, 33, 123).getTime();
  const opened = Date.now();
  assert.equal(
    entryTimestamp(localDateValue(original), opened, original, localTimeValue(original)),
    original,
  );
  assert.equal(
    entryTimestamp("2025-03-15", opened, original, "09:30"),
    new Date(2025, 2, 15, 9, 30).getTime(),
  );
  assert.equal(entryTimestamp("2025-03-15", opened, original, "25:00"), null);
  assert.equal(entryTimestamp("2025-03-15", opened, original, "10:60"), null);
  const now = new Date();
  if (now.getHours() < 23) {
    assert.equal(entryTimestamp(localDateValue(), opened, undefined, "23:59"), null);
  }
});

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
  const balances = balanceMap(rows);
  assert.equal(balances.get("Ahmad")?.get("AFN"), 30n);
  assert.deepEqual(totals(people, balances, "AFN"), [
    { currency: "AFN", collect: 30n, pay: 1234n },
    { currency: "USD", collect: 10000n, pay: 0n },
  ]);
  assert.equal(balances.get("Ahmad")?.get("USD"), 10000n);
  assert.equal(money(100_000_000_000_031n), "1,000,000,000,000.31");
  assert.equal(minorUnits("-12.34"), -1234n);
});

test("mixed directions remain separate in totals and qualify for either balance filter", () => {
  const people = [person("Mixed"), person("Other"), person("Zero"), person("Empty")];
  const balances = balanceMap([
    entry("1", "Mixed", "100"),
    entry("2", "Mixed", "100", { currency: "USD", type: "payment" }),
    entry("3", "Other", "100", { type: "payment" }),
    entry("4", "Zero", "20", { currency: "EUR" }),
    entry("5", "Zero", "20", { currency: "EUR", type: "payment" }),
  ]);
  assert.deepEqual(totals(people, balances, "AFN"), [
    { currency: "AFN", collect: 10000n, pay: 10000n },
    { currency: "USD", collect: 0n, pay: 10000n },
  ]);
  const names = (filter: "collect" | "pay" | "settled") =>
    peopleInView(people, balances, "", filter).map((row) => row.name);
  assert.deepEqual(names("collect"), ["Mixed"]);
  assert.deepEqual(names("pay"), ["Mixed", "Other"]);
  assert.deepEqual(names("settled"), ["Empty", "Zero"]);
  assert.deepEqual(personBalances(balances, "Mixed", "USD"), [
    { currency: "USD", balance: -10000n },
    { currency: "AFN", balance: 10000n },
  ]);
});

test("person currencies retain zero history but omit unused or wholly deleted denominations", () => {
  const balances = balanceMap([
    entry("1", "A", "12.34", { currency: "USD" }),
    entry("2", "A", "12.34", { currency: "USD", type: "payment" }),
    entry("3", "A", "0.01", { currency: "EUR" }),
    entry("4", "A", "999", { currency: "PKR", is_deleted: true }),
    entry("5", "Deleted", "1", { currency: "USD", is_deleted: true }),
  ]);
  assert.deepEqual(personBalances(balances, "A", "AFN"), [
    { currency: "EUR", balance: 1n },
    { currency: "USD", balance: 0n },
  ]);
  assert.deepEqual(personBalances(balances, "Deleted", "AFN"), [{ currency: "AFN", balance: 0n }]);
  assert.deepEqual(totals([person("A")], balances, "AFN"), [
    { currency: "EUR", collect: 1n, pay: 0n },
  ]);
  assert.deepEqual(totals([person("Deleted")], balances, "AFN"), [
    { currency: "AFN", collect: 0n, pay: 0n },
  ]);
  assert.deepEqual(totals([], new Map(), "USD"), [{ currency: "USD", collect: 0n, pay: 0n }]);
});

test("recent ordering uses current business dates, new-contact creation, and explicit settlement", () => {
  const rows = [
    person("older", { created_at: 10, last_entry_at: 100 }),
    person("latest", { created_at: 1, last_entry_at: 400 }),
    person("new-contact", { created_at: 500, last_entry_at: null }),
    person("settled", { created_at: 5, last_entry_at: 900, is_settled: true }),
    person("unknown"),
  ];
  const ordered = (people: WebPerson[]) =>
    peopleInView(people, new Map(), "", "all").map((row) => row.relationship_id);
  assert.deepEqual(ordered(rows), ["new-contact", "latest", "older", "unknown", "settled"]);
  // The live projection changes latest activity on deletion or a business-date
  // correction. The browser sorts that fresh metadata, never a cached write time.
  const removedLatest = rows.map((row) =>
    row.relationship_id === "latest" ? { ...row, last_entry_at: null } : row,
  );
  assert.deepEqual(ordered(removedLatest), [
    "new-contact",
    "older",
    "latest",
    "unknown",
    "settled",
  ]);
  const backdated = rows.map((row) =>
    row.relationship_id === "latest" ? { ...row, last_entry_at: 50 } : row,
  );
  assert.deepEqual(ordered(backdated), ["new-contact", "older", "latest", "unknown", "settled"]);
  assert.equal(rows[0].relationship_id, "older", "sorting must not mutate its source");
});

test("equal activity uses localized numeric names and stable user identity", () => {
  const rows = [
    person("ten", { name: "دکان ۱۰", created_at: 100 }),
    person("two-b", { user_id: "b", name: "دکان ۲", created_at: 100 }),
    person("two-a", { user_id: "a", name: "دکان ۲", created_at: 100 }),
  ];
  assert.deepEqual(
    peopleInView(rows, new Map(), "", "all", "fa").map((row) => row.relationship_id),
    ["two-a", "two-b", "ten"],
  );
  assert.equal(peopleInView(rows, new Map(), "10", "all", "fa")[0].relationship_id, "ten");
});

test("new entries choose the enabled person override or sole live historical currency", () => {
  const contact = person("A");
  const ledger = {
    default_entry_currency: "AFN",
    enabled_currencies: ["AFN", "USD"],
    entries: [
      entry("1", "A", "10", { currency: "USD", read_only: true, settled_at: 1 }),
      entry("2", "A", "10", {
        currency: "USD",
        type: "payment",
        read_only: true,
        settled_at: 1,
      }),
      entry("3", "A", "10", { currency: "AFN", is_deleted: true }),
      entry("4", "Other", "10", { currency: "AFN" }),
    ],
  };
  assert.equal(defaultPersonEntryCurrency(ledger, contact), "USD", "zero settled history counts");
  assert.equal(
    defaultPersonEntryCurrency(ledger, { ...contact, default_entry_currency: "AFN" }),
    "AFN",
    "explicit enabled override wins over history",
  );
  for (const override of ["EUR", "usd"])
    assert.equal(
      defaultPersonEntryCurrency(ledger, { ...contact, default_entry_currency: override }),
      "AFN",
      "disabled or invalid explicit preference falls back instead of inferring",
    );
  assert.equal(
    defaultPersonEntryCurrency(
      { ...ledger, entries: [...ledger.entries, entry("5", "A", "1")] },
      contact,
    ),
    "AFN",
    "several recorded currencies use the book default",
  );
  assert.equal(defaultPersonEntryCurrency(ledger, person("Empty")), "AFN");
  assert.equal(
    defaultPersonEntryCurrency({ ...ledger, enabled_currencies: ["AFN"] }, contact),
    "AFN",
    "disabled history does not return to the new-entry picker",
  );
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

test("CSV identifies current, settled and disputed history across currencies and safely localizes exports", () => {
  const contact = person("a", { name: '=HYPERLINK("bad")' });
  const rows = [
    entry("1", "a", "10.50", { note: '+danger,\nquoted"' }),
    entry("2", "a", "5", { currency: "USD", type: "payment", settled_at: 10 }),
    entry("3", "a", "99", { is_deleted: true }),
    entry("4", "other", "999"),
    entry("5", "a", "7.25", { currency: "EUR", disputed_at: 12 }),
    entry("6", "a", "3.75", { currency: "GBP", type: "payment", settled_at: 10, disputed_at: 12 }),
  ];
  const csv = statementCSV(contact, rows);
  assert.ok(csv.startsWith('\ufeff"Person","Date","Type","Amount","Currency","Note","Status"\r\n'));
  assert.ok(csv.includes("'" + '=HYPERLINK(""bad"")'));
  assert.ok(csv.includes("'+danger,"));
  assert.ok(csv.includes('"10.50","AFN"'));
  assert.ok(csv.includes('"5","USD"'));
  assert.ok(csv.includes('"7.25","EUR","","Disputed"'));
  assert.ok(
    csv.includes('"3.75","GBP","","Disputed"'),
    "a disputed settled row must still be flagged as disputed",
  );
  assert.equal(csv.match(/,"Current"(?:\r\n|$)/g)?.length, 1);
  assert.equal(csv.match(/,"Settled"(?:\r\n|$)/g)?.length, 1);
  assert.equal(csv.match(/,"Disputed"(?:\r\n|$)/g)?.length, 2);
  assert.ok(!csv.includes('"99"') && !csv.includes('"999"'));
  for (const [locale, statusHeader, current, settled, disputed, gave, received] of [
    ["fa", "وضعیت", "جاری", "تصفیه‌شده", "مورد اختلاف", "دادم", "گرفتم"],
    ["ps", "حالت", "اوسنی", "تصفیه شوی", "لانجمن", "ورکړل", "واخیستل"],
  ] as const) {
    const localized = statementCSV(contact, rows, locale);
    assert.ok(localized.includes(`,"${statusHeader}"\r\n`));
    for (const label of [current, settled, disputed, gave, received])
      assert.ok(localized.includes(`"${label}"`));
    assert.ok(localized.includes('"7.25","EUR","",' + `"${disputed}"`));
    assert.ok(localized.includes("'" + '=HYPERLINK(""bad"")'));
    assert.ok(localized.includes("'+danger,"));
    assert.ok(!localized.includes('"99"') && !localized.includes('"999"'));
  }
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
