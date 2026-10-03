// Dev-only: render the export PDFs' HTML to disk so a human can LOOK at them.
//
// `npx tsx lib/__dev__/pdf-preview.ts [outDir]`
//
// The PDF builders run inside expo-print's WebView on a device, which makes
// "does it actually look right" untestable by assertion — the failure modes
// that matter here are visual (a header band that prints white, a number that
// flips to the wrong side of an RTL cell, a table that loses its header on
// page two). This writes the exact HTML those builders hand to expo-print, so
// it can be opened in any browser or piped through headless Chrome/Edge.
//
// Fixtures are deliberately Dari-first with Afghan month names and real shop
// vocabulary, because that is the document the complaint was about.

import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

function withModuleStubs<T>(stubs: Record<string, unknown>, load: () => T): T {
  const saved = new Map<string, NodeJS.Module | undefined>();
  for (const [name, exports] of Object.entries(stubs)) {
    const filename = require.resolve(name);
    saved.set(filename, require.cache[filename]);
    require.cache[filename] = { id: filename, filename, loaded: true, exports } as NodeJS.Module;
  }
  try {
    return load();
  } finally {
    for (const [filename, previous] of saved) {
      if (previous) require.cache[filename] = previous;
      else delete require.cache[filename];
    }
  }
}

const captured: { name: string; html: string }[] = [];

class PrintFile {
  uri: string;
  constructor(uri: string) {
    this.uri = uri;
  }
  base64(): string {
    // No font bytes in the preview: the browser substitutes a system Arabic
    // face, which is enough to judge layout. Embedding ~1MB of base64 twice
    // would make the output unopenable in an editor.
    return "";
  }
  async move(target: PrintFile) {
    this.uri = target.uri;
  }
}

const stubs = {
  "expo-localization": { getLocales: () => [{ languageCode: "fa" }] },
  "../db": { getAppMeta: async () => null },
  "../calendar": { getEffectiveCalendar: () => "jalali" },
  "../currency": { getCurrentCurrencySymbol: () => "؋" },
  "expo-file-system": { File: PrintFile },
  "expo-asset": {
    Asset: { fromModule: () => ({ downloadAsync: async () => {}, localUri: "preview-font" }) },
  },
  "@expo-google-fonts/vazirmatn": { Vazirmatn_400Regular: 1, Vazirmatn_700Bold: 2 },
  "expo-print": {
    printToFileAsync: async ({ html }: { html: string }) => {
      captured.push({ name: `doc-${captured.length}`, html });
      return { uri: "preview-printed" };
    },
  },
  // Only what pdf.ts actually imports at RUNTIME. Deliberately NOT spreading
  // the real module: requiring it would execute data.ts, which imports
  // expo-sharing, which imports react-native — Flow syntax that esbuild
  // cannot transform. The other names pdf.ts takes from here are types, and
  // types are erased.
  "../export/data": {
    exportFileTarget: (name: string) => new PrintFile(name),
  },
};

const pdf = withModuleStubs(
  stubs,
  () => require("../export/pdf") as typeof import("../export/pdf"),
);
// Pure (money helpers only): the same contribution rule data.ts applies.
const { balanceContribution } =
  require("../export/shared-record") as typeof import("../export/shared-record");

type Row = { note: string; type: "debt" | "payment"; amount: number; day: number };

