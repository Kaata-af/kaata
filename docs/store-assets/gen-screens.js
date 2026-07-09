const fs = require("fs");
const path = require("path");

const OUT = __dirname;
const GF = "file:///C:/Users/Matee/Desktop/Projects/Kaata/kaata/apps/mobile/node_modules/@expo-google-fonts";
const V = (w, f) => `@font-face{font-family:"Vaz";font-weight:${w};src:url("${GF}/vazirmatn/${f}/Vazirmatn_${f}.ttf");}`;
const M = (w, f) => `@font-face{font-family:"Mono";font-weight:${w};src:url("${GF}/jetbrains-mono/${f}/JetBrainsMono_${f}.ttf");}`;

const FONTS = [
  V(400, "400Regular"), V(500, "500Medium"), V(600, "600SemiBold"), V(700, "700Bold"), V(800, "800ExtraBold"),
  M(400, "400Regular"), M(500, "500Medium"), M(600, "600SemiBold"), M(700, "700Bold"), M(800, "800ExtraBold"),
].join("\n");

// ---- inline Ionicons-style SVGs (stroke = currentColor) ----
const svg = (inner, o = {}) =>
  `<svg viewBox="0 0 24 24" width="${o.w || 24}" height="${o.w || 24}" fill="${o.fill || "none"}" stroke="${o.fill ? "none" : "currentColor"}" stroke-width="${o.sw || 2}" stroke-linecap="round" stroke-linejoin="round" style="display:block">${inner}</svg>`;
const ic = {
  chevronDown: (w) => svg('<polyline points="6 9 12 15 18 9"/>', { w, sw: 2.2 }),
  chevronBack: (w) => svg('<polyline points="15 6 9 12 15 18"/>', { w, sw: 2.4 }),
  plus: (w) => svg('<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>', { w, sw: 2.4 }),
  pencil: (w) => svg('<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z"/>', { w, sw: 2 }),
  arrowUp: (w) => svg('<line x1="12" y1="19" x2="12" y2="6"/><polyline points="6 12 12 6 18 12"/>', { w, sw: 2.4 }),
  arrowDown: (w) => svg('<line x1="12" y1="5" x2="12" y2="18"/><polyline points="6 12 12 18 18 12"/>', { w, sw: 2.4 }),
  storefront: (w) => svg('<path d="M3 9l1.6-5h14.8L21 9"/><path d="M4.5 9v11h15V9"/><path d="M9.5 20v-6h5v6"/><path d="M3 9a2.4 2.4 0 0 0 4.5 0 2.4 2.4 0 0 0 4.5 0 2.4 2.4 0 0 0 4.5 0 2.4 2.4 0 0 0 4.5 0"/>', { w, sw: 1.7 }),
  check: (w) => svg('<polyline points="4 12.5 9.5 18 20 6.5"/>', { w, sw: 3, }),
  whatsapp: (w) => `<svg viewBox="0 0 24 24" width="${w}" height="${w}" fill="currentColor" style="display:block"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51l-.57-.01c-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.71.306 1.263.489 1.694.625.712.227 1.36.195 1.872.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.885-9.885 9.885M20.52 3.449C18.24 1.245 15.24 0 12.045 0 5.463 0 .104 5.334.101 11.892c0 2.096.549 4.14 1.595 5.945L0 24l6.335-1.652a12.062 12.062 0 005.71 1.454h.005c6.585 0 11.946-5.335 11.949-11.893a11.821 11.821 0 00-3.479-8.46"/></svg>`,
  send: (w) => svg('<line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/>', { w, sw: 2 }),
};

// ---- status bar (iOS-ish), color adapts ----
const statusBar = (dark = false) => {
  const c = dark ? "#fff" : "#171717";
  return `<div class="sbar" style="color:${c}">
    <span class="sb-time">9:41</span>
    <span class="sb-right">
      <svg viewBox="0 0 24 14" width="30" height="17" fill="${c}"><rect x="0" y="8" width="4" height="6" rx="1"/><rect x="6" y="5" width="4" height="9" rx="1"/><rect x="12" y="2.5" width="4" height="11.5" rx="1"/><rect x="18" y="0" width="4" height="14" rx="1"/></svg>
      <svg viewBox="0 0 24 18" width="26" height="19" fill="none" stroke="${c}" stroke-width="2" stroke-linecap="round"><path d="M2 6.5a15 15 0 0 1 20 0"/><path d="M5.5 10a10 10 0 0 1 13 0"/><path d="M9 13.5a5 5 0 0 1 6 0"/><circle cx="12" cy="16.5" r="1.1" fill="${c}" stroke="none"/></svg>
      <span class="sb-bat"><span class="sb-batbody" style="border-color:${c}"><span class="sb-batfill" style="background:${c}"></span></span><span class="sb-batnub" style="background:${c}"></span></span>
    </span>
  </div>`;
};

