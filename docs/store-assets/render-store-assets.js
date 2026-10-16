/*
 * Local artwork export only: this does not build or publish the app.
 * Run: node docs/store-assets/render-store-assets.js
 * Optional: --platform <name> --slug <name>
 * Uses installed Playwright (including NODE_PATH) and Chrome. No downloads.
 */
const fs = require("node:fs/promises");
const { existsSync } = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const GENERATED = path.join(__dirname, ".generated");
const BUNDLED_MODULES = path.join(
  os.homedir(),
  ".cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules",
);

function dependency(name) {
  for (const location of [name, path.join(BUNDLED_MODULES, name)]) {
    try {
      return require(location);
    } catch (error) {
      if (error.code !== "MODULE_NOT_FOUND") throw error;
    }
  }
  return null;
}

function chromePath(chromium) {
  const candidates = [
    process.env.CHROME_PATH,
    process.env.PROGRAMFILES &&
      path.join(process.env.PROGRAMFILES, "Google/Chrome/Application/chrome.exe"),
    process.env["PROGRAMFILES(X86)"] &&
      path.join(process.env["PROGRAMFILES(X86)"], "Google/Chrome/Application/chrome.exe"),
    process.env.LOCALAPPDATA &&
      path.join(process.env.LOCALAPPDATA, "Google/Chrome/Application/chrome.exe"),
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    chromium.executablePath(),
  ];
  const executable = candidates.find((candidate) => candidate && existsSync(candidate));
  if (!executable) {
    throw new Error("Chrome was not found. Set CHROME_PATH to an installed Chrome executable.");
  }
  return executable;
}

function options(args) {
  const result = {};
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (!["--platform", "--slug"].includes(argument) || !args[index + 1]) {
      throw new Error(`Unknown or incomplete argument: ${argument}`);
    }
    result[argument.slice(2)] = args[++index];
  }
  return result;
}

function validateManifest(items) {
  if (!Array.isArray(items) || !items.length) throw new Error("The export manifest is empty.");
  const targets = new Set();
  for (const item of items) {
    if (
      !path.isAbsolute(item.html || "") ||
      !path.isAbsolute(item.png || "") ||
      !Number.isInteger(item.width) ||
      !Number.isInteger(item.height) ||
      item.width <= 0 ||
      item.height <= 0 ||
      !["phone", "tablet", "feature", "preview"].includes(item.kind) ||
      !item.platform ||
      !item.slug
    ) {
      throw new Error(`Invalid export manifest entry: ${JSON.stringify(item)}`);
    }
    const relative = path.relative(GENERATED, item.html);
    if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error(`Generated HTML must live under ${GENERATED}: ${item.html}`);
    }
    const target = path.resolve(item.png).toLowerCase();
    if (targets.has(target)) throw new Error(`Duplicate PNG output: ${item.png}`);
    targets.add(target);
  }
}

async function ready(page) {
  await page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all(
      [...document.images].map(async (image) => {
        if (!image.complete) {
          await new Promise((resolve) => {
            image.addEventListener("load", resolve, { once: true });
            image.addEventListener("error", resolve, { once: true });
          });
        }
        if (image.naturalWidth) await image.decode().catch(() => {});
      }),
    );
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
}

