import { getEffectiveCalendar } from "./calendar";
import { getCurrentCurrencySymbol } from "./currency";
import { getLocale, t } from "./i18n";
import { formatCalendarDate } from "./jalali";

// Plain numeric formatter — thousands separator, no currency, no sign.
// Pair with the chip/direction context to convey meaning.
export function formatAmount(amount: number): string {
  return Math.trunc(Math.abs(amount)).toLocaleString("en-US");
}

// Numeric + current-currency-symbol suffix, unsigned. Used in callers that
// just want a one-shot formatted string (e.g., WhatsApp share message body).
export function formatAFN(amount: number): string {
  return `${formatAmount(amount)} ${getCurrentCurrencySymbol()}`;
}

// Absolute date in the user's chosen calendar and language.
//
// This used to hold its own English month table and render Gregorian dates to
// everyone, on the reasoning that Gregorian-with-English-months is a common
// Afghan commerce convention. That reasoning is now a CHOICE rather than a
// hardcode: it is exactly what the Gregorian + English setting produces, and
// it stays the default for English installs. Persian installs default (via
// 'auto') to Solar Hijri — the change this feature is for.
//
// Both tables live in lib/jalali.ts so the four month sets can't drift apart.
export function formatDate(ms: number): string {
  return formatCalendarDate(ms, getLocale(), getEffectiveCalendar());
}

// Human-friendly "5 minutes ago" / "3 days ago". Used on list rows where
// exact dates would be visual noise — the long date form stays for entry
// detail. Strings flow through t() so Persian users see "همین حالا" /
// "۳ روز پیش" etc. on the same render as their language switch.
export function formatRelative(ms: number, now: number = Date.now()): string {
  const diff = Math.max(0, now - ms);
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return t("format.justNow");
  if (minutes < 60) return t("format.minutesAgo", { n: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t("format.hoursAgo", { n: hours });
  const days = Math.floor(hours / 24);
  if (days === 1) return t("format.yesterday");
  if (days < 7) return t("format.daysAgo", { n: days });
  const weeks = Math.floor(days / 7);
  if (weeks < 5) return t("format.weeksAgo", { n: weeks });
  return formatDate(ms);
}
