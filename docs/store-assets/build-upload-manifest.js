// Export only source-faithful, validated current-release screenshot sets.
const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { formats, panels } = require("./store-design.js");
const root = __dirname;
const repo = path.resolve(root, "../..");
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const validationFile = path.join(root, ".generated/validation.json");
const validation = JSON.parse(fs.readFileSync(validationFile, "utf8"));
if (validation.length !== 36 || validation.some((x) => !x.valid))
  throw new Error("All 36 screenshot exports must pass the renderer diagnostics first.");
const slots = {
  iphone: "APP_IPHONE_61",
  "iphone-legacy": "APP_IPHONE_65",
  ipad: "APP_IPAD_PRO_3GEN_129",
};
const roles = {
  "play-phone": "phoneScreenshots",
  "tablet-7": "sevenInchScreenshots",
  "tablet-10": "tenInchScreenshots",
};
const sets = formats.map((format) => {
  const images = panels.map((panel, i) => {
    const fileName = `${String(i + 1).padStart(2, "0")}-${panel.slug}.png`;
    const filename = path.join(root, format.folder, fileName);
    const bytes = fs.readFileSync(filename);
    if (
      bytes.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a" ||
      bytes.readUInt32BE(16) !== format.width ||
      bytes.readUInt32BE(20) !== format.height ||
      bytes[24] !== 8 ||
      bytes[25] !== 2
    )
      throw new Error(`Invalid RGB PNG: ${filename}`);
    let offset = 8;
    while (offset + 12 <= bytes.length) {
      const length = bytes.readUInt32BE(offset);
      const type = bytes.toString("ascii", offset + 4, offset + 8);
      if (type === "tRNS") throw new Error(`Transparency chunk: ${filename}`);
      offset += length + 12;
      if (type === "IEND") break;
    }
    const proof = validation.find((x) => path.resolve(x.png) === filename);
    if (!proof || !proof.valid) throw new Error(`Missing renderer proof: ${filename}`);
    return {
      fileName,
      path: path.relative(repo, filename).split(path.sep).join("/"),
      sha256: sha(bytes),
      width: format.width,
      height: format.height,
    };
  });
  return {
    id: format.id,
    platform: format.platform,
    width: format.width,
    height: format.height,
    screenshotDisplayType: slots[format.id] ?? null,
    imageType: roles[format.id] ?? null,
    images,
  };
});
const write = (name, value) =>
  fs.writeFileSync(path.join(root, name), JSON.stringify(value, null, 2) + "\n");
write("play-screenshots-manifest.json", {
  locale: "en-US",
  sets: Object.fromEntries(sets.filter((x) => x.imageType).map((x) => [x.imageType, x.images])),
});
write("apple-screenshots-manifest.json", {
  locale: "en-US",
  sets: sets
    .filter((x) => x.screenshotDisplayType)
    .map(({ screenshotDisplayType, width, height, images }) => ({
      screenshotDisplayType,
      width,
      height,
      images,
    })),
});
write("store-upload-manifest.json", {
  schema: 1,
  version: "2.3.0",
  androidCode: 82,
  iosBuild: "48",
  testedSource: "4057d982b98b8a67c75d847a7be4998866433a94",
  contentLanguage: "fa-AF",
  storeLocale: "en-US",
  provenance:
    "Source-faithful promotional compositions using fictional data; not native device captures.",
  screenshotCount: 36,
  allPassed: true,
  pngBitDepth: 8,
  pngColorType: 2,
  validationSha256: sha(fs.readFileSync(validationFile)),
  formats: sets,
});
console.log("Validated 36 opaque RGB screenshots and wrote Play, Apple and audit manifests.");
