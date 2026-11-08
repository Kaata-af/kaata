// PDF builders — expo-print renders our HTML in a WebView, so the document is
// styled with plain CSS using the app's design tokens. The print WebView has
// no access to the app's registered fonts; Vazirmatn is embedded as a base64
// @font-face read from the same @expo-google-fonts packages the UI loads. If
// that read ever fails we still print — system WebView fonts shape Arabic
// script correctly, just off-brand.
//
// Public exports use a paper statement with a clear closing balance, explicit
// direction columns, opening balance, and a separate section for optional notes.
// Technical receipts and earlier books are only appended in detailed mode.
// Raw legacy snapshots (without exportOptions) retain their archival rendering.
// Fonts are embedded for offline Arabic-script shaping; table headers repeat
// across pages, and each numeric value is isolated from surrounding RTL prose.
import { Asset } from "expo-asset";
import { File } from "expo-file-system";
import * as Print from "expo-print";
import { Platform } from "react-native";
import { Vazirmatn_400Regular, Vazirmatn_700Bold } from "@expo-google-fonts/vazirmatn";
import { colors } from "../colors";
import { IS_EXPO_GO } from "../expo-go";
import { formatAmount } from "../format";
import { tExtraIn } from "../mobile-copy";
import { tIn, type LocaleCode } from "../i18n";
import { clearanceNote, noteFor } from "./note";
import { faDigits, formatSettlementDate } from "../jalali";
import { sumAmounts } from "../money";
import {
  exportFileTarget,
  type PersonStatement,
  type StatementRow,
  type VaultReport,
} from "./data";
import { EVIDENCE_KEYS, evidenceCells, evidenceTime, recordStatus } from "./evidence";
import {
  balanceContribution,
  countsTowardBalance,
  isExcludedRecord,
  recordTotals,
} from "./shared-record";
import type { Entry } from "../types";
import type { TabEntryMeta } from "../tabs/types";
import { pdfCopy } from "./pdf-copy";
import type { ExportNote } from "./data";

let cachedFontCss: string | null = null;

async function fontBase64(mod: number): Promise<string> {
  const asset = Asset.fromModule(mod);
  await asset.downloadAsync();
  if (!asset.localUri) throw new Error("font asset has no local uri");
  return new File(asset.localUri).base64();
}

async function vazirmatnCss(): Promise<string> {
  if (cachedFontCss !== null) return cachedFontCss;
  try {
    const [regular, bold] = await Promise.all([
      fontBase64(Vazirmatn_400Regular),
      fontBase64(Vazirmatn_700Bold),
    ]);
    cachedFontCss =
      `@font-face{font-family:'Vazirmatn';font-weight:400;src:url(data:font/ttf;base64,${regular}) format('truetype')}` +
      `@font-face{font-family:'Vazirmatn';font-weight:700;src:url(data:font/ttf;base64,${bold}) format('truetype')}`;
    return cachedFontCss;
  } catch {
    // Deliberately NOT cached — a transient asset hiccup (cache purge, full
    // disk) shouldn't downgrade every later PDF this session; next export
    // retries the read.
    return "";
  }
}

function esc(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
}

/** Unsigned amount with separators; sign restored explicitly so the bidi
 *  isolation (`.num` is direction:ltr) keeps the minus on the correct side
 *  in RTL documents. */
function fmtSigned(n: number): string {
  return n < 0 ? `-${formatAmount(n)}` : formatAmount(n);
}

/** Counts that sit inside PROSE take the locale's digits, so "۲۵ ثبت" does
 * not read as a Persian sentence with a Latin number dropped into it. Money
 * and row indices stay Latin, matching the app and the reference document. */
function countIn(locale: LocaleCode, n: number): string {
  return locale !== "en" ? faDigits(n) : String(n);
}

/** A number cell that survives RTL: LTR-isolated, tabular, never wrapped. */
function num(inner: string): string {
  return `<span class="num">${inner}</span>`;
}

/** Prose that may be in either script, such as a person's name or a date, as
 *  its own isolate: it takes its direction from its own letters and can never
 *  reorder the words around it. */
function isolated(text: string): string {
  return `<span style="unicode-bidi:isolate" dir="auto">${esc(text)}</span>`;
}

/** Names retain their own script direction inside a translated sentence. */
function pdfSentence(
  locale: LocaleCode,
  key: Parameters<typeof pdfCopy>[1],
  values: Record<string, string>,
): string {
  return esc(pdfCopy(locale, key)).replace(/\{(\w+)\}/g, (placeholder, name: string) =>
    values[name] == null ? placeholder : isolated(values[name]),
  );
}

/** A machine identifier or UTC stamp: printed as recorded, LTR-isolated, and
 *  free to wrap (a UUID would otherwise overrun its half of the grid). */
function code(text: string): string {
  return `<span class="code" dir="ltr">${esc(text)}</span>`;
}

