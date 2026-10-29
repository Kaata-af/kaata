import { Ionicons } from "@expo/vector-icons";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { colors } from "../lib/colors";
import { rowDir, textDir, useIsRTL } from "../lib/direction";
import { t } from "../lib/i18n";
import { radius, ROW_MIN, space, typography } from "../lib/tokens";

/** One history control shared by the customer timeline and homepage accounts. */
export function SettledHistoryToggle({
  kind,
  expanded,
  onToggle,
  count,
  disabled = false,
  horizontalInset = 0,
}: {
  kind: "accounts" | "tallies";
  expanded: boolean;
  onToggle: () => void;
  count: number;
  disabled?: boolean;
  horizontalInset?: number;
}) {
  const isRTL = useIsRTL();
  if (count <= 0) return null;
  const label =
    kind === "accounts"
      ? t(expanded ? "home.settled.hide" : "home.settled.show")
      : t(expanded ? "person.history.hideSettled" : "person.history.seeSettled");
  const countLabel =
    kind === "accounts"
      ? t("home.settled.count", { count })
      : t("person.history.settledCount", { count });
  return (
    <Pressable
      testID={`settled-${kind}-toggle`}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityValue={{ text: countLabel }}
      accessibilityState={{ expanded, disabled }}
      disabled={disabled}
      onPress={() => {
        if (!disabled) onToggle();
      }}
      style={({ pressed }) => [
        styles.toggle,
        { marginHorizontal: horizontalInset },
        rowDir(isRTL),
        kind === "accounts" && expanded && styles.expanded,
        disabled && styles.disabled,
        pressed && !disabled && styles.pressed,
      ]}
    >
      <Ionicons
        accessible={false}
        name="checkmark-done-outline"
        size={20}
        color={colors.textSubtle}
      />
      <Text accessible={false} style={[styles.label, textDir(isRTL)]}>
        {label}
      </Text>
      <View accessible={false} style={styles.badge}>
        <Text accessible={false} style={styles.count}>
          {count}
        </Text>
      </View>
      <Ionicons
        accessible={false}
        name={expanded ? "chevron-up" : "chevron-down"}
        size={16}
        color={colors.textSubtle}
      />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  toggle: {
    minHeight: ROW_MIN,
    marginTop: space.lg,
    paddingVertical: space.md,
    paddingHorizontal: space.lg,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderSubtle,
    backgroundColor: colors.bgMuted,
    alignItems: "center",
    gap: space.md,
  },
  label: { ...typography.label, color: colors.textDefault, flex: 1, minWidth: 0 },
  badge: {
    minWidth: 28,
    paddingHorizontal: space.sm,
    paddingVertical: 2,
    borderRadius: radius.sm,
    backgroundColor: colors.bgDefault,
    alignItems: "center",
  },
  count: { ...typography.numMeta, color: colors.textSubtle, writingDirection: "ltr" },
  expanded: { marginBottom: space.md },
  pressed: { backgroundColor: colors.bgSubtle },
  disabled: { opacity: 0.4 },
});
