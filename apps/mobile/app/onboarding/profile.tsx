import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { useEffect, useRef, useState } from "react";
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Button } from "../../components/Button";
import { CountryPickerSheet } from "../../components/CountryPickerSheet";
import { FormField } from "../../components/FormField";
import { colors } from "../../lib/colors";
import { createSelfProfile, getAppMeta, setAppMeta } from "../../lib/db";
import { EventSigningUnavailableError } from "../../lib/event-log";
import { rowDir, textDir, useIsRTL } from "../../lib/direction";
import { fonts } from "../../lib/fonts";
import { t } from "../../lib/i18n";
import { getCountry, getCurrentDefaultCountryCode, normalizePhone } from "../../lib/phone";

// Onboarding final form step — name + shop. NEITHER field is prefilled
// from the Google profile (intentional UX call: shopkeepers' Google
// account is typically their formal name, not their shop persona).
// The email subtitle is the only Google-derived UI element.
//
// On successful submit:
//   1. createSelfProfile() writes users + shop_profile rows
//   2. app_meta is updated: onboarding_step='done', clear pending values
//   3. router.replace('/') — home renders. (The previous guided tour
//      was removed; see docs/tour-redesign.md for the postmortem.)
//
// Back button: returns to /onboarding/auth so the user can switch auth
// choice without force-quitting. Doesn't preserve typed input — that's
// the lesser of two evils vs trapping them on this screen.

