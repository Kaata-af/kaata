import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import { Pressable, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { FullNotificationInbox } from "../components/NotificationInbox";
import { colors } from "../lib/colors";
import { rowDir, useIsRTL } from "../lib/direction";
import { t } from "../lib/i18n";
import { icon, TOUCH_MIN, typography } from "../lib/tokens";

export default function NotificationsScreen() {
  const rtl = useIsRTL();
  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.bgDefault }}>
      <View style={[rowDir(rtl), { paddingHorizontal: 12, alignItems: "center" }]}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("common.back")}
          onPress={() => router.back()}
          style={{
            minWidth: TOUCH_MIN,
            minHeight: TOUCH_MIN,
            justifyContent: "center",
            alignItems: "center",
          }}
        >
          <Ionicons
            name={rtl ? "chevron-forward" : "chevron-back"}
            size={icon.header}
            color={colors.textEmphasis}
          />
        </Pressable>
        <Text
          accessibilityRole="header"
          style={{ ...typography.title, flex: 1, textAlign: "center", color: colors.textEmphasis }}
        >
          {t("inbox.title")}
        </Text>
        <View style={{ width: TOUCH_MIN }} />
      </View>
      <FullNotificationInbox />
    </SafeAreaView>
  );
}
