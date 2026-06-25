// In-app Restore from cloud screen. Reachable from the SYNC section of
// ProfileSettingsSheet (signed-in only).
//
// M5 multi-vault recovery: runs recoverAllVaults() (lib/recovery.ts) — it
// lists every vault the account belongs to, restores + witness-binds each,
// and picks one active/default. The success toast reports the count.
//
// Distinct from app/onboarding/restore.tsx by design:
//   - Onboarding/restore supports "Start fresh" because the user has no
//     local data they care about yet, and stamps onboarding_step on
//     completion.
//   - On success this in-app screen returns to / (home), not to
//     onboarding/profile.
//   - The user already has local data; the CTA wording warns about
//     replacement instead of offering "Start fresh".
//
// State machine:
//
//   confirm     → "This will replace your local data" + Replace / Cancel
//   restoring   → spinner; restoreFromSnapshot runs
//   error path  → toast.push(message, "error") + router.back()
//   success     → toast.push("Restored from cloud", "success") + router.replace("/")
//
// All errors surface as toasts (per D-BACKUP-RESTORE-FLOW spec) — never
// modal dialogs. Session-expired clears the local session so the user
// has to sign in again before retrying.
//
// Phase 7 UX coherence pass:
//   - ScreenHeader (chevron-back + centered title + spacer) replaces the
//     headerless layout. The header makes "back to the sheet" a
//     discoverable affordance instead of relying on the iOS swipe-back
//     gesture / Android hardware back / inline "Cancel" Pressable.
//   - Network precheck before fetchSnapshot — surfaces "you appear to
//     be offline" instantly instead of waiting 30 s for the timeout.
//   - RestoreSessionExpiredError now wipes the local session so the
//     sheet's signed-in surfaces stop appearing until the user signs
//     in again. Previously the JWT was invalidated on the server but
//     the sheet's Sync rows still rendered, leading to a stuck state.

