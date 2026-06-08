/**
 * Settings design language — canonical tokens for settings-adjacent screens.
 *
 * Phase 7 consolidated settings into ProfileSettingsSheet (opens from the
 * profile avatar top-RIGHT of the home header) and a small set of pushed
 * screens (preferences, vault/*). This file documents the visual
 * contract those surfaces all share, and exports the magic numbers as
 * constants so individual screens don't redefine them.
 *
 * If you're building a new settings screen and reaching for a literal like
 * `paddingHorizontal: 20` or `minHeight: 52`, import the matching constant
 * from here instead. If a screen needs to deviate, deviate consciously and
 * leave a comment explaining why.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * STACK SCREEN PRESENTATION
 * ───────────────────────────────────────────────────────────────────────────
 * - presentation: "card" (default) — full-screen push, native back gesture
 *   enabled on iOS, hardware back on Android. ALL settings-adjacent
 *   sub-pages use this presentation: /preferences, /restore, /vault/new,
 *   /vault/settings, /vault/members, /vault/invite, /vault/audit-log,
 *   /vault/pair, /vault/pair-scan. Sticking to one presentation keeps the
 *   back-affordance mental model (chevron at top-left, never a swipe-down)
 *   consistent across the entire surface.
 * - headerShown: false — every settings screen renders its own in-screen
 *   header (see below). The native header is hidden because we need full
 *   control over typography, back-chevron icon, and trailing actions.
 * - Sheets (ProfileSettingsSheet, VaultPickerSheet, OptionSheet, etc.) are
 *   not pushed routes — they are inline <Modal> overlays. See the Sheet
 *   atoms section in ProfileSettingsSheet.tsx for that contract.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * IN-SCREEN HEADER
 * ───────────────────────────────────────────────────────────────────────────
 * - Height: SETTINGS_HEADER_HEIGHT (48-56px). The visible chrome is the back
 *   chevron + centered title + (optional) trailing action / spacer.
 * - Layout: flexDirection: "row", alignItems: "center",
 *   paddingHorizontal: 8 (the back-button's own 44x44 hit area takes care
 *   of pushing the title 44+8 = 52px in from the edge).
 * - Left: back chevron (Ionicons "chevron-back" / "chevron-forward" under
 *   RTL), 24-26px, colors.textEmphasis, wrapped in a 44×44 Pressable for
 *   touch target.
 * - Center: title, fonts.sansSemi, 16-17px, colors.textEmphasis,
 *   numberOfLines 1, textAlign: "center", flex: 1.
 * - Right: empty 44×44 spacer to keep the title visually centered. Replace
 *   with a trailing action (Done / Save) when needed.
 * - Divider: borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor:
 *   colors.borderSubtle. Always present so the user has a clear "this is
 *   where the chrome ends".
 *
 * ───────────────────────────────────────────────────────────────────────────
 * SECTIONS
 * ───────────────────────────────────────────────────────────────────────────
 * SectionHeader (one per logical group: DETAILS, MEMBERS, SYNC, …)
 * - fontFamily: fonts.sansSemi
 * - fontSize: 11
 * - color: colors.textSubtle
 * - letterSpacing: 0.6px
 * - textTransform: "uppercase"
 * - paddingHorizontal: SETTINGS_ROW_PADDING_X (20)
 * - paddingTop: 14
 * - paddingBottom: 8
 *
 * SectionGap (visual break between sections)
 * - height: SETTINGS_SECTION_GAP (4px)
 * - backgroundColor: colors.bgMuted
 * - marginTop: 12
 *
 * ───────────────────────────────────────────────────────────────────────────
 * ROWS
 * ───────────────────────────────────────────────────────────────────────────
 * NavRow (the workhorse: tappable list item)
 * - minHeight: SETTINGS_ROW_MIN_HEIGHT (52px)
 * - paddingHorizontal: SETTINGS_ROW_PADDING_X (20)
 * - paddingVertical: SETTINGS_ROW_PADDING_Y (14)
 * - flexDirection: "row" (row-reverse under RTL via rowDir())
 * - alignItems: "center"
 * - borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor:
 *   colors.borderSubtle. Last row in a section sets borderBottomWidth: 0.
 * - Pressed state: backgroundColor: colors.bgMuted (no ripple, no scale).
 *
 *   Children, left → right (LTR):
 *   1. Icon: Ionicons, size SETTINGS_ROW_ICON_SIZE (22), color textDefault
 *      by default (textEmphasis for emphasis variant, danger for
 *      destructive, textMuted for disabled). gap SETTINGS_ROW_ICON_GAP
 *      (14px) to label via marginRight (marginLeft under RTL).
 *   2. Text column (flex: 1):
 *      - Label: fonts.sansMedium 15px, color textDefault. Bumps to
 *        fonts.sansSemi on emphasis/bold/danger rows.
 *      - Hint (optional, single line): fonts.sansRegular 12px, color
 *        textSubtle, marginTop 2px.
 *   3. Trailing (optional):
 *      - chevron-forward (Ionicons, 18px, textMuted) for navigation
 *      - Switch for boolean toggles
 *      - ActivityIndicator for in-flight async
 *      - Short string status (fonts.sansRegular 13px, textMuted)
 *
 * IdentityRow (hero variant — signed-in user, current vault, etc.)
 * - minHeight: 64px
 * - Avatar: 44px circle (in-row) or 64px circle (hero).
 *
 * ───────────────────────────────────────────────────────────────────────────
 * COLOR USAGE
 * ───────────────────────────────────────────────────────────────────────────
 * - colors.textEmphasis — primary text, hero titles, active row labels, back
 *   chevron, identity name, emphasis-variant icons.
 * - colors.textDefault — standard row label.
 * - colors.textSubtle — section header text, hints, identity subtitle,
 *   inline status, version/about lines.
 * - colors.textMuted — icons in passive rows, trailing chevron, disabled
 *   label, trailing status strings.
 * - colors.danger — destructive actions (Sign out, Archive, Delete, Reset).
 *   Use for both label and icon.
 * - colors.bgDefault — screen and sheet body.
 * - colors.bgMuted — section gap bar, row pressed state, avatar fallback.
 * - colors.borderSubtle — hairline dividers (between rows, under header).
 * - colors.borderDefault — sheet top edge only — avoid inside settings
 *   screens; rows should use hairline dividers, not boxes.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * TYPOGRAPHY
 * ───────────────────────────────────────────────────────────────────────────
 * - fonts.sansBold — avatar initials (20px).
 * - fonts.sansSemi — section headers (11px uppercase), in-screen header
 *   titles (16-17px), identity name (16px), emphasis row labels (15px),
 *   active row labels (15px).
 * - fonts.sansMedium — standard row label (15px).
 * - fonts.sansRegular — hints (12px), identity subtitle (13px), status text
 *   (12-13px), version line (12px).
 * - fonts.monoRegular — payload/JSON viewers only (e.g. audit log expanded
 *   row). Never for primary labels.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * BORDER RADIUS
 * ───────────────────────────────────────────────────────────────────────────
 * - 0 between rows in a section. Rows are flat, separated by hairline
 *   dividers, not cards. Bordered "row boxes" are a legacy v0 pattern — do
 *   not add new ones.
 * - 18 for sheet top corners (BottomSheet, ProfileSettingsSheet,
 *   VaultPickerSheet).
 *
 * ───────────────────────────────────────────────────────────────────────────
 * TOUCH TARGETS & ACCESSIBILITY
 * ───────────────────────────────────────────────────────────────────────────
 * - Minimum 44pt (iOS HIG) for any tappable. The 52px row min-height clears
 *   this with margin; the 44×44 header back-button wrapper hits the floor
 *   exactly.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * RTL
 * ───────────────────────────────────────────────────────────────────────────
 * Apps/mobile is currently locked to LTR via I18nManager.forceRTL(false) in
 * app/_layout.tsx, but each row/header composes with rowDir(isRTL) /
 * textDir(isRTL) helpers so the day we unlock RTL the layouts flip
 * correctly without a rewrite. Margins that encode handedness (icon →
 * text gap, header chevron) must use the
 * isRTL ? { marginLeft: 14 } : { marginRight: 14 } shape, not bare margins.
 *
 * "I gave / + FAB stay on the RIGHT" invariants do not apply to settings
 * screens — those are home-screen cultural anchors. Settings screens follow
 * standard LTR/RTL reflow.
 */

