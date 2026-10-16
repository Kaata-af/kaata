import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { OnboardingHeader, OnboardingIntro, onboardingStyles } from "../../components/Onboarding";
import { colors } from "../../lib/colors";
import { setAppMeta } from "../../lib/db";
import { rowDir, textDir, useIsRTL } from "../../lib/direction";
import { fonts } from "../../lib/fonts";
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
    <SafeAreaView style={onboardingStyles.screen}>
      <OnboardingHeader />
      <ScrollView
        contentContainerStyle={onboardingStyles.content}
        showsVerticalScrollIndicator={false}
      >
        <OnboardingIntro
          title={t("onboardingLanguage.title")}
          description={t("onboardingLanguage.subtitle")}
        />
        <View style={styles.choices}>
          {(["en", "fa"] as const).map((code) => (
            <Pressable
              key={code}
              onPress={() => void pick(code)}
              disabled={busy}
              accessibilityRole="button"
              accessibilityLabel={code === "en" ? "English" : "دری"}
              accessibilityState={{ disabled: busy, busy }}
              style={({ pressed }) => [
                styles.card,
                rowDir(isRTL),
                pressed && styles.pressed,
                busy && { opacity: 0.5 },
              ]}
            >
              <Text style={[styles.cardLabel, code === "fa" && styles.cardLabelFa]}>
                {code === "en" ? "English" : "دری"}
              </Text>
              <Ionicons
                name={isRTL ? "arrow-back" : "arrow-forward"}
                size={20}
                color={colors.textMuted}
              />
            </Pressable>
          ))}
        </View>
        {error ? (
          <Text style={[styles.error, textDir(isRTL)]} accessibilityLiveRegion="polite">
            {error}
          </Text>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  error: { ...typography.bodySm, color: colors.danger, marginTop: 16 },
  choices: { gap: 12 },
  card: {
    minHeight: 64,
    paddingVertical: 16,
    paddingHorizontal: 18,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.borderDefault,
    backgroundColor: colors.bgDefault,
    alignItems: "center",
    justifyContent: "space-between",
    gap: 16,
  },
  pressed: { backgroundColor: colors.bgMuted },
  cardLabel: { ...typography.title, flexShrink: 1, color: colors.textEmphasis },
  cardLabelFa: { fontFamily: fonts.faSemi },
});
