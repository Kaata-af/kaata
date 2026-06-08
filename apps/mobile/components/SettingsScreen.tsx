import { Ionicons } from "@expo/vector-icons";
import type { ComponentProps, ReactNode } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { colors } from "../lib/colors";
import {
  SETTINGS_HEADER_HEIGHT,
  SETTINGS_HEADER_ICON_SIZE,
  SETTINGS_HEADER_TITLE_FONT_SIZE,
  SETTINGS_MIN_TOUCH_TARGET,
  SETTINGS_ROW_HINT_FONT_SIZE,
  SETTINGS_ROW_HINT_MARGIN_TOP,
  SETTINGS_ROW_ICON_GAP,
  SETTINGS_ROW_ICON_SIZE,
  SETTINGS_ROW_LABEL_FONT_SIZE,
  SETTINGS_ROW_MIN_HEIGHT,
  SETTINGS_ROW_PADDING_X,
  SETTINGS_ROW_PADDING_Y,
  SETTINGS_SECTION_GAP,
  SETTINGS_SECTION_HEADER_FONT_SIZE,
  SETTINGS_SECTION_HEADER_LETTER_SPACING,
  SETTINGS_SECTION_HEADER_PADDING_BOTTOM,
  SETTINGS_SECTION_HEADER_PADDING_TOP,
} from "../lib/design-tokens";
import { rowDir, textDir } from "../lib/direction";
import { fonts } from "../lib/fonts";

// Settings-screen design atoms — extracted from ProfileSettingsSheet's
// design DNA so vault/* and preferences screens share one source of
// truth. See lib/design-tokens.ts for the visual contract these atoms
// implement; the tokens (paddingX, row min height, font sizes, etc.) are
// the public surface — change them there, not here.
//
// All four atoms accept an `isRTL` prop for direction handling. The app
// is currently locked to LTR (see app/_layout.tsx) but each atom
// composes via rowDir() / textDir() so the day RTL unlocks, layouts
// reflow without a rewrite.

// --------------------------------------------------------------------------
// ScreenHeader — back chevron LEFT, centered title, right-side spacer.
// Used at the top of every pushed settings sub-page (vault/settings,
// vault/members, vault/invite, vault/audit-log, preferences, restore).
// The 44×44 back-button wrapper hits the iOS HIG minimum touch target;
// the trailing 44px spacer keeps the title visually centered.
// --------------------------------------------------------------------------
export function ScreenHeader(props: {
  title: string;
  /** When null, the back chevron + tap target are hidden. Used by
   * forced-context screens (e.g. /vault/new?forced=1 after archiving
   * the last Kaata) where there is no parent to pop back to. The 44px
   * leading spacer is preserved so the title's optical center stays
   * aligned with the other settings sub-pages. */
  onBack: (() => void) | null;
  isRTL: boolean;
  backLabel?: string;
  /** Optional right-side trailing element (text button or icon). */
  trailing?: ReactNode;
}) {
  return (
    <View style={[styles.header, rowDir(props.isRTL)]}>
      {props.onBack != null ? (
        <Pressable
          onPress={props.onBack}
          hitSlop={8}
          style={({ pressed }) => [styles.headerBack, pressed && { opacity: 0.5 }]}
          accessibilityRole="button"
          accessibilityLabel={props.backLabel ?? "Back"}
        >
          <Ionicons
            name={props.isRTL ? "chevron-forward" : "chevron-back"}
            size={SETTINGS_HEADER_ICON_SIZE}
            color={colors.textEmphasis}
          />
        </Pressable>
      ) : (
        <View style={styles.headerBack} />
      )}
      <Text style={styles.headerTitle} numberOfLines={1}>
        {props.title}
      </Text>
      {props.trailing ? (
        <View style={styles.headerRightSlot}>{props.trailing}</View>
      ) : (
        <View style={styles.headerRightSpacer} />
      )}
    </View>
  );
}

// --------------------------------------------------------------------------
// SectionHeader — uppercase, letter-spaced 11px label introducing a
// group of NavRows. Optional trailing string label rendered at the
// opposite end (e.g. "5 min ago" on the SYNC section header).
// --------------------------------------------------------------------------
export function SectionHeader(props: { label: string; isRTL: boolean; trailing?: string }) {
  if (!props.trailing) {
    return <Text style={[styles.sectionHeader, textDir(props.isRTL)]}>{props.label}</Text>;
  }
  return (
    <View style={[styles.sectionHeaderRow, rowDir(props.isRTL)]}>
      <Text style={[styles.sectionHeader, styles.sectionHeaderInRow, textDir(props.isRTL)]}>
        {props.label}
      </Text>
      <Text style={[styles.sectionHeaderTrailing, textDir(props.isRTL)]} numberOfLines={1}>
        {props.trailing}
      </Text>
    </View>
  );
}

