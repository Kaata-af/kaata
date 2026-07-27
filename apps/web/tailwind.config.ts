import type { Config } from "tailwindcss";
import { ledger } from "./src/theme";

// Design system mirrors the mobile app (apps/mobile/lib/colors.ts).
// Most neutrals come straight from Tailwind's built-in `neutral` palette,
// which happens to match our mobile tokens exactly:
//   bgMuted    = neutral-50  (#FAFAFA)
//   bgSubtle   = neutral-100 (#F5F5F5)
//   border     = neutral-200 (#E5E5E5)
//   textMuted  = neutral-400 (#A3A3A3)
//   textSubtle = neutral-500 (#737373)
//   textDefault= neutral-700 (#404040)
//   textEmphasis / bgInverted = neutral-900 (#171717)
//
// Only the semantic chip colors and danger are added as explicit tokens.
//
// Tremor (admin dashboard kit): its components style themselves with
// tremor-* theme tokens + Tailwind classes shipped inside node_modules —
// both the content glob and the token block below are required or the
// admin UI renders unstyled. Tokens follow Tremor v3's documented theme
// shape, tinted to our quiet-fintech neutrals.

const config: Config = {
  content: ["./index.html", "./src/**/*.{ts,tsx}", "./node_modules/@tremor/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      colors: {
        // Direction tokens come from the shared ledger palette (src/theme.ts),
        // mirrored in CustomerView + the mobile app. collect = money toward you;
        // pay = money away. `strong` is the accent for numbers/arrows; `bg`/`text`
        // are the soft chip pair.
        collect: { bg: ledger.collectBg, text: ledger.collectText, strong: ledger.collectStrong },
        pay: { bg: ledger.payBg, text: ledger.payText, strong: ledger.payStrong },
        danger: "#DC2626",
        // --- Tremor v3 theme tokens (light only — admin is light-theme) ---
        tremor: {
          brand: {
            faint: "#eff6ff",
            muted: "#bfdbfe",
            subtle: "#60a5fa",
            DEFAULT: "#2a78d6",
            emphasis: "#1d4ed8",
            inverted: "#ffffff",
          },
          background: {
            muted: "#f9fafb",
            subtle: "#f2f4f7",
            DEFAULT: "#ffffff",
            emphasis: "#101828",
          },
          border: { DEFAULT: "#eaecf0" },
          ring: { DEFAULT: "#eaecf0" },
          content: {
            subtle: "#98a2b3",
            DEFAULT: "#475467",
            emphasis: "#101828",
            strong: "#101828",
            inverted: "#ffffff",
          },
        },
      },
      boxShadow: {
        "tremor-input": "0 1px 2px 0 rgb(0 0 0 / 0.05)",
        "tremor-card": "0 1px 3px 0 rgb(0 0 0 / 0.06), 0 1px 2px -1px rgb(0 0 0 / 0.06)",
        "tremor-dropdown": "0 4px 6px -1px rgb(0 0 0 / 0.1), 0 2px 4px -2px rgb(0 0 0 / 0.1)",
      },
      borderRadius: {
        "tremor-small": "0.375rem",
        "tremor-default": "0.5rem",
        "tremor-full": "9999px",
      },
      fontSize: {
        "tremor-label": ["0.75rem", { lineHeight: "1rem" }],
        "tremor-default": ["0.875rem", { lineHeight: "1.25rem" }],
        "tremor-title": ["1.125rem", { lineHeight: "1.75rem" }],
        "tremor-metric": ["1.875rem", { lineHeight: "2.25rem" }],
      },
      fontFamily: {
        sans: ['"Inter"', "system-ui", "-apple-system", "sans-serif"],
        mono: ['"JetBrains Mono"', "ui-monospace", "Menlo", "monospace"],
      },
    },
  },
  safelist: [
    // Tremor colors arrive as runtime props (color="emerald" etc.) that the
    // content scan can't see — safelist the families the admin app uses.
    {
      pattern:
        /^(bg|text|fill|stroke|border|ring)-(blue|emerald|red|amber|neutral|gray|slate)-(50|100|200|300|400|500|600|700|800|900)$/,
    },
  ],
  plugins: [],
};

export default config;
