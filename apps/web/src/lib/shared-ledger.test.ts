import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import ts from "typescript";
import { parseSharedLedger, type MultiCurrencyBill, type SharedEntry } from "./shared-ledger";

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
    "AFN ؋",
    "USD $",
    "AUD A$",
    "afn current",
    "usd current",
    "owes",
    "is owed",
  ])
    assert.ok(html.includes(text), text);
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
    (html.match(/AFN ؋/g) ?? []).length >= 3 && (html.match(/USD \$/g) ?? []).length >= 3,
    "every visible entry retains its currency label",
  );
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
