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
  SignInFailedError,
} from "../../lib/auth";
import { queueCrashReport } from "../../lib/crash-report";
import { colors } from "../../lib/colors";
import { getAppMeta, setAppMeta } from "../../lib/db";
import { rowDir, textDir, useIsRTL } from "../../lib/direction";
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

/**
 * Turn a sign-in failure into something the shopkeeper — and the person
 * standing next to them trying to help — can actually act on.
 *
 * Every failure used to render "Sign-in didn't work. Try again." with the
 * cause going only to a console.warn. A phone that failed in the field gave
 * the operator nothing: no stage, no status, nothing to read out. Now the
 * message names the leg that broke, and carries a short code in parentheses
 * (e.g. "server 503", "timeout") that can be relayed verbatim.
 */
function describeSignInFailure(err: unknown): string {
  if (err instanceof SignInFailedError) {
    const hint =
      err.stage === "play_services"
        ? t("onboardingMode.signInFailed.playServices")
        : err.stage === "timeout" || err.stage === "network"
          ? t("onboardingMode.signInFailed.network")
          : t("onboardingMode.signInFailed");
    return `${hint} (${err.code})`;
  }
  return t("onboardingMode.signInFailed");
}

/**
 * Send the failure home. The crash-report pipeline already exists (queued
 * locally, flushed opportunistically) but auth never used it, so a sign-in
 * that failed on someone else's phone left ZERO remote evidence — the exact
 * situation that made this bug un-diagnosable. Best-effort and non-blocking.
 */
function reportSignInFailure(provider: "google" | "apple", err: unknown): void {
  const code = err instanceof SignInFailedError ? err.code : "unknown";
  const message = err instanceof Error ? err.message : String(err);
  console.warn(`[onboarding/auth] ${provider} sign-in failed [${code}]`, err);
  void queueCrashReport({
    kind: "js",
    stage: "signin",
    name: `${provider}:${code}`,
    message: message.slice(0, 500),
  }).catch(() => {});
}

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
        setError(describeSignInFailure(err));
        reportSignInFailure("google", err);
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
      setError(describeSignInFailure(err));
      reportSignInFailure("apple", err);
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

        {/* Two clearly separate offers, each explained ONCE. The backup
            sentence used to be repeated verbatim on the Google and Apple
            cards, which read as two different deals and buried the actual
            choice (account vs no account) under three look-alike blocks. */}
        <Text style={[styles.groupLabel, textDir(isRTL)]}>{t("onboardingMode.account.label")}</Text>
        <Text style={[styles.groupBody, textDir(isRTL)]}>{t("onboardingMode.account.body")}</Text>

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
                    rowDir(isRTL),
                    isGoogle ? styles.cardGoogle : styles.cardPrimary,
                    pressed && { opacity: 0.85 },
                    busy !== null && !spinning && { opacity: 0.5 },
                  ]}
                >
                  <View style={[styles.cardIcon, isRTL ? { marginLeft: 14 } : { marginRight: 14 }]}>
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
                </Pressable>
              </View>
            );
          })}

        {error ? (
          <Text style={[styles.errorText, textDir(isRTL)]} accessibilityLiveRegion="polite">
            {error}
          </Text>
        ) : null}

        {/* Hard break between the two offers — the offline choice is not a
            third sign-in provider, and stacking it flush under the provider
            cards made it read like one. */}
        <View style={styles.divider} />

        <Text style={[styles.groupLabel, textDir(isRTL)]}>{t("onboardingMode.offline.label")}</Text>
        <Text style={[styles.groupBody, textDir(isRTL)]}>{t("onboardingMode.offline.body")}</Text>

        <Pressable
          onPress={onStayOffline}
          disabled={busy !== null}
          accessibilityRole="button"
          accessibilityLabel={t("onboardingMode.offline.title")}
          style={({ pressed }) => [
            styles.card,
            rowDir(isRTL),
            styles.cardGhost,
            pressed && { opacity: 0.85 },
            busy !== null && { opacity: 0.5 },
          ]}
        >
          <View style={[styles.cardIcon, isRTL ? { marginLeft: 14 } : { marginRight: 14 }]}>
            <NinjaIcon size={30} />
          </View>
          <Text style={[styles.cardTitle, textDir(isRTL)]}>
            {t("onboardingMode.offline.title")}
          </Text>
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
  spacer: { height: 28 },
  gap: { height: 12 },
  // Group heading + its one-time explanation. No uppercase/tracking: letter-
  // spacing severs Arabic-script joining in the Dari labels.
  groupLabel: {
    fontSize: 13,
    fontFamily: fonts.sansSemi,
    color: colors.textEmphasis,
  },
  groupBody: {
    fontSize: 13,
    fontFamily: fonts.sansRegular,
    color: colors.textSubtle,
    lineHeight: sansLineHeight(13, 19),
    marginTop: 4,
    marginBottom: 14,
  },
  divider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.borderDefault,
    marginVertical: 24,
  },
  // Compact action row (icon + label). The cards used to be icon-over-title-
  // over-paragraph blocks; the paragraph moved up into the group explanation,
  // so the choice itself is now one tappable line.
  card: {
    flexDirection: "row",
    alignItems: "center",
    borderRadius: 14,
    paddingVertical: 14,
    paddingHorizontal: 16,
    minHeight: 60,
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
  // Fixed box so the three logos (G / Apple / ninja) sit on one vertical
  // axis despite different glyph widths. rowDir() flips the row in Dari, and
  // the margin side is set inline to follow it.
  cardIcon: {
    width: 32,
    height: 32,
    alignItems: "center",
    justifyContent: "center",
  },
  cardTitle: {
    flex: 1,
    fontSize: 16,
    fontFamily: fonts.sansSemi,
    color: colors.textEmphasis,
  },
  cardTitlePrimary: { color: colors.textInverted },
  errorText: {
    fontSize: 12,
    fontFamily: fonts.sansMedium,
    color: colors.danger,
    marginTop: 8,
    textAlign: "center",
  },
});