function htmlShell(opts: {
  locale: LocaleCode;
  fontCss: string;
  title: string;
  body: string;
}): string {
  const rtl = opts.locale !== "en";
  return `<!DOCTYPE html>
<html dir="${rtl ? "rtl" : "ltr"}" lang="${opts.locale}">
<head>
<meta charset="utf-8">
<title>${esc(opts.title)}</title>
<style>
${opts.fontCss}
/* Full bleed: the masthead runs to the paper edge like a letterhead, so the
   page itself carries no margin and each block owns its own padding. */
@page{size:A4;margin:14mm 12mm 16mm;@bottom-right{content:counter(page);font-size:9px;color:#667085}}
*{margin:0;padding:0;box-sizing:border-box}
html,body{-webkit-print-color-adjust:exact;print-color-adjust:exact}
body{font-family:'Vazirmatn','Segoe UI',-apple-system,sans-serif;color:${colors.textEmphasis};font-size:12px;line-height:1.45}

/* ---- masthead ---------------------------------------------------- */
.masthead{background:${colors.brandPrimary};color:${colors.textInverted};padding:26px 36px 22px;text-align:center}
.brand{font-size:20px;font-weight:700;letter-spacing:-.01em}
.docTitle{font-size:12px;font-weight:400;color:${colors.bgWarm};margin-top:5px}
.mastMeta{font-size:10px;color:${colors.textInverted};margin-top:9px}
/* Each item is isolated and the separator is its own element. Without this
   the bidi algorithm runs a date and the count that follows it together —
   "۱۴۰۵" + "·" + "۴" renders as "۴۰۱۴۰۵", which looks like one nonsense
   number. Isolation is the whole fix; the dot alone is not a boundary. */
.mastMeta > span{unicode-bidi:isolate}
.mastMeta .sep{unicode-bidi:isolate;margin:0 7px;color:${colors.brandAccent}}

/* ---- page body --------------------------------------------------- */
.content{padding:22px 36px 0}
.section{margin-top:20px}
/* Accent bar on the leading edge — logical property so it mirrors in RTL. */
.sectionTitle{font-size:13px;font-weight:700;border-inline-start:3px solid ${colors.brandAccent};padding-inline-start:9px;margin-bottom:10px}

/* ---- party card -------------------------------------------------- */
.party{border:1px solid ${colors.borderDefault};border-radius:10px;padding:12px 14px;background:${colors.bgMuted}}
.partyRow{display:flex;gap:8px;align-items:baseline}
.partyRow + .partyRow{margin-top:4px}
.partyLabel{font-size:10px;color:${colors.textSubtle};min-width:74px}
.partyValue{font-size:14px;font-weight:700}
.partyValue.sm{font-size:12px;font-weight:400}

/* ---- summary cards ----------------------------------------------- */
.cards{display:flex;gap:10px}
.card{flex:1;border:1px solid ${colors.borderDefault};border-radius:10px;padding:11px 12px;text-align:center}
.card.collect{background:${colors.collectBg};border-color:${colors.collectBg}}
.card.pay{background:${colors.payBg};border-color:${colors.payBg}}
.card.flat{background:${colors.bgMuted}}
.cardLabel{font-size:10px;color:${colors.textSubtle}}
.cardValue{font-size:16px;font-weight:700;margin-top:4px}
.cardNote{font-size:9px;color:${colors.textSubtle};margin-top:2px}

/* ---- table ------------------------------------------------------- */
table{width:100%;border-collapse:collapse}
thead{display:table-header-group}
tr{page-break-inside:avoid}
th{background:${colors.brandPrimary};color:${colors.textInverted};font-size:10px;font-weight:700;text-align:start;padding:8px 9px;white-space:nowrap}
td{font-size:11px;padding:7px 9px;border-bottom:1px solid ${colors.borderSubtle};vertical-align:top}
tbody tr td{background:${colors.bgDefault}}
th.n,td.n{text-align:end}
th.c,td.c{text-align:center}
td.idx{color:${colors.textMuted};font-size:10px}
td.amount{font-weight:700;white-space:nowrap}
td.gave{color:${colors.payStrong}}
td.received{color:${colors.collectStrong}}
.type{font-size:10px;font-weight:700;white-space:nowrap}
.type.gave{color:${colors.payStrong}}
.type.received{color:${colors.collectStrong}}
td.note{color:${colors.textDefault}}
.recordNotes{font-size:10px;color:${colors.textSubtle};margin-top:10px;line-height:1.6}
/* A dot-separated line of labels (an earlier period's parties and currency):
   the same per-item isolation as .mastMeta, for the same reason. */
.metaLine > span{unicode-bidi:isolate}
.metaLine .sep{margin:0 6px;color:${colors.textMuted}}
.evidenceGrid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:3px 12px;font-size:9px;overflow-wrap:anywhere}
.evidenceGrid span{unicode-bidi:isolate}
.code{direction:ltr;unicode-bidi:isolate}
.evidenceLabel{font-weight:700}
tr.evidence td{background:${colors.bgMuted};padding:8px 10px 12px}
tbody.receipt{break-inside:avoid;page-break-inside:avoid}
.excluded{text-decoration:line-through;color:${colors.textSubtle}}
/* An excluded amount cell also carries its direction class; without this the
   more specific td.gave/td.received colour wins over the grey. */
td.amount.excluded{color:${colors.textSubtle}}
.recordStatus{display:block;font-size:9px;margin-top:3px;white-space:normal}
td.muted{color:${colors.textSubtle}}
/* Running balance: same weight as the amount so the two numeric columns read
   as a pair, but no hue — the colour in the amount column means direction,
   and a second meaning here would fight it. */
td.bal{font-weight:700;color:${colors.textEmphasis};white-space:nowrap}
/* Settlement line — the paper-khata rule-off. Kept loud on purpose: it is a
   real event in the account's history, not a row of data. */
tbody tr.settled td{text-align:center;font-size:10px;font-weight:700;color:${colors.textSubtle};background:${colors.bgSubtle};border-top:2px solid ${colors.borderEmphasis};border-bottom:2px solid ${colors.borderEmphasis}}
/* A shared clearance's exact server time, under its sentence as evidence. */
.settledMeta{display:block;font-size:9px;font-weight:400;margin-top:2px}

.num{direction:ltr;unicode-bidi:isolate;font-variant-numeric:tabular-nums;white-space:nowrap}
.empty{font-size:12px;color:${colors.textSubtle};padding:18px 0}
footer{margin-top:26px;padding:14px 36px 26px;text-align:center;font-size:9px;color:${colors.textMuted};border-top:1px solid ${colors.borderSubtle}}
/* Tracking severs Arabic-script joining (same fix as the web app's fa
   handling) — zero it wherever the labels are Dari. */
[dir=rtl] .brand,[dir=rtl] th,[dir=rtl] .cardLabel{letter-spacing:0}
/* Paper-first defaults also apply to the optional detailed record. */
body{font-size:12px;color:#20272b}
.masthead{background:white;color:#20272b;padding:0 0 14px;text-align:start;border-bottom:2px solid #31594f}
.docTitle,.mastMeta{color:#58635e}
.mastMeta .sep{color:#8b9690}
.content{padding:0}
.section{margin-top:18px}
.sectionTitle{border:0;padding:0;font-size:13px}
.party{background:white;border:0;padding:14px 0 0}
.card{border-radius:4px;background:white!important;border:1px solid #d9dfdb!important}
th{color:#25372f;background:#edf1ee;border-top:1px solid #cdd6cf;border-bottom:1px solid #cdd6cf;white-space:normal}
td{overflow-wrap:anywhere}
footer{padding:10px 0 0;margin-top:22px;color:#69736c}
.summaryTop{display:flex;align-items:flex-start;justify-content:space-between;gap:22px;margin:18px 0}
.customerName{font-size:20px;font-weight:700;overflow-wrap:anywhere}
.customerInfo{min-width:0;flex:1}
.subtle{font-size:10px;color:#59665e;line-height:1.6}
.closing{text-align:end;max-width:50%;min-width:0}
.closingValue{font-size:24px;font-weight:700;margin:3px 0;overflow-wrap:anywhere}
.closingValue .num{white-space:normal}
.balanceDirection{font-size:11px;overflow-wrap:anywhere}
.facts{display:flex;gap:16px;justify-content:space-between;border-block:1px solid #d9dfdb;padding:10px 0;margin:12px 0}
.fact{flex:1;min-width:0}
.factValue{display:block;font-size:13px;font-weight:700;margin-top:2px}
.factValue .num{white-space:normal}
.ledger{table-layout:fixed;font-size:11px;margin-top:12px}
.ledger th,.ledger td{padding:8px 6px}
.ledger td{font-size:12px}
.ledger .date{font-size:11px;color:#59665e}
.ledger .description{font-size:12px;white-space:pre-wrap;overflow-wrap:anywhere}
.ledger td.n{font-variant-numeric:tabular-nums}
.ledger td.n .num{white-space:normal;overflow-wrap:anywhere}
.ledger .balanceRow td{background:#f3f5f2;font-weight:700;border-top:1px solid #b4c3b9}
.ledger .identity th{font-size:9px;font-weight:400;color:#59665e;background:white;border:0;padding:0 0 7px}
.ledger .settled td{background:#f3f5f2;border-block:1px solid #cdd6cf;font-weight:400;text-align:start}
.ledger .excluded .num{text-decoration:line-through;color:#69736c}
.status{display:block;font-size:9px;color:#75613b;margin-top:3px}
.internalNote{border-inline-start:3px solid #cdbb8d;padding:8px 10px;background:#faf7ed;break-inside:avoid;page-break-inside:avoid;margin-top:7px}
.noteBody{white-space:pre-wrap;overflow-wrap:anywhere;font-size:11px}
.noteMeta{font-size:9px;color:#70674f;margin-top:4px}
.noteNumber{font-size:11px;color:#75613b;margin-top:4px}
.reportName{font-weight:700}
.reportPhone{display:block;font-size:9px;color:#69736c;margin-top:2px}
.reportDescription{font-size:11px;color:#59665e;white-space:pre-wrap;overflow-wrap:anywhere;margin-top:4px}
.summaryTop,.facts,.cards,.party{break-inside:avoid;page-break-inside:avoid}
h2{break-after:avoid;page-break-after:avoid}
@media print{thead{display:table-header-group}tfoot{display:table-row-group}}
</style>
</head>
<body>
${opts.body}
<footer dir="auto">${esc(tExtraIn(opts.locale, "pdf.poweredBy"))}</footer>
</body>
</html>`;
}