import { Ionicons } from "@expo/vector-icons";
import * as Network from "expo-network";
import { useRouter } from "expo-router";
import { useRef, useState } from "react";
import { Platform, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { RestoreProgress, restoreProgressLabel } from "../components/RestoreProgress";
import { ScreenHeader } from "../components/SettingsScreen";
import { useToast } from "../components/Toast";
import { signOut } from "../lib/auth";
import { colors } from "../lib/colors";
import { textDir, useIsRTL } from "../lib/direction";
import { fonts } from "../lib/fonts";
import { t } from "../lib/i18n";
import { recoverAllVaults, type RecoveryProgress } from "../lib/recovery";
import { RestoreSessionExpiredError, RestoreTimeoutError } from "../lib/restore";

type Phase = { kind: "confirm" } | { kind: "restoring" };

export default function RestoreScreen() {
  const router = useRouter();
  const isRTL = useIsRTL();
  const toast = useToast();
  const [phase, setPhase] = useState<Phase>({ kind: "confirm" });
  // Live recovery progress, driven by recoverAllVaults's onProgress callback —
  // powers the determinate progress bar in the "restoring" phase.
  const [progress, setProgress] = useState<RecoveryProgress | null>(null);
  // Synchronous re-entry guard — see entry/new.tsx. Without it a
  // double-tap during the network precheck started two concurrent
  // restoreFromSnapshot transactions.
  const confirmingRef = useRef(false);

  // Defer toast pushes until AFTER router navigation so the parent
  // viewport can actually render them (toasts inside the leaving stack
  // modal are silently swallowed — same constraint documented in
  // app/index.tsx onSyncNow).
  function exitWithToast(msg: string, kind: "success" | "error" | "info") {
    router.back();
    setTimeout(() => toast.push(msg, kind), 240);
  }

  function exitToHomeWithToast(msg: string, kind: "success" | "error") {
    router.replace("/");
    setTimeout(() => toast.push(msg, kind), 240);
  }

  async function onConfirm() {
    if (confirmingRef.current) return;
    confirmingRef.current = true;
    // Flip to the progress bar BEFORE the network precheck — the confirm
    // button must leave the screen the moment the first tap lands.
    setProgress(null);
    setPhase({ kind: "restoring" });
    // UX critique #5 (Eng C5): cheap network precheck so users on a flaky
    // connection don't sit on the spinner for the full 30 s timeout.
    // Network.getNetworkStateAsync is also unreliable (false negatives on
    // captive portals), so this is advisory — we still attempt the fetch
    // and rely on RestoreTimeoutError as the authoritative fallback.
    try {
      const net = await Network.getNetworkStateAsync();
      if (net?.isConnected === false) {
        exitWithToast(t("menu.sync.offline"), "error");
        return;
      }
    } catch {
      // expo-network unavailable — skip precheck, fall through to fetch.
    }
    try {
      // M5 multi-vault recovery: restore EVERY vault the account belongs to,
      // not just the default. recoverAllVaults never throws for a single
      // vault's failure — it returns a per-vault outcome (only a total
      // inability to list the account's vaults bubbles up here).
      const result = await recoverAllVaults({ onProgress: setProgress });
      if (result.recovered.length > 0) {
        exitToHomeWithToast(
          t("restore.toast.successVaults", { count: String(result.recovered.length) }),
          "success",
        );
        return;
      }
      // Nothing recovered. If the inability to list was auth — surface the
      // session-expired path (clears the local session below). Otherwise the
      // account simply has no restorable vaults yet, or every vault errored.
      const listFailure = result.failed.find((f) => f.vaultId === "*");
      if (listFailure && /401|not signed in|unauthor/i.test(listFailure.error)) {
        throw new RestoreSessionExpiredError();
      }
      if (result.failed.length === 0) {
        exitWithToast(t("restore.toast.noBackup"), "error");
        return;
      }
      if (__DEV__) console.warn("[restore] recovery produced no vaults", result.failed);
      exitWithToast(t("restore.toast.generic"), "error");
    } catch (err) {
      if (err instanceof RestoreSessionExpiredError) {
        // UX critique #5 (Eng C5): the JWT is invalid; the sheet's
        // signed-in surfaces (Sync now, Restore from cloud) would still
        // render despite the user being effectively signed-out. Clear
        // the local session NOW so the next sheet open reflects reality.
        // signOut() is idempotent + tolerant of network failure (auth.ts:
        // 471) so we don't need to gate this on anything.
        try {
          await signOut();
        } catch (e) {
          if (__DEV__) console.warn("[restore] post-401 signOut failed", e);
        }
        exitWithToast(t("restore.toast.sessionExpired"), "error");
        return;
      }
      if (err instanceof RestoreTimeoutError) {
        exitWithToast(t("restore.toast.timeout"), "error");
        return;
      }
      if (__DEV__) console.warn("[restore] failed", err);
      exitWithToast(t("restore.toast.generic"), "error");
    }
  }

  if (phase.kind === "restoring") {
    return (
      <SafeAreaView style={styles.container} edges={["top", "bottom"]}>
        <ScreenHeader
          title={t("restore.confirm.title")}
          onBack={() => {
            // Discourage backing out mid-restore — the in-DB transaction
            // is atomic but the navigation race is real. Hardware back +
            // gesture swipe still work (this is just the chrome button).
            // No-op; the user can wait for the spinner to resolve.
          }}
          isRTL={isRTL}
          backLabel={t("common.back")}
        />
        <View style={styles.center}>
          <RestoreProgress
            fraction={progress?.fraction ?? 0}
            label={progress ? restoreProgressLabel(progress) : t("restoreProgress.preparing")}
            tone="dark"
            isRTL={isRTL}
          />
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container} edges={["top", "bottom"]}>
      <ScreenHeader
        title={t("restore.confirm.title")}
        onBack={() => router.back()}
        isRTL={isRTL}
        backLabel={t("common.back")}
      />
      <ScrollView contentContainerStyle={styles.scrollContent}>
        <View style={styles.content}>
          <View style={styles.iconWrap}>
            <Ionicons name="cloud-download-outline" size={36} color={colors.textEmphasis} />
          </View>
          <Text style={[styles.title, textDir(isRTL)]}>{t("restore.confirm.title")}</Text>
          <Text style={[styles.body, textDir(isRTL)]}>{t("restore.confirm.body")}</Text>

          <View style={styles.spacer} />

          <Pressable
            onPress={onConfirm}
            accessibilityRole="button"
            accessibilityLabel={t("restore.confirm.cta")}
            accessibilityHint={t("restore.confirm.body")}
            style={({ pressed }) => [styles.cta, styles.ctaPrimary, pressed && { opacity: 0.85 }]}
          >
            <Text style={[styles.ctaLabel, styles.ctaLabelPrimary, textDir(isRTL)]}>
              {t("restore.confirm.cta")}
            </Text>
          </Pressable>

          <View style={styles.gap} />

          <Pressable
            onPress={() => router.back()}
            accessibilityRole="button"
            accessibilityLabel={t("restore.confirm.cancel")}
            style={({ pressed }) => [styles.cta, styles.ctaGhost, pressed && { opacity: 0.85 }]}
          >
            <Text style={[styles.ctaLabel, textDir(isRTL)]}>{t("restore.confirm.cancel")}</Text>
          </Pressable>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bgDefault },
  scrollContent: { flexGrow: 1, justifyContent: "center" },
  content: { padding: 24 },
  center: { flex: 1, alignItems: "center", justifyContent: "center", paddingHorizontal: 32 },
  iconWrap: {
    width: 64,
    height: 64,
    borderRadius: 16,
    backgroundColor: colors.bgMuted,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 20,
    alignSelf: "center",
  },
  title: {
    fontSize: 22,
    fontFamily: fonts.sansBold,
    color: colors.textEmphasis,
    letterSpacing: -0.4,
    textAlign: "center",
  },
  body: {
    fontSize: 14,
    fontFamily: fonts.sansRegular,
    color: colors.textSubtle,
    marginTop: 10,
    lineHeight: 20,
    textAlign: "center",
  },
  spacer: { height: 32 },
  gap: { height: 10 },
  cta: {
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: "center",
    borderWidth: 1,
  },
  ctaPrimary: {
    backgroundColor: colors.bgInverted,
    borderColor: colors.bgInverted,
    ...Platform.select({
      ios: {
        shadowColor: "#000",
        shadowOpacity: 0.15,
        shadowRadius: 12,
        shadowOffset: { width: 0, height: 4 },
      },
      android: { elevation: 3 },
    }),
  },
  ctaGhost: {
    backgroundColor: colors.bgDefault,
    borderColor: colors.borderDefault,
  },
  ctaLabel: {
    fontSize: 15,
    fontFamily: fonts.sansSemi,
    color: colors.textEmphasis,
  },
  ctaLabelPrimary: { color: colors.textInverted },
});
