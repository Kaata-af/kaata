import { Ionicons } from "@expo/vector-icons";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useState } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Button } from "../../components/Button";
import { colors } from "../../lib/colors";
import { getAppMeta, getLocalSelf, setAppMeta } from "../../lib/db";
import { rowDir, textDir, useIsRTL } from "../../lib/direction";
import { t } from "../../lib/i18n";
import { gutter, icon, radius, space, typography } from "../../lib/tokens";

// Confirmation only: the previous step has already committed the first kaata
// and marked onboarding done. Keep the name fallback and home navigation here;
// rendering this screen must never create another vault or gate access to it.
//
// It is also where a mutual-tab deep link that arrived BEFORE the user had a
// kaata is redeemed (docs/mutual-tab-design.md §4.4). app/t/[token].tsx stashes
// pending_tab_token and sends such a visitor into onboarding; this is the last
// screen of that flow, and the first moment the join has somewhere to land — a
// self, a vault and a currency all exist. Consumed on the CTA rather than on
// mount so the celebration is not stolen by a modal sliding over it.
export default function OnboardingSuccessScreen() {
  const router = useRouter();
  const isRTL = useIsRTL();
  const params = useLocalSearchParams<{ name?: string }>();
  const [shopName, setShopName] = useState<string | null>(
    typeof params.name === "string" && params.name.trim() ? params.name.trim() : null,
  );

  useEffect(() => {
    if (shopName) return;
    let cancelled = false;
    void (async () => {
      try {
        const self = await getLocalSelf();
        const name = self?.shop_name?.trim();
        if (!cancelled && name) setShopName(name);
      } catch {
        // The confirmation and home action still work without the optional name.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [shopName]);

  // Redeem a tab link that was followed before this kaata existed; otherwise
  // the ordinary home landing. A failed read must never trap the user on the
  // success screen, so every failure falls through to home.
  async function onContinue() {
    let pendingTab: string | null = null;
    try {
      pendingTab = await getAppMeta("pending_tab_token");
      if (pendingTab) await setAppMeta("pending_tab_token", "");
    } catch (err) {
      console.warn("[onboarding/success] pending tab read failed", err);
    }
    if (pendingTab) {
      router.replace({ pathname: "/t/[token]", params: { token: pendingTab } });
      return;
    }
    router.replace("/");
  }

  return (
    <SafeAreaView style={styles.container} edges={["top", "bottom"]}>
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.content}>
          <View
            style={[styles.check, { alignSelf: isRTL ? "flex-end" : "flex-start" }]}
            accessible={false}
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
          >
            <Ionicons name="checkmark" size={icon.card} color={colors.textEmphasis} />
          </View>

          <Text style={[styles.title, textDir(isRTL)]} accessibilityRole="header">
            {t("onboardingSuccess.title")}
          </Text>

          {shopName ? (
            <View style={[styles.kaataRow, rowDir(isRTL)]}>
              <View
                accessible={false}
                accessibilityElementsHidden
                importantForAccessibility="no-hide-descendants"
              >
                <Ionicons name="book-outline" size={icon.row} color={colors.textSubtle} />
              </View>
              <Text style={[styles.shopName, textDir(isRTL)]}>{shopName}</Text>
            </View>
          ) : null}

          <Text style={[styles.body, textDir(isRTL)]}>{t("onboardingSuccess.body")}</Text>
        </View>
      </ScrollView>

      <View style={styles.footer}>
        <View style={styles.footerContent}>
          <Button
            label={t("onboardingSuccess.cta")}
            onPress={() => void onContinue()}
            size="hero"
            fullWidth
          />
        </View>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bgDefault },
  scroll: { flex: 1 },
  scrollContent: { flexGrow: 1, paddingHorizontal: gutter.hero, paddingVertical: space.xxl },
  content: {
    flexGrow: 1,
    width: "100%",
    maxWidth: 420,
    alignSelf: "center",
    justifyContent: "center",
    paddingVertical: space.xxl,
  },
  check: {
    width: 44,
    height: 44,
    borderRadius: radius.md,
    backgroundColor: colors.bgSubtle,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: space.xl,
  },
  title: { ...typography.heading, color: colors.textEmphasis },
  kaataRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
    marginTop: space.xl,
    padding: space.lg,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderDefault,
    backgroundColor: colors.bgMuted,
  },
  // User-entered names may be Dari even in English UI. Let them wrap and never
  // add tracking, which breaks Arabic-script joining.
  shopName: { ...typography.labelBold, flex: 1, minWidth: 0, color: colors.textEmphasis },
  body: { ...typography.body, color: colors.textSubtle, marginTop: space.lg },
  // Keep the shared bottom-control offset above the safe area (Toast.tsx).
  footer: { paddingHorizontal: gutter.hero, paddingTop: space.lg, paddingBottom: 20 },
  footerContent: { width: "100%", maxWidth: 420, alignSelf: "center" },
});
