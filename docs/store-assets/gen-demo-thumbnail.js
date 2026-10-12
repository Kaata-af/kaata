const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");
const S = require("./gen-screens.js"); // fonts, icons, palette and the Dari home screen

// The Download page's "How to use Kaata" thumbnail (apps/web/src/assets/
// kaata-demo.jpg, 1280x720; the page links it to the YouTube guide). Brand
// roles per docs/brand-language.md: Ivory ground, Aubergine logo and headline,
// Saffron highlights, Charcoal copy; the phone shows the current app's Dari
// home (gen-screens.js), and the store badges are the official artwork the
// site uses. The page centers a 64px play button over the image, so the gap
// between the text column and the phone is kept clear of copy.
//
// Render: node gen-demo-thumbnail.js, then headless Chrome at
// --window-size=1280,720 (see docs/store-listing.md) and save the PNG as JPEG
// over apps/web/src/assets/kaata-demo.jpg.

const { brand, ion } = S;
const REPO = path.resolve(__dirname, "../..");
const asset = (p) => pathToFileURL(path.join(REPO, p)).href;
const SUB = "#706573"; // apps/web/src/theme.ts brand.sub: 5.0:1 on Ivory

const feature = (icon, title, sub) =>
  `<div class="feat"><span class="feat-icon">${ion(icon, 30, brand.aubergine)}</span><b>${title}</b><span>${sub}</span></div>`;

const CSS = `${S.CSS}
html,body{width:1280px;height:720px;}
.thumb{--k:1;position:relative;width:1280px;height:720px;overflow:hidden;background:${brand.ivory};font-family:"Vaz",sans-serif;color:${brand.charcoal};-webkit-font-smoothing:antialiased;}
.col{position:absolute;left:30px;top:0;width:560px;height:720px;direction:rtl;text-align:right;}
.brandrow{position:absolute;top:40px;right:0;display:flex;align-items:center;gap:16px;}
.brandrow img{width:72px;height:72px;border-radius:22%;display:block;}
.brandrow span{font-weight:800;font-size:58px;line-height:1;color:${brand.aubergine};}
.h1{position:absolute;top:136px;right:0;font-weight:800;font-size:76px;line-height:1.25;color:${brand.charcoal};white-space:nowrap;}
.h2{position:absolute;top:226px;right:0;font-weight:800;font-size:92px;line-height:1.25;color:${brand.aubergine};white-space:nowrap;}
.h2 em{font-style:normal;padding:0 .08em;background:linear-gradient(transparent 58%,${brand.saffron} 58%,${brand.saffron} 86%,transparent 86%);}
.sub{position:absolute;top:366px;right:0;font-weight:500;font-size:25px;line-height:1.6;color:${brand.charcoal};}
.feats{position:absolute;top:470px;right:0;left:0;display:flex;justify-content:space-between;}
.feat{width:140px;display:flex;flex-direction:column;align-items:center;text-align:center;}
.feat-icon{width:62px;height:62px;border-radius:999px;background:${brand.white};border:1.5px solid rgba(74,42,80,.14);display:flex;align-items:center;justify-content:center;margin-bottom:9px;}
.feat b{font-weight:700;font-size:17px;line-height:1.35;color:${brand.charcoal};}
.feat span:last-child{font-size:12.5px;line-height:1.4;color:${SUB};white-space:nowrap;}
.badges{position:absolute;bottom:34px;right:0;display:flex;gap:16px;direction:ltr;}
.badges img{height:58px;width:auto;display:block;}
.device{position:absolute;left:742px;top:52px;width:660px;height:1400px;transform:scale(.5);transform-origin:top left;}
.device .phone{position:relative;left:0;top:0;transform:none;box-shadow:0 50px 110px rgba(41,34,43,.35), inset 0 0 0 2px #2a2a2a, 0 0 0 1px #000;}
.note{position:absolute;direction:rtl;text-align:center;font-weight:800;font-size:27px;line-height:1.3;color:${brand.aubergine};}
.note u{text-decoration:none;background:linear-gradient(transparent 62%,${brand.saffron} 62%,${brand.saffron} 92%,transparent 92%);}
.note1{left:1094px;top:96px;width:170px;transform:rotate(-5deg);}
.note3{left:1092px;top:560px;width:170px;transform:rotate(4deg);font-size:24px;}
.free{position:absolute;left:1108px;top:318px;width:142px;height:142px;border-radius:999px;background:${brand.saffron};display:flex;align-items:center;justify-content:center;text-align:center;direction:rtl;font-weight:800;font-size:27px;line-height:1.25;color:${brand.charcoal};transform:rotate(-8deg);box-shadow:0 0 0 6px ${brand.ivory},0 0 0 8px rgba(74,42,80,.28);}
.arrow{position:absolute;fill:none;stroke:${brand.aubergine};stroke-width:3.2;stroke-linecap:round;stroke-linejoin:round;}
`;

const body = `<div class="thumb">
  <div class="col">
    <div class="brandrow"><img src="${asset("apps/web/public/logo.png")}" alt="" /><span>کاتا.</span></div>
    <div class="h1">دانلود و استفاده</div>
    <div class="h2"><em>در چند دقیقه</em></div>
    <div class="sub">ثبت حسابداری و ارسال بل برای قرض‌ها<br />ساده، سریع و رایگان!</div>
    <div class="feats">
      ${feature("albums-outline", "چندین کتابچه", "برای دکان‌های مختلف")}
      ${feature("document-text-outline", "خروجی PDF/CSV", "همه معاملات")}
      ${feature("logo-whatsapp", "ارسال بل", "از طریق واتساپ")}
      ${feature("cloud-done-outline", "بکاپ آنلاین", "اطلاعات شما همیشه محفوظ")}
    </div>
    <div class="badges">
      <img src="${asset("apps/web/src/assets/app-store-badge.svg")}" alt="" />
      <img src="${asset("apps/web/src/assets/google-play-badge.svg")}" alt="" />
    </div>
  </div>
  <div class="device"><div class="phone"><div class="island"></div><div class="screen">${S.screenHome({ rtl: true })}</div></div></div>
  <div class="note note1">مثل دفترچه،<br /><u>اما بهتر!</u></div>
  <svg class="arrow" style="left:1060px;top:196px" width="90" height="90" viewBox="0 0 90 90"><path d="M70 6 C 70 44, 46 66, 10 72"/><path d="M24 60 L10 72 L26 82"/></svg>
  <div class="free">کاملاً<br />رایگان!</div>
  <div class="note note3">همین حالا<br /><u>دانلود کنید!</u></div>
  <svg class="arrow" style="left:1052px;top:628px" width="90" height="70" viewBox="0 0 90 70"><path d="M80 18 C 60 52, 36 58, 10 50"/><path d="M24 38 L10 50 L24 62"/></svg>
</div>`;

module.exports = { CSS, body };

if (require.main === module) {
  const out = path.join(__dirname, "demo-thumbnail.html");
  fs.writeFileSync(
    out,
    `<!doctype html><html lang="fa"><head><meta charset="utf-8"/><style>${CSS}</style></head><body>${body}</body></html>`,
    "utf8",
  );
  console.log("wrote", out, "(1280x720)");
}