/** The masthead every export shares: who produced it, what it is, when. */
function masthead(opts: { brand: string; docTitle: string; meta: string[] }): string {
  return `<header class="masthead">
${opts.brand ? `<div class="brand" dir="auto">${esc(opts.brand)}</div>` : ""}
<div class="docTitle" dir="auto">${esc(opts.docTitle)}</div>
${opts.meta.length ? `<div class="mastMeta">${opts.meta.map((m) => `<span>${m}</span>`).join(`<span class="sep">·</span>`)}</div>` : ""}
</header>`;
}

function card(opts: {
  tone: "collect" | "pay" | "flat";
  label: string;
  value: string;
  color?: string;
  note?: string;
}): string {
  return `<div class="card ${opts.tone}">
<div class="cardLabel" dir="auto">${esc(opts.label)}</div>
<div class="cardValue num"${opts.color ? ` style="color:${opts.color}"` : ""}>${opts.value}</div>
${opts.note ? `<div class="cardNote" dir="auto">${esc(opts.note)}</div>` : ""}
</div>`;
}

async function printToTarget(html: string, fileName: string): Promise<File> {
  // WebKit uses the native printable rectangle; Android uses CSS @page.
  // Keeping the paper size and physical margins explicit avoids a statement
  // that is readable in previews but touches the page edge on iOS.
  const options = {
    html: Platform.OS === "ios" ? html.replace("margin:14mm 12mm 16mm", "margin:0") : html,
    width: 595.28,
    height: 841.89,
    ...(Platform.OS === "ios" ? { margins: { top: 40, right: 34, bottom: 45, left: 34 } } : {}),
  };
  if (IS_EXPO_GO) {
    // Expo Go prints outside the experience's scoped FileSystem directory.
    // Read the bytes through Print, then write only within our own cache.
    const { base64 } = await Print.printToFileAsync({ ...options, base64: true });
    if (!base64) throw new Error("The printed PDF is unavailable. Please try again.");
    const target = exportFileTarget(fileName);
    target.writeSync(base64, { encoding: "base64" });
    return target;
  }
  const { uri } = await Print.printToFileAsync(options);
  const printed = new File(uri);
  const target = exportFileTarget(fileName);
  // AWAIT is load-bearing. Expo SDK 56 made move() asynchronous, and move()
  // rewrites `printed`'s own uri to the destination — so returning without
  // awaiting hands the caller a File pointing at a path the move may not have
  // reached yet, and the share sheet opens on a missing file. An unawaited
  // promise here is not a type error, so nothing but this comment prevents it
  // being "tidied" back.
  await printed.move(target);
  return printed;
}

type EvidenceKey = (typeof EVIDENCE_KEYS)[number];

// Evidence values that are machine identifiers, UTC stamps or record numbers.
// The CSV keeps every value as recorded; on paper these print as LTR codes so
// a Dari line can never reorder them. Everything else is prose (dir=auto).
const CODE_KEYS: ReadonlySet<EvidenceKey> = new Set<EvidenceKey>([
  "export.record.tabId",
  "export.record.authorId",
  "export.record.recordedAt",
  "export.record.reviewerId",
  "export.record.reviewedAt",
  "export.record.reviewVersion",
  "export.record.cancelledById",
  "export.record.cancelledAt",
  "export.record.cancellationId",
  "export.record.seq",
  "export.record.rev",
]);

// The member role the server snapshotted with an action, in the document's
// language. "account" is the party's own account acting directly rather than
// as a member of its kaata. A role this table does not know prints as its
// code rather than as a guess.
const ROLE_KEYS = {
  owner: "vaultSettings.role.owner",
  manager: "vaultSettings.role.manager",
  editor: "vaultSettings.role.editor",
  clerk: "vaultSettings.role.clerk",
  viewer: "vaultSettings.role.viewer",
  account: "export.record.role.account",
} as const;

/** The reviewer's party relative to the exporter: the wire's a/b letters mean
 *  nothing on paper. The exporter's own letter follows from the row's author
 *  (`by: "me"` means created_by is mine). Null when either side is unknown. */
function reviewerSide(party: string, tab: TabEntryMeta, locale: LocaleCode): string | null {
  if ((party !== "a" && party !== "b") || !tab.created_by) return null;
  const mine = tab.by === "me" ? tab.created_by : tab.created_by === "a" ? "b" : "a";
  return tIn(locale, party === mine ? "export.record.side.this" : "export.record.side.other");
}

function evidenceValueHtml(
  key: EvidenceKey,
  value: string,
  tab: TabEntryMeta,
  locale: LocaleCode,
): string {
  let shown: string | null = value;
  if (key === "export.record.authorRole" || key === "export.record.reviewerRole") {
    const roleKey = ROLE_KEYS[value as keyof typeof ROLE_KEYS];
    shown = roleKey ? tIn(locale, roleKey) : null;
  } else if (key === "export.record.reviewerParty") {
    shown = reviewerSide(value, tab, locale);
  } else if (CODE_KEYS.has(key)) {
    shown = null;
  }
  return shown === null ? code(value) : `<span dir="auto">${esc(shown)}</span>`;
}

function recordDetailHtml(entry: Pick<Entry, "id" | "tab">, locale: LocaleCode): string {
  if (!entry.tab) return "";
  const tab = entry.tab;
  const values = evidenceCells(tab, locale);
  // Names on historical records may be absent; do not substitute the current
  // party owner. That would claim a review by somebody who may never have acted.
  if (!values[3]) values[3] = tIn(locale, "export.record.unknown");
  if (
    !tab.local_pending &&
    (tab.status === "accepted" || tab.status === "disputed") &&
    !values[7]
  ) {
    values[7] = tIn(locale, "export.record.unknown");
  }
  const details = EVIDENCE_KEYS.flatMap((key, i) =>
    values[i]
      ? [
          `<div><span class="evidenceLabel" dir="auto">${esc(tIn(locale, key))}: </span>${evidenceValueHtml(key, values[i], tab, locale)}</div>`,
        ]
      : [],
  );
  details.push(
    `<div><span class="evidenceLabel" dir="auto">${esc(tIn(locale, "export.col.id"))}: </span>${code(entry.id)}</div>`,
  );
  return `<tr class="evidence"><td colspan="6"><div class="evidenceGrid">${details.join("")}</div></td></tr>`;
}

function receiptsHtml(
  entries: readonly Pick<Entry, "id" | "tab" | "created_at" | "note" | "amount_afn">[],
  doc: Pick<PersonStatement, "locale" | "calendar" | "currencyCode">,
): string {
  return `<table>${entries.map((entry) => `<tbody class="receipt"><tr><td colspan="6" dir="auto"><strong>${esc(formatSettlementDate(entry.created_at, doc.locale, doc.calendar))}</strong> · ${esc(noteFor(entry.note, entry.tab?.kind, doc.locale) || "—")} · ${num(`${formatAmount(entry.amount_afn)} ${esc(doc.currencyCode)}`)}</td></tr>${recordDetailHtml(entry, doc.locale)}</tbody>`).join("")}</table>`;
}

