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
stub("../api", { getBackendUrl: async () => "https://example.invalid" });
let selectedCalendar = "jalali";
let qamariOffset = 0;
stub("../calendar", {
  getEffectiveCalendar: () => selectedCalendar,
  getQamariOffset: () => qamariOffset,
});
stub("../currency", { getCurrentCurrencySymbol: () => "AFN" });
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
  tally("voided", "Cancelled", { ...meta, voided: true }),
  tally("rejected", "Rejected", { ...meta, status: "disputed" }),
];

async function main() {
  const { shareKaataViaWhatsApp } = require("../share") as typeof import("../share");
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
    entries.slice(0, 2).map((e) => e.note),
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
  console.log(
    "PASS: WhatsApp preparation/opening progress, complete statement, plain-text fallback, recipient routing and best-effort counters",
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
