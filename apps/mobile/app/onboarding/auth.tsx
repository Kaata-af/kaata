import { Ionicons } from "@expo/vector-icons";
import Constants from "expo-constants";
import { useRouter } from "expo-router";
import { useState } from "react";
import { ActivityIndicator, Platform, Pressable, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { NinjaIcon } from "../../components/NinjaIcon";
import { isCancellation, signInWithGoogle } from "../../lib/auth";
import { colors } from "../../lib/colors";
import { setAppMeta } from "../../lib/db";
import { textDir, useIsRTL } from "../../lib/direction";
import { fonts } from "../../lib/fonts";
import { t } from "../../lib/i18n";

// Onboarding step 2 — auth choice. Sits BEFORE the name/shop form so the
// Google handshake (and the email it returns) can inform the next screen's
// header ("Signed in as ahmad@gmail.com"). Both branches end at
// /onboarding/profile.
//
// Error UX:
//   - User-cancelled Google sheet → silent (stay on screen, no error)
//   - Expo Go (no native module) → inline hint under the Google card
//     telling them to continue offline for now
//   - Any other Google error or backend rejection → inline error under
//     the Google card. NEVER a toast — toasts are dismissable and easily
//     missed when the user is figuring out a new screen.

const IS_EXPO_GO = Constants.executionEnvironment === "storeClient";

export default function OnboardingAuthScreen() {
  const router = useRouter();
  const isRTL = useIsRTL();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSignIn() {
    setError(null);
    setBusy(true);
    try {
      const user = await signInWithGoogle();
      await setAppMeta("onboarding_auth_method", "google");
      // Stash the Google-returned display name + email for the profile
      // screen's "Signed in as X" subtitle. The name is NOT prefilled into
      // the actual name input (per UX call: shopkeepers' Google name is
      // their formal/legal name, not their shop persona).
      if (user.name) await setAppMeta("onboarding_pending_name", user.name);
      if (user.email) await setAppMeta("onboarding_pending_email", user.email);
      await setAppMeta("onboarding_step", "profile");
      router.replace("/onboarding/profile");
    } catch (err) {
      if (isCancellation(err)) {
        // user-cancelled → silent, leave them on the screen
        return;
      }
      if (IS_EXPO_GO) {
        setError(t("onboardingMode.expoGoHint"));
      } else {
        setError(t("onboardingMode.signInFailed"));
        console.warn("[onboarding/auth] sign-in failed", err);
      }
    } finally {
      setBusy(false);
    }
  }

  async function onStayOffline() {
    await setAppMeta("onboarding_auth_method", "offline");
    // Clear any pending Google name/email that lingered from a prior
    // sign-in attempt this session — otherwise the profile screen would
    // show "Signed in as X" even though the user is now choosing offline.
    await setAppMeta("onboarding_pending_name", "");
    await setAppMeta("onboarding_pending_email", "");
    await setAppMeta("onboarding_step", "profile");
    router.replace("/onboarding/profile");
  }

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.content}>
        <Text style={[styles.title, textDir(isRTL)]}>{t("onboardingMode.title")}</Text>
        <Text style={[styles.subtitle, textDir(isRTL)]}>{t("onboardingMode.subtitle")}</Text>

        <View style={styles.spacer} />

        <Pressable
          onPress={onSignIn}
          disabled={busy}
          style={({ pressed }) => [
            styles.card,
            styles.cardPrimary,
            pressed && { opacity: 0.85 },
            busy && { opacity: 0.6 },
          ]}
        >
          <View style={styles.cardIcon}>
            {busy ? (
              <ActivityIndicator color={colors.textInverted} />
            ) : (
              <Ionicons name="logo-google" size={28} color={colors.textInverted} />
            )}
          </View>
          <Text style={[styles.cardTitle, styles.cardTitlePrimary, textDir(isRTL)]}>
            {t("onboardingMode.google.title")}
          </Text>
          <Text style={[styles.cardBody, styles.cardBodyPrimary, textDir(isRTL)]}>
            {t("onboardingMode.google.body")}
          </Text>
        </Pressable>

        {error ? (
          <Text style={[styles.errorText, textDir(isRTL)]} accessibilityLiveRegion="polite">
            {error}
          </Text>
        ) : null}

        <View style={styles.gap} />

        <Pressable
          onPress={onStayOffline}
          disabled={busy}
          style={({ pressed }) => [styles.card, styles.cardGhost, pressed && { opacity: 0.85 }]}
        >
          <View style={styles.cardIcon}>
            <NinjaIcon size={36} />
          </View>
          <Text style={[styles.cardTitle, textDir(isRTL)]}>
            {t("onboardingMode.offline.title")}
          </Text>
          <Text style={[styles.cardBody, textDir(isRTL)]}>{t("onboardingMode.offline.body")}</Text>
        </Pressable>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bgDefault },
  content: { flex: 1, padding: 24, justifyContent: "center" },
  title: {
    fontSize: 22,
    fontFamily: fonts.sansBold,
    color: colors.textEmphasis,
    letterSpacing: -0.4,
    textAlign: "center",
  },
  subtitle: {
    fontSize: 14,
    fontFamily: fonts.sansRegular,
    color: colors.textSubtle,
    marginTop: 8,
    lineHeight: 20,
    textAlign: "center",
  },
  spacer: { height: 36 },
  gap: { height: 14 },
  card: {
    borderRadius: 14,
    padding: 20,
    borderWidth: 1,
  },
  cardPrimary: {
    backgroundColor: colors.bgInverted,
    borderColor: colors.bgInverted,
    ...Platform.select({
      ios: {
        shadowColor: "#000",
        shadowOpacity: 0.18,
        shadowRadius: 14,
        shadowOffset: { width: 0, height: 6 },
      },
      android: { elevation: 4 },
    }),
  },
  cardGhost: {
    backgroundColor: colors.bgDefault,
    borderColor: colors.borderDefault,
  },
  cardIcon: {
    width: 44,
    height: 44,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 12,
  },
  cardTitle: {
    fontSize: 16,
    fontFamily: fonts.sansSemi,
    color: colors.textEmphasis,
    marginBottom: 6,
  },
  cardTitlePrimary: { color: colors.textInverted },
  cardBody: {
    fontSize: 13,
    fontFamily: fonts.sansRegular,
    color: colors.textSubtle,
    lineHeight: 19,
  },
  cardBodyPrimary: { color: colors.textInverted, opacity: 0.85 },
  errorText: {
    fontSize: 12,
    fontFamily: fonts.sansMedium,
    color: colors.danger,
    marginTop: 8,
    textAlign: "center",
  },
});
