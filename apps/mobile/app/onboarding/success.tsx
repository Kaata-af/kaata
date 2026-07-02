import { Ionicons } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { Animated, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Button } from "../../components/Button";
import { colors } from "../../lib/colors";
import { getLocalSelf } from "../../lib/db";
import { rowDir, textDir, useIsRTL } from "../../lib/direction";
import { fonts } from "../../lib/fonts";
import { t } from "../../lib/i18n";

// Onboarding completion — the game-style "you made it" moment (Matee's ask).
//
// Shown once, right after the kaata step creates the self + first vault,
// replacing the old silent router.replace("/"). This is where the kaata
// concept lands: a celebratory check, the SHOP NAME the user just typed
// displayed big inside a card, and one line of what-to-do-next. Success
// screens are how games cement "that thing you just made? here it is" —
// far stickier than a mid-form diagram (removed; Matee didn't like it).
//
// The shop name arrives via route param (?name=). Force-quit here is
// harmless: onboarding_step is already 'done', so a relaunch routes
// straight to home — this screen is pure ceremony, never a gate. The
// param can be lost in edge cases (deep-link replay), so we fall back to
// getLocalSelf().shop_name before rendering the name card.
//
// No new dependencies: the check pops in with the same Animated.spring
// the rest of the app uses, plus a success haptic (expo-haptics is
// already a dependency — the home swipe rail uses it).

export default function OnboardingSuccessScreen() {
  const router = useRouter();
  const isRTL = useIsRTL();
  const params = useLocalSearchParams<{ name?: string }>();
  const [shopName, setShopName] = useState<string | null>(
    typeof params.name === "string" && params.name.trim() ? params.name.trim() : null,
  );

  // Pop the check in with a spring, then fade the rest up. Native-driver
  // transforms only — no layout thrash on low-end Androids.
  const checkScale = useRef(new Animated.Value(0)).current;
  const contentOpacity = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.sequence([
      Animated.spring(checkScale, {
        toValue: 1,
        friction: 5,
        tension: 90,
        useNativeDriver: true,
      }),
      Animated.timing(contentOpacity, {
        toValue: 1,
        duration: 260,
        useNativeDriver: true,
      }),
    ]).start();
    // Success haptic — the tactile half of the celebration. Best-effort:
    // some devices have no vibrator or haptics disabled.
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Param lost (deep-link replay, state restoration) — recover the name
  // from the just-created vault so the card never renders blank.
  useEffect(() => {
    if (shopName) return;
    void (async () => {
      try {
        const self = await getLocalSelf();
        if (self?.shop_name) setShopName(self.shop_name);
      } catch {
        // Leave null — the name card is hidden and the title still lands.
      }
    })();
  }, [shopName]);

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.content}>
        <Animated.View style={[styles.checkWrap, { transform: [{ scale: checkScale }] }]}>
          <Ionicons name="checkmark" size={54} color={colors.textInverted} />
        </Animated.View>

        <Animated.View style={{ opacity: contentOpacity, alignSelf: "stretch" }}>
          <Text style={styles.title}>{t("onboardingSuccess.title")}</Text>

          {shopName ? (
            <View style={[styles.nameCard, rowDir(isRTL)]}>
              <Ionicons
                name="storefront-outline"
                size={24}
                color={colors.textEmphasis}
                style={isRTL ? { marginLeft: 12 } : { marginRight: 12 }}
              />
              <Text style={[styles.nameText, textDir(isRTL)]} numberOfLines={2}>
                {shopName}
              </Text>
            </View>
          ) : null}

          <Text style={styles.body}>{t("onboardingSuccess.body")}</Text>
        </Animated.View>
      </View>

      <Animated.View style={[styles.footer, { opacity: contentOpacity }]}>
        <Button label={t("onboardingSuccess.cta")} onPress={() => router.replace("/")} />
      </Animated.View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bgDefault },
  content: {
    flex: 1,
    paddingHorizontal: 24,
    alignItems: "center",
    justifyContent: "center",
  },
  // Emerald = "money toward you" everywhere else in the app; here it reads
  // as plain success. The one deliberate splash of color in onboarding.
  checkWrap: {
    width: 96,
    height: 96,
    borderRadius: 48,
    backgroundColor: colors.collectStrong,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 28,
  },
  title: {
    fontSize: 24,
    fontFamily: fonts.sansBold,
    color: colors.textEmphasis,
    letterSpacing: -0.4,
    textAlign: "center",
  },
  nameCard: {
    flexDirection: "row",
    alignItems: "center",
    alignSelf: "center",
    marginTop: 20,
    paddingVertical: 16,
    paddingHorizontal: 20,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: colors.borderDefault,
    backgroundColor: colors.bgMuted,
    maxWidth: "100%",
  },
  nameText: {
    fontSize: 18,
    fontFamily: fonts.sansSemi,
    color: colors.textEmphasis,
    flexShrink: 1,
  },
  body: {
    fontSize: 14,
    fontFamily: fonts.sansRegular,
    color: colors.textSubtle,
    lineHeight: 21,
    textAlign: "center",
    marginTop: 20,
  },
  footer: { paddingHorizontal: 24, paddingBottom: 16 },
});
