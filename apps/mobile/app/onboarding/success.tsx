import { Ionicons } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { Animated, Easing, Platform, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Button } from "../../components/Button";
import { colors } from "../../lib/colors";
import { getLocalSelf } from "../../lib/db";
import { rowDir, textDir, useIsRTL } from "../../lib/direction";
import { fonts, sansLineHeight } from "../../lib/fonts";
import { t } from "../../lib/i18n";

// Onboarding completion — the game-style "you made it" moment (Matee's ask).
//
// Shown once, right after the kaata step creates the self + first vault,
// replacing the old silent router.replace("/"). Success screens are how
// games cement "that thing you just made? here it is" — so the SHOP NAME is
// the hero: a black shop-sign card (the app's primary-surface style — it
// reads as the cover of the ledger book they just created) with the name
// big, under a celebratory check.
//
// Celebration choreography (all Animated + expo-haptics, no new deps, every
// animated prop is native-driver-safe — transform/opacity only):
//   t=0      check pops in (spring) + a ring pulse expands behind it
//            + success haptic
//   t≈80ms   confetti burst — 18 pieces in the brand palette arc out of the
//            check and fall away (per-piece randomized trajectory/rotation)
//   t≈250ms  title fades up
//   t≈380ms  shop-sign card springs up + light impact haptic (the "thunk"
//            of the sign landing)
//   t≈520ms  body line fades in
//   t≈640ms  CTA rises
//
// The shop name arrives via route param (?name=). Force-quit here is
// harmless: onboarding_step is already 'done', so a relaunch routes
// straight to home — this screen is pure ceremony, never a gate. The
// param can be lost in edge cases (deep-link replay), so we fall back to
// getLocalSelf().shop_name before rendering the name card.

// Confetti in the brand palette: the two emerald "success" tones + black.
// Deliberately NOT the garnet "pay" color (money-away everywhere else), and
// no light neutrals — they vanish against the white background and make the
// burst read sparse.
const CONFETTI_COLORS = [colors.collectStrong, colors.collectText, colors.bgInverted] as const;

const CONFETTI_COUNT = 18;

type ConfettiPiece = {
  progress: Animated.Value;
  dx: number; // horizontal spread at full progress
  riseY: number; // arc peak (negative = up)
  fallY: number; // final resting offset (positive = down, off the card)
  spin: string; // total rotation, e.g. "540deg"
  delay: number;
  duration: number;
  color: string;
  w: number;
  h: number;
};

function makeConfetti(): ConfettiPiece[] {
  return Array.from({ length: CONFETTI_COUNT }, (_, i) => {
    // Alternate sides so the burst is symmetric even with randomness.
    const side = i % 2 === 0 ? 1 : -1;
    return {
      progress: new Animated.Value(0),
      dx: side * (30 + Math.random() * 120),
      riseY: -(40 + Math.random() * 90),
      fallY: 160 + Math.random() * 180,
      spin: `${side * (280 + Math.round(Math.random() * 420))}deg`,
      delay: 80 + Math.random() * 160,
      duration: 950 + Math.random() * 450,
      color: CONFETTI_COLORS[i % CONFETTI_COLORS.length],
      w: 6 + Math.random() * 5,
      h: 4 + Math.random() * 4,
    };
  });
}

