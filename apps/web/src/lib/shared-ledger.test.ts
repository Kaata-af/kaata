import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import ts from "typescript";
import {
  billCurrencyLabel,
  parseSharedLedger,
  type MultiCurrencyBill,
  type SharedEntry,
} from "./shared-ledger";
import { formatBillDate } from "./customer-dates";

const entry = (
  currency: string,
  amount: number,
  date: number,
  type: "debt" | "payment" = "debt",
  note = "current",
): SharedEntry => ({ currency, amount, date, type, note });
const fixture = (): MultiCurrencyBill => ({
  v: 2,
  shop: "Synthetic shop",
  person: "Synthetic customer",
  locale: "en",
  calendar: "gregorian",
  generated_at: 1700000000000,
  currencies: [
    {
      currency: "؋",
      currency_code: "AFN",
      balance: 10.1,
      entries: [
        entry("AFN", 10.1, 300, "debt", "afn current"),
        entry("AFN", 20, 100, "debt", "afn old"),
        entry("AFN", 20, 90, "payment"),
      ],
      settled_chapters: 1,
      settled_boundary_ms: 200,
      settled_boundaries: [200],
    },
    {
      currency: "$",
      currency_code: "USD",
      balance: -10.1,
      entries: [
        entry("USD", 10.1, 175, "payment", "usd current"),
        entry("USD", 7, 100, "debt", "usd old"),
        entry("USD", 7, 90, "payment"),
      ],
      settled_chapters: 1,
      settled_boundary_ms: 150,
      settled_boundaries: [150],
    },
    {
      currency: "A$",
      currency_code: "AUD",
      balance: 0,
      entries: [entry("AUD", 5, 100), entry("AUD", 5, 90, "payment")],
      settled_chapters: 1,
      settled_boundary_ms: 200,
      settled_boundaries: [200, 200],
    },
  ],
});

test("v2 parses complete currency sections and rejects mixed/invalid/oversized bills", () => {
  const bill = fixture();
  assert.equal(parseSharedLedger(bill), bill);
  const wrong = fixture();
  wrong.currencies[1].entries[0].currency = "AFN";
  assert.equal(parseSharedLedger(wrong), null);
  const duplicate = fixture();
  duplicate.currencies[1].currency_code = "AFN";
  assert.equal(parseSharedLedger(duplicate), null);
  const missing = fixture();
  delete (missing.currencies[0] as Partial<(typeof missing.currencies)[0]>).balance;
  assert.equal(parseSharedLedger(missing), null);
  const invalid = fixture();
  invalid.currencies[0].balance = NaN;
  assert.equal(parseSharedLedger(invalid), null);
  const fraction = fixture();
  fraction.currencies[0].entries[0].amount = 0.001;
  assert.equal(parseSharedLedger(fraction), null);
  const boundary = fixture();
  boundary.currencies[0].settled_boundaries = [-1];
  assert.equal(parseSharedLedger(boundary), null);
  const full = fixture();
  full.currencies.forEach((section) => {
    section.entries = [];
  });
  full.currencies[0].entries = Array.from({ length: 2500 }, () => entry("AFN", 0.01, 1));
  full.currencies[1].entries = Array.from({ length: 2500 }, () => entry("USD", 0.01, 1));
  assert.equal(parseSharedLedger(full), full);
  full.currencies[2].entries.push(entry("AUD", 1, 1));
  assert.equal(parseSharedLedger(full), null);
});

test("v2 supports155 currencies and historical codes through the bounded256-section limit", () => {
  const bill = fixture();
  const sections = Array.from({ length: 257 }, (_, i) => {
    const code = String.fromCharCode(
      65 + Math.floor(i / 676),
      65 + (Math.floor(i / 26) % 26),
      65 + (i % 26),
    );
    return { currency: code, currency_code: code, balance: 0, entries: [] };
  });
  for (const count of [155, 256]) {
    bill.currencies = sections.slice(0, count);
    assert.equal(parseSharedLedger(bill), bill, `complete ${count}-currency bill remains readable`);
  }
  bill.currencies = sections;
  assert.equal(parseSharedLedger(bill), null, "257 sections are rejected as a whole");
});

const viewPath = fileURLToPath(new URL("../pages/CustomerView.tsx", import.meta.url));
const requireView = createRequire(viewPath),
  output: Record<string, any> = {};
const code = ts.transpileModule(readFileSync(viewPath, "utf8"), {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    jsx: ts.JsxEmit.ReactJSX,
    target: ts.ScriptTarget.ES2022,
  },
}).outputText;
new Function("require", "exports", code)(
  (name: string) =>
    name === "../env"
      ? { BACKEND_URL: "" }
      : name === "../lib/i18n"
        ? { useI18n: () => ({ lang: "en" }) }
        : requireView(name),
  output,
);
const render = (data: unknown) =>
  renderToStaticMarkup(createElement(MemoryRouter, null, createElement(output.Ledger, { data })));