// Check text itself, not large artwork wrappers: phone frames may intentionally
// extend beyond the canvas. An explicitly clipped text box can opt out of the
// overflow check with data-allow-crop; language and asset checks still apply.
async function inspect(page) {
  return page.evaluate(() => {
    const latin = [];
    const overflow = [];
    const seen = new Set();
    const visible = (element, rect) => {
      if (!rect.width || !rect.height) return false;
      let clip = { left: 0, top: 0, right: innerWidth, bottom: innerHeight };
      for (let ancestor = element; ancestor; ancestor = ancestor.parentElement) {
        const style = getComputedStyle(ancestor);
        if (
          style.display === "none" ||
          style.visibility === "hidden" ||
          Number(style.opacity) === 0
        ) {
          return false;
        }
        const bounds = ancestor.getBoundingClientRect();
        if (["hidden", "clip", "auto", "scroll"].includes(style.overflowX)) {
          clip.left = Math.max(clip.left, bounds.left);
          clip.right = Math.min(clip.right, bounds.right);
        }
        if (["hidden", "clip", "auto", "scroll"].includes(style.overflowY)) {
          clip.top = Math.max(clip.top, bounds.top);
          clip.bottom = Math.min(clip.bottom, bounds.bottom);
        }
      }
      return (
        rect.right > clip.left &&
        rect.left < clip.right &&
        rect.bottom > clip.top &&
        rect.top < clip.bottom
      );
    };
    const checkLanguage = (value) => {
      const words = value.match(/[A-Za-z]+/g) || [];
      if (words.some((word) => word !== "K")) latin.push(value.trim().slice(0, 160));
    };
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const node = walker.currentNode;
      const element = node.parentElement;
      if (!element || !node.textContent.trim() || element.closest("script,style,noscript")) {
        continue;
      }
      const range = document.createRange();
      range.selectNodeContents(node);
      const rects = [...range.getClientRects()];
      if (!rects.some((rect) => visible(element, rect))) continue;
      checkLanguage(node.textContent);
      if (seen.has(element) || element.hasAttribute("data-allow-crop")) continue;
      seen.add(element);
      const style = getComputedStyle(element);
      const bounds = element.getBoundingClientRect();
      const label = element.textContent.trim().replace(/\s+/g, " ").slice(0, 100);
      // Inline spans can legitimately break over lines; their bounding boxes
      // cannot be treated as a single rectangular text container.
      if (!["inline", "contents"].includes(style.display) && element.clientWidth) {
        if (
          element.scrollWidth > element.clientWidth + 3 ||
          rects.some((rect) => rect.left < bounds.left - 3 || rect.right > bounds.right + 3)
        ) {
          overflow.push({ text: label, issue: "horizontal text overflow" });
        }
        if (
          ["hidden", "clip"].includes(style.overflowY) &&
          element.scrollHeight > element.clientHeight + 3
        ) {
          overflow.push({ text: label, issue: "vertical text clipping" });
        }
      }
    }
    for (const element of document.querySelectorAll("input,textarea")) {
      if (visible(element, element.getBoundingClientRect())) {
        checkLanguage(element.value || element.placeholder || "");
      }
    }
    const images = [...document.images]
      .filter((image) => !image.complete || !image.naturalWidth)
      .map((image) => image.currentSrc || image.src);
    const fonts = [...document.fonts]
      .filter((font) => font.status === "error")
      .map((font) => `${font.family} ${font.weight}`);
    return { latin: [...new Set(latin)], overflow, images, fonts };
  });
}

async function opaquePng(page, width, height) {
  let buffer = await page.screenshot({
    type: "png",
    omitBackground: false,
    animations: "disabled",
    clip: { x: 0, y: 0, width, height },
  });
  // Chrome normally writes RGB PNGs. Ensure a different browser revision never
  // introduces an alpha channel that App Store Connect would reject.
  if ([4, 6].includes(buffer[25])) {
    const sharp = dependency("sharp");
    if (!sharp)
      throw new Error("An alpha PNG needs sharp; expose the bundled modules via NODE_PATH.");
    buffer = await sharp(buffer).flatten({ background: "#ffffff" }).removeAlpha().png().toBuffer();
  }
  if (
    buffer.toString("hex", 0, 8) !== "89504e470d0a1a0a" ||
    buffer.readUInt32BE(16) !== width ||
    buffer.readUInt32BE(20) !== height ||
    buffer[25] !== 2
  ) {
    throw new Error(`Expected an opaque RGB PNG at exactly ${width} × ${height}.`);
  }
  return buffer;
}

const escapeHtml = (value) =>
  String(value).replace(/[&<>"']/g, (character) => {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[character];
  });

function imagePath(file) {
  return path.relative(GENERATED, file).split(path.sep).map(encodeURIComponent).join("/");
}

