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
import { getAppMeta, setAppMeta } from "../../lib/db";
import { rowDir, textDir, trackingSafe, useIsRTL } from "../../lib/direction";
import { fonts, sansLineHeight } from "../../lib/fonts";
import { t } from "../../lib/i18n";
import {
  getCountry,
  getCurrentDefaultCountryCode,
  inferCountryFromE164,
  normalizePhone,
} from "../../lib/phone";

// Onboarding identity step — name + phone. The name IS prefilled from the
// Google profile name stashed at sign-in (onboarding_pending_name) so a
// returning user isn't forced to retype it; they can edit before saving. (A
// user who had backed-up data never reaches this screen — restore rehydrates
// their saved self-profile and routing skips onboarding.) The email subtitle
// is the other Google-derived UI element.
//
// This step does NOT create the local-self user. It stashes the entered
// identity in app_meta and advances to the kaata step (onboarding/kaata.tsx),
// which collects the shop name and then mints self + first vault together.
// Self-creation is deferred there on purpose: hasOnboarded is derived from
// "a local_self row exists", so creating the self here would flip the user to
// "onboarded" and routing would skip the kaata step. Keeping self + vault
// creation atomic in the next step guarantees a fresh account lands on home
// WITH a kaata, never the confusing empty "create a kaata" state.
//
// On submit: stash name/phone -> onboarding_step='kaata' -> /onboarding/kaata.
//
// Back button: returns to /onboarding/auth so the user can switch auth
// choice without force-quitting. Doesn't preserve typed input — that's
// the lesser of two evils vs trapping them on this screen.

