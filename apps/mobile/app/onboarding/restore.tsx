// Onboarding step inserted between auth and profile when the backend has
// existing ledger state for the freshly-signed-in account. Two flows land
// here:
//
//   1. Phase 3 snapshot path. Backend returns 200 from GET /v1/sync/snapshot
//      with a JSON body — the user had a previous v0.5+ install on this
//      account. Show "We found your ledger from <date>. Restore?" + the
//      two action cards. Restore = restoreFromSnapshot; Start fresh = skip
//      to onboarding/profile with the local vault intact.
//
//   2. v0.4 legacy bridge path. Backend returns 404 from the snapshot
//      endpoint BUT 200 from GET /v1/backup/latest. The user is upgrading
//      across the v0.4→v0.5 boundary and the backend still holds the old
//      mega-snapshot. Same two-card UI; Restore = decodeV04Backup +
//      importDecodedEvents.
//
// If both endpoints come back empty (no snapshot and no v0.4 backup),
// _layout.tsx routes the user past this screen straight to profile —
// they're a fresh install with no recoverable data.
//
// State machine on this screen:
//
//   loading           → spinner while we fetch snapshot + (optionally) v0.4 backup
//   ready_snapshot    → show "restore from snapshot" UI
//   ready_v04         → show "restore from v0.4 backup" UI
//   ready_none        → router.replace('/onboarding/profile') (auto-skip)
//   restoring         → spinner while restoreFromSnapshot or bridge runs
//   error             → inline error + "Try again" / "Start fresh"
//
// Restore success → router.replace('/'). The home screen will read the
// just-imported projection rows. Start fresh keeps onboarding flowing
// normally to /onboarding/profile (the user explicitly chose to discard
// the cloud copy in favor of a clean slate).

import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { useEffect, useState } from "react";
import { ActivityIndicator, Platform, Pressable, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Button } from "../../components/Button";
import { colors } from "../../lib/colors";
import { getAppMeta, setAppMeta } from "../../lib/db";
import { textDir, useIsRTL } from "../../lib/direction";
import { fonts } from "../../lib/fonts";
import { t } from "../../lib/i18n";
import { ensureInstallId } from "../../lib/install-id";
import {
  decodeV04Backup,
  ensureBridgeVaultId,
  fetchSnapshot,
  fetchV04Backup,
  importDecodedEvents,
  isEventLogEmptyForVault,
  restoreFromSnapshot,
  RestoreSessionExpiredError,
  RestoreTimeoutError,
  type Snapshot,
  type V04Backup,
} from "../../lib/restore";

type Phase =
  | { kind: "loading" }
  | { kind: "ready_snapshot"; snapshot: Snapshot }
  | { kind: "ready_v04"; backup: V04Backup; vaultId: string }
  | { kind: "ready_none" }
  | { kind: "restoring" }
  | { kind: "error"; message: string; retryable: boolean };

