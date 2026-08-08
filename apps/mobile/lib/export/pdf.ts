// PDF builders — expo-print renders our HTML in a WebView, so the document is
// styled with plain CSS using the app's design tokens. The print WebView has
// no access to the app's registered fonts; Vazirmatn is embedded as a base64
// @font-face read from the same @expo-google-fonts packages the UI loads. If
// that read ever fails we still print — system WebView fonts shape Arabic
// script correctly, just off-brand.
import { Asset } from "expo-asset";
import { File } from "expo-file-system";
import * as Print from "expo-print";
import { Vazirmatn_400Regular, Vazirmatn_700Bold } from "@expo-google-fonts/vazirmatn";
import { colors } from "../colors";
import { formatAmount } from "../format";
import { tIn } from "../i18n";
import { formatSettlementDate } from "../jalali";
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
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:'Vazirmatn','Segoe UI',-apple-system,sans-serif;color:${colors.textEmphasis};padding:44px 40px;font-size:12px}
.shop{font-size:11px;font-weight:700;color:${colors.textSubtle};letter-spacing:.06em;text-transform:uppercase}
h1{font-size:22px;font-weight:700;margin-top:6px}
.who{font-size:15px;font-weight:700;margin-top:14px}
.sub{font-size:11px;color:${colors.textSubtle};margin-top:2px}
.meta{font-size:10px;color:${colors.textMuted};margin-top:10px;padding-bottom:14px;border-bottom:1px solid ${colors.borderDefault}}
.num{direction:ltr;unicode-bidi:isolate;font-variant-numeric:tabular-nums;white-space:nowrap}
table{width:100%;border-collapse:collapse;margin-top:14px}
th{font-size:9px;letter-spacing:.08em;text-transform:uppercase;color:${colors.textSubtle};text-align:start;padding:6px 8px;border-bottom:1px solid ${colors.borderEmphasis}}
td{font-size:11px;padding:6px 8px;border-bottom:1px solid ${colors.borderSubtle};vertical-align:top}
th.n,td.n{text-align:end}
td.gave{color:${colors.payStrong}}
td.received{color:${colors.collectStrong}}
td.note{color:${colors.textSubtle}}
tr.settled td{text-align:center;font-size:10px;color:${colors.textSubtle};background:${colors.bgMuted};border-top:3px double ${colors.borderEmphasis};padding:5px 8px}
.empty{margin-top:24px;font-size:12px;color:${colors.textSubtle}}
.balanceRow{margin-top:18px;display:flex;align-items:baseline;gap:10px}
.balanceLabel{font-size:11px;color:${colors.textSubtle}}
.balanceAmount{font-size:20px;font-weight:700}
.chip{font-size:10px;font-weight:700;padding:3px 10px;border-radius:999px}
.totals{display:flex;gap:12px;margin-top:16px}
.card{flex:1;border:1px solid ${colors.borderDefault};border-radius:10px;padding:10px 12px}
.cardLabel{font-size:9px;letter-spacing:.06em;text-transform:uppercase;color:${colors.textSubtle}}
.cardValue{font-size:16px;font-weight:700;margin-top:4px}
footer{margin-top:30px;text-align:center;font-size:9px;color:${colors.textMuted}}
/* Tracking severs Arabic-script joining (same fix as the web app's fa
   handling) — zero it wherever the labels are Dari. */
[dir=rtl] .shop,[dir=rtl] th,[dir=rtl] .cardLabel{letter-spacing:0}
</style>
</head>
<body>
${opts.body}
<footer dir="ltr">Powered by kaata. — kaata.af</footer>
</body>
</html>`;
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
  const { locale, currencySymbol: sym } = st;
  const shopName = st.self?.shop_name ?? st.self?.name ?? "";
  const entryCount = st.rows.filter((r) => r.kind === "entry").length;

  const metaBits = [
    tIn(locale, "export.doc.generated", {
      date: formatSettlementDate(st.generatedAtMs, locale),
    }),
    tIn(locale, "export.doc.entriesCount", { n: entryCount }),
  ];
  if (st.self?.phone) metaBits.push(`<span class="num">${esc(st.self.phone)}</span>`);

  let tableHtml: string;
  if (st.rows.length === 0) {
    tableHtml = `<p class="empty">${esc(tIn(locale, "export.doc.empty"))}</p>`;
  } else {
    const rows = st.rows
      .map((row) => {
        if (row.kind === "settled") {
          const label = tIn(locale, "person.history.settledOn", {
            date: formatSettlementDate(row.ms, locale),
          });
          return `<tr class="settled"><td colspan="5">${esc(label)}</td></tr>`;
        }
        const e = row.entry;
        return (
          `<tr>` +
          `<td>${esc(formatSettlementDate(e.created_at, locale))}</td>` +
          `<td class="note" dir="auto">${esc(e.note ?? "")}</td>` +
          `<td class="n gave"><span class="num">${e.type === "debt" ? formatAmount(e.amount_afn) : ""}</span></td>` +
          `<td class="n received"><span class="num">${e.type === "payment" ? formatAmount(e.amount_afn) : ""}</span></td>` +
          `<td class="n"><span class="num">${fmtSigned(row.balanceAfter)}</span></td>` +
          `</tr>`
        );
      })
      .join("");
    tableHtml = `<table>
