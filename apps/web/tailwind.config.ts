import type { Config } from "tailwindcss";
import { brand, ledger } from "./src/theme";

// shadcn CSS-variable tokens and Tailwind's genuine neutral scale power the
// web. Existing brand utilities are compatibility aliases to neutral colors.
// Financial directions and chart series keep their own semantic colors.
//
// Tremor (admin dashboard kit): its components style themselves with
// tremor-* theme tokens + Tailwind classes shipped inside node_modules —
// both the content glob and the token block below are required or the
// admin UI renders unstyled. Tokens follow Tremor v3's documented theme
// shape, tinted to our quiet-fintech neutrals.

const config: Config = {
  // Light-only web UI: Tremor's optional dark classes must not follow OS
  // dark mode independently of the page's declared light color scheme.
  darkMode: "class",
  content: ["./index.html", "./src/**/*.{ts,tsx}", "./node_modules/@tremor/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      colors: {
        brand,
        border: "hsl(var(--border))",
        input: "hsl(var(--input))",
        ring: "hsl(var(--ring))",
        background: "hsl(var(--background))",
        foreground: "hsl(var(--foreground))",
        primary: { DEFAULT: "hsl(var(--primary))", foreground: "hsl(var(--primary-foreground))" },
        secondary: {
          DEFAULT: "hsl(var(--secondary))",
          foreground: "hsl(var(--secondary-foreground))",
        },
        destructive: {
          DEFAULT: "hsl(var(--destructive))",
          foreground: "hsl(var(--destructive-foreground))",
        },
        muted: { DEFAULT: "hsl(var(--muted))", foreground: "hsl(var(--muted-foreground))" },
        accent: { DEFAULT: "hsl(var(--accent))", foreground: "hsl(var(--accent-foreground))" },
        popover: { DEFAULT: "hsl(var(--popover))", foreground: "hsl(var(--popover-foreground))" },
        card: { DEFAULT: "hsl(var(--card))", foreground: "hsl(var(--card-foreground))" },
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
            faint: brand.faint,
            muted: brand.border,
            subtle: "#A3A3A3",
            DEFAULT: brand.primary,
            emphasis: brand.hover,
            inverted: brand.white,
          },
          background: {
            muted: brand.ivory,
            subtle: brand.faint,
            DEFAULT: brand.white,
            emphasis: brand.charcoal,
          },
          border: { DEFAULT: brand.border },
          ring: { DEFAULT: brand.border },
          content: {
            subtle: brand.muted,
            DEFAULT: brand.sub,
            emphasis: brand.charcoal,
            strong: brand.charcoal,
            inverted: brand.white,
          },
        },
      },
      boxShadow: {
        "tremor-input": "0 1px 2px 0 rgb(0 0 0 / 0.05)",
        "tremor-card": "0 1px 3px 0 rgb(0 0 0 / 0.06), 0 1px 2px -1px rgb(0 0 0 / 0.06)",
        "tremor-dropdown": "0 4px 6px -1px rgb(0 0 0 / 0.1), 0 2px 4px -2px rgb(0 0 0 / 0.1)",
      },
      borderRadius: {
        lg: "var(--radius)",
        md: "calc(var(--radius) - 2px)",
        sm: "calc(var(--radius) - 4px)",
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
