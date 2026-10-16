import { Ionicons } from "@expo/vector-icons";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import {
  OnboardingAction,
  OnboardingHeader,
  OnboardingIntro,
  onboardingStyles,
} from "../../components/Onboarding";
import { colors } from "../../lib/colors";
import { getAppMeta, getLocalSelf, setAppMeta } from "../../lib/db";
import { rowDir, textDir, useIsRTL } from "../../lib/direction";
import { t } from "../../lib/i18n";
import { icon, radius, space, typography } from "../../lib/tokens";

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
  const leaving = useRef(false);
  const mounted = useRef(true);
  const [busy, setBusy] = useState(false);
  const [shopName, setShopName] = useState<string | null>(
    typeof params.name === "string" && params.name.trim() ? params.name.trim() : null,
  );

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

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
    if (leaving.current || !mounted.current) return;
    leaving.current = true;
    setBusy(true);
    let pendingTab: string | null = null;
    try {
      pendingTab = await getAppMeta("pending_tab_token");
      if (pendingTab) {
        // The pair travels together (app/t/[token].tsx): a currency left
        // armed alone would preset a later, unrelated vault/new.
        await setAppMeta("pending_tab_token", "");
        await setAppMeta("pending_tab_currency", "");
      }
    } catch (err) {
      console.warn("[onboarding/success] pending tab read failed", err);
    }
    if (!mounted.current) return;
    if (pendingTab) {
      router.replace({ pathname: "/t/[token]", params: { token: pendingTab } });
      return;
    }
    router.replace("/");
  }

  return (
    <SafeAreaView style={onboardingStyles.screen} edges={["top", "bottom"]}>
      <OnboardingHeader />
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={[onboardingStyles.content, styles.scrollContent]}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.content}>
          <View
            style={styles.check}
            accessible={false}
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
          >
            <Ionicons name="checkmark-circle-outline" size={56} color={colors.textEmphasis} />
          </View>

          <OnboardingIntro
            title={t("onboardingSuccess.title")}
            description={t("onboardingSuccess.body")}
            align="center"
          />

          {shopName ? (
            <View style={[styles.kaataRow, rowDir(isRTL)]}>
              <View
                accessible={false}
                accessibilityElementsHidden
                importantForAccessibility="no-hide-descendants"
              >
                <Ionicons name="book-outline" size={icon.row} color={colors.textSubtle} />
              </View>
              <View style={styles.kaataName}>
                <Text style={[styles.kaataLabel, textDir(isRTL)]}>
                  {t("onboardingSuccess.ledgerLabel")}
                </Text>
                <Text style={[styles.shopName, textDir(isRTL)]}>{shopName}</Text>
              </View>
            </View>
          ) : null}
        </View>
      </ScrollView>

      <View style={onboardingStyles.footer}>
        <OnboardingAction
          label={t("onboardingSuccess.cta")}
          onPress={() => void onContinue()}
          loading={busy}
        />
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  scroll: { flex: 1 },
  scrollContent: { justifyContent: "center" },
  content: {
    width: "100%",
    paddingVertical: space.lg,
  },
  check: {
    alignSelf: "center",
    marginBottom: space.xxl,
  },
  kaataRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
    padding: space.lg,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderDefault,
    backgroundColor: colors.bgMuted,
  },
  // User-entered names may be Dari even in English UI. Let them wrap and never
  // add tracking, which breaks Arabic-script joining.
  kaataName: { flex: 1, minWidth: 0, gap: 2 },
  kaataLabel: { ...typography.caption, color: colors.textMuted },
  shopName: { ...typography.labelBold, color: colors.textEmphasis },
});
