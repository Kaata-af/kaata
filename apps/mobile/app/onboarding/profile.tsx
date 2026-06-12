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
  type TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Button } from "../../components/Button";
import { FormField } from "../../components/FormField";
import { colors } from "../../lib/colors";
import { createSelfProfile, getAppMeta, setAppMeta } from "../../lib/db";
import { EventSigningUnavailableError } from "../../lib/event-log";
import { rowDir, textDir, useIsRTL } from "../../lib/direction";
import { fonts } from "../../lib/fonts";
import { t } from "../../lib/i18n";

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
  const [shopName, setShopName] = useState("");
  const [nameError, setNameError] = useState<string | null>(null);
  // v0.5.3: shop (Kaata) name is OPTIONAL. The user can install Kaata
  // just to JOIN someone else's kaata — the "Join an existing kaata"
  // link below skips vault creation entirely. When shop is left empty
  // and the user taps Continue, a placeholder "My kaata" vault is minted
  // so they have somewhere to land; they can rename it from settings.
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [signedInEmail, setSignedInEmail] = useState<string | null>(null);
  const nameRef = useRef<TextInput>(null);
  const phoneRef = useRef<TextInput>(null);
  const shopRef = useRef<TextInput>(null);

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
    const trimmedName = name.trim();
    const trimmedPhone = phone.trim();
    const trimmedShop = shopName.trim();

    if (!trimmedName) {
      setNameError(t("onboardingProfile.nameRequired"));
      nameRef.current?.focus();
      return;
    }
    setNameError(null);

    setSubmitError(null);
    setBusy(true);
    try {
      await createSelfProfile(trimmedName, trimmedShop, trimmedPhone || null);
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
      setBusy(false);
    }
  }

  async function onSubmit() {
    await finalize("/");
  }

  async function onJoinExisting() {
    // v0.5.3 "I'll join an existing kaata" path: create the local-self
    // user (with whatever fields they filled in) and route directly to
    // the QR scanner instead of home. The placeholder vault that
    // createSelfProfile mints stays in the background — if they pair
    // into someone else's kaata it gets switched as the active vault.
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

          <FormField
            ref={phoneRef}
            label={t("onboarding.phone.label")}
            value={phone}
            onChangeText={setPhone}
            placeholder={t("onboarding.phone.placeholder")}
            keyboardType="phone-pad"
            autoCorrect={false}
            returnKeyType="next"
            onSubmitEditing={() => shopRef.current?.focus()}
            submitBehavior="submit"
          />
          <Text style={[styles.fieldHint, textDir(isRTL)]}>{t("onboarding.phone.hint")}</Text>

          <FormField
            ref={shopRef}
            label={t("onboarding.shop.labelOptional")}
            value={shopName}
            onChangeText={setShopName}
            placeholder={t("onboarding.shop.placeholder")}
            returnKeyType="done"
            onSubmitEditing={onSubmit}
          />
          <Text style={[styles.fieldHint, textDir(isRTL)]}>{t("onboarding.shop.hint")}</Text>

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
});
