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

const config: Config = {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
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
      },
      fontFamily: {
        sans: ['"Inter"', "system-ui", "-apple-system", "sans-serif"],
        mono: ['"JetBrains Mono"', "ui-monospace", "Menlo", "monospace"],
      },
    },
  },
  plugins: [],
};

export default config;
