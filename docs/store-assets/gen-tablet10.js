const fs = require("fs");
const path = require("path");
const S = require("./gen-screens.js"); // the phone set's screens, palette and fonts

const { brand, app } = S;

// ACCURATE tablet rendering.
// The app has NO tablet layout and NO content maxWidth, and is portrait-locked.
// On a ~600-800dp-wide tablet (portrait) the single-column UI STRETCHES to full
// width at its TRUE dp sizes -> small text, wide sparse rows, lots of whitespace.
// These are the phone set's own screen builders (gen-screens.js) drawn at
// --k: 1, so every app dp value is 1 CSS px, rendered at device-scale-factor 2:
// 600x1067 dp -> 1200x2134 px (7"), 800x1422 dp -> 1600x2844 px (10").

const statusBar = (dark) => {
  const c = dark ? brand.white : "#000000";
  return `<div class="sb" style="color:${c}">
    <span class="sb-t">9:41</span>
    <span class="sb-r">
      <svg viewBox="0 0 24 14" width="17" height="10" fill="${c}"><rect x="0" y="8" width="4" height="6" rx="1"/><rect x="6" y="5" width="4" height="9" rx="1"/><rect x="12" y="2.5" width="4" height="11.5" rx="1"/><rect x="18" y="0" width="4" height="14" rx="1"/></svg>
      <svg viewBox="0 0 24 18" width="15" height="11" fill="none" stroke="${c}" stroke-width="2" stroke-linecap="round"><path d="M2 6.5a15 15 0 0 1 20 0"/><path d="M5.5 10a10 10 0 0 1 13 0"/><path d="M9 13.5a5 5 0 0 1 6 0"/><circle cx="12" cy="16.5" r="1.1" fill="${c}" stroke="none"/></svg>
      <span class="bat" style="border-color:${c}"><span class="batf" style="background:${c}"></span></span>
    </span>
  </div>`;
};

const home = (lang) => S.screenHome({ rtl: lang === "fa", bar: statusBar() });
const person = () => S.screenPerson({ bar: statusBar() });
const onboarding = () => S.screenOnboarding({ bar: statusBar() });

// --ib: Android tablets draw the app edge-to-edge above the navigation bar
// here, as in the earlier accurate set; gen-ipad13.js sets the iPad's inset.
const CSS = `${S.CSS}
.t10{--k:1;--ib:0px;--sbar:34px;position:relative;overflow:hidden;background:${app.bg};font-family:"Vaz",sans-serif;color:${app.textEmphasis};-webkit-font-smoothing:antialiased;}
.t10:has(.ob-screen){background:${app.bgWarm};}
.sb{height:34px;display:flex;align-items:center;justify-content:space-between;padding:10px 22px 0;font-family:"Mono";}
.sb-t{font-weight:600;font-size:14px;}
.sb-r{display:flex;align-items:center;gap:6px;}
.bat{width:22px;height:11px;border:1.5px solid;border-radius:3px;padding:1.5px;display:flex;opacity:.9;}
.batf{flex:1;border-radius:1px;}
`;

const panels = [
  { n: 1, name: "home", screen: home("en") },
  { n: 2, name: "person", screen: person() },
  { n: 3, name: "onboarding", screen: onboarding() },
  { n: 4, name: "dari", screen: home("fa") },
];

// Reused by gen-ipad13.js — same true-dp screens, different canvas.
module.exports = { CSS, home, person, onboarding, statusBar, panels };

// Writes tablet-screenshots/<7-inch|10-inch>/NN-<name>.html. Render each with
// headless Chrome at the dp window size and --force-device-scale-factor=2
// (plus --virtual-time-budget=4000) to the PNG of the same name.
if (require.main === module) {
  // Real portrait dp widths: 7" tablet ~600dp, 10" tablet ~800dp. Height = 9:16.
  const sizes = [
    { dir: "7-inch", w: 600, h: 1067 },
    { dir: "10-inch", w: 800, h: 1422 },
  ];

  for (const s of sizes) {
    const out = path.join(__dirname, "tablet-screenshots", s.dir);
    fs.mkdirSync(out, { recursive: true });
    for (const p of panels) {
      const html = `<!doctype html><html><head><meta charset="utf-8"/><style>${CSS}
html,body,.t10{width:${s.w}px;height:${s.h}px;}</style></head><body><div class="t10">${p.screen}</div></body></html>`;
      fs.writeFileSync(
        path.join(out, `${String(p.n).padStart(2, "0")}-${p.name}.html`),
        html,
        "utf8",
      );
    }
    console.log("wrote", s.dir, "(" + s.w + "x" + s.h + " dp)");
  }
  console.log("done", sizes.length * panels.length, "files");
}
