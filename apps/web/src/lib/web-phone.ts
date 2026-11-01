export type PhonePlatform = "ios" | "android" | "other";
type PhoneBrowser = { userAgent?: string; mobile?: boolean };

// This is a download suggestion, never an access or security decision. Screen
// width alone would also target resized desktop browsers and split-screen apps.
export function detectPhonePlatform(browser: PhoneBrowser): PhonePlatform | null {
  const ua = browser.userAgent ?? "";
  if (/iPad|Tablet|PlayBook|Silk\//i.test(ua)) return null;
  if (/Windows Phone|IEMobile/i.test(ua)) return "other";
  if (/iPhone|iPod/i.test(ua)) return "ios";
  if (/Android/i.test(ua)) return /Mobile/i.test(ua) || browser.mobile === true ? "android" : null;
  if (browser.mobile === true || /BlackBerry|BB10|Opera Mini|Mobi/i.test(ua)) return "other";
  return null;
}

export function currentPhonePlatform(): PhonePlatform | null {
  if (typeof navigator === "undefined") return null;
  const browser = navigator as Navigator & { userAgentData?: { mobile?: boolean } };
  return detectPhonePlatform({
    userAgent: browser.userAgent,
    mobile: browser.userAgentData?.mobile,
  });
}
