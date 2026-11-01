import assert from "node:assert/strict";
import { test } from "node:test";
import { detectPhonePlatform } from "./web-phone";

test("iPhones and Android phones get their own store even in landscape", () => {
  assert.equal(
    detectPhonePlatform({
      userAgent:
        "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1",
    }),
    "ios",
  );
  assert.equal(
    detectPhonePlatform({
      userAgent:
        "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 Chrome/140.0 Mobile Safari/537.36",
    }),
    "android",
  );
  assert.equal(
    detectPhonePlatform({
      userAgent:
        "Mozilla/5.0 (Linux; Android 15; Samsung) SamsungBrowser/28.0 Mobile Safari/537.36",
    }),
    "android",
  );
});

test("tablet and desktop browsers do not get the phone prompt", () => {
  for (const userAgent of [
    "Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) Mobile/15E148 Safari/604.1",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15",
    "Mozilla/5.0 (Linux; Android 15; SM-X710) Chrome/140.0 Safari/537.36",
    "Mozilla/5.0 (Linux; Android 15; Tablet) Mobile Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/140.0 Safari/537.36",
    "Mozilla/5.0 (X11; Linux x86_64) Firefox/140.0",
  ])
    assert.equal(detectPhonePlatform({ userAgent, mobile: false }), null, userAgent);
  assert.equal(detectPhonePlatform({}), null);
});

test("mobile client hints support reduced user agents without guessing the wrong store", () => {
  assert.equal(detectPhonePlatform({ userAgent: "Android Chrome", mobile: true }), "android");
  assert.equal(detectPhonePlatform({ userAgent: "Reduced browser", mobile: true }), "other");
  assert.equal(
    detectPhonePlatform({ userAgent: "Mozilla/5.0 (Windows Phone 10.0) IEMobile/11.0" }),
    "other",
  );
  assert.equal(
    detectPhonePlatform({
      userAgent:
        "Mozilla/5.0 (Windows Phone 10.0; Android 4.2.1) AppleWebKit/537.36 Chrome/42.0 Mobile Safari/537.36 Edge/12.0",
    }),
    "other",
  );
  assert.equal(detectPhonePlatform({ userAgent: "Reduced browser", mobile: false }), null);
});