// ---- money helper ----
const money = (n, symSize) => `<span class="num">${n}</span><span class="afn"${symSize ? ` style="font-size:${symSize}px"` : ""}>؋</span>`;

// =================== SCREENS ===================

// avatar-less person row
const pRow = (name, sub, amt) => `<div class="prow"><div class="pleft"><div class="pname">${name}</div><div class="psub">${sub}</div></div><div class="pamt">${money(amt, 22)}</div></div>`;

function screenHome(opts = {}) {
  const rtl = opts.rtl;
  const t = rtl
    ? { shop: "مارکیت برادران", collect: "وصول", pay: "پرداخت", label: "قابل وصول", sub: "از ۴ نفر",
        rows: [["احمد ولی", "۲ ساعت پیش", "12,500"], ["گل رحمان", "دیروز", "8,750"], ["فاطمه نوری", "۳ روز پیش", "3,200"], ["نصیر احمدزی", "۱ هفته پیش", "1,400"]] }
    : { shop: "Baradaran Market", collect: "To collect", pay: "To pay", label: "TO COLLECT", sub: "from 4 people",
        rows: [["Ahmad Wali", "2h ago", "12,500"], ["Gul Rahman", "yesterday", "8,750"], ["Fatima Noori", "3d ago", "3,200"], ["Naseer Ahmadzai", "1w ago", "1,400"]] };
  // App is LTR-locked even in Dari (I18nManager.forceRTL(false)) — layout does
  // NOT flip; only the strings change. Keep the English geometry verbatim.
  // Profile initial matches the visible shop name's first letter: "B" for
  // "Baradaran Market", "م" for "مارکیت برادران".
  const chip = rtl ? "م" : "B";
  return `${statusBar()}
  <div class="hdr">
    <div class="hdr-l"><span class="shop">${t.shop}</span><span class="chev">${ic.chevronDown(30)}</span></div>
    <div class="pchip">${chip}</div>
  </div>
  <div class="tabs"><div class="tab tab-on">${t.collect}</div><div class="tab tab-off">${t.pay}</div></div>
  <div class="total">
    <div class="total-lbl">${t.label}</div>
    <div class="total-row">${money('<span style="color:#0C745A">25,850</span>', 32)}</div>
    <div class="total-sub">${t.sub}</div>
  </div>
  <div class="card">${t.rows.map((r) => pRow(r[0], r[1], r[2])).join('<div class="div"></div>')}</div>
  <div class="fab">${ic.plus(56)}</div>`;
}

function screenPerson() {
  const entry = (dir, amt, note, when) => {
    const gave = dir === "gave";
    const bg = gave ? "#F8EAEC" : "#E8F4EF";
    const col = gave ? "#A3203A" : "#0C745A";
    const arrow = gave ? ic.arrowUp(28) : ic.arrowDown(28);
    return `<div class="erow">
      <div class="eicon" style="background:${bg};color:${col}">${arrow}</div>
      <div class="emid">
        <div class="etop"><div class="eamt">${money(amt, 20)}</div><div class="ewhen">${when}</div></div>
        ${note ? `<div class="enote">${note}</div>` : ""}
      </div></div>`;
  };
  return `${statusBar()}
  <div class="nav"><div class="navbtn">${ic.chevronBack(38)}</div><div class="navbtn">${ic.pencil(34)}</div></div>
  <div class="pinfo">
    <div class="pd-name">Ahmad Wali</div>
    <div class="pd-phone">+93 70 123 4567</div>
    <div class="pd-chip chip-collect">THEY OWE YOU</div>
    <div class="pd-bal">${money('<span style="color:#0C745A">12,500</span>', 30)}</div>
  </div>
  <div class="actions">
    <div class="actbtn"><span class="coin">${ic.arrowDown(30)}</span><span>I received</span></div>
    <div class="actbtn"><span class="coin">${ic.arrowUp(30)}</span><span>I gave</span></div>
  </div>
  <div class="ecard">
    ${entry("received", "2,500", "", "2h ago")}<div class="div"></div>
    ${entry("gave", "5,000", "Cooking oil &amp; rice", "yesterday")}<div class="div"></div>
    ${entry("gave", "10,000", "Sacks of flour", "4d ago")}
  </div>
  <div class="pingbar"><div class="ping"><span class="wa">${ic.whatsapp(34)}</span><span>Ping Ahmad Wali on WhatsApp</span></div></div>`;
}