// A real-shaped grocery tab: many small "gave" lines, occasional payments,
// one settlement, a long note to exercise wrapping, and a decimal amount.
const ROWS: Row[] = [
  { note: "شیر ماست نوشابه", type: "debt", amount: 220, day: 1 },
  { note: "شیر", type: "debt", amount: 100, day: 1 },
  { note: "بیسکویت", type: "debt", amount: 30, day: 1 },
  { note: "تخم", type: "debt", amount: 300, day: 1 },
  { note: "ماست", type: "debt", amount: 50, day: 1 },
  { note: "رسید", type: "payment", amount: 500, day: 1 },
  { note: "شیر", type: "debt", amount: 100, day: 2 },
  { note: "تصفیه شد", type: "payment", amount: 300, day: 3 },
  { note: "شیر", type: "debt", amount: 140, day: 3 },
  { note: "بیسکویت جوس", type: "debt", amount: 90, day: 3 },
  {
    note: "پاپور جوس بیسکویت کاغذ نشایی و چند قلم دیگر که یادداشت طولانی دارد",
    type: "debt",
    amount: 70,
    day: 3,
  },
  { note: "کیکو شفا", type: "debt", amount: 70.5, day: 5 },
  { note: "شفا ماست", type: "debt", amount: 110, day: 5 },
  { note: "شیر", type: "debt", amount: 160, day: 5 },
  { note: "پنیر", type: "debt", amount: 75, day: 5 },
  { note: "رسید", type: "payment", amount: 500, day: 5 },
  { note: "انرژی", type: "debt", amount: 70, day: 5 },
  { note: "تخم", type: "debt", amount: 300, day: 6 },
  { note: "سنبچ", type: "debt", amount: 90, day: 6 },
  { note: "شیر", type: "debt", amount: 150, day: 7 },
  { note: "رسید", type: "payment", amount: 800, day: 7 },
  { note: "کاغذ نشایی", type: "debt", amount: 100, day: 7 },
  { note: "", type: "debt", amount: 70, day: 7 },
  { note: "کیک", type: "debt", amount: 20, day: 8 },
  { note: "شیر", type: "debt", amount: 100, day: 8 },
];

const DAY = 86_400_000;
const BASE = Date.UTC(2026, 8, 1); // fixed: no Date.now(), so output is stable

function buildStatement() {
  let balance = 0;
  const rows: unknown[] = [];
  ROWS.forEach((r, i) => {
    const signed = r.type === "debt" ? r.amount : -r.amount;
    balance = Math.round((balance + signed) * 100) / 100;
    rows.push({
      kind: "entry",
      entry: {
        id: `e${i}`,
        relationship_id: "rel-1",
        type: r.type,
        amount_afn: r.amount,
        note: r.note || null,
        created_at: BASE + r.day * DAY,
      },
      balanceAfter: balance,
    });
    // Rule off the book after the third day's settling payment.
    if (r.note === "تصفیه شد") {
      rows.push({ kind: "settled", ms: BASE + r.day * DAY + 1, balanceAfter: balance });
    }
  });
  return {
    person: { id: "p1", name: "حاجی محمد اخلاص", phone: "+93793134779", balance },
    self: { user_id: "u1", name: "عبدالله آشوری", phone: "+93700000000", shop_name: "دوکان اخلاص" },
    rows,
    balance,
    currencyCode: "AFN",
    currencySymbol: "؋",
    locale: "fa",
    calendar: "jalali",
    generatedAtMs: BASE + 9 * DAY,
  };
}

function buildReport() {
  const people = [
    {
      id: "p1",
      name: "حاجی محمد اخلاص",
      phone: "+93793134779",
      entryCount: 25,
      balance: 520,
      lastEntryAt: BASE + 8 * DAY,
    },
    {
      id: "p2",
      name: "قاری حیات",
      phone: "+93796817181",
      entryCount: 14,
      balance: 5380,
      lastEntryAt: BASE - 95 * DAY,
    },
    {
      id: "p3",
      name: "اعظم",
      phone: null,
      entryCount: 6,
      balance: -1200,
      lastEntryAt: BASE - 30 * DAY,
    },
    {
      id: "p4",
      name: "خالد مکرونی",
      phone: "+93700111222",
      entryCount: 3,
      balance: 0,
      lastEntryAt: BASE - 200 * DAY,
    },
  ];
  return {
    vaultName: "دوکان اخلاص",
    self: { user_id: "u1", name: "عبدالله آشوری", phone: "+93700000000", shop_name: "دوکان اخلاص" },
    people,
    journal: new Array(48).fill(null),
    totals: { collect: 5900, pay: 1200, net: 4700 },
    currencyCode: "AFN",
    currencySymbol: "؋",
    locale: "fa",
    calendar: "jalali",
    generatedAtMs: BASE + 9 * DAY,
  };
}

