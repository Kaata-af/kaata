import { useRouter } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { colors } from "../../lib/colors";
import { setAppMeta } from "../../lib/db";
import { textDir, trackingSafe, useIsRTL } from "../../lib/direction";
import { fonts, sansLineHeight } from "../../lib/fonts";
import { setLocale, t } from "../../lib/i18n";
import { radius, typography } from "../../lib/tokens";

// Onboarding step 1 — only mounted by _layout's routing logic when the
// device locale is NOT already fa/prs. Persian-locale users skip directly
// to /onboarding/calendar (their language is already correct; asking them to
// pick "Persian or English" reads like a "we don't trust your device"
// signal).
//
// Two cards, each tap commits immediately (no Continue button). The
// translated copy under the cards is the only thing that updates locale —
// the cards themselves render their language names in their own scripts
// (English in Latin, دری in Persian) so users recognize them regardless
// of current locale.

export default function OnboardingLanguageScreen() {
  const router = useRouter();
  const isRTL = useIsRTL();
  const picking = useRef(false);
  const mounted = useRef(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  async function pick(code: "en" | "fa") {
    if (picking.current) return;
    picking.current = true;
    setBusy(true);
    setError(null);
    try {
      await setAppMeta("locale_pref", code);
      setLocale(code);
      if (!mounted.current) return;
      await setAppMeta("onboarding_step", "calendar");
      if (mounted.current) router.replace("/onboarding/calendar");
    } catch {
      if (mounted.current) setError(t("entry.saveFailed"));
    } finally {
      picking.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.content}>
        <Text style={[styles.brand, trackingSafe(isRTL)]}>{t("brand.wordmark")}</Text>
        <View style={styles.gapLarge} />
        <Text style={[styles.title, textDir(isRTL)]}>{t("onboardingLanguage.title")}</Text>
        <Text style={[styles.subtitle, textDir(isRTL)]}>{t("onboardingLanguage.subtitle")}</Text>

        <View style={styles.gapLarge} />

        <Pressable
          onPress={() => pick("en")}
          disabled={busy}
          accessibilityRole="button"
          accessibilityLabel="English"
          style={({ pressed }) => [styles.card, pressed && { opacity: 0.85 }]}
        >
          <Text style={styles.cardLabel}>English</Text>
        </Pressable>

        <View style={styles.gap} />

        <Pressable
          onPress={() => pick("fa")}
          disabled={busy}
          accessibilityRole="button"
          accessibilityLabel="دری"
          style={({ pressed }) => [styles.card, pressed && { opacity: 0.85 }]}
        >
          {/* Always render in Vazirmatn so the Dari card renders in its
              own script regardless of current locale. */}
          <Text style={[styles.cardLabel, styles.cardLabelFa]}>دری</Text>
        </Pressable>
        {error ? (
          <Text style={[styles.error, textDir(isRTL)]} accessibilityLiveRegion="polite">
            {error}
          </Text>
        ) : null}
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  error: { ...typography.bodySm, color: colors.danger, marginTop: 16, textAlign: "center" },
  container: { flex: 1, backgroundColor: colors.bgWarm },
  content: { flex: 1, padding: 24, justifyContent: "center" },
  brand: {
    fontSize: 28,
    fontFamily: fonts.sansBold,
    color: colors.brandPrimary,
    letterSpacing: -0.6,
    textAlign: "center",
  },
  title: {
    fontSize: 20,
    fontFamily: fonts.sansSemi,
    color: colors.textEmphasis,
    textAlign: "center",
  },
  subtitle: {
    fontSize: 13,
    fontFamily: fonts.sansRegular,
    color: colors.textSubtle,
    marginTop: 8,
    textAlign: "center",
    lineHeight: sansLineHeight(13, 19),
  },
  gap: { height: 14 },
  gapLarge: { height: 32 },
  card: {
    // radius.lg (16), not md — these are the same inset hero-card family as
    // the auth screen's provider cards (which carry the lift shadow), and the
    // two screens are seen seconds apart. Was a bare 14.
    borderRadius: radius.lg,
    paddingVertical: 22,
    paddingHorizontal: 20,
    borderWidth: 1,
    borderColor: colors.borderDefault,
    backgroundColor: colors.bgDefault,
    alignItems: "center",
  },
  cardLabel: {
    // typography.heading (20) — was 18, and sansSemi is already the token's
    // family, so this is a pure size step. The label is the ONLY text on the
    // card, so it legitimately takes the screen-headline step rather than a
    // row label.
    ...typography.heading,
    color: colors.textEmphasis,
  },
  cardLabelFa: {
    // The fa* font family in fonts.ts is already Vazirmatn, but call it
    // out explicitly here so future Inter-vs-Vazirmatn refactors don't
    // accidentally render دری in a Latin-only font.
    //
    // DELIBERATE OPTICAL BUMP — do NOT collapse this onto the type scale.
    //
    // Persian letterforms occupy less of the em box than Latin ones, so دری at
    // the same NOMINAL size as "English" reads visibly smaller. These two cards
    // sit one directly above the other — the single layout in the app where a
    // reader compares the two scripts side by side and the difference is
    // unmissable. A type scale governs nominal sizes; it cannot govern optical
    // ones. A consistency pass that flattens this makes the screen worse in the
    // name of tidiness, which is why it is spelled out here rather than left to
    // look like drift. (Originally 22 against English's 18; still 22, now
    // against typography.heading's 20 — a smaller correction, because the
    // English side grew.)
    fontSize: 22,
    lineHeight: sansLineHeight(22, 28),
    fontFamily: fonts.faSemi,
  },
});
