const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");
const S = require("./gen-screens.js");
const { SCENE_CSS = "" } = require("./store-scenes.js");
const { palette: P, panels, formats } = require("./store-design.js");

const ROOT = __dirname;
const GENERATED = path.join(ROOT, ".generated");
const logo = pathToFileURL(path.resolve(ROOT, "../../apps/mobile/assets/icon.png")).href;

function documentPage(title, css, body) {
  return `<!doctype html><html lang="fa"><head><meta charset="utf-8"><title>${title}</title><style>${S.CSS}\n${SCENE_CSS}\n${css}</style></head><body>${body}</body></html>`;
}

const strip = '<div class="color-strip"><i></i><i></i><i></i></div>';
const wordmark = `<div class="brand-lockup" dir="rtl"><img src="${logo}" alt=""><span>کاتا.</span></div>`;

function page(panel, format) {
  const scale = format.width / 1080;
  const artHeight = format.height / scale;
  const compact = artHeight < 1700;
  const iphone = format.platform === "ios" && format.kind === "phone";
  const legacyIphone = format.id === "iphone-legacy";
  const tablet = format.kind === "tablet";
  const top = compact ? 370 : iphone ? 600 : 490;
  const deviceHeight = artHeight - top - 82;
  const bezel = tablet ? 13 : 9;
  const corner = tablet ? 30 : iphone ? 48 : 39;
  const k = (deviceHeight - bezel * 2) / format.dpHeight;
  const screenWidth = format.dpWidth * k;
  const deviceWidth = screenWidth + bezel * 2;
  const screen = S[panel.scene]({ platform: format.platform });
  const css = `
html,body{width:${format.width}px;height:${format.height}px;overflow:hidden;background:${P.white};}
.store-art{position:relative;width:1080px;height:${artHeight}px;overflow:hidden;background:${P.white};font-family:"Vaz",sans-serif;color:${P.ink};transform:scale(${scale});transform-origin:top left;-webkit-font-smoothing:antialiased;}
.campaign-top{position:absolute;top:${compact ? 44 : 58}px;left:72px;right:72px;display:flex;align-items:center;justify-content:space-between;direction:rtl;}
.brand-lockup{display:flex;align-items:center;gap:14px;font-size:42px;font-weight:800;white-space:nowrap;}
.brand-lockup img{width:54px;height:54px;border-radius:14px;}
.campaign-label{font-size:24px;font-weight:500;color:${P.muted};}
.campaign-copy{position:absolute;top:${compact ? 135 : iphone ? 205 : 155}px;left:60px;right:60px;text-align:center;direction:rtl;}
.campaign-copy h1{font-size:${compact ? 58 : 72}px;line-height:1.5;font-weight:700;letter-spacing:0;}
.campaign-copy em{color:${P.blue};font-style:normal;}
.campaign-copy p{font-size:${compact ? 24 : 27}px;line-height:1.75;margin-top:${compact ? 12 : 20}px;color:${P.muted};}
.store-device{position:absolute;top:${top}px;left:50%;transform:translateX(-50%);width:${deviceWidth}px;height:${deviceHeight}px;padding:${bezel}px;border-radius:${corner}px;background:linear-gradient(112deg,#8e9297,#c5c8cb 13%,#777d84 36%,#a2a6ac 83%,#676c73);box-shadow:0 1px 2px #17212e35,0 20px 32px -15px #17212e28,0 43px 68px -38px #17212e37,inset 0 0 0 1px #686d74;}
.store-device.android{background:linear-gradient(112deg,#474d55,#9399a1 14%,#4d535a 33%,#7e858d 83%,#353a41);}
.store-device::before{content:"";position:absolute;inset:3px;border-radius:${corner - 3}px;background:#111317;box-shadow:0 0 0 1px #23262b65,inset 0 1px 1px #fff2;}
.device-key{position:absolute;display:block;width:3px;border-radius:2px;background:linear-gradient(90deg,#5c626a,#a4aab1 56%,#565b63);box-shadow:0 0 0 1px #3d424759;}
.device-key.primary{right:-2px;top:22%;height:6.5%;}
.device-key.volume{left:-2px;top:16%;height:4%;box-shadow:0 0 0 1px #3d424759,0 ${Math.round(deviceHeight * 0.052)}px #848a91;}
.store-device.android .device-key.volume{left:auto;right:-2px;top:30%;height:9%;box-shadow:0 0 0 1px #3d424759;}
.store-screen{position:relative;z-index:1;width:100%;height:100%;overflow:hidden;border-radius:${corner - bezel}px;background:#fff;font-family:"Vaz",sans-serif;color:${S.app.textEmphasis};--k:${k};--ib:${format.platform === "ios" ? 24 : 18}px;--sbar:calc(var(--k)*48px);}
.store-screen .sbar{height:var(--sbar);padding:calc(var(--k)*12px) calc(var(--k)*26px) 0;direction:ltr;}
.store-screen .sb-time{font-size:calc(var(--k)*13px);}
.store-screen .sb-right{transform:scale(${k / 1.6});transform-origin:right center;}
.phone .device-sensor{position:absolute;z-index:2;top:${bezel + k * 10}px;left:50%;transform:translateX(-50%);border-radius:100px;background:#0c0e10;}
.ios.phone .device-sensor{width:${k * 95}px;height:${k * 25}px;box-shadow:inset 0 1px 2px #4448;}
.ios.phone .device-sensor::after{content:"";position:absolute;top:50%;right:${k * 7}px;transform:translateY(-50%);width:${k * 8}px;height:${k * 8}px;border-radius:50%;background:radial-gradient(circle at 36% 33%,#40536a,#151a24 41%,#08090b 70%);}
.ios.face-id-notch .device-sensor{top:${bezel - 1}px;width:${k * 152}px;height:${k * 28}px;border-radius:0 0 ${k * 13}px ${k * 13}px;box-shadow:0 1px 1px #0003;}
.ios.face-id-notch .device-sensor::before{content:"";position:absolute;top:${k * 3}px;left:50%;transform:translateX(-50%);width:${k * 40}px;height:${k * 2}px;border-radius:2px;background:#37393c;}
.ios.face-id-notch .device-sensor::after{left:${k * 19}px;right:auto;width:${k * 8}px;height:${k * 8}px;}
.android.phone .device-sensor{width:${k * 8}px;height:${k * 8}px;background:radial-gradient(circle at 34% 32%,#465366,#17191d 45%,#0a0b0d 70%);}
.home-indicator{position:absolute;bottom:${k * 7}px;left:50%;transform:translateX(-50%);width:${k * 110}px;height:${k * 4}px;border-radius:20px;background:#171717;z-index:25;}
.store-screen .keypad{display:none;}
.store-screen .ob,.store-screen .ob-foot,.store-screen .ob-brand{max-width:calc(var(--k)*480px);margin-left:auto;margin-right:auto;}
.color-strip{display:flex;position:absolute;bottom:0;left:0;right:0;height:14px;direction:ltr;}
.color-strip i{flex:1;background:${P.yellow};}.color-strip i:nth-child(2){background:${P.blue};}.color-strip i:nth-child(3){background:${P.red};}
`;
  return documentPage(
    panel.label,
    css,
    `<main class="store-art"><header class="campaign-top">${wordmark}<span class="campaign-label">${panel.label}</span></header><section class="campaign-copy"><h1>${panel.head}</h1><p>${panel.description}</p></section><div class="store-device ${format.platform} ${format.kind}${legacyIphone ? " face-id-notch" : ""}">${tablet ? "" : '<i class="device-key primary" aria-hidden="true"></i><i class="device-key volume" aria-hidden="true"></i><i class="device-sensor" aria-hidden="true"></i>'}<div class="store-screen">${screen}<div class="home-indicator"></div></div></div>${strip}</main>`,
  );
}

