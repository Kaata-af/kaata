import { useEffect, useState } from "react";
import { BrandLogo } from "../../components/BrandLogo";
import { Button } from "../../components/ui/button";
import { Card } from "../../components/ui/card";
import { APP_STORE_URL, PLAY_STORE_URL } from "../../env";
import { useI18n } from "../../lib/i18n";
import { currentPhonePlatform } from "../../lib/web-phone";
import "./MobileAppPrompt.css";

const DISMISSED_KEY = "kaata_phone_app_prompt_dismissed_v1";
const DISMISSED_EVENT = "kaata:phone-app-prompt-dismissed";
let dismissedInMemory = false;
const copy = {
  en: {
    title: "Kaata is better on your phone",
    body: "Get the mobile app. It’s free with no trial, works offline, and includes reminders.",
    account: "Use the same account to see your kaatas.",
    ios: "Download on the App Store",
    android: "Get it on Google Play",
    other: "Get the free app",
    continue: "Continue on web",
    dismiss: "Dismiss mobile app suggestion",
  },
  fa: {
    title: "کاتا در اپ تلفون بهتر است",
    body: "اپ تلفون را بگیرید؛ رایگان است و دورۀ آزمایشی ندارد، بدون انترنت کار می‌کند و یادآوری دارد.",
    account: "برای دیدن کاتاهای خود، با همان حساب وارد شوید.",
    ios: "دانلود از App Store",
    android: "دانلود از Google Play",
    other: "دریافت اپ رایگان",
    continue: "ادامه در وب",
    dismiss: "بستن پیشنهاد اپ تلفون",
  },
  ps: {
    title: "کاتا په موبایل اپ کې غوره ده",
    body: "د موبایل اپ واخلئ؛ وړیا دی او ازمایښتي موده نه لري، بې انټرنېټه کار کوي او یادونې لري.",
    account: "د خپلو کاتاګانو د لیدلو لپاره په هماغه حساب ننوځئ.",
    ios: "له App Store څخه یې ښکته کړئ",
    android: "له Google Play څخه یې ښکته کړئ",
    other: "وړیا اپ واخلئ",
    continue: "په وېب کې دوام ورکړئ",
    dismiss: "د موبایل اپ وړاندیز بند کړئ",
  },
};

function readDismissed(): boolean {
  if (dismissedInMemory) return true;
  try {
    return window.sessionStorage.getItem(DISMISSED_KEY) === "1";
  } catch {
    return false;
  }
}

export function MobileAppPrompt() {
  const { lang } = useI18n();
  const c = copy[lang];
  const [phone] = useState(currentPhonePlatform);
  const [dismissed, setDismissed] = useState(readDismissed);
  useEffect(() => {
    const update = () => setDismissed(readDismissed());
    window.addEventListener(DISMISSED_EVENT, update);
    return () => window.removeEventListener(DISMISSED_EVENT, update);
  }, []);
  if (!phone || dismissed) return null;

  function dismiss() {
    dismissedInMemory = true;
    setDismissed(true);
    try {
      window.sessionStorage.setItem(DISMISSED_KEY, "1");
    } catch {
      /* Keep the choice in memory. */
    }
    window.dispatchEvent(new Event(DISMISSED_EVENT));
  }
  const href = phone === "ios" ? APP_STORE_URL : phone === "android" ? PLAY_STORE_URL : "/download";
  return (
    <Card className="mobile-app-prompt" role="region" aria-label={c.title}>
      <div className="mobile-app-prompt-heading">
        <BrandLogo className="h-8 w-8 shrink-0" />
        <h2>{c.title}</h2>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="mobile-app-prompt-close"
          aria-label={c.dismiss}
          onClick={dismiss}
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.7"
            strokeLinecap="round"
            aria-hidden="true"
          >
            <path d="m6 6 12 12M18 6 6 18" />
          </svg>
        </Button>
      </div>
      <p>{c.body}</p>
      <p className="mobile-app-prompt-account">{c.account}</p>
      <div className="mobile-app-prompt-actions">
        <Button asChild variant="brand" className="rounded-full">
          <a href={href} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">
            {c[phone]}
          </a>
        </Button>
        <Button type="button" variant="ghost" className="rounded-full" onClick={dismiss}>
          {c.continue}
        </Button>
      </div>
    </Card>
  );
}