// ─── Layout ─────────────────────────────────────────────────────────────────

/** In-screen header minimum height (does not include the safe-area top inset). */
export const SETTINGS_HEADER_HEIGHT = 48;

/** Minimum row height for NavRow and friends. Exceeds the 44pt HIG floor. */
export const SETTINGS_ROW_MIN_HEIGHT = 52;

/** Visual section break: a 4px bgMuted bar with a 12px top margin. */
export const SETTINGS_SECTION_GAP = 4;

/** Horizontal padding applied to header, rows, and section headers alike. */
export const SETTINGS_ROW_PADDING_X = 20;

/** Vertical padding inside a NavRow. Combined with minHeight to lock geometry. */
export const SETTINGS_ROW_PADDING_Y = 14;

/** Gap between a row's leading icon and its label. Mirror to marginLeft in RTL. */
export const SETTINGS_ROW_ICON_GAP = 14;

// ─── Avatars ────────────────────────────────────────────────────────────────

/** In-row avatar diameter (e.g. a vault row carrying a shop logo). */
export const SETTINGS_AVATAR_ROW = 36;

/** Hero avatar diameter (identity row at the top of ProfileSettingsSheet). */
export const SETTINGS_AVATAR_HERO = 44;

// ─── Typography ─────────────────────────────────────────────────────────────

