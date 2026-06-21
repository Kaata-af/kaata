// Account — the user's PERSONAL settings (one place, per Matee). Edits the
// device identity (first/last name + phone), folds in the personal preferences
// (language + default country), and links to archived kaatas. Distinct from
// "Manage this Kaata" (per-kaata: name, currency, members).
//
// Name + phone are saved via updateSelfProfile (name is event-sourced when a
// kaata is active so shared members see it; phone is device-local identity).
// Language + default country auto-commit (no Save) like the old Preferences.

import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { Button } from "../components/Button";
import { CountryPickerSheet } from "../components/CountryPickerSheet";
import { OptionSheet } from "../components/OptionSheet";
import { NavRow, ScreenHeader, SectionGap, SectionHeader } from "../components/SettingsScreen";
import { useToast } from "../components/Toast";
import { colors } from "../lib/colors";
import { joinName, splitName } from "../lib/contacts-sync";
import { getAppMeta, getLocalSelf, setAppMeta, updateSelfProfile } from "../lib/db";
import { rowDir, textDir, useIsRTL } from "../lib/direction";
import { EventSigningUnavailableError, RoleGateRejectionError } from "../lib/event-log";
import { fonts } from "../lib/fonts";
import { type LocalePref, setLocale, t } from "../lib/i18n";
import {
  getCountry,
  getCurrentDefaultCountryCode,
  inferCountryFromE164,
  normalizePhone,
  setCurrentDefaultCountryCode,
} from "../lib/phone";

const LANGUAGE_OPTIONS: ReadonlyArray<{ value: LocalePref; labelKey: string }> = [
  { value: "system", labelKey: "settings.language.option.system" },
  { value: "en", labelKey: "settings.language.option.en" },
  { value: "fa", labelKey: "settings.language.option.fa" },
];

