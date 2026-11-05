import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import { clearWebSession } from "./web-auth";
import type { WebLedger, WebPerson } from "./web-ledger";
import {
  appendWebTabEntry,
  createWebTabGroup,
  closeWebSharedAccount,
  disputeWebTabEntry,
  fetchWebTab,
  findWebSharedInvitationContact,
  joinWebSharedInvitation,
  parseWebTabResponse,
  prepareWebSharedCurrencies,
  webSharedAmount,
  webSharedMinor,
  type WebTab,
  type WebSharedInvitation,
} from "./web-tabs";

const TAB = "10000000-0000-4000-8000-000000000001";
const ENTRY = "20000000-0000-4000-8000-000000000001";
const VAULT = "30000000-0000-4000-8000-000000000001";
const PERSON = "40000000-0000-4000-8000-000000000001";
const GROUP = "50000000-0000-4000-8000-000000000001";
const originalFetch = globalThis.fetch;
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
const storage = new Map<string, string>();
const browser = Object.assign(new EventTarget(), {
  localStorage: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  },
  sessionStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
});
Object.defineProperty(globalThis, "window", { configurable: true, value: browser });
function login() {
  const account = "60000000-0000-4000-8000-000000000001",
    install = "70000000-0000-4000-8000-000000000001";
  const claims = {
    account_id: account,
    install_id: install,
    provider: "google",
    provider_sub: "synthetic",
    ep: 1,
    exp: Math.floor(Date.now() / 1000) + 3600,
  };
  storage.set(
    "kaata_web_session_v2",
    JSON.stringify({
      account_id: account,
      install_id: install,
      default_vault_id: VAULT,
      user: { has_password: false },
      session_jwt: `head.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.signature`,
    }),
  );
}
function tab(override: Partial<WebTab> = {}): WebTab {
  return {
    id: TAB,
    currency: "AFN",
    recording_mode: "review",
    you: "a",
    rev: 4,
    created_at_ms: 1,
    closed_at_ms: null,
    closed_by: null,
    parties: {
      a: { label: "Me", bound: true, joined_at_ms: 1, linked_at_ms: 5, history_order: "1" },
      b: { label: "Peer", bound: true, joined_at_ms: 2 },
    },
    balance: { a: "0", b: "0" },
    recorded_balance: { a: "0", b: "0" },
    confirmed_balance: { a: "0", b: "0" },
    pending_for_you: 0,
    unjoined_invitation: false,
    access: { append: true, review: true, void: true, settle: true, manage: true },
    ...override,
  };
}
const entry = {
  id: ENTRY,
  seq: 1,
  rev: 1,
  created_by: "a",
  direction: "a_to_b",
  amount: "12.34",
  kind: "entry",
  note: null,
  occurred_at_ms: 1,
  created_at_ms: 1,
  status: "pending",
  status_at_ms: null,
  dispute_reason: null,
  voids_entry_id: null,
  voided_by_entry_id: null,
};
const person: WebPerson = {
  relationship_id: PERSON,
  user_id: PERSON,
  name: "Peer",
  phone_e164: null,
  default_entry_currency: null,
  archived_at: null,
  read_only: false,
  read_only_reason: null,
};
const ledger: WebLedger = {
  vault_id: VAULT,
  name: "Shop",
  role: "owner",
  currency: "AFN",
  legacy_currency: "AFN",
  default_entry_currency: "AFN",
  enabled_currencies: ["AFN"],
  archived_at_ms: null,
  server_seq: 1,
  hlc_last: { pms: 1, l: 0, did: TAB },
  device_registered: true,
  people: [person],
  entries: [],
  incomplete_people: 0,
};
beforeEach(() => {
  clearWebSession();
  storage.clear();
  login();
});
after(() => {
  globalThis.fetch = originalFetch;
  if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
  else Reflect.deleteProperty(globalThis, "window");
});

