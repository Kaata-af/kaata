import assert from "node:assert/strict";
import { parseInstallReferrerSource } from "../install-referrer-source";
import { compileUI } from "./ui-fixture";

for (const [raw, expected] of [
  ["kaata_source=facebook_ads&fbclid=private", "facebook_ads"],
  ["kaata_source=organic_posts", "organic_posts"],
  ["kaata_source=bill_share", "bill_share"],
  ["utm_source=Facebook&utm_medium=paid_social", "facebook_ads"],
  ["utm_source=Instagram&utm_medium=organic-social", "organic_posts"],
  ["utm_source=YouTube&utm_medium=social", "organic_posts"],
  ["utm_source=google-play&utm_medium=organic", null],
  ["fbclid=private", null],
  ["kaata_source=untrusted&utm_source=facebook&utm_medium=cpc", null],
  ["kaata_source=bill_share&kaata_source=facebook_ads", null],
  ["utm_source=facebook&utm_source=other&utm_medium=cpc", null],
  ["utm_source=facebook&utm_medium", null],
  ["kaata_source=%zz", null],
  [null, null],
] as const) {
  assert.equal(parseInstallReferrerSource(raw), expected, raw ?? "missing referrer");
}

function fixture(platform: string, read: ((id: string) => Promise<string | null>) | null) {
  let lookups = 0;
  const helper: typeof import("../install-referrer") = compileUI("../install-referrer", {
    "expo-modules-core": {
      requireOptionalNativeModule: (name: string) => {
        assert.equal(name, "KaataInstallReferrer");
        lookups++;
        return read && { getInstallReferrer: read };
      },
    },
    "react-native": { Platform: { OS: platform } },
    "./install-referrer-source": { parseInstallReferrerSource },
  });
  return { read: helper.getInstallReferrerSource, lookups: () => lookups };
}

async function main() {
  const ios = fixture("ios", null);
  assert.equal(await ios.read("install-one"), undefined);
  assert.equal(ios.lookups(), 0);
  const olderBuild = fixture("android", null);
  assert.equal(await olderBuild.read("install-one"), undefined);
  assert.equal(await olderBuild.read("install-one"), undefined);
  assert.equal(olderBuild.lookups(), 1);

  let complete!: (raw: string) => void;
  const delayed = fixture("android", (id) => {
    assert.equal(id, "install-one");
    return new Promise<string>((resolve) => (complete = resolve));
  });
  // Concurrent background check-ins share one bounded native read, and both
  // receive attribution even if Play is slower than the previous JS cutoff.
  const firstRead = delayed.read("install-one");
  const concurrentRead = delayed.read("install-one");
  assert.equal(delayed.lookups(), 1);
  complete("kaata_source=bill_share&clickid=private");
  assert.deepEqual(await Promise.all([firstRead, concurrentRead]), ["bill_share", "bill_share"]);
  assert.equal(await delayed.read("install-one"), "bill_share");
  assert.equal(await delayed.read("install-two"), undefined);

  let attempts = 0;
  const retry = fixture("android", async () => {
    if (++attempts === 1) throw new Error("Play connection unavailable");
    return "kaata_source=facebook_ads";
  });
  assert.equal(await retry.read("install-one"), undefined);
  assert.equal(await retry.read("install-one"), "facebook_ads");
  assert.equal(retry.lookups(), 2);
  console.log("install-referrer selftest passed");
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
