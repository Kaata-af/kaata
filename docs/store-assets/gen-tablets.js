const fs = require("fs");
const path = require("path");
const S = require("./gen-screens.js"); // reuse FONTS, CSS, and the phone-screen builders

const OUT = __dirname;

// Landscape tablet stage (16:9). Reuses the phone-frame + app-screen CSS from
// gen-screens.js verbatim; only the outer panel/caption + phone POSITIONING is
// redefined here (later rules win over the imported .phone positioning).
const TCSS = `
.tpanel{width:2560px;height:1440px;position:relative;overflow:hidden;font-family:"Vaz",sans-serif;
  background:radial-gradient(120% 130% at 14% 8%, #1f1f1f 0%, #0d0d0d 48%, #000 86%);
  -webkit-font-smoothing:antialiased;display:flex;align-items:center;}
.tgrain{position:absolute;inset:0;background-image:repeating-linear-gradient(to bottom, rgba(255,255,255,.016) 0 1px, transparent 1px 60px);
  -webkit-mask-image:linear-gradient(to right,#000,transparent 55%);mask-image:linear-gradient(to right,#000,transparent 55%);}
.tcap{width:1060px;flex:none;padding-left:150px;position:relative;z-index:5;}
.teyebrow{font-family:"Mono",monospace;font-weight:600;font-size:32px;letter-spacing:7px;color:#14B981;text-transform:uppercase;}
.thead{margin-top:34px;font-weight:800;font-size:108px;line-height:1.03;color:#fff;letter-spacing:-3px;text-wrap:balance;}
.thead .g{color:#14B981;}
.tsub{margin-top:44px;font-weight:500;font-size:35px;line-height:1.5;color:#9a9a9a;max-width:840px;}
.tcap.rtl{direction:rtl;padding-left:0;padding-right:150px;}

.tphones{flex:1;position:relative;height:100%;}
/* override imported .phone absolute positioning; keep its frame styling */
.tphones .phone{position:absolute;left:auto;top:auto;transform-origin:center center;}
.tphones .front{z-index:2;}
.tphones .back{z-index:1;}
`;

function phone(screenHtml, cls, style) {
  return `<div class="phone ${cls}" style="${style}"><div class="island"></div><div class="screen">${screenHtml}</div></div>`;
}

function tabletPage(p) {
  const phonesHtml = p.single
    ? phone(p.front, "front", "left:360px;top:70px;transform:rotate(-2deg) scale(0.9);")
    : phone(p.back, "back", "left:690px;top:24px;transform:rotate(6deg) scale(0.78);opacity:.94;filter:brightness(.96);") +
      phone(p.front, "front", "left:150px;top:78px;transform:rotate(-3deg) scale(0.9);");
  return `<!doctype html><html><head><meta charset="utf-8"/><style>${S.FONTS}\n${S.CSS}\n${TCSS}</style></head><body>
  <div class="tpanel">
    <div class="tgrain"></div>
    <div class="tcap${p.rtl ? " rtl" : ""}">
      <div class="teyebrow">${p.eyebrow}</div>
      <div class="thead">${p.head}</div>
      ${p.sub ? `<div class="tsub">${p.sub}</div>` : ""}
    </div>
    <div class="tphones">${phonesHtml}</div>
  </div></body></html>`;
}

const panels = [
  {
    n: 1, eyebrow: "YOUR SHOP LEDGER",
    head: 'Know who owes you,<br><span class="g">to the last afghani.</span>',
    sub: "Every customer’s running balance in one tidy book — no more torn paper khata under the counter.",
    front: S.screenHome(), back: S.screenPerson(),
  },
  {
    n: 2, eyebrow: "GET PAID",
    head: 'A polite nudge,<br><span class="g">on WhatsApp.</span>',
    sub: "Send a friendly reminder with the balance and a ledger link — in two taps, no awkward call.",
    front: S.screenWhatsApp(), back: S.screenHome(),
  },
  {
    n: 3, eyebrow: "FAST & SIMPLE",
    head: 'Set up in a minute,<br><span class="g">log in seconds.</span>',
    sub: "Name your shop, add a customer, record what they took or paid. Kaata does the math for you.",
    front: S.screenEntry(), back: S.screenOnboarding(),
  },
  {
    n: 4, rtl: true, eyebrow: "دری  •  OFFLINE",
    head: 'به زبان خودت.<br><span class="g">بدون انترنت.</span>',
    sub: "کاتای شما روی تلفن‌تان است — بدون انترنت کار می‌کند، به انگلیسی و دری.",
    front: S.screenHome({ rtl: true }), single: true,
  },
];

for (const p of panels) {
  const f = path.join(OUT, `tablet-${p.n}.html`);
  fs.writeFileSync(f, tabletPage(p), "utf8");
  console.log("wrote", f);
}
console.log("done", panels.length, "tablet panels");