function settlementRowHtml(
  row: Extract<StatementRow, { kind: "settled" }>,
  st: Pick<PersonStatement, "locale" | "calendar">,
): string {
  const { locale, calendar } = st;
  const date = formatSettlementDate(row.ms, locale, calendar);
  // A shared clearance is a sentence with two values from outside the
  // document's script: the clearer's Google/Apple display name (often Dari,
  // sometimes empty) and the date. Each value is its own isolate; one plain
  // run of text let the bidi algorithm interleave a Dari name with the date.
  // The server's exact UTC time follows on its own LTR line, as evidence.
  const label = row.shared
    ? clearanceNote(row.shared.settlement.actor_name, date, locale, {
        text: esc,
        value: isolated,
      }) +
      `<span class="settledMeta" dir="auto">${esc(tIn(locale, "export.record.recordedAt"))}: ${num(esc(evidenceTime(row.ms)))}</span>`
    : esc(tIn(locale, "export.doc.settledOn", { date }));
  // Preserve the balance column (fifth) and the six-column table grid.
  return (
    `<tr class="settled"><td colspan="4" dir="auto">${label}</td>` +
    `<td class="n">${num(fmtSigned(row.balanceAfter))}</td><td></td></tr>`
  );
}

function archivedPeriodHtml(
  period: NonNullable<PersonStatement["archivedSharedPeriods"]>[number],
  st: PersonStatement,
): string {
  const { locale, calendar } = st;
  let index = 0;
  const rows = period.rows
    .map((row) => {
      if (row.kind === "settled") return settlementRowHtml(row, st);
      const entry = row.entry;
      const gave = entry.type === "debt";
      // Coloured by direction exactly like the main table (see the comment
      // there): the type word and the amount, never a sign.
      const cls = gave ? "gave" : "received";
      return `<tr>
<td class="idx n">${num(String(++index))}</td>
<td class="muted" dir="auto">${esc(formatSettlementDate(entry.created_at, locale, calendar))}</td>
<td class="c"><span class="type ${cls}" dir="auto">${esc(tIn(locale, gave ? "export.col.gave" : "export.col.received"))}</span><span class="recordStatus" dir="auto">${esc(recordStatus(entry.tab, locale))}</span></td>
<td class="n amount ${cls}${isExcludedRecord(entry) ? " excluded" : ""}">${num(`${formatAmount(entry.amount_afn)} ${esc(period.link.currency)}`)}</td>
<td class="n bal">${num(fmtSigned(row.balanceAfter))}</td>
<td class="note" dir="auto">${esc(noteFor(entry.note, entry.tab?.kind, locale) ?? "")}</td>
</tr>${recordDetailHtml(entry, locale)}`;
    })
    .join("");
  return `<section class="section">
<h2 class="sectionTitle" dir="auto">${esc(tIn(locale, "export.record.archiveTitle"))} — ${esc(formatSettlementDate(period.link.linked_at, locale, calendar))}</h2>
<p class="recordNotes metaLine"><span dir="auto">${esc(period.link.my_label)}</span><span class="sep">·</span><span dir="auto">${esc(period.link.other_label)}</span><span class="sep">·</span><span dir="ltr">${esc(period.link.currency)}</span></p>
<p class="recordNotes" dir="auto">${esc(tIn(locale, "export.record.archiveExplanation"))}</p>
${period.link.closed_reason === "account_deleted" ? `<p class="recordNotes" dir="auto">${esc(tIn(locale, "export.record.closedDeleted"))}</p>` : ""}
<table><thead><tr>
<th class="n">${esc(tIn(locale, "export.col.num"))}</th><th>${esc(tIn(locale, "export.col.date"))}</th>
<th class="c">${esc(tIn(locale, "export.col.type"))}</th><th class="n">${esc(tIn(locale, "export.col.amount"))}</th>
<th class="n">${esc(tIn(locale, "export.record.periodBalance"))}</th><th>${esc(tIn(locale, "export.col.note"))}</th>
</tr></thead><tbody>${st.exportOptions?.period ? `<tr class="settled"><td colspan="4" dir="auto">${esc(pdfCopy(locale, "earlierOpening"))}</td><td class="n">${num(fmtSigned(period.openingBalance ?? 0))}</td><td></td></tr>` : ""}${rows}</tbody></table></section>`;
}

function preLinkHistoryHtml(st: PersonStatement): string {
  if (!st.preLinkRows?.length) return "";
  const { locale, calendar, currencyCode } = st;
  let index = 0;
  const rows = st.preLinkRows
    .map((row) => {
      if (row.kind === "settled") return settlementRowHtml(row, st);
      const entry = row.entry;
      const gave = entry.type === "debt";
      const cls = gave ? "gave" : "received";
      return `<tr>
<td class="idx n">${num(String(++index))}</td>
<td class="muted" dir="auto">${esc(formatSettlementDate(entry.created_at, locale, calendar))}</td>
<td class="c"><span class="type ${cls}" dir="auto">${esc(tIn(locale, gave ? "export.col.gave" : "export.col.received"))}</span></td>
<td class="n amount ${cls}">${num(`${formatAmount(entry.amount_afn)} ${esc(currencyCode)}`)}</td>
<td class="n bal">${num(fmtSigned(row.balanceAfter))}</td>
<td class="note" dir="auto">${esc(noteFor(entry.note, undefined, locale) ?? "")}</td>
</tr>`;
    })
    .join("");
  return `<section class="section">
<h2 class="sectionTitle" dir="auto">${esc(tIn(locale, "export.preLinkHistory.title"))} — ${esc(currencyCode)}</h2>
<p class="recordNotes" dir="auto">${esc(tIn(locale, "export.preLinkHistory.note"))}</p>
<table><thead><tr>
<th class="n">${esc(tIn(locale, "export.col.num"))}</th><th>${esc(tIn(locale, "export.col.date"))}</th>
<th class="c">${esc(tIn(locale, "export.col.type"))}</th><th class="n">${esc(tIn(locale, "export.col.amount"))}</th>
<th class="n">${esc(tIn(locale, "export.record.periodBalance"))}</th><th>${esc(tIn(locale, "export.col.note"))}</th>
</tr></thead><tbody>${st.exportOptions?.period ? `<tr class="settled"><td colspan="4" dir="auto">${esc(pdfCopy(locale, "earlierOpening"))}</td><td class="n">${num(fmtSigned(st.preLinkOpeningBalance ?? 0))}</td><td></td></tr>` : ""}${rows}</tbody></table></section>`;
}

type DocumentContext = Pick<
  PersonStatement,
  "locale" | "calendar" | "generatedAtMs" | "exportOptions" | "hasEarlierHistory"
>;

function periodLabel(doc: DocumentContext): string {
  const period = doc.exportOptions?.period;
  const date = (ms: number) => formatSettlementDate(ms, doc.locale, doc.calendar);
  if (period?.startMs != null && period.endMs != null)
    return `${date(period.startMs)} — ${date(period.endMs - 1)}`;
  if (period?.startMs != null) return pdfCopy(doc.locale, "from", { date: date(period.startMs) });
  if (period?.endMs != null)
    return pdfCopy(doc.locale, "through", { date: date(period.endMs - 1) });
  return pdfCopy(
    doc.locale,
    doc.hasEarlierHistory && doc.exportOptions?.detail === "standard"
      ? "currentHistory"
      : "allTime",
  );
}

