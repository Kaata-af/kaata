import { minorToWire } from "./wire";
import { sourceOf } from "./direction";
import type { TabEntryRow, TabLink } from "./types";

/** Display only. A notification's signed amount is from its RECIPIENT's
 * balance perspective, even for rejected/voided tallies (never computed as 0). */
export function notificationVars(link: TabLink, entry: TabEntryRow, fallback: string) {
  const label = link.other_label.replace(/[\p{Cc}\p{Cf}]/gu, "").trim();
  const name = Array.from(label).slice(0, 60).join("") || fallback;
  const sign = sourceOf(entry.direction) === link.role ? "+" : "−";
  return {
    name: `\u2068${name}${Array.from(label).length > 60 ? "…" : ""}\u2069`,
    amount: `\u2066${sign}${minorToWire(entry.amount_minor)} ${link.currency}\u2069`,
  };
}
