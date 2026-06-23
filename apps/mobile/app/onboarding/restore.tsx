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
import { useRouter } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Platform, Pressable, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Button } from "../../components/Button";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { colors } from "../../lib/colors";
import { getAppMeta, setAppMeta } from "../../lib/db";
import { textDir, useIsRTL } from "../../lib/direction";
import { fonts } from "../../lib/fonts";
import { t } from "../../lib/i18n";
import { adoptAccountPhoneToSelf } from "../../lib/auth";
import { recoverAllVaults } from "../../lib/recovery";
import { RestoreSessionExpiredError, RestoreTimeoutError } from "../../lib/restore";
import { listVaults } from "../../lib/vault-api";

type Phase =
  | { kind: "loading" }
  | { kind: "ready"; vaultCount: number }
  | { kind: "ready_none" }
  | { kind: "restoring" }
  | { kind: "error"; message: string; retryable: boolean };

export default function OnboardingRestoreScreen() {
  const router = useRouter();
  const isRTL = useIsRTL();
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });
  // Bumped by the error screen's "Try again" — the probe effect keys on it.
  // Previously Try-again only set phase back to "loading" and NOTHING
  // re-ran the mount-only probe: an infinite spinner with force-quit as
  // the only way out.
  const [retryNonce, setRetryNonce] = useState(0);
  // Synchronous re-entry guard for the restore action — see entry/new.tsx.
  const restoringRef = useRef(false);
  // Confirmation gate for "Start fresh" on the data-found screen — discarding
  // a found backup from this device shouldn't be a one-tap mistake.
  const [confirmFresh, setConfirmFresh] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // Without an account_id the user is mid-onboarding with no server
        // vault yet — skip straight to profile so they can create one.
        const accountId = await getAppMeta("account_id");
        if (!accountId) {
          if (!cancelled) setPhase({ kind: "ready_none" });
          return;
        }

        // M5: list every vault this account is a member of. Any non-archived
        // vault → offer recovery; none → fresh install, skip to profile.
        const vaults = await listVaults();
        if (cancelled) return;
        const live = vaults.filter((v) => v.archived_at_ms == null);
        if (live.length === 0) {
          setPhase({ kind: "ready_none" });
          return;
        }
        setPhase({ kind: "ready", vaultCount: live.length });
      } catch (err) {
        if (cancelled) return;
        setPhase({
          kind: "error",
          message: classifyError(err),
          retryable: !(err instanceof RestoreSessionExpiredError),
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
      router.replace("/onboarding/profile");
    }, 50);
    return () => clearTimeout(id);
  }, [phase.kind, router]);

  async function onRestore() {
    if (restoringRef.current) return;
    restoringRef.current = true;
    setPhase({ kind: "restoring" });
    try {
      const result = await recoverAllVaults();
      if (result.recovered.length > 0) {
        // At least one vault came back. Mark onboarding done — the restored
        // snapshot already contains the local self user so we don't need the
        // profile screen. Going straight to home matches the user's mental
        // model: "my data is back, take me to it."
        await setAppMeta("onboarding_step", "done");
        await setAppMeta("onboarding_pending_name", "");
        await setAppMeta("onboarding_pending_email", "");
        // BUG-1: the restored self user comes back WITHOUT a phone (the self
        // phone is device-local + never event-sourced) AND this screen skips the
        // profile form that would prefill it. Adopt the account-level phone
        // (stashed at sign-in from /v1/auth/google) onto the restored self row so
        // it survives the reinstall. Best-effort; runs after recovery created the
        // self row (the sign-in-time reconcile ran before that row existed).
        const pendingPhone = (await getAppMeta("onboarding_pending_phone"))?.trim() || null;
        if (pendingPhone) await adoptAccountPhoneToSelf(pendingPhone);
        await setAppMeta("onboarding_pending_phone", "");
        router.replace("/");
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
      setPhase({
        kind: "error",
        message: classifyError(err),
        retryable: !(err instanceof RestoreSessionExpiredError),
      });
    }
  }

  async function onStartFresh(opts: { persistSkip: boolean }) {
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
  }

  // ---------- render ----------

  if (phase.kind === "loading" || phase.kind === "ready_none") {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.center}>
          <ActivityIndicator color={colors.textDefault} />
        </View>
      </SafeAreaView>
    );
  }

  if (phase.kind === "restoring") {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.center}>
          <ActivityIndicator color={colors.textDefault} />
          <View style={styles.gap} />
          <Text style={[styles.subtitle, textDir(isRTL)]}>{t("onboardingRestore.restoring")}</Text>
        </View>
      </SafeAreaView>
    );
  }

  if (phase.kind === "error") {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.content}>
          <Text style={[styles.title, textDir(isRTL)]}>{t("onboardingRestore.errorTitle")}</Text>
          <Text style={[styles.subtitle, textDir(isRTL)]}>{phase.message}</Text>
          <View style={styles.spacer} />
          {phase.retryable ? (
            <Button
              label={t("onboardingRestore.tryAgain")}
              onPress={() => {
                setPhase({ kind: "loading" });
                // Re-run the probe — setting phase alone left an
                // infinite spinner (the probe effect was mount-only).
                setRetryNonce((n) => n + 1);
              }}
            />
          ) : null}
          <View style={styles.gap} />
          <Button
            variant="secondary"
            label={t("onboardingRestore.startFresh")}
            // From the error screen: do NOT persist the skip — the restore
            // failed (likely transient), so the next launch should re-offer it.
            onPress={() => onStartFresh({ persistSkip: false })}
          />
        </View>
      </SafeAreaView>
    );
  }

  // phase.kind === "ready"
  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.content}>
        <Text style={[styles.title, textDir(isRTL)]}>{t("onboardingRestore.title")}</Text>
        <Text style={[styles.subtitle, textDir(isRTL)]}>
          {t("onboardingRestore.subtitleVaults", { count: String(phase.vaultCount) })}
        </Text>

        <View style={styles.spacer} />

        <Pressable
          onPress={onRestore}
          style={({ pressed }) => [styles.card, styles.cardPrimary, pressed && { opacity: 0.85 }]}
        >
          <View style={styles.cardIcon}>
            <Ionicons name="cloud-download-outline" size={28} color={colors.textInverted} />
          </View>
          <Text style={[styles.cardTitle, styles.cardTitlePrimary, textDir(isRTL)]}>
            {t("onboardingRestore.restore.title")}
          </Text>
          <Text style={[styles.cardBody, styles.cardBodyPrimary, textDir(isRTL)]}>
            {t("onboardingRestore.restore.bodyVaults", { count: String(phase.vaultCount) })}
          </Text>
        </Pressable>

        <View style={styles.gap} />

        <Pressable
          onPress={() => setConfirmFresh(true)}
          style={({ pressed }) => [styles.card, styles.cardGhost, pressed && { opacity: 0.85 }]}
        >
          <View style={styles.cardIcon}>
            <Ionicons name="document-outline" size={28} color={colors.textEmphasis} />
          </View>
          <Text style={[styles.cardTitle, textDir(isRTL)]}>
            {t("onboardingRestore.fresh.title")}
          </Text>
          <Text style={[styles.cardBody, textDir(isRTL)]}>{t("onboardingRestore.fresh.body")}</Text>
        </Pressable>
      </View>

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

// ---------- styles (mirrors onboarding/auth.tsx for visual continuity) ----------

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bgDefault },
  content: { flex: 1, padding: 24, justifyContent: "center" },
  center: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
  },
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
});
