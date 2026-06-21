// Preferences — USER-level settings (NOT per-kaata).
//
// Matee: language + default country + app health are the user's own
// preferences and must NOT be mixed into a kaata's settings. The per-kaata
// CURRENCY lives in /vault/settings ("Manage this Kaata"); it is deliberately
// absent here. Settings split cleanly into: ACCOUNT (the sheet) + this screen
// (USER preferences) + Manage-this-Kaata (per-kaata).
//
// Sections, top to bottom:
//   1. LANGUAGE      — System default / English / دری
//   2. REGION        — default country code for new contacts' phone numbers
// (App health / diagnostics lives in the settings sheet next to About.)
//
// Auto-commit (no Save): picking an option writes app_meta + flips the
// in-memory module setter and closes the sheet; the page re-renders in place.
// Uses the same row→sheet picker style as the country picker so the two match.

import { useRouter } from "expo-router";
import { useEffect, useState } from "react";
import { ScrollView, StyleSheet } from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { CountryPickerSheet } from "../components/CountryPickerSheet";
import { OptionSheet } from "../components/OptionSheet";
import { NavRow, ScreenHeader, SectionGap, SectionHeader } from "../components/SettingsScreen";
import { useToast } from "../components/Toast";
import { colors } from "../lib/colors";
import { getAppMeta, setAppMeta } from "../lib/db";
import { useIsRTL } from "../lib/direction";
import { type LocalePref, setLocale, t } from "../lib/i18n";
import {
  getCountry,
  getCurrentDefaultCountryCode,
  setCurrentDefaultCountryCode,
} from "../lib/phone";

const LANGUAGE_OPTIONS: ReadonlyArray<{ value: LocalePref; labelKey: string }> = [
  { value: "system", labelKey: "settings.language.option.system" },
  { value: "en", labelKey: "settings.language.option.en" },
  { value: "fa", labelKey: "settings.language.option.fa" },
];

export default function PreferencesScreen() {
  const router = useRouter();
  const toast = useToast();
  const isRTL = useIsRTL();
  const insets = useSafeAreaInsets();

  const [loaded, setLoaded] = useState(false);
  const [localePref, setLocalePref] = useState<LocalePref>("system");
  const [countryCode, setCountryCode] = useState<string>("AF");

  const [langSheetVisible, setLangSheetVisible] = useState(false);
  const [countrySheetVisible, setCountrySheetVisible] = useState(false);

  useEffect(() => {
    (async () => {
      const storedPref = await getAppMeta("locale_pref");
      const pref: LocalePref = storedPref === "en" || storedPref === "fa" ? storedPref : "system";
      setLocalePref(pref);
      setCountryCode(getCurrentDefaultCountryCode());
      setLoaded(true);
    })();
  }, []);

  async function pickLanguage(value: LocalePref) {
    setLangSheetVisible(false);
    if (value === localePref) return;
    setLocalePref(value);
    setLocale(value);
    await setAppMeta("locale_pref", value);
    toast.push(t("settings.language.changed"), "success");
  }

  async function pickCountry(code: string) {
    setCountrySheetVisible(false);
    if (code === countryCode) return;
    setCountryCode(code);
    setCurrentDefaultCountryCode(code);
    await setAppMeta("default_country_code", code);
    toast.push(t("preferences.country.changed"), "success");
  }

  if (!loaded) return null;

  const selectedLangLabelKey =
    LANGUAGE_OPTIONS.find((o) => o.value === localePref)?.labelKey ??
    "settings.language.option.system";
  const languageValue = t(selectedLangLabelKey as Parameters<typeof t>[0]);

  const country = getCountry(countryCode);
  const countryValue = `${country.flag}  ${country.name}`;

  return (
    <SafeAreaView style={styles.container} edges={["top"]}>
      <ScreenHeader
        title={t("preferences.title")}
        onBack={() => router.back()}
        isRTL={isRTL}
        backLabel={t("common.back")}
      />

      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ paddingBottom: 24 + insets.bottom * 0.25 }}
      >
        {/* ============ LANGUAGE ============ */}
        <SectionHeader label={t("settings.language.label")} isRTL={isRTL} />
        <NavRow
          icon="language-outline"
          label={t("settings.language.label")}
          trailing={languageValue}
          onPress={() => setLangSheetVisible(true)}
          isRTL={isRTL}
          isLast
        />

        <SectionGap />

        {/* ============ REGION (default country for new contacts) ============ */}
        <SectionHeader label={t("preferences.region.section")} isRTL={isRTL} />
        <NavRow
          icon="flag-outline"
          label={t("preferences.country.label")}
          hint={t("preferences.country.hint")}
          trailing={countryValue}
          onPress={() => setCountrySheetVisible(true)}
          isRTL={isRTL}
          isLast
        />
      </ScrollView>

      <OptionSheet
        visible={langSheetVisible}
        title={t("settings.language.label")}
        options={LANGUAGE_OPTIONS.map((o) => ({
          key: o.value,
          label: t(o.labelKey as Parameters<typeof t>[0]),
        }))}
        selected={localePref}
        onSelect={(k) => pickLanguage(k as LocalePref)}
        onDismiss={() => setLangSheetVisible(false)}
        isRTL={isRTL}
      />
      <CountryPickerSheet
        visible={countrySheetVisible}
        selectedCode={countryCode}
        onSelect={pickCountry}
        onDismiss={() => setCountrySheetVisible(false)}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bgDefault },
});