async function main() {
  const outDir = resolve(process.argv[2] ?? join(process.cwd(), ".pdf-preview"));
  mkdirSync(outDir, { recursive: true });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await pdf.renderPersonStatementPdf(buildStatement() as any, "statement.pdf");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await pdf.renderVaultReportPdf(buildReport() as any, "report.pdf");

  // Recorded names and reviewer details are synthetic. Exercise long IDs,
  // absolute UTC timestamps, every outcome, both reviewer sides, member roles,
  // and an earlier period, built as data.ts builds them: `rows` with clearance
  // markers interleaved by server sequence, `entries` derived from them. The
  // clearers' names are a Dari-script name and an EMPTY one (Apple can withhold
  // it), in the current account and in the earlier period, so the rule-off
  // line shows up in both languages with both kinds of name.
  const ME = { name: "عبدالله احمدزی", id: "11111111-2222-3333-4444-555555555555" };
  const THEM = { name: "احمد محمدی", id: "66666666-7777-8888-9999-000000000000" };
  type Outcome = "accepted" | "pending" | "disputed" | "cancelled";
  const sharedEntry = (
    tabId: string,
    seq: number,
    day: number,
    type: "debt" | "payment",
    amount: number,
    note: string,
    outcome: Outcome,
    byThem = false,
    closedReason: "account_deleted" | null = null,
  ) => {
    // This statement's owner is party a, the customer party b. Only the side
    // that did NOT write a tally reviews it.
    const author = byThem ? THEM : ME;
    const reviewer = byThem ? ME : THEM;
    const reviewed = outcome === "accepted" || outcome === "disputed";
    const at = BASE + day * DAY;
    const id = `${tabId.slice(0, 6)}-${seq}-baaa-4ccc-8ddd-eeeeeeeeeeee`;
    return {
      id,
      relationship_id: "rel-1",
      type,
      amount_afn: amount,
      note,
      created_at: at,
      tab: {
        by: byThem ? ("them" as const) : ("me" as const),
        created_by: byThem ? ("b" as const) : ("a" as const),
        status: outcome === "cancelled" ? ("pending" as const) : outcome,
        kind: "entry" as const,
        voided: outcome === "cancelled",
        local_pending: false,
        other_label: "احمد",
        author_name: author.name,
        author_account_id: author.id,
        author_member_role: byThem ? "account" : "editor",
        recorded_at: at + 15_000,
        status_at: reviewed ? at + 30_000 : null,
        reviewer_name: reviewed ? reviewer.name : "",
        reviewer_account_id: reviewed ? reviewer.id : null,
        reviewer_party: reviewed ? (byThem ? ("a" as const) : ("b" as const)) : null,
        reviewer_member_role: reviewed ? (byThem ? "owner" : "account") : null,
        review_semantics_version: reviewed ? "tally-review-v1" : null,
        dispute_reason: outcome === "disputed" ? "مبلغ اشتباه است" : null,
        cancelled_by_name: outcome === "cancelled" ? author.name : "",
        cancelled_by_account_id: outcome === "cancelled" ? author.id : null,
        cancelled_at: outcome === "cancelled" ? at + 40_000 : null,
        cancellation_entry_id: outcome === "cancelled" ? `cancel-${id}` : null,
        tab_id: tabId,
        seq,
        rev: seq + 1,
        closed_reason: closedReason,
      },
    };
  };
  type SharedEntry = ReturnType<typeof sharedEntry>;
  // Clearances land at 21:45 UTC: the next morning in Kabul, which is exactly
  // when a raw UTC stamp next to the date used to tell two different days.
  const clearance = (tabId: string, throughSeq: number, day: number, actorName: string) => ({
    id: `clear-${tabId.slice(0, 6)}-${throughSeq}`,
    rev: throughSeq + 10,
    through_seq: throughSeq,
    settled_at_ms: BASE + day * DAY + 21 * 3_600_000 + 45 * 60_000,
    created_by: "a" as const,
    actor_account_id: actorName ? ME.id : null,
    actor_name: actorName,
    actor_member_role: "owner",
    semantics_version: "tally-zero-settlement-v1",
  });
  const chapterRows = (
    tabId: string,
    entries: SharedEntry[],
    clearances: ReturnType<typeof clearance>[],
  ) => {
    const rows: unknown[] = [];
    let running = 0;
    let next = 0;
    const append = (entry: SharedEntry) => {
      running = Math.round((running + balanceContribution(entry)) * 100) / 100;
      rows.push({ kind: "entry", entry, balanceAfter: running });
    };
    for (const settlement of clearances) {
      while (next < entries.length && entries[next].tab.seq <= settlement.through_seq) {
        append(entries[next++]);
      }
      rows.push({
        kind: "settled",
        ms: settlement.settled_at_ms,
        balanceAfter: running,
        shared: { tabId, settlement },
      });
    }
    while (next < entries.length) append(entries[next++]);
    return { rows, balance: running };
  };

  const CURRENT = "shared-11111111-2222-3333-4444-555555555555";
  const deleted = "account_deleted" as const;
  const current = chapterRows(
    CURRENT,
    [
      sharedEntry(
        CURRENT,
        1,
        0,
        "debt",
        300,
        "آرد و روغن — flour and oil",
        "accepted",
        false,
        deleted,
      ),
      sharedEntry(CURRENT, 2, 1, "payment", 300, "رسید نقد — cash", "accepted", true, deleted),
      sharedEntry(CURRENT, 3, 2, "debt", 80, "چای — tea", "accepted", false, deleted),
      sharedEntry(CURRENT, 4, 2, "payment", 80, "رسید — paid", "accepted", true, deleted),
      sharedEntry(
        CURRENT,
        5,
        3,
        "debt",
        100,
        "سابقهٔ مشترک — shared record",
        "accepted",
        false,
        deleted,
      ),
      sharedEntry(
        CURRENT,
        6,
        4,
        "debt",
        125,
        "سابقهٔ مشترک — shared record",
        "pending",
        false,
        deleted,
      ),
      sharedEntry(
        CURRENT,
        7,
        5,
        "debt",
        150,
        "مبلغ اشتباه است — disputed amount",
        "disputed",
        false,
        deleted,
      ),
      sharedEntry(
        CURRENT,
        8,
        6,
        "debt",
        175,
        "سابقهٔ مشترک — shared record",
        "cancelled",
        false,
        deleted,
      ),
    ],
    [clearance(CURRENT, 2, 1, ME.name), clearance(CURRENT, 4, 2, "")],
  );
  const OLD = "old-period";
  const earlier = chapterRows(
    OLD,
    [
      sharedEntry(OLD, 1, -20, "debt", 50, "قرض — loan", "accepted"),
      sharedEntry(OLD, 2, -19, "payment", 50, "رسید — repaid", "accepted", true),
      sharedEntry(OLD, 3, -10, "debt", 20, "کرایه — fare", "accepted"),
      sharedEntry(OLD, 4, -9, "debt", 70, "مبلغ اشتباه — wrong amount", "disputed"),
      sharedEntry(OLD, 5, -8, "payment", 20, "رسید — repaid", "accepted", true),
    ],
    [clearance(OLD, 2, -19, ""), clearance(OLD, 5, -8, ME.name)],
  );
  const shared = {
    ...buildStatement(),
    balance: current.balance,
    rows: current.rows,
    archivedSharedPeriods: [
      {
        link: {
          tab_id: OLD,
          currency: "USD",
          linked_at: BASE - 21 * DAY,
          my_label: "عبدالله",
          other_label: "احمد",
          closed_at: BASE - 7 * DAY,
        },
        rows: earlier.rows,
        entries: earlier.rows.flatMap((row) =>
          (row as { kind: string }).kind === "entry" ? [(row as { entry: unknown }).entry] : [],
        ),
      },
    ],
  };
  await pdf.renderPersonStatementPdf(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    { ...shared, locale: "en", calendar: "gregorian" } as any,
    "shared-en.pdf",
  );
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await pdf.renderPersonStatementPdf(shared as any, "shared-fa.pdf");

  const names = ["statement", "report", "shared-en", "shared-fa"];
  captured.forEach((doc, i) => {
    const file = join(outDir, `${names[i] ?? doc.name}.html`);
    writeFileSync(file, doc.html, "utf8");
    console.log(file);
  });
}

void main();
