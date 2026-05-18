// Plain numeric formatter — thousands separator, no currency, no sign.
// Pair with the chip/direction context to convey meaning.
export function formatAmount(amount: number): string {
  return Math.trunc(Math.abs(amount)).toLocaleString("en-US");
}

// Numeric + AFN suffix, unsigned. For balance displays where currency is needed.
export function formatAFN(amount: number): string {
  return `${formatAmount(amount)} AFN`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function formatDate(ms: number): string {
  const d = new Date(ms);
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

// Human-friendly "5 minutes ago" / "3 days ago". Used on list rows where
// exact dates would be visual noise — the long date form stays for entry detail.
export function formatRelative(ms: number, now: number = Date.now()): string {
  const diff = Math.max(0, now - ms);
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return "yesterday";
  if (days < 7) return `${days}d ago`;
  const weeks = Math.floor(days / 7);
  if (weeks < 5) return `${weeks}w ago`;
  return formatDate(ms);
}
