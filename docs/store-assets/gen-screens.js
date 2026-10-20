const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");
const brand = require("../../apps/_shared/brand-palette.json");

// Shared drawing primitives for local store artwork, using installed app fonts
// and neutral UI tokens. These are manually composed previews with fictional
// data, not native device captures. Keep store-scenes.js aligned with app UI.
// The surrounding white/blue campaign lives in store-design.js; it deliberately
// does not change the product or the separate social/flyer palette.

// Mirror of apps/mobile/lib/colors.ts.
const app = {
  action: "#000000",
  entryActionGave: "#F6E4D5",
  entryActionGaveText: "#7D4923",
  entryActionGaveCoin: "#ECD0B7",
  entryActionReceived: "#E4EEE6",
  entryActionReceivedText: "#3E6149",
  entryActionReceivedCoin: "#CDDFD1",
  bg: "#FFFFFF",
  bgMuted: "#F7F7F7",
  bgSubtle: "#EFEFEF",
  bgWarm: brand.ivory,
  textEmphasis: "#171717",
  textDefault: "#292929",
  textSubtle: "#616161",
  textMuted: "#6B6B6B",
  borderSubtle: "#EFEFEF",
  borderDefault: "#E2E2E2",
  collectBg: "#E8F4EF",
  collectText: "#0A5A46",
  collectStrong: "#0C745A",
  payBg: "#F8EAEC",
  payStrong: "#A3203A",
  reviewPending: "#D29A00",
  sharedAccount: "#2563EB",
  danger: "#DC2626",
};

const OUT = __dirname;
const MOBILE_MODULES = path.resolve(__dirname, "../../apps/mobile/node_modules");
const fileUrl = (...parts) => pathToFileURL(path.join(MOBILE_MODULES, ...parts)).href;
const V = (w, f) =>
  `@font-face{font-family:"Vaz";font-weight:${w};src:url("${fileUrl("@expo-google-fonts/vazirmatn", f, `Vazirmatn_${f}.ttf`)}");}`;
const M = (w, f) =>
  `@font-face{font-family:"Mono";font-weight:${w};src:url("${fileUrl("@expo-google-fonts/jetbrains-mono", f, `JetBrainsMono_${f}.ttf`)}");}`;
const ICON_FONTS = "@expo/vector-icons/build/vendor/react-native-vector-icons";

const FONTS = [
  V(400, "400Regular"),
  V(500, "500Medium"),
  V(600, "600SemiBold"),
  V(700, "700Bold"),
  V(800, "800ExtraBold"),
  M(400, "400Regular"),
  M(500, "500Medium"),
  M(600, "600SemiBold"),
  M(700, "700Bold"),
  M(800, "800ExtraBold"),
  // The app's own icon fonts, so every glyph is the one the app draws.
  `@font-face{font-family:"Ion";src:url("${fileUrl(ICON_FONTS, "Fonts", "Ionicons.ttf")}");}`,
  `@font-face{font-family:"MI";src:url("${fileUrl(ICON_FONTS, "Fonts", "MaterialIcons.ttf")}");}`,
].join("\n");

const IONICONS = require(path.join(MOBILE_MODULES, ICON_FONTS, "glyphmaps/Ionicons.json"));
const MATERIAL = require(path.join(MOBILE_MODULES, ICON_FONTS, "glyphmaps/MaterialIcons.json"));
const glyph = (family, map, name, size, color) => {
  if (!(name in map)) throw new Error(`unknown icon ${name}`);
  const box = `calc(var(--k)*${size}px)`;
  return `<span class="glyph" style="font-family:${family};font-size:${box};width:${box};height:${box}${color ? `;color:${color}` : ""}">&#x${map[name].toString(16)};</span>`;
};
// Ionicons by name, sized in dp like the app's <Ionicons size>. Color defaults
// to the parent's.
const ion = (name, size, color) => glyph("Ion", IONICONS, name, size, color);
const material = (name, size, color) => glyph("MI", MATERIAL, name, size, color);

// Every app dp value from source is written as d(dp) = dp × --k px. Inside the
// phone frame --k is 1.6 (the 630px screen is a 393dp iPhone); the tablet sets
// render the same screens at --k: 1, true dp. --ib is the bottom safe-area
// inset in dp and --sbar the status bar height in px.
const d = (n) => `calc(var(--k)*${n}px)`;
// Bottom offsets that include the safe-area inset: d(n) + inset, in dp.
const dIb = (n) => `calc(var(--k)*(${n}px + var(--ib)))`;