export default function OnboardingProfileScreen() {
  const router = useRouter();
  const isRTL = useIsRTL();
  const [name, setName] = useState("");
  const [lastName, setLastName] = useState("");
  const [phone, setPhone] = useState("");
  // Country dial-code for the phone field — same compound field as person/new
  // and person/[id]/edit. Defaults to the user's preference (hydrated at
  // _layout init, so synchronously correct on mount); changeable via the
  // CountryPickerSheet. normalizePhone uses this country on submit.
  const [countryCode, setCountryCode] = useState(getCurrentDefaultCountryCode);
  const [pickerVisible, setPickerVisible] = useState(false);
  const [nameError, setNameError] = useState<string | null>(null);
  const [phoneError, setPhoneError] = useState<string | null>(null);
  // The kaata name is collected on the NEXT step (onboarding/kaata.tsx), which
  // also mints the self + first vault. A user who JOINS an existing kaata via
  // an invite link never reaches that step — accepting the invite creates the
  // self and routing then short-circuits to home (no join option here).
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [signedInEmail, setSignedInEmail] = useState<string | null>(null);
  const nameRef = useRef<TextInput>(null);
  const lastNameRef = useRef<TextInput>(null);
  const phoneRef = useRef<TextInput>(null);
  // Synchronous re-entry guard — `busy` state can't stop a same-frame
  // double-tap (setState is async); see entry/new.tsx.
  const savingRef = useRef(false);
  const country = getCountry(countryCode);

  useEffect(() => {
    (async () => {
      const email = await getAppMeta("onboarding_pending_email");
      if (email) setSignedInEmail(email);
      // Prefill name + last name. Prefer what the user actually typed on this
      // step (stashed as onboarding_self_name when they advanced to the kaata
      // step) so tapping Back from the kaata step restores their input — vital
      // for offline users, who have no Google name to fall back on. Otherwise
      // fall back to the Google identity stashed at sign-in so a returning user
      // isn't asked to retype it. (A user who actually had backed-up data has
      // this screen skipped entirely — restore rehydrates their saved profile.)
      // The name is one string, so split on the first space into first / rest.
      const pendingName =
        (await getAppMeta("onboarding_self_name"))?.trim() ||
        (await getAppMeta("onboarding_pending_name"))?.trim();
      if (pendingName) {
        const sp = pendingName.indexOf(" ");
        const first = sp === -1 ? pendingName : pendingName.slice(0, sp);
        const rest = sp === -1 ? "" : pendingName.slice(sp + 1).trim();
        setName((prev) => (prev ? prev : first));
        if (rest) setLastName((prev) => (prev ? prev : rest));
      }
      // BUG-1: prefill the phone — the user's typed value if they're returning
      // from the kaata step (onboarding_self_phone), else the account-level
      // value returned at sign-in (onboarding_pending_phone). Stored E.164 →
      // infer the country and show the national part. User can edit.
      const pendingPhone =
        (await getAppMeta("onboarding_self_phone"))?.trim() ||
        (await getAppMeta("onboarding_pending_phone"))?.trim();
      if (pendingPhone) {
        const inferred = inferCountryFromE164(pendingPhone);
        const dial = getCountry(inferred).dialCode;
        setCountryCode(inferred);
        setPhone((prev) =>
          prev
            ? prev
            : pendingPhone.startsWith(dial)
              ? pendingPhone.slice(dial.length)
              : pendingPhone,
        );
      }
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

  async function finalize(): Promise<void> {
    if (savingRef.current) return;
    const trimmedName = name.trim();
    const trimmedLast = lastName.trim();
    const trimmedPhone = phone.trim();

    if (!trimmedName) {
      setNameError(t("onboardingProfile.nameRequired"));
      nameRef.current?.focus();
      return;
    }
    setNameError(null);

    // Phone is REQUIRED during onboarding (Matee). Empty → inline error +
    // focus, same affordance as the name field above. The number is the
    // canonical identity the rest of the data model keys on, and it's how
    // staff find the shopkeeper when pairing — so we no longer let it be
    // skipped at sign-up.
    if (!trimmedPhone) {
      setPhoneError(t("onboarding.phone.required"));
      phoneRef.current?.focus();
      return;
    }

    // Last name is optional. Stored combined into the single display_name the
    // data model uses everywhere ("First Last"); no schema change.
    const fullName = trimmedLast ? `${trimmedName} ${trimmedLast}` : trimmedName;

    // Normalize to E.164 like every other phone write path. Without this,
    // the raw string ("0700123456", spaces, typos) landed verbatim in
    // users.phone_e164 — the column the data model treats as canonical
    // identity — with zero feedback for typos.
    const normalizedPhone = normalizePhone(trimmedPhone, countryCode);
    if (!normalizedPhone) {
      setPhoneError(t("personAdd.phone.invalid"));
      phoneRef.current?.focus();
      return;
    }
    setPhoneError(null);

    savingRef.current = true;
    setSubmitError(null);
    setBusy(true);
    try {
      // Don't create the local-self user here — that's deferred to the kaata
      // step so "self exists" (which flips hasOnboarded) coincides with "has a
      // kaata", guaranteeing a fresh account lands on home WITH a kaata instead
      // of the confusing empty "create a kaata" state. Stash the entered
      // identity (resume-safe across a force-quit) for that step to consume.
      await setAppMeta("onboarding_self_name", fullName);
      await setAppMeta("onboarding_self_phone", normalizedPhone);
      await setAppMeta("onboarding_step", "kaata");
      router.replace("/onboarding/kaata");
    } catch (err) {
      // setAppMeta failing is the only realistic case here (storage error);
      // surface inline so the user knows their tap landed but something failed.
      console.warn("[onboarding/profile] advance to kaata step failed", err);
      setSubmitError(t("entry.saveFailed"));
    } finally {
      savingRef.current = false;
      setBusy(false);
    }
  }

  async function onSubmit() {
    await finalize();
  }

  async function onBack() {
    // Step back to auth picker. Clear the pending Google name/email so
    // if they then choose offline, no stale subtitle persists.
    await setAppMeta("onboarding_pending_name", "");
    await setAppMeta("onboarding_pending_email", "");
    await setAppMeta("onboarding_pending_phone", "");
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
          <Text style={[styles.title, textDir(isRTL), trackingSafe(isRTL)]}>
            {t("onboardingProfile.title")}
          </Text>
          {/* Why-we-ask subtitle — offline users got NO context here before
              (the only subtitle was the signed-in-as hint). */}
          <Text style={[styles.subtitle, textDir(isRTL)]}>{t("onboardingProfile.subtitle")}</Text>
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
            onSubmitEditing={() => lastNameRef.current?.focus()}
            submitBehavior="submit"
            error={nameError}
          />

          <FormField
            ref={lastNameRef}
            label={t("onboarding.lastName.label")}
            value={lastName}
            onChangeText={setLastName}
            placeholder={t("onboarding.lastName.placeholder")}
            autoCapitalize="words"
            returnKeyType="next"
            onSubmitEditing={() => phoneRef.current?.focus()}
            submitBehavior="submit"
          />

          {/* Phone with country picker — same compound field as person/new and
              person/[id]/edit. The row stays physical-LTR (Western digits
              render LTR via Unicode bidi regardless of locale); the label and
              hint flip via textDir to follow reading order. */}
          <View>
            <Text style={[styles.fieldLabel, textDir(isRTL)]}>
              {t("onboarding.phone.label")}
              <Text style={styles.required}> *</Text>
            </Text>
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
    lineHeight: sansLineHeight(13, 19),
  },
  spacer: { height: 28 },
  fieldHint: {
    fontSize: 12,
    fontFamily: fonts.sansRegular,
    color: colors.textSubtle,
    marginTop: 6,
    marginBottom: 14,
    lineHeight: sansLineHeight(12, 17),
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
  required: { color: colors.danger },
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
