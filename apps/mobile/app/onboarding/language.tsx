import { useRouter } from "expo-router";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { colors } from "../../lib/colors";
import { setAppMeta } from "../../lib/db";
import { textDir, useIsRTL } from "../../lib/direction";
import { fonts, sansLineHeight } from "../../lib/fonts";
import { setLocale, t } from "../../lib/i18n";

// Onboarding step 1 — only mounted by _layout's routing logic when the
// device locale is NOT already fa/prs. Persian-locale users skip directly
// to /onboarding/auth (their language is already correct; asking them to
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

  async function pick(code: "en" | "fa") {
    setLocale(code);
    await setAppMeta("locale_pref", code);
    await setAppMeta("onboarding_step", "auth");
    router.replace("/onboarding/auth");
  }

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.content}>
        <Text style={styles.brand}>{t("brand.wordmark")}</Text>
        <View style={styles.gapLarge} />
        <Text style={[styles.title, textDir(isRTL)]}>{t("onboardingLanguage.title")}</Text>
        <Text style={[styles.subtitle, textDir(isRTL)]}>{t("onboardingLanguage.subtitle")}</Text>

        <View style={styles.gapLarge} />

        <Pressable
          onPress={() => pick("en")}
          style={({ pressed }) => [styles.card, pressed && { opacity: 0.85 }]}
        >
          <Text style={styles.cardLabel}>English</Text>
        </Pressable>

        <View style={styles.gap} />

        <Pressable
          onPress={() => pick("fa")}
          style={({ pressed }) => [styles.card, pressed && { opacity: 0.85 }]}
        >
          {/* Always render in Vazirmatn so the Dari card renders in its
              own script regardless of current locale. */}
          <Text style={[styles.cardLabel, styles.cardLabelFa]}>دری</Text>
        </Pressable>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bgDefault },
  content: { flex: 1, padding: 24, justifyContent: "center" },
  brand: {
    fontSize: 28,
    fontFamily: fonts.sansBold,
    color: colors.textEmphasis,
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
    borderRadius: 14,
    paddingVertical: 22,
    paddingHorizontal: 20,
    borderWidth: 1,
    borderColor: colors.borderDefault,
    backgroundColor: colors.bgDefault,
    alignItems: "center",
  },
  cardLabel: {
    fontSize: 18,
    fontFamily: fonts.sansSemi,
    color: colors.textEmphasis,
  },
  cardLabelFa: {
    // The fa* font family in fonts.ts is already Vazirmatn, but call it
    // out explicitly here so future Inter-vs-Vazirmatn refactors don't
    // accidentally render دری in a Latin-only font.
    fontFamily: fonts.faSemi,
    fontSize: 22,
  },
});