export default function OnboardingRestoreScreen() {
  const router = useRouter();
  const isRTL = useIsRTL();
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // Read the default vault id _layout.tsx persisted right after
        // postSignInHousekeeping returned. If it's missing the user is
        // mid-onboarding with no server vault yet — skip straight to
        // profile so they can create one.
        const defaultVaultId = await getAppMeta("default_vault_id");
        const accountId = await getAppMeta("account_id");
        if (!defaultVaultId || !accountId) {
          if (!cancelled) setPhase({ kind: "ready_none" });
          return;
        }

        // 1. Phase 3 snapshot path.
        const snapshot = await fetchSnapshot({ defaultVaultId });
        if (cancelled) return;
        if (snapshot) {
          setPhase({ kind: "ready_snapshot", snapshot });
          return;
        }

        // 2. v0.4 legacy bridge fallback. Only worth fetching if the
        //    local event log for this vault is empty — if it's not
        //    empty the bridge already ran on a prior launch and the
        //    user must have wiped the snapshot manually; show
        //    ready_none and let onboarding/profile take over.
        const installId = await ensureInstallId();
        const vaultId = await ensureBridgeVaultId({
          installId,
          accountId,
        });
        const eventLogEmpty = await isEventLogEmptyForVault(vaultId);
        if (!eventLogEmpty) {
          if (!cancelled) setPhase({ kind: "ready_none" });
          return;
        }
        const v04 = await fetchV04Backup();
        if (cancelled) return;
        if (v04) {
          setPhase({ kind: "ready_v04", backup: v04, vaultId });
          return;
        }

        setPhase({ kind: "ready_none" });
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
  }, []);

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

  async function onRestoreSnapshot(snapshot: Snapshot) {
    setPhase({ kind: "restoring" });
    try {
      await restoreFromSnapshot(snapshot);
      // Mark onboarding done — the snapshot already contains the local
      // self user so we don't need the profile screen. Going straight
      // to home matches the user's mental model: "my data is back, take
      // me to it."
      await setAppMeta("onboarding_step", "done");
      await setAppMeta("onboarding_pending_name", "");
      await setAppMeta("onboarding_pending_email", "");
      router.replace("/");
    } catch (err) {
      setPhase({
        kind: "error",
        message: classifyError(err),
        retryable: !(err instanceof RestoreSessionExpiredError),
      });
    }
  }

  async function onRestoreV04(backup: V04Backup, vaultId: string) {
    setPhase({ kind: "restoring" });
    try {
      const installId = await ensureInstallId();
      const decoded = decodeV04Backup(backup, installId, vaultId);
      await importDecodedEvents(decoded);
      // The bridge re-creates relationships + entries + shop_profile but
      // NOT the local-self user (it has no event of its own). The user
      // still needs to go through onboarding/profile to re-mint their
      // local self row and let the appliers re-bind it to relationships
      // via the user_a_id resolution in applyPersonAdded.
      await setAppMeta("onboarding_step", "profile");
      router.replace("/onboarding/profile");
    } catch (err) {
      setPhase({
        kind: "error",
        message: classifyError(err),
        retryable: !(err instanceof RestoreSessionExpiredError),
      });
    }
  }

  async function onStartFresh() {
    // The user explicitly chose to ignore the cloud copy. Don't fetch
    // again on the next launch — stamp a flag the next restore-check can
    // read to short-circuit. The flag is per-account so signing out and
    // into a different account still triggers the restore prompt.
    const accountId = await getAppMeta("account_id");
    if (accountId) {
      await setAppMeta(`restore_skipped_for_account_${accountId}`, "1");
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
              onPress={() => setPhase({ kind: "loading" })}
            />
          ) : null}
          <View style={styles.gap} />
          <Button
            variant="secondary"
            label={t("onboardingRestore.startFresh")}
            onPress={onStartFresh}
          />
        </View>
      </SafeAreaView>
    );
  }

  const generatedDate =
    phase.kind === "ready_snapshot"
      ? new Date(phase.snapshot.generated_at_ms)
      : new Date(phase.backup.exported_at);
  const dateLabel = formatDate(generatedDate);

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.content}>
        <Text style={[styles.title, textDir(isRTL)]}>{t("onboardingRestore.title")}</Text>
        <Text style={[styles.subtitle, textDir(isRTL)]}>
          {t("onboardingRestore.subtitle", { date: dateLabel })}
        </Text>

        <View style={styles.spacer} />

        <Pressable
          onPress={() =>
            phase.kind === "ready_snapshot"
              ? onRestoreSnapshot(phase.snapshot)
              : onRestoreV04(phase.backup, phase.vaultId)
          }
          style={({ pressed }) => [styles.card, styles.cardPrimary, pressed && { opacity: 0.85 }]}
        >
          <View style={styles.cardIcon}>
            <Ionicons name="cloud-download-outline" size={28} color={colors.textInverted} />
          </View>
          <Text style={[styles.cardTitle, styles.cardTitlePrimary, textDir(isRTL)]}>
            {t("onboardingRestore.restore.title")}
          </Text>
          <Text style={[styles.cardBody, styles.cardBodyPrimary, textDir(isRTL)]}>
            {t("onboardingRestore.restore.body")}
          </Text>
        </Pressable>

        <View style={styles.gap} />

        <Pressable
          onPress={onStartFresh}
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

function formatDate(d: Date): string {
  if (Number.isNaN(d.getTime())) return "—";
  // Localized short-date format. Day/month/year without time — the
  // restore prompt is about "from which day" not "to the minute."
  return d.toLocaleDateString();
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