function featurePage() {
  // Play also shows this 1024x500 asset in narrower cards (including 16:9).
  // Keep the complete foreground inside 132px side insets; only the footer
  // reaches the edge, so the phone and RTL copy survive a centered crop.
  return documentPage(
    "کتابچهٔ حساب کاتا",
    `
html,body{width:1024px;height:500px;overflow:hidden;background:#fff;}
.feature{width:1024px;height:500px;position:relative;overflow:hidden;background:#fff;font-family:"Vaz",sans-serif;color:${P.ink};}
.feature-copy{position:absolute;right:132px;top:64px;width:436px;direction:rtl;}
.brand-lockup{display:flex;align-items:center;gap:10px;font-size:28px;font-weight:800;}.brand-lockup img{width:38px;height:38px;border-radius:10px;}
.feature h1{font-size:42px;line-height:1.55;margin-top:24px;font-weight:700;}.feature h1 em{color:${P.blue};font-style:normal;}
.feature p{font-size:18px;line-height:1.8;color:${P.muted};margin-top:18px;}
.feature-phone{position:absolute;left:132px;top:64px;width:224px;height:372px;padding:6px;border-radius:24px;background:#222;box-shadow:0 10px 20px #00000017;}
.feature-screen{position:relative;width:100%;height:100%;border-radius:19px;overflow:hidden;background:#fff;--k:.5394;--ib:14px;--sbar:26px;}
.feature-screen .sbar{height:26px;padding:7px 14px 0;}.feature-screen .sb-time{font-size:8px;}.feature-screen .sb-right{transform:scale(.345);transform-origin:right center;}
.color-strip{display:flex;position:absolute;bottom:0;left:0;right:0;height:10px;}.color-strip i{flex:1;background:${P.yellow};}.color-strip i:nth-child(2){background:${P.blue};}.color-strip i:nth-child(3){background:${P.red};}
`,
    `<main class="feature"><section class="feature-copy">${wordmark}<h1>کتابچهٔ حساب شما،<br><em>همیشه همراه شما.</em></h1><p>ثبت قرض‌ها، حساب مشتری‌ها و یادآوری‌ها<br>ساده، روشن و به زبان خودتان.</p></section><div class="feature-phone"><div class="feature-screen">${S.screenHome({ compact: true })}</div></div>${strip}</main>`,
  );
}