export default function OnboardingProfileScreen() {
  const router = useRouter();
  const isRTL = useIsRTL();
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  // Country dial-code for the phone field — same compound field as person/new
  // and person/[id]/edit. Defaults to the user's preference (hydrated at
  // _layout init, so synchronously correct on mount); changeable via the
  // CountryPickerSheet. normalizePhone uses this country on submit.
  const [countryCode, setCountryCode] = useState(getCurrentDefaultCountryCode);
  const [pickerVisible, setPickerVisible] = useState(false);
  const [nameError, setNameError] = useState<string | null>(null);
  const [phoneError, setPhoneError] = useState<string | null>(null);
  // The kaata name is NOT collected during onboarding — creating an account
  // never forces creating a kaata. createSelfProfile makes only the local-self
  // user; the user creates / joins / restores their first kaata afterwards
  // (from the "no kaatas yet" home screen, or the "Join an existing kaata"
  // link below → pair-scan).
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [signedInEmail, setSignedInEmail] = useState<string | null>(null);
  const nameRef = useRef<TextInput>(null);
  const phoneRef = useRef<TextInput>(null);
  // Synchronous re-entry guard — `busy` state can't stop a same-frame
  // double-tap (setState is async); see entry/new.tsx.
  const savingRef = useRef(false);
  const country = getCountry(countryCode);

  useEffect(() => {
    (async () => {
      const email = await getAppMeta("onboarding_pending_email");
      if (email) setSignedInEmail(email);
    })();
  }, []);

  // Focus the name input via ref + delayed setTimeout instead of `autoFocus`.
  // Per CLAUDE.md: autoFocus on TextInputs inside Stack screens has been
  // observed to fail to open the soft keyboard on Android because focus
  // is requested before the screen-presentation animation finishes. The
  // 280ms delay outlasts every Stack transition we use today.
  useEffect(() => {
    const t = setTimeout(() => nameRef.current?.focus(), 280);
    return () => clearTimeout(t);
  }, []);

  async function finalize(targetRoute: "/" | "/vault/pair-scan"): Promise<void> {
    if (savingRef.current) return;
    const trimmedName = name.trim();
    const trimmedPhone = phone.trim();

    if (!trimmedName) {
      setNameError(t("onboardingProfile.nameRequired"));
      nameRef.current?.focus();
      return;
    }
    setNameError(null);

    // Normalize to E.164 like every other phone write path. Without this,
    // the raw string ("0700123456", spaces, typos) landed verbatim in
    // users.phone_e164 — the column the data model treats as canonical
    // identity — with zero feedback for typos.
    let normalizedPhone: string | null = null;
    if (trimmedPhone) {
      normalizedPhone = normalizePhone(trimmedPhone, countryCode);
      if (!normalizedPhone) {
        setPhoneError(t("personAdd.phone.invalid"));
        phoneRef.current?.focus();
        return;
      }
    }
    setPhoneError(null);

    savingRef.current = true;
    setSubmitError(null);
    setBusy(true);
    try {
      // No kaata name → createSelfProfile creates only the local-self user, no
      // vault. The user makes their first kaata from the "no kaatas" home
      // screen (or by pairing/restoring). (Matee: account creation must not
      // force creating a kaata.)
      await createSelfProfile(trimmedName, "", normalizedPhone);
      await setAppMeta("onboarding_step", "done");
      await setAppMeta("onboarding_pending_name", "");
      await setAppMeta("onboarding_pending_email", "");
      router.replace(targetRoute);
    } catch (err) {
      // createSelfProfile rarely throws — DB constraint violations are
      // the realistic case (e.g. a stale self user row from a partial
      // earlier reset). Surface inline so the user knows their tap
      // landed but something failed; falls back to a generic message.
      console.warn("[onboarding/profile] createSelfProfile failed", err);
      // Mythos Fix Set C: signing-unavailable gets an actionable message.
      if (err instanceof EventSigningUnavailableError) {
        setSubmitError(t("entry.signingUnavailable"));
      } else {
        setSubmitError(t("entry.saveFailed"));
      }
    } finally {
      savingRef.current = false;
      setBusy(false);
    }
  }

  async function onSubmit() {
    await finalize("/");
  }

  async function onJoinExisting() {
    // "I'll join an existing kaata" path: create the local-self user (name +
    // optional phone) and route straight to the QR scanner. No kaata is minted
    // here — pair-scan creates the joined vault. If they back out without
    // pairing they have zero kaatas and land on the "no kaatas yet" screen.
    await finalize("/vault/pair-scan");
  }

  async function onBack() {
    // Step back to auth picker. Clear the pending Google name/email so
    // if they then choose offline, no stale subtitle persists.
    await setAppMeta("onboarding_pending_name", "");
    await setAppMeta("onboarding_pending_email", "");
    await setAppMeta("onboarding_step", "auth");
    router.replace("/onboarding/auth");
  }

  return (
    <SafeAreaView style={styles.container}>
      <View style={[styles.header, rowDir(isRTL)]}>
        <Pressable
          onPress={onBack}
          hitSlop={10}
          style={({ pressed }) => [styles.backBtn, pressed && { opacity: 0.6 }]}
        >
          <Ionicons
            name={isRTL ? "chevron-forward" : "chevron-back"}
            size={22}
            color={colors.textEmphasis}
          />
          <Text style={[styles.backText, textDir(isRTL)]}>{t("onboardingMode.back")}</Text>
        </Pressable>
      </View>

      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === "ios" ? "padding" : "height"}
      >
        <ScrollView
          contentContainerStyle={styles.scrollContent}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          <Text style={[styles.title, textDir(isRTL)]}>{t("onboardingProfile.title")}</Text>
          {signedInEmail ? (
            <Text style={[styles.subtitle, textDir(isRTL)]}>
              {t("onboardingProfile.signedInHint", { email: signedInEmail })}
            </Text>
          ) : null}

          <View style={styles.spacer} />

          <FormField
            ref={nameRef}
            label={t("onboarding.name.label")}
            required
            value={name}
            onChangeText={(s) => {
              setName(s);
              if (nameError) setNameError(null);
            }}
            placeholder={t("onboarding.name.placeholder")}
            autoCapitalize="words"
            returnKeyType="next"
            onSubmitEditing={() => phoneRef.current?.focus()}
            submitBehavior="submit"
            error={nameError}
          />

          {/* Phone with country picker — same compound field as person/new and
              person/[id]/edit. The row stays physical-LTR (Western digits
              render LTR via Unicode bidi regardless of locale); the label and
              hint flip via textDir to follow reading order. */}
          <View>
            <Text style={[styles.fieldLabel, textDir(isRTL)]}>{t("onboarding.phone.label")}</Text>
            <View style={styles.phoneRow}>
              <Pressable
                onPress={() => setPickerVisible(true)}
                style={({ pressed }) => [
                  styles.countryBtn,
                  pressed && { backgroundColor: colors.bgMuted },
                ]}
                accessibilityRole="button"
                accessibilityLabel={t("onboarding.phone.label")}
              >
                <Text style={styles.countryFlag}>{country.flag}</Text>
                <Text style={styles.countryDial}>{country.dialCode}</Text>
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
                  country.code === "AF" ? "70 123 4567" : t("personAdd.phone.placeholderGeneric")
                }
                placeholderTextColor={colors.textMuted}
                accessibilityLabel={t("onboarding.phone.label")}
                keyboardType="phone-pad"
                autoCorrect={false}
                returnKeyType="done"
                onSubmitEditing={onSubmit}
                submitBehavior="submit"
              />
            </View>
            {phoneError ? (
              <Text style={[styles.fieldError, textDir(isRTL)]} accessibilityLiveRegion="polite">
                {phoneError}
              </Text>
            ) : null}
          </View>
          <Text style={[styles.fieldHint, textDir(isRTL)]}>{t("onboarding.phone.hint")}</Text>

          {submitError ? (
            <Text style={[styles.submitError, textDir(isRTL)]} accessibilityLiveRegion="polite">
              {submitError}
            </Text>
          ) : null}

          <View style={{ height: 12 }} />
          <Button label={t("onboardingProfile.continue")} onPress={onSubmit} loading={busy} />

          <View style={{ height: 14 }} />
          <Pressable
            onPress={onJoinExisting}
            disabled={busy}
            style={({ pressed }) => [styles.joinLink, pressed && { opacity: 0.6 }]}
          >
            <Text style={[styles.joinLinkText, textDir(isRTL)]}>
              {t("onboardingProfile.joinExisting")}
            </Text>
          </Pressable>
        </ScrollView>
      </KeyboardAvoidingView>

      <CountryPickerSheet
        visible={pickerVisible}
        selectedCode={countryCode}
        onSelect={(c) => setCountryCode(c)}
        onDismiss={() => setPickerVisible(false)}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bgDefault },
  header: {
    paddingHorizontal: 8,
    paddingTop: 8,
    paddingBottom: 4,
    flexDirection: "row",
    alignItems: "center",
  },
  backBtn: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 8,
    paddingVertical: 8,
    gap: 2,
  },
  backText: {
    fontSize: 15,
    fontFamily: fonts.sansMedium,
    color: colors.textSubtle,
  },
  scrollContent: {
    flexGrow: 1,
    padding: 24,
    paddingTop: 12,
    paddingBottom: 48,
  },
  title: {
    fontSize: 22,
    fontFamily: fonts.sansBold,
    color: colors.textEmphasis,
    letterSpacing: -0.4,
  },
  subtitle: {
    fontSize: 13,
    fontFamily: fonts.sansRegular,
    color: colors.textSubtle,
    marginTop: 6,
    lineHeight: 19,
  },
  spacer: { height: 28 },
  fieldHint: {
    fontSize: 12,
    fontFamily: fonts.sansRegular,
    color: colors.textSubtle,
    marginTop: 6,
    marginBottom: 14,
    lineHeight: 17,
  },
  joinLink: {
    alignItems: "center",
    paddingVertical: 10,
  },
  joinLinkText: {
    fontSize: 14,
    fontFamily: fonts.sansMedium,
    color: colors.textSubtle,
    textDecorationLine: "underline",
  },
  submitError: {
    fontSize: 13,
    fontFamily: fonts.sansMedium,
    color: colors.danger,
    marginBottom: 4,
  },
  // Phone field with country picker — mirrors person/new.tsx.
  fieldLabel: {
    fontSize: 13,
    fontFamily: fonts.sansMedium,
    color: colors.textDefault,
    marginBottom: 8,
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
  countryDial: {
    fontSize: 14,
    fontFamily: fonts.monoMedium,
    color: colors.textEmphasis,
  },
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
  inputError: {
    borderColor: colors.danger,
    backgroundColor: "rgba(220, 38, 38, 0.04)",
  },
  fieldError: {
    fontSize: 12,
    fontFamily: fonts.sansMedium,
    color: colors.danger,
    marginTop: 6,
  },
});
