import assert from "node:assert/strict";
import type { Entry } from "../types";

// Run the actual sharing module; replace only native/storage/network edges.
// All data and URLs are synthetic. Never opens WhatsApp or talks to a backend.
const priorModules = new Map<string, NodeJS.Module | undefined>();
function stub(name: string, exports: object) {
  const filename = require.resolve(name);
  priorModules.set(filename, require.cache[filename]);
  require.cache[filename] = { id: filename, filename, loaded: true, exports } as NodeJS.Module;
}
const priorFetch = globalThis.fetch;
const priorDev = (globalThis as { __DEV__?: boolean }).__DEV__;
(globalThis as { __DEV__?: boolean }).__DEV__ = false;
const opens: string[] = [];
let openError = false;
let counterError = false;
let counters = 0;
stub("react-native", {
  Linking: {
    openURL: async (url: string) => {
      if (openError) throw new Error("synthetic WhatsApp unavailable");
      opens.push(url);
    },
  },
});
let backendWait: Promise<string> | null = null;
stub("../api", { getBackendUrl: async () => backendWait ?? "https://example.invalid" });
let selectedCalendar = "jalali";
let qamariOffset = 0;
stub("../calendar", {
  getEffectiveCalendar: () => selectedCalendar,
  getQamariOffset: () => qamariOffset,
});
let selectedCurrency = "AFN";
stub("../currency", {
  getCurrentCurrencyCode: () => selectedCurrency,
  getCurrencySymbol: (code: string) =>
    (({ USD: "$", AFN: "؋", AUD: "A$" }) as Record<string, string>)[code] ?? code,
});
stub("../db", {
  bumpUsageCounter: async () => {
    counters++;
    if (counterError) throw new Error("synthetic counter failure");
  },
});
stub("../format", { formatAmount: (amount: number) => String(Math.abs(amount)) });
stub("../i18n", {
  tIn: (_lang: string, key: string, args: Record<string, unknown> = {}) =>
    `${key}${Object.keys(args).length ? ":" + JSON.stringify(args) : ""}`,
});

function tally(id: string, note: string, tab?: Entry["tab"]): Entry {
  return {
    id,
    relationship_id: "r",
    type: "debt",
    amount_afn: 5,
    note,
    created_at: 1,
    updated_at: 1,
    deleted_at: null,
    proposed_by_user_id: null,
    accepted_at: null,
    disputed_at: null,
    disputed_reason: null,
    settled_at: null,
    tab,
  };
}
const meta = {
  tab_id: "tab",
  kind: "entry",
  author_account_id: "a",
  author_party: "a",
  seq: 1,
  rev: 1,
  status: "accepted",
  voided: false,
  local_pending: false,
  by: "me",
  dispute_reason: null,
  other_label: "Other party",
} as const;
const entries = [
  tally("accepted", "Whole statement, even while a note filter is visible"),
  tally("pending", "Awaiting review", { ...meta, status: "pending" }),
  tally("unsynced-accept", "Acceptance awaiting sync", { ...meta, local_pending: true }),
  tally("voided", "Cancelled", { ...meta, voided: true }),
  tally("rejected", "Rejected", { ...meta, status: "disputed" }),
];