function generate(options = {}) {
  fs.mkdirSync(GENERATED, { recursive: true });
  const selected = options.only ? formats.filter((f) => options.only.includes(f.id)) : formats;
  const manifest = [];
  for (const format of selected) {
    for (const [i, panel] of panels.entries()) {
      const name = `${String(i + 1).padStart(2, "0")}-${panel.slug}`;
      const html = path.join(GENERATED, format.id, `${name}.html`);
      const png = path.join(ROOT, format.folder, `${name}.png`);
      fs.mkdirSync(path.dirname(html), { recursive: true });
      fs.mkdirSync(path.dirname(png), { recursive: true });
      fs.writeFileSync(html, page(panel, format), "utf8");
      manifest.push({
        html,
        png,
        width: format.width,
        height: format.height,
        kind: format.kind,
        platform: format.id,
        slug: panel.slug,
      });
    }
  }
  if (!options.only) {
    const html = path.join(GENERATED, "feature-graphic.html");
    fs.writeFileSync(html, featurePage(), "utf8");
    manifest.push({
      html,
      png: path.join(ROOT, "feature-graphic.png"),
      width: 1024,
      height: 500,
      kind: "feature",
      platform: "play",
      slug: "feature-graphic",
    });
  }
  fs.writeFileSync(path.join(GENERATED, "manifest.json"), JSON.stringify(manifest, null, 2));
  return manifest;
}

module.exports = { generate, page, featurePage };
if (require.main === module) console.log(`Prepared ${generate().length} Persian store assets.`);
