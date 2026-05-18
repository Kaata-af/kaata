// Design tokens, adapted from dub.co's system.
// Monochrome chrome — black/white/neutral grays. Color appears only in:
//   - direction chips (collect / pay), as pastel tints
//   - the danger color (delete only), as a saturated red
// Loud color never appears on balance numbers, buttons, or section headers.

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

  // Direction chips — soft tints, used as backgrounds for small badges
  collectBg: "#ECFDF5",
  collectText: "#065F46",
  payBg: "#FEF3C7",
  payText: "#78350F",

  // Reserved for destructive actions only
  danger: "#DC2626",
} as const;
