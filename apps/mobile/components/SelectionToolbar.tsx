import type { ComponentProps } from "react";
import { Ionicons } from "@expo/vector-icons";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { colors } from "../lib/colors";
import { rowDir, textDir, useIsRTL } from "../lib/direction";
import { t } from "../lib/i18n";
import { faDigits } from "../lib/jalali";
import { lift, radius, space, TOUCH_MIN, typography } from "../lib/tokens";

export type SelectionAction = {
  key: string;
  label: string;
  icon: ComponentProps<typeof Ionicons>["name"];
  onPress: () => void;
  destructive?: boolean;
  disabled?: boolean;
};

/** An in-flow panel. The screen owns its placement and safe-area insets. */
export function SelectionToolbar({
  count,
  total,
  onClose,
  onToggleAll,
  actions = [],
  busy = false,
  summary,
}: {
  count: number;
  total: number;
  onClose: () => void;
  onToggleAll: () => void;
  actions?: SelectionAction[];
  busy?: boolean;
  summary?: string;
}) {
  const isRTL = useIsRTL();
  const allSelected = total > 0 && count === total;
  return (
    <View style={[styles.panel, lift]} accessibilityState={{ busy }}>
      <View style={[styles.header, rowDir(isRTL)]}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("selection.close")}
          accessibilityState={{ disabled: busy }}
          disabled={busy}
          onPress={onClose}
          style={({ pressed }) => [
            styles.close,
            pressed && styles.pressed,
            busy && styles.disabled,
          ]}
        >
          <Ionicons name="close" size={20} color={colors.textEmphasis} />
        </Pressable>
        <View style={[styles.selection, rowDir(isRTL)]}>
          {busy ? <ActivityIndicator size="small" color={colors.actionPrimary} /> : null}
          <Text accessibilityLiveRegion="polite" style={[styles.count, textDir(isRTL)]}>
            {t("selection.count", { count: isRTL ? faDigits(String(count)) : count })}
          </Text>
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t(allSelected ? "selection.clear" : "selection.all")}
          accessibilityState={{ disabled: busy || total === 0 }}
          disabled={busy || total === 0}
          onPress={onToggleAll}
          style={({ pressed }) => [
            styles.toggleAll,
            pressed && styles.pressed,
            (busy || total === 0) && styles.disabled,
          ]}
        >
          <Text style={[styles.toggleLabel, textDir(isRTL)]}>
            {t(allSelected ? "selection.clear" : "selection.all")}
          </Text>
        </Pressable>
      </View>
      {summary || count === 0 ? (
        <Text style={[styles.summary, textDir(isRTL)]}>{summary || t("selection.empty")}</Text>
      ) : null}
      {actions.length > 0 ? (
        <View style={[styles.actions, rowDir(isRTL)]}>
          {actions.map((action) => {
            const disabled = busy || count === 0 || Boolean(action.disabled);
            const color = action.destructive ? colors.danger : colors.textEmphasis;
            return (
              <Pressable
                key={action.key}
                accessibilityRole="button"
                accessibilityLabel={action.label}
                accessibilityState={{ disabled, busy }}
                disabled={disabled}
                onPress={action.onPress}
                style={({ pressed }) => [
                  styles.action,
                  rowDir(isRTL),
                  action.destructive && styles.destructive,
                  pressed && styles.pressed,
                  disabled && styles.disabled,
                ]}
              >
                <Ionicons name={action.icon} size={18} color={color} />
                <Text style={[styles.actionLabel, textDir(isRTL), { color }]}>{action.label}</Text>
              </Pressable>
            );
          })}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  panel: {
    alignSelf: "stretch",
    backgroundColor: colors.bgDefault,
    borderColor: colors.borderDefault,
    borderWidth: 1,
    borderRadius: radius.lg,
    padding: space.sm,
    gap: space.sm,
  },
  header: { alignItems: "center", flexWrap: "wrap", gap: space.sm },
  close: {
    minWidth: TOUCH_MIN,
    minHeight: TOUCH_MIN,
    borderRadius: radius.pill,
    backgroundColor: colors.bgMuted,
    alignItems: "center",
    justifyContent: "center",
  },
  selection: {
    flex: 1,
    flexBasis: 90,
    minWidth: 0,
    alignItems: "center",
    gap: space.sm,
  },
  count: { ...typography.labelBold, color: colors.textEmphasis, flexShrink: 1 },
  toggleAll: {
    minHeight: TOUCH_MIN,
    minWidth: TOUCH_MIN,
    maxWidth: "100%",
    paddingVertical: space.xs,
    paddingHorizontal: space.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.borderDefault,
    alignItems: "center",
    justifyContent: "center",
  },
  toggleLabel: { ...typography.bodySm, color: colors.textDefault },
  summary: { ...typography.bodySm, color: colors.textSubtle, paddingHorizontal: space.sm },
  actions: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.borderDefault,
    paddingTop: space.sm,
    flexWrap: "wrap",
    gap: space.sm,
  },
  action: {
    flexGrow: 1,
    flexBasis: 110,
    minWidth: TOUCH_MIN,
    minHeight: TOUCH_MIN,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    borderRadius: radius.md,
    backgroundColor: colors.bgMuted,
    borderColor: colors.bgMuted,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: space.sm,
  },
  actionLabel: { ...typography.bodySm, flexShrink: 1 },
  destructive: { backgroundColor: colors.bgDefault, borderColor: colors.borderDefault },
  pressed: { opacity: 0.65 },
  disabled: { opacity: 0.4 },
});