function screenEntry() {
  const key = (t, sub) => `<div class="key"><span class="kd">${t}</span>${sub ? `<span class="ks">${sub}</span>` : ""}</div>`;
  return `${statusBar()}
  <div class="ehdr"><span class="ehdr-cancel">Cancel</span><span class="ehdr-title">I gave</span><span class="ehdr-sp"></span></div>
  <div class="ebody">
    <div class="ectx"><div class="ectx-lbl">TO</div><div class="ectx-name">Ahmad Wali</div></div>
    <div class="fld">
      <div class="flbl">Amount (؋) <span class="req">*</span></div>
      <div class="amtbox"><span class="amtnum">5000</span><span class="caret"></span></div>
    </div>
    <div class="fld">
      <div class="flbl">Note</div>
      <div class="notebox">Cooking oil &amp; rice</div>
    </div>
    <div class="savebtn">Save</div>
  </div>
  <div class="keypad">
    ${key("1","")}${key("2","ABC")}${key("3","DEF")}
    ${key("4","GHI")}${key("5","JKL")}${key("6","MNO")}
    ${key("7","PQRS")}${key("8","TUV")}${key("9","WXYZ")}
    <div class="key key-blank"></div>${key("0","")}<div class="key key-del">⌫</div>
  </div>`;
}

function screenOnboarding() {
  return `${statusBar()}
  <div class="ob">
    <div class="ob-check">${ic.check(64)}</div>
    <div class="ob-title">Your kaata is ready!</div>
    <div class="ob-card"><span class="ob-store">${ic.storefront(40)}</span><span class="ob-shop">Baradaran Market</span></div>
    <div class="ob-body">This is your shop's book. Add a tally<br>for each customer with the + button.</div>
  </div>
  <div class="ob-foot"><div class="savebtn">Open my kaata</div></div>`;
}

function screenWhatsApp() {
  const msg = `Salaam Ahmad Wali.

Your kaata at Baradaran Market:
🔴 You owe: −12,500 ؋

Please settle when you can.

See the full ledger here:
https://kaata.af/v/AbC123`;
  const lines = msg.split("\n").map((l) => l === "" ? '<div class="wa-sp"></div>' :
    l.startsWith("🔴") ? `<div class="wa-owe">${l}</div>` :
    l.startsWith("https") ? `<div class="wa-link">${l}</div>` : `<div>${l}</div>`).join("");
  return `<div class="wa-screen">
    ${statusBar(true)}
    <div class="wa-hdr">
      <span class="wa-back">${ic.chevronBack(34)}</span>
      <span class="wa-av">A</span>
      <span class="wa-who"><span class="wa-name">Ahmad Wali</span><span class="wa-seen">online</span></span>
    </div>
    <div class="wa-body">
      <div class="wa-day">TODAY</div>
      <div class="wa-bubble">${lines}<span class="wa-meta">9:41 AM <span class="wa-ticks">✓✓</span></span></div>
    </div>
    <div class="wa-input"><div class="wa-field">Message</div><div class="wa-send">${ic.send(26)}</div></div>
  </div>`;
}

// =================== PANELS ===================
const panels = [
  { n: 1, eyebrow: "YOUR SHOP LEDGER", head: 'Know who owes you,<br><span class="g">at a glance.</span>', screen: screenHome() },
  { n: 2, eyebrow: "GET PAID", head: 'A polite nudge,<br><span class="g">on WhatsApp.</span>', screen: screenWhatsApp(), noPad: true },
  { n: 3, eyebrow: "EVERY CUSTOMER", head: 'One running balance,<br><span class="g">every deal logged.</span>', screen: screenPerson() },
  { n: 4, eyebrow: "FAST ENTRY", head: 'Gave or received?<br><span class="g">Logged in seconds.</span>', screen: screenEntry() },
  { n: 5, eyebrow: "GET STARTED", head: 'Your shop’s book,<br><span class="g">ready in a minute.</span>', screen: screenOnboarding() },
  { n: 6, eyebrow: "دری  •  OFFLINE", head: 'به زبان خودت.<br><span class="g">بدون انترنت.</span>', screen: screenHome({ rtl: true }), rtlCap: true },
];

