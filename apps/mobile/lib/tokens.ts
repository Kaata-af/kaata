/**
 * App-wide design tokens.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * lib/design-tokens.ts already contained a good, fully-articulated design
 * language — but its own docblock scoped it to "settings-adjacent screens", and
 * only 8 files ever imported it, against ~50 for lib/colors.ts. Every surface it
 * reached (the nine vault screens, the settings sheets) is internally coherent;
 * every surface it didn't reach re-derived the same numbers as literals and
 * drifted by ±2-4px. Kaata never had a design problem. It had a DISTRIBUTION
 * problem.
 *
 * So these values are not new taste. They are the values the app already uses
 * most often, promoted to names. Adopting them is mostly DELETING literals, not
 * restyling — which is why this is a refinement and not a redesign.
 *
 * TWO COMPOSITIONS, ONE SCALE
 * ---------------------------
 * Do NOT flatten every screen to one look. The ledger surfaces (home, person,
 * entry) legitimately want denser rows, a bordered card and a 16px gutter;
 * settings legitimately wants flat rows, hairline dividers and 20px. They share
 * this scale and differ in composition. Making the ledger look like a settings
 * screen would be a downgrade, not consistency.
 *
 * RULES
 * -----
 *  1. No consumer writes `lineHeight` as a literal. Use `typography.*`, whose line
 *     heights already route through sansLineHeight()/monoLineHeight(). The
 *     whole app renders in Vazirmatn (English included) at 1.5625em natural
 *     metrics; Android trims the excess via includeFontPadding:false, iOS does
 *     NOT and CLIPS GLYPH TOPS. See lib/fonts.ts.
 *  2. No consumer writes `letterSpacing` on text that can be Persian. Tracking
 *     severs Arabic-script joining. Use trackingSafe(isRTL) from
 *     lib/direction.ts — and for USER-ENTERED content (names, shop names) use
 *     no tracking at all, since a customer can be named in Persian while the
 *     app is in English.
 *  3. Circles are `size / 2`, never a literal radius.
 *  4. Anything tappable clears TOUCH_MIN.
 */

import { fonts, monoLineHeight, sansLineHeight } from "./fonts";

// ─── Spacing ────────────────────────────────────────────────────────────────
//
// Measured frequency across app/ + components/: 8(90) · 12(76) · 14(68) ·
// 16(61) · 10(39) · 20(36) · 4(32) · 24(31) · 6(26) · 2(17) · 18(11) · 32(9).
// The 6/10/18/22 steps are the drift — each is within 2px of a neighbour that
// is 3-6x more common.
export const space = {
  /** Hairline gaps: icon-to-label inside a chip, badge insets. */
  xs: 4,
  /** Tight vertical rhythm: label→hint, stacked meta lines. */
  sm: 8,
  /** Default gap between related elements. */
  md: 12,
  /** Row vertical padding; the ledger gutter. */
  lg: 16,
  /** Settings gutter; section breathing room. */
  xl: 20,
  /** Hero screens (onboarding, restore, invite) horizontal gutter. */
  xxl: 24,
  /** Major vertical separation between blocks. */
  xxxl: 32,
} as const;

/** Screen gutters. The ledger and settings gutters differ ON PURPOSE — see
 *  "two compositions" above. Don't unify them. */
export const gutter = {
  ledger: space.lg, // 16 — home, person detail, entry forms
  settings: space.xl, // 20 — = SETTINGS_ROW_PADDING_X
  hero: space.xxl, // 24 — onboarding, restore, invite landing
} as const;