function galleryHtml(items, contactSheet = false) {
  return `<!doctype html><html lang="fa" dir="rtl"><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>تصاویر فروشگاه کاتا</title><style>
*{box-sizing:border-box}body{margin:0;padding:32px;background:#f4f6f9;color:#202124;font-family:Tahoma,sans-serif}
h1{font-size:24px;margin:0 0 24px}.grid{display:grid;grid-template-columns:repeat(${contactSheet ? 4 : "auto-fit"},${contactSheet ? "1fr" : "minmax(230px,1fr)"});gap:20px}
figure{margin:0;background:white;padding:10px;border:1px solid #e1e4e8;border-radius:12px}
img{display:block;width:100%;height:auto}figcaption{padding:12px 2px 2px;font-size:13px;color:#5f6368;text-align:center}a{color:inherit;text-decoration:none}
</style><h1>تصاویر فروشگاه کاتا</h1><div class="grid">${items
    .map(
      (item, index) => `<figure><a href="${escapeHtml(imagePath(item.png))}"><img
src="${escapeHtml(imagePath(item.png))}" alt="تصویر ${index + 1}"></a><figcaption>
${index + 1} · <span dir="ltr">${item.width} × ${item.height}</span></figcaption></figure>`,
    )
    .join("")}</div></html>`;
}

function previewHtml(items) {
  const titles = {
    home: "حساب مشتری‌ها",
    "person-detail": "جزئیات حساب",
    "add-entry": "ثبت قرض و پرداخت",
    search: "جستجو و انتخاب",
    onboarding: "شروع ساده",
    reminder: "یادآوری حساب",
  };
  return `<!doctype html><html lang="fa" dir="rtl"><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>تصاویر تازهٔ کاتا</title><style>
*{box-sizing:border-box}html,body{margin:0;width:1080px;min-height:1400px;background:#f4f6f9;color:#202124;font-family:Tahoma,sans-serif}
body{padding:36px}h1{font-size:30px;line-height:48px;margin:0 0 24px;font-weight:700}
.grid{display:grid;grid-template-columns:repeat(3,320px);gap:24px;direction:rtl}
figure{margin:0;width:320px;overflow:hidden;background:#fff;border:1px solid #e1e4e8;border-radius:12px}
img{display:block;width:318px;height:auto}figcaption{padding:14px 8px;font-size:15px;line-height:24px;text-align:center;color:#5f6368}
</style><h1>کاتا؛ کتابچهٔ هوشمند قرض‌ها</h1><div class="grid">${items
    .map(
      (item) =>
        `<figure><img src="${escapeHtml(imagePath(item.png))}" alt="${escapeHtml(titles[item.slug] || "تصویر کاتا")}"><figcaption>${escapeHtml(titles[item.slug] || "تصویر کاتا")}</figcaption></figure>`,
    )
    .join("")}</div></html>`;
}

async function makeReviews(browser, items) {
  await fs.writeFile(path.join(GENERATED, "index.html"), galleryHtml(items));
  for (const kind of ["phone", "tablet"]) {
    const group = items.filter((item) => item.kind === kind);
    if (!group.length) continue;
    const html = path.join(GENERATED, `contact-sheet-${kind}.html`);
    await fs.writeFile(html, galleryHtml(group, true));
    const page = await browser.newPage({
      viewport: { width: 1600, height: 1000 },
      deviceScaleFactor: 1,
    });
    try {
      await page.goto(pathToFileURL(html).href);
      await ready(page);
      const height = await page.evaluate(() => Math.ceil(document.documentElement.scrollHeight));
      await page.setViewportSize({ width: 1600, height });
      await ready(page);
      await fs.writeFile(
        path.join(GENERATED, `contact-sheet-${kind}.png`),
        await opaquePng(page, 1600, height),
      );
    } finally {
      await page.close();
    }
  }
  const previewItems = items.filter((item) => item.platform === "play-phone");
  if (previewItems.length === 6) {
    const html = path.join(GENERATED, "preview.html");
    await fs.writeFile(html, previewHtml(previewItems));
    const page = await browser.newPage({
      viewport: { width: 1080, height: 1400 },
      deviceScaleFactor: 1,
    });
    try {
      await page.goto(pathToFileURL(html).href);
      await ready(page);
      const height = await page.evaluate(() => Math.ceil(document.documentElement.scrollHeight));
      await page.setViewportSize({ width: 1080, height });
      await ready(page);
      await fs.writeFile(path.join(GENERATED, "preview.png"), await opaquePng(page, 1080, height));
    } finally {
      await page.close();
    }
  }
}

