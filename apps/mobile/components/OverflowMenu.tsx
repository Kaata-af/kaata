import { Ionicons } from "@expo/vector-icons";
import { useEffect, useRef, useState } from "react";
import { Modal, Pressable, StyleSheet, Text, View, useWindowDimensions } from "react-native";
import { colors } from "../lib/colors";
import { rowDir, textDir, useIsRTL } from "../lib/direction";
import { t } from "../lib/i18n";
import { icon, radius, TOUCH_MIN, typography } from "../lib/tokens";

type Action = {
  label: string;
  icon: keyof typeof Ionicons.glyphMap;
  onPress: () => void;
  disabled?: boolean;
};

/** Header-anchored menu. Actions run after the modal dismisses, so opening a
 * native share sheet or another modal cannot race its presentation on iOS. */
export function OverflowMenu({ actions }: { actions: Action[] }) {
  const rtl = useIsRTL();
  const anchor = useRef<View>(null);
  const [position, setPosition] = useState<{ x: number; y: number } | null>(null);
  const pending = useRef<(() => void) | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  const { width, height } = useWindowDimensions();
  const menuWidth = Math.min(280, width - 32);
  const finish = () => {
    if (timer.current) clearTimeout(timer.current);
    const action = pending.current;
    pending.current = null;
    action?.();
  };
  const close = (action?: () => void) => {
    pending.current = action ?? null;
    setPosition(null);
    // Android does not fire Modal.onDismiss. animationType=none needs only
    // one native commit; the delay also covers iOS's presentation teardown.
    timer.current = setTimeout(finish, 250);
  };
  return (
    <>
      <View ref={anchor} collapsable={false}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("entry.options")}
          accessibilityState={{ expanded: position !== null }}
          style={styles.trigger}
          onPress={() =>
            anchor.current?.measureInWindow((x, y, w, h) => {
              setPosition({
                x: Math.max(16, Math.min(rtl ? x : x + w - menuWidth, width - menuWidth - 16)),
                y: Math.max(16, Math.min(y + h + 4, height - actions.length * 52 - 32)),
              });
            })
          }
        >
          <Ionicons name="ellipsis-horizontal" size={icon.row} color={colors.textEmphasis} />
        </Pressable>
      </View>
      <Modal
        transparent
        statusBarTranslucent
        navigationBarTranslucent
        visible={position !== null}
        animationType="none"
        onRequestClose={() => close()}
        onDismiss={finish}
      >
        <View style={styles.overlay}>
          <Pressable
            style={StyleSheet.absoluteFill}
            accessibilityLabel={t("common.cancel")}
            accessibilityRole="button"
            onPress={() => close()}
          />
          <View
            accessibilityViewIsModal
            style={[
              styles.menu,
              { width: menuWidth, left: position?.x ?? 16, top: position?.y ?? 16 },
            ]}
          >
            {actions.map((action) => (
              <Pressable
                key={action.label}
                accessibilityRole="button"
                accessibilityState={{ disabled: !!action.disabled }}
                disabled={action.disabled}
                onPress={() => close(action.onPress)}
                style={({ pressed }) => [
                  styles.item,
                  rowDir(rtl),
                  pressed && { backgroundColor: colors.bgSubtle },
                  action.disabled && { opacity: 0.4 },
                ]}
              >
                <Ionicons name={action.icon} size={icon.trailing} color={colors.textDefault} />
                <Text style={[styles.label, textDir(rtl)]}>{action.label}</Text>
              </Pressable>
            ))}
          </View>
        </View>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  trigger: {
    minWidth: TOUCH_MIN,
    minHeight: TOUCH_MIN,
    alignItems: "center",
    justifyContent: "center",
  },
  overlay: { flex: 1 },
  menu: {
    position: "absolute",
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.borderDefault,
    backgroundColor: colors.bgDefault,
    overflow: "hidden",
    elevation: 8,
    boxShadow: "0 8px 28px rgba(0,0,0,0.12)",
  },
  item: {
    minHeight: 52,
    paddingHorizontal: 16,
    paddingVertical: 10,
    gap: 12,
    alignItems: "center",
  },
  label: { ...typography.body, color: colors.textEmphasis, flex: 1 },
});
