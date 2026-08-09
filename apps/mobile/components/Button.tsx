// components/Button.tsx
//
// The app's one button.
//
// It already existed and was already imported by 15 screens — but every
// high-traffic CTA bypassed it and re-rolled a Pressable with its own geometry:
// radius 8 here vs 12 on restore/person-detail vs 14 on onboarding vs 999 on
// the archived-list pill; heights 44 / 52 / 60; and flat here vs three
// different shadow recipes elsewhere. A shopkeeper walking onboarding → home →
// person detail → entry form met the same black pill at four corner radii,
// three heights, and flat-vs-lifted. Flat-vs-lifted is the most legible
// difference between two otherwise identical buttons, which is why it read as
// four different components rather than one.
//
// The variants below exist so those call sites have somewhere to land WITHOUT
// changing how they look — `hero` is the 52px lifted CTA the ledger screens
// want, `pill` is the fully-rounded list CTA. One shadow recipe (tokens `lift`)
// is shared by every lifted variant.

import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import type { ComponentProps } from "react";
import { Ionicons } from "@expo/vector-icons";
import { colors } from "../lib/colors";
import { icon as iconSize, lift, radius, TOUCH_MIN, typography } from "../lib/tokens";

/**
 * Colour intent.
 *  - primary   — filled bgInverted. The one action a screen wants.
 *  - secondary — white + hairline border. A real alternative to primary.
 *  - muted     — filled bgMuted, no border. The quiet in-list CTA (Restore,
 *                Retry). Distinct from `secondary` on purpose: a row that is
 *                unavailable *here* renders as the bordered outline, while an
 *                available one stays filled — a distinction three list screens
 *                relied on and which collapses into an indistinguishable pair
 *                if both map to the same variant.
 *  - danger    — filled danger. Destructive confirmation only.
 */
type Variant = "primary" | "secondary" | "muted" | "danger";

/**
 * Geometry.
 *  - md   — the default 44px control. Forms, sheets, secondary actions.
 *  - hero — 52px, radius.md, LIFTED. The single primary action on a screen
 *           whose whole job is that action (person detail's give/receive,
 *           onboarding's continue, restore's confirm).
 *  - pill — fully rounded, for a CTA sitting INSIDE A LIST ROW. Compact by
 *           design: it keeps the 44pt touch floor via hitSlop rather than
 *           height, because a 44px-tall control in a ~56px row swallows the
 *           row. The first migration onto this component gave pill the default
 *           44px box and a 15px label, which grew every Restore pill by ~10px,
 *           jumped its label 13→15, and dropped its minWidth so the pills
 *           stopped aligning down the list.
 */
type Size = "md" | "hero" | "pill";

/** Restores the 44pt target that `pill`'s compact box gives up in height. */
const PILL_HIT_SLOP = { top: 6, bottom: 6, left: 8, right: 8 } as const;

export function Button(props: {
  label: string;
  onPress: () => void;
  variant?: Variant;
  size?: Size;
  disabled?: boolean;
  loading?: boolean;
  /** Optional leading icon. Sized to the label, never to icon.row. */
  icon?: ComponentProps<typeof Ionicons>["name"];
  /** Stretch to the container's width. Hero CTAs usually want this. */
  fullWidth?: boolean;
  /** Announced instead of `label` when the visible text is terse ("×", "Go"). */
  accessibilityLabel?: string;
}) {
  const { label, onPress, variant = "primary", size = "md", disabled, loading, fullWidth } = props;

  const isPrimary = variant === "primary";
  const isDanger = variant === "danger";
  const isMuted = variant === "muted";
  const bg = isPrimary
    ? colors.bgInverted
    : isDanger
      ? colors.danger
      : isMuted
        ? colors.bgMuted
        : colors.bgDefault;
  const fg = isPrimary || isDanger ? colors.textInverted : colors.textEmphasis;
  // muted is a FILL, so it carries no border — a bordered fill reads as two
  // competing edges at pill radius.
  const borderColor = isPrimary || isDanger || isMuted ? "transparent" : colors.borderDefault;

  // Only filled buttons lift. A lifted outline button reads as a mistake, and
  // a shadow under a transparent surface shows through the border.
  const lifted = size === "hero" && (isPrimary || isDanger);

  return (
    <Pressable
      onPress={onPress}
      disabled={disabled || loading}
      hitSlop={size === "pill" ? PILL_HIT_SLOP : undefined}
      accessibilityRole="button"
      accessibilityState={{ disabled: Boolean(disabled || loading), busy: Boolean(loading) }}
      accessibilityLabel={props.accessibilityLabel ?? label}
      style={({ pressed }) => [
        styles.btn,
        size === "hero" && styles.hero,
        size === "pill" && styles.pill,
        fullWidth && styles.fullWidth,
        { backgroundColor: bg, borderColor },
        lifted && lift,
        pressed && { opacity: 0.85 },
        (disabled || loading) && { opacity: 0.5 },
      ]}
    >
      {loading ? (
        <ActivityIndicator color={fg} size={size === "pill" ? "small" : undefined} />
      ) : (
        <View style={styles.content}>
          {props.icon ? <Ionicons name={props.icon} size={iconSize.trailing} color={fg} /> : null}
          <Text
            style={[styles.text, size === "pill" && styles.textPill, { color: fg }]}
            numberOfLines={1}
          >
            {label}
          </Text>
        </View>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  btn: {
    minHeight: TOUCH_MIN,
    paddingHorizontal: 16,
    borderRadius: radius.sm,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  // 52 matches the ping bar and the FAB — the other two "this is THE action"
  // controls in the app — so a hero CTA lines up with them optically.
  hero: { minHeight: 52, paddingHorizontal: 20, borderRadius: radius.md },
  // Compact list-row CTA: overrides the 44px floor with its own 34px box and
  // buys the touch target back with PILL_HIT_SLOP. minWidth keeps a column of
  // pills aligned down a list even when their labels differ in length.
  pill: {
    borderRadius: radius.pill,
    paddingHorizontal: 18,
    minHeight: 34,
    minWidth: 84,
  },
  fullWidth: { alignSelf: "stretch" },
  // Row, but NOT via rowDir(): a leading icon on a button is decoration bound
  // to the label, not a layout that should flip with script. The whole
  // icon+label group is centred, so it reads correctly in both directions.
  content: { flexDirection: "row", alignItems: "center", gap: 8 },
  text: { ...typography.labelBold },
  // 13px sansSemi — the size list-row CTAs used before this component existed.
  // 15px is right for a standalone button and too loud inside a row.
  textPill: { ...typography.bodySm, fontFamily: typography.labelBold.fontFamily },
});
