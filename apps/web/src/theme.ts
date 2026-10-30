// Web chrome follows shadcn's neutral theme. Keep these compatibility names
// for existing pages and Tremor; the marketing palette remains independent in
// apps/_shared/brand-palette.json for flyers and social material.
export const brand = {
  aubergine: "#171717",
  saffron: "#F5F5F5",
  ivory: "#FAFAFA",
  charcoal: "#171717",
  white: "#FFFFFF",
  primary: "#171717",
  hover: "#262626",
  faint: "#F5F5F5",
  border: "#E5E5E5",
  ink: "#171717",
  sub: "#525252",
  muted: "#737373",
} as const;

// Reading surfaces and entry actions mirror the current mobile palette.
// These roles stay separate from balance direction and marketing colors.
export const surface = {
  base: "#FFFFFF",
  muted: "#F7F7F7",
  subtle: "#EFEFEF",
  balance: "#F6F9F7",
  balanceBorder: "#DBE4DF",
} as const;

export const entryAction = {
  gave: { bg: "#F8EAEC", text: "#A3203A", coin: "#F1DADE" },
  received: { bg: "#E4EEE6", text: "#3E6149", coin: "#CDDFD1" },
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