function documentMeta(doc: DocumentContext, currency: string): string[] {
  return [
    `${esc(pdfCopy(doc.locale, "period"))}: ${isolated(periodLabel(doc))}`,
    `${esc(pdfCopy(doc.locale, "currency"))}: ${num(esc(currency))}`,
    isolated(
      tIn(doc.locale, "export.doc.generated", {
        date: formatSettlementDate(doc.generatedAtMs, doc.locale, doc.calendar),
      }),
    ),
  ];
}

function fact(label: string, value: string): string {
  return `<div class="fact"><span class="subtle" dir="auto">${esc(label)}</span><span class="factValue">${value}</span></div>`;
}

function internalNotesHtml(
  notes: ExportNote[] | undefined,
  doc: DocumentContext,
  withPerson = false,
): string {
  if (!doc.exportOptions?.includeNotes || !notes?.length) return "";
  return `<section class="section"><h2 class="sectionTitle" dir="auto">${esc(pdfCopy(doc.locale, "notes"))}</h2>
<p class="subtle" dir="auto">${esc(pdfCopy(doc.locale, "notesHelp"))}</p>
${notes
  .map(
    (note) => `<div class="internalNote">
${withPerson ? `<div class="reportName" dir="auto">${esc(note.personName)}</div>` : ""}
<div class="noteBody" dir="auto">${esc(note.note)}</div>
${note.noteNumber != null ? `<div class="noteNumber">${isolated(pdfCopy(doc.locale, "noteNumber"))}: ${num(esc(note.noteNumber))}</div>` : ""}
<div class="noteMeta">${isolated(formatSettlementDate(note.createdAt, doc.locale, doc.calendar))}${note.authorName ? ` · ${isolated(pdfCopy(doc.locale, "by", { name: note.authorName }))}` : ""}</div>
</div>`,
  )
  .join("")}</section>`;
}

/** A customer-facing statement uses one column per movement direction. Currency
 * is declared once, and pending/excluded records stay visible without affecting
 * the opening, running or closing balance. The detailed record remains opt-in. */
function compactStatementBody(st: PersonStatement): string {
  const { locale, calendar } = st;
  const shop = st.vaultName || st.self?.shop_name || tIn(locale, "export.doc.summaryTitle");
  const entries = st.rows.flatMap((row) => (row.kind === "entry" ? [row.entry] : []));
  const totals = st.periodTotals ?? {
    gave: sumAmounts(
      entries.filter((entry) => balanceContribution(entry) > 0).map((entry) => entry.amount_afn),
    ),
    received: sumAmounts(
      entries.filter((entry) => balanceContribution(entry) < 0).map((entry) => entry.amount_afn),
    ),
  };
  const direction =
    st.balance === 0
      ? esc(pdfCopy(locale, "balanced"))
      : pdfSentence(locale, st.balance > 0 ? "owesShop" : "shopOwes", {
          person: st.person.name,
          shop,
        });
  const balanceRow = (label: string, balance: number) =>
    `<tr class="balanceRow"><td colspan="4" dir="auto">${esc(label)}</td><td class="n">${num(fmtSigned(balance))}</td></tr>`;
  const rows = st.rows
    .map((row) => {
      if (row.kind === "settled") {
        const date = formatSettlementDate(row.ms, locale, calendar);
        const label = row.shared
          ? clearanceNote(row.shared.settlement.actor_name, date, locale, {
              text: esc,
              value: isolated,
            })
          : esc(tIn(locale, "export.doc.settledOn", { date }));
        return `<tr class="settled"><td colspan="4" dir="auto">${label}</td><td class="n">${num(fmtSigned(row.balanceAfter))}</td></tr>`;
      }
      const e = row.entry;
      const description = noteFor(e.note, e.tab?.kind, locale) || "—";
      const counts = countsTowardBalance(e);
      const status = e.tab
        ? `<span class="status" dir="auto">${esc(recordStatus(e.tab, locale))}${!counts ? ` · ${isolated(tIn(locale, e.type === "debt" ? "export.col.gave" : "export.col.received"))} ${num(`${formatAmount(e.amount_afn)} ${esc(st.currencyCode)}`)}` : ""}</span>`
        : "";
      const amount = num(formatAmount(e.amount_afn));
      const cls = isExcludedRecord(e) ? " excluded" : "";
      return `<tr>
<td class="date" dir="auto">${esc(formatSettlementDate(e.created_at, locale, calendar))}</td>
<td class="description" dir="auto">${esc(description)}${status}</td>
<td class="n amount${cls}">${counts && e.type === "debt" ? amount : "—"}</td>
<td class="n amount${cls}">${counts && e.type === "payment" ? amount : "—"}</td>
<td class="n bal">${num(fmtSigned(row.balanceAfter))}</td>
</tr>`;
    })
    .join("");
  const context = `${isolated(shop)} · ${isolated(st.person.name)} · ${num(esc(st.currencyCode))}`;
  return `${masthead({ brand: shop, docTitle: tIn(locale, "export.doc.statementTitle"), meta: documentMeta(st, st.currencyCode) })}
<div class="summaryTop">
<div class="customerInfo"><div class="subtle" dir="auto">${esc(pdfCopy(locale, "customer"))}</div><div class="customerName" dir="auto">${esc(st.person.name)}</div>${st.person.phone ? `<div class="subtle">${num(esc(st.person.phone))}</div>` : ""}${st.exportOptions?.includeNotes && st.personDescription ? `<div class="reportDescription" dir="auto">${esc(st.personDescription)}</div>` : ""}</div>
<div class="closing"><div class="subtle" dir="auto">${esc(pdfCopy(locale, "closing"))}</div><div class="closingValue">${num(`${formatAmount(st.balance)} ${esc(st.currencyCode)}`)}</div><div class="balanceDirection" dir="${locale === "en" ? "ltr" : "rtl"}">${direction}</div></div>
</div>
<div class="facts">${fact(pdfCopy(locale, "opening"), num(fmtSigned(st.openingBalance ?? 0)))}${fact(tIn(locale, "export.doc.totalGave"), num(formatAmount(totals.gave)))}${fact(tIn(locale, "export.doc.totalReceived"), num(formatAmount(totals.received)))}</div>
<p class="subtle" dir="${locale === "en" ? "ltr" : "rtl"}">${pdfSentence(locale, "perspective", { shop })}</p>
${entries.some((entry) => !!entry.tab) ? `<p class="subtle" dir="auto">${esc(pdfCopy(locale, "unconfirmed"))}</p>` : ""}
${st.exportOptions?.period ? `<p class="subtle" dir="auto">${esc(pdfCopy(locale, "selectedDates"))}</p>` : ""}
${st.hasEarlierHistory && st.exportOptions?.detail === "standard" ? `<p class="subtle" dir="auto">${esc(pdfCopy(locale, "earlierAvailable"))}</p>` : ""}
<table class="ledger"><colgroup><col style="width:17%"><col style="width:35%"><col style="width:16%"><col style="width:16%"><col style="width:16%"></colgroup>
<thead><tr class="identity"><th colspan="5">${context}</th></tr><tr>
<th>${esc(tIn(locale, "export.col.date"))}</th><th>${esc(pdfCopy(locale, "description"))}</th><th class="n">${esc(tIn(locale, "export.col.gave"))}</th><th class="n">${esc(tIn(locale, "export.col.received"))}</th><th class="n">${esc(tIn(locale, "export.col.balance"))}</th>
</tr></thead><tbody>${balanceRow(pdfCopy(locale, "opening"), st.openingBalance ?? 0)}${rows || `<tr><td colspan="5" class="empty" dir="auto">${esc(pdfCopy(locale, "noActivity"))}</td></tr>`}${balanceRow(pdfCopy(locale, "closing"), st.balance)}</tbody></table>
${internalNotesHtml(st.notes, st)}`;
}

