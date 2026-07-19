const fs = require("fs");
const path = require("path");
const S = require("./gen-screens.js"); // reuse FONTS + inline icon SVGs only

const OUT = __dirname;

// ACCURATE 10-inch tablet rendering.
// The app has NO tablet layout and NO content maxWidth, and is portrait-locked.
// On a ~800dp-wide 10" tablet (portrait) the single-column UI STRETCHES to full
// width at its TRUE dp sizes -> small text, wide sparse rows, lots of whitespace.
// Canvas = 800x1422 dp (9:16); rendered at device-scale-factor 2 -> 1600x2844 px.
// Every value below is the app's real dp value (from source), used 1:1 as CSS px.

const ic = S.ic;
const money = (n, afn, color) =>
  `<span class="num"${color ? ` style="color:${color}"` : ""}>${n}</span><span class="afn" style="font-size:${afn}px">؋</span>`;

const statusBar = (dark) => {
  const c = dark ? "#fff" : "#171717";
  return `<div class="sb" style="color:${c}">
    <span class="sb-t">9:41</span>
    <span class="sb-r">
      <svg viewBox="0 0 24 14" width="17" height="10" fill="${c}"><rect x="0" y="8" width="4" height="6" rx="1"/><rect x="6" y="5" width="4" height="9" rx="1"/><rect x="12" y="2.5" width="4" height="11.5" rx="1"/><rect x="18" y="0" width="4" height="14" rx="1"/></svg>
      <svg viewBox="0 0 24 18" width="15" height="11" fill="none" stroke="${c}" stroke-width="2" stroke-linecap="round"><path d="M2 6.5a15 15 0 0 1 20 0"/><path d="M5.5 10a10 10 0 0 1 13 0"/><path d="M9 13.5a5 5 0 0 1 6 0"/><circle cx="12" cy="16.5" r="1.1" fill="${c}" stroke="none"/></svg>
      <span class="bat" style="border-color:${c}"><span class="batf" style="background:${c}"></span></span>
    </span>
  </div>`;
};

function home(lang) {
  const rtl = lang === "fa";
  const t = rtl
    ? {
        shop: "مارکیت برادران",
        chip: "م",
        collect: "وصول",
        pay: "پرداخت",
        lbl: "قابل وصول",
        sub: "از ۴ نفر",
        rows: [
          ["احمد ولی", "۲ ساعت پیش", "12,500"],
          ["گل رحمان", "دیروز", "8,750"],
          ["فاطمه نوری", "۳ روز پیش", "3,200"],
          ["نصیر احمدزی", "۱ هفته پیش", "1,400"],
        ],
      }
    : {
        shop: "Baradaran Market",
        chip: "B",
        collect: "To collect",
        pay: "To pay",
        lbl: "TO COLLECT",
        sub: "from 4 people",
        rows: [
          ["Ahmad Wali", "2h ago", "12,500"],
          ["Gul Rahman", "yesterday", "8,750"],
          ["Fatima Noori", "3d ago", "3,200"],
          ["Naseer Ahmadzai", "1w ago", "1,400"],
        ],
      };
  const row = (r) =>
    `<div class="row"><div class="row-l"><div class="row-nm">${r[0]}</div><div class="row-sub">${r[1]}</div></div><div class="row-r">${money(r[2], 11)}</div></div>`;
  return `${statusBar()}
  <div class="hd"><span class="hd-shop">${t.shop}</span><span class="hd-chev">${ic.chevronDown(16)}</span><span class="hd-sp"></span><span class="hd-chip">${t.chip}</span></div>
  <div class="tabs"><div class="tab tab-on">${t.collect}</div><div class="tab tab-off">${t.pay}</div></div>
  <div class="total"><div class="total-l">${t.lbl}</div><div class="total-row">${money("25,850", 14, "#0C745A")}</div><div class="total-sub">${t.sub}</div></div>
  <div class="card">${t.rows.map(row).join('<div class="div"></div>')}</div>
  <div class="fab">${ic.plus(30)}</div>`;
}

