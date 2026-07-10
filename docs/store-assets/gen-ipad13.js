const fs = require("fs");
const path = require("path");
const T = require("./gen-tablet10.js"); // true-dp screens + CSS (guarded export)

// App Store iPad 13" display screenshots: 2048x2732 portrait.
// Same ACCURATE full-bleed approach as the Play tablet set: the app has no
// tablet layout and is portrait-locked, so on a 12.9"/13" iPad the
// single-column UI stretches to full width at its TRUE dp sizes.
// iPad 12.9"/13" logical canvas = 1024x1366 pt; rendered with headless Chrome
// at --window-size=1024,1366 --force-device-scale-factor=2 -> 2048x2732 px.
//
// Render (Git Bash):
//   node gen-ipad13.js
//   BASE=".../docs/store-assets/ipad-13"
//   for n in 01-home 02-person 03-onboarding 04-dari; do
//     chrome --headless=new --disable-gpu --no-sandbox \
//       --allow-file-access-from-files --hide-scrollbars \
//       --force-device-scale-factor=2 --window-size=1024,1366 \
//       --screenshot="$BASE/$n.png" "file:///$BASE/$n.html"
//   done

const OUT = path.join(__dirname, "ipad-13");
const W = 1024;
const H = 1366;

const panels = [
  { n: 1, name: "home", screen: T.home("en") },
  { n: 2, name: "person", screen: T.person() },
  { n: 3, name: "onboarding", screen: T.onboarding() },
  { n: 4, name: "dari", screen: T.home("fa") },
];

if (require.main === module) {
  fs.mkdirSync(OUT, { recursive: true });
  for (const p of panels) {
    const html = `<!doctype html><html><head><meta charset="utf-8"/><style>${T.CSS}
html,body,.t10{width:${W}px;height:${H}px;}</style></head><body><div class="t10">${p.screen}</div></body></html>`;
    fs.writeFileSync(path.join(OUT, `${String(p.n).padStart(2, "0")}-${p.name}.html`), html, "utf8");
  }
  console.log("done", panels.length, "panels at", `${W}x${H} dp (@2x -> ${W * 2}x${H * 2})`);
}
