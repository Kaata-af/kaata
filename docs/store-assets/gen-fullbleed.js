const fs = require("fs");
const path = require("path");
const S = require("./gen-screens.js"); // reuse the real app-screen builders + CSS

const OUT = __dirname;
// The app screen is authored at 630x1370 (the phone inner). A phone-only,
// single-column app on a tablet shows that same UI as a centered column.
// Scale it to fill a 9:16 tablet canvas by height; matching-bg side gutters
// read as normal tablet content-max-width padding.
const SCALE = 2732 / 1370;

function page(screen, bg) {
  // S.CSS already contains the @font-face block; don't duplicate it.
  return `<!doctype html><html><head><meta charset="utf-8"/><style>
${S.CSS}
html,body{width:1536px;height:2732px;margin:0;font-family:"Vaz",sans-serif;}
.canvas{width:1536px;height:2732px;background:${bg};font-family:"Vaz",sans-serif;display:flex;align-items:center;justify-content:center;overflow:hidden;}
.approot{width:630px;height:1370px;position:relative;overflow:hidden;background:${bg};
  transform:scale(${SCALE});transform-origin:center center;flex:none;}
</style></head><body><div class="canvas"><div class="approot">${screen}</div></div></body></html>`;
}

const panels = [
  { n: 1, bg: "#FFFFFF", screen: S.screenHome() },
  { n: 2, bg: "#FFFFFF", screen: S.screenPerson() },
  { n: 3, bg: "#FFFFFF", screen: S.screenEntry() },
  { n: 4, bg: "#FFFFFF", screen: S.screenOnboarding() },
  { n: 5, bg: "#FFFFFF", screen: S.screenHome({ rtl: true }) },
];

for (const p of panels) {
  fs.writeFileSync(path.join(OUT, `tab-full-${p.n}.html`), page(p.screen, p.bg), "utf8");
  console.log("wrote tab-full-" + p.n);
}
console.log("done", panels.length);
