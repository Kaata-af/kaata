import { Ionicons } from "@expo/vector-icons";
import { StyleSheet, View } from "react-native";
import { colors } from "../lib/colors";

/** The containing row owns the checkbox role, label and checked state. */
export function SelectionMark({
  selected,
  disabled = false,
}: {
  selected: boolean;
  disabled?: boolean;
}) {
  return (
    <View
      pointerEvents="none"
      accessible={false}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[styles.mark, selected && styles.selected, disabled && styles.disabled]}
    >
      {selected ? (
        <Ionicons
          name="checkmark"
          size={14}
          color={disabled ? colors.textMuted : colors.textInverted}
        />
      ) : null}
    </View>
  );
}

const SIZE = 22;
const styles = StyleSheet.create({
  mark: {
    width: SIZE,
    height: SIZE,
    borderRadius: SIZE / 2,
    borderWidth: 1.5,
    borderColor: colors.textMuted,
    backgroundColor: colors.bgDefault,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  selected: {
    borderColor: colors.actionPrimary,
    backgroundColor: colors.actionPrimary,
  },
  disabled: { borderColor: colors.borderDefault, backgroundColor: colors.bgSubtle },
});