// ---- status bar (iOS-ish) ----
const statusBar = (dark = false) => {
  const c = dark ? brand.white : "#000000";
  return `<div class="sbar" style="color:${c}">
    <span class="sb-time">9:41</span>
    <span class="sb-right">
      <svg viewBox="0 0 24 14" width="30" height="17" fill="${c}"><rect x="0" y="8" width="4" height="6" rx="1"/><rect x="6" y="5" width="4" height="9" rx="1"/><rect x="12" y="2.5" width="4" height="11.5" rx="1"/><rect x="18" y="0" width="4" height="14" rx="1"/></svg>
      <svg viewBox="0 0 24 18" width="26" height="19" fill="none" stroke="${c}" stroke-width="2" stroke-linecap="round"><path d="M2 6.5a15 15 0 0 1 20 0"/><path d="M5.5 10a10 10 0 0 1 13 0"/><path d="M9 13.5a5 5 0 0 1 6 0"/><circle cx="12" cy="16.5" r="1.1" fill="${c}" stroke="none"/></svg>
      <span class="sb-bat"><span class="sb-batbody" style="border-color:${c}"><span class="sb-batfill" style="background:${c}"></span></span><span class="sb-batnub" style="background:${c}"></span></span>
    </span>
  </div>`;
};

// ---- money helper: Latin digits in every language, ؋ after the number ----
const money = (n, cls = "") => `<span class="num ${cls}">${n}</span><span class="afn">؋</span>`;

