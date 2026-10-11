import { Ionicons } from "@expo/vector-icons";
import Constants from "expo-constants";
import { type Href, Stack, useFocusEffect, useIsFocused, useRouter } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  BackHandler,
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { GoogleGIcon } from "../../components/GoogleGIcon";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { EmailAuthFlow } from "../../components/EmailAuthFlow";
import { recoverAllVaults } from "../../lib/recovery";
import { reconcileVaultRegistrations } from "../../lib/sync/reconcile";
import { NinjaIcon } from "../../components/NinjaIcon";
import {
  type DifferentAccountChoice,
  type DifferentAccountPromptArgs,
  type EmailFlowPending,
  InstallRetiredError,
  isCancellation,
  isGoogleSignInAvailable,
  readEmailFlowPending,
  resetRetiredInstall,
  type SessionUser,
  signInWithApple,
  signInWithGoogle,
  SignInFailedError,
} from "../../lib/auth";
import { queueCrashReport } from "../../lib/crash-report";
import { colors } from "../../lib/colors";
import { getAppMeta, getLocalSelf, setAppMeta } from "../../lib/db";
import { getActiveVaultIdSyncMaybe, setActiveVaultId } from "../../lib/db-tx";
import { applyVaultCurrency } from "../../lib/currency";
import { ltrIsolate, rowDir, textDir, trackingSafe, useIsRTL } from "../../lib/direction";
import { fonts, sansLineHeight } from "../../lib/fonts";
import { t } from "../../lib/i18n";
import { icon, radius, TOUCH_MIN, typography } from "../../lib/tokens";
import { useOnboardingKeyboardScroll } from "../../lib/use-onboarding-keyboard-scroll";

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
//
// Under the two provider cards, on both platforms, a quieter outlined option:
// "Continue with email", Kaata's own accounts (docs/kaata-accounts.md). It
// pushes a separate native email screen over the choices. Its first-step iOS
// swipe returns to these cards instead of popping sign-in all the way home.
// components/EmailAuthFlow stays inside the KeyboardAvoidingView + ScrollView;
// hardware/on-screen Back retraces its steps before leaving. /sign-in?mode=email
// retains the choices beneath it, as does a code step the app was killed on.
// The code is in the inbox; Android often kills the app while they read it.
// Play's review instructions name "Continue with email": keep it visible.

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
 *
 * A retired install (InstallRetiredError, HTTP 410) is the exception: it gets
 * its own explanation and no code, because nothing about it is transient and
 * "try again" would be a lie. `retired` tells the screen to offer the reset.
 */
function describeSignInFailure(err: unknown): {
  text: string;
  retired: boolean;
  /** A known state, not a fault: nothing to report. */
  known: boolean;
} {
  if (err instanceof Error && "reason" in err && err.reason === "account_deletion_expired") {
    return { text: t("auth.error.accountDeletionExpired"), retired: false, known: true };
  }
  if (err instanceof SignInFailedError) {
    // InstallRetiredError is a SignInFailedError ("server 410"), so it is told
    // apart inside this branch, before the generic server copy.
    if (err instanceof InstallRetiredError) {
      return { text: t("account.retired.body"), retired: true, known: true };
    }
    // The token or code went stale while the different-account question was
    // up; nothing was changed. Not a fault, and "try again" is the whole fix.
    if (err.stage === "token_expired") {
      return { text: t("auth.error.tokenExpired"), retired: false, known: true };
    }
    const hint =
      err.stage === "play_services"
        ? t("onboardingMode.signInFailed.playServices")
        : err.stage === "timeout" || err.stage === "network"
          ? t("onboardingMode.signInFailed.network")
          : t("onboardingMode.signInFailed");
    return { text: `${hint} (${err.code})`, retired: false, known: false };
  }
  return { text: t("onboardingMode.signInFailed"), retired: false, known: false };
}

/**
 * Send the failure home. The crash-report pipeline already exists (queued
 * locally, flushed opportunistically) but auth never used it, so a sign-in
 * that failed on someone else's phone left ZERO remote evidence — the exact
 * situation that made this bug un-diagnosable. Best-effort and non-blocking.
 */
function reportSignInFailure(provider: "google" | "apple" | "email", err: unknown): void {
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
  return <AuthScreen />;
}