// --------------------------------------------------------------------------
// SectionGap — 4px bgMuted bar with 12px top margin between sections.
// --------------------------------------------------------------------------
export function SectionGap() {
  return <View style={styles.sectionGap} />;
}

// --------------------------------------------------------------------------
// NavRow — the workhorse list item. Icon left, label + optional hint
// middle, optional trailing element right (chevron, string status,
// ActivityIndicator, or any ReactNode). Hairline divider under every
// row except `isLast`. Variants:
//   - emphasis: label and icon bump to textEmphasis + sansSemi
//   - bold: label upgrades to sansSemi (same color)
//   - danger: red label + icon for destructive actions
//   - disabled: textMuted color, no press feedback, onPress ignored
// --------------------------------------------------------------------------
export function NavRow(props: {
  icon: ComponentProps<typeof Ionicons>["name"];
  iconColor?: string;
  label: string;
  hint?: string;
  trailing?: string | ReactNode;
  onPress: () => void;
  isRTL: boolean;
  disabled?: boolean;
  bold?: boolean;
  emphasis?: boolean;
  danger?: boolean;
  isLast?: boolean;
  /**
   * Optional a11y hint surfaced to screen readers (e.g. "Replace local
   * data with cloud copy"). Defaults to undefined; only set this when
   * the consequence of the row isn't obvious from the label alone.
   */
  accessibilityHint?: string;
  /**
   * Override the announced a11y label. Defaults to `props.label`.
   * Useful when the visible label is a section-header phrase that
   * doesn't read well via TalkBack.
   */
  accessibilityLabel?: string;
}) {
  const color = props.disabled
    ? colors.textMuted
    : props.danger
      ? colors.danger
      : props.emphasis
        ? colors.textEmphasis
        : colors.textDefault;
  const iconColor = props.iconColor ?? color;
  return (
    <Pressable
      onPress={props.disabled ? undefined : props.onPress}
      disabled={props.disabled}
      accessibilityRole="button"
      accessibilityLabel={props.accessibilityLabel ?? props.label}
      accessibilityHint={props.accessibilityHint}
      accessibilityState={{ disabled: !!props.disabled }}
      style={({ pressed }) => [
        styles.navRow,
        rowDir(props.isRTL),
        !props.isLast && styles.navRowDivider,
        pressed && !props.disabled && { backgroundColor: colors.bgMuted },
      ]}
    >
      <Ionicons
        name={props.icon}
        size={SETTINGS_ROW_ICON_SIZE}
        color={iconColor}
        style={
          props.isRTL
            ? { marginLeft: SETTINGS_ROW_ICON_GAP }
            : { marginRight: SETTINGS_ROW_ICON_GAP }
        }
      />
      <View style={styles.navRowTextCol}>
        <Text
          style={[
            styles.navRowLabel,
            textDir(props.isRTL),
            { color },
            (props.bold || props.emphasis || props.danger) && {
              fontFamily: fonts.sansSemi,
            },
          ]}
          numberOfLines={1}
        >
          {props.label}
        </Text>
        {props.hint ? (
          <Text
            style={[
              styles.navRowHint,
              textDir(props.isRTL),
              props.disabled && { color: colors.textMuted },
            ]}
            numberOfLines={1}
          >
            {props.hint}
          </Text>
        ) : null}
      </View>
      {typeof props.trailing === "string" ? (
        <Text
          style={[
            styles.navRowTrailing,
            textDir(props.isRTL),
            props.disabled && { color: colors.textMuted },
          ]}
          numberOfLines={1}
        >
          {props.trailing}
        </Text>
      ) : (
        (props.trailing ?? null)
      )}
    </Pressable>
  );
}

// --------------------------------------------------------------------------
// EmptyHint — quiet single-line message used when a section has no
// rows to render (e.g. "No members yet" before an invite has been
// accepted). Sized to live inside a section but lighter than a NavRow.
// --------------------------------------------------------------------------
export function EmptyHint(props: { label: string; isRTL: boolean }) {
  return <Text style={[styles.emptyHint, textDir(props.isRTL)]}>{props.label}</Text>;
}

