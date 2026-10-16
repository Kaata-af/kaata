import { Ionicons } from "@expo/vector-icons";
import { useFocusEffect, useRouter } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  BackHandler,
  Keyboard,
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
import { CountryPickerSheet } from "../../components/CountryPickerSheet";
import { FormField } from "../../components/FormField";
import {
  OnboardingAction,
  OnboardingHeader,
  OnboardingIntro,
  onboardingStyles,
} from "../../components/Onboarding";
import {
  accountNameIsOurs,
  accountNameProblem,
  normalizeAccountName,
} from "../../lib/account-rules";
import { currentSessionKind, fetchAccountMe, syncAccountName } from "../../lib/auth";
import { colors } from "../../lib/colors";
import { getAppMeta, setAppMeta } from "../../lib/db";
import { ltrIsolate, textDir, useIsRTL } from "../../lib/direction";
import { fonts, sansLineHeight } from "../../lib/fonts";
import { t } from "../../lib/i18n";
import {
  getCountry,
  getCurrentDefaultCountryCode,
  inferCountryFromE164,
  normalizePhone,
} from "../../lib/phone";
import { icon } from "../../lib/tokens";
import { useOnboardingKeyboardScroll } from "../../lib/use-onboarding-keyboard-scroll";

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
  const { scrollProps, focusInput, blurInput } = useOnboardingKeyboardScroll();
  // Synchronous re-entry guard — `busy` state can't stop a same-frame
  // double-tap (setState is async); see entry/new.tsx.
  const savingRef = useRef(false);
  // The account's name is ours to set (an email account: no Google or Apple
  // identity names it), so the name typed here is the ACCOUNT's too: it
  // follows the server's rule and every Continue sends it. Decided from the
  // account's providers: an email session may be a Google account that added
  // a password. Only an email session can be ours, so only it asks.
  const nameOursRef = useRef(false);
  const country = getCountry(countryCode);

  useEffect(() => {
    void (async () => {
      const kind = await currentSessionKind().catch(() => null);
      if (kind !== "email") return;
      const me = await fetchAccountMe().catch(() => null);
      nameOursRef.current = accountNameIsOurs(me ? me.providers : null, kind);
    })();
  }, []);

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
    const typedName = trimmedLast ? `${trimmedName} ${trimmedLast}` : trimmedName;
    // A name that is ours to set is the account's, kept to the server's rule
    // (§6.11): whitespace collapsed, 2 to 60 characters.
    const nameOurs = nameOursRef.current;
    const fullName = nameOurs ? normalizeAccountName(typedName) : typedName;
    if (nameOurs && accountNameProblem(fullName)) {
      setNameError(t("auth.error.name.invalid"));
      nameRef.current?.focus();
      return;
    }

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
      // An email account has no name until the phone gives it one, and shared
      // tallies, reviews and pushes show the ACCOUNT's name (§7). When the
      // name is ours, every Continue sends it as it is NOW, so a name fixed
      // after Back from the kaata step reaches the server too. Otherwise only
      // a name still owed is sent (never for Google or Apple, whose provider
      // names the account). Never throws; check-in retries a send that did not
      // arrive. Not awaited: the next step must not wait on the network.
      void syncAccountName(fullName, nameOurs ? { force: true } : {});
      Keyboard.dismiss();
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

  const onBack = useCallback(async () => {
    if (savingRef.current) return;
    savingRef.current = true;
    setBusy(true);
    setSubmitError(null);
    Keyboard.dismiss();
    try {
      // Returning to the provider choice must not race Continue, or leave
      // an old provider identity visible after choosing the offline path.
      await setAppMeta("onboarding_pending_name", "");
      await setAppMeta("onboarding_pending_email", "");
      await setAppMeta("onboarding_pending_phone", "");
      await setAppMeta("onboarding_step", "auth");
      router.replace("/onboarding/auth");
    } catch (err) {
      console.warn("[onboarding/profile] return to auth failed", err);
      setSubmitError(t("entry.saveFailed"));
    } finally {
      savingRef.current = false;
      setBusy(false);
    }
  }, [router]);

  useFocusEffect(
    useCallback(() => {
      const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
        void onBack();
        return true;
      });
      return () => subscription.remove();
    }, [onBack]),
  );

  return (
    <SafeAreaView style={onboardingStyles.screen}>
      <OnboardingHeader onBack={onBack} disabled={busy} />

      <KeyboardAvoidingView
        style={styles.form}
        // Android draws edge-to-edge, so adjustResize no longer shrinks the
        // window: without this the phone field and Continue sit under the
        // keyboard with nothing to scroll (2.0.0 had it). Inert on iOS, whose
        // ScrollView insets already compensate (see the hook); enabled there it
        // would also arm a stray LayoutAnimation on every keyboard show.
        behavior="height"
        enabled={Platform.OS === "android"}
      >
        <ScrollView
          {...scrollProps}
          style={styles.form}
          contentContainerStyle={onboardingStyles.content}
          showsVerticalScrollIndicator={false}
        >
          <OnboardingIntro
            title={t("onboardingProfile.title")}
            description={t("onboardingProfile.subtitle")}
          >
            {signedInEmail ? (
              <Text style={[styles.identityHint, textDir(isRTL)]}>
                {t("onboardingProfile.signedInHint", { email: ltrIsolate(signedInEmail) })}
              </Text>
            ) : null}
          </OnboardingIntro>

          <FormField
            ref={nameRef}
            onFocus={() => focusInput(nameRef.current)}
            onBlur={() => blurInput(nameRef.current)}
            label={t("onboarding.name.label")}
            required
            value={name}
            editable={!busy}
            style={styles.input}
            onChangeText={(s) => {
              if (savingRef.current) return;
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
            onFocus={() => focusInput(lastNameRef.current)}
            onBlur={() => blurInput(lastNameRef.current)}
            label={t("onboarding.lastName.label")}
            value={lastName}
            editable={!busy}
            style={styles.input}
            onChangeText={(value) => {
              if (!savingRef.current) setLastName(value);
            }}
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
                onPress={() => {
                  if (savingRef.current) return;
                  Keyboard.dismiss();
                  setPickerVisible(true);
                }}
                style={({ pressed }) => [
                  styles.countryBtn,
                  pressed && { backgroundColor: colors.bgMuted },
                ]}
                accessibilityRole="button"
                accessibilityLabel={t("onboarding.phone.label")}
                disabled={busy}
                accessibilityState={{ disabled: busy }}
              >
                <Text style={styles.countryFlag}>{country.flag}</Text>
                <Text style={styles.countryDial}>{ltrIsolate(country.dialCode)}</Text>
                <Ionicons name="chevron-down" size={icon.trailing} color={colors.textMuted} />
              </Pressable>
              <TextInput
                ref={phoneRef}
                onFocus={() => focusInput(phoneRef.current)}
                onBlur={() => blurInput(phoneRef.current)}
                style={[styles.phoneInput, phoneError ? styles.inputError : null]}
                value={phone}
                editable={!busy}
                onChangeText={(v) => {
                  if (savingRef.current) return;
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
          <OnboardingAction
            label={t("onboardingProfile.continue")}
            onPress={onSubmit}
            loading={busy}
          />
        </ScrollView>
      </KeyboardAvoidingView>

      <CountryPickerSheet
        visible={pickerVisible}
        selectedCode={countryCode}
        onSelect={(c) => {
          if (!savingRef.current) setCountryCode(c);
        }}
        onDismiss={() => setPickerVisible(false)}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  form: { flex: 1 },
  identityHint: {
    fontSize: 13,
    fontFamily: fonts.sansRegular,
    color: colors.textSubtle,
    backgroundColor: colors.bgMuted,
    borderRadius: 10,
    padding: 12,
    marginTop: 16,
    lineHeight: sansLineHeight(13, 19),
  },
  input: { minHeight: 52, borderRadius: 12 },
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
    minHeight: 52,
    paddingHorizontal: 12,
    borderWidth: 1,
    borderColor: colors.borderDefault,
    borderRadius: 12,
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
    minWidth: 0,
    minHeight: 52,
    borderWidth: 1,
    borderColor: colors.borderDefault,
    borderRadius: 12,
    paddingHorizontal: 14,
    fontSize: 15,
    fontFamily: fonts.sansRegular,
    color: colors.textEmphasis,
    backgroundColor: colors.bgDefault,
    writingDirection: "ltr",
    textAlign: "left",
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
