import { Ionicons } from "@expo/vector-icons";
import { useState } from "react";
import { Pressable, StyleSheet } from "react-native";
import { BottomSheet, type SheetAction } from "./BottomSheet";
import { colors } from "../lib/colors";
import { t } from "../lib/i18n";
import { icon, TOUCH_MIN } from "../lib/tokens";

/** Shares the app's bottom-sheet presentation and post-dismiss action timing. */
export function OverflowMenu({ actions }: { actions: SheetAction[] }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t("entry.options")}
        accessibilityState={{ expanded: open }}
        style={styles.trigger}
        onPress={() => setOpen(true)}
      >
        <Ionicons name="ellipsis-horizontal" size={icon.row} color={colors.textEmphasis} />
      </Pressable>
      <BottomSheet
        visible={open}
        title={t("entry.options")}
        actions={actions}
        onDismiss={() => setOpen(false)}
      />
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
});