export default function OnboardingSuccessScreen() {
  const router = useRouter();
  const isRTL = useIsRTL();
  const params = useLocalSearchParams<{ name?: string }>();
  const [shopName, setShopName] = useState<string | null>(
    typeof params.name === "string" && params.name.trim() ? params.name.trim() : null,
  );

  // --- animation state (created once; all native-driver) ---
  const checkScale = useRef(new Animated.Value(0)).current;
  const ringProgress = useRef(new Animated.Value(0)).current;
  const titleProgress = useRef(new Animated.Value(0)).current;
  const cardProgress = useRef(new Animated.Value(0)).current;
  const bodyProgress = useRef(new Animated.Value(0)).current;
  const footerProgress = useRef(new Animated.Value(0)).current;
  // Lazy-init: useRef(makeConfetti()) would re-run the allocation (18
  // Animated.Values + ~150 Math.random calls) on EVERY re-render and discard
  // the result — and the shopName fallback effect guarantees a re-render
  // mid-burst on low-end devices.
  const confettiRef = useRef<ConfettiPiece[] | null>(null);
  if (confettiRef.current === null) confettiRef.current = makeConfetti();
  const confetti = confettiRef.current;

  useEffect(() => {
    const fadeUp = (v: Animated.Value, delay: number) =>
      Animated.timing(v, {
        toValue: 1,
        duration: 320,
        delay,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      });

    Animated.parallel([
      // The check pops...
      Animated.spring(checkScale, {
        toValue: 1,
        friction: 5,
        tension: 90,
        useNativeDriver: true,
      }),
      // ...a ring pulses out behind it...
      Animated.timing(ringProgress, {
        toValue: 1,
        duration: 650,
        easing: Easing.out(Easing.quad),
        useNativeDriver: true,
      }),
      // ...confetti arcs out of it...
      ...confetti.map((p) =>
        Animated.timing(p.progress, {
          toValue: 1,
          duration: p.duration,
          delay: p.delay,
          easing: Easing.out(Easing.cubic),
          useNativeDriver: true,
        }),
      ),
      // ...and the content lands in reading order.
      fadeUp(titleProgress, 250),
      Animated.spring(cardProgress, {
        toValue: 1,
        friction: 7,
        tension: 70,
        delay: 380,
        useNativeDriver: true,
      }),
      fadeUp(bodyProgress, 520),
      fadeUp(footerProgress, 640),
    ]).start();

    // Tactile half of the celebration; both best-effort (no vibrator /
    // haptics off). Success chord now, a light "thunk" when the sign lands.
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
    const thunk = setTimeout(() => {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
    }, 420);
    return () => clearTimeout(thunk);
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
        // Leave null — the sign card is hidden and the title still lands.
      }
    })();
  }, [shopName]);

  const fadeRise = (v: Animated.Value, from = 12) => ({
    opacity: v,
    transform: [{ translateY: v.interpolate({ inputRange: [0, 1], outputRange: [from, 0] }) }],
  });

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.content}>
        {/* Check + pulse ring + confetti share one anchor so the burst
            originates exactly at the check's center. The confetti layer is
            oversized + non-interactive; RN doesn't clip it, so pieces fall
            over the content below — deliberately. Hidden from screen
            readers wholesale: it's pure decoration, and TalkBack/VoiceOver
            stepping through 18 confetti views would be noise. */}
        <View
          style={styles.burstAnchor}
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
        >
          <Animated.View
            pointerEvents="none"
            style={[
              styles.ring,
              {
                opacity: ringProgress.interpolate({
                  inputRange: [0, 0.15, 1],
                  outputRange: [0, 0.35, 0],
                }),
                transform: [
                  {
                    scale: ringProgress.interpolate({ inputRange: [0, 1], outputRange: [1, 2.4] }),
                  },
                ],
              },
            ]}
          />
          {confetti.map((p, i) => (
            <Animated.View
              key={i}
              pointerEvents="none"
              style={[
                styles.confetti,
                {
                  width: p.w,
                  height: p.h,
                  backgroundColor: p.color,
                  opacity: p.progress.interpolate({
                    inputRange: [0, 0.05, 0.75, 1],
                    outputRange: [0, 1, 1, 0],
                  }),
                  transform: [
                    {
                      translateX: p.progress.interpolate({
                        inputRange: [0, 1],
                        outputRange: [0, p.dx],
                      }),
                    },
                    {
                      translateY: p.progress.interpolate({
                        // Rise to the arc peak, then fall past the origin.
                        inputRange: [0, 0.35, 1],
                        outputRange: [0, p.riseY, p.fallY],
                      }),
                    },
                    {
                      rotate: p.progress.interpolate({
                        inputRange: [0, 1],
                        outputRange: ["0deg", p.spin],
                      }),
                    },
                  ],
                },
              ]}
            />
          ))}
          <Animated.View style={[styles.checkWrap, { transform: [{ scale: checkScale }] }]}>
            <Ionicons name="checkmark" size={54} color={colors.textInverted} />
          </Animated.View>
        </View>

        <Animated.View style={[styles.titleWrap, fadeRise(titleProgress)]}>
          <Text style={styles.title}>{t("onboardingSuccess.title")}</Text>
        </Animated.View>

        {shopName ? (
          <Animated.View
            style={[
              styles.signCard,
              rowDir(isRTL),
              {
                opacity: cardProgress,
                transform: [
                  {
                    translateY: cardProgress.interpolate({
                      inputRange: [0, 1],
                      outputRange: [24, 0],
                    }),
                  },
                ],
              },
            ]}
          >
            <View style={[styles.signIconChip, isRTL ? { marginLeft: 14 } : { marginRight: 14 }]}>
              <Ionicons name="storefront-outline" size={20} color={colors.textInverted} />
            </View>
            <Text style={[styles.signName, textDir(isRTL)]} numberOfLines={2}>
              {shopName}
            </Text>
          </Animated.View>
        ) : null}

        <Animated.View style={[{ alignSelf: "stretch" }, fadeRise(bodyProgress, 8)]}>
          <Text style={styles.body}>{t("onboardingSuccess.body")}</Text>
        </Animated.View>
      </View>

      <Animated.View style={[styles.footer, fadeRise(footerProgress, 10)]}>
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
  // Anchor for the check + ring + confetti so every burst layer shares the
  // check's center. zIndex keeps falling confetti above the title/card on
  // iOS; on Android, sibling elevation trumps zIndex in the hardware
  // renderer's Z sort — the sign card's elevation:4 would put every falling
  // piece BEHIND it — so the anchor carries elevation:5 (no background, so
  // no visible shadow, just the Z lift).
  burstAnchor: {
    width: 96,
    height: 96,
    marginBottom: 30,
    alignItems: "center",
    justifyContent: "center",
    zIndex: 2,
    ...Platform.select({ android: { elevation: 5 } }),
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
  },
  ring: {
    position: "absolute",
    width: 96,
    height: 96,
    borderRadius: 48,
    borderWidth: 3,
    borderColor: colors.collectStrong,
  },
  confetti: {
    position: "absolute",
    borderRadius: 2,
  },
  titleWrap: { alignSelf: "stretch" },
  title: {
    fontSize: 24,
    fontFamily: fonts.sansBold,
    color: colors.textEmphasis,
    letterSpacing: -0.4,
    textAlign: "center",
  },
  // The shop sign — the hero. Black primary-surface card (same language as
  // the onboarding auth cards): the cover of the book they just created.
  signCard: {
    flexDirection: "row",
    alignItems: "center",
    alignSelf: "center",
    marginTop: 24,
    paddingVertical: 20,
    paddingHorizontal: 24,
    borderRadius: 18,
    backgroundColor: colors.bgInverted,
    maxWidth: "100%",
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
  signIconChip: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: colors.collectStrong,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  signName: {
    fontSize: 22,
    fontFamily: fonts.sansBold,
    color: colors.textInverted,
    letterSpacing: -0.3,
    flexShrink: 1,
  },
  body: {
    fontSize: 14,
    fontFamily: fonts.sansRegular,
    color: colors.textSubtle,
    lineHeight: sansLineHeight(14, 21),
    textAlign: "center",
    marginTop: 24,
  },
  footer: { paddingHorizontal: 24, paddingBottom: 16 },
});
