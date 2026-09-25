import { Ionicons } from "@expo/vector-icons";
import { colors } from "../lib/colors";
import { t } from "../lib/i18n";

/** A shared-account marker, not an identity-verification claim. */
export function SharedAccountBadge({ size = 16 }: { size?: number }) {
  return (
    <Ionicons
      name="checkmark-circle"
      size={size}
      color={colors.sharedAccount}
      accessibilityLabel={t("tab.join.title")}
    />
  );
}
