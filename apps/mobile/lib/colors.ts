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

  // Reserved for destructive actions only
  danger: "#DC2626",
} as const;
