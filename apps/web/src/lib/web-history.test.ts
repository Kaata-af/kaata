import assert from "node:assert/strict";
import { test } from "node:test";
import type { WebEntry } from "./web-ledger";
import {
  EMPTY_HISTORY_FILTERS,
  filterEntryHistory,
  historyDateRange,
  historyMatchesQuery,
  historySearchAmount,
  summarizeEntryHistory,
  type HistoryFilters,
} from "./web-history";

const timestamp = (day: number, hour = 12, minute = 0, second = 0, millisecond = 0) =>
  new Date(2026, 9, day, hour, minute, second, millisecond).getTime();
function entry(id: string, fields: Partial<WebEntry> = {}): WebEntry {
  return {
    id,
    relationship_id: "person-1",
    type: "debt",
    amount_afn: "500",
    currency: "AFN",
    note: null,
    created_at: timestamp(30),
    updated_at: timestamp(30),
    current_event_id: id,
    is_deleted: false,
    read_only: false,
    settled_at: null,
    ...fields,
  };
}
const filtered = (
  entries: readonly WebEntry[],
  fields: Partial<HistoryFilters>,
  now = timestamp(31),
) => filterEntryHistory(entries, { ...EMPTY_HISTORY_FILTERS, ...fields }, now);

test("amount searches use exact cents rather than numeric or note substrings", () => {
  assert.equal(historySearchAmount("۵۰۰٫۰۰"), 50000n);
  assert.equal(historySearchAmount("١٬٢٣٤٫٥٠"), 123450n);
  assert.equal(historySearchAmount("1,234.50"), 123450n);
  assert.equal(historySearchAmount("12,50"), 1250n);
  assert.equal(historySearchAmount("12,345,67"), null);
  assert.equal(historyMatchesQuery(entry("exact"), "۵۰۰"), true);
  assert.equal(historyMatchesQuery(entry("larger", { amount_afn: "5000" }), "500"), false);
  assert.equal(
    historyMatchesQuery(entry("note", { amount_afn: "5", note: "Invoice 1500" }), "500"),
    false,
  );
  assert.equal(
    historyMatchesQuery(entry("note", { amount_afn: "5", note: "Paid ۵۰۰٫۰۰ today" }), "500"),
    true,
  );
  assert.equal(
    historyMatchesQuery(entry("note", { note: "Rice delivery on Friday" }), "DELIVERY"),
    true,
  );
  assert.equal(historyMatchesQuery(entry("note", { note: "حساب شماره ۱۵۰۰" }), "شماره 1500"), true);
});

test("large monetary searches retain neighboring cents beyond Number precision", () => {
  const entries = [
    entry("one", { amount_afn: "90071992547409.93" }),
    entry("two", { amount_afn: "90071992547409.94" }),
  ];
  assert.deepEqual(
    filtered(entries, { query: "۹۰۰۷۱۹۹۲۵۴۷۴۰۹٫۹۳" }).map((row) => row.id),
    ["one"],
  );
});

test("custom Gregorian date bounds include both full business dates and preserve epochs", () => {
  const start = entry("start", { created_at: timestamp(10, 0) });
  const finish = entry("finish", { created_at: timestamp(12, 23, 59, 59, 999) });
  const entries = [
    entry("before", { created_at: timestamp(9, 23, 59, 59, 999) }),
    start,
    finish,
    entry("after", { created_at: timestamp(13, 0) }),
  ];
  const snapshot = entries.map((row) => row.created_at);
  assert.deepEqual(
    filtered(entries, { preset: "custom", from: "2026-10-10", to: "2026-10-12" }).map(
      (row) => row.id,
    ),
    ["finish", "start"],
  );
  assert.deepEqual(
    entries.map((row) => row.created_at),
    snapshot,
  );
  assert.equal(
    filtered(entries, { preset: "custom", from: "2026-10-13", to: "2026-10-10" }).length,
    0,
  );
  assert.equal(filtered(entries, { preset: "custom", from: "2026-02-30", to: "" }).length, 0);
  assert.deepEqual(
    filtered(entries, { preset: "custom", from: "2026-10-12", to: "" }).map((row) => row.id),
    ["after", "finish"],
  );
});

