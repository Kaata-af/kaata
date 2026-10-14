import { Pressable, StyleSheet, View, type GestureResponderHandlers } from "react-native";
import { colors } from "../lib/colors";
import { t } from "../lib/i18n";
import { radius, TOUCH_MIN } from "../lib/tokens";

/** Move capture belongs to this parent, rather than Pressable's own responder.
 * The whole header width is draggable; a simple tap also provides an a11y exit. */
export function SheetHandle(props: {
  panHandlers: GestureResponderHandlers;
  onDismiss: () => void;
}) {
  return (
    <View {...props.panHandlers} style={styles.area}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t("common.close")}
        onPress={props.onDismiss}
        style={styles.target}
      >
        <View style={styles.grabber} />
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  area: { flexShrink: 0 },
  target: { minHeight: TOUCH_MIN, alignItems: "center", justifyContent: "center" },
  grabber: {
    width: 40,
    height: 4,
    borderRadius: radius.grabber,
    backgroundColor: colors.borderEmphasis,
  },
});
