const fs = require("fs");
const path = require("path");
const S = require("./gen-screens.js"); // reuse FONTS, CSS, and screen builders

// App Store iPhone 6.5" display screenshots: 1284x2778 portrait.
// Same marketing-panel design as the Play set (gen-screens.js), re-composed
// for the taller 9:19.5 canvas: the 1080-wide design is wrapped in a
// scale(1284/1080) fitter, the caption gets more air, and the phone mockup is
// scaled up so it grounds at the bottom edge like the Play panels.
//
// Render each HTML with headless Chrome at --window-size=1284,2778 (see
// render-iphone65 command in the repo docs / git history).

const OUT = path.join(__dirname, "iphone-6.5");

// iOS ordering: WhatsApp panel LAST — Apple review is stricter about
// third-party UI in screenshots (guideline 2.3.7), and only the first three
// screenshots surface on the install sheet. Drop 06 at upload time if in doubt.
const panels = [
  {
    n: 1,
    slug: "home",
    eyebrow: "YOUR SHOP LEDGER",
    head: 'Know who owes you,<br><span class="g">at a glance.</span>',
    screen: S.screenHome(),
  },
  {
    n: 2,
    slug: "person-detail",
    eyebrow: "EVERY CUSTOMER",
    head: 'One running balance,<br><span class="g">every deal logged.</span>',
    screen: S.screenPerson(),
  },
  {
    n: 3,
    slug: "add-entry",
    eyebrow: "FAST ENTRY",
    head: 'Gave or received?<br><span class="g">Logged in seconds.</span>',
    screen: S.screenEntry(),
  },
  {
    n: 4,
    slug: "onboarding",
    eyebrow: "GET STARTED",
    head: 'Your shop’s book,<br><span class="g">ready in a minute.</span>',
    screen: S.screenOnboarding(),
  },
  {
    n: 5,
    slug: "dari",
    eyebrow: "دری  •  OFFLINE",
    head: 'به زبان خودت.<br><span class="g">بدون انترنت.</span>',
    screen: S.screenHome({ rtl: true }),
    rtlCap: true,
  },
  {
    n: 6,
    slug: "whatsapp",
    eyebrow: "GET PAID",
    head: 'A polite nudge,<br><span class="g">on WhatsApp.</span>',
    screen: S.screenWhatsApp(),
  },
];

// 1284/1080 = 1.18889 exactly fills the width; inner design height
// 2778 / 1.18889 = 2336.6 -> 2337 (the last sub-pixel row is background).
const IOS_CSS = `
html,body{width:1284px;height:2778px;overflow:hidden;}
.fit{width:1080px;height:2337px;transform:scale(1.18889);transform-origin:top left;}
.panel{width:1080px;height:2337px;}
.cap{top:240px;}
.eyebrow{font-size:25px;}
.headline{font-size:84px;}
.phone{top:745px;transform:translateX(-50%) scale(1.17);transform-origin:top center;}
`;

function page(p) {
  return `<!doctype html><html><head><meta charset="utf-8"/><style>${S.CSS}${IOS_CSS}</style></head><body>
  <div class="fit"><div class="panel">
    <div class="cap${p.rtlCap ? " rtl" : ""}"><div class="eyebrow">${p.eyebrow}</div><div class="headline">${p.head}</div></div>
    <div class="phone"><div class="island"></div><div class="screen">${p.screen}</div></div>
  </div></div></body></html>`;
}

if (require.main === module) {
  fs.mkdirSync(OUT, { recursive: true });
  for (const p of panels) {
    const f = path.join(OUT, `${String(p.n).padStart(2, "0")}-${p.slug}.html`);
    fs.writeFileSync(f, page(p), "utf8");
    console.log("wrote", f);
  }
  console.log("done", panels.length, "panels");
}

module.exports = { panels };