/** Section header text size (uppercase, letter-spaced). */
export const SETTINGS_SECTION_HEADER_FONT_SIZE = 11;

/** Section header letter-spacing in points. */
export const SETTINGS_SECTION_HEADER_LETTER_SPACING = 0.6;

/** Section header top padding (above the label). */
export const SETTINGS_SECTION_HEADER_PADDING_TOP = 14;

/** Section header bottom padding (between label and first row). */
export const SETTINGS_SECTION_HEADER_PADDING_BOTTOM = 8;

/** In-screen header title size for standard settings pages. */
export const SETTINGS_HEADER_TITLE_FONT_SIZE = 16;

/** Standard row label font size. */
export const SETTINGS_ROW_LABEL_FONT_SIZE = 15;

/** Row hint (subtitle) font size. */
export const SETTINGS_ROW_HINT_FONT_SIZE = 12;

/** Margin between a row's label and its hint subtitle. */
export const SETTINGS_ROW_HINT_MARGIN_TOP = 2;

// ─── Icons ──────────────────────────────────────────────────────────────────

/** Leading icon size in a NavRow. */
export const SETTINGS_ROW_ICON_SIZE = 22;

/** Trailing chevron-forward size in a NavRow. */
export const SETTINGS_ROW_TRAILING_ICON_SIZE = 16;

/** Back chevron size in the in-screen header. */
export const SETTINGS_HEADER_ICON_SIZE = 26;

// ─── Touch targets & states ─────────────────────────────────────────────────

/** iOS HIG minimum touch target (used for header back / trailing buttons). */
export const SETTINGS_MIN_TOUCH_TARGET = 44;

/** Opacity applied to a disabled row. */
export const SETTINGS_DISABLED_OPACITY = 0.4;

// ─── Border radius ──────────────────────────────────────────────────────────

/** Row corners are flat — rows are separated by hairline dividers, not cards. */
export const SETTINGS_ROW_BORDER_RADIUS = 0;

/** Sheet top-edge corner radius (BottomSheet, ProfileSettingsSheet, etc.). */
export const SETTINGS_SHEET_TOP_RADIUS = 18;