const CSS = `
${FONTS}
*{margin:0;padding:0;box-sizing:border-box;}
html,body{width:1080px;height:1920px;}
.panel{width:1080px;height:1920px;position:relative;overflow:hidden;font-family:"Vaz",sans-serif;
  background:radial-gradient(130% 90% at 50% -12%, #1f1f1f 0%, #0d0d0d 46%, #000 84%);
  -webkit-font-smoothing:antialiased;}
.cap{position:absolute;top:96px;left:0;right:0;padding:0 96px;text-align:center;}
.eyebrow{font-family:"Mono",monospace;font-weight:600;font-size:23px;letter-spacing:5px;color:#14B981;text-transform:uppercase;}
.headline{margin-top:22px;font-weight:800;font-size:72px;line-height:1.05;color:#fff;letter-spacing:-2px;text-wrap:balance;}
.headline .g{color:#14B981;}
.cap.rtl .headline{direction:rtl;letter-spacing:-1px;}

/* phone frame */
.phone{position:absolute;left:50%;transform:translateX(-50%);top:566px;width:660px;height:1400px;
  background:#0b0b0b;border-radius:74px;padding:15px;
  box-shadow:0 60px 130px rgba(0,0,0,.6), inset 0 0 0 2px #2a2a2a, 0 0 0 1px #000;}
.screen{position:relative;width:100%;height:100%;background:#FFFFFF;border-radius:60px;overflow:hidden;}
.island{position:absolute;top:20px;left:50%;transform:translateX(-50%);width:150px;height:33px;background:#000;border-radius:20px;z-index:20;}

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
.afn{font-family:"Vaz";font-weight:500;color:#A3A3A3;font-size:22px;margin-left:6px;}

/* ---------- HOME ---------- */
.hdr{display:flex;align-items:center;justify-content:space-between;padding:26px 30px 12px;}
.hdr-l{display:flex;align-items:center;gap:6px;min-width:0;}
.shop{font-family:"Vaz";font-weight:700;font-size:44px;color:#171717;letter-spacing:-1px;white-space:nowrap;}
.chev{color:#737373;display:flex;margin-top:6px;}
.pchip{width:58px;height:58px;border-radius:999px;background:#FAFAFA;border:1px solid #EDEDED;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:26px;color:#171717;flex:none;}
.tabs{display:flex;gap:0;margin:6px 30px 0;background:#FAFAFA;border:1px solid #E5E5E5;border-radius:18px;padding:7px;}
.tab{flex:1;text-align:center;padding:20px 0;border-radius:12px;font-weight:600;font-size:26px;}
.tab-on{background:#171717;color:#fff;}
.tab-off{color:#404040;font-weight:500;}
.total{padding:30px 30px 22px;}
.total-lbl{font-weight:600;font-size:20px;letter-spacing:1.2px;color:#737373;text-transform:uppercase;}
.total-row{display:flex;align-items:center;margin-top:10px;}
.total-row .num{font-weight:700;font-size:66px;letter-spacing:-2px;}
.total-row .afn{font-size:38px;margin-left:12px;position:relative;top:2px;}
.total-sub{margin-top:8px;font-size:24px;color:#737373;}
.card{margin:0 30px;border:1px solid #E5E5E5;border-radius:22px;overflow:hidden;background:#fff;}
.div{height:1px;background:#E5E5E5;}
.prow{display:flex;align-items:center;padding:24px 26px;}
.pleft{flex:1;min-width:0;}
.pname{font-weight:600;font-size:30px;color:#171717;}
.psub{font-size:22px;color:#737373;margin-top:3px;}
.pamt{display:flex;align-items:baseline;}
.pamt .num{font-weight:600;font-size:30px;color:#171717;}
.rtl .prow{flex-direction:row-reverse;}
.rtl .pleft{text-align:right;}
.fab{position:absolute;right:38px;bottom:44px;width:104px;height:104px;border-radius:999px;background:#171717;color:#fff;display:flex;align-items:center;justify-content:center;box-shadow:0 16px 40px rgba(0,0,0,.35);}

/* ---------- PERSON ---------- */
.nav{display:flex;align-items:center;justify-content:space-between;padding:6px 22px;}
.navbtn{width:72px;height:72px;display:flex;align-items:center;justify-content:center;color:#171717;}
.pinfo{padding:6px 32px 26px;}
.pd-name{font-weight:700;font-size:44px;color:#171717;}
.pd-phone{font-family:"Mono";font-size:24px;color:#737373;margin-top:6px;}
.pd-chip{display:inline-block;margin-top:22px;padding:7px 15px;border-radius:10px;font-weight:600;font-size:19px;letter-spacing:1px;}
.chip-collect{background:#E8F4EF;color:#0A5A46;}
.pd-bal{display:flex;align-items:center;margin-top:16px;}
.pd-bal .num{font-weight:700;font-size:78px;letter-spacing:-2px;}
.pd-bal .afn{font-size:44px;margin-left:12px;position:relative;top:2px;}
.actions{display:flex;gap:18px;padding:0 32px;margin-bottom:26px;}
.actbtn{flex:1;display:flex;align-items:center;justify-content:center;gap:14px;padding:24px 0;border-radius:20px;background:#171717;color:#fff;font-weight:600;font-size:27px;box-shadow:0 8px 22px rgba(0,0,0,.16);}
.coin{width:46px;height:46px;border-radius:999px;background:rgba(255,255,255,.13);display:flex;align-items:center;justify-content:center;}
.ecard{margin:0 32px;border:1px solid #E5E5E5;border-radius:22px;overflow:hidden;background:#fff;}
.erow{display:flex;align-items:flex-start;padding:24px 26px;}
.eicon{width:58px;height:58px;border-radius:14px;display:flex;align-items:center;justify-content:center;margin-right:22px;flex:none;}
.emid{flex:1;min-width:0;}
.etop{display:flex;align-items:baseline;justify-content:space-between;}
.eamt{display:flex;align-items:baseline;}
.eamt .num{font-weight:700;font-size:30px;color:#171717;}
.ewhen{font-size:22px;color:#737373;}
.enote{font-size:24px;color:#404040;margin-top:8px;}
.pingbar{position:absolute;left:0;right:0;bottom:0;padding:22px 32px 40px;}
.ping{height:96px;border-radius:22px;background:#171717;color:#fff;display:flex;align-items:center;justify-content:center;gap:18px;font-weight:600;font-size:28px;box-shadow:0 8px 22px rgba(0,0,0,.2);}
.wa{display:flex;}

/* ---------- ENTRY ---------- */
.ehdr{display:flex;align-items:center;justify-content:space-between;padding:24px 30px;border-bottom:1px solid #E5E5E5;}
.ehdr-cancel{font-size:27px;color:#737373;font-weight:500;min-width:110px;}
.ehdr-title{font-size:28px;font-weight:600;color:#171717;}
.ehdr-sp{min-width:110px;}
.ebody{padding:40px 30px 0;}
.ectx{margin-bottom:40px;}
.ectx-lbl{font-weight:600;font-size:20px;letter-spacing:1.2px;color:#737373;}
.ectx-name{font-weight:700;font-size:34px;color:#171717;margin-top:6px;}
.fld{margin-bottom:34px;}
.flbl{font-weight:500;font-size:24px;color:#404040;margin-bottom:14px;}
.req{color:#DC2626;}
.amtbox{min-height:120px;border:1px solid #E5E5E5;border-radius:22px;display:flex;align-items:center;justify-content:center;background:#fff;}
.amtnum{font-family:"Mono";font-weight:700;font-size:64px;color:#171717;}
.caret{width:3px;height:64px;background:#171717;margin-left:4px;opacity:.85;}
.notebox{min-height:80px;border:1px solid #E5E5E5;border-radius:16px;padding:0 26px;display:flex;align-items:center;font-size:27px;color:#171717;background:#fff;}
.savebtn{min-height:84px;border-radius:16px;background:#171717;color:#fff;display:flex;align-items:center;justify-content:center;font-weight:600;font-size:28px;margin-top:12px;}
.keypad{position:absolute;left:0;right:0;bottom:0;height:520px;background:#D6DAE0;display:grid;grid-template-columns:repeat(3,1fr);gap:2px;padding:14px 8px 44px;}
.key{background:#fff;border-radius:10px;display:flex;flex-direction:column;align-items:center;justify-content:center;font-family:"Vaz";}
.kd{font-weight:500;font-size:46px;color:#171717;line-height:1;}
.ks{font-size:15px;font-weight:600;letter-spacing:2px;color:#171717;margin-top:3px;}
.key-blank{background:transparent;}
.key-del{background:transparent;font-size:40px;color:#171717;}

/* ---------- ONBOARDING ---------- */
.ob{position:absolute;top:0;left:0;right:0;bottom:220px;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:0 60px;}
.ob-check{width:180px;height:180px;border-radius:999px;background:#0C745A;display:flex;align-items:center;justify-content:center;color:#fff;margin-bottom:50px;}
.ob-title{font-weight:700;font-size:48px;color:#171717;letter-spacing:-1px;text-align:center;}
.ob-card{display:flex;align-items:center;gap:20px;margin-top:38px;padding:28px 38px;border:1px solid #E5E5E5;border-radius:26px;background:#FAFAFA;}
.ob-store{color:#171717;display:flex;}
.ob-shop{font-weight:600;font-size:34px;color:#171717;}
.ob-body{margin-top:38px;font-size:27px;line-height:1.5;color:#737373;text-align:center;}
.ob-foot{position:absolute;left:0;right:0;bottom:0;padding:0 44px 56px;}

/* ---------- WHATSAPP ---------- */
.wa-screen{position:absolute;inset:0;background:#0B141A;display:flex;flex-direction:column;}
.wa-screen .sbar{color:#fff;}
.wa-hdr{background:#1F2C33;display:flex;align-items:center;gap:16px;padding:14px 26px 22px;}
.wa-back{color:#fff;display:flex;}
.wa-av{width:74px;height:74px;border-radius:999px;background:#0C745A;color:#fff;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:34px;}
.wa-who{display:flex;flex-direction:column;}
.wa-name{color:#fff;font-weight:600;font-size:32px;}
.wa-seen{color:#8FA1AC;font-size:22px;margin-top:2px;}
.wa-body{flex:1;padding:34px 30px;background-color:#0B141A;
  background-image:radial-gradient(rgba(255,255,255,.02) 1.5px, transparent 1.5px);background-size:34px 34px;
  display:flex;flex-direction:column;align-items:center;gap:26px;}
.wa-day{background:#182229;color:#8FA1AC;font-size:20px;font-weight:600;letter-spacing:1px;padding:8px 20px;border-radius:12px;}
.wa-bubble{align-self:flex-end;max-width:82%;background:#005C4B;color:#E9EDEF;border-radius:22px 22px 6px 22px;padding:22px 26px 30px;font-size:29px;line-height:1.5;position:relative;box-shadow:0 1px 2px rgba(0,0,0,.3);}
.wa-bubble .wa-sp{height:14px;}
.wa-owe{color:#fff;font-weight:600;font-family:"Mono";font-size:30px;}
.wa-link{color:#8FC9F5;word-break:break-all;}
.wa-meta{display:block;text-align:right;color:#8FB9AE;font-size:20px;margin-top:12px;margin-bottom:-10px;}
.wa-ticks{color:#53BDEB;margin-left:4px;}
.wa-input{display:flex;align-items:center;gap:16px;padding:20px 26px 40px;background:#0B141A;}
.wa-field{flex:1;background:#1F2C33;color:#8696A0;border-radius:30px;padding:24px 30px;font-size:26px;}
.wa-send{width:82px;height:82px;border-radius:999px;background:#00A884;color:#fff;display:flex;align-items:center;justify-content:center;flex:none;}
`;

function page(p) {
  return `<!doctype html><html><head><meta charset="utf-8"/><style>${CSS}</style></head><body>
  <div class="panel">
    <div class="cap${p.rtlCap ? " rtl" : ""}"><div class="eyebrow">${p.eyebrow}</div><div class="headline">${p.head}</div></div>
    <div class="phone"><div class="island"></div><div class="screen">${p.screen}</div></div>
  </div></body></html>`;
}

module.exports = { FONTS, CSS, statusBar, ic, money, screenHome, screenPerson, screenEntry, screenOnboarding, screenWhatsApp };

if (require.main === module) {
  for (const p of panels) {
    const f = path.join(OUT, `screenshot-${p.n}.html`);
    fs.writeFileSync(f, page(p), "utf8");
    console.log("wrote", f);
  }
  console.log("done", panels.length, "panels");
}