async function render(filters = {}) {
  const { generate } = require("./generate-store-assets.js");
  const manifest = await generate();
  validateManifest(manifest);
  const items = manifest.filter(
    (item) =>
      (!filters.platform || item.platform === filters.platform) &&
      (!filters.slug || item.slug === filters.slug),
  );
  if (!items.length) throw new Error("No assets match the requested platform/slug.");
  const playwright = dependency("playwright") || dependency("playwright-core");
  if (!playwright) {
    throw new Error("Playwright was not found. Expose the bundled modules through NODE_PATH.");
  }
  const browser = await playwright.chromium.launch({
    executablePath: chromePath(playwright.chromium),
    headless: true,
    args: ["--allow-file-access-from-files"],
  });
  const report = [];
  try {
    for (const item of items) {
      const page = await browser.newPage({
        viewport: { width: item.width, height: item.height },
        deviceScaleFactor: 1,
        locale: "fa-AF",
        colorScheme: "light",
        reducedMotion: "reduce",
      });
      const failures = [];
      page.on("pageerror", (error) => failures.push(error.message));
      page.on("requestfailed", (request) => failures.push(`Asset failed: ${request.url()}`));
      try {
        await page.goto(pathToFileURL(item.html).href, { waitUntil: "load" });
        await ready(page);
        const diagnostics = await inspect(page);
        const valid =
          Object.values(diagnostics).every((values) => !values.length) && !failures.length;
        const buffer = await opaquePng(page, item.width, item.height);
        if (!valid) {
          const diagnosticFile = path.join(
            GENERATED,
            "diagnostics",
            `${String(item.platform).replace(/[^\w.-]/g, "_")}-${String(item.slug).replace(/[^\w.-]/g, "_")}.png`,
          );
          await fs.mkdir(path.dirname(diagnosticFile), { recursive: true });
          await fs.writeFile(diagnosticFile, buffer);
          report.push({ ...item, valid, diagnostics, failures, diagnosticFile });
          console.error(`Validation failed: ${item.platform}/${item.slug}`);
          continue;
        }
        await fs.mkdir(path.dirname(item.png), { recursive: true });
        await fs.writeFile(item.png, buffer);
        report.push({ ...item, valid, diagnostics, failures });
        console.log(`Exported ${item.platform}/${item.slug}: ${item.width} × ${item.height}`);
      } catch (error) {
        report.push({ ...item, valid: false, error: error.message, failures });
        console.error(`Failed ${item.platform}/${item.slug}: ${error.message}`);
      } finally {
        await page.close();
      }
    }
    await fs.writeFile(path.join(GENERATED, "validation.json"), JSON.stringify(report, null, 2));
    const failed = report.filter((item) => !item.valid);
    if (failed.length) {
      throw new Error(`${failed.length} export(s) failed. Inspect .generated/validation.json.`);
    }
    await makeReviews(browser, items);
    console.log(`Review gallery: ${path.join(GENERATED, "index.html")}`);
    return report;
  } finally {
    await browser.close();
  }
}

module.exports = { render };

if (require.main === module) {
  if (process.argv.includes("--help")) {
    console.log("node docs/store-assets/render-store-assets.js [--platform name] [--slug name]");
  } else {
    Promise.resolve()
      .then(() => render(options(process.argv.slice(2))))
      .catch((error) => {
        console.error(error.message);
        process.exitCode = 1;
      });
  }
}