async function main() {
  const { shareKaataViaWhatsApp, shareKaataCurrenciesViaWhatsApp } =
    require("../share") as typeof import("../share");
  const person = { id: "synthetic", name: "Test person", phone: "+93 (700) 000 001" };
  const stages: string[] = [];
  let snapshot: Record<string, any> | undefined;
  let completeUpload!: (value: Response) => void;
  globalThis.fetch = (async (_url: unknown, init: RequestInit) => {
    snapshot = JSON.parse(String(init.body));
    return new Promise<Response>((resolve) => {
      completeUpload = resolve;
    });
  }) as typeof fetch;
  const pending = shareKaataViaWhatsApp(
    person,
    10,
    null,
    entries,
    "fa",
    { settledChapters: 0, settledBoundaryMs: null, settledBoundaries: [] },
    (stage) => stages.push(stage),
  );
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(stages, ["preparing"]);
  assert.equal(opens.length, 0, "WhatsApp waits while the statement is preparing");
  assert.equal(snapshot!.locale, "fa");
  assert.equal(snapshot!.calendar, "jalali");
  assert.equal("qamari_offset" in snapshot!, false, "no adjustment field off Qamari");
  assert.deepEqual(
    snapshot!.entries.map((entry: any) => entry.note),
    entries.slice(0, 1).map((e) => e.note),
    "a public bill lists confirmed amounts; pending reviews cannot masquerade as ordinary payments",
  );
  assert.equal(snapshot!.balance, 10);
  completeUpload(
    new Response(JSON.stringify({ url: "https://example.invalid/v/bill" }), { status: 201 }),
  );
  assert.equal(await pending, true);
  assert.deepEqual(stages, ["preparing", "opening"]);
  const first = new URL(opens[0]);
  assert.equal(first.searchParams.get("phone"), "+93700000001");
  assert.match(first.searchParams.get("text")!, /share.theyOwe.header/);
  assert.match(first.searchParams.get("text")!, /https:\/\/example.invalid\/v\/bill/);
  assert.equal(counters, 1);

  // Freeze the explicit third calendar even when the message language is
  // English. Later local preference changes cannot mutate an issued bill.
  selectedCalendar = "qamari";
  qamariOffset = -1;
  globalThis.fetch = (async (_url: unknown, init: RequestInit) => {
    snapshot = JSON.parse(String(init.body));
    return new Response(JSON.stringify({ url: "https://example.invalid/v/qamari" }), {
      status: 201,
    });
  }) as typeof fetch;
  assert.equal(await shareKaataViaWhatsApp(person, 10, null, entries, "en"), true);
  assert.equal(snapshot!.calendar, "qamari");
  assert.equal(snapshot!.qamari_offset, -1, "the Qamari adjustment is frozen too (audit #15)");
  assert.equal(snapshot!.locale, "en");
  assert.equal(snapshot!.entries[0].date, entries[0].created_at, "timestamps remain unchanged");
  selectedCalendar = "gregorian";
  qamariOffset = 0;
  assert.equal(snapshot!.calendar, "qamari", "bill calendar stays frozen");
  // Restore the prior fixture's counters for its routing/failure assertions.
  opens.pop();
  counters--;

  // Network failure still opens an ordinary text reminder; metadata writes
  // must not turn a successful open into a reported failure.
  globalThis.fetch = (async () => {
    throw new Error("synthetic offline");
  }) as typeof fetch;
  counterError = true;
  const fallbackStages: string[] = [];
  assert.equal(
    await shareKaataViaWhatsApp(
      { ...person, phone: null },
      -10,
      null,
      entries,
      "en",
      undefined,
      (stage) => fallbackStages.push(stage),
    ),
    true,
  );
  assert.deepEqual(fallbackStages, ["preparing", "opening"]);
  const fallback = new URL(opens[1]);
  assert.equal(fallback.searchParams.get("phone"), null);
  assert.match(fallback.searchParams.get("text")!, /share.youOwe.header/);
  assert.match(fallback.searchParams.get("text")!, /share.footer/);
  assert.doesNotMatch(fallback.searchParams.get("text")!, /share.fullLedger/);

  // A reached server that gives no usable link has the same plain-text path.
  globalThis.fetch = (async () => new Response(JSON.stringify({ url: "" }))) as typeof fetch;
  assert.equal(await shareKaataViaWhatsApp(person, 0, null, entries, "en"), true);
  assert.match(new URL(opens[2]).searchParams.get("text")!, /share.settled.line/);
  openError = true;
  const beforeCounters = counters;
  const savedWarn = console.warn;
  console.warn = () => {};
  try {
    assert.equal(await shareKaataViaWhatsApp(person, 0, null, entries, "en"), false);
  } finally {
    console.warn = savedWarn;
  }
  assert.equal(counters, beforeCounters, "failed WhatsApp opens do not count as successful shares");
  openError = false;
  const controller = new AbortController();
  const cancelStages: string[] = [];
  let uploadSignal: AbortSignal | undefined;
  globalThis.fetch = (async (_url: unknown, init: RequestInit) => {
    uploadSignal = init.signal as AbortSignal;
    return new Promise<Response>((resolve) => {
      completeUpload = resolve;
    });
  }) as typeof fetch;
  const cancelled = shareKaataViaWhatsApp(
    person,
    10,
    null,
    entries,
    "en",
    undefined,
    (stage) => cancelStages.push(stage),
    controller.signal,
  );
  await Promise.resolve();
  await Promise.resolve();
  controller.abort();
  assert.equal(uploadSignal!.aborted, true, "leaving aborts the snapshot request too");
  completeUpload(new Response(JSON.stringify({ url: "https://example.invalid/v/late" })));
  assert.equal(await cancelled, false);
  assert.deepEqual(cancelStages, ["preparing"], "late upload completion never reaches opening");
  assert.equal(opens.length, 3, "a cancelled reminder cannot launch WhatsApp from another screen");
  assert.equal(
    await shareKaataViaWhatsApp(
      person,
      10,
      null,
      entries,
      "en",
      undefined,
      undefined,
      controller.signal,
    ),
    false,
  );
  selectedCurrency = "USD";
  const usdEntries = entries.map((entry) => ({ ...entry, currency: "USD" }));
  globalThis.fetch = (async (_url: unknown, init: RequestInit) => {
    snapshot = JSON.parse(String(init.body));
    selectedCurrency = "AFN";
    return new Response(JSON.stringify({ url: "https://example.invalid/v/usd" }), { status: 201 });
  }) as typeof fetch;
  assert.equal(await shareKaataViaWhatsApp(person, 10, null, usdEntries, "en"), true);
  assert.equal(snapshot!.currency_code, "USD");
  assert.equal(snapshot!.currency, "$ USD", "issued currency is frozen despite a view change");
  assert.match(new URL(opens.at(-1)!).searchParams.get("text")!, /USD/);
  await assert.rejects(
    shareKaataViaWhatsApp(
      person,
      10,
      null,
      [...usdEntries, { ...entries[0], currency: "AFN" }],
      "en",
    ),
    /different currencies/,
  );

  const afnHistory = Array.from({ length: 140 }, (_, i) => ({
    ...tally(
      `afn-${i}`,
      i === 0 ? "Old settled tally outside visible search/date filter" : `AFN tally ${i}`,
    ),
    currency: "AFN",
    created_at: i + 1,
  }));
  const usdHistory = [
    {
      ...tally("usd-receipt", "Received in USD"),
      currency: "USD",
      type: "payment" as const,
      amount_afn: 700,
      created_at: 200,
    },
    {
      ...tally("usd-pending", "Not acknowledged", { ...meta, status: "pending" }),
      currency: "USD",
      amount_afn: 50,
    },
  ];
  const audHistory = [
    { ...tally("aud-a", "AUD exact cents"), currency: "AUD", amount_afn: 0.1 },
    { ...tally("aud-b", "AUD exact cents"), currency: "AUD", amount_afn: 0.2 },
    {
      ...tally("aud-paid", "AUD settled"),
      currency: "AUD",
      type: "payment" as const,
      amount_afn: 0.3,
    },
  ];
  const statements = [
    {
      currency: "AFN",
      balance: 700,
      entries: afnHistory,
      settled: { settledChapters: 1, settledBoundaryMs: 70, settledBoundaries: [70] },
    },
    { currency: "USD", balance: -700, entries: usdHistory },
    { currency: "AUD", balance: 0, entries: audHistory },
  ];
  const requests: string[] = [];
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    requests.push(String(url));
    if (String(url).endsWith("/capabilities"))
      return Response.json({ bill_versions: [1, 2], multi_currency: true });
    snapshot = JSON.parse(String(init?.body));
    selectedCurrency = "EUR";
    return Response.json({ bill_version: 2, url: "https://example.invalid/v2/all-currencies" });
  }) as typeof fetch;
  const fullStages: string[] = [];
  assert.equal(
    await shareKaataCurrenciesViaWhatsApp(person, null, statements, "fa", (stage) =>
      fullStages.push(stage),
    ),
    true,
  );
  assert.deepEqual(fullStages, ["preparing", "opening"]);
  assert.ok(requests[0].endsWith("/v1/shared/capabilities"));
  assert.ok(requests[1].endsWith("/v1/shared"));
  assert.equal(snapshot!.v, 2);
  assert.equal("balance" in snapshot!, false);
  assert.equal("currency" in snapshot!, false);
  assert.equal("entries" in snapshot!, false);
  assert.deepEqual(
    snapshot!.currencies.map((section: any) => [section.currency_code, section.balance]),
    [
      ["AFN", 700],
      ["USD", -700],
      ["AUD", 0],
    ],
  );
  assert.equal(
    snapshot!.currencies[0].entries.length,
    140,
    "full history is never silently truncated at100",
  );
  assert.equal(
    snapshot!.currencies[0].entries[0].note,
    afnHistory[0].note,
    "folded/search/date-hidden history remains on the bill",
  );
  assert.deepEqual(snapshot!.currencies[0].settled_boundaries, [70]);
  assert.deepEqual(
    snapshot!.currencies[1].settled_boundaries,
    [],
    "settlement metadata never crosses currencies",
  );
  assert.equal(
    snapshot!.currencies[1].entries.length,
    1,
    "unacknowledged rows never masquerade as billed money",
  );
  for (const section of snapshot!.currencies)
    assert.ok(section.entries.every((entry: any) => entry.currency === section.currency_code));
  const fullText = new URL(opens.at(-1)!).searchParams.get("text")!;
  assert.match(fullText, /share.theyOwe.amount.*700.*AFN/);
  assert.match(fullText, /share.youOwe.amount.*700.*USD/);
  assert.match(fullText, /share.currencySettled.*AUD/);
  assert.doesNotMatch(fullText, /share.settled.line/);
  assert.match(fullText, /https:\/\/example.invalid\/v2\/all-currencies/);

  let resolveBackend!: (value: string) => void;
  backendWait = new Promise<string>((resolve) => {
    resolveBackend = resolve;
  });
  const frozenPerson = { ...person };
  const frozenEntry = { ...tally("frozen", "Original note"), currency: "AFN", amount_afn: 1 };
  const frozenBoundaries = [1];
  const frozenStatement = {
    currency: "AFN",
    balance: 1,
    entries: [frozenEntry],
    settled: { settledChapters: 1, settledBoundaryMs: 1, settledBoundaries: frozenBoundaries },
  };
  selectedCalendar = "qamari";
  qamariOffset = -1;
  const freeze = shareKaataCurrenciesViaWhatsApp(frozenPerson, null, [frozenStatement], "ps");
  frozenEntry.amount_afn = 999;
  frozenEntry.currency = "USD";
  frozenEntry.note = "Changed while waiting";
  frozenStatement.balance = 999;
  frozenBoundaries.push(99);
  frozenPerson.phone = "+61499999999";
  selectedCalendar = "gregorian";
  qamariOffset = 2;
  resolveBackend("https://example.invalid");
  await freeze;
  backendWait = null;
  assert.equal(snapshot!.calendar, "qamari");
  assert.equal(snapshot!.qamari_offset, -1);
  assert.equal(snapshot!.locale, "ps");
  assert.equal(snapshot!.currencies[0].balance, 1);
  assert.deepEqual(snapshot!.currencies[0].entries, [
    { currency: "AFN", type: "debt", amount: 1, note: "Original note", date: 1 },
  ]);
  assert.deepEqual(snapshot!.currencies[0].settled_boundaries, [1]);
  assert.equal(
    new URL(opens.at(-1)!).searchParams.get("phone"),
    "+93700000001",
    "recipient and statement are frozen before any asynchronous preparation",
  );
  await shareKaataCurrenciesViaWhatsApp(
    person,
    null,
    [{ currency: "AUD", balance: 0, entries: audHistory }],
    "en",
  );
  assert.match(
    new URL(opens.at(-1)!).searchParams.get("text")!,
    /share.currencySettled.*AUD/,
    "even a single settled currency keeps its label",
  );
  const capacity = Array.from({ length: 5000 }, (_, i) => ({
    ...tally(`capacity-${i}`, "Complete maximum-size bill"),
    currency: "AFN",
    amount_afn: 1,
  }));
  await shareKaataCurrenciesViaWhatsApp(
    person,
    null,
    [{ currency: "AFN", balance: 5000, entries: capacity }],
    "en",
  );
  assert.equal(
    snapshot!.currencies[0].entries.length,
    5000,
    "the complete accepted capacity reaches the server unchanged",
  );

  // The older explicit-row API remains scoped to exactly the supplied rows.
  selectedCurrency = "USD";
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    snapshot = JSON.parse(String(init?.body));
    return Response.json({ url: "https://example.invalid/v/selected" });
  }) as typeof fetch;
  assert.equal(
    await shareKaataViaWhatsApp(
      person,
      -700,
      null,
      [usdHistory[0]],
      "en",
      undefined,
      undefined,
      undefined,
      "USD",
    ),
    true,
  );
  assert.equal(snapshot!.v, 1);
  assert.equal(snapshot!.entries.length, 1);
  assert.equal(snapshot!.entries[0].note, "Received in USD");
  const selectedRows = afnHistory.slice(20, 121).map((entry) => ({ ...entry, currency: "USD" }));
  await shareKaataViaWhatsApp(
    person,
    selectedRows.length * 5,
    null,
    selectedRows,
    "en",
    undefined,
    undefined,
    undefined,
    "USD",
  );
  assert.equal(
    snapshot!.entries.length,
    101,
    "an explicit selection over100 rows also stays complete",
  );
  assert.deepEqual(
    snapshot!.entries.map((entry: any) => entry.note),
    selectedRows.map((entry) => entry.note),
    "scoped sharing never expands to hidden/unselected customer rows",
  );

  // An older backend must never get a v2 packet it would misrender as zero.
  let posts = 0;
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    if (init?.method === "POST") posts++;
    return new Response(null, { status: 404 });
  }) as typeof fetch;
  assert.equal(await shareKaataCurrenciesViaWhatsApp(person, null, statements, "en"), true);
  assert.equal(posts, 0);
  let fallbackText = new URL(opens.at(-1)!).searchParams.get("text")!;
  assert.match(fallbackText, /share.billUnavailable/);
  assert.doesNotMatch(fallbackText, /share.fullLedger|https:\/\/example.invalid\/v/);
  assert.match(fallbackText, /AFN/);
  assert.match(fallbackText, /USD/);
  assert.match(fallbackText, /AUD/);

  // Probe may reach a new worker while POST reaches an old rolling worker.
  globalThis.fetch = (async (url: unknown) =>
    String(url).endsWith("/capabilities")
      ? Response.json({ bill_versions: [1, 2] })
      : Response.json({ url: "https://example.invalid/v/old-zero-renderer" })) as typeof fetch;
  await shareKaataCurrenciesViaWhatsApp(person, null, statements, "en");
  fallbackText = new URL(opens.at(-1)!).searchParams.get("text")!;
  assert.match(fallbackText, /share.billUnavailable/);
  assert.doesNotMatch(fallbackText, /old-zero-renderer|share.fullLedger/);

  // Server body limit rejects the whole bill; no shortened link is substituted.
  globalThis.fetch = (async (url: unknown) =>
    String(url).endsWith("/capabilities")
      ? Response.json({ bill_versions: [2] })
      : new Response(null, { status: 413 })) as typeof fetch;
  await shareKaataCurrenciesViaWhatsApp(person, null, statements, "en");
  assert.match(new URL(opens.at(-1)!).searchParams.get("text")!, /share.billUnavailable/);
  globalThis.fetch = (async () => {
    throw new Error("synthetic offline");
  }) as typeof fetch;
  await shareKaataCurrenciesViaWhatsApp(person, null, statements, "en");
  assert.match(new URL(opens.at(-1)!).searchParams.get("text")!, /share.billUnavailable/);

  // Capacity is all-or-nothing, with no POST or partial public link.
  let oversizeRequests = 0;
  globalThis.fetch = (async () => {
    oversizeRequests++;
    throw new Error("must not upload an oversized bill");
  }) as typeof fetch;
  const tooMany = Array.from({ length: 5001 }, (_, i) => ({
    ...tally(`large-${i}`, "Full history"),
    currency: "AFN",
    amount_afn: 1,
  }));
  await shareKaataCurrenciesViaWhatsApp(
    person,
    null,
    [{ currency: "AFN", balance: 5001, entries: tooMany }],
    "en",
  );
  assert.equal(oversizeRequests, 0);
  assert.match(new URL(opens.at(-1)!).searchParams.get("text")!, /share.billUnavailable/);

  const beforeInvalid = opens.length;
  await assert.rejects(
    shareKaataCurrenciesViaWhatsApp(person, null, [{ ...statements[0], pending: true }], "en"),
    /not fully synced/,
  );
  await assert.rejects(
    shareKaataCurrenciesViaWhatsApp(person, null, [{ ...statements[0], currency: "USD" }], "en"),
    /different currencies/,
  );
  assert.equal(opens.length, beforeInvalid);

  let finishBill!: (response: Response) => void;
  let billSignal: AbortSignal | undefined;
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    if (String(url).endsWith("/capabilities")) return Response.json({ bill_versions: [2] });
    billSignal = init?.signal as AbortSignal;
    return new Promise<Response>((resolve) => {
      finishBill = resolve;
    });
  }) as typeof fetch;
  const billController = new AbortController();
  const beforeCancel = opens.length;
  const bill = shareKaataCurrenciesViaWhatsApp(
    person,
    null,
    statements,
    "en",
    undefined,
    billController.signal,
  );
  for (let i = 0; i < 20 && !finishBill; i++) await Promise.resolve();
  assert.ok(finishBill);
  billController.abort();
  assert.equal(billSignal!.aborted, true);
  finishBill(Response.json({ bill_version: 2, url: "https://example.invalid/v2/late" }));
  assert.equal(await bill, false);
  assert.equal(
    opens.length,
    beforeCancel,
    "late all-currency uploads cannot open another app after leaving",
  );
  console.log(
    "PASS: complete multi-currency WhatsApp bills, scoped selected rows, per-currency balances/chapters, no truncation, version/limit/offline fallback and abort guards",
  );
}
main()
  .finally(() => {
    globalThis.fetch = priorFetch;
    (globalThis as { __DEV__?: boolean }).__DEV__ = priorDev;
    for (const [filename, prior] of priorModules) {
      if (prior) require.cache[filename] = prior;
      else delete require.cache[filename];
    }
  })
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
