// PDF builders — expo-print renders our HTML in a WebView, so the document is
// styled with plain CSS using the app's design tokens. The print WebView has
// no access to the app's registered fonts; Vazirmatn is embedded as a base64
// @font-face read from the same @expo-google-fonts packages the UI loads. If
// that read ever fails we still print — system WebView fonts shape Arabic
// script correctly, just off-brand.
//
// LAYOUT (rebuilt 2026-09 after a shopkeeper called the old one "ugly, not
// structured, unreadable"). The old document was five columns of small grey
// text under a hairline, three of them numeric (gave / received / running
// balance), with the one number anybody actually wanted — the balance — as a
// small chip at the very bottom. Nothing told the eye where to land.
//
// What replaced it, in reading order:
//   1. a full-bleed dark masthead carrying the shop name and what the document
//      IS, so page one announces itself;
//   2. a party card naming the other side of the account;
//   3. summary cards, so the totals are readable in one second instead of
//      requiring you to scroll to the end;
//   4. a titled section, then ONE table with a dark header band, row numbers
//      and zebra striping.
//
// The old table had THREE numeric columns — gave, received, running balance —
// and that, not the balance itself, was the clutter. Collapsing gave/received
// into one amount column plus a type word leaves room for the running balance
// to come back, which a statement needs: the document exists to be checked,
// and without it the reader must add every line to see how the total arose.
// The two numeric columns carry different weights of meaning, so only the
// amount is coloured; see the comment at the balance cell.
//
// Two print-only details that are easy to lose and silently ruin the result:
//   - `print-color-adjust: exact` — WebView print drops background colors by
//     default, which would render the masthead and the table header band as
//     white-on-white.
//   - `thead { display: table-header-group }` — repeats the column band on
//     every page. These statements run to several pages routinely.
import { Asset } from "expo-asset";
import { File } from "expo-file-system";
import * as Print from "expo-print";
import { Vazirmatn_400Regular, Vazirmatn_700Bold } from "@expo-google-fonts/vazirmatn";
import { colors } from "../colors";
import { formatAmount } from "../format";
import { tIn } from "../i18n";
import { faDigits, formatSettlementDate } from "../jalali";
import { sumAmounts } from "../money";
import { exportFileTarget, type PersonStatement, type VaultReport } from "./data";

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
function countIn(locale: "en" | "fa", n: number): string {
  return locale === "fa" ? faDigits(n) : String(n);
}

/** A number cell that survives RTL: LTR-isolated, tabular, never wrapped. */
function num(inner: string): string {
  return `<span class="num">${inner}</span>`;
}