test("actual SPA renders all three currencies independently, including zero and own settled cutoffs", () => {
  const html = render(fixture());
  for (const text of [
    "Synthetic shop",
    "AFN",
    "USD",
    "AUD",
    "afn current",
    "usd current",
    "owes",
    "is owed",
  ])
    assert.ok(html.includes(text), text);
  for (const redundant of ["AFN ؋", "USD $", "AUD A$", "$ USD"])
    assert.ok(!html.includes(redundant), `${redundant} is never repeated beside an amount`);
  assert.ok(
    !html.includes("afn old") && !html.includes("usd old"),
    "history collapses only inside its own currency",
  );
  assert.equal(
    (html.match(/All settled/g) ?? []).length,
    1,
    "only zero AUD is settled; opposite AFN/USD never cancel",
  );
  assert.equal(
    (html.match(/Synthetic shop/g) ?? []).length,
    1,
    "common bill metadata is not repeated for every currency",
  );
  assert.ok(
    (html.match(/AFN/g) ?? []).length >= 3 && (html.match(/USD/g) ?? []).length >= 3,
    "every visible entry retains its currency label",
  );
});

test("bill currency display uses one code while preserving legacy symbol-only snapshots", () => {
  assert.equal(billCurrencyLabel("AUD", "A$"), "AUD");
  assert.equal(billCurrencyLabel("USD", "$ USD"), "USD");
  assert.equal(billCurrencyLabel("AFN", "AFN ؋"), "AFN");
  assert.equal(billCurrencyLabel(undefined, "؋"), "؋");
  const legacy = {
    v: 1 as const,
    shop: "Old shop",
    person: "Old customer",
    locale: "en",
    currency: "$ USD",
    currency_code: "USD",
    balance: 5,
    generated_at: 1700000000000,
    entries: [{ type: "debt" as const, amount: 5, note: "old bill", date: 1700000000000 }],
  };
  const before = JSON.stringify(legacy);
  const html = render(legacy);
  assert.ok(html.includes("USD"));
  assert.ok(!html.includes("$ USD") && !html.includes("USD $"));
  assert.equal(JSON.stringify(legacy), before, "display cleanup never rewrites a stored bill");
});

test("old single-currency bills retain their symbols, dates, and original shape", () => {
  const legacy = {
    v: 1,
    shop: "Old shop",
    person: "Old customer",
    locale: "en",
    currency: "؋",
    balance: 5,
    generated_at: 1700000000000,
    entries: [{ type: "debt", amount: 5, note: "old bill", date: 1700000000000 }],
  };
  const before = JSON.stringify(legacy);
  assert.equal(parseSharedLedger(legacy), legacy);
  const html = render(legacy);
  assert.ok(
    html.includes("Old customer") && html.includes("old bill") && html.includes("Bill dated"),
  );
  assert.ok(!html.includes("AFN"));
  assert.equal(JSON.stringify(legacy), before);
});

const historyDay = (offset: number) => new Date(2026, 0, 1 + offset, 12).getTime();
const identified = (
  id: string,
  amount: number,
  offset: number,
  type: "debt" | "payment" = "debt",
  note = id,
): SharedEntry => ({ ...entry("USD", amount, historyDay(offset), type, note), id });
const historyFixture = (): MultiCurrencyBill => ({
  v: 3,
  shop: "Historical shop",
  person: "Historical customer",
  locale: "en",
  calendar: "gregorian",
  generated_at: historyDay(10),
  currencies: [
    {
      currency: "$",
      currency_code: "USD",
      balance: 100,
      entries: [identified("current-opening", 100, 9)],
      history: [
        {
          kind: "pre_link",
          entries: [
            identified("private-gave", 100, 4, "debt", "private original <unsafe>"),
            identified("private-received", 30, 1, "payment"),
          ],
          settlements: [
            { after_entry_id: null, date: historyDay(2) },
            { after_entry_id: "private-gave", date: historyDay(6) },
            { after_entry_id: "private-gave", date: historyDay(7) },
            { after_entry_id: "private-received", date: historyDay(3) },
          ],
        },
        {
          kind: "closed_shared",
          entries: [
            identified("closed-received", 0.1, 5, "payment"),
            identified("closed-gave", 0.05, 0),
          ],
          settlements: null,
        },
      ],
    },
  ],
});

