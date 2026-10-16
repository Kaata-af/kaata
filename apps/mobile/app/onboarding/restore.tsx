// Onboarding step inserted between auth and profile when the backend has
// existing ledger state for the freshly-signed-in account.
//
// M5 multi-vault recovery (docs/m5-recovery.md §3.2). The freshly-signed-in
// account may belong to MANY vaults (its own + ones it was invited to). We
// probe GET /v1/vaults (listVaults) and, if there are any non-archived
// vaults, show "We found your kaata — restore N vaults?" + the two action
// cards. Restore = recoverAllVaults() (restores+witness-binds EVERY vault,
// picks one active/default). Start fresh = skip to onboarding/profile with
// the local vault intact.
//
// If the account belongs to no vaults (or there's no account_id yet —
// mid-onboarding with no server vault), _layout.tsx / this screen routes
// the user past straight to profile: they're a fresh install with no
// recoverable data.
//
// State machine on this screen:
//
//   loading     → spinner while we list the account's vaults
//   ready       → show "restore N vaults" UI (N = non-archived vault count)
//   ready_none  → router.replace('/onboarding/profile') (auto-skip)
//   restoring   → spinner while recoverAllVaults runs
//   error       → inline error + "Try again" / "Start fresh"
//
// Restore success → router.replace('/'). The home screen will read the
// just-restored projection rows. Start fresh keeps onboarding flowing
// normally to /onboarding/profile (the user explicitly chose to discard
// the cloud copy in favor of a clean slate).

