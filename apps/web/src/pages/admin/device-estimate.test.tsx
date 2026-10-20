// From apps/web: bun test ./src/pages/admin/device-estimate.test.tsx
// Bun handles JSX and the same TypeScript/React imports as the web build.
import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { DeviceEstimate } from "./api";
import { DeviceEstimateCard } from "./DeviceEstimateCard";

function render(estimate?: DeviceEstimate) {
  return renderToStaticMarkup(<DeviceEstimateCard estimate={estimate} installations={500} />);
}

test("device reporting rollout preserves installations without inventing a device count", () => {
  const html = render();
  assert.match(html, />500<\/dd>/);
  assert.match(html, /Available after the server update/);
  assert.match(html, /Waiting for device reporting support/);
  assert.doesNotMatch(html, />0%<|recognized by device identifier/);
});

test("legacy installs wait for updated app check-ins before showing an estimate", () => {
  const html = render({
    estimated_devices: 250,
    identified_devices: 0,
    identified_installs: 0,
    unidentified_installs: 250,
    total_installs: 250,
  });
  assert.match(html, /Collecting · waiting for updated apps/);
  assert.match(html, /0%/);
  assert.match(html, /0 of 250 installations/);
  // Only the installation total is numeric; a purely legacy count is not
  // presented as a measured device estimate.
  assert.equal((html.match(/>250<\/dd>/g) ?? []).length, 1);
});

test("partial coverage keeps the combined estimate distinct from recognized devices", () => {
  const html = render({
    estimated_devices: 160,
    identified_devices: 60,
    identified_installs: 100,
    unidentified_installs: 100,
    total_installs: 200,
  });
  assert.match(html, />200<\/dd>/);
  assert.match(html, />160<\/dd>/);
  assert.match(html, /60 recognized by device identifier/);
  assert.match(html, /50%/);
  assert.match(html, /100 of 200 installations/);
  assert.match(html, /100 installations without an identifier count individually/);
  assert.match(html, /Only updated apps report device identifiers/);
  assert.match(html, /Activity charts still count installations/);
});

test("empty reporting data does not divide by zero or display a fabricated estimate", () => {
  const html = render({
    estimated_devices: 0,
    identified_devices: 0,
    identified_installs: 0,
    unidentified_installs: 0,
    total_installs: 0,
  });
  assert.match(html, /0 of 0 installations/);
  assert.match(html, /Collecting/);
  assert.doesNotMatch(html, /NaN|Infinity/);
});
