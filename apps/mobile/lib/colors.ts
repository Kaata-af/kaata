import brand from "../../_shared/brand-palette.json";

// Kaata's shared brand palette. Brand chrome never replaces the colors that
// carry ledger meaning: emerald/garnet direction, pending amber and danger.
// Reading surfaces remain white; Ivory is reserved for warm selected surfaces.
// Saffron is a highlight/background with Charcoal ink, never small light text.
//
// Khatabook flow-direction convention: collect = money TOWARD you (the
// to-collect balance + "I received" entries); pay = money AWAY from you (the
// to-pay balance + "I gave" entries). One color always means "money toward
// you", on balances AND entries. Kept in sync with the web app
// (apps/web/src/theme.ts) + the backend SSR ledger (internal/shared/templates.go).
export const colors = {
  brandPrimary: brand.aubergine,
  brandAccent: brand.saffron,
  bgWarm: brand.ivory,
  // True black is a provider/camera requirement, not Kaata's primary color.
  providerApple: "#000000",
  pressedOverlay: `${brand.charcoal}08`,
  // Linked two-party account marker; never used for money direction.
  sharedAccount: "#2563EB",
  // Backgrounds
  bgDefault: brand.white,
  bgMuted: "#FAF7F2",
  bgSubtle: "#F3EEE8",
  bgInverted: brand.charcoal,

  // Text
  textEmphasis: brand.charcoal,
  textDefault: brand.charcoal,
  textSubtle: "#706573",
  textMuted: "#756B78",
  textInverted: brand.white,

  // Borders — hairline everywhere
  borderSubtle: "#F3EEE8",
  borderDefault: "#E4DCE3",
  borderEmphasis: "#D2C6D0",

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

  // Review state of a shared tally, independent of the money-direction colors
  // above. Only pending gets a 6px dot (closed or opened); all opened states
  // retain a neutral status pill. Never a row tint or a button colour.
  // Accept uses the Aubergine primary, independent of money direction.
  // The darker pending amber retains contrast at this small size; brand
  // Saffron is too light on white for a status cue. Pinned by selftest:tally-ui.
  reviewPending: "#D29A00",
  reviewAccepted: "#0A5A46",
  reviewRejected: "#A34242",

  // The brief grey cue on a tally a notification opened (TallyHighlight).
  tallyHighlight: "#D4D4D4",

  // Reserved for destructive actions only
  danger: "#DC2626",
} as const;

// memberTints — the ONLY place in the app where color identifies a PERSON
// rather than a direction or a danger.
//
// Why this exists independently of brand chrome:
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