function person() {
  const entry = (dir, amt, note, when) => {
    const gave = dir === "gave";
    return `<div class="erow"><div class="eic" style="background:${gave ? "#F8EAEC" : "#E8F4EF"};color:${gave ? "#A3203A" : "#0C745A"}">${gave ? ic.arrowUp(16) : ic.arrowDown(16)}</div>
      <div class="emid"><div class="etop"><div class="eamt">${money(amt, 11)}</div><div class="ewhen">${when}</div></div>${note ? `<div class="enote">${note}</div>` : ""}</div></div>`;
  };
  return `${statusBar()}
  <div class="nav"><div class="nav-b">${ic.chevronBack(22)}</div><div class="nav-b">${ic.pencil(20)}</div></div>
  <div class="info"><div class="pn">Ahmad Wali</div><div class="pph">+93 70 123 4567</div><div class="pchip">THEY OWE YOU</div><div class="pbal">${money("12,500", 15, "#0C745A")}</div></div>
  <div class="acts"><div class="act"><span class="coin">${ic.arrowDown(16)}</span><span>I received</span></div><div class="act"><span class="coin">${ic.arrowUp(16)}</span><span>I gave</span></div></div>
  <div class="ecard">${entry("received", "2,500", "", "2h ago")}<div class="div"></div>${entry("gave", "5,000", "Cooking oil &amp; rice", "yesterday")}<div class="div"></div>${entry("gave", "10,000", "Sacks of flour", "4d ago")}</div>
  <div class="ping"><div class="ping-b"><span style="display:flex">${ic.whatsapp(20)}</span><span>Ping Ahmad Wali on WhatsApp</span></div></div>`;
}

function onboarding() {
  return `${statusBar()}
  <div class="ob"><div class="ob-c">${ic.check(54)}</div><div class="ob-t">Your kaata is ready!</div>
    <div class="ob-card"><span style="color:#171717;display:flex">${ic.storefront(24)}</span><span class="ob-shop">Baradaran Market</span></div>
    <div class="ob-body">This is your shop's book. Add a tally<br>for each customer with the + button.</div></div>
  <div class="ob-foot"><div class="ob-btn">Open my kaata</div></div>`;
}