test("today, seven-day, thirty-day and current-month presets use inclusive calendar days", () => {
  const filters = (preset: HistoryFilters["preset"]) => ({ ...EMPTY_HISTORY_FILTERS, preset });
  const now = timestamp(31, 23, 59);
  assert.deepEqual(historyDateRange(filters("today"), now), {
    from: "2026-10-31",
    to: "2026-10-31",
    valid: true,
  });
  assert.deepEqual(historyDateRange(filters("last7"), now), {
    from: "2026-10-25",
    to: "2026-10-31",
    valid: true,
  });
  assert.deepEqual(historyDateRange(filters("last30"), now), {
    from: "2026-10-02",
    to: "2026-10-31",
    valid: true,
  });
  assert.deepEqual(historyDateRange(filters("month"), now), {
    from: "2026-10-01",
    to: "2026-10-31",
    valid: true,
  });
  const entries = [
    entry("earlier", { created_at: timestamp(24, 23, 59, 59, 999) }),
    entry("first", { created_at: timestamp(25, 0) }),
    entry("last", { created_at: timestamp(31, 23, 59, 59, 999) }),
    entry("future", { created_at: timestamp(32, 0) }),
  ];
  assert.deepEqual(
    filtered(entries, { preset: "last7" }, now).map((row) => row.id),
    ["last", "first"],
  );
});

test("filters search both current and settled records without inferring settlement from balances", () => {
  const entries = [
    entry("current", { amount_afn: "500", note: "rice", type: "debt" }),
    entry("balancing-payment", { amount_afn: "500", type: "payment" }),
    entry("settled", {
      currency: "USD",
      amount_afn: "5",
      note: "rice",
      settled_at: timestamp(31),
      read_only: true,
    }),
    entry("deleted", { note: "rice", is_deleted: true }),
  ];
  const matches = filtered(entries, { query: "rice" });
  assert.deepEqual(matches.map((row) => row.id).sort(), ["current", "settled"]);
  assert.equal(matches.find((row) => row.id === "current")?.settled_at, null);
  assert.deepEqual(
    filtered(entries, { query: "rice", currency: "USD" }).map((row) => row.id),
    ["settled"],
  );
  assert.deepEqual(
    filtered(entries, { query: "5" }).map((row) => row.id),
    ["settled"],
  );
});

test("whole-history totals and direction counts stay separate per currency and omit deleted/disputed", () => {
  const entries = [
    entry("a", { amount_afn: "0.10" }),
    entry("b", { amount_afn: "0.20", settled_at: timestamp(30) }),
    entry("c", { type: "payment", amount_afn: "0.05" }),
    entry("d", { currency: "USD", amount_afn: "12.50" }),
    entry("deleted", { is_deleted: true, amount_afn: "999" }),
    entry("disputed", { disputed_at: 0, amount_afn: "888" }),
  ];
  const before = summarizeEntryHistory(entries);
  assert.deepEqual(before, [
    { currency: "AFN", given: 30n, received: 5n, givenCount: 2, receivedCount: 1 },
    { currency: "USD", given: 1250n, received: 0n, givenCount: 1, receivedCount: 0 },
  ]);
  filtered(entries, { query: "12.50", currency: "USD", preset: "today" });
  assert.deepEqual(summarizeEntryHistory(entries), before);
  assert.ok(
    filtered(entries, { query: "888" }).some((row) => row.id === "disputed"),
    "disputed records remain searchable",
  );
});

test("aggregating a long valid history preserves cents beyond the safe Number range", () => {
  const entries = Array.from({ length: 9008 }, (_, index) =>
    entry(String(index), { amount_afn: "9999999999.99" }),
  );
  const [summary] = summarizeEntryHistory(entries);
  assert.equal(summary.given, 9007999999990992n);
  assert.equal(summary.givenCount, 9008);
});