test("shared amounts preserve exact signed hundredths beyond floating-point precision", () => {
  assert.equal(webSharedMinor("90071992547409.93"), 9007199254740993n);
  assert.equal(webSharedAmount(-1234n), "-12.34");
  assert.throws(() => webSharedMinor("12.345"));
});
test("full reads send the resolved party and reject mismatched or partial history", async () => {
  globalThis.fetch = (async (_url, init) => {
    assert.equal(new Headers(init?.headers).get("X-Kaata-Party"), "a");
    assert.equal(new Headers(init?.headers).get("X-Kaata-Tab-One-Way"), "1");
    return Response.json({ tab: tab(), entries: [entry], full: true });
  }) as typeof fetch;
  assert.equal((await fetchWebTab(TAB, "a")).entries.length, 1);
  await assert.rejects(fetchWebTab(TAB, "b"));
  assert.throws(() => parseWebTabResponse({ tab: tab(), entries: [entry], full: false }));
  assert.throws(() =>
    parseWebTabResponse({
      tab: tab({ recording_mode: "future" as never }),
      entries: [],
      full: true,
    }),
  );
});
test("each financial mutation probes capabilities before sending the stable entry ID", async () => {
  const calls: string[] = [];
  globalThis.fetch = (async (url, init) => {
    calls.push(String(url));
    if (String(url).endsWith("capabilities")) return Response.json({ multi_currency: true });
    assert.equal(JSON.parse(String(init?.body)).id, ENTRY);
    return Response.json({ tab: tab(), entry });
  }) as typeof fetch;
  await appendWebTabEntry(tab(), {
    id: ENTRY,
    direction: "a_to_b",
    amount: "12.34",
    note: null,
    occurred_at_ms: 1,
  });
  assert.equal(calls.length, 2);
  calls.length = 0;
  globalThis.fetch = (async (url) => {
    calls.push(String(url));
    return Response.json({ multi_currency: true, notification_only_tallies: false });
  }) as typeof fetch;
  await assert.rejects(
    appendWebTabEntry(tab({ recording_mode: "notify" }), {
      id: ENTRY,
      direction: "a_to_b",
      amount: "12.34",
      note: null,
      occurred_at_ms: 1,
    }),
  );
  assert.equal(calls.length, 1);
});
test("logout or abort during the capability probe prevents the write", async () => {
  for (const scenario of ["logout", "abort"]) {
    login();
    const controller = new AbortController();
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      if (scenario === "logout") clearWebSession();
      else controller.abort();
      return Response.json({ multi_currency: true });
    }) as typeof fetch;
    await assert.rejects(
      appendWebTabEntry(
        tab(),
        { id: ENTRY, direction: "a_to_b", amount: "1", note: null, occurred_at_ms: 1 },
        controller.signal,
      ),
    );
    assert.equal(calls, 1);
  }
});
test("unknown server permissions and one-way recipient permissions fail closed", async () => {
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    return Response.json({});
  }) as typeof fetch;
  for (const current of [
    tab({ access: undefined }),
    tab({
      you: "b",
      recording_mode: "notify_one_way",
      access: { append: false, review: false, void: false, settle: false, manage: false },
    }),
  ])
    await assert.rejects(
      appendWebTabEntry(current, {
        id: ENTRY,
        direction: "a_to_b",
        amount: "1",
        note: null,
        occurred_at_ms: 1,
      }),
    );
  assert.equal(calls, 0);
});
test("replacement openings use authoritative unified totals and all prior revisions", async () => {
  const currentPerson: WebPerson = {
    ...person,
    shared: {
      tabs: [
        {
          id: TAB,
          role: "a",
          currency: "AFN",
          history_order: "1",
          linked_at_ms: 5,
          closed_at_ms: 9,
          recording_mode: "review",
          rev: 4,
          unjoined_invitation: false,
        },
      ],
      balances: [
        { currency: "AFN", recorded: "31.27", confirmed: "25", pending: "0", private: "6.27" },
      ],
      pending_for_you: 0,
    },
  };
  globalThis.fetch = (async () =>
    Response.json({ tab: tab({ closed_at_ms: 9 }), entries: [], full: true })) as typeof fetch;
  const prepared = await prepareWebSharedCurrencies(
    { ...ledger, people: [currentPerson] },
    currentPerson,
  );
  assert.equal(prepared[0].opening?.amount, "31.27");
  assert.deepEqual(prepared[0].expected_history_revisions, { [TAB]: 4 });
  globalThis.fetch = (async () =>
    Response.json({ tab: tab({ closed_at_ms: 9 }), entries: [entry], full: true })) as typeof fetch;
  await assert.rejects(
    prepareWebSharedCurrencies({ ...ledger, people: [currentPerson] }, currentPerson),
  );
});
test("a lost group-create response reuses its exact source boundary on retry", async () => {
  const bodies: string[] = [];
  globalThis.fetch = (async (url, init) => {
    if (String(url).endsWith("capabilities"))
      return Response.json({ multi_currency: true, multi_currency_tabs: true });
    bodies.push(String(init?.body));
    if (bodies.length === 1) throw new Error("lost response");
    return Response.json({
      group: {
        id: GROUP,
        recording_mode: "review",
        rev: 1,
        you: "a",
        currencies: ["AFN"],
        parties: { a: { vault_id: VAULT, relationship_id: PERSON } },
      },
      tabs: [{ tab: tab({ group_id: GROUP }), entries: [], full: true }],
    });
  }) as typeof fetch;
  const draft = {
    request_id: GROUP,
    invite_token: "a".repeat(43),
    label: "My shop",
    recording_mode: "review" as const,
  };
  await assert.rejects(createWebTabGroup(ledger, person, draft));
  await createWebTabGroup(ledger, person, draft);
  assert.equal(bodies[0], bodies[1]);
});

