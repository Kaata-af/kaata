import { getLocales } from "expo-localization";
import { Redirect, type Href } from "expo-router";
import { useEffect, useState } from "react";
import { ActivityIndicator, View } from "react-native";
import { colors } from "../../lib/colors";
import { getAppMeta, getLocalSelf } from "../../lib/db";
import { parseOnboardingStep, pickInitialRoute } from "../../lib/onboarding-route";

// `/onboarding` (no trailing path) used to be the single-step name form.
// Now it's a directory of {language, calendar, auth, profile, kaata, ...} screens.
// Keep this index stub so anyone (deep links, hard-coded references,
// future Settings "Re-do setup" affordance) hitting `/onboarding` lands
// on a real screen instead of an ambiguous 404.

export default function OnboardingIndex() {
  const [target, setTarget] = useState<Href | null>(null);
  useEffect(() => {
    let cancelled = false;
    const deviceLang = (getLocales()[0]?.languageCode ?? "en").toLowerCase();
    const deviceIsPersian = deviceLang === "fa" || deviceLang === "prs";
    void (async () => {
      const [self, rawStep, accountId] = await Promise.all([
        getLocalSelf(),
        getAppMeta("onboarding_step"),
        getAppMeta("account_id"),
      ]);
      const skipped = accountId
        ? await getAppMeta(`restore_skipped_for_account_${accountId}`)
        : null;
      if (!cancelled)
        setTarget(
          (
            "/" +
            pickInitialRoute({
              hasOnboarded: !!self,
              onboardingStep: parseOnboardingStep(rawStep),
              accountId,
              restoreSkipped: skipped === "1",
              deviceIsPersian,
            })
          ).replace("/index", "/") as Href,
        );
    })().catch(() => {
      if (!cancelled) setTarget(deviceIsPersian ? "/onboarding/calendar" : "/onboarding/language");
    });
    return () => {
      cancelled = true;
    };
  }, []);
  if (target) return <Redirect href={target} />;
  return (
    <View style={{ flex: 1, backgroundColor: colors.bgWarm, justifyContent: "center" }}>
      <ActivityIndicator color={colors.textSubtle} />
    </View>
  );
}
