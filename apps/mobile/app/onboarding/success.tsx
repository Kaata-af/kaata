import { Ionicons } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { Animated, Easing, Platform, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Button } from "../../components/Button";
import { colors } from "../../lib/colors";
import { getLocalSelf } from "../../lib/db";
import { rowDir, textDir, trackingSafe, useIsRTL } from "../../lib/direction";
import { fonts } from "../../lib/fonts";
import { t } from "../../lib/i18n";
import { icon, radius, space, typography } from "../../lib/tokens";

// Onboarding completion — shown once, right after the kaata step creates the
// self + first vault.
//
// REWRITTEN 1.0.8. This was a game-style celebration: a 96px black disk with a
// 54px check, an expanding pulse ring, 18 confetti pieces on randomised arcs,
// six staged animations and two haptics. It was cut for one reason — it
// contradicted the app's own design doctrine. lib/colors.ts opens by declaring
// monochrome chrome with quiet semantic colour only where it carries meaning,
// and every other screen in Kaata is calm. A shopkeeper who has just typed
// their shop name met a party, and it read as belonging to a different app.
// (The confetti palette had already been through one round of "terrible green"
// feedback — a sign the concept was being patched rather than reconsidered.)
//
// What replaces it: the same information, stated confidently once. The SHOP
// SIGN is the hero — a black card in the app's primary-surface language,
// reading as the cover of the ledger book they just created — with a small
// quiet check above it rather than a disk competing for the same attention.
// The whole block arrives on ONE fade-up.
//
// Kept deliberately:
//   - the single success haptic. It is tactile, not visual noise, and this is
//     a genuine completion moment. The second "thunk" haptic went with the
//     spring it was punctuating.
//   - the ?name= param + getLocalSelf() fallback. Force-quit here is harmless
//     (onboarding_step is already 'done', so a relaunch routes straight to
//     home — this screen is ceremony, never a gate), but the param can be lost
//     on deep-link replay, and a blank sign card would be a sad ending.
//   - footer paddingBottom 20, which is BUTTON_OFFSET_ABOVE_SAFE_AREA. Every
//     bottom-anchored control in the app sits exactly that far above the safe
//     area because useToastOffset()'s lift constant is derived from it.

/** Diameter of the sign card's icon chip. Radius is size/2, never a literal. */
const SIGN_CHIP = 38;

export default function OnboardingSuccessScreen() {
  const router = useRouter();
  const isRTL = useIsRTL();
  const params = useLocalSearchParams<{ name?: string }>();
  const [shopName, setShopName] = useState<string | null>(
    typeof params.name === "string" && params.name.trim() ? params.name.trim() : null,
  );

  // ONE animated value for the whole block. The old screen had six, staggered
  // across 640ms; a single 320ms fade-up is the entrance every other screen in
  // the app uses, and it cannot jank on a low-end Android the way eighteen
  // concurrent interpolations could.
  const enter = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.timing(enter, {
      toValue: 1,
      duration: 320,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start();
    // Best-effort: no-ops when the device has no vibrator or haptics are off.
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
  }, [enter]);

  // Param lost (deep-link replay, state restoration) — recover the name from
  // the just-created vault so the sign card never renders blank.
  useEffect(() => {
    if (shopName) return;
    void (async () => {
      try {
        const self = await getLocalSelf();
        if (self?.shop_name) setShopName(self.shop_name);
      } catch {
        // Leave null — the card is hidden and the title still lands.
      }
    })();
  }, [shopName]);

  const rise = {
    opacity: enter,
    transform: [{ translateY: enter.interpolate({ inputRange: [0, 1], outputRange: [12, 0] }) }],
  };

  return (
    <SafeAreaView style={styles.container} edges={["top", "bottom"]}>
      <Animated.View style={[styles.content, rise]}>
        {/* Small and quiet. The old 96px black disk was the third heavy black
            block in a vertical column (disk → sign card → CTA) and out-shouted
            the shop name it was supposed to be introducing. A check at
            icon.hero in textEmphasis says "done" without claiming the page. */}
        <Ionicons name="checkmark" size={icon.hero} color={colors.textEmphasis} />

        <Text style={[styles.title, trackingSafe(isRTL)]}>{t("onboardingSuccess.title")}</Text>

        {shopName ? (
          <View style={[styles.signCard, rowDir(isRTL)]}>
            <View style={[styles.signIconChip, isRTL ? { marginLeft: 14 } : { marginRight: 14 }]}>
              <Ionicons name="storefront-outline" size={icon.row} color={colors.textInverted} />
            </View>
            <Text style={[styles.signName, textDir(isRTL), trackingSafe(isRTL)]} numberOfLines={2}>
              {shopName}
            </Text>
          </View>
        ) : null}

        <Text style={styles.body}>{t("onboardingSuccess.body")}</Text>
      </Animated.View>

      <Animated.View style={[styles.footer, rise]}>
        <Button
          label={t("onboardingSuccess.cta")}
          onPress={() => router.replace("/")}
          size="hero"
          fullWidth
        />
      </Animated.View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bgDefault },
  content: {
    flex: 1,
    paddingHorizontal: space.xxl,
    alignItems: "center",
    justifyContent: "center",
  },
  title: {
    // heading (20), not display (28). The sign card is the hero now, and a
    // 28px headline directly above it competed with the thing it introduces.
    ...typography.heading,
    color: colors.textEmphasis,
    textAlign: "center",
    marginTop: space.lg,
  },
  // THE HERO. Black primary-surface card — the same language as the onboarding
  // auth cards and the FAB — reading as the cover of the book they just made.
  signCard: {
    flexDirection: "row",
    alignItems: "center",
    alignSelf: "stretch",
    marginTop: space.xxl,
    paddingVertical: space.xl,
    paddingHorizontal: space.xxl,
    // radius.lg (16): this card floats inset from the screen edge. 18 is
    // reserved for sheet tops welded to it — see the adjacency note in
    // lib/tokens.ts.
    borderRadius: radius.lg,
    backgroundColor: colors.bgInverted,
    ...Platform.select({
      ios: {
        shadowColor: "#000",
        shadowOpacity: 0.18,
        shadowRadius: 14,
        shadowOffset: { width: 0, height: 6 },
      },
      android: { elevation: 4 },
    }),
  },
  // Frosted white-on-dark chip — the same treatment as the person screen's
  // action coins, which keeps the card fully monochrome.
  signIconChip: {
    width: SIGN_CHIP,
    height: SIGN_CHIP,
    borderRadius: SIGN_CHIP / 2,
    backgroundColor: "rgba(255,255,255,0.13)",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  signName: {
    // sansBold over the token's sansSemi: this is sign lettering, and the
    // weight is what makes the card read as a shopfront rather than a list row.
    // NO letterSpacing at any weight — this is the user's own shop name, and an
    // Afghan shopkeeper running the app in English very often names their shop
    // in Persian script, which tracking would shred.
    ...typography.heading,
    fontFamily: fonts.sansBold,
    color: colors.textInverted,
    flexShrink: 1,
  },
  body: {
    ...typography.body,
    color: colors.textSubtle,
    textAlign: "center",
    marginTop: space.xxl,
  },
  // paddingBottom 20 = BUTTON_OFFSET_ABOVE_SAFE_AREA (components/Toast.tsx).
  // Every bottom-anchored control in the app sits exactly that far above the
  // safe area; useToastOffset()'s lift constant is derived from it, and the
  // insets only cancel if this number agrees.
  footer: { paddingHorizontal: space.xxl, paddingBottom: 20 },
});