function compactReportBody(report: VaultReport): string {
  const { locale, calendar, currencyCode } = report;
  const asOf = formatSettlementDate(
    (report.exportOptions?.period?.endMs ?? report.generatedAtMs + 1) - 1,
    locale,
    calendar,
  );
  const rows = report.people
    .map(
      (person) => `<tr>
<td><div class="reportName" dir="auto">${esc(person.name)}</div>${person.phone ? `<span class="reportPhone">${num(esc(person.phone))}</span>` : ""}${report.exportOptions?.includeNotes && person.description ? `<div class="reportDescription" dir="auto">${esc(person.description)}</div>` : ""}</td>
<td class="date" dir="auto">${person.lastEntryAt ? esc(formatSettlementDate(person.lastEntryAt, locale, calendar)) : "—"}</td>
<td class="n amount">${person.balance > 0 ? num(formatAmount(person.balance)) : "—"}</td>
<td class="n amount">${person.balance < 0 ? num(formatAmount(person.balance)) : "—"}</td>
</tr>`,
    )
    .join("");
  return `${masthead({ brand: report.vaultName, docTitle: tIn(locale, "export.doc.summaryTitle"), meta: documentMeta(report, currencyCode) })}
<section class="section"><h2 class="sectionTitle" dir="auto">${esc(pdfCopy(locale, "asOf", { date: asOf }))}</h2>
<div class="facts">${fact(pdfCopy(locale, "collect"), num(`${formatAmount(report.totals.collect)} ${esc(currencyCode)}`))}${fact(pdfCopy(locale, "pay"), num(`${formatAmount(report.totals.pay)} ${esc(currencyCode)}`))}${fact(tIn(locale, "export.doc.net"), num(`${fmtSigned(report.totals.net)} ${esc(currencyCode)}`))}</div>
${report.exportOptions?.period && report.periodTotals ? `<p class="subtle" dir="auto">${esc(pdfCopy(locale, "periodFlows"))}: ${isolated(tIn(locale, "export.col.gave"))} ${num(formatAmount(report.periodTotals.gave))} · ${isolated(tIn(locale, "export.col.received"))} ${num(formatAmount(report.periodTotals.received))}</p>` : ""}
<table class="ledger"><colgroup><col style="width:44%"><col style="width:20%"><col style="width:18%"><col style="width:18%"></colgroup>
<thead><tr class="identity"><th colspan="4">${isolated(report.vaultName)} · ${num(esc(currencyCode))}</th></tr><tr><th>${esc(tIn(locale, "export.col.person"))}</th><th>${esc(tIn(locale, "export.col.lastActivity"))}</th><th class="n">${esc(pdfCopy(locale, "collect"))}</th><th class="n">${esc(pdfCopy(locale, "pay"))}</th></tr></thead>
<tbody>${rows || `<tr><td colspan="4" class="empty" dir="auto">${esc(tIn(locale, "export.doc.empty"))}</td></tr>`}</tbody></table></section>
${internalNotesHtml(report.notes, report, true)}`;
}

