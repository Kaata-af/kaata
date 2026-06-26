// Shared ledger semantic palette for the web app — imported by BOTH
// tailwind.config.ts (the collect/pay utility tokens) and CustomerView.tsx
// (the runtime statement colors). Mirror of apps/mobile/lib/colors.ts and the
// backend SSR shell (apps/backend/internal/shared/templates.go — hand-kept in
// sync). "Emerald Vault & Garnet": a refined deep emerald + garnet pair.
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
