import { MaterialIcons } from "@expo/vector-icons";
import { useWindowDimensions, View } from "react-native";
import { colors } from "../lib/colors";
import { t } from "../lib/i18n";

/** Align a Latin name's ink, rather than Vazirmatn's taller Persian line box.
 * Measured from the bundled 600/700 TTFs: UPEM 2048, hhea ascent 2100,
 * descent -1100; Latin H/M/A glyph bounds 0..1456. The OS/2 cap-height field
 * is 1638, so it does not describe those actual Latin capital glyphs.
 * Keep Persian and mixed-script names at their existing centered position. */
export function sharedAccountBadgeOffset(name: string, fontSize: number, fontScale = 1): number {
  const letters = name.match(/\p{L}/gu) ?? [];
  if (!letters.length || letters.some((letter) => !/\p{Script=Latin}/u.test(letter))) return 0;
  return ((2100 - 1100 - 1456) / (2 * 2048)) * fontSize * fontScale;
}

/** A shared-account marker, not an identity-verification claim. */
export function SharedAccountBadge({
  size = 16,
  name = "",
  fontSize = 15,
}: {
  size?: number;
  /** Adjacent displayed name; alignment follows its script, not the UI locale. */
  name?: string;
  fontSize?: number;
}) {
  const { fontScale } = useWindowDimensions();
  const offset = sharedAccountBadgeOffset(name, fontSize, fontScale);
  return (
    <View
      style={{
        width: size,
        height: size,
        flexShrink: 0,
        alignItems: "center",
        justifyContent: "center",
        ...(offset ? { transform: [{ translateY: offset }] } : {}),
      }}
    >
      <MaterialIcons
        name="verified"
        size={size}
        color={colors.sharedAccount}
        accessibilityLabel={t("tab.join.title")}
      />
    </View>
  );
}