function personStatementBody(st: PersonStatement): string {
  if (st.exportOptions) {
    const sharedEntries = st.rows.flatMap((row) =>
      row.kind === "entry" && row.entry.tab ? [row.entry] : [],
    );
    const detail = st.exportOptions.detail === "detailed";
    return (
      compactStatementBody(st) +
      (detail
        ? `
${sharedEntries.length ? `<section class="section"><h2 class="sectionTitle" dir="auto">${esc(pdfCopy(st.locale, "details"))}</h2>${receiptsHtml(sharedEntries, st)}</section>` : ""}
${preLinkHistoryHtml(st)}${(st.archivedSharedPeriods ?? []).map((period) => archivedPeriodHtml(period, st)).join("")}`
        : "")
    );
  }
  const { locale, calendar, currencySymbol: sym } = st;
  const shopName = st.self?.shop_name ?? st.self?.name ?? "";
  const entries = st.rows.filter((r) => r.kind === "entry");
  const shared =
    st.rows.some((r) => (r.kind === "entry" ? r.entry.tab : r.shared)) ||
    !!st.preLinkRows?.length ||
    !!st.archivedSharedPeriods?.length;
  const totals = st.sharedTotals ?? recordTotals(entries.map((r) => r.entry));

  // Totals for the summary cards. Computed here rather than in data.ts so the
  // CSV — a machine format whose columns are a stable contract — is untouched
  // by a presentation change.
  const totalGave = sumAmounts(
    entries
      .filter((r) => r.entry.type === "debt" && balanceContribution(r.entry) !== 0)
      .map((r) => r.entry.amount_afn),
  );
  const totalReceived = sumAmounts(
    entries
      .filter((r) => r.entry.type === "payment" && balanceContribution(r.entry) !== 0)
      .map((r) => r.entry.amount_afn),
  );

  const meta = [
    esc(
      tIn(locale, "export.doc.generated", {
        date: formatSettlementDate(st.generatedAtMs, locale, calendar),
      }),
    ),
    esc(tIn(locale, "export.doc.entriesCount", { n: countIn(locale, entries.length) })),
  ];

  const partyRows = [
    `<div class="partyRow"><span class="partyLabel" dir="auto">${esc(tIn(locale, "export.doc.customer"))}</span><span class="partyValue" dir="auto">${esc(st.person.name)}</span></div>`,
  ];
  if (st.person.phone) {
    partyRows.push(
      `<div class="partyRow"><span class="partyLabel" dir="auto">${esc(tIn(locale, "export.col.phone"))}</span><span class="partyValue sm">${num(esc(st.person.phone))}</span></div>`,
    );
  }

  // The direction word under the balance: the app's own vocabulary, so the
  // document and the screen agree on what a positive number means.
  const balanceNote =
    st.balance > 0
      ? tIn(locale, "home.tab.collect")
      : st.balance < 0
        ? tIn(locale, "home.tab.pay")
        : tIn(locale, "person.balance.settled");
  const balanceColor =
    st.balance > 0 ? colors.collectStrong : st.balance < 0 ? colors.payStrong : colors.textDefault;

  const summaryHtml = shared
    ? `<div class="cards">
${card({ tone: "flat", label: tIn(locale, "export.record.acknowledgedBalance"), value: `${fmtSigned(totals.acknowledged)} ${sym}` })}
${totals.recorded != null ? card({ tone: "flat", label: tIn(locale, "export.record.recordedBalance"), value: `${fmtSigned(totals.recorded)} ${sym}` }) : ""}
${card({ tone: "flat", label: tIn(locale, "export.record.pendingBalance"), value: `${fmtSigned(totals.pending)} ${sym}` })}
${card({ tone: "flat", label: tIn(locale, "export.doc.balance"), value: `${fmtSigned(st.balance)} ${sym}`, color: balanceColor, note: balanceNote })}
</div>
${entries.some((r) => !r.entry.tab) ? `<p class="recordNotes" dir="auto">${esc(tIn(locale, "export.record.privateBalance"))}: ${num(fmtSigned(totals.private))} ${esc(sym)}</p>` : ""}
<p class="recordNotes" dir="auto">${esc(tIn(locale, "export.record.explanation"))}</p>
${entries.some((r) => r.entry.tab?.closed_reason === "account_deleted") ? `<p class="recordNotes" dir="auto">${esc(tIn(locale, "export.record.closedDeleted"))}</p>` : ""}`
    : `<div class="cards">
${card({ tone: "pay", label: tIn(locale, "export.doc.totalGave"), value: `${formatAmount(totalGave)} ${sym}`, color: colors.payStrong })}
${card({ tone: "collect", label: tIn(locale, "export.doc.totalReceived"), value: `${formatAmount(totalReceived)} ${sym}`, color: colors.collectStrong })}
${card({ tone: "flat", label: tIn(locale, "export.doc.balance"), value: `${fmtSigned(st.balance)} ${sym}`, color: balanceColor, note: balanceNote })}
</div>`;

  let tableHtml: string;
  if (st.rows.length === 0) {
    tableHtml = `<p class="empty" dir="auto">${esc(tIn(locale, "export.doc.empty"))}</p>`;
  } else {
    let n = 0;
    const rows = st.rows
      .map((row) => {
        if (row.kind === "settled") {
          return settlementRowHtml(row, st);
        }
        const e = row.entry;
        const gave = e.type === "debt";
        // Amount is coloured by DIRECTION OF GOODS, never signed here: "I
        // gave" is garnet and "I received" is emerald across the whole app
        // (see lib/colors.ts). A sign in this column would encode a second,
        // opposite axis — a gave row increases what they owe — and the two
        // readings fight. The sign lives on the balance, where it means
        // exactly one thing.
        const cls = gave ? "gave" : "received";
        const typeLabel = tIn(locale, gave ? "export.col.gave" : "export.col.received");
        return (
          `<tr>` +
          `<td class="idx n">${num(String(++n))}</td>` +
          `<td class="muted" dir="auto">${esc(formatSettlementDate(e.created_at, locale, calendar))}</td>` +
          `<td class="c"><span class="type ${cls}" dir="auto">${esc(typeLabel)}</span>${shared ? `<span class="recordStatus" dir="auto">${esc(recordStatus(e.tab, locale))}</span>` : ""}</td>` +
          `<td class="n amount ${cls}${isExcludedRecord(e) ? " excluded" : ""}">${num(`${formatAmount(e.amount_afn)} ${esc(sym)}`)}</td>` +
          // The running balance is back, and deliberately NEUTRAL. A statement
          // exists to be checked, and without it the reader has to add
          // twenty-five numbers to see how the total was reached. It is not
          // coloured because the column beside it already carries a colour on
          // a different axis; two colour meanings side by side is what made
          // the old document unreadable.
          `<td class="n bal">${num(fmtSigned(row.balanceAfter))}</td>` +
          `<td class="note" dir="auto">${esc(noteFor(e.note, e.tab?.kind, locale) ?? "")}</td>` +
          `</tr>` +
          (e.tab ? recordDetailHtml(e, locale) : "")
        );
      })
      .join("");
    tableHtml = `<table>
<thead><tr>
<th class="n">${esc(tIn(locale, "export.col.num"))}</th>
<th>${esc(tIn(locale, "export.col.date"))}</th>
<th class="c">${esc(tIn(locale, "export.col.type"))}</th>
<th class="n">${esc(tIn(locale, "export.col.amount"))}</th>
<th class="n">${esc(tIn(locale, "export.col.balance"))}</th>
<th>${esc(tIn(locale, "export.col.note"))}</th>
</tr></thead>
<tbody>${rows}</tbody>
</table>`;
  }

  const body = `${masthead({
    brand: shopName,
    docTitle: tIn(locale, shared ? "export.record.title" : "export.doc.statementTitle"),
    meta,
  })}
<div class="content">
<section class="party">${partyRows.join("")}</section>
<section class="section">
<h2 class="sectionTitle" dir="auto">${esc(tIn(locale, "export.doc.summarySection"))} — ${esc(st.currencyCode)}</h2>
${summaryHtml}
</section>
<section class="section">
<h2 class="sectionTitle" dir="auto">${esc(tIn(locale, "export.doc.transactionsSection"))}</h2>
${tableHtml}
</section>
${preLinkHistoryHtml(st)}
${(st.archivedSharedPeriods ?? []).map((period) => archivedPeriodHtml(period, st)).join("")}
</div>`;

  return body;
}

export async function renderPersonStatementPdf(
  st: PersonStatement,
  fileName: string,
): Promise<File> {
  const html = htmlShell({
    locale: st.locale,
    fontCss: await vazirmatnCss(),
    title: `${tIn(st.locale, "export.doc.statementTitle")} — ${st.person.name}`,
    body: personStatementBody(st),
  });
  return printToTarget(html, fileName);
}

export async function renderPersonCurrenciesPdf(
  statements: readonly PersonStatement[],
  fileName: string,
): Promise<File> {
  if (statements.length === 0) throw new Error("No currency statements");
  if (statements.length === 1) return renderPersonStatementPdf(statements[0], fileName);
  const first = statements[0];
  return printToTarget(
    htmlShell({
      locale: first.locale,
      fontCss: await vazirmatnCss(),
      title: `${tIn(first.locale, "export.doc.statementTitle")} — ${first.person.name}`,
      body: statements
        .map(
          (statement, index) =>
            `<article${index ? ' style="break-before: page; page-break-before: always"' : ""}>${personStatementBody(statement)}</article>`,
        )
        .join(""),
    }),
    fileName,
  );
}

function reportJournalHtml(report: VaultReport): string {
  const { locale, calendar, currencyCode } = report;
  return report.people
    .map((person) => {
      const entries = report.journal.filter((entry) => entry.person_id === person.id);
      if (!entries.length) return "";
      const rows = entries
        .map((entry) => {
          const counts = countsTowardBalance(entry);
          const status = entry.tab
            ? `<span class="status" dir="auto">${esc(recordStatus(entry.tab, locale))}${!counts ? ` · ${isolated(tIn(locale, entry.type === "debt" ? "export.col.gave" : "export.col.received"))} ${num(`${formatAmount(entry.amount_afn)} ${esc(currencyCode)}`)}` : ""}</span>`
            : "";
          return `<tr><td class="date" dir="auto">${esc(formatSettlementDate(entry.created_at, locale, calendar))}</td><td class="description" dir="auto">${esc(noteFor(entry.note, entry.tab?.kind, locale) || "—")}${status}</td><td class="n">${counts && entry.type === "debt" ? num(formatAmount(entry.amount_afn)) : "—"}</td><td class="n">${counts && entry.type === "payment" ? num(formatAmount(entry.amount_afn)) : "—"}</td><td class="n">${num(fmtSigned(entry.balanceAfter))}</td></tr>`;
        })
        .join("");
      return `<section class="section"><h2 class="sectionTitle" dir="auto">${esc(person.name)} — ${esc(pdfCopy(locale, "journal"))}</h2>
<table class="ledger"><colgroup><col style="width:17%"><col style="width:35%"><col style="width:16%"><col style="width:16%"><col style="width:16%"></colgroup>
<thead><tr class="identity"><th colspan="5">${isolated(report.vaultName)} · ${isolated(person.name)} · ${num(esc(currencyCode))}</th></tr><tr><th>${esc(tIn(locale, "export.col.date"))}</th><th>${esc(pdfCopy(locale, "description"))}</th><th class="n">${esc(tIn(locale, "export.col.gave"))}</th><th class="n">${esc(tIn(locale, "export.col.received"))}</th><th class="n">${esc(tIn(locale, "export.col.balance"))}</th></tr></thead>
<tbody><tr class="balanceRow"><td colspan="4" dir="auto">${esc(pdfCopy(locale, "opening"))}</td><td class="n">${num(fmtSigned(person.openingBalance ?? 0))}</td></tr>${rows}<tr class="balanceRow"><td colspan="4" dir="auto">${esc(pdfCopy(locale, "closing"))}</td><td class="n">${num(fmtSigned(person.balance))}</td></tr></tbody></table>
${
  entries.some((entry) => entry.tab)
    ? `<p class="subtle" dir="auto">${esc(pdfCopy(locale, "unconfirmed"))}</p>${receiptsHtml(
        entries.filter((entry) => entry.tab),
        report,
      )}`
    : ""
}
</section>`;
    })
    .join("");
}

