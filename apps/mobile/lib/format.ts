import { getCurrentCurrencySymbol } from "./currency";
import { t } from "./i18n";

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

// English-locale month abbreviations. We keep these short for Persian too —
// Gregorian dates with English month abbreviations are a common Afghan
// commerce convention, and switching to Solar Hijri month names (حمل/ثور)
// would be a bigger calendar-system change than we want here.
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function formatDate(ms: number): string {
  const d = new Date(ms);
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
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
