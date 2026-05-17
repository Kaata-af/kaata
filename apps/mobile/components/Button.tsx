import { ActivityIndicator, Pressable, StyleSheet, Text } from "react-native";
import { colors } from "../lib/colors";

type Variant = "primary" | "debt" | "payment" | "ghost";

export function Button(props: {
  label: string;
  onPress: () => void;
  variant?: Variant;
  disabled?: boolean;
  loading?: boolean;
}) {
  const { label, onPress, variant = "primary", disabled, loading } = props;

  const bg =
    variant === "debt"
      ? colors.debt
      : variant === "payment"
        ? colors.payment
        : variant === "ghost"
          ? "transparent"
          : colors.primaryAction;
  const fg = variant === "ghost" ? colors.textPrimary : "#FFFFFF";
  const borderColor = variant === "ghost" ? colors.border : "transparent";

  return (
    <Pressable
      onPress={onPress}
      disabled={disabled || loading}
      style={({ pressed }) => [
        styles.btn,
        { backgroundColor: bg, borderColor, opacity: pressed ? 0.85 : 1 },
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
    minHeight: 52,
    paddingHorizontal: 16,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: "center",
    justifyContent: "center",
  },
  text: { fontSize: 16, fontWeight: "600" },
});
