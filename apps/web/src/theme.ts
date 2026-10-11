import palette from "../../_shared/brand-palette.json";

// One brand palette for product, web and marketing. Derived neutrals keep
// secondary text readable; saffron is a highlight, never body text on white.
export const brand = {
  ...palette,
  primary: palette.aubergine,
  hover: "#3B2140",
  faint: "#F3EEE8",
  border: "#E4DCE3",
  ink: palette.charcoal,
  sub: "#706573",
  muted: "#756B78",
} as const;

// Shared ledger semantic palette for the web app — imported by BOTH
// tailwind.config.ts (the collect/pay utility tokens) and CustomerView.tsx
// (the runtime statement colors). Mirror of apps/mobile/lib/colors.ts and the
// backend SSR shell (apps/backend/internal/shared/templates.go — hand-kept in
// sync). These direction colors carry financial meaning separately from brand.
//
// Khatabook flow-direction convention: collect = money TOWARD you (the
// to-collect balance + "I received"); pay = money AWAY from you (to-pay + "I
// gave").
//   bg     soft tint behind chips / arrow chips
//   text   readable chip label on the soft tint
//   strong accent for the balance number + arrows
export const ledger = {
  collectBg: "#E8F4EF",
  collectText: "#0A5A46",
  collectStrong: "#0C745A",
  payBg: "#F8EAEC",
  payText: "#7E1B30",
  payStrong: "#A3203A",
} as const;