// --------------------------------------------------------------------------
// Styles — token-driven. Keep these 1:1 with ProfileSettingsSheet so
// the sheet and the pushed sub-pages read as one coherent surface.
// --------------------------------------------------------------------------

const styles = StyleSheet.create({
  // Header ----------------------------------------------------------------
  header: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 8,
    paddingVertical: 8,
    minHeight: SETTINGS_HEADER_HEIGHT,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.borderSubtle,
  },
  headerBack: {
    width: SETTINGS_MIN_TOUCH_TARGET,
    height: SETTINGS_MIN_TOUCH_TARGET,
    alignItems: "center",
    justifyContent: "center",
  },
  headerTitle: {
    flex: 1,
    fontSize: SETTINGS_HEADER_TITLE_FONT_SIZE,
    fontFamily: fonts.sansSemi,
    color: colors.textEmphasis,
    textAlign: "center",
  },
  headerRightSpacer: {
    width: SETTINGS_MIN_TOUCH_TARGET,
    height: SETTINGS_MIN_TOUCH_TARGET,
  },
  headerRightSlot: {
    minWidth: SETTINGS_MIN_TOUCH_TARGET,
    height: SETTINGS_MIN_TOUCH_TARGET,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 8,
  },

  // Section ---------------------------------------------------------------
  sectionHeader: {
    fontSize: SETTINGS_SECTION_HEADER_FONT_SIZE,
    fontFamily: fonts.sansSemi,
    color: colors.textSubtle,
    paddingHorizontal: SETTINGS_ROW_PADDING_X,
    paddingTop: SETTINGS_SECTION_HEADER_PADDING_TOP,
    paddingBottom: SETTINGS_SECTION_HEADER_PADDING_BOTTOM,
    textTransform: "uppercase",
    letterSpacing: SETTINGS_SECTION_HEADER_LETTER_SPACING,
  },
  // Two-column header variant for SectionHeader with `trailing`. Padding
  // moves to the row so the text doesn't double-pad against the parent.
  sectionHeaderRow: {
    flexDirection: "row",
    alignItems: "baseline",
    paddingHorizontal: SETTINGS_ROW_PADDING_X,
    paddingTop: SETTINGS_SECTION_HEADER_PADDING_TOP,
    paddingBottom: SETTINGS_SECTION_HEADER_PADDING_BOTTOM,
  },
  sectionHeaderInRow: {
    flex: 1,
    paddingHorizontal: 0,
    paddingTop: 0,
    paddingBottom: 0,
  },
  sectionHeaderTrailing: {
    fontSize: SETTINGS_SECTION_HEADER_FONT_SIZE,
    fontFamily: fonts.sansSemi,
    color: colors.textMuted,
    textTransform: "uppercase",
    letterSpacing: SETTINGS_SECTION_HEADER_LETTER_SPACING,
    marginLeft: 12,
  },
  sectionGap: {
    height: SETTINGS_SECTION_GAP,
    backgroundColor: colors.bgMuted,
    marginTop: 12,
  },

  // NavRow ----------------------------------------------------------------
  navRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: SETTINGS_ROW_PADDING_X,
    paddingVertical: SETTINGS_ROW_PADDING_Y,
    minHeight: SETTINGS_ROW_MIN_HEIGHT,
  },
  navRowDivider: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.borderSubtle,
  },
  navRowTextCol: { flex: 1 },
  navRowLabel: {
    fontSize: SETTINGS_ROW_LABEL_FONT_SIZE,
    fontFamily: fonts.sansMedium,
  },
  navRowHint: {
    fontSize: SETTINGS_ROW_HINT_FONT_SIZE,
    fontFamily: fonts.sansRegular,
    color: colors.textSubtle,
    marginTop: SETTINGS_ROW_HINT_MARGIN_TOP,
  },
  navRowTrailing: {
    fontSize: 13,
    fontFamily: fonts.sansRegular,
    color: colors.textMuted,
    marginLeft: 8,
    maxWidth: 160,
  },

  emptyHint: {
    fontSize: 13,
    fontFamily: fonts.sansRegular,
    color: colors.textSubtle,
    paddingHorizontal: SETTINGS_ROW_PADDING_X,
    paddingVertical: 10,
  },
});
