import { Ionicons } from "@expo/vector-icons";
import { Pressable, StyleSheet, Text, type StyleProp, type ViewStyle } from "react-native";
import { colors } from "../lib/colors";
import { rowDir, textDir } from "../lib/direction";
import { t } from "../lib/i18n";
import { icon, radius, TOUCH_MIN, typography } from "../lib/tokens";

/** Looks like the search field it opens; the actual input lives in the sheet. */
export function SearchFieldTrigger(props: {
  placeholder: string;
  onPress: () => void;
  isRTL: boolean;
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <Pressable
      testID="search-field-trigger"
      accessibilityRole="button"
      accessibilityLabel={props.placeholder}
      accessibilityHint={t("search.openHint")}
      accessibilityState={{ disabled: !!props.disabled }}
      disabled={props.disabled}
      onPress={props.onPress}
      style={({ pressed }) => [
        styles.field,
        rowDir(props.isRTL),
        props.style,
        (pressed || props.disabled) && { opacity: 0.65 },
      ]}
    >
      <Ionicons name="search-outline" size={icon.row} color={colors.textSubtle} />
      <Text style={[styles.placeholder, textDir(props.isRTL)]}>{props.placeholder}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  field: {
    flexGrow: 1,
    flexShrink: 1,
    minWidth: 0,
    minHeight: Math.max(52, TOUCH_MIN),
    paddingHorizontal: 12,
    paddingVertical: 12,
    borderWidth: 1,
    borderColor: colors.borderDefault,
    borderRadius: radius.sm,
    backgroundColor: colors.bgDefault,
    alignItems: "center",
    gap: 8,
  },
  placeholder: { ...typography.body, color: colors.textMuted, flex: 1 },
});
