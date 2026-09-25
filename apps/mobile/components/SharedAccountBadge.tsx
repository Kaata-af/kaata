import { MaterialIcons } from "@expo/vector-icons";
import { View } from "react-native";
import { colors } from "../lib/colors";
import { t } from "../lib/i18n";

/** A shared-account marker, not an identity-verification claim. */
export function SharedAccountBadge({ size = 16 }: { size?: number }) {
  return (
    <View
      style={{
        width: size,
        height: size,
        flexShrink: 0,
        alignItems: "center",
        justifyContent: "center",
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