// ─── Typography ─────────────────────────────────────────────────────────────
//
// Measured: 13(59) · 12(51) · 14(49) · 15(48) · 11(20) · 22(10) · 20(8) ·
// 18(8) · 16(8) · 36(3) · 28(3) · 17(3) · 32(2) · 40(1).
//
// Every lineHeight here goes through the helpers, which keep the designed tight
// value on Android and floor iOS at the font's natural height. That is the
// single rule that makes the "raw lineHeight cleared the clip by 1px, by luck"
// class of bug unrepeatable.
export const typography = {
  /** Uppercase section headers. Pair with trackingSafe(isRTL). */
  caption: { fontSize: 11, fontFamily: fonts.sansSemi, lineHeight: sansLineHeight(11, 15) },
  /** Row hints, secondary meta. */
  hint: { fontSize: 12, fontFamily: fonts.sansRegular, lineHeight: sansLineHeight(12, 18) },
  /** Subtitles, list secondary lines. */
  bodySm: { fontSize: 13, fontFamily: fonts.sansRegular, lineHeight: sansLineHeight(13, 19) },
  /** Body copy. */
  body: { fontSize: 14, fontFamily: fonts.sansRegular, lineHeight: sansLineHeight(14, 20) },
  /** Standard row label. */
  label: { fontSize: 15, fontFamily: fonts.sansMedium, lineHeight: sansLineHeight(15, 22) },
  /** Emphasised row label, primary button text. */
  labelBold: { fontSize: 15, fontFamily: fonts.sansSemi, lineHeight: sansLineHeight(15, 22) },
  /** In-screen header title. = SETTINGS_HEADER_TITLE_FONT_SIZE. */
  title: { fontSize: 16, fontFamily: fonts.sansSemi, lineHeight: sansLineHeight(16, 22) },
  /** Screen headline (onboarding, restore, empty-state page variant). */
  heading: { fontSize: 20, fontFamily: fonts.sansSemi, lineHeight: sansLineHeight(20, 26) },
  /** Wordmark, shop name. NOTE: apply NO tracking — user-entered content. */
  display: { fontSize: 28, fontFamily: fonts.sansBold, lineHeight: sansLineHeight(28, 32) },

  // Numeric — JetBrains Mono. Amounts are always Latin digits (lib/format.ts
  // hardcodes toLocaleString("en-US")), so these may keep tracking in both
  // languages.
  /** The hero balance on person detail / home total. */
  numHero: { fontSize: 36, fontFamily: fonts.monoBold, lineHeight: monoLineHeight(36, 44) },
  /** Amount in a list row. */
  numRow: { fontSize: 15, fontFamily: fonts.monoSemi, lineHeight: monoLineHeight(15, 20) },
  /** Currency symbol, small numeric meta. */
  numMeta: { fontSize: 13, fontFamily: fonts.monoRegular, lineHeight: monoLineHeight(13, 18) },
} as const;

// ─── Radius ─────────────────────────────────────────────────────────────────
//
// Measured 15 distinct values: 8(36) · 12(14) · 999(9) · 2(6) · 10(6) · 14(5) ·
// 22(4) · 16(4) · 6(3) · 48(2) · 7 · 26 · 19 · 18 · 13. Everything except the
// six below is within 2px of one of them, or is a circle that should be
// expressed as size/2.
export const radius = {
  /** Sheet grabber pill only. */
  grabber: 2,
  /** Inputs, buttons, chips, small icon tiles. */
  sm: 8,
  /** Cards, hero buttons, icon wells. */
  md: 12,
  /** FLOATING inset surfaces: dialog card, toast. */
  lg: 16,
  /** Screen-ANCHORED sheet tops. = SETTINGS_SHEET_TOP_RADIUS.
   *  The 16-vs-18 adjacency is deliberate: a sheet welded to the screen edge
   *  carries a larger radius than a card floating inset from it. */
  sheet: 18,
  /** Badges, pill CTAs. */
  pill: 999,
} as const;

// ─── Icons ──────────────────────────────────────────────────────────────────
//
// Measured 15 distinct sizes: 22(15) · 40(8) · 16(7) · 18(5) · 36(4) · 28(4) ·
// 20(4) · 14(4) · 48(2) · 30(2) · 12(2) · 56 · 54 · 44.
export const icon = {
  /** Trailing chevron in a row. = SETTINGS_ROW_TRAILING_ICON_SIZE. */
  trailing: 16,
  /** Leading icon in a row. = SETTINGS_ROW_ICON_SIZE. */
  row: 22,
  /** Back chevron in an in-screen header. = SETTINGS_HEADER_ICON_SIZE. */
  header: 26,
  /** Provider marks, card leading icons. */
  card: 28,
  /** Empty states, full-screen status. */
  hero: 40,
} as const;

// ─── Touch targets ──────────────────────────────────────────────────────────

/** iOS HIG floor. EVERY tappable must clear this — pair with
 *  justifyContent:"center" when adding it to an existing control.
 *  = SETTINGS_MIN_TOUCH_TARGET. */
export const TOUCH_MIN = 44;

/** List-row minimum height; clears TOUCH_MIN with margin.
 *  = SETTINGS_ROW_MIN_HEIGHT. */
export const ROW_MIN = 52;

// ─── Elevation ──────────────────────────────────────────────────────────────

/**
 * ONE shadow recipe for lifted surfaces.
 *
 * The app currently has four different primary black buttons at three shadow
 * recipes plus a flat one, and flat-vs-lifted is the most legible difference
 * between two otherwise identical buttons. Anything that should read as
 * floating uses exactly this; everything else is flat.
 */
export const lift = {
  shadowColor: "#000",
  shadowOpacity: 0.16,
  shadowRadius: 14,
  shadowOffset: { width: 0, height: 5 },
  elevation: 4,
} as const;
