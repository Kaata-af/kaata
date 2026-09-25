// Design tokens, adapted from dub.co's system.
// Monochrome chrome — black/white/neutral grays. Quiet semantic color appears
// only on the things that carry meaning:
//   - direction (collect / pay) — a refined red & green pair, "Emerald Vault &
//     Garnet" (deep forest-emerald + garnet-wine), not the generic bright
//     primaries
//   - the danger color (delete only), as a saturated red
// Chrome (headers, FAB, ping button, nav) stays monochrome.
//
// Khatabook flow-direction convention: collect = money TOWARD you (the
// to-collect balance + "I received" entries); pay = money AWAY from you (the
// to-pay balance + "I gave" entries). One color always means "money toward
// you", on balances AND entries. Kept in sync with the web app
// (apps/web/src/theme.ts) + the backend SSR ledger (internal/shared/templates.go).
export const colors = {
  // Linked two-party account marker; never used for money direction.
  sharedAccount: "#2563EB",
  // Backgrounds
  bgDefault: "#FFFFFF",
  bgMuted: "#FAFAFA",
  bgSubtle: "#F5F5F5",
  bgInverted: "#171717",

  // Text
  textEmphasis: "#171717",
  textDefault: "#404040",
  textSubtle: "#737373",
  textMuted: "#A3A3A3",
  textInverted: "#FFFFFF",

  // Borders — hairline everywhere
  borderSubtle: "#F5F5F5",
  borderDefault: "#E5E5E5",
  borderEmphasis: "#D4D4D4",

  // Direction / semantic. collect = money TOWARD you (emerald), pay = money
  // AWAY from you (garnet). *Bg is the soft tint behind chips + arrow chips;
  // *Text the readable chip label on that tint; *Strong the saturated accent
  // for the big balance numbers + arrows.
  collectBg: "#E8F4EF",
  collectText: "#0A5A46",
  collectStrong: "#0C745A",
  payBg: "#F8EAEC",
  payText: "#7E1B30",
  payStrong: "#A3203A",

  // Review state, independent of the money-direction colors above.
  pendingBg: "#FFF4CF",
  pendingText: "#856000",
  acceptedBg: "#E8F4EF",
  acceptedText: "#0A5A46",
  tallyHighlight: "#D4D4D4",
  rejectedBg: "#FBECEC",
  rejectedText: "#A34242",

  // Reserved for destructive actions only
  danger: "#DC2626",
} as const;

// memberTints — the ONLY place in the app where color identifies a PERSON
// rather than a direction or a danger.
//
// Why this exists at all, given the rule above that chrome stays monochrome:
// in a shared kaata the owner cannot tell their own tallies from their staff's
// without opening the Activity screen, and nobody opens the Activity screen.
// A name in text would have to compete with the amount and the date for the
// same trailing slot; a tinted initial reads at a glance and costs 20px.
//
// Constraints these six satisfy, and any future edit must keep:
//   - NO hue near emerald (collect) or garnet (pay). A member tint that reads
//     as a direction color would be worse than no tint at all: on a ledger row
//     that already encodes give/receive in color, a green-ish chip is a lie.
//     That rules out roughly 140-175° and 340-20°.
//   - The same soft-tint-plus-strong-ink construction as collectBg/collectText,
//     so a chip sits at the app's existing weight rather than shouting.
//   - Distinguishable from EACH OTHER at 20px, where all you see is a hue.
// Assigned deterministically from the account id (see lib/attribution.ts), so
// every member's phone paints the same person the same color.
//
// Mobile-only, and unlike `colors` above it needs NO counterpart in
// apps/web/src/theme.ts or internal/shared/templates.go: a shared bill and the
// web ledger view are one shopkeeper's statement to one customer, so there is
// nobody to tell apart there.
export const memberTints = [
  { bg: "#E8EAF7", fg: "#39409B" }, // indigo
  { bg: "#F7F0DF", fg: "#8A6108" }, // amber
  { bg: "#F2E9F6", fg: "#6E3A8C" }, // violet
  { bg: "#E2EFF8", fg: "#1B5E8C" }, // sky
  { bg: "#F2EBE4", fg: "#7A5433" }, // clay
  { bg: "#EEF1E2", fg: "#5A6B22" }, // olive
] as const;

export type MemberTint = (typeof memberTints)[number];