const CSS = `
${FONTS}
*{margin:0;padding:0;box-sizing:border-box;}
html,body{width:1080px;height:1920px;}
.panel{width:1080px;height:1920px;position:relative;overflow:hidden;font-family:"Vaz",sans-serif;
  background:${brand.ivory};
  -webkit-font-smoothing:antialiased;}
.cap{position:absolute;top:96px;left:0;right:0;padding:0 96px;text-align:center;}
.eyebrow{font-family:"Mono",monospace;font-weight:600;font-size:23px;letter-spacing:5px;color:${brand.aubergine};text-transform:uppercase;}
.headline{margin-top:22px;font-weight:800;font-size:72px;line-height:1.05;color:${brand.aubergine};letter-spacing:-2px;text-wrap:balance;}
.headline .g{color:${brand.charcoal};padding:0 .1em;-webkit-box-decoration-break:clone;box-decoration-break:clone;
  background:linear-gradient(transparent 34%,${brand.saffron} 34%,${brand.saffron} 94%,transparent 94%);}
.cap.rtl .headline{direction:rtl;letter-spacing:-1px;}

/* phone frame */
.phone{position:absolute;left:50%;transform:translateX(-50%);top:566px;width:660px;height:1400px;
  background:#0b0b0b;border-radius:74px;padding:15px;
  box-shadow:0 60px 130px rgba(41,34,43,.45), inset 0 0 0 2px #2a2a2a, 0 0 0 1px #000;}
.screen{--k:1.6;--ib:34px;--sbar:78px;position:relative;width:100%;height:100%;background:${app.bg};border-radius:60px;overflow:hidden;font-family:"Vaz",sans-serif;color:${app.textEmphasis};}
.island{position:absolute;top:20px;left:50%;transform:translateX(-50%);width:150px;height:33px;background:#000;border-radius:20px;z-index:20;}
.screen:has(.ob-screen){background:${app.bgWarm};}
.home,.person,.entry,.ob-screen{position:absolute;inset:0;}

/* icon glyphs (Ionicons / MaterialIcons fonts) */
.glyph{display:inline-flex;align-items:center;justify-content:center;line-height:1;flex:none;font-style:normal;font-weight:normal;}

/* status bar */
.sbar{height:78px;display:flex;align-items:center;justify-content:space-between;padding:22px 46px 0;font-family:"Mono";}
.sb-time{font-weight:700;font-size:26px;}
.sb-right{display:flex;align-items:center;gap:9px;}
.sb-bat{display:flex;align-items:center;}
.sb-batbody{width:34px;height:17px;border:2px solid;border-radius:5px;padding:2px;display:flex;opacity:.9;}
.sb-batfill{flex:1;border-radius:2px;}
.sb-batnub{width:3px;height:7px;border-radius:0 2px 2px 0;margin-left:1px;opacity:.9;}

/* money */
.num{font-family:"Mono";}
.num.collect{color:${app.collectStrong};}
.afn{font-family:"Vaz";font-weight:500;color:${app.textMuted};}

/* ---------- HOME ---------- */
.hdr{display:flex;align-items:center;padding:${d(18)} ${d(16)} ${d(14)};}
.hdr-title{display:flex;align-items:center;gap:${d(4)};min-width:0;min-height:${d(40)};}
.hdr-title .glyph{margin-top:${d(3)};}
.shop{font-weight:700;font-size:${d(28)};line-height:${d(32)};color:${app.textEmphasis};white-space:nowrap;}
.hdr-sp{flex:1;}
.bell{width:${d(44)};height:${d(44)};display:flex;align-items:center;justify-content:center;}
.pchip{width:${d(36)};height:${d(36)};margin-left:${d(12)};border-radius:999px;background:${app.bgMuted};display:flex;align-items:center;justify-content:center;font-weight:700;font-size:${d(16)};color:${app.textEmphasis};flex:none;}
.tabs{display:flex;margin:${d(2)} ${d(16)} ${d(16)};padding:${d(4)};background:${app.bgMuted};border:${d(1)} solid ${app.borderDefault};border-radius:${d(8)};}
.tab{flex:1;min-height:${d(44)};display:flex;align-items:center;justify-content:center;border-radius:${d(8)};font-weight:500;font-size:${d(13)};color:${app.textDefault};}
.tab-on{background:${app.action};color:${app.bg};font-weight:600;}
.total{margin:0 ${d(16)} ${d(20)};}
.total-lbl{font-weight:600;font-size:${d(11)};letter-spacing:${d(0.6)};color:${app.textSubtle};text-transform:uppercase;}
.total-row{display:flex;align-items:baseline;gap:${d(6)};margin-top:${d(6)};}
.total-row .num{font-weight:700;font-size:${d(36)};letter-spacing:${d(-0.5)};line-height:1.2;}
.total-row .afn{font-size:${d(14)};}
.total-sub{margin-top:${d(4)};font-size:${d(13)};color:${app.textSubtle};}
.card{margin:0 ${d(16)};border:${d(1)} solid ${app.borderDefault};border-radius:${d(12)};overflow:hidden;background:${app.bg};}
.div{height:${d(1)};background:${app.borderDefault};}
.prow{display:flex;align-items:center;padding:${d(12)} ${d(14)};}
.pleft{flex:1;min-width:0;margin-right:${d(12)};}
.pname{font-weight:600;font-size:${d(15)};color:${app.textEmphasis};}
.psub{font-size:${d(12)};color:${app.textSubtle};margin-top:${d(2)};}
.pamt{display:flex;align-items:baseline;gap:${d(4)};}
.pamt .num{font-weight:600;font-size:${d(15)};color:${app.textEmphasis};}
.pamt .afn{font-size:${d(11)};}
.dock{position:absolute;left:${d(16)};right:${d(16)};bottom:${dIb(20)};display:flex;align-items:center;gap:${d(8)};}
.dock-opt{width:${d(44)};height:${d(52)};border-radius:${d(12)};border:${d(1)} solid ${app.borderDefault};background:${app.bg};display:flex;align-items:center;justify-content:center;flex:none;}
.dock-search{flex:1;min-width:0;height:${d(52)};border-radius:${d(12)};border:${d(1)} solid ${app.borderDefault};background:${app.bg};display:flex;align-items:center;gap:${d(8)};padding:0 ${d(8)};font-size:${d(14)};color:${app.textMuted};white-space:nowrap;}
.dock-search .ph{flex:1;min-width:0;}
.dock-add{width:${d(52)};height:${d(52)};border-radius:999px;background:${app.action};display:flex;align-items:center;justify-content:center;flex:none;}
/* Dari: rows mirror (rowDir/textDir); tabs and dock order stay LTR-locked. */
.rtl .hdr,.rtl .hdr-title,.rtl .total-row,.rtl .prow,.rtl .pamt,.rtl .dock-search{flex-direction:row-reverse;}
.rtl .pchip{margin-left:0;margin-right:${d(12)};}
.rtl .total,.rtl .pleft,.rtl .dock-search .ph{text-align:right;}
.rtl .pleft{margin-right:0;margin-left:${d(12)};}

/* ---------- PERSON ---------- */
.pnav{display:flex;align-items:center;justify-content:space-between;padding:${d(4)} ${d(8)};}
.navbtn{width:${d(40)};height:${d(40)};display:flex;align-items:center;justify-content:center;}
.pnav-actions{display:flex;align-items:center;gap:${d(2)};}
.navwa{min-width:${d(44)};height:${d(44)};margin-right:${d(8)};display:flex;align-items:center;justify-content:center;}
.navmore{min-width:${d(44)};height:${d(44)};display:flex;align-items:center;justify-content:center;}
.pinfo{padding:${d(4)} ${d(16)} ${d(20)};}
.pd-namerow{display:flex;align-items:center;gap:${d(7)};}
.pd-name{font-weight:700;font-size:${d(20)};color:${app.textEmphasis};}
.pd-phone{font-family:"Mono";font-size:${d(13)};color:${app.textSubtle};margin-top:${d(4)};}
.pd-overview{display:flex;align-items:center;gap:${d(18)};margin-top:${d(16)};}
.pd-balance{flex:1;min-width:0;}
.pd-chip{display:inline-block;padding:${d(3)} ${d(8)};border-radius:${d(8)};font-weight:600;font-size:${d(11)};line-height:${d(15)};letter-spacing:${d(0.6)};background:${app.collectBg};color:${app.collectText};}
.pd-bal{display:flex;align-items:baseline;gap:${d(6)};margin-top:${d(10)};}
.pd-bal .num{font-weight:700;font-size:${d(36)};letter-spacing:${d(-0.5)};line-height:1.2;}
.pd-bal .afn{font-size:${d(15)};}
.pd-flows{flex:1;min-width:0;display:flex;flex-direction:column;justify-content:center;gap:${d(8)};text-align:right;}
.flow-lbl{font-size:${d(11)};line-height:${d(16)};color:${app.textSubtle};}
.flow-amt{font-family:"Mono";font-weight:500;font-size:${d(16)};line-height:${d(21)};color:${app.textEmphasis};}
.ecard{margin:${d(8)} ${d(16)} 0;border:${d(1)} solid ${app.borderDefault};border-radius:${d(12)};overflow:hidden;background:${app.bg};}
.erow{display:flex;align-items:center;padding:${d(12)} ${d(14)};}
.etile{width:${d(32)};height:${d(32)};border-radius:${d(8)};display:flex;align-items:center;justify-content:center;margin-right:${d(12)};flex:none;}
.emid{flex:1;min-width:0;}
.etop{display:flex;align-items:center;justify-content:space-between;gap:${d(10)};}
.eamt{display:flex;align-items:baseline;gap:${d(4)};}
.eamt .num{font-weight:700;font-size:${d(15)};color:${app.textEmphasis};}
.eamt .afn{font-size:${d(11)};}
.emeta{display:flex;align-items:center;gap:${d(6)};}
.edot{width:${d(6)};height:${d(6)};border-radius:999px;background:${app.reviewPending};}
.ewhen{font-size:${d(12)};line-height:${d(17)};color:${app.textSubtle};}
.enote{margin-top:${d(5)};font-size:${d(13)};line-height:${d(18)};color:${app.textDefault};}
.pdock{position:absolute;left:0;right:0;bottom:0;display:flex;flex-direction:column;gap:${d(10)};padding:${d(12)} ${d(16)} ${dIb(20)};background:${app.bg};border-top:1px solid ${app.borderSubtle};}
.pdock-row{display:flex;gap:${d(10)};}
.abtn{flex:1;min-height:${d(54)};display:flex;align-items:center;justify-content:center;gap:${d(8)};padding:${d(13)} ${d(10)};border-radius:${d(12)};background:${app.action};color:${app.bg};font-weight:600;font-size:${d(15)};letter-spacing:${d(0.2)};box-shadow:0 ${d(5)} ${d(14)} rgba(0,0,0,.16);}
.coin{width:${d(26)};height:${d(26)};border-radius:999px;background:rgba(255,255,255,.13);display:flex;align-items:center;justify-content:center;}
.psearch{display:flex;align-items:center;gap:${d(8)};}
.psearch-box{flex:1;min-width:0;min-height:${d(44)};display:flex;align-items:center;gap:${d(8)};padding:0 ${d(12)};border:${d(1)} solid ${app.borderDefault};border-radius:${d(8)};font-size:${d(14)};color:${app.textSubtle};white-space:nowrap;}
.pdate{width:${d(44)};height:${d(44)};border:${d(1)} solid ${app.borderDefault};border-radius:${d(8)};display:flex;align-items:center;justify-content:center;flex:none;}

/* ---------- ENTRY ---------- */
.shdr{display:flex;align-items:center;min-height:${d(48)};padding:${d(8)};border-bottom:1px solid ${app.borderSubtle};}
.shdr-btn{width:${d(44)};height:${d(44)};display:flex;align-items:center;justify-content:center;flex:none;}
.shdr-title{flex:1;text-align:center;font-weight:600;font-size:${d(16)};color:${app.textEmphasis};}
.ebody{padding:${d(24)} ${d(16)} 0;}
.ectx{margin-bottom:${d(24)};}
.ectx-lbl{font-weight:600;font-size:${d(11)};letter-spacing:${d(0.6)};text-transform:uppercase;color:${app.textSubtle};}
.ectx-name{font-weight:700;font-size:${d(20)};color:${app.textEmphasis};margin-top:${d(4)};}
.fld{margin-bottom:${d(20)};}
.flbl{font-weight:500;font-size:${d(13)};color:${app.textDefault};margin-bottom:${d(8)};}
.req{color:${app.danger};}
.amtbox{min-height:${d(72)};border:${d(1)} solid ${app.borderDefault};border-radius:${d(12)};display:flex;align-items:center;justify-content:center;background:${app.bg};}
.amtnum{font-family:"Mono";font-weight:700;font-size:${d(36)};color:${app.textEmphasis};}
.caret{width:3px;height:${d(36)};background:${app.textEmphasis};margin-left:4px;opacity:.85;}
.notebox{min-height:${d(44)};border:${d(1)} solid ${app.borderDefault};border-radius:${d(8)};padding:0 ${d(14)};display:flex;align-items:center;font-size:${d(15)};color:${app.textEmphasis};background:${app.bg};}
.savebtn{min-height:${d(44)};margin-top:${d(4)};border-radius:${d(8)};background:${app.action};color:${app.bg};display:flex;align-items:center;justify-content:center;font-weight:600;font-size:${d(15)};}
.keypad{position:absolute;left:0;right:0;bottom:0;height:520px;background:#D6DAE0;display:grid;grid-template-columns:repeat(3,1fr);gap:2px;padding:14px 8px 44px;}
.key{background:#FFFFFF;border-radius:10px;display:flex;flex-direction:column;align-items:center;justify-content:center;font-family:"Vaz";color:#000;}
.kd{font-weight:500;font-size:46px;line-height:1;}
.ks{font-size:15px;font-weight:600;letter-spacing:2px;margin-top:3px;}
.key-fn{background:transparent;font-size:40px;}

/* ---------- ONBOARDING SUCCESS ---------- */
.ob{position:absolute;top:var(--sbar);left:0;right:0;bottom:${dIb(16 + 52 + 20)};display:flex;flex-direction:column;justify-content:center;padding:0 ${d(24)};}
.ob-check{width:${d(44)};height:${d(44)};border-radius:${d(12)};background:${brand.saffron};display:flex;align-items:center;justify-content:center;margin-bottom:${d(20)};}
.ob-title{font-weight:600;font-size:${d(20)};line-height:${d(26)};color:${brand.aubergine};}
.ob-card{display:flex;align-items:center;gap:${d(12)};margin-top:${d(20)};padding:${d(16)};border:1px solid ${app.borderDefault};border-radius:${d(12)};background:${app.bg};}
.ob-shop{flex:1;min-width:0;font-weight:600;font-size:${d(15)};color:${app.textEmphasis};}
.ob-body{margin-top:${d(16)};font-size:${d(14)};line-height:${d(20)};color:${app.textSubtle};}
.ob-foot{position:absolute;left:0;right:0;bottom:0;padding:${d(16)} ${d(24)} ${dIb(20)};}
.herobtn{min-height:${d(52)};border-radius:${d(12)};background:${app.action};color:${app.bg};display:flex;align-items:center;justify-content:center;font-weight:600;font-size:${d(15)};box-shadow:0 ${d(5)} ${d(14)} rgba(0,0,0,.16);}


`;

const scenes = require("./store-scenes.js").createScenes({ app, ion, material, money, statusBar });
module.exports = {
  FONTS,
  brand,
  app,
  CSS,
  statusBar,
  ion,
  material,
  money,
  ...scenes,
};

if (require.main === module) {
  const { generate } = require("./generate-store-assets.js");
  const files = generate({ only: ["play-phone"] });
  console.log(`Prepared ${files.length} Persian phone panels.`);
}
