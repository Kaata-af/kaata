import { StyleSheet, Text, View } from "react-native";
import { colors } from "../lib/colors";
import { useIsRTL } from "../lib/direction";
import { radius, typography } from "../lib/tokens";

type Variant = "collect" | "pay" | "neutral" | "outline";

// Tiny uppercase badge. Used to label direction (TO COLLECT / TO PAY) without
// shouting from a balance number. The chip is the only place pastel color
// appears in the chrome.
//
// alignSelf snaps to the script's start edge inline — flex-start in LTR,
// flex-end in RTL — because Yoga's automatic RTL handling is disabled
// globally (see _layout.tsx) so logical alignSelf no longer follows the
// active script direction on its own.
export function Chip(props: { label: string; variant?: Variant }) {
  const isRTL = useIsRTL();
  const variant = props.variant ?? "neutral";
  // `outline` is the lightest weight in the set: a hollow pill for a state
  // that is true but not an achievement (a tally sitting at zero that was
  // never ruled off). Deliberately monochrome — emerald/garnet are reserved
  // for direction (money toward you / away from you), and a zero balance has
  // no direction.
  const palette =
    variant === "collect"
      ? { bg: colors.collectBg, fg: colors.collectText }
      : variant === "pay"
        ? { bg: colors.payBg, fg: colors.payText }
        : variant === "outline"
          ? { bg: "transparent", fg: colors.textMuted }
          : { bg: colors.bgSubtle, fg: colors.textDefault };

  return (
    <View
      style={[
        styles.chip,
        { backgroundColor: palette.bg, alignSelf: isRTL ? "flex-end" : "flex-start" },
        variant === "outline" && styles.outline,
      ]}
    >
      <Text
        style={[
          styles.label,
          { color: palette.fg },
          // Tracking severs Arabic-script joining (same fix as the web
          // wordmark and the export PDF's headers) — drop it for Dari.
          isRTL && { letterSpacing: 0 },
        ]}
      >
        {props.label}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  chip: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: radius.sm, // 6 → 8; chips share the input/button step
  },
  // Border compensates for the missing fill so the pill keeps the same
  // silhouette (and the same height) as the filled variants.
  outline: {
    borderWidth: 1,
    borderColor: colors.borderDefault,
    paddingHorizontal: 7,
    paddingVertical: 2,
  },
  // 10 → caption (11), the scale's smallest step and the only size below it in
  // the whole app. The token also brings the routed lineHeight the literal
  // never had: at 10px iOS was laying an uppercase Latin cap-height run into
  // the font's own box with no floor, which is the same near-miss that beheaded
  // the home header. The pill grows ~1px in return — it sits in a flow column
  // on person detail, not a fixed-height slot.
  label: {
    ...typography.caption,
    letterSpacing: 0.6,
  },
});
