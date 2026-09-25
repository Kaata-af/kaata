import assert from "node:assert/strict";
import type { AppMetaUpdate } from "../types";

const filename = require.resolve("react-native");
const prior = require.cache[filename];
const Platform = { OS: "ios" };
require.cache[filename] = {
  id: filename,
  filename,
  loaded: true,
  exports: { Platform },
} as NodeJS.Module;
try {
  const { updateTargetUrl, forceUpdateTargetUrl } =
    require("../update-url") as typeof import("../update-url");
  const historical: AppMetaUpdate = {
    version: "0.2.0",
    apk_url: "https://example.invalid/old.apk",
    play_store_url: "https://example.invalid/stale-listing",
    release_notes: null,
  };
  for (const [os, expected] of [
    ["ios", "https://apps.apple.com/us/app/kaata/id6789651127"],
    ["android", "https://play.google.com/store/apps/details?id=af.kaata.app"],
    ["web", "https://kaata.af/download"],
  ]) {
    Platform.OS = os!;
    assert.equal(updateTargetUrl(historical), expected);
    assert.equal(forceUpdateTargetUrl(historical), expected);
    assert.equal(forceUpdateTargetUrl(null), expected);
  }
  console.log("PASS: 9 store-only update routing checks");
} finally {
  if (prior) require.cache[filename] = prior;
  else delete require.cache[filename];
}
