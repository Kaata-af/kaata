// Regenerate checked-in social PNGs with Playwright + Chromium, entirely offline.
// Install Playwright locally, or set PLAYWRIGHT_MODULE_PATH to its entry file.
// CHROME_PATH optionally selects an existing Chrome/Edge executable.
// kaata-fa-v1.png is selected for both homepage and bill-link previews.
// The separate bill illustration remains an alternate design.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const webRoot = fileURLToPath(new URL("../", import.meta.url));
// Reuse the existing white/blue campaign and its yellow/blue/red footer.
const require = createRequire(import.meta.url);
const { palette } = require("../../../docs/store-assets/store-design.js");
const template = await readFile(new URL("./social-preview.html", import.meta.url), "utf8");
const fontRoot = path.join(webRoot, "public", "fonts");
const dataURL = async (file, mime) =>
  `data:${mime};base64,${(await readFile(file)).toString("base64")}`;
const logo = await dataURL(path.join(webRoot, "public", "logo.png"), "image/png");
let fonts = "";
for (const weight of [400, 700]) {
  for (const subset of ["arabic", "latin"]) {
    const source = await dataURL(
      path.join(fontRoot, `vazirmatn-${subset}-${weight}-normal.woff2`),
      "font/woff2",
    );
    const range =
      subset === "arabic"
        ? "U+0600-06FF,U+0750-077F,U+08A0-08FF,U+FB50-FDFF,U+FE70-FEFF"
        : "U+0000-024F";
    fonts += `@font-face{font-family:Vazirmatn;font-style:normal;font-weight:${weight};src:url('${source}') format('woff2');unicode-range:${range};font-display:block;}\n`;
  }
}
const suppliedModule = process.env.PLAYWRIGHT_MODULE_PATH;
const playwright = await import(
  suppliedModule ? pathToFileURL(path.resolve(suppliedModule)).href : "playwright"
);
const { chromium } = playwright.default ?? playwright;
const executablePath =
  process.env.CHROME_PATH ||
  [
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  ].find(existsSync);
const browser = await chromium.launch({
  headless: true,
  ...(executablePath ? { executablePath } : {}),
});
const output = path.join(webRoot, "public", "og");
await mkdir(output, { recursive: true });
const variants = [
  {
    name: "kaata-fa-v1.png",
    variant: "home",
    headlineOne: "حساب و کتاب،",
    headlineTwo: "ساده و روشن",
    subtitle: "قرض، طلب و پرداخت‌ها در یک‌جا",
    footerOne: "بدون انترنت",
    footerTwo: "بدون ثبت‌نام",
    alt: "کاتا؛ حساب و کتاب ساده و روشن، برای همیشه رایگان",
  },
  {
    name: "kaata-bill-fa-v1.png",
    variant: "bill",
    headlineOne: "صورت‌حساب شما",
    headlineTwo: "آماده است",
    subtitle: "جزئیات حساب را در لینک ببینید.",
    footerOne: "ساخته‌شده با کاتا",
    footerTwo: "بدون نیاز به نصب اپ",
    alt: "صورت‌حساب شما در کاتا آماده است؛ برای همیشه رایگان",
  },
];
try {
  for (const variant of variants) {
    const values = {
      FONTS: fonts,
      LOGO: logo,
      INK: palette.ink,
      WHITE: palette.white,
      BLUE: palette.blue,
      YELLOW: palette.yellow,
      RED: palette.red,
      MUTED: palette.muted,
      PALE_BLUE: palette.paleBlue,
      VARIANT: variant.variant,
      ALT: variant.alt,
      HEADLINE_ONE: variant.headlineOne,
      HEADLINE_TWO: variant.headlineTwo,
      SUBTITLE: variant.subtitle,
      FOOTER_ONE: variant.footerOne,
      FOOTER_TWO: variant.footerTwo,
    };
    const html = template.replace(/\{\{([A-Z_]+)\}\}/g, (_, key) => {
      assert.ok(key in values, `Unknown template value: ${key}`);
      return values[key];
    });
    const page = await browser.newPage({
      viewport: { width: 1200, height: 630 },
      deviceScaleFactor: 1,
    });
    await page.route("**/*", (route) => {
      throw new Error(`Social artwork must render offline: ${route.request().url()}`);
    });
    await page.setContent(html, { waitUntil: "load" });
    await page.evaluate(() => document.fonts.ready);
    const layout = await page.evaluate(() => ({
      fontReady: document.fonts.check('700 76px "Vazirmatn"', "حساب و کتاب"),
      width: document.documentElement.scrollWidth,
      height: document.documentElement.scrollHeight,
      text: [...document.querySelectorAll("h1 span, .subtitle, .forever, .benefits, .domain")].map(
        (el) => {
          const r = el.getBoundingClientRect();
          return {
            text: el.textContent,
            x: r.x,
            y: r.y,
            right: r.right,
            bottom: r.bottom,
            scrollWidth: el.scrollWidth,
            clientWidth: el.clientWidth,
          };
        },
      ),
    }));
    assert.equal(layout.fontReady, true);
    assert.equal(layout.width, 1200);
    assert.equal(layout.height, 630);
    for (const block of layout.text) {
      assert.ok(
        block.x >= 40 &&
          block.right <= 1160 &&
          block.y >= 35 &&
          block.bottom <= 595 &&
          block.scrollWidth <= block.clientWidth + 1,
        `Clipped text: ${JSON.stringify(block)}`,
      );
    }
    const file = path.join(output, variant.name);
    await page.screenshot({ path: file, type: "png", animations: "disabled" });
    const bytes = await readFile(file);
    assert.equal(bytes.readUInt32BE(16), 1200);
    assert.equal(bytes.readUInt32BE(20), 630);
    assert.ok(bytes.length < 300 * 1024, `Keep social artwork small: ${bytes.length} bytes`);
    console.log(
      `${variant.name}: 1200x630, ${(bytes.length / 1024).toFixed(1)} KiB; Persian font and text bounds verified`,
    );
    await page.close();
  }
} finally {
  await browser.close();
}