test("v3 validates complete frozen history without changing v1/v2 interpretation", () => {
  const bill = historyFixture();
  const before = JSON.stringify(bill);
  assert.equal(parseSharedLedger(bill), bill);
  assert.equal(JSON.stringify(bill), before, "validation never sorts historical business dates");
  for (const settlements of [undefined, null]) {
    const compatible = historyFixture();
    compatible.currencies[0].history![0].settlements = settlements;
    assert.equal(parseSharedLedger(compatible), compatible);
  }
  const v2 = fixture();
  v2.currencies[0].history = [];
  assert.equal(parseSharedLedger(v2), null, "v2 cannot silently drop historical records");
  v2.currencies[0].history = null;
  assert.equal(parseSharedLedger(v2), v2);
});

test("v3 rejects malformed IDs, currencies, markers and unsafe historical sums as a whole", () => {
  const failures: [string, (bill: any) => void][] = [
    ["missing current ID", (b) => delete b.currencies[0].entries[0].id],
    ["blank ID", (b) => (b.currencies[0].history[0].entries[0].id = "  ")],
    [
      "duplicate across current/history",
      (b) => (b.currencies[0].history[0].entries[0].id = "current-opening"),
    ],
    ["duplicate across groups", (b) => (b.currencies[0].history[1].entries[0].id = "private-gave")],
    ["foreign currency", (b) => (b.currencies[0].history[0].entries[0].currency = "AFN")],
    ["unknown group kind", (b) => (b.currencies[0].history[0].kind = "current")],
    ["empty historical group", (b) => (b.currencies[0].history[0].entries = [])],
    ["negative amount", (b) => (b.currencies[0].history[0].entries[0].amount = -0.1)],
    ["third-decimal amount", (b) => (b.currencies[0].history[0].entries[0].amount = 0.001)],
    [
      "invalid business date",
      (b) => (b.currencies[0].history[0].entries[0].date = 8640000000000001),
    ],
    [
      "current entry anchor",
      (b) => (b.currencies[0].history[0].settlements[0].after_entry_id = "current-opening"),
    ],
    [
      "other group anchor",
      (b) => (b.currencies[0].history[0].settlements[0].after_entry_id = "closed-gave"),
    ],
    [
      "unknown anchor",
      (b) => (b.currencies[0].history[0].settlements[0].after_entry_id = "missing"),
    ],
    [
      "decreasing membership positions",
      (b) =>
        (b.currencies[0].history[0].settlements = [
          { after_entry_id: "private-received", date: historyDay(3) },
          { after_entry_id: "private-gave", date: historyDay(7) },
        ]),
    ],
    ["negative marker date", (b) => (b.currencies[0].history[0].settlements[0].date = -1)],
    ["nonarray settlements", (b) => (b.currencies[0].history[0].settlements = {})],
    [
      "unsafe accumulated hundredths",
      (b) =>
        (b.currencies[0].history[0] = {
          kind: "pre_link",
          entries: [0, 1, 2].map((i) => identified(`large-${i}`, 40000000000000, i)),
        }),
    ],
  ];
  for (const [why, mutate] of failures) {
    const bill = historyFixture();
    mutate(bill);
    assert.equal(parseSharedLedger(bill), null, why);
  }
  const duplicateCurrency = historyFixture();
  duplicateCurrency.currencies.push({
    ...duplicateCurrency.currencies[0],
    currency_code: "AFN",
    entries: [{ ...identified("current-opening", 1, 0), currency: "AFN" }],
    history: [],
  });
  assert.equal(
    parseSharedLedger(duplicateCurrency),
    null,
    "IDs remain globally unique across currencies",
  );
});

test("v3 shares entry and clearance limits across current/history while preserving v2 bounds", () => {
  const full = historyFixture();
  full.currencies[0].history = [
    {
      kind: "pre_link",
      entries: Array.from({ length: 4999 }, (_, i) => identified(`historical-${i}`, 0.01, 0)),
    },
  ];
  assert.equal(parseSharedLedger(full), full, "current1 + historical4999 is complete");
  full.currencies[0].history[0].entries.push(identified("excess-entry", 0.01, 0));
  assert.equal(parseSharedLedger(full), null);
  const markers = historyFixture();
  markers.currencies[0].history = [
    {
      kind: "pre_link",
      entries: [identified("one-history", 1, 0)],
      settlements: [{ after_entry_id: null, date: 0 }],
    },
  ];
  markers.currencies[0].settled_boundaries = Array(4999).fill(0);
  assert.equal(parseSharedLedger(markers), markers, "4999 current +1 historical marker is allowed");
  markers.currencies[0].history[0].settlements!.push({ after_entry_id: "one-history", date: 0 });
  assert.equal(parseSharedLedger(markers), null, "5001 total markers is refused");
  const groups = historyFixture();
  groups.currencies[0].entries = [];
  groups.currencies[0].history = Array.from({ length: 5000 }, (_, i) => ({
    kind: "pre_link" as const,
    entries: [identified(`group-${i}`, 0, 0)],
  }));
  assert.equal(parseSharedLedger(groups), groups);
  groups.currencies[0].history.push({
    kind: "pre_link",
    entries: [identified("excess-group", 0, 0)],
  });
  assert.equal(parseSharedLedger(groups), null);
  const old = fixture();
  old.currencies[0].settled_boundaries = Array(5000).fill(0);
  old.currencies[1].settled_boundaries = Array(5000).fill(0);
  assert.equal(parseSharedLedger(old), old, "v2 retains its original per-section marker bound");
});

