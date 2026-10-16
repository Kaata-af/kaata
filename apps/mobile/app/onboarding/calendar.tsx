import { Ionicons } from "@expo/vector-icons";
import { useFocusEffect, useRouter } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { BackHandler, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import {
  OnboardingAction,
  OnboardingHeader,
  OnboardingIntro,
  onboardingStyles,
} from "../../components/Onboarding";
import {
  CALENDAR_PREF_KEY,
  getEffectiveCalendar,
  setCalendarPref,
  type Calendar,
} from "../../lib/calendar";
import { colors } from "../../lib/colors";
import { setAppMeta } from "../../lib/db";
import { rowDir, textDir, useIsRTL } from "../../lib/direction";
import { getLocale, t } from "../../lib/i18n";
import { formatCalendarDate } from "../../lib/jalali";
import { radius, typography } from "../../lib/tokens";

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
    <SafeAreaView style={onboardingStyles.screen}>
      <OnboardingHeader onBack={() => void back()} disabled={busy} />
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={onboardingStyles.content}
        showsVerticalScrollIndicator={false}
      >
        <OnboardingIntro
          title={t("onboardingCalendar.title")}
          description={t("onboardingCalendar.subtitle")}
        />
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
                rowDir(rtl),
                selected === calendar && styles.selected,
                pressed && { backgroundColor: colors.bgMuted },
                busy && { opacity: 0.5 },
              ]}
            >
              <View style={styles.calendarText}>
                <Text style={[styles.label, textDir(rtl)]}>
                  {t(`settings.calendar.option.${calendar}`)}
                </Text>
                <Text style={[styles.example, textDir(rtl)]}>
                  {formatCalendarDate(today, getLocale(), calendar)}
                </Text>
                {calendar === "qamari" ? (
                  <Text style={[styles.hint, textDir(rtl)]}>
                    {t("settings.calendar.hint.qamari")}
                  </Text>
                ) : null}
              </View>
              <Ionicons
                name={selected === calendar ? "radio-button-on" : "radio-button-off"}
                size={22}
                color={selected === calendar ? colors.textEmphasis : colors.borderEmphasis}
              />
            </Pressable>
          ))}
        </View>
        {error ? (
          <Text style={[styles.error, textDir(rtl)]} accessibilityLiveRegion="polite">
            {error}
          </Text>
        ) : null}
      </ScrollView>
      <View style={onboardingStyles.footer}>
        <OnboardingAction
          label={t("onboarding.continue")}
          loading={busy}
          disabled={busy}
          onPress={() => void next()}
        />
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  choices: { gap: 12 },
  card: {
    minHeight: 76,
    padding: 16,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.borderDefault,
    backgroundColor: colors.bgDefault,
    alignItems: "center",
    gap: 16,
  },
  selected: { borderColor: colors.textEmphasis, backgroundColor: colors.bgMuted },
  calendarText: { flex: 1, minWidth: 0, gap: 4 },
  label: { ...typography.title, color: colors.textEmphasis },
  example: { ...typography.bodySm, color: colors.textSubtle },
  hint: { ...typography.caption, color: colors.textSubtle, marginTop: 4 },
  error: { ...typography.bodySm, color: colors.danger, marginTop: 16 },
});
