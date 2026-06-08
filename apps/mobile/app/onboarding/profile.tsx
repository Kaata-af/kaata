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
  const [shopName, setShopName] = useState("");
  const [nameError, setNameError] = useState<string | null>(null);
  // Phase 7 D-VAULT-NAME-REQUIRED: shop (Kaata) name is now REQUIRED.
  // Previously the field was optional and the vault defaulted to "My
  // ledger" — founder rejected that. Every vault must have a
  // user-chosen name.
  const [shopError, setShopError] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [signedInEmail, setSignedInEmail] = useState<string | null>(null);
  const nameRef = useRef<TextInput>(null);
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

  async function onSubmit() {
    const trimmedName = name.trim();
    const trimmedShop = shopName.trim();

    // Validate BOTH fields up front so the user sees every error at once
    // instead of fixing one, tapping submit, and discovering another.
    let hasError = false;
    if (!trimmedName) {
      setNameError(t("onboardingProfile.nameRequired"));
      hasError = true;
    } else {
      setNameError(null);
    }
    if (!trimmedShop) {
      setShopError(t("onboardingProfile.shopRequired"));
      hasError = true;
    } else {
      setShopError(null);
    }
    if (hasError) {
      // Focus the first invalid field so the keyboard puts the user
      // straight back to the action they need to take. Name first
      // because it's above the shop field in tab order.
      if (!trimmedName) nameRef.current?.focus();
      else if (!trimmedShop) shopRef.current?.focus();
      return;
    }

    setSubmitError(null);
    setBusy(true);
    try {
      // Phase 7: createSelfProfile now requires a non-empty trimmed
      // shopName. The function throws on empty as a data-layer contract.
      await createSelfProfile(trimmedName, trimmedShop);
      await setAppMeta("onboarding_step", "done");
      // Clear pending values so a later "reset all data + re-onboard"
      // run doesn't carry stale Google email into the next session.
      await setAppMeta("onboarding_pending_name", "");
      await setAppMeta("onboarding_pending_email", "");
      router.replace("/");
    } catch (err) {
      // createSelfProfile rarely throws — DB constraint violations are
      // the realistic case (e.g. a stale self user row from a partial
      // earlier reset). Surface inline so the user knows their tap
      // landed but something failed; falls back to a generic message.
      console.warn("[onboarding/profile] createSelfProfile failed", err);
      setSubmitError(t("entry.saveFailed"));
    } finally {
      setBusy(false);
    }
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
              // Clear error as soon as the user starts typing so it doesn't
              // sit there nagging while they fix it.
              if (nameError) setNameError(null);
            }}
            placeholder={t("onboarding.name.placeholder")}
            autoCapitalize="words"
            returnKeyType="next"
            onSubmitEditing={() => shopRef.current?.focus()}
            submitBehavior="submit"
            error={nameError}
          />

          <FormField
            ref={shopRef}
            label={t("onboarding.shop.label")}
            required
            value={shopName}
            onChangeText={(s) => {
              setShopName(s);
              if (shopError) setShopError(null);
            }}
            onBlur={() => {
              if (!shopName.trim()) {
                setShopError(t("onboardingProfile.shopRequired"));
              }
            }}
            placeholder={t("onboarding.shop.placeholder")}
            returnKeyType="done"
            onSubmitEditing={onSubmit}
            error={shopError}
          />

          {submitError ? (
            <Text style={[styles.submitError, textDir(isRTL)]} accessibilityLiveRegion="polite">
              {submitError}
            </Text>
          ) : null}

          <View style={{ height: 12 }} />
          <Button label={t("onboardingProfile.continue")} onPress={onSubmit} loading={busy} />
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
  submitError: {
    fontSize: 13,
    fontFamily: fonts.sansMedium,
    color: colors.danger,
    marginBottom: 4,
  },
});
