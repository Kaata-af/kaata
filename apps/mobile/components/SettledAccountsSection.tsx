import { Ionicons } from "@expo/vector-icons";
import type { ReactNode } from "react";
import { Pressable, StyleSheet, Text } from "react-native";
import { colors } from "../lib/colors";
import { rowDir, textDir, useIsRTL } from "../lib/direction";
import { t } from "../lib/i18n";
import { TOUCH_MIN, typography } from "../lib/tokens";

/** Settled customers stay below active accounts in the same scroll container. */
export function SettledAccountsSection({
  expanded,
  onToggle,
  count,
  children,
  disabled = false,
}: {
  expanded: boolean;
  onToggle: () => void;
  count: number;
  children: ReactNode;
  disabled?: boolean;
}) {
  const isRTL = useIsRTL();
  if (count <= 0) return null;
  const label = t(expanded ? "home.settled.hide" : "home.settled.show");
  return (
    <>
      <Pressable
        testID="settled-accounts-toggle"
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityValue={{ text: t("home.settled.count", { count }) }}
        accessibilityState={{ expanded, disabled }}
        disabled={disabled}
        onPress={() => {
          if (!disabled) onToggle();
        }}
        style={({ pressed }) => [
          styles.toggle,
          rowDir(isRTL),
          expanded && styles.expanded,
          disabled && styles.disabled,
          pressed && styles.pressed,
        ]}
      >
        <Text accessible={false} style={[styles.label, textDir(isRTL)]}>
          {label}
        </Text>
        <Text accessible={false} style={styles.count}>
          {count}
        </Text>
        <Ionicons
          accessible={false}
          name={expanded ? "chevron-up" : "chevron-down"}
          size={16}
          color={colors.textSubtle}
        />
      </Pressable>
      {expanded ? children : null}
    </>
  );
}

const styles = StyleSheet.create({
  toggle: {
    minHeight: TOUCH_MIN,
    marginTop: 20,
    marginHorizontal: 16,
    paddingVertical: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.borderDefault,
    alignItems: "center",
    gap: 10,
  },
  expanded: { marginBottom: 8 },
  label: { ...typography.bodySm, color: colors.textDefault, flex: 1, minWidth: 0 },
  count: { ...typography.numMeta, color: colors.textSubtle, writingDirection: "ltr" },
  pressed: { backgroundColor: colors.bgMuted },
  disabled: { opacity: 0.4 },
});