<thead><tr>
<th>${esc(tIn(locale, "export.col.date"))}</th>
<th>${esc(tIn(locale, "export.col.note"))}</th>
<th class="n">${esc(tIn(locale, "export.col.gave"))} (${sym})</th>
<th class="n">${esc(tIn(locale, "export.col.received"))} (${sym})</th>
<th class="n">${esc(tIn(locale, "export.col.balance"))} (${sym})</th>
</tr></thead>
<tbody>${rows}</tbody>
</table>`;
  }

  // Direction chip mirrors the app: emerald = money toward you, garnet = money
  // away; a deliberately settled book (last row is a ruled line) says so.
  let chip = "";
  if (st.balance > 0) {
    chip = `<span class="chip" style="background:${colors.collectBg};color:${colors.collectText}">${esc(tIn(locale, "home.tab.collect"))}</span>`;
  } else if (st.balance < 0) {
    chip = `<span class="chip" style="background:${colors.payBg};color:${colors.payText}">${esc(tIn(locale, "home.tab.pay"))}</span>`;
  } else if (st.rows.length > 0 && st.rows[st.rows.length - 1].kind === "settled") {
    // Neutral, not emerald — the app renders SETTLED as a neutral chip
    // (person/[id].tsx) because a settled book is directionless; emerald and
    // garnet stay exclusively directional.
    chip = `<span class="chip" style="background:${colors.bgSubtle};color:${colors.textSubtle}">${esc(tIn(locale, "person.balance.settled"))}</span>`;
  }
  const balanceColor =
    st.balance > 0 ? colors.collectStrong : st.balance < 0 ? colors.payStrong : colors.textDefault;

  const body = `
<header>
${shopName ? `<div class="shop" dir="auto">${esc(shopName)}</div>` : ""}
<h1>${esc(tIn(locale, "export.doc.statementTitle"))}</h1>
<div class="who" dir="auto">${esc(st.person.name)}</div>
${st.person.phone ? `<div class="sub"><span class="num">${esc(st.person.phone)}</span></div>` : ""}
<div class="meta">${metaBits.join(" · ")}</div>
</header>
${tableHtml}
<div class="balanceRow">
<span class="balanceLabel">${esc(tIn(locale, "export.doc.balance"))}</span>
<span class="balanceAmount num" style="color:${balanceColor}">${fmtSigned(st.balance)} ${sym}</span>
${chip}
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
  const { locale, currencySymbol: sym } = report;

  const metaBits = [
    tIn(locale, "export.doc.generated", {
      date: formatSettlementDate(report.generatedAtMs, locale),
    }),
    tIn(locale, "export.doc.peopleCount", { n: report.people.length }),
    tIn(locale, "export.doc.entriesCount", { n: report.journal.length }),
  ];
  if (report.self?.name) metaBits.push(`<span dir="auto">${esc(report.self.name)}</span>`);
  if (report.self?.phone) metaBits.push(`<span class="num">${esc(report.self.phone)}</span>`);

  const totalsHtml = `<div class="totals">
<div class="card"><div class="cardLabel">${esc(tIn(locale, "export.doc.totalCollect"))}</div><div class="cardValue num" style="color:${colors.collectStrong}">${formatAmount(report.totals.collect)} ${sym}</div></div>
<div class="card"><div class="cardLabel">${esc(tIn(locale, "export.doc.totalPay"))}</div><div class="cardValue num" style="color:${colors.payStrong}">${formatAmount(report.totals.pay)} ${sym}</div></div>
<div class="card"><div class="cardLabel">${esc(tIn(locale, "export.doc.net"))}</div><div class="cardValue num" style="color:${report.totals.net > 0 ? colors.collectStrong : report.totals.net < 0 ? colors.payStrong : colors.textDefault}">${fmtSigned(report.totals.net)} ${sym}</div></div>
</div>`;

  let tableHtml: string;
  if (report.people.length === 0) {
    tableHtml = `<p class="empty">${esc(tIn(locale, "export.doc.empty"))}</p>`;
  } else {
    const rows = report.people
      .map((p) => {
        const balColor =
          p.balance > 0
            ? colors.collectStrong
            : p.balance < 0
              ? colors.payStrong
              : colors.textMuted;
        const dir =
          p.balance > 0
            ? `<span style="color:${colors.collectText}">${esc(tIn(locale, "home.tab.collect"))}</span>`
            : p.balance < 0
              ? `<span style="color:${colors.payText}">${esc(tIn(locale, "home.tab.pay"))}</span>`
              : "";
        return (
          `<tr>` +
          `<td dir="auto">${esc(p.name)}</td>` +
          `<td><span class="num">${esc(p.phone ?? "")}</span></td>` +
          `<td class="n"><span class="num">${p.entryCount}</span></td>` +
          `<td class="n" style="color:${balColor}"><span class="num">${fmtSigned(p.balance)}</span></td>` +
          `<td>${dir}</td>` +
          `</tr>`
        );
      })
      .join("");
    tableHtml = `<table>
<thead><tr>
<th>${esc(tIn(locale, "export.col.person"))}</th>
<th>${esc(tIn(locale, "export.col.phone"))}</th>
<th class="n">${esc(tIn(locale, "export.col.entries"))}</th>
<th class="n">${esc(tIn(locale, "export.col.balance"))} (${sym})</th>
<th></th>
</tr></thead>
<tbody>${rows}</tbody>
</table>`;
  }

  const body = `
<header>
<div class="shop" dir="auto">${esc(report.vaultName)}</div>
<h1>${esc(tIn(locale, "export.doc.summaryTitle"))}</h1>
<div class="meta">${metaBits.join(" · ")}</div>
</header>
${totalsHtml}
${tableHtml}`;

  const html = htmlShell({
    locale,
    fontCss: await vazirmatnCss(),
    title: `${tIn(locale, "export.doc.summaryTitle")} — ${report.vaultName}`,
    body,
  });
  return printToTarget(html, fileName);
}
