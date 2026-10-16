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
  const top = compact ? 370 : format.id === "iphone" ? 600 : 490;
  const deviceHeight = artHeight - top - 82;
  const bezel = format.kind === "tablet" ? 12 : 11;
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
.campaign-copy{position:absolute;top:${compact ? 135 : format.id === "iphone" ? 205 : 155}px;left:60px;right:60px;text-align:center;direction:rtl;}
.campaign-copy h1{font-size:${compact ? 58 : 72}px;line-height:1.5;font-weight:700;letter-spacing:0;}
.campaign-copy em{color:${P.blue};font-style:normal;}
.campaign-copy p{font-size:${compact ? 24 : 27}px;line-height:1.75;margin-top:${compact ? 12 : 20}px;color:${P.muted};}
.store-device{position:absolute;top:${top}px;left:50%;transform:translateX(-50%);width:${deviceWidth}px;height:${deviceHeight}px;padding:${bezel}px;background:#222;border-radius:${format.kind === "tablet" ? 35 : 64}px;box-shadow:0 18px 40px #00000017,0 0 0 2px #b2b2b2,inset 0 0 0 3px #4a4a4a;}
.store-screen{position:relative;width:100%;height:100%;overflow:hidden;border-radius:${format.kind === "tablet" ? 24 : 54}px;background:#fff;font-family:"Vaz",sans-serif;color:${S.app.textEmphasis};--k:${k};--ib:${format.platform === "ios" ? 24 : 18}px;--sbar:calc(var(--k)*48px);}
.store-screen .sbar{height:var(--sbar);padding:calc(var(--k)*12px) calc(var(--k)*26px) 0;direction:ltr;}
.store-screen .sb-time{font-size:calc(var(--k)*13px);}
.store-screen .sb-right{transform:scale(${k / 1.6});transform-origin:right center;}
.store-device.ios.phone::after{content:"";position:absolute;top:${bezel + k * 10}px;left:50%;transform:translateX(-50%);width:${k * 91}px;height:${k * 24}px;border-radius:40px;background:#090909;}
.store-device.android.phone::after{content:"";position:absolute;top:${bezel + k * 10}px;left:50%;transform:translateX(-50%);width:${k * 9}px;height:${k * 9}px;border-radius:50%;background:#161616;}
.home-indicator{position:absolute;bottom:${k * 7}px;left:50%;transform:translateX(-50%);width:${k * 110}px;height:${k * 4}px;border-radius:20px;background:#171717;z-index:25;}
.store-screen .keypad{display:none;}
.store-screen .ob,.store-screen .ob-foot,.store-screen .ob-brand{max-width:calc(var(--k)*480px);margin-left:auto;margin-right:auto;}
.color-strip{display:flex;position:absolute;bottom:0;left:0;right:0;height:14px;direction:ltr;}
.color-strip i{flex:1;background:${P.yellow};}.color-strip i:nth-child(2){background:${P.blue};}.color-strip i:nth-child(3){background:${P.red};}
`;
  return documentPage(
    panel.label,
    css,
    `<main class="store-art"><header class="campaign-top">${wordmark}<span class="campaign-label">${panel.label}</span></header><section class="campaign-copy"><h1>${panel.head}</h1><p>${panel.description}</p></section><div class="store-device ${format.platform} ${format.kind}"><div class="store-screen">${screen}<div class="home-indicator"></div></div></div>${strip}</main>`,
  );
}

function featurePage() {
  return documentPage(
    "کتابچهٔ حساب کاتا",
    `
html,body{width:1024px;height:500px;overflow:hidden;background:#fff;}
.feature{width:1024px;height:500px;position:relative;overflow:hidden;background:#fff;font-family:"Vaz",sans-serif;color:${P.ink};}
.feature-copy{position:absolute;right:56px;top:40px;width:514px;direction:rtl;}
.brand-lockup{display:flex;align-items:center;gap:12px;font-size:31px;font-weight:800;}.brand-lockup img{width:42px;height:42px;border-radius:11px;}
.feature h1{font-size:49px;line-height:1.55;margin-top:27px;font-weight:700;}.feature h1 em{color:${P.blue};font-style:normal;}
.feature p{font-size:21px;line-height:1.8;color:${P.muted};margin-top:18px;}
.feature-phone{position:absolute;left:58px;top:34px;width:260px;height:432px;padding:7px;border-radius:28px;background:#222;box-shadow:0 12px 24px #00000017;}
.feature-screen{position:relative;width:100%;height:100%;border-radius:22px;overflow:hidden;background:#fff;--k:.626;--ib:16px;--sbar:30px;}
.feature-screen .sbar{height:30px;padding:8px 17px 0;}.feature-screen .sb-time{font-size:9px;}.feature-screen .sb-right{transform:scale(.4);transform-origin:right center;}
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