import { Ionicons } from "@expo/vector-icons";
import { useIsFocused, useRouter } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { BackHandler, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import {
  OnboardingAction,
  OnboardingHeader,
  OnboardingIntro,
  onboardingStyles,
} from "../../components/Onboarding";
import { RestoreProgress, restoreProgressLabel } from "../../components/RestoreProgress";
import { requestImmediateCheckIn } from "../../lib/checkin-trigger";
import { colors } from "../../lib/colors";
import { getAppMeta, setAppMeta } from "../../lib/db";
import { rowDir, textDir, useIsRTL } from "../../lib/direction";
import { t } from "../../lib/i18n";
import {
  adoptAccountPhoneToSelf,
  applyForCurrentSession,
  applyForUnchangedLocalSession,
  captureCurrentSession,
  SessionChangedError,
  type SessionSnapshot,
} from "../../lib/auth";
import { recoverAllVaults, type RecoveryProgress } from "../../lib/recovery";
import { RestoreSessionExpiredError, RestoreTimeoutError } from "../../lib/restore";
import { icon, typography } from "../../lib/tokens";
import { listVaults } from "../../lib/vault-api";

type Phase =
  | { kind: "loading" }
  | { kind: "ready"; vaultCount: number }
  | { kind: "ready_none" }
  | { kind: "restoring" }
  | { kind: "error"; message: string; retryable: boolean; expired?: boolean };

export default function OnboardingRestoreScreen() {
  const router = useRouter();
  const isFocused = useIsFocused();
  const focused = useRef(isFocused);
  focused.current = isFocused;
  const mounted = useRef(true);
  const probedSession = useRef<SessionSnapshot | null>(null);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const isRTL = useIsRTL();
  const [phase, updatePhase] = useState<Phase>({ kind: "loading" });
  const phaseRef = useRef(phase);
  phaseRef.current = phase;
  const setPhase = useCallback((next: Phase) => {
    phaseRef.current = next;
    updatePhase(next);
  }, []);
  // Bumped by the error screen's "Try again" — the probe effect keys on it.
  // Previously Try-again only set phase back to "loading" and NOTHING
  // re-ran the mount-only probe: an infinite spinner with force-quit as
  // the only way out.
  const [retryNonce, setRetryNonce] = useState(0);
  // Synchronous re-entry guard for the restore action — see entry/new.tsx.
  const restoringRef = useRef(false);
  // Route changes and recovery must not start together on a same-frame tap.
  const navigatingRef = useRef(false);
  const [navigating, setNavigating] = useState(false);
  // Live recovery progress for the determinate bar in the "restoring" phase.
  const [progress, setProgress] = useState<RecoveryProgress | null>(null);
  // Confirmation gate for "Start fresh" on the data-found screen — discarding
  // a found backup from this device shouldn't be a one-tap mistake.
  const [confirmFresh, setConfirmFresh] = useState(false);
  const [cancelledDeletion, setCancelledDeletion] = useState(false);
  const autoRestoreStarted = useRef(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // Without an account_id the user is mid-onboarding with no server
        // vault yet — skip straight to profile so they can create one.
        const session = await captureCurrentSession();
        const accountId = session.accountId;
        probedSession.current = session;
        if (!accountId) {
          if (!cancelled) setPhase({ kind: "ready_none" });
          return;
        }
        const recoveringDeletion = (await getAppMeta("account_deletion_cancelled")) === accountId;

        // M5: list every vault this account is a member of. Any non-archived
        // vault → offer recovery; none → fresh install, skip to profile.
        const vaults = await listVaults();
        if (cancelled) return;
        await applyForCurrentSession(session, async () => {
          if (cancelled || !mounted.current || !focused.current) return;
          setCancelledDeletion(recoveringDeletion);
          const live = recoveringDeletion ? vaults : vaults.filter((v) => v.archived_at_ms == null);
          setPhase(
            live.length === 0 ? { kind: "ready_none" } : { kind: "ready", vaultCount: live.length },
          );
        });
      } catch (err) {
        if (cancelled || !focused.current || err instanceof SessionChangedError) return;
        setPhase({
          kind: "error",
          message: classifyError(err),
          retryable: !(err instanceof RestoreSessionExpiredError),
          expired: err instanceof RestoreSessionExpiredError,
        });
      }
    })();
    return () => {
      cancelled = true;
    };
    // The probe deliberately re-runs when "Try again" bumps retryNonce.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [retryNonce]);

  // Auto-redirect when there's nothing to restore. Done in an effect so
  // the spinner gets at least one render frame and the user perceives
  // forward motion rather than a confusing flash.
  useEffect(() => {
    if (phase.kind !== "ready_none") return;
    const id = setTimeout(() => {
      const session = probedSession.current;
      if (!session?.accountId) {
        if (mounted.current && focused.current) router.replace("/onboarding/profile");
        return;
      }
      void applyForCurrentSession(session, async () => {
        if (mounted.current && focused.current) router.replace("/onboarding/profile");
      }).catch(() => {});
    }, 50);
    return () => clearTimeout(id);
  }, [phase.kind, router]);

  // A proved return within the grace window already cancelled deletion. Restore
  // the kept cloud data automatically, with the normal progress/error UI.
  useEffect(() => {
    if (cancelledDeletion && phase.kind === "ready" && !autoRestoreStarted.current) {
      autoRestoreStarted.current = true;
      void onRestore();
    }
  }, [cancelledDeletion, phase.kind]);

  async function onRestore() {
    if (restoringRef.current || navigatingRef.current || phaseRef.current.kind !== "ready") return;
    const session = probedSession.current;
    if (!session?.accountId || !mounted.current || !focused.current) return;
    restoringRef.current = true;
    setProgress(null);
    setPhase({ kind: "restoring" });
    try {
      await applyForCurrentSession(session, async () => {});
      const result = await recoverAllVaults({
        requireComplete: cancelledDeletion,
        includeArchived: cancelledDeletion,
        onProgress: (next) => {
          if (mounted.current && focused.current) setProgress(next);
        },
      });
      await applyForCurrentSession(session, async () => {});
      if (!mounted.current || !focused.current) return;
      if (result.recovered.length > 0 && (!cancelledDeletion || result.failed.length === 0)) {
        // At least one vault came back. Mark onboarding done — recovery rebuilt
        // the ledger AND minted the local-self identity (the snapshot can't carry
        // it), so getLocalSelf() is non-null and home won't bounce back here; the
        // profile screen is unnecessary. Going straight to home matches the user's
        // mental model: "my data is back, take me to it."
        await applyForCurrentSession(session, async () => {
          if (!mounted.current || !focused.current) return;
          await setAppMeta("onboarding_step", "done");
          await setAppMeta("onboarding_pending_name", "");
          await setAppMeta("onboarding_pending_email", "");
          if ((await getAppMeta("account_deletion_cancelled")) === session.accountId) {
            await setAppMeta("account_deletion_cancelled", "");
          }
          // BUG-1: the restored self user comes back WITHOUT a phone (the self
          // phone is device-local + never event-sourced) AND this screen skips the
          // profile form that would prefill it. Adopt the account-level phone
          // (stashed at sign-in from /v1/auth/google) onto the restored self row so
          // it survives the reinstall. Best-effort; runs after recovery created the
          // self row (the sign-in-time reconcile ran before that row existed).
          const pendingPhone = (await getAppMeta("onboarding_pending_phone"))?.trim() || null;
          if (pendingPhone) await adoptAccountPhoneToSelf(pendingPhone);
          await setAppMeta("onboarding_pending_phone", "");
          // Push the restored identity + onboarded state to the backend now, so
          // this signed-in user doesn't read as "not onboarded" on the admin
          // dashboard until their next launch. (recovery only fired a minimal
          // witness-pin check-in with no identity fields.) Best-effort; offline
          // no-ops and self-heals on the next online check-in.
          requestImmediateCheckIn();
          if (mounted.current && focused.current) router.replace("/");
        });
        return;
      }
      // Nothing recovered but at least one vault errored → retryable error.
      // (recoverAllVaults itself only throws on a total inability to list,
      // which is caught below; per-vault failures land here.)
      restoringRef.current = false;
      setPhase({
        kind: "error",
        message: t("onboardingRestore.errorGeneric"),
        retryable: true,
      });
    } catch (err) {
      restoringRef.current = false;
      if (!mounted.current || !focused.current || err instanceof SessionChangedError) return;
      setPhase({
        kind: "error",
        message: classifyError(err),
        retryable: !(err instanceof RestoreSessionExpiredError),
        expired: err instanceof RestoreSessionExpiredError,
      });
    }
  }

  // Start fresh is local work (a flag and a route), so it uses the local guard:
  // the account guard demands a session token, and an expired or missing one
  // made this button a silent no-op on the very screen that offered it.
  async function onStartFresh(opts: { persistSkip: boolean }) {
    if (
      restoringRef.current ||
      navigatingRef.current ||
      (phaseRef.current.kind !== "ready" && phaseRef.current.kind !== "error")
    ) {
      return;
    }
    const session = probedSession.current;
    if (!session?.accountId || !mounted.current || !focused.current) return;
    navigatingRef.current = true;
    setNavigating(true);
    await applyForUnchangedLocalSession(session, async () => {
      if (!mounted.current || !focused.current) return;
      // Only persist the per-account skip flag for a DELIBERATE choice on the
      // "we found your data" screen. From the ERROR screen we must NOT persist
      // it: the restore failed (often transiently), and a permanent skip would
      // strand the account's server data — the next launch should re-probe and
      // offer restore again. (The cloud copy is never deleted here either way;
      // this flag only controls whether we re-prompt.) The flag is per-account
      // so signing into a different account still triggers the restore prompt.
      if (opts.persistSkip) {
        const accountId = await getAppMeta("account_id");
        if (accountId) {
          await setAppMeta(`restore_skipped_for_account_${accountId}`, "1");
        }
      }
      await setAppMeta("onboarding_step", "profile");
      router.replace("/onboarding/profile");
    }).catch((err) => {
      navigatingRef.current = false;
      if (!mounted.current || !focused.current) return;
      setNavigating(false);
      if (err instanceof SessionChangedError) return;
      setPhase({ kind: "error", message: classifyError(err), retryable: true });
    });
  }

  // The expired-session error says "Sign in again"; this is that way out.
  const onSignInAgain = useCallback(async () => {
    if (
      restoringRef.current ||
      navigatingRef.current ||
      phaseRef.current.kind === "loading" ||
      phaseRef.current.kind === "ready_none"
    ) {
      return;
    }
    const session = probedSession.current;
    if (!session || !mounted.current || !focused.current) return;
    navigatingRef.current = true;
    setNavigating(true);
    await applyForUnchangedLocalSession(session, async () => {
      if (!mounted.current || !focused.current) return;
      await setAppMeta("onboarding_step", "auth");
      router.replace("/onboarding/auth");
    }).catch((err) => {
      navigatingRef.current = false;
      if (!mounted.current || !focused.current) return;
      setNavigating(false);
      if (err instanceof SessionChangedError) return;
      setPhase({ kind: "error", message: classifyError(err), retryable: true });
    });
  }, [router, setPhase]);

  // Android Back follows the same explicit step as the visible return button.
  // During a restore, keep the screen mounted until recovery has finished.
  useEffect(() => {
    if (!isFocused) return;
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
      void onSignInAgain();
      return true;
    });
    return () => subscription.remove();
  }, [isFocused, onSignInAgain]);

  // ---------- render ----------

  if (phase.kind === "loading" || phase.kind === "ready_none") {
    return (
      <SafeAreaView style={onboardingStyles.screen}>
        <OnboardingHeader onBack={onSignInAgain} disabled />
        <ScrollView contentContainerStyle={onboardingStyles.content}>
          <OnboardingIntro title={t("onboardingRestore.checking")} />
          <View style={styles.progressPanel}>
            <RestoreProgress
              label={t("onboardingRestore.checkingHint")}
              tone="dark"
              isRTL={isRTL}
            />
          </View>
        </ScrollView>
      </SafeAreaView>
    );
  }

  if (phase.kind === "restoring") {
    return (
      <SafeAreaView style={onboardingStyles.screen}>
        <OnboardingHeader onBack={onSignInAgain} disabled />
        <ScrollView contentContainerStyle={onboardingStyles.content}>
          <OnboardingIntro
            title={
              cancelledDeletion
                ? t("account.deleteAccount.restoring")
                : t("onboardingRestore.restoring")
            }
          />
          <View style={styles.progressPanel}>
            <RestoreProgress
              fraction={progress?.fraction ?? 0}
              label={progress ? restoreProgressLabel(progress) : t("restoreProgress.preparing")}
              tone="dark"
              isRTL={isRTL}
            />
          </View>
        </ScrollView>
      </SafeAreaView>
    );
  }

  if (phase.kind === "error") {
    return (
      <SafeAreaView style={onboardingStyles.screen}>
        <OnboardingHeader onBack={onSignInAgain} disabled={navigating} />
        <ScrollView contentContainerStyle={onboardingStyles.content}>
          <OnboardingIntro title={t("onboardingRestore.errorTitle")} description={phase.message} />
          <View style={styles.actions}>
            {phase.expired ? (
              <OnboardingAction
                label={t("onboardingRestore.signInAgain")}
                onPress={onSignInAgain}
                disabled={navigating}
              />
            ) : null}
            {phase.retryable ? (
              <OnboardingAction
                label={t("onboardingRestore.tryAgain")}
                disabled={navigating}
                onPress={() => {
                  if (navigatingRef.current || restoringRef.current) return;
                  autoRestoreStarted.current = false;
                  setPhase({ kind: "loading" });
                  // Re-run the probe; changing the phase alone cannot retry it.
                  setRetryNonce((n) => n + 1);
                }}
              />
            ) : null}
            <OnboardingAction
              variant="outline"
              label={t("onboardingRestore.startFresh")}
              disabled={navigating}
              // A failed restore must be offered again on the next launch.
              onPress={() => void onStartFresh({ persistSkip: false })}
            />
          </View>
        </ScrollView>
      </SafeAreaView>
    );
  }

  // phase.kind === "ready"
  return (
    <SafeAreaView style={onboardingStyles.screen}>
      <OnboardingHeader onBack={onSignInAgain} disabled={navigating} />
      <ScrollView contentContainerStyle={onboardingStyles.content}>
        <OnboardingIntro
          title={t("onboardingRestore.title")}
          description={t("onboardingRestore.subtitleVaults", { count: String(phase.vaultCount) })}
        />
        <View style={[styles.backupDetails, rowDir(isRTL)]}>
          <Ionicons name="cloud-download-outline" size={icon.row} color={colors.textSubtle} />
          <Text style={[styles.backupDescription, textDir(isRTL)]}>
            {t("onboardingRestore.restore.bodyVaults", { count: String(phase.vaultCount) })}
          </Text>
        </View>
        <View style={styles.actions}>
          <OnboardingAction
            label={t("onboardingRestore.restore.title")}
            onPress={onRestore}
            disabled={navigating}
          />
          <OnboardingAction
            variant="outline"
            label={t("onboardingRestore.fresh.title")}
            disabled={navigating}
            onPress={() => {
              if (!restoringRef.current && !navigatingRef.current) setConfirmFresh(true);
            }}
          />
        </View>
        <Text style={[styles.freshHint, textDir(isRTL)]}>{t("onboardingRestore.fresh.body")}</Text>
      </ScrollView>

      <ConfirmDialog
        visible={confirmFresh}
        title={t("onboardingRestore.fresh.confirmTitle")}
        description={t("onboardingRestore.fresh.confirmBody")}
        confirmLabel={t("onboardingRestore.startFresh")}
        cancelLabel={t("common.cancel")}
        onConfirm={() => {
          setConfirmFresh(false);
          void onStartFresh({ persistSkip: true });
        }}
        onCancel={() => setConfirmFresh(false)}
      />
    </SafeAreaView>
  );
}

// ---------- helpers ----------

function classifyError(err: unknown): string {
  if (err instanceof RestoreSessionExpiredError) {
    return t("onboardingRestore.errorSessionExpired");
  }
  if (err instanceof RestoreTimeoutError) {
    return t("onboardingRestore.errorTimeout");
  }
  return t("onboardingRestore.errorGeneric");
}

const styles = StyleSheet.create({
  progressPanel: {
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.borderDefault,
    backgroundColor: colors.bgMuted,
    padding: 20,
  },
  backupDetails: {
    borderWidth: 1,
    borderColor: colors.borderDefault,
    borderRadius: 12,
    padding: 16,
    alignItems: "flex-start",
    gap: 12,
    marginBottom: 24,
  },
  backupDescription: { ...typography.bodySm, color: colors.textSubtle, flex: 1 },
  actions: { gap: 12 },
  freshHint: {
    ...typography.hint,
    color: colors.textSubtle,
    marginTop: 12,
  },
});
