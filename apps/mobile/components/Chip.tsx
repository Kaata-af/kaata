import { StyleSheet, Text, View } from "react-native";
import { colors } from "../lib/colors";
import { fonts } from "../lib/fonts";

type Variant = "collect" | "pay" | "neutral";

// Tiny uppercase badge. Used to label direction (TO COLLECT / TO PAY) without
// shouting from a balance number. The chip is the only place pastel color
// appears in the chrome.
export function Chip(props: { label: string; variant?: Variant }) {
  const variant = props.variant ?? "neutral";
  const palette =
    variant === "collect"
      ? { bg: colors.collectBg, fg: colors.collectText }
      : variant === "pay"
        ? { bg: colors.payBg, fg: colors.payText }
        : { bg: colors.bgSubtle, fg: colors.textDefault };

  return (
    <View style={[styles.chip, { backgroundColor: palette.bg }]}>
      <Text style={[styles.label, { color: palette.fg }]}>{props.label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  chip: {
    alignSelf: "flex-start",
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
  },
  label: {
    fontSize: 10,
    fontFamily: fonts.sansSemi,
    letterSpacing: 0.6,
  },
});
