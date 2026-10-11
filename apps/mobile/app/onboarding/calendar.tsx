import { Ionicons } from "@expo/vector-icons";
import { useFocusEffect, useRouter } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { BackHandler, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Button } from "../../components/Button";
import {
  CALENDAR_PREF_KEY,
  getEffectiveCalendar,
  setCalendarPref,
  type Calendar,
} from "../../lib/calendar";
import { colors } from "../../lib/colors";
import { setAppMeta } from "../../lib/db";
import { rowDir, textDir, trackingSafe, useIsRTL } from "../../lib/direction";
import { fonts } from "../../lib/fonts";
import { getLocale, t } from "../../lib/i18n";
import { formatCalendarDate } from "../../lib/jalali";
import { icon, radius, TOUCH_MIN, typography } from "../../lib/tokens";

const choices: Calendar[] = ["gregorian", "jalali", "qamari"];

/** Device-local display preference, chosen after language and before sign-in. */
export default function OnboardingCalendarScreen() {
  const router = useRouter();
  const rtl = useIsRTL();
  const [selected, setSelected] = useState<Calendar>(getEffectiveCalendar);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const working = useRef(false);
  const mounted = useRef(true);
  const today = useRef(Date.now()).current;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  async function back() {
    if (working.current) return;
    working.current = true;
    setBusy(true);
    setError(null);
    try {
      await setAppMeta("onboarding_step", "language");
      if (mounted.current) router.replace("/onboarding/language");
    } catch {
      if (mounted.current) setError(t("entry.saveFailed"));
    } finally {
      working.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  useFocusEffect(
    useCallback(() => {
      const sub = BackHandler.addEventListener("hardwareBackPress", () => {
        void back();
        return true;
      });
      return () => sub.remove();
      // back reads only stable navigation/setters and the immediate work guard.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []),
  );

  async function next() {
    if (working.current) return;
    working.current = true;
    setBusy(true);
    setError(null);
    try {
      await setAppMeta(CALENDAR_PREF_KEY, selected);
      setCalendarPref(selected);
      if (!mounted.current) return;
      await setAppMeta("onboarding_step", "auth");
      if (mounted.current) router.replace("/onboarding/auth");
    } catch {
      if (mounted.current) setError(t("entry.saveFailed"));
    } finally {
      working.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  return (
    <SafeAreaView style={styles.container}>
      <Pressable
        onPress={() => void back()}
        disabled={busy}
        accessibilityRole="button"
        accessibilityLabel={t("common.back")}
        style={[styles.back, rowDir(rtl)]}
      >
        <Ionicons
          name={rtl ? "chevron-forward" : "chevron-back"}
          size={icon.row}
          color={colors.textEmphasis}
        />
        <Text style={[styles.backText, textDir(rtl)]}>{t("common.back")}</Text>
      </Pressable>
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={[styles.brand, trackingSafe(rtl)]}>{t("brand.wordmark")}</Text>
        <Text style={[styles.title, textDir(rtl)]}>{t("onboardingCalendar.title")}</Text>
        <Text style={[styles.subtitle, textDir(rtl)]}>{t("onboardingCalendar.subtitle")}</Text>
        <View style={styles.choices} accessibilityRole="radiogroup">
          {choices.map((calendar) => (
            <Pressable
              key={calendar}
              disabled={busy}
              accessibilityRole="radio"
              accessibilityState={{ checked: selected === calendar, disabled: busy }}
              accessibilityLabel={t(`settings.calendar.option.${calendar}`)}
              accessibilityHint={
                calendar === "qamari" ? t("settings.calendar.hint.qamari") : undefined
              }
              onPress={() => setSelected(calendar)}
              style={({ pressed }) => [
                styles.card,
                selected === calendar && styles.selected,
                pressed && { opacity: 0.85 },
              ]}
            >
              <View style={[styles.labelRow, rowDir(rtl)]}>
                <Text style={[styles.label, textDir(rtl)]}>
                  {t(`settings.calendar.option.${calendar}`)}
                </Text>
                {selected === calendar ? (
                  <Ionicons name="checkmark-circle" size={22} color={colors.actionPrimary} />
                ) : null}
              </View>
              <Text style={[styles.example, textDir(rtl)]}>
                {formatCalendarDate(today, getLocale(), calendar)}
              </Text>
              {calendar === "qamari" ? (
                <Text style={[styles.hint, textDir(rtl)]}>
                  {t("settings.calendar.hint.qamari")}
                </Text>
              ) : null}
            </Pressable>
          ))}
        </View>
        {error ? (
          <Text style={[styles.error, textDir(rtl)]} accessibilityLiveRegion="polite">
            {error}
          </Text>
        ) : null}
        <Button
          label={t("onboarding.continue")}
          size="hero"
          fullWidth
          loading={busy}
          disabled={busy}
          onPress={() => void next()}
        />
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bgWarm },
  back: { minHeight: TOUCH_MIN, alignItems: "center", paddingHorizontal: 20, gap: 4 },
  backText: { ...typography.bodySm, color: colors.textEmphasis },
  content: { flexGrow: 1, justifyContent: "center", padding: 24 },
  brand: {
    ...typography.heading,
    fontFamily: fonts.sansBold,
    color: colors.brandPrimary,
    textAlign: "center",
    marginBottom: 28,
  },
  title: { ...typography.heading, color: colors.textEmphasis, textAlign: "center" },
  subtitle: { ...typography.bodySm, color: colors.textSubtle, textAlign: "center", marginTop: 8 },
  choices: { gap: 12, marginVertical: 28 },
  card: {
    padding: 18,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.borderDefault,
    backgroundColor: colors.bgDefault,
  },
  selected: { borderColor: colors.actionPrimary },
  labelRow: { alignItems: "center", justifyContent: "space-between", gap: 12 },
  label: { ...typography.title, color: colors.textEmphasis, flexShrink: 1 },
  example: { ...typography.bodySm, color: colors.textSubtle, marginTop: 6 },
  hint: { ...typography.caption, color: colors.textSubtle, marginTop: 8 },
  error: { ...typography.bodySm, color: colors.danger, marginBottom: 16 },
});
