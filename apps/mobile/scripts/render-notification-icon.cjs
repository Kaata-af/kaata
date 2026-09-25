// Deterministic renderer for the small M/L/C/Z vector above. No bitmap editing,
// remote service or new dependency; pngjs already ships with the Expo toolchain.
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const { PNG } = require("pngjs");
const asset = path.join(__dirname, "../assets/notification-icon");
const svg = fs.readFileSync(asset + ".svg", "utf8");
const polygons = [...svg.matchAll(/ d="([^"]+)"/g)].map((match) => {
  const tokens = match[1].match(/[MLCZ]|-?\d+(?:\.\d+)?/g);
  let i = 0,
    current = [0, 0];
  const points = [];
  const point = () => [Number(tokens[i++]), Number(tokens[i++])];
  while (i < tokens.length) {
    const command = tokens[i++];
    if (command === "M" || command === "L") {
      current = point();
      points.push(current);
    } else if (command === "C") {
      const a = current,
        b = point(),
        c = point(),
        d = point();
      for (let step = 1; step <= 32; step++) {
        const t = step / 32,
          u = 1 - t;
        points.push(
          [0, 1].map(
            (k) =>
              u * u * u * a[k] + 3 * u * u * t * b[k] + 3 * u * t * t * c[k] + t * t * t * d[k],
          ),
        );
      }
      current = d;
    } else assert.equal(command, "Z");
  }
  return points;
});
function inside(x, y, polygon) {
  let hit = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [ax, ay] = polygon[i],
      [bx, by] = polygon[j];
    if (ay > y !== by > y && x < ((bx - ax) * (y - ay)) / (by - ay) + ax) hit = !hit;
  }
  return hit;
}
const png = new PNG({ width: 96, height: 96 });
for (let y = 0; y < 96; y++)
  for (let x = 0; x < 96; x++) {
    let hits = 0;
    for (let sy = 0; sy < 4; sy++)
      for (let sx = 0; sx < 4; sx++)
        if (polygons.some((p) => inside(x + (sx + 0.5) / 4, y + (sy + 0.5) / 4, p))) hits++;
    const offset = (y * 96 + x) * 4;
    png.data[offset] = png.data[offset + 1] = png.data[offset + 2] = 255;
    png.data[offset + 3] = Math.round((hits / 16) * 255);
  }
const rendered = PNG.sync.write(png);
if (process.argv.includes("--check")) {
  assert.deepEqual(fs.readFileSync(asset + ".png"), rendered, "PNG differs from vector");
} else fs.writeFileSync(asset + ".png", rendered);
const visible = [...png.data].filter((_, i) => i % 4 === 3).filter((v) => v > 0).length;
assert(visible > 1500 && visible < 5000, "Unexpected silhouette coverage");
assert.equal(png.data[3], 0, "Background must be transparent");
console.log("Notification icon: 96×96, white silhouette, transparent background; verified.");
