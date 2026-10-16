import { Ionicons } from "@expo/vector-icons";
import type { ReactNode } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { colors } from "../lib/colors";
import { rowDir, textDir, useIsRTL } from "../lib/direction";
import { t } from "../lib/i18n";
import { radius, TOUCH_MIN, typography } from "../lib/tokens";

// One visual language for setup and its optional sign-in/recovery branches.
// The screen owns safe areas and keyboard handling; these are only UI pieces.
export function OnboardingHeader({
  onBack,
  disabled = false,
  backLabel,
}: {
  onBack?: () => void;
  disabled?: boolean;
  backLabel?: string;
}) {
  const isRTL = useIsRTL();
  const label = backLabel ?? t("common.back");
  return (
    <View style={[styles.header, rowDir(isRTL)]}>
      {onBack ? (
        <Pressable
          onPress={onBack}
          disabled={disabled}
          accessibilityRole="button"
          accessibilityLabel={label}
          accessibilityState={{ disabled }}
          style={({ pressed }) => [
            styles.back,
            rowDir(isRTL),
            pressed && styles.pressed,
            disabled && styles.disabled,
          ]}
        >
          <Ionicons
            name={isRTL ? "chevron-forward" : "chevron-back"}
            size={18}
            color={colors.textSubtle}
          />
          <Text style={[styles.backLabel, textDir(isRTL)]}>{label}</Text>
        </Pressable>
      ) : null}
      <Text style={[styles.brand, textDir(isRTL)]}>{t("brand.wordmark")}</Text>
    </View>
  );
}

export function OnboardingIntro({
  title,
  description,
  children,
  align = "start",
}: {
  title: string;
  description?: string;
  children?: ReactNode;
  align?: "start" | "center";
}) {
  const isRTL = useIsRTL();
  return (
    <View style={styles.intro}>
      <Text
        style={[styles.title, textDir(isRTL), align === "center" && styles.centered]}
        accessibilityRole="header"
      >
        {title}
      </Text>
      {description ? (
        <Text style={[styles.description, textDir(isRTL), align === "center" && styles.centered]}>
          {description}
        </Text>
      ) : null}
      {children}
    </View>
  );
}

export function OnboardingAction({
  label,
  onPress,
  loading = false,
  disabled = false,
  variant = "primary",
}: {
  label: string;
  onPress: () => void;
  loading?: boolean;
  disabled?: boolean;
  variant?: "primary" | "outline" | "ghost";
}) {
  const isRTL = useIsRTL();
  const inactive = loading || disabled;
  const foreground = variant === "primary" ? colors.textInverted : colors.textEmphasis;
  return (
    <Pressable
      onPress={onPress}
      disabled={inactive}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: inactive, busy: loading }}
      style={({ pressed }) => [
        styles.action,
        variant === "primary" ? styles.primary : variant === "outline" ? styles.outline : null,
        pressed && (variant === "primary" ? styles.pressedPrimary : styles.pressed),
        inactive && styles.disabled,
      ]}
    >
      {loading ? (
        <ActivityIndicator
          size="small"
          color={foreground}
          style={[styles.spinner, isRTL ? { right: 16 } : { left: 16 }]}
        />
      ) : null}
      <Text style={[styles.actionLabel, { color: foreground }]}>{label}</Text>
    </Pressable>
  );
}

export const onboardingStyles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bgDefault },
  content: {
    flexGrow: 1,
    width: "100%",
    maxWidth: 480,
    alignSelf: "center",
    padding: 24,
    paddingTop: 24,
    paddingBottom: 32,
  },
  section: { gap: 16 },
  footer: { width: "100%", maxWidth: 480, alignSelf: "center", padding: 24, paddingTop: 16 },
});

const styles = StyleSheet.create({
  header: {
    width: "100%",
    maxWidth: 480,
    alignSelf: "center",
    minHeight: 60,
    paddingHorizontal: 16,
    paddingVertical: 8,
    alignItems: "center",
    justifyContent: "space-between",
    gap: 16,
  },
  back: {
    minWidth: TOUCH_MIN,
    minHeight: TOUCH_MIN,
    flexShrink: 1,
    alignItems: "center",
    paddingHorizontal: 8,
    paddingVertical: 8,
    borderRadius: radius.sm,
    gap: 6,
  },
  backLabel: { ...typography.bodySm, color: colors.textSubtle, flexShrink: 1 },
  brand: { ...typography.title, color: colors.textEmphasis, paddingHorizontal: 8 },
  intro: { gap: 8, marginBottom: 28 },
  title: { ...typography.display, color: colors.textEmphasis },
  description: { ...typography.body, color: colors.textSubtle },
  centered: { textAlign: "center" },
  action: {
    minHeight: 52,
    alignSelf: "stretch",
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 40,
    paddingVertical: 12,
    borderWidth: 1,
    borderColor: "transparent",
    borderRadius: radius.md,
  },
  primary: { backgroundColor: colors.actionPrimary },
  outline: { backgroundColor: colors.bgDefault, borderColor: colors.borderDefault },
  actionLabel: { ...typography.labelBold, textAlign: "center" },
  spinner: { position: "absolute" },
  pressed: { backgroundColor: colors.bgMuted },
  pressedPrimary: { opacity: 0.85 },
  disabled: { opacity: 0.5 },
});