const CSS = `
${S.FONTS}
*{margin:0;padding:0;box-sizing:border-box;}
.t10{position:relative;overflow:hidden;background:#fff;font-family:"Vaz",sans-serif;-webkit-font-smoothing:antialiased;}
.num{font-family:"Mono";}
.afn{font-family:"Vaz";font-weight:500;color:#A3A3A3;margin-left:3px;}
.sb{height:34px;display:flex;align-items:center;justify-content:space-between;padding:10px 22px 0;font-family:"Mono";}
.sb-t{font-weight:600;font-size:14px;}
.sb-r{display:flex;align-items:center;gap:6px;}
.bat{width:22px;height:11px;border:1.5px solid;border-radius:3px;padding:1.5px;display:flex;opacity:.9;}
.batf{flex:1;border-radius:1px;}
/* HOME */
.hd{display:flex;align-items:center;padding:18px 16px 14px;}
.hd-shop{font-weight:700;font-size:28px;color:#171717;letter-spacing:-.5px;white-space:nowrap;}
.hd-chev{color:#737373;margin-left:4px;margin-top:3px;display:flex;}
.hd-sp{flex:1;}
.hd-chip{width:32px;height:32px;border-radius:16px;background:#FAFAFA;border:1px solid #EDEDED;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:14px;color:#171717;flex:none;}
.tabs{margin:2px 16px 16px;display:flex;padding:4px;background:#FAFAFA;border:1px solid #E5E5E5;border-radius:10px;}
.tab{flex:1;min-height:44px;display:flex;align-items:center;justify-content:center;border-radius:7px;font-size:13px;}
.tab-on{background:#171717;color:#fff;font-weight:600;}
.tab-off{color:#404040;font-weight:500;}
.total{margin:0 16px 20px;}
.total-l{font-weight:600;font-size:11px;letter-spacing:.6px;color:#737373;text-transform:uppercase;}
.total-row{display:flex;align-items:baseline;gap:6px;margin-top:6px;}
.total-row .num{font-weight:700;font-size:36px;letter-spacing:-.5px;}
.total-row .afn{font-size:14px;}
.total-sub{font-weight:400;font-size:13px;color:#737373;margin-top:4px;}
.card{margin:0 16px;border:1px solid #E5E5E5;border-radius:12px;overflow:hidden;}
.div{height:1px;background:#E5E5E5;}
.row{display:flex;align-items:center;padding:12px 14px;}
.row-l{flex:1;margin-right:12px;min-width:0;}
.row-nm{font-weight:600;font-size:15px;color:#171717;}
.row-sub{font-weight:400;font-size:12px;color:#737373;margin-top:2px;}
.row-r{display:flex;align-items:baseline;}
.row-r .num{font-weight:600;font-size:15px;color:#171717;}
.row-r .afn{font-size:11px;}
.fab{position:absolute;right:20px;bottom:20px;width:52px;height:52px;border-radius:26px;background:#171717;color:#fff;display:flex;align-items:center;justify-content:center;}
/* PERSON */
.nav{display:flex;align-items:center;justify-content:space-between;padding:4px 8px;}
.nav-b{width:40px;height:40px;display:flex;align-items:center;justify-content:center;color:#171717;}
.info{padding:4px 16px 20px;}
.pn{font-weight:700;font-size:22px;color:#171717;}
.pph{font-family:"Mono";font-size:13px;color:#737373;margin-top:4px;}
.pchip{display:inline-block;margin-top:16px;padding:3px 8px;border-radius:6px;font-weight:600;font-size:10px;letter-spacing:.6px;background:#E8F4EF;color:#0A5A46;}
.pbal{display:flex;align-items:baseline;gap:6px;margin-top:10px;}
.pbal .num{font-weight:700;font-size:40px;letter-spacing:-.5px;}
.pbal .afn{font-size:15px;}
.acts{display:flex;gap:10px;padding:0 16px;margin-bottom:20px;}
.act{flex:1;display:flex;align-items:center;justify-content:center;gap:9px;padding:13px 0;border-radius:12px;background:#171717;color:#fff;font-weight:600;font-size:15px;box-shadow:0 5px 14px rgba(0,0,0,.16);}
.coin{width:26px;height:26px;border-radius:13px;background:rgba(255,255,255,.13);display:flex;align-items:center;justify-content:center;}
.ecard{margin:8px 16px 0;border:1px solid #E5E5E5;border-radius:12px;overflow:hidden;}
.erow{display:flex;align-items:flex-start;padding:12px 14px;}
.eic{width:32px;height:32px;border-radius:8px;display:flex;align-items:center;justify-content:center;margin-right:12px;flex:none;}
.emid{flex:1;min-width:0;}
.etop{display:flex;align-items:baseline;justify-content:space-between;}
.eamt{display:flex;align-items:baseline;}
.eamt .num{font-weight:700;font-size:15px;color:#171717;}
.eamt .afn{font-size:11px;}
.ewhen{font-weight:400;font-size:12px;color:#737373;}
.enote{font-weight:400;font-size:13px;color:#404040;line-height:18px;margin-top:5px;}
.ping{position:absolute;left:0;right:0;bottom:0;padding:12px 16px 20px;}
.ping-b{height:52px;border-radius:12px;background:#171717;color:#fff;display:flex;align-items:center;justify-content:center;gap:10px;font-weight:600;font-size:15px;box-shadow:0 4px 12px rgba(0,0,0,.18);}
/* ONBOARDING */
.ob{position:absolute;top:0;left:0;right:0;bottom:76px;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:0 24px;}
.ob-c{width:96px;height:96px;border-radius:48px;background:#0C745A;display:flex;align-items:center;justify-content:center;color:#fff;margin-bottom:28px;}
.ob-t{font-weight:700;font-size:24px;color:#171717;letter-spacing:-.4px;text-align:center;}
.ob-card{display:flex;align-items:center;gap:12px;margin-top:20px;padding:16px 20px;border:1px solid #E5E5E5;border-radius:14px;background:#FAFAFA;}
.ob-shop{font-weight:600;font-size:18px;color:#171717;}
.ob-body{font-weight:400;font-size:14px;line-height:21px;color:#737373;text-align:center;margin-top:20px;}
.ob-foot{position:absolute;left:0;right:0;bottom:0;padding:0 24px 16px;}
.ob-btn{min-height:44px;border-radius:8px;background:#171717;color:#fff;display:flex;align-items:center;justify-content:center;font-weight:600;font-size:15px;}
`;

const panels = [
  { name: "home", screen: home("en") },
  { name: "person", screen: person() },
  { name: "onboarding", screen: onboarding() },
  { name: "dari", screen: home("fa") },
];

// Reused by gen-ipad13.js — same true-dp screens, different canvas.
module.exports = { CSS, home, person, onboarding, statusBar, panels };

if (require.main === module) {
  // Real portrait dp widths: 7" tablet ~600dp, 10" tablet ~800dp. Height = 9:16.
  const sizes = [
    { tag: "7in", w: 600, h: 1067 },
    { tag: "10in", w: 800, h: 1422 },
  ];

  for (const s of sizes) {
    for (const p of panels) {
      const html = `<!doctype html><html><head><meta charset="utf-8"/><style>${CSS}
html,body,.t10{width:${s.w}px;height:${s.h}px;}</style></head><body><div class="t10">${p.screen}</div></body></html>`;
      fs.writeFileSync(path.join(OUT, `tab-${s.tag}-${p.name}.html`), html, "utf8");
    }
    console.log("wrote", s.tag, "(" + s.w + "x" + s.h + " dp)");
  }
  console.log("done", sizes.length * panels.length, "files");
}
