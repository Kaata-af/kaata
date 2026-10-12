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
// Render: see docs/store-listing.md (1024x1366 window, device-scale-factor 2).

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
    // --ib: the 20pt home-indicator inset of Face ID iPads.
    const html = `<!doctype html><html><head><meta charset="utf-8"/><style>${T.CSS}
html,body,.t10{width:${W}px;height:${H}px;}.t10{--ib:20px;}</style></head><body><div class="t10">${p.screen}</div></body></html>`;
    fs.writeFileSync(
      path.join(OUT, `${String(p.n).padStart(2, "0")}-${p.name}.html`),
      html,
      "utf8",
    );
  }
  console.log("done", panels.length, "panels at", `${W}x${H} dp (@2x -> ${W * 2}x${H * 2})`);
}
