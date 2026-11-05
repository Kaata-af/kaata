import assert from "node:assert/strict";
import { test } from "node:test";
import type { WebTab, WebTabEntry, WebTabResponse, WebTabSettlement } from "../../lib/web-tabs";
import {
  sharedDirectionFor,
  sharedAccountCanStart,
  sharedContactActive,
  sharedEntryActions,
  sharedHistoryCSV,
  sharedPeriodHistory,
  sharedPeriodCanSettle,
} from "./shared-tallies-model";
import { sharedTalliesCopy } from "./shared-tallies-copy";
import type { WebEntry, WebPerson, WebSharedBinding } from "../../lib/web-ledger";

const tab = {
  you: "b",
  access: { append: true, review: true, void: true, settle: true, manage: true },
} as WebTab;
const entry = {
  id: "entry",
  seq: 3,
  kind: "entry",
  status: "pending",
  created_by: "a",
  voided_by_entry_id: null,
} as WebTabEntry;

test("archived books and contacts cannot mutate shared tallies", () => {
  assert.equal(sharedContactActive({ archived_at_ms: null }, { archived_at: null }), true);
  assert.equal(sharedContactActive({ archived_at_ms: 1 }, { archived_at: null }), false);
  assert.equal(sharedContactActive({ archived_at_ms: null }, { archived_at: 1 }), false);
});

test("sharing can restart after closed periods while unknown and active links stay guarded", () => {
  const contact = {
    read_only_reason: "shared_tab" as const,
    shared: { tabs: [{ closed_at_ms: 1 } as WebSharedBinding], balances: [], pending_for_you: 0 },
  };
  assert.equal(sharedAccountCanStart(contact), true);
  assert.equal(
    sharedAccountCanStart({
      ...contact,
      shared: { ...contact.shared, tabs: [{ closed_at_ms: null } as WebSharedBinding] },
    }),
    false,
  );
  assert.equal(sharedAccountCanStart({ ...contact, shared: null }), false);
  assert.equal(sharedAccountCanStart({ read_only_reason: null, shared: null }), true);
});

test("settlement requires both unified and selected-period zero balances without proposals", () => {
  const period = {
    tab: { ...tab, recorded_balance: { a: "0", b: "0" } },
    entries: [{ ...entry, status: "accepted" }],
    settlements: [],
    full: true,
  } as WebTabResponse;
  assert.equal(sharedPeriodCanSettle(period, "0", "0"), true);
  assert.equal(
    sharedPeriodCanSettle(
      { ...period, tab: { ...period.tab, recorded_balance: { a: "100", b: "-100" } } },
      "0",
      "0",
    ),
    false,
  );
  assert.equal(sharedPeriodCanSettle(period, "100", "0"), false);
  assert.equal(sharedPeriodCanSettle({ ...period, entries: [entry] }, "0", "0"), false);
});

test("shared transfers reverse correctly for party B", () => {
  assert.equal(sharedDirectionFor("a", "debt"), "a_to_b");
  assert.equal(sharedDirectionFor("a", "payment"), "b_to_a");
  assert.equal(sharedDirectionFor("b", "debt"), "b_to_a");
  assert.equal(sharedDirectionFor("b", "payment"), "a_to_b");
});

test("only peer proposals can be reviewed and accepted/disputed decisions stay final", () => {
  assert.deepEqual(sharedEntryActions(tab, entry, 0), { review: true, void: false });
  assert.deepEqual(sharedEntryActions(tab, { ...entry, created_by: "b" }, 0), {
    review: false,
    void: true,
  });
  for (const status of ["accepted", "disputed"] as const) {
    assert.deepEqual(sharedEntryActions(tab, { ...entry, created_by: "b", status }, 0), {
      review: false,
      void: false,
    });
  }
  assert.deepEqual(sharedEntryActions({ ...tab, access: undefined }, entry, 0), {
    review: false,
    void: false,
  });
  assert.deepEqual(sharedEntryActions(tab, { ...entry, voided_by_entry_id: "void" }, 0), {
    review: false,
    void: false,
  });
});

test("recorded cancellations respect opening and settled chapter boundaries", () => {
  const recorded = { ...entry, created_by: "b", status: "recorded" } as WebTabEntry;
  assert.equal(sharedEntryActions(tab, recorded, 2).void, true);
  assert.equal(sharedEntryActions(tab, recorded, 3).void, false);
  assert.equal(sharedEntryActions(tab, { ...recorded, kind: "opening" }, 0).void, false);
});

test("settlement lines use server sequence even when dates move backwards", () => {
  const entries = [
    { ...entry, id: "older", seq: 1, occurred_at_ms: 5000 },
    { ...entry, id: "newer-backdated", seq: 3, occurred_at_ms: 1000 },
  ];
  const settlement = { id: "line", through_seq: 2 } as WebTabSettlement;
  const history = sharedPeriodHistory({
    tab,
    entries,
    settlements: [settlement],
    full: true,
  } as WebTabResponse);
  assert.deepEqual(
    history.map((item) => (item.kind === "entry" ? item.entry.id : item.settlement.id)),
    ["newer-backdated", "line", "older"],
  );
});

test("shared history export retains exact amounts, currencies, cancellation evidence and safe text", () => {
  const person = { name: "=HYPERLINK(unsafe)", relationship_id: "person" } as WebPerson;
  const makePeriod = (currency: string) =>
    ({
      tab: {
        ...tab,
        id: `period-${currency}`,
        currency,
        parties: {
          a: { label: "Peer", bound: true, joined_at_ms: 1 },
          b: { label: "Owner", bound: true, joined_at_ms: 1 },
        },
      },
      entries: [
        {
          ...entry,
          amount: "9999999999.99",
          direction: "a_to_b",
          note: "+SUM(A1)",
          occurred_at_ms: 1000,
          voids_entry_id: null,
          voided_by_entry_id: "cancel-id",
        },
      ],
      settlements: [],
      full: true,
    }) as WebTabResponse;
  const privateEntry = {
    id: "private-id",
    relationship_id: "person",
    type: "debt",
    currency: "EUR",
    amount_afn: "0.01",
    created_at: 2000,
    is_deleted: false,
    note: "private",
    disputed_at: 1,
    settled_at: null,
  } as WebEntry;
  const csv = sharedHistoryCSV(
    person,
    [makePeriod("AFN"), makePeriod("USD")],
    [privateEntry],
    sharedTalliesCopy.en,
  );
  assert.ok(csv.startsWith('\ufeff"Person"'));
  assert.ok(csv.includes('"\'=HYPERLINK(unsafe)"'));
  assert.ok(csv.includes('"\'+SUM(A1)"'));
  assert.equal(csv.match(/9999999999\.99/g)?.length, 2);
  for (const expected of ["AFN", "USD", "EUR", "cancel-id", "private-id", "Disputed", "0.01"])
    assert.ok(csv.includes(`\"${expected}\"`));
});
