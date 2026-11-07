import assert from "node:assert/strict";
import { test } from "node:test";
import { parseSharedLedger } from "./shared-ledger";
import { buildWebBill, createWebBillLink } from "./web-bill";
import { clearWebSession, type WebSession } from "./web-auth";
import type { WebEntry, WebLedger, WebPerson } from "./web-ledger";

const customer: WebPerson = {
  relationship_id: "customer",
  user_id: "private-customer-id",
  name: "Customer",
  phone_e164: "+93700123456",
  note: "Private staff note",
  default_entry_currency: null,
  archived_at: null,
  read_only: false,
  read_only_reason: null,
  settled_through: { AFN: 10 },
};

function entry(id: string, overrides: Partial<WebEntry> = {}): WebEntry {
  return {
    id,
    relationship_id: customer.relationship_id,
    type: "debt",
    amount_afn: "12.34",
    currency: "AFN",
    note: "Invoice note",
    created_at: 7,
    recorded_at_ms: 9,
    updated_at: 9,
    current_event_id: "private-event-id",
    is_deleted: false,
    read_only: false,
    settled_at: 10,
    ...overrides,
  };
}

function ledger(entries: WebEntry[] = []): WebLedger {
  return {
    vault_id: "private-vault-id",
    name: "Corner Shop",
    role: "owner",
    currency: "AFN",
    legacy_currency: "AFN",
    default_entry_currency: "AFN",
    bill_links_enabled: true,
    enabled_currencies: ["AFN", "USD"],
    archived_at_ms: null,
    server_seq: 0,
    hlc_last: { pms: 0, l: 0, did: "private-device-id" },
    device_registered: false,
    people: [customer],
    entries,
    incomplete_people: 0,
  };
}

test("private bills preserve independent currencies, both dates, and customer-facing entry notes", () => {
  const bill = buildWebBill(
    ledger([
      entry("afn"),
      entry("usd", { currency: "USD", type: "payment", amount_afn: "0.21", settled_at: null }),
      entry("deleted", { is_deleted: true, note: "Deleted note" }),
      entry("disputed", { disputed_at: 30, note: "Disputed note" }),
      entry("other", { relationship_id: "other-customer", note: "Other customer's note" }),
    ]),
    customer.relationship_id,
    "ps",
    50,
  );
  assert.equal(bill.v, 2);
  assert.equal(bill.shop, "Corner Shop");
  assert.equal(bill.calendar, "jalali");
  assert.deepEqual(
    bill.currencies.map(({ currency, balance }) => [currency, balance]),
    [
      ["AFN", 12.34],
      ["USD", -0.21],
    ],
  );
  assert.deepEqual(bill.currencies[0].settled_boundaries, [10]);
  assert.deepEqual(bill.currencies[0].entries, [
    {
      currency: "AFN",
      type: "debt",
      amount: 12.34,
      note: "Invoice note",
      date: 7,
      recorded_at_ms: 9,
    },
  ]);
  assert.equal(bill.currencies[1].entries.length, 1);
  const body = JSON.stringify(bill);
  assert.doesNotMatch(
    body,
    /private-|Private staff note|Deleted note|Disputed note|Other customer|93700123456/,
  );
  assert.deepEqual(parseSharedLedger(JSON.parse(body)), bill);
});

test("partial shared histories and amounts the bill format cannot represent are refused", () => {
  const book = ledger();
  book.people = [{ ...customer, read_only_reason: "shared_tab" }];
  assert.throws(() => buildWebBill(book, customer.relationship_id, "en"), {
    message: "unavailable",
  });
  const large = ledger([entry("large", { amount_afn: "90071992547409.91" })]);
  assert.throws(() => buildWebBill(large, customer.relationship_id, "en"), { message: "invalid" });
});

test("publication requires a fresh authorized read of the exact preview and honors book settings", async (t) => {
  const session: WebSession = {
    account_id: "fixture-account",
    install_id: "fixture-install",
    default_vault_id: null,
    session_jwt: "",
    user: { has_password: false },
  };
  session.session_jwt = `header.${Buffer.from(
    JSON.stringify({
      account_id: session.account_id,
      install_id: session.install_id,
      exp: Math.floor(Date.now() / 1000) + 60,
    }),
  ).toString("base64url")}.signature`;
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const originalFetch = globalThis.fetch;
  const storage = new Map([["kaata_web_session_v2", JSON.stringify(session)]]);
  const fakeStorage = {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  };
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: Object.assign(new EventTarget(), {
      localStorage: fakeStorage,
      sessionStorage: fakeStorage,
    }),
  });
  t.after(() => {
    clearWebSession();
    globalThis.fetch = originalFetch;
    if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
    else Reflect.deleteProperty(globalThis, "window");
  });

  const book = ledger([entry("one")]);
  const reviewed = buildWebBill(book, customer.relationship_id, "en", 50);
  const signal = new AbortController().signal;
  const requests: string[] = [];
  const token = "abcDEF_012-34567";
  const link = `https://kaata.af/v2/${token}`;
  let responseURL = link;
  let denyRead = false;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    requests.push(path);
    if (path === "/v1/sync/ledger") {
      assert.equal(
        new Headers(init?.headers).get("Authorization"),
        `Bearer ${session.session_jwt}`,
      );
      return denyRead
        ? Response.json({ error: "forbidden" }, { status: 403 })
        : Response.json(book);
    }
    assert.equal(new Headers(init?.headers).has("Authorization"), false);
    assert.equal(init?.credentials, "omit");
    if (path === "/v1/shared/capabilities") return Response.json({ bill_versions: [1, 2, 3] });
    assert.equal(path, "/v1/shared");
    assert.deepEqual(JSON.parse(String(init?.body)), reviewed);
    return Response.json({ token, url: responseURL, bill_version: 2 });
  }) as typeof fetch;
  const publish = () =>
    createWebBillLink(session, book.vault_id, customer.relationship_id, "en", reviewed, signal);

  assert.equal(await publish(), link);
  assert.deepEqual(requests.splice(0), [
    "/v1/shared/capabilities",
    "/v1/sync/ledger",
    "/v1/shared",
  ]);

  responseURL = `https://kaata.af.evil.example/v2/${token}`;
  await assert.rejects(publish(), { message: "publish_failed" });
  assert.equal(requests.splice(0).at(-1), "/v1/shared");

  book.entries[0].note = "Changed during preview";
  await assert.rejects(publish(), { message: "stale" });
  assert.deepEqual(requests.splice(0), ["/v1/shared/capabilities", "/v1/sync/ledger"]);

  book.bill_links_enabled = false;
  await assert.rejects(publish(), { message: "unavailable" });
  assert.deepEqual(requests.splice(0), ["/v1/shared/capabilities", "/v1/sync/ledger"]);

  delete book.bill_links_enabled;
  await assert.rejects(publish(), { message: "unavailable" });
  assert.deepEqual(requests.splice(0), ["/v1/shared/capabilities", "/v1/sync/ledger"]);

  denyRead = true;
  await assert.rejects(publish(), { status: 403 });
  assert.deepEqual(requests, ["/v1/shared/capabilities", "/v1/sync/ledger"]);
});
