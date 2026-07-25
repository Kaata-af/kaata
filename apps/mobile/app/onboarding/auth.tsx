import { Ionicons } from "@expo/vector-icons";
import Constants from "expo-constants";
import { useRouter } from "expo-router";
import { useState } from "react";
import { ActivityIndicator, Platform, Pressable, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { GoogleGIcon } from "../../components/GoogleGIcon";
import { NinjaIcon } from "../../components/NinjaIcon";
import {
  isCancellation,
  isGoogleSignInAvailable,
  signInWithApple,
  signInWithGoogle,
} from "../../lib/auth";
import { colors } from "../../lib/colors";
import { getAppMeta, setAppMeta } from "../../lib/db";
import { textDir, useIsRTL } from "../../lib/direction";
import { fonts, sansLineHeight } from "../../lib/fonts";
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
  // WHICH provider is mid-handshake (null = idle). Both cards disable while
  // either runs, but only the tapped card shows the spinner — a shared
  // boolean used to put a spinner on BOTH cards at once.
  const [busy, setBusy] = useState<null | "google" | "apple">(null);
  const [error, setError] = useState<string | null>(null);

  // Post-sign-in navigation shared by Google and Apple: stash the returned
  // profile for the "Signed in as X" subtitle, then honor any pending pair /
  // invite deep link, else route to the restore probe.
  async function completeSignIn(
    user: { name?: string; email?: string; phone?: string },
    method: "google" | "apple",
  ) {
    await setAppMeta("onboarding_auth_method", method);
    // Stash the provider-returned display name + email for the profile
    // screen's "Signed in as X" subtitle. The name is NOT prefilled into
    // the actual name input (per UX call: the formal/legal name isn't the
    // shop persona).
    if (user.name) await setAppMeta("onboarding_pending_name", user.name);
    if (user.email) await setAppMeta("onboarding_pending_email", user.email);
    // BUG-1: the account-level phone (saved on a prior device, returned by
    // /v1/auth/google) — stash it so the profile screen can prefill it like
    // the name. Google itself never provides a phone; this is the only source.
    if (user.phone) await setAppMeta("onboarding_pending_phone", user.phone);
    // Phase 5.1: if the user signed in BECAUSE a kaata://pair/<token>
    // deep link triggered the "needs sign-in" gate, hand off back to
    // that deep link rather than the restore probe — the pair flow is
    // the higher-priority intent.
    //
    // Use router.replace, NOT Linking.openURL — the latter can:
    //   1. Spawn a brand-new task instance on Android (singleTask
    //      intent filter), leaving the previous activity orphaned.
    //   2. Race with the JWT-write step: if getSessionJWT() in the
    //      pair screen runs before postSignInHousekeeping has committed
    //      the JWT to SecureStore, the pair screen will re-stash the
    //      pending_pair_deeplink and re-route to /onboarding/auth,
    //      producing an infinite redirect loop.
    // The parsed-route handoff in-process sidesteps both issues.
    const pendingPair = await getAppMeta("pending_pair_deeplink");
    if (pendingPair) {
      await setAppMeta("pending_pair_deeplink", "");
      await setAppMeta("onboarding_step", "profile");
      // Defensive parse: pendingPair is shaped like
      //   kaata://pair/<token>?p=<base64>
      // Map it to /pair/<token>?p=<base64> for expo-router.
      try {
        const url = new URL(pendingPair);
        const token = url.pathname.replace(/^\//, "") || "x";
        const p = url.searchParams.get("p") ?? "";
        router.replace({
          pathname: "/pair/[token]",
          params: { token, p },
        });
      } catch {
        // Malformed stash — clear, fall through to restore probe so the
        // user isn't stranded.
        router.replace("/onboarding/restore");
      }
      return;
    }
    // Vault-invite deep link parity with the pair flow above: the
    // invite screen stashes pending_invite_token before sending the
    // user here to sign in. Without this read, the stash was written
    // and never consumed — the invitee signed in and got dumped into
    // onboarding/restore with their invite lost.
    const pendingInvite = await getAppMeta("pending_invite_token");
    if (pendingInvite) {
      await setAppMeta("pending_invite_token", "");
      await setAppMeta("onboarding_step", "profile");
      router.replace({ pathname: "/invite/[token]", params: { token: pendingInvite } });
      return;
    }
    // Phase 3: route through the restore probe instead of jumping
    // straight to profile. The probe screen checks the backend for
    // an existing snapshot or v0.4 backup; if neither is found it
    // forwards to /onboarding/profile transparently. onboarding_step
    // stays at 'profile' so a force-quit during the probe still
    // resumes the flow correctly.
    await setAppMeta("onboarding_step", "profile");
    router.replace("/onboarding/restore");
  }

  const googleAvailable = isGoogleSignInAvailable();

  async function onSignIn() {
    setError(null);
    setBusy("google");
    try {
      const user = await signInWithGoogle();
      await completeSignIn(user, "google");
    } catch (err) {
      if (isCancellation(err)) return; // user-cancelled → silent
      if (IS_EXPO_GO) {
        setError(t("onboardingMode.expoGoHint"));
      } else {
        setError(t("onboardingMode.signInFailed"));
        console.warn("[onboarding/auth] google sign-in failed", err);
      }
    } finally {
      setBusy(null);
    }
  }

  async function onAppleSignIn() {
    setError(null);
    setBusy("apple");
    try {
      const user = await signInWithApple();
      await completeSignIn(user, "apple");
    } catch (err) {
      if (isCancellation(err)) return; // user-cancelled → silent
      setError(t("onboardingMode.signInFailed"));
      console.warn("[onboarding/auth] apple sign-in failed", err);
    } finally {
      setBusy(null);
    }
  }

  async function onStayOffline() {
    await setAppMeta("onboarding_auth_method", "offline");
    // Clear any pending Google name/email that lingered from a prior
    // sign-in attempt this session — otherwise the profile screen would
    // show "Signed in as X" even though the user is now choosing offline.
    await setAppMeta("onboarding_pending_name", "");
    await setAppMeta("onboarding_pending_email", "");
    await setAppMeta("onboarding_pending_phone", "");
    await setAppMeta("onboarding_step", "profile");
    router.replace("/onboarding/profile");
  }

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.content}>
        <Text style={[styles.title, textDir(isRTL)]}>{t("onboardingMode.title")}</Text>
        <Text style={[styles.subtitle, textDir(isRTL)]}>{t("onboardingMode.subtitle")}</Text>

        <View style={styles.spacer} />

        {/* BOTH providers on BOTH platforms (one account, any device — the
            email-linking backend makes them land on the same kaatas), each
            wearing its OWN brand: Apple = black card + white Apple mark
            (Apple's canonical form), Google = white card + the multicolor G
            (Google's light-surface guidance). The platform's home-team
            provider leads. Google hides on iOS builds without the iOS OAuth
            client baked in (isGoogleSignInAvailable — configure() would
            crash); Apple on Android runs the web OAuth flow inside lib/auth.
            Guideline 4.8 stays satisfied on iOS either way. While EITHER
            handshake runs both cards disable, but only the tapped one shows
            the spinner. */}
        {(Platform.OS === "ios" ? (["apple", "google"] as const) : (["google", "apple"] as const))
          .filter((p) => p !== "google" || googleAvailable)
          .map((provider, idx) => {
            const isGoogle = provider === "google";
            const spinning = busy === provider;
            return (
              <View key={provider}>
                {idx > 0 ? <View style={styles.gap} /> : null}
                <Pressable
                  onPress={isGoogle ? onSignIn : onAppleSignIn}
                  disabled={busy !== null}
                  accessibilityRole="button"
                  accessibilityLabel={t(
                    isGoogle ? "onboardingMode.google.title" : "onboardingMode.apple.title",
                  )}
                  style={({ pressed }) => [
                    styles.card,
                    isGoogle ? styles.cardGoogle : styles.cardPrimary,
                    pressed && { opacity: 0.85 },
                    busy !== null && !spinning && { opacity: 0.5 },
                  ]}
                >
                  <View style={[styles.cardIcon, isRTL && styles.cardIconRTL]}>
                    {spinning ? (
                      <ActivityIndicator
                        color={isGoogle ? colors.textEmphasis : colors.textInverted}
                      />
                    ) : isGoogle ? (
                      <GoogleGIcon size={28} />
                    ) : (
                      <Ionicons name="logo-apple" size={28} color={colors.textInverted} />
                    )}
                  </View>
                  <Text
                    style={[styles.cardTitle, !isGoogle && styles.cardTitlePrimary, textDir(isRTL)]}
                  >
                    {t(isGoogle ? "onboardingMode.google.title" : "onboardingMode.apple.title")}
                  </Text>
                  <Text
                    style={[styles.cardBody, !isGoogle && styles.cardBodyPrimary, textDir(isRTL)]}
                  >
                    {t(isGoogle ? "onboardingMode.google.body" : "onboardingMode.apple.body")}
                  </Text>
                </Pressable>
              </View>
            );
          })}

        {error ? (
          <Text style={[styles.errorText, textDir(isRTL)]} accessibilityLiveRegion="polite">
            {error}
          </Text>
        ) : null}

        <View style={styles.gap} />

        <Pressable
          onPress={onStayOffline}
          disabled={busy !== null}
          style={({ pressed }) => [styles.card, styles.cardGhost, pressed && { opacity: 0.85 }]}
        >
          <View style={[styles.cardIcon, isRTL && styles.cardIconRTL]}>
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
    lineHeight: sansLineHeight(14, 20),
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
  // Google's brand guidance puts the multicolor G on a LIGHT surface — and
  // the white card is also what visually separates it from the black Apple
  // card (two identical dark cards read as one choice). Same elevation as
  // cardPrimary so the pair sits at equal weight.
  cardGoogle: {
    backgroundColor: colors.bgDefault,
    borderColor: colors.borderDefault,
    ...Platform.select({
      ios: {
        shadowColor: "#000",
        shadowOpacity: 0.1,
        shadowRadius: 14,
        shadowOffset: { width: 0, height: 6 },
      },
      android: { elevation: 4 },
    }),
  },
  cardIcon: {
    width: 44,
    height: 44,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 12,
  },
  // In Dari (RTL) the card icon mirrors to the right edge so it lines up with
  // the right-aligned title/body. Without this it stays at the column's
  // cross-start (left) because the app is LTR-locked at the Yoga level, leaving
  // a left icon above right-aligned text — the "not properly RTL" look.
  cardIconRTL: { alignSelf: "flex-end" },
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
    lineHeight: sansLineHeight(13, 19),
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
