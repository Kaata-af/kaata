import { ActivityIndicator, Pressable, StyleSheet, Text } from "react-native";
import { colors } from "../lib/colors";
import { fonts } from "../lib/fonts";

type Variant = "primary" | "secondary" | "danger";

export function Button(props: {
  label: string;
  onPress: () => void;
  variant?: Variant;
  disabled?: boolean;
  loading?: boolean;
}) {
  const { label, onPress, variant = "primary", disabled, loading } = props;

  const isPrimary = variant === "primary";
  const isDanger = variant === "danger";
  const bg = isPrimary ? colors.bgInverted : isDanger ? colors.danger : colors.bgDefault;
  const fg = isPrimary || isDanger ? colors.textInverted : colors.textEmphasis;
  const borderColor = isPrimary || isDanger ? "transparent" : colors.borderDefault;

  return (
    <Pressable
      onPress={onPress}
      disabled={disabled || loading}
      style={({ pressed }) => [
        styles.btn,
        {
          backgroundColor: bg,
          borderColor,
          opacity: pressed ? 0.85 : 1,
        },
        (disabled || loading) && { opacity: 0.5 },
      ]}
    >
      {loading ? (
        <ActivityIndicator color={fg} />
      ) : (
        <Text style={[styles.text, { color: fg }]}>{label}</Text>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  btn: {
    minHeight: 44,
    paddingHorizontal: 16,
    borderRadius: 8,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  text: { fontSize: 15, fontFamily: fonts.sansSemi },
});