function htmlShell(opts: {
  locale: "en" | "fa";
  fontCss: string;
  title: string;
  body: string;
}): string {
  const rtl = opts.locale === "fa";
  return `<!DOCTYPE html>
<html dir="${rtl ? "rtl" : "ltr"}" lang="${opts.locale}">
<head>
<meta charset="utf-8">
<title>${esc(opts.title)}</title>
<style>
${opts.fontCss}
/* Full bleed: the masthead runs to the paper edge like a letterhead, so the
   page itself carries no margin and each block owns its own padding. */
@page{margin:0}
*{margin:0;padding:0;box-sizing:border-box}
html,body{-webkit-print-color-adjust:exact;print-color-adjust:exact}
body{font-family:'Vazirmatn','Segoe UI',-apple-system,sans-serif;color:${colors.textEmphasis};font-size:12px;line-height:1.45}

/* ---- masthead ---------------------------------------------------- */
.masthead{background:${colors.bgInverted};color:${colors.textInverted};padding:26px 36px 22px;text-align:center}
.brand{font-size:20px;font-weight:700;letter-spacing:-.01em}
.docTitle{font-size:12px;font-weight:400;color:#C9C9C9;margin-top:5px}
.mastMeta{font-size:10px;color:#9A9A9A;margin-top:9px}
/* Each item is isolated and the separator is its own element. Without this
   the bidi algorithm runs a date and the count that follows it together —
   "۱۴۰۵" + "·" + "۴" renders as "۴۰۱۴۰۵", which looks like one nonsense
   number. Isolation is the whole fix; the dot alone is not a boundary. */
.mastMeta > span{unicode-bidi:isolate}
.mastMeta .sep{unicode-bidi:isolate;margin:0 7px;color:#6E6E6E}

/* ---- page body --------------------------------------------------- */
.content{padding:22px 36px 0}
.section{margin-top:20px}
/* Accent bar on the leading edge — logical property so it mirrors in RTL. */
.sectionTitle{font-size:13px;font-weight:700;border-inline-start:3px solid ${colors.textEmphasis};padding-inline-start:9px;margin-bottom:10px}

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
th{background:${colors.bgInverted};color:${colors.textInverted};font-size:10px;font-weight:700;text-align:start;padding:8px 9px;white-space:nowrap}
td{font-size:11px;padding:7px 9px;border-bottom:1px solid ${colors.borderSubtle};vertical-align:top}
tbody tr:nth-child(even) td{background:${colors.bgMuted}}
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
td.muted{color:${colors.textSubtle}}
/* Running balance: same weight as the amount so the two numeric columns read
   as a pair, but no hue — the colour in the amount column means direction,
   and a second meaning here would fight it. */
td.bal{font-weight:700;color:${colors.textEmphasis};white-space:nowrap}
/* Settlement line — the paper-khata rule-off. Kept loud on purpose: it is a
   real event in the account's history, not a row of data. */
tbody tr.settled td{text-align:center;font-size:10px;font-weight:700;color:${colors.textSubtle};background:${colors.bgSubtle};border-top:2px solid ${colors.borderEmphasis};border-bottom:2px solid ${colors.borderEmphasis}}

.num{direction:ltr;unicode-bidi:isolate;font-variant-numeric:tabular-nums;white-space:nowrap}
.empty{font-size:12px;color:${colors.textSubtle};padding:18px 0}
footer{margin-top:26px;padding:14px 36px 26px;text-align:center;font-size:9px;color:${colors.textMuted};border-top:1px solid ${colors.borderSubtle}}
/* Tracking severs Arabic-script joining (same fix as the web app's fa
   handling) — zero it wherever the labels are Dari. */
[dir=rtl] .brand,[dir=rtl] th,[dir=rtl] .cardLabel{letter-spacing:0}
</style>
</head>
<body>
${opts.body}
<footer dir="ltr">Powered by kaata. — kaata.af</footer>
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
  const { uri } = await Print.printToFileAsync({ html });
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

export async function renderPersonStatementPdf(
  st: PersonStatement,
  fileName: string,
): Promise<File> {
  const { locale, calendar, currencySymbol: sym } = st;
  const shopName = st.self?.shop_name ?? st.self?.name ?? "";
  const entries = st.rows.filter((r) => r.kind === "entry");

  // Totals for the summary cards. Computed here rather than in data.ts so the
  // CSV — a machine format whose columns are a stable contract — is untouched
  // by a presentation change.
  const totalGave = sumAmounts(
    entries.filter((r) => r.entry.type === "debt").map((r) => r.entry.amount_afn),
  );
  const totalReceived = sumAmounts(
    entries.filter((r) => r.entry.type === "payment").map((r) => r.entry.amount_afn),
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

  const summaryHtml = `<div class="cards">
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
          const label = tIn(locale, "export.doc.settledOn", {
            date: formatSettlementDate(row.ms, locale, calendar),
          });
          // The rule-off keeps the GRID: the label spans the first five cells
          // and the balance at that moment sits in the balance column, lined
          // up with every other balance. That makes a closed chapter
          // verifiable at a glance, and it sidesteps the bidi hazard of
          // putting a number next to Dari prose inside one spanned cell.
          return (
            `<tr class="settled">` +
            `<td colspan="5" dir="auto">${esc(label)}</td>` +
            `<td class="n">${num(fmtSigned(row.balanceAfter))}</td>` +
            `</tr>`
          );
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
          `<td class="c"><span class="type ${cls}" dir="auto">${esc(typeLabel)}</span></td>` +
          `<td class="n amount ${cls}">${num(`${formatAmount(e.amount_afn)} ${esc(sym)}`)}</td>` +
          // The running balance is back, and deliberately NEUTRAL. A statement
          // exists to be checked, and without it the reader has to add
          // twenty-five numbers to see how the total was reached. It is not
          // coloured because the column beside it already carries a colour on
          // a different axis; two colour meanings side by side is what made
          // the old document unreadable.
          `<td class="n bal">${num(fmtSigned(row.balanceAfter))}</td>` +
          `<td class="note" dir="auto">${esc(e.note ?? "")}</td>` +
          `</tr>`
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
    docTitle: tIn(locale, "export.doc.statementTitle"),
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
</div>`;

  const html = htmlShell({
    locale,
    fontCss: await vazirmatnCss(),
    title: `${tIn(locale, "export.doc.statementTitle")} — ${st.person.name}`,
    body,
  });
  return printToTarget(html, fileName);
}

export async function renderVaultReportPdf(report: VaultReport, fileName: string): Promise<File> {
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

  const html = htmlShell({
    locale,
    fontCss: await vazirmatnCss(),
    title: `${tIn(locale, "export.doc.summaryTitle")} — ${report.vaultName}`,
    body,
  });
  return printToTarget(html, fileName);
}