function vaultReportBody(report: VaultReport): string {
  if (report.exportOptions)
    return (
      compactReportBody(report) +
      (report.exportOptions.detail === "detailed" ? reportJournalHtml(report) : "")
    );
  const { locale, calendar, currencySymbol: sym } = report;

  const meta = [
    esc(
      tIn(locale, "export.doc.generated", {
        date: formatSettlementDate(report.generatedAtMs, locale, calendar),
      }),
    ),
    esc(tIn(locale, "export.doc.peopleCount", { n: countIn(locale, report.people.length) })),
    esc(tIn(locale, "export.doc.entriesCount", { n: countIn(locale, report.journal.length) })),
  ];

  const partyRows: string[] = [];
  if (report.self?.name) {
    partyRows.push(
      `<div class="partyRow"><span class="partyLabel" dir="auto">${esc(tIn(locale, "export.doc.preparedBy"))}</span><span class="partyValue" dir="auto">${esc(report.self.name)}</span></div>`,
    );
  }
  if (report.self?.phone) {
    partyRows.push(
      `<div class="partyRow"><span class="partyLabel" dir="auto">${esc(tIn(locale, "export.col.phone"))}</span><span class="partyValue sm">${num(esc(report.self.phone))}</span></div>`,
    );
  }

  const netColor =
    report.totals.net > 0
      ? colors.collectStrong
      : report.totals.net < 0
        ? colors.payStrong
        : colors.textDefault;
  // How many PEOPLE sit behind each total. A single figure hides whether it is
  // one large debt or thirty small ones, which is the first thing you want to
  // know before deciding what to do about it.
  const collectCount = report.people.filter((p) => p.balance > 0).length;
  const payCount = report.people.filter((p) => p.balance < 0).length;
  const settledCount = report.people.filter((p) => p.balance === 0).length;
  const peopleNote = (n: number) =>
    tIn(locale, "export.doc.peopleCount", { n: countIn(locale, n) });

  const summaryHtml = `<div class="cards">
${card({ tone: "collect", label: tIn(locale, "export.doc.totalCollect"), value: `${formatAmount(report.totals.collect)} ${sym}`, color: colors.collectStrong, note: peopleNote(collectCount) })}
${card({ tone: "pay", label: tIn(locale, "export.doc.totalPay"), value: `${formatAmount(report.totals.pay)} ${sym}`, color: colors.payStrong, note: peopleNote(payCount) })}
${card({ tone: "flat", label: tIn(locale, "export.doc.net"), value: `${fmtSigned(report.totals.net)} ${sym}`, color: netColor, note: `${peopleNote(settledCount)} ${tIn(locale, "person.balance.settled")}` })}
</div>`;

  let tableHtml: string;
  if (report.people.length === 0) {
    tableHtml = `<p class="empty" dir="auto">${esc(tIn(locale, "export.doc.empty"))}</p>`;
  } else {
    let n = 0;
    const rows = report.people
      .map((p) => {
        const collect = p.balance > 0;
        const pay = p.balance < 0;
        const cls = collect ? "received" : pay ? "gave" : "";
        const status = collect
          ? tIn(locale, "home.tab.collect")
          : pay
            ? tIn(locale, "home.tab.pay")
            : tIn(locale, "person.balance.settled");
        return (
          `<tr>` +
          `<td class="idx n">${num(String(++n))}</td>` +
          `<td dir="auto">${esc(p.name)}</td>` +
          `<td class="muted">${p.phone ? num(esc(p.phone)) : ""}</td>` +
          // Last activity replaced the entry COUNT. "25 entries" tells the
          // shopkeeper nothing they act on; "last wrote three months ago" is
          // exactly how you find the accounts that have gone quiet while still
          // owing. The data was already computed and thrown away.
          `<td class="muted" dir="auto">${esc(formatSettlementDate(p.lastEntryAt, locale, calendar))}</td>` +
          `<td class="c"><span class="type ${cls}" dir="auto">${esc(status)}</span></td>` +
          `<td class="n amount ${cls}">${num(`${fmtSigned(p.balance)} ${esc(sym)}`)}</td>` +
          `</tr>`
        );
      })
      .join("");
    tableHtml = `<table>
<thead><tr>
<th class="n">${esc(tIn(locale, "export.col.num"))}</th>
<th>${esc(tIn(locale, "export.col.person"))}</th>
<th>${esc(tIn(locale, "export.col.phone"))}</th>
<th>${esc(tIn(locale, "export.col.lastActivity"))}</th>
<th class="c">${esc(tIn(locale, "export.col.status"))}</th>
<th class="n">${esc(tIn(locale, "export.col.balance"))}</th>
</tr></thead>
<tbody>${rows}</tbody>
</table>`;
  }

  const body = `${masthead({
    brand: report.vaultName,
    docTitle: tIn(locale, "export.doc.summaryTitle"),
    meta,
  })}
<div class="content">
${partyRows.length ? `<section class="party">${partyRows.join("")}</section>` : ""}
<section class="section">
<h2 class="sectionTitle" dir="auto">${esc(tIn(locale, "export.doc.summarySection"))} — ${esc(report.currencyCode)}</h2>
${summaryHtml}
</section>
<section class="section">
<h2 class="sectionTitle" dir="auto">${esc(tIn(locale, "export.doc.peopleSection"))}</h2>
${tableHtml}
</section>
</div>`;
  return body;
}

export async function renderVaultReportPdf(report: VaultReport, fileName: string): Promise<File> {
  const { locale } = report;
  const html = htmlShell({
    locale,
    fontCss: await vazirmatnCss(),
    title: `${tIn(locale, "export.doc.summaryTitle")} — ${report.vaultName}`,
    body: vaultReportBody(report),
  });
  return printToTarget(html, fileName);
}

export async function renderVaultCurrenciesPdf(
  reports: readonly VaultReport[],
  fileName: string,
): Promise<File> {
  if (reports.length === 0) throw new Error("No currency reports");
  if (reports.length === 1) return renderVaultReportPdf(reports[0], fileName);
  const first = reports[0];
  return printToTarget(
    htmlShell({
      locale: first.locale,
      fontCss: await vazirmatnCss(),
      title: `${tIn(first.locale, "export.doc.summaryTitle")} — ${first.vaultName}`,
      body: reports
        .map(
          (report, index) =>
            `<article${index ? ' style="break-before: page; page-break-before: always"' : ""}>${vaultReportBody(report)}</article>`,
        )
        .join(""),
    }),
    fileName,
  );
}