test("actual v3 SPA keeps current100 separate and honors saved history order and clearance anchors", () => {
  const bill = historyFixture();
  const html = render(parseSharedLedger(bill)!);
  const historicalAt = html.indexOf('aria-label="Before this shared account"');
  assert.ok(historicalAt > 0);
  const current = html.slice(0, historicalAt),
    historical = html.slice(historicalAt);
  assert.ok(current.includes("Historical customer") && current.includes("current-opening"));
  assert.ok(!current.includes("private original") && !current.includes("Historical balance"));
  const headline = current.match(/<p class="[^"]*text-\[38px\][^"]*"[^>]*>([\s\S]*?)<\/p>/)?.[1];
  assert.ok(headline, "the current balance has its own headline");
  assert.equal(
    headline.replace(/<[^>]+>/g, ""),
    "100USD",
    "history cannot change the current header",
  );
  assert.ok(historical.includes("do not change the current balance"));
  assert.ok(
    historical.includes("private original &lt;unsafe&gt;") && !historical.includes("<unsafe>"),
  );
  const latest = formatBillDate(historyDay(7), "en", "gregorian", 0);
  const replaced = formatBillDate(historyDay(6), "en", "gregorian", 0);
  assert.ok(historical.indexOf("private original") < historical.indexOf(latest));
  assert.ok(historical.indexOf(latest) < historical.indexOf("private-received"));
  assert.ok(
    !historical.includes(replaced),
    "adjacent duplicate anchors keep only the last supplied clearance",
  );
  assert.ok(
    historical.includes(formatBillDate(historyDay(1), "en", "gregorian", 0)),
    "edited earlier business date stays displayed",
  );
  assert.ok(
    historical.includes("70 USD") &&
      historical.includes("-0.10 USD") &&
      historical.includes("-0.05 USD"),
  );
  assert.ok(!html.includes("169.95"), "historical balances never join the current headline");
  assert.ok(historical.includes("Earlier shared account"));
  for (const [locale, title] of [
    ["fa", "پیش از این حساب مشترک"],
    ["ps", "تر دې ګډ حساب مخکې"],
  ]) {
    const localized = render({ ...bill, locale });
    assert.ok(localized.includes(title) && localized.includes('dir="rtl"'));
  }
});

test("v3 renders all155 currency histories completely and keeps the256-section bound", () => {
  const bill = historyFixture();
  bill.currencies = Array.from({ length: 155 }, (_, i) => {
    const code = String.fromCharCode(
      65 + Math.floor(i / 676),
      65 + (Math.floor(i / 26) % 26),
      65 + (i % 26),
    );
    return {
      currency: "$",
      currency_code: code,
      balance: 0.01,
      entries: [{ ...identified(`current-${code}`, 0.01, 0), currency: code }],
      history: [
        {
          kind: "pre_link",
          entries: [{ ...identified(`history-${code}`, 0.02, 1), currency: code }],
        },
      ],
    };
  });
  assert.equal(parseSharedLedger(bill), bill);
  const html = render(bill);
  for (const section of bill.currencies) {
    assert.ok(html.includes(`history-${section.currency_code}`));
    assert.ok(html.includes(section.currency_code!));
    assert.ok(!html.includes(`${section.currency_code} $`));
  }
  assert.equal((html.match(/aria-label="Before this shared account"/g) ?? []).length, 155);
  const template = bill.currencies[0];
  bill.currencies = Array.from({ length: 257 }, (_, i) => ({
    ...template,
    currency_code: String.fromCharCode(
      65 + Math.floor(i / 676),
      65 + (Math.floor(i / 26) % 26),
      65 + (i % 26),
    ),
    entries: [],
    history: [],
  }));
  const maximum = parseSharedLedger({ ...bill, currencies: bill.currencies.slice(0, 256) });
  assert.ok(maximum?.v === 3);
  assert.equal(maximum.currencies.length, 256);
  assert.equal(parseSharedLedger(bill), null);
});