export default function AccountScreen() {
  const router = useRouter();
  const toast = useToast();
  const isRTL = useIsRTL();
  const insets = useSafeAreaInsets();

  const [loaded, setLoaded] = useState(false);
  // Profile (editable).
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [phone, setPhone] = useState("");
  const [phoneCountry, setPhoneCountry] = useState(getCurrentDefaultCountryCode);
  const [phonePickerVisible, setPhonePickerVisible] = useState(false);
  const [nameError, setNameError] = useState<string | null>(null);
  const [phoneError, setPhoneError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const lastNameRef = useRef<TextInput>(null);
  const phoneRef = useRef<TextInput>(null);

  // Preferences (auto-commit).
  const [localePref, setLocalePref] = useState<LocalePref>("system");
  const [langSheetVisible, setLangSheetVisible] = useState(false);
  const [prefCountry, setPrefCountry] = useState(getCurrentDefaultCountryCode);
  const [prefCountryVisible, setPrefCountryVisible] = useState(false);

  useEffect(() => {
    void (async () => {
      const self = await getLocalSelf();
      if (self) {
        const s = splitName(self.name);
        setFirstName(s.firstName);
        setLastName(s.lastName ?? "");
        if (self.phone) {
          const inferred = inferCountryFromE164(self.phone);
          const dial = getCountry(inferred).dialCode;
          setPhoneCountry(inferred);
          setPhone(self.phone.startsWith(dial) ? self.phone.slice(dial.length) : self.phone);
        }
      }
      const storedPref = await getAppMeta("locale_pref");
      setLocalePref(storedPref === "en" || storedPref === "fa" ? storedPref : "system");
      setPrefCountry(getCurrentDefaultCountryCode());
      setLoaded(true);
    })();
  }, []);

  async function onSave() {
    if (savingRef.current) return;
    const fn = firstName.trim();
    if (!fn) {
      setNameError(t("onboarding.nameRequired"));
      return;
    }
    setNameError(null);
    let normalizedPhone: string | null = null;
    const trimmedPhone = phone.trim();
    if (trimmedPhone) {
      normalizedPhone = normalizePhone(trimmedPhone, phoneCountry);
      if (!normalizedPhone) {
        setPhoneError(t("personAdd.phone.invalid"));
        return;
      }
    }
    setPhoneError(null);
    savingRef.current = true;
    setSaving(true);
    setSaveError(null);
    try {
      await updateSelfProfile(joinName(fn, lastName.trim() || null), null, normalizedPhone);
      toast.push(t("settings.saved"), "success");
      router.back();
    } catch (err) {
      console.warn("[account] updateSelfProfile failed", err);
      if (err instanceof EventSigningUnavailableError) {
        setSaveError(t("entry.signingUnavailable"));
      } else if (err instanceof RoleGateRejectionError) {
        setSaveError(t("entry.roleDenied"));
      } else {
        // Most likely a phone UNIQUE collision with an existing contact.
        setSaveError(t("personAdd.phone.conflict", { name: trimmedPhone }));
      }
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }

  async function pickLanguage(value: LocalePref) {
    setLangSheetVisible(false);
    if (value === localePref) return;
    setLocalePref(value);
    setLocale(value);
    await setAppMeta("locale_pref", value);
    toast.push(t("settings.language.changed"), "success");
  }

  async function pickPrefCountry(code: string) {
    setPrefCountryVisible(false);
    if (code === prefCountry) return;
    setPrefCountry(code);
    setCurrentDefaultCountryCode(code);
    await setAppMeta("default_country_code", code);
    toast.push(t("preferences.country.changed"), "success");
  }

  if (!loaded) {
    return (
      <SafeAreaView style={styles.container} edges={["top"]}>
        <View style={styles.fillCenter}>
          <ActivityIndicator color={colors.textDefault} />
        </View>
      </SafeAreaView>
    );
  }

  const phoneC = getCountry(phoneCountry);
  const selectedLangLabelKey =
    LANGUAGE_OPTIONS.find((o) => o.value === localePref)?.labelKey ??
    "settings.language.option.system";
  const languageValue = t(selectedLangLabelKey as Parameters<typeof t>[0]);
  const prefC = getCountry(prefCountry);

  return (
    <SafeAreaView style={styles.container} edges={["top"]}>
      <ScreenHeader
        title={t("account.title")}
        onBack={() => router.back()}
        isRTL={isRTL}
        backLabel={t("common.back")}
      />
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <ScrollView
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
          contentContainerStyle={{ paddingBottom: 24 + insets.bottom * 0.25 }}
        >
          {/* ============ PROFILE ============ */}
          <SectionHeader label={t("account.profile.section")} isRTL={isRTL} />
          <View style={styles.formInset}>
            <Text style={[styles.label, textDir(isRTL)]}>
              {t("personEdit.name.label")} <Text style={styles.required}>*</Text>
            </Text>
            <View style={styles.nameRow}>
              <TextInput
                style={[styles.nameInput, textDir(isRTL), nameError ? styles.inputError : null]}
                value={firstName}
                onChangeText={(v) => {
                  setNameError(null);
                  setFirstName(v);
                }}
                placeholder={t("personAdd.firstName.placeholder")}
                placeholderTextColor={colors.textMuted}
                accessibilityLabel={t("personEdit.firstName.label")}
                autoCapitalize="words"
                autoCorrect={false}
                maxLength={40}
                returnKeyType="next"
                onSubmitEditing={() => lastNameRef.current?.focus()}
                submitBehavior="submit"
              />
              <TextInput
                ref={lastNameRef}
                style={[styles.nameInput, textDir(isRTL)]}
                value={lastName}
                onChangeText={setLastName}
                placeholder={t("personAdd.lastName.placeholder")}
                placeholderTextColor={colors.textMuted}
                accessibilityLabel={t("personEdit.lastName.label")}
                autoCapitalize="words"
                autoCorrect={false}
                maxLength={40}
                returnKeyType="next"
                onSubmitEditing={() => phoneRef.current?.focus()}
                submitBehavior="submit"
              />
            </View>
            {nameError ? (
              <Text style={[styles.fieldError, textDir(isRTL)]} accessibilityLiveRegion="polite">
                {nameError}
              </Text>
            ) : null}

            <View style={{ height: 14 }} />
            <Text style={[styles.label, textDir(isRTL)]}>{t("personEdit.phone.label")}</Text>
            {/* Phone row stays physical-LTR (digits are LTR via Unicode bidi). */}
            <View style={styles.phoneRow}>
              <Pressable
                onPress={() => setPhonePickerVisible(true)}
                style={({ pressed }) => [
                  styles.countryBtn,
                  pressed && { backgroundColor: colors.bgMuted },
                ]}
              >
                <Text style={styles.countryFlag}>{phoneC.flag}</Text>
                <Text style={styles.countryDial}>{phoneC.dialCode}</Text>
                <Ionicons name="chevron-down" size={14} color={colors.textMuted} />
              </Pressable>
              <TextInput
                ref={phoneRef}
                style={[styles.phoneInput, phoneError ? styles.inputError : null]}
                value={phone}
                onChangeText={(v) => {
                  setPhoneError(null);
                  setPhone(v);
                }}
                placeholder={
                  phoneC.code === "AF" ? "70 123 4567" : t("personAdd.phone.placeholderGeneric")
                }
                placeholderTextColor={colors.textMuted}
                accessibilityLabel={t("personEdit.phone.label")}
                keyboardType="phone-pad"
                returnKeyType="done"
                onSubmitEditing={onSave}
              />
            </View>
            {phoneError ? (
              <Text style={[styles.fieldError, textDir(isRTL)]} accessibilityLiveRegion="polite">
                {phoneError}
              </Text>
            ) : null}
            {saveError ? (
              <Text style={[styles.fieldError, textDir(isRTL)]} accessibilityLiveRegion="polite">
                {saveError}
              </Text>
            ) : null}

            <View style={{ height: 14 }} />
            <Button label={t("account.save")} onPress={onSave} loading={saving} />
          </View>

          <SectionGap />

          {/* ============ PREFERENCES (personal) ============ */}
          <SectionHeader label={t("account.preferences.section")} isRTL={isRTL} />
          <NavRow
            icon="language-outline"
            label={t("settings.language.label")}
            trailing={languageValue}
            onPress={() => setLangSheetVisible(true)}
            isRTL={isRTL}
          />
          <NavRow
            icon="flag-outline"
            label={t("preferences.country.label")}
            hint={t("preferences.country.hint")}
            trailing={`${prefC.flag}  ${prefC.name}`}
            onPress={() => setPrefCountryVisible(true)}
            isRTL={isRTL}
            isLast
          />

          <SectionGap />

          {/* ============ KAATAS ============ */}
          <SectionHeader label={t("account.kaatas.section")} isRTL={isRTL} />
          <NavRow
            icon="archive-outline"
            label={t("account.archived.row")}
            onPress={() => router.push("/vault/archived")}
            isRTL={isRTL}
            isLast
          />
        </ScrollView>
      </KeyboardAvoidingView>

      <CountryPickerSheet
        visible={phonePickerVisible}
        selectedCode={phoneCountry}
        onSelect={(c) => setPhoneCountry(c)}
        onDismiss={() => setPhonePickerVisible(false)}
      />
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
        visible={prefCountryVisible}
        selectedCode={prefCountry}
        onSelect={pickPrefCountry}
        onDismiss={() => setPrefCountryVisible(false)}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bgDefault },
  fillCenter: { flex: 1, alignItems: "center", justifyContent: "center" },
  formInset: { paddingHorizontal: 20, paddingTop: 4 },
  label: {
    fontSize: 13,
    fontFamily: fonts.sansMedium,
    color: colors.textDefault,
    marginBottom: 8,
  },
  required: { color: colors.danger },
  nameRow: { flexDirection: "row", gap: 10 },
  nameInput: {
    flex: 1,
    minHeight: 44,
    borderWidth: 1,
    borderColor: colors.borderDefault,
    borderRadius: 8,
    paddingHorizontal: 14,
    fontSize: 15,
    fontFamily: fonts.sansRegular,
    color: colors.textEmphasis,
    backgroundColor: colors.bgDefault,
  },
  phoneRow: { flexDirection: "row", gap: 8 },
  countryBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    minHeight: 44,
    paddingHorizontal: 12,
    borderWidth: 1,
    borderColor: colors.borderDefault,
    borderRadius: 8,
    backgroundColor: colors.bgDefault,
  },
  countryFlag: { fontSize: 18 },
  countryDial: { fontSize: 14, fontFamily: fonts.monoMedium, color: colors.textEmphasis },
  phoneInput: {
    flex: 1,
    minHeight: 44,
    borderWidth: 1,
    borderColor: colors.borderDefault,
    borderRadius: 8,
    paddingHorizontal: 14,
    fontSize: 15,
    fontFamily: fonts.sansRegular,
    color: colors.textEmphasis,
    backgroundColor: colors.bgDefault,
  },
  inputError: { borderColor: colors.danger, backgroundColor: "rgba(220, 38, 38, 0.04)" },
  fieldError: {
    fontSize: 12,
    fontFamily: fonts.sansMedium,
    color: colors.danger,
    marginTop: 6,
  },
});