test("append accepts 500 Unicode note characters and dispute keeps its 300-character limit", async () => {
  let writes = 0;
  globalThis.fetch = (async (url, init) => {
    if (String(url).endsWith("capabilities")) return Response.json({ multi_currency: true });
    writes++;
    const body = JSON.parse(String(init?.body));
    if (String(url).endsWith("dispute")) assert.equal(body.reason, "r".repeat(300));
    return Response.json({ tab: tab(), entry });
  }) as typeof fetch;
  await appendWebTabEntry(tab(), {
    id: ENTRY,
    direction: "a_to_b",
    amount: "1",
    note: "😀".repeat(500),
    occurred_at_ms: 1,
  });
  await assert.rejects(
    appendWebTabEntry(tab(), {
      id: ENTRY,
      direction: "a_to_b",
      amount: "1",
      note: "😀".repeat(501),
      occurred_at_ms: 1,
    }),
  );
  await disputeWebTabEntry(tab(), ENTRY, ` ${"r".repeat(300)} `, 1);
  assert.throws(() => disputeWebTabEntry(tab(), ENTRY, "r".repeat(301), 1));
  assert.equal(writes, 2);
});

test("preparing history withdraws an unused closed opening while ordinary closed management stays disabled", async () => {
  const currentTab = tab({
    closed_at_ms: 9,
    unjoined_invitation: true,
    access: { append: false, review: false, void: false, settle: false, manage: false },
  });
  const opening = { ...entry, kind: "opening", amount: "100.05" };
  const linked: WebPerson = {
    ...person,
    shared: {
      tabs: [
        {
          id: TAB,
          role: "a",
          currency: "AFN",
          history_order: "1",
          linked_at_ms: 5,
          closed_at_ms: 9,
          recording_mode: "review",
          rev: 4,
          unjoined_invitation: true,
        },
      ],
      balances: [
        { currency: "AFN", recorded: "100.05", confirmed: "0", pending: "0", private: "100.05" },
      ],
      pending_for_you: 0,
    },
  };
  let withdrawn = false,
    posts = 0;
  globalThis.fetch = (async (url, init) => {
    if (String(url).endsWith("capabilities")) return Response.json({ multi_currency: true });
    if (init?.method === "POST") {
      posts++;
      assert.equal(JSON.parse(String(init.body)).withdraw_unjoined_opening, true);
      withdrawn = true;
    }
    return Response.json({
      tab: currentTab,
      entries: [{ ...opening, voided_by_entry_id: withdrawn ? GROUP : null }],
      full: true,
    });
  }) as typeof fetch;
  await assert.rejects(closeWebSharedAccount(currentTab));
  assert.equal(posts, 0);
  const currencies = await prepareWebSharedCurrencies({ ...ledger, people: [linked] }, linked);
  assert.equal(posts, 1);
  assert.equal(currencies[0].opening?.amount, "100.05");
});

test("review joins protect a nonzero recipient balance and closed invitations never mutate", async () => {
  const invitation: WebSharedInvitation = {
    kind: "tab",
    tab: tab({ you: "b" }),
    entries: [],
    full: true,
  };
  let requests = 0;
  globalThis.fetch = (async () => {
    requests++;
    return Response.json({});
  }) as typeof fetch;
  const source = {
    id: ENTRY,
    relationship_id: PERSON,
    type: "debt" as const,
    amount_afn: "750",
    currency: "AFN",
    note: null,
    created_at: 1,
    recorded_at_ms: 1,
    updated_at: 1,
    current_event_id: ENTRY,
    is_deleted: false,
    read_only: false,
    settled_at: null,
  };
  await assert.rejects(
    joinWebSharedInvitation(invitation, "opaque", { ...ledger, entries: [source] }, person, "Me"),
    { code: "shared_account_currency_history" },
  );
  await assert.rejects(
    joinWebSharedInvitation(
      { ...invitation, tab: tab({ closed_at_ms: 9 }) },
      "opaque",
      ledger,
      person,
      "Me",
    ),
    { code: "tab_closed" },
  );
  assert.equal(requests, 0);
  const prepared = await prepareWebSharedCurrencies(
    { ...ledger, entries: [{ ...source, disputed_at: 3 }] },
    person,
  );
  assert.equal(prepared[0].opening, null);
});

test("invitation recovery matches its group or tab and the account's exact party", () => {
  const binding = {
    id: TAB,
    group_id: GROUP,
    role: "b" as const,
    currency: "AFN",
    history_order: "1",
    linked_at_ms: 5,
    closed_at_ms: null,
    recording_mode: "review" as const,
    rev: 4,
    unjoined_invitation: false,
  };
  const bound: WebPerson = {
    ...person,
    shared: { tabs: [binding], balances: [], pending_for_you: 0 },
  };
  const current = { ...ledger, people: [bound] };
  const invitation: WebSharedInvitation = {
    kind: "tab",
    tab: tab({ you: "b" }),
    entries: [],
    full: true,
  };
  assert.equal(findWebSharedInvitationContact(current, invitation), bound);
  assert.equal(
    findWebSharedInvitationContact(current, { ...invitation, tab: tab({ you: "a" }) }),
    undefined,
  );
  const group = {
    kind: "group",
    group: { id: GROUP, you: "b" },
    tabs: [],
  } as unknown as WebSharedInvitation;
  assert.equal(findWebSharedInvitationContact(current, group), bound);
  assert.equal(findWebSharedInvitationContact(current, null), undefined);
});