export function AuthScreen({
  redirected = false,
  initialMode = "providers",
  emailRoute = false,
  providerReady = true,
}: {
  redirected?: boolean;
  /** "email": open straight on the email flow (/sign-in?mode=email). */
  initialMode?: "providers" | "email";
  /** A native screen pushed over the provider selector, preserving its context. */
  emailRoute?: boolean;
  /** Direct/cold entry rebuilds the selector beneath the email route first. */
  providerReady?: boolean;
}) {
  const router = useRouter();
  const isFocused = useIsFocused();
  const isRTL = useIsRTL();
  // WHICH sign-in is mid-handshake (null = idle). Every control disables
  // while one runs, but only the tapped one shows the spinner — a shared
  // boolean used to put a spinner on BOTH cards at once. "reset" = the
  // retired-install reset below is erasing; everything disables.
  const [busy, setBusy] = useState<null | "google" | "apple" | "email" | "reset" | "back">(null);
  const [error, setError] = useState<string | null>(null);
  // The last failure was a retired install: offer "Reset this phone".
  const [retired, setRetired] = useState(false);
  const providerRoute = redirected ? "/sign-in" : "/onboarding/auth";
  const inEmailMode = emailRoute;
  // Native swipe is available at the first form. Deeper steps use the flow's
  // Back handler, which also cancels a pending code when leaving its step.
  const [emailCanGoBack, setEmailCanGoBack] = useState(false);
  const [resumeChecked, setResumeChecked] = useState(!emailRoute);
  // A code step to reopen (see the effect below), or null.
  const [resume, setResume] = useState<EmailFlowPending | null>(null);
  // The email flow's own one-step Back; false at its first step.
  const emailBackRef = useRef<(() => boolean) | null>(null);
  const { scrollProps, focusInput, blurInput } = useOnboardingKeyboardScroll();

  const busyRef = useRef(false);
  const emailOpenedRef = useRef(false);
  const focusedRef = useRef(isFocused);
  focusedRef.current = isFocused;
  const decisionRef = useRef<((choice: DifferentAccountChoice) => void) | null>(null);
  const [decision, setDecision] = useState<DifferentAccountPromptArgs | null>(null);
  const [resetConfirm, setResetConfirm] = useState(false);
  useEffect(() => () => decisionRef.current?.("cancel"), []);
  const decide = (choice: DifferentAccountChoice) => {
    decisionRef.current?.(choice);
    decisionRef.current = null;
    setDecision(null);
  };
  const promptDifferentAccount = (args: DifferentAccountPromptArgs) =>
    new Promise<DifferentAccountChoice>((resolve) => {
      decisionRef.current = resolve;
      setDecision(args);
    });

  // An emailed code the user went to fetch: Android often kills the app while
  // they read their mail, so for the code's 15 minutes the email flow reopens
  // on its code step. A setup code (a first password from Account settings)
  // belongs to that screen, not this one.
  useEffect(() => {
    let cancelled = false;
    if (!emailRoute && initialMode === "email") {
      openEmailMode();
      return;
    }
    void readEmailFlowPending()
      .then((pending) => {
        if (cancelled || !focusedRef.current || busyRef.current) return;
        if (pending && pending.purpose !== "setup") {
          if (emailRoute) {
            setEmailCanGoBack(true);
            setResume(pending);
          } else {
            openEmailMode();
          }
        }
        if (emailRoute) setResumeChecked(true);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        console.warn("[auth] could not read the pending email step", err);
        if (emailRoute) setResumeChecked(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  function openEmailMode() {
    if (busyRef.current || emailOpenedRef.current) return;
    emailOpenedRef.current = true;
    setError(null);
    setRetired(false);
    router.push({ pathname: "/auth/email", params: { redirected: redirected ? "1" : "0" } });
  }

  // Back to the provider choices. Only ever from a first step: Back leaves a
  // code step through the flow itself, which forgets it (a cancel), so this
  // never touches a pending code, not even Account settings' own.
  function leaveEmailMode() {
    Keyboard.dismiss();
    router.dismissTo(providerRoute);
  }

  // One step back through the email flow, then out of it.
  function emailBack() {
    if (emailBackRef.current?.()) return;
    leaveEmailMode();
  }

  async function backToCalendar() {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy("back");
    try {
      await setAppMeta("onboarding_step", "calendar");
      if (focusedRef.current) router.replace("/onboarding/calendar");
    } catch {
      if (focusedRef.current) setError(t("entry.saveFailed"));
    } finally {
      busyRef.current = false;
      if (focusedRef.current) setBusy(null);
    }
  }

  // Android's back button walks the email flow instead of leaving the screen.
  useFocusEffect(
    useCallback(() => {
      focusedRef.current = true;
      if (!emailRoute) {
        emailOpenedRef.current = false;
        const sub = !redirected
          ? BackHandler.addEventListener("hardwareBackPress", () => {
              void backToCalendar();
              return true;
            })
          : null;
        return () => {
          focusedRef.current = false;
          sub?.remove();
        };
      }
      const sub = BackHandler.addEventListener("hardwareBackPress", () => {
        if (!busyRef.current && resumeChecked) emailBack();
        return true;
      });
      return () => {
        focusedRef.current = false;
        sub.remove();
      };
      // emailBack reads a ref and the screen's stable context.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [emailRoute, redirected, resumeChecked]),
  );

  function replaceAuthRoute(destination: Href) {
    // Replace the selector too, as the original single auth route did. Leaving
    // it below a successful invite/restore would make Back reopen sign-in.
    if (emailRoute) router.dismissTo(providerRoute);
    router.replace(destination);
  }

  // Post-sign-in navigation shared by every sign-in: stash the returned
  // profile for the "Signed in as X" subtitle, then honor any pending pair /
  // invite deep link, else route to the restore probe.
  async function completeSignIn(user: SessionUser, method: "google" | "apple" | "email") {
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
    const accountId = await getAppMeta("account_id");
    if (accountId && (await getAppMeta("account_deletion_cancelled")) === accountId) {
      replaceAuthRoute("/onboarding/restore");
      return;
    }
    if (redirected) {
      // A redirect is authentication, not onboarding. Recover existing books
      // before deciding this is a new user; a failed lookup is NOT "no books".
      const hadSelf = await getLocalSelf();
      const previousVault = getActiveVaultIdSyncMaybe();
      await reconcileVaultRegistrations().catch(() => undefined);
      const result = await recoverAllVaults();
      if (result.failed.length && !hadSelf && !result.recovered.length) {
        throw new Error("Account recovery unavailable");
      }
      if (hadSelf || result.recovered.length) {
        if (hadSelf && previousVault) {
          await setActiveVaultId(previousVault);
          await applyVaultCurrency(previousVault);
        }
        await setAppMeta("onboarding_step", "done");
        const pendingPerson = await getAppMeta("pending_tab_person");
        const pendingTab = await getAppMeta("pending_tab_token");
        const pendingInvite = await getAppMeta("pending_invite_token");
        if (pendingPerson) {
          await setAppMeta("pending_tab_person", "");
          replaceAuthRoute({ pathname: "/person/[id]", params: { id: pendingPerson } });
        } else if (pendingTab) {
          replaceAuthRoute({ pathname: "/t/[token]", params: { token: pendingTab } });
        } else if (pendingInvite) {
          await setAppMeta("pending_invite_token", "");
          replaceAuthRoute({ pathname: "/invite/[token]", params: { token: pendingInvite } });
        } else {
          // Back DOWN to the home screen this sign-in was opened from (the
          // profile sheet pushes /sign-in over it); replace would stack a
          // second home on top of the first. With no home below, it replaces.
          router.dismissTo("/");
        }
        return;
      }
      // Only a genuinely new account without a local ledger needs setup.
      await setAppMeta("onboarding_step", "profile");
      replaceAuthRoute("/onboarding/profile");
      return;
    }
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
    const pendingPerson = await getAppMeta("pending_tab_person");
    if (pendingPerson && (await getLocalSelf())) {
      await setAppMeta("pending_tab_person", "");
      replaceAuthRoute({ pathname: "/person/[id]", params: { id: pendingPerson } });
      return;
    }
    const pendingTab = await getAppMeta("pending_tab_token");
    if (pendingTab && (await getLocalSelf())) {
      replaceAuthRoute({ pathname: "/t/[token]", params: { token: pendingTab } });
      return;
    }
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
        replaceAuthRoute({
          pathname: "/pair/[token]",
          params: { token, p },
        });
      } catch {
        // Malformed stash — clear, fall through to restore probe so the
        // user isn't stranded.
        replaceAuthRoute("/onboarding/restore");
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
      replaceAuthRoute({ pathname: "/invite/[token]", params: { token: pendingInvite } });
      return;
    }
    // Phase 3: route through the restore probe instead of jumping
    // straight to profile. The probe screen checks the backend for
    // an existing snapshot or v0.4 backup; if neither is found it
    // forwards to /onboarding/profile transparently. onboarding_step
    // stays at 'profile' so a force-quit during the probe still
    // resumes the flow correctly.
    await setAppMeta("onboarding_step", "profile");
    replaceAuthRoute("/onboarding/restore");
  }

  const googleAvailable = isGoogleSignInAvailable();

  function showSignInFailure(provider: "google" | "apple" | "email", err: unknown) {
    const failure = describeSignInFailure(err);
    setError(failure.text);
    setRetired(failure.retired);
    // A retired install is a known state with its own way out, not a failure
    // to diagnose — and the server discards a retired install's reports anyway.
    // A stale token is the user's pause, not a fault either.
    if (!failure.known) reportSignInFailure(provider, err);
  }

  async function onSignIn() {
    if (busyRef.current) return;
    busyRef.current = true;
    setError(null);
    setRetired(false);
    setBusy("google");
    try {
      const user = await signInWithGoogle(promptDifferentAccount);
      await completeSignIn(user, "google");
    } catch (err) {
      if (isCancellation(err)) return; // user-cancelled → silent
      if (IS_EXPO_GO) {
        setError(t("onboardingMode.expoGoHint"));
      } else {
        showSignInFailure("google", err);
      }
    } finally {
      busyRef.current = false;
      setBusy(null);
    }
  }

  async function onAppleSignIn() {
    if (busyRef.current) return;
    busyRef.current = true;
    setError(null);
    setRetired(false);
    setBusy("apple");
    try {
      const user = await signInWithApple(promptDifferentAccount);
      await completeSignIn(user, "apple");
    } catch (err) {
      if (isCancellation(err)) return; // user-cancelled → silent
      showSignInFailure("apple", err);
    } finally {
      busyRef.current = false;
      setBusy(null);
    }
  }

  // The email flow's requests run through the same gate as the two cards, so
  // only one sign-in is ever in flight. The flow handles its own outcome:
  // completeSignIn on success, its own words for the server's refusals, and
  // showSignInFailure("email", …) for everything else.
  async function runEmail(task: () => Promise<void>) {
    if (busyRef.current) return;
    busyRef.current = true;
    setError(null);
    setRetired(false);
    setBusy("email");
    try {
      await task();
    } finally {
      busyRef.current = false;
      setBusy(null);
    }
  }

  // Retired install only: the erase runs from the destructive confirmation,
  // never from the error itself. Then land exactly where a completed account
  // deletion lands (app/account.tsx) — the wipe rebuilt an empty schema under
  // a fresh install id, so this phone is a new install now.
  async function onConfirmReset() {
    if (busyRef.current) return;
    busyRef.current = true;
    setResetConfirm(false);
    setBusy("reset");
    try {
      await resetRetiredInstall();
      replaceAuthRoute("/onboarding");
    } catch (err) {
      console.warn("[onboarding/auth] resetRetiredInstall failed", err);
      setError(t("account.retired.failed"));
    } finally {
      busyRef.current = false;
      setBusy(null);
    }
  }

  async function onStayOffline() {
    if (busyRef.current) return;
    await setAppMeta("onboarding_auth_method", "offline");
    // Clear any pending Google name/email that lingered from a prior
    // sign-in attempt this session — otherwise the profile screen would
    // show "Signed in as X" even though the user is now choosing offline.
    await setAppMeta("onboarding_pending_name", "");
    await setAppMeta("onboarding_pending_email", "");
    await setAppMeta("onboarding_pending_phone", "");
    await setAppMeta("onboarding_step", "profile");
    replaceAuthRoute("/onboarding/profile");
  }

  // The last failure, under whichever sign-in produced it, plus the retired
  // install's way out.
  const failureNotice = (
    <>
      {error ? (
        <Text style={[styles.errorText, textDir(isRTL)]} accessibilityLiveRegion="polite">
          {error}
        </Text>
      ) : null}
      {retired ? (
        <Pressable
          onPress={() => setResetConfirm(true)}
          disabled={busy !== null}
          accessibilityRole="button"
          accessibilityLabel={t("account.retired.reset")}
          style={({ pressed }) => [
            styles.resetButton,
            pressed && { backgroundColor: colors.bgMuted },
            busy !== null && busy !== "reset" && { opacity: 0.5 },
          ]}
        >
          {busy === "reset" ? (
            <ActivityIndicator color={colors.danger} />
          ) : (
            <Text style={styles.resetButtonText}>{t("account.retired.reset")}</Text>
          )}
        </Pressable>
      ) : null}
    </>
  );

  const providerChoices = (
    <>
      <Text style={[styles.title, textDir(isRTL), trackingSafe(isRTL)]}>
        {t(redirected ? "auth.redirect.title" : "onboardingMode.title")}
      </Text>
      <Text style={[styles.subtitle, textDir(isRTL)]}>
        {t(redirected ? "auth.redirect.subtitle" : "onboardingMode.subtitle")}
      </Text>

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
                    <GoogleGIcon size={icon.card} />
                  ) : (
                    <Ionicons name="logo-apple" size={icon.card} color={colors.textInverted} />
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

      {/* Kaata's own accounts, on both platforms: outlined and flat, so it
          reads as the quieter third way in under the two provider cards. */}
      <View style={styles.gap} />
      <Pressable
        onPress={openEmailMode}
        disabled={busy !== null}
        accessibilityRole="button"
        accessibilityLabel={t("onboardingMode.email.title")}
        style={({ pressed }) => [
          styles.card,
          rowDir(isRTL),
          styles.cardOutlined,
          pressed && { opacity: 0.85 },
          busy !== null && { opacity: 0.5 },
        ]}
      >
        <View style={[styles.cardIcon, isRTL ? { marginLeft: 14 } : { marginRight: 14 }]}>
          <Ionicons name="mail-outline" size={24} color={colors.actionPrimary} />
        </View>
        <Text style={[styles.cardTitle, styles.cardTitleKaata, textDir(isRTL)]}>
          {t("onboardingMode.email.title")}
        </Text>
      </Pressable>

      {failureNotice}

      {/* Hard break between the two offers — the offline choice is not a
          third sign-in provider, and stacking it flush under the provider
          cards made it read like one. */}
      {!redirected ? (
        <>
          <View style={styles.divider} />

          <Text style={[styles.groupLabel, textDir(isRTL)]}>
            {t("onboardingMode.offline.label")}
          </Text>
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
              {/* NOT icon.card (28) like the G / Apple marks above: NinjaIcon's
                  viewBox is "0 -64 640 640" and the head circle fills only ~77%
                  of it (the rest is katana headroom), so at 28 the ninja reads
                  visibly smaller than its two siblings in the shared 32px well.
                  30 is the optical-size compensation — a composed graphic. */}
              <NinjaIcon size={30} />
            </View>
            <Text style={[styles.cardTitle, textDir(isRTL)]}>
              {t("onboardingMode.offline.title")}
            </Text>
          </Pressable>
        </>
      ) : null}
    </>
  );

  return (
    <SafeAreaView style={styles.container}>
      {emailRoute ? (
        <Stack.Screen
          options={{
            gestureEnabled: providerReady && resumeChecked && busy === null && !emailCanGoBack,
          }}
        />
      ) : null}
      {redirected || inEmailMode || !emailRoute ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("common.back")}
          disabled={busy !== null || !resumeChecked}
          onPress={() =>
            inEmailMode
              ? emailBack()
              : !redirected
                ? void backToCalendar()
                : router.canGoBack()
                  ? router.back()
                  : router.replace("/")
          }
          style={{
            minHeight: 44,
            minWidth: 44,
            alignSelf: isRTL ? "flex-end" : "flex-start",
            padding: 12,
          }}
        >
          <Ionicons
            name={isRTL ? "chevron-forward" : "chevron-back"}
            size={26}
            color={colors.textEmphasis}
          />
        </Pressable>
      ) : null}
      <KeyboardAvoidingView
        style={styles.flex}
        // Android draws edge-to-edge, so the window never shrinks for the
        // keyboard: without this the email flow's fields and button sit under
        // it. Inert on iOS, whose ScrollView insets compensate (see the hook);
        // enabled there it would compensate twice.
        behavior="height"
        enabled={Platform.OS === "android"}
      >
        <ScrollView
          {...scrollProps}
          style={styles.flex}
          contentContainerStyle={styles.content}
          showsVerticalScrollIndicator={false}
        >
          {inEmailMode ? (
            resumeChecked ? (
              <EmailAuthFlow
                key={resume ? `resume-${resume.sentAt}` : "fresh"}
                entry={redirected ? "signin" : "signup"}
                resume={resume}
                isRTL={isRTL}
                busy={busy !== null}
                googleAvailable={googleAvailable && !IS_EXPO_GO}
                focusInput={focusInput}
                blurInput={blurInput}
                run={runEmail}
                onSignedIn={(user) => completeSignIn(user, "email")}
                onFailure={(err) => showSignInFailure("email", err)}
                onGoogle={onSignIn}
                onExit={leaveEmailMode}
                promptDifferentAccount={promptDifferentAccount}
                notice={failureNotice}
                backRef={emailBackRef}
                onCanStepBackChange={setEmailCanGoBack}
              />
            ) : (
              <ActivityIndicator color={colors.actionPrimary} />
            )
          ) : (
            providerChoices
          )}
        </ScrollView>
      </KeyboardAvoidingView>
      <ConfirmDialog
        visible={decision !== null}
        title={t("account.differentAccount.title")}
        description={
          decision
            ? t("account.differentAccount.body", {
                // Addresses are Latin: isolated, so a Dari sentence cannot
                // reorder them.
                oldEmail: decision.cachedEmail ? ltrIsolate(decision.cachedEmail) : "—",
                newEmail: decision.newEmail ? ltrIsolate(decision.newEmail) : "—",
              })
            : ""
        }
        confirmLabel={t("account.differentAccount.keep")}
        tertiaryLabel={t("account.differentAccount.wipe")}
        tertiaryDestructive
        cancelLabel={t("account.differentAccount.cancel")}
        onConfirm={() => decide("keep")}
        onTertiary={() => decide("wipe")}
        onCancel={() => decide("cancel")}
      />
      <ConfirmDialog
        visible={resetConfirm}
        title={t("account.retired.confirm.title")}
        description={t("account.retired.confirm.body")}
        confirmLabel={t("account.retired.confirm.cta")}
        cancelLabel={t("common.cancel")}
        destructive
        onConfirm={onConfirmReset}
        onCancel={() => setResetConfirm(false)}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bgWarm },
  flex: { flex: 1 },
  // A scroll container (the email flow needs the keyboard room), so flexGrow,
  // not flex: the column still centres when it fits.
  content: { flexGrow: 1, padding: 24, justifyContent: "center" },
  title: {
    // typography.heading (20) — was a one-off 22. sansBold is kept OVER the
    // token's sansSemi: what made this headline the loudest thing on the screen
    // was the weight, not the two points of size. Spreading the token is also
    // what gives it a lineHeight at all (it had none), routed through
    // sansLineHeight so iOS can't clip the glyph tops.
    ...typography.heading,
    fontFamily: fonts.sansBold,
    color: colors.brandPrimary,
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
    // radius.lg — these are floating inset surfaces (cardPrimary/cardGoogle
    // both carry a shadow + elevation 4). Was a bare 14.
    borderRadius: radius.lg,
    paddingVertical: 14,
    paddingHorizontal: 16,
    minHeight: 60,
    borderWidth: 1,
  },
  cardPrimary: {
    backgroundColor: colors.providerApple,
    borderColor: colors.providerApple,
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
  // "Continue with email": the provider cards' geometry, outlined and flat (no
  // shadow), a step quieter than the two branded cards above it.
  cardOutlined: {
    backgroundColor: colors.bgDefault,
    borderColor: colors.actionPrimary,
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
  cardTitleKaata: { color: colors.actionPrimary },
  errorText: {
    fontSize: 12,
    fontFamily: fonts.sansMedium,
    color: colors.danger,
    marginTop: 8,
    textAlign: "center",
  },
  // Retired-install way out under the explanation. Red label like Account's
  // "Delete account" row; it only opens the destructive confirmation.
  resetButton: {
    alignSelf: "center",
    alignItems: "center",
    justifyContent: "center",
    minHeight: TOUCH_MIN,
    marginTop: 12,
    paddingHorizontal: 18,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.borderDefault,
  },
  resetButtonText: {
    fontSize: 14,
    fontFamily: fonts.sansSemi,
    color: colors.danger,
    lineHeight: sansLineHeight(14, 20),
  },
});
