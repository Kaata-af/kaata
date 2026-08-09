// apps/mobile/app/diagnostics.tsx
//
// App-health / crash-diagnosis screen. Renders, as plain copy-able text:
//   1. The app version + build (native APK truth, with a stale-build warning
//      when the bundled JS version disagrees).
//   2. WHY the previous process(es) died — ApplicationExitInfo verdict
//      (LOW_MEMORY = OOM/LMK kill, NATIVE_CRASH = Hermes abort, etc.) plus
//      the RSS at death.
//   3. A current memory snapshot.
//
// "Copy report" bundles all of the above (plus device + crash history) to the
// clipboard so a user can paste it straight to us — no screenshots, no adb.
// Reachable from Account → App health, or directly at /diagnostics.
//
// PARKED: the live Nearby-sync (BT steady) state + log and the per-minute
// memory-slope table are commented out below — they depend on the mesh feature,
// which is hidden for now. Re-enable them together when mesh ships again.

import * as Application from "expo-application";
import * as Clipboard from "expo-clipboard";
import Constants from "expo-constants";
import { useRouter } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import {
  DevSettings,
  Platform,
  Pressable,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { ScreenHeader } from "../components/SettingsScreen";
import { trackingSafe, useIsRTL } from "../lib/direction";
import { t } from "../lib/i18n";
import { useToast } from "../components/Toast";
import { colors } from "../lib/colors";
import { buildDiagnosticsReport } from "../lib/diagnostics-report";
import { fonts, monoLineHeight, sansLineHeight } from "../lib/fonts";
import { resetAllLocalData } from "../lib/db";
import { radius, TOUCH_MIN } from "../lib/tokens";
// PARKED (Nearby sync / mesh): the live sync state + log and the mem-probe
// memory-slope sampling belong to the mesh feature, which is hidden for now.
// Re-enable these imports together with the commented-out sections below when
// mesh ships again.
// import { getDb } from "../lib/db-tx";
// import { getAppMeta } from "../lib/db";
// import { getSyncDiagLines, onSyncDiag, clearSyncDiag } from "../lib/mesh/sync-diag";
// import { isBtcSteadyRunning, isBtcPairPaused } from "../lib/mesh/btc-steady";
import {
  getLastExitReasons,
  getMemorySnapshot,
  type ProcessExitReason,
} from "../modules/kaata-gatt-server";

// PARKED (mesh): row shape for the memory-slope table (mem_samples).
// type MemRow = {
//   at: number;
//   native_pss_kb: number | null;
//   dalvik_pss_kb: number | null;
//   native_alloc_kb: number | null;
//   js_heap_kb: number | null;
//   avail_mb: number | null;
//   storage_free_mb: number | null;
// };

function fmtTime(ms: number): string {
  try {
    const d = new Date(ms);
    const p = (n: number) => n.toString().padStart(2, "0");
    return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  } catch {
    return String(ms);
  }
}

function mb(kb: number | null | undefined): string {
  if (kb == null) return "—";
  return (kb / 1024).toFixed(1) + "MB";
}

export default function DiagnosticsScreen() {
  const router = useRouter();
  const toast = useToast();
  const isRTL = useIsRTL();
  const [copyingReport, setCopyingReport] = useState(false);
  const [copied, setCopied] = useState(false);
  const [sharingReport, setSharingReport] = useState(false);
  // When the clipboard write fails (rare), we drop the report into a selectable
  // text block so the user can long-press → Select all → Copy by hand.
  const [fallbackText, setFallbackText] = useState<string | null>(null);
  const [exits, setExits] = useState<ProcessExitReason[]>([]);
  const [now, setNow] = useState<Record<string, unknown>>({});
  // PARKED (mesh): live sync state/log + memory-slope samples.
  // const [samples, setSamples] = useState<MemRow[]>([]);
  // const [syncLines, setSyncLines] = useState<string[]>([]);
  // const [syncSnap, setSyncSnap] = useState<{ steady: boolean; paused: boolean; shop: string }>({
  //   steady: false,
  //   paused: false,
  //   shop: "?",
  // });
  // DEV-only: two-tap arm→confirm for the destructive reset button below.
  const [resetArmed, setResetArmed] = useState(false);

  // PARKED (mesh): live Nearby-sync (BT steady) state + diag log.
  // const refreshSync = useCallback(async () => {
  //   setSyncLines(getSyncDiagLines());
  //   let shop = "?";
  //   try {
  //     shop = (await getAppMeta("shop_mode_enabled")) ?? "0";
  //   } catch {
  //     /* */
  //   }
  //   setSyncSnap({ steady: isBtcSteadyRunning(), paused: isBtcPairPaused(), shop });
  // }, []);

  const load = useCallback(async () => {
    try {
      setExits(getLastExitReasons());
    } catch {
      setExits([]);
    }
    try {
      setNow(getMemorySnapshot() as Record<string, unknown>);
    } catch {
      setNow({});
    }
    // PARKED (mesh): the memory-slope samples come from the mem-probe, which only
    // runs while the mesh sync loop is active.
    // try {
    //   const db = await getDb();
    //   const rows = await db.getAllAsync<MemRow>(
    //     `SELECT at, native_pss_kb, dalvik_pss_kb, native_alloc_kb,
    //             js_heap_kb, avail_mb, storage_free_mb
    //        FROM mem_samples
    //       ORDER BY id DESC
    //       LIMIT 20`,
    //   );
    //   setSamples(rows);
    // } catch {
    //   setSamples([]);
    // }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Copy the full App-health report (versions + account/backup/sync state +
  // memory + crash history) to the clipboard so the user can send it to us.
  // Best-effort; on a clipboard failure we fall back to a selectable text block.
  const onCopyReport = useCallback(async () => {
    if (copyingReport) return;
    setCopyingReport(true);
    try {
      await Clipboard.setStringAsync(await buildDiagnosticsReport());
      setFallbackText(null);
      setCopied(true);
      setTimeout(() => setCopied(false), 5000);
      toast.push(t("diagnostics.toast.copied"), "success");
    } catch (err) {
      console.warn("[diagnostics] copy report failed", err);
      try {
        setFallbackText(await buildDiagnosticsReport());
      } catch {
        setFallbackText(null);
      }
      toast.push(t("diagnostics.toast.copyFailed"), "error");
    } finally {
      setCopyingReport(false);
    }
  }, [copyingReport, toast]);

  // One-tap alternative: open the OS share sheet with the report prefilled, so
  // the user can fire it straight into WhatsApp (or any app) without a paste.
  const onShareReport = useCallback(async () => {
    if (sharingReport) return;
    setSharingReport(true);
    try {
      await Share.share({ message: await buildDiagnosticsReport() });
    } catch (err) {
      console.warn("[diagnostics] share report failed", err);
      toast.push(t("diagnostics.toast.shareFailed"), "error");
    } finally {
      setSharingReport(false);
    }
  }, [sharingReport, toast]);

  // PARKED (mesh): live-update the sync log — push-driven on each new line, plus
  // a 2s poll so the running/paused snapshot stays fresh while the user watches.
  // useEffect(() => {
  //   const off = onSyncDiag(() => void refreshSync());
  //   const t = setInterval(() => void refreshSync(), 2000);
  //   return () => {
  //     off();
  //     clearInterval(t);
  //   };
  // }, [refreshSync]);

  // DEV-only: wipe kaata.db (all ledger + onboarding state) and reload so the
  // app boots back into onboarding. __DEV__-gated at the call site so it can
  // never ship. resetAllLocalData drops every table + clears cached handles;
  // DevSettings.reload re-runs initDb() which recreates the schema from scratch.
  const onResetPress = useCallback(() => {
    if (!resetArmed) {
      setResetArmed(true);
      setTimeout(() => setResetArmed(false), 4000);
      return;
    }
    void (async () => {
      try {
        await resetAllLocalData();
      } catch (err) {
        console.warn("[diagnostics] resetAllLocalData failed", err);
      }
      DevSettings.reload();
    })();
  }, [resetArmed]);

  // Version + build (moved here from Account). Prefer the NATIVE (installed APK)
  // values — the truth about what's actually running — falling back to the bundled
  // JS (app.json via expo-constants) where native is unavailable. When the two
  // disagree the running build is stale; we flag it inline.
  const appVersion =
    Application.nativeApplicationVersion ?? Constants.expoConfig?.version ?? "0.0.0";
  // Per-platform fallback: android.versionCode and ios.buildNumber are separate
  // counters for the same release (1.0.7 = versionCode 33 / buildNumber 13), so
  // reading versionCode on iOS reports a number that was never installed there.
  const buildNumber =
    Application.nativeBuildVersion ??
    (Platform.OS === "ios"
      ? (Constants.expoConfig?.ios?.buildNumber ?? null)
      : Constants.expoConfig?.android?.versionCode != null
        ? String(Constants.expoConfig.android.versionCode)
        : null);
  const jsBundleVersion = Constants.expoConfig?.version ?? null;

  return (
    <SafeAreaView style={styles.root} edges={["top", "bottom"]}>
      {/* isRTL was hardcoded false here — the only one of 17 ScreenHeader call
          sites that did so, which pointed the back chevron the wrong way for a
          Dari user. The screen's own copy is still English (localizing it is
          tracked separately), but the chrome should follow the app's language
          regardless: the chevron is navigation, not content. */}
      <ScreenHeader title={t("diagnostics.title")} onBack={() => router.back()} isRTL={isRTL} />
      <ScrollView contentContainerStyle={styles.scroll}>
        <Text style={styles.hint}>{t("diagnostics.hint")}</Text>
        <View style={styles.actionRow}>
          <Pressable
            style={[styles.copyReport, copyingReport && { opacity: 0.6 }]}
            onPress={onCopyReport}
            disabled={copyingReport}
          >
            <Text style={styles.copyReportText}>
              {copyingReport
                ? t("diagnostics.copying")
                : copied
                  ? t("diagnostics.copied")
                  : t("diagnostics.copyReport")}
            </Text>
          </Pressable>
          <Pressable
            style={[styles.shareReport, sharingReport && { opacity: 0.6 }]}
            onPress={onShareReport}
            disabled={sharingReport}
          >
            <Text style={styles.shareReportText}>
              {sharingReport ? "…" : t("diagnostics.share")}
            </Text>
          </Pressable>
        </View>

        {fallbackText ? (
          <View style={styles.fallbackBox}>
            <Text style={styles.copyHint}>{t("diagnostics.fallbackHint")}</Text>
            <Text style={styles.mono} selectable>
              {fallbackText}
            </Text>
          </View>
        ) : null}

        {/* ---- App version + build (moved here from Account) ---- */}
        <Text style={[styles.section, trackingSafe(isRTL)]}>
          {t("diagnostics.section.version")}
        </Text>
        <Text style={styles.mono}>
          app {appVersion}
          {buildNumber ? ` · build ${buildNumber}` : ""}
        </Text>
        {jsBundleVersion && jsBundleVersion !== appVersion ? (
          <Text style={styles.warn}>
            {t("diagnostics.staleBuild", { js: jsBundleVersion, native: appVersion })}
          </Text>
        ) : null}

        {/* ---- PARKED (mesh): Nearby sync (BT steady) live state + log ----
            Re-enable together with the imports / state / effects above when the
            mesh feature ships again.
        <Text style={[styles.section, trackingSafe(isRTL)]}>NEARBY SYNC — STATE</Text>
        <Text style={styles.mono}>
          shop mode: {syncSnap.shop === "1" ? "ON" : "OFF"} · steady loop:{" "}
          {syncSnap.steady ? "RUNNING" : "STOPPED"} · pairing: {syncSnap.paused ? "YES" : "no"}
        </Text>
        {syncSnap.shop === "1" && !syncSnap.steady && !syncSnap.paused ? (
          <Text style={styles.warn}>
            ⚠ shop mode ON but steady loop STOPPED — this is the no-sync state (the watchdog should
            restart it within 15s).
          </Text>
        ) : null}

        <Text style={[styles.section, trackingSafe(isRTL)]}>NEARBY SYNC — LOG (newest first)</Text>
        <Text style={styles.copyHint}>Long-press the log below → Select all → Copy</Text>
        {syncLines.length === 0 ? (
          <Text style={styles.muted}>
            No sync events yet — turn Nearby sync ON, pair two phones, then watch here.
          </Text>
        ) : (
          <Text style={styles.mono} selectable>
            {syncLines.join("\n")}
          </Text>
        )}
        <Pressable style={styles.refreshGhost} onPress={() => clearSyncDiag()}>
          <Text style={styles.refreshGhostText}>Clear sync log</Text>
        </Pressable>
        ---- end PARKED Nearby sync ---- */}

        {/* ---- Last exit reasons + memory snapshot (ANDROID ONLY) ----
            Both read modules/kaata-gatt-server, whose expo-module.config.json
            declares platforms: ["android"] — exit reasons come from Android's
            ApplicationExitInfo (API 30+) and the snapshot from Debug.MemoryInfo,
            neither of which has an iOS equivalent. The JS wrappers early-return
            [] and {} off Android, so on an iPhone these rendered as a section
            headed "WHY THE APP DIED" explaining itself in terms of "Android < 11"
            plus a row of em-dashes. This screen exists to be screenshotted and
            sent to support, so a permanently-empty section that reads as
            "something is broken" costs us real signal. Hidden rather than
            emptied. */}
        {Platform.OS === "android" ? (
          <>
            <Text style={[styles.section, trackingSafe(isRTL)]}>
              {t("diagnostics.section.exits")}
            </Text>
            {exits.length === 0 ? (
              <Text style={styles.muted}>{t("diagnostics.noExits")}</Text>
            ) : (
              exits.map((e, i) => (
                <View key={i} style={styles.exitRow}>
                  <Text style={styles.exitName}>
                    {e.reasonName}
                    {e.reasonName === "LOW_MEMORY" ? "  ← OOM / LMK kill" : ""}
                    {e.reasonName === "NATIVE_CRASH" ? "  ← native/Hermes abort" : ""}
                  </Text>
                  <Text style={styles.mono}>
                    {fmtTime(e.timestamp)} rss={mb(e.rssKb)} pss={mb(e.pssKb)} imp=
                    {e.importance}
                  </Text>
                  {e.description ? <Text style={styles.monoDim}>{e.description}</Text> : null}
                </View>
              ))
            )}

            <Text style={[styles.section, trackingSafe(isRTL)]}>
              {t("diagnostics.section.now")}
            </Text>
            <Text style={styles.mono}>
              nativePss={mb(now.nativePssKb as number)} dalvikPss=
              {mb(now.dalvikPssKb as number)} js={mb(now.javaHeapUsedKb as number)}
            </Text>
            <Text style={styles.mono}>
              availMem={(now.systemAvailMemMb as number) ?? "—"}MB lowMem=
              {String(now.systemLowMemory ?? "—")} storageFree=
              {(now.storageFreeMb as number) ?? "—"}MB
            </Text>
          </>
        ) : null}

        {/* ---- PARKED (mesh): memory slope (mem_samples ring) ----
            The mem-probe only samples while the mesh sync loop runs, so this is
            empty without the parked feature. Re-enable with the query in load().
        <Text style={[styles.section, trackingSafe(isRTL)]}>MEMORY SLOPE (last 20 min, newest first)</Text>
        <Text style={styles.monoDim}>time nativePss dalvikPss js avail store</Text>
        {samples.length === 0 ? (
          <Text style={styles.muted}>
            No samples yet — turn Nearby sync ON and wait 1 minute, then reopen this screen.
          </Text>
        ) : (
          samples.map((s, i) => (
            <Text key={i} style={styles.mono}>
              {fmtTime(s.at).slice(6)} {mb(s.native_pss_kb).padStart(8)}{" "}
              {mb(s.dalvik_pss_kb).padStart(8)} {mb(s.js_heap_kb).padStart(6)}{" "}
              {(s.avail_mb ?? "—").toString().padStart(5)}{" "}
              {(s.storage_free_mb ?? "—").toString().padStart(5)}
            </Text>
          ))
        )}
        ---- end PARKED memory slope ---- */}

        <Pressable style={styles.refresh} onPress={() => void load()}>
          <Text style={styles.refreshText}>{t("diagnostics.refresh")}</Text>
        </Pressable>

        {__DEV__ ? (
          <>
            <Text style={[styles.section, trackingSafe(isRTL)]}>DEV ONLY</Text>
            <Text style={styles.copyHint}>
              Wipes kaata.db (all ledger + onboarding state) and reloads, so you land back on
              onboarding. Never ships — __DEV__ gated.
            </Text>
            <Pressable
              style={[styles.dangerBtn, resetArmed && styles.dangerBtnArmed]}
              onPress={onResetPress}
            >
              <Text style={[styles.dangerBtnText, resetArmed && styles.dangerBtnTextArmed]}>
                {resetArmed ? "Tap again to wipe & reload" : "Reset all data"}
              </Text>
            </Pressable>
          </>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bgDefault },
  scroll: { padding: 20, paddingBottom: 60 },
  hint: {
    fontSize: 13,
    fontFamily: fonts.sansRegular,
    color: colors.textSubtle,
    marginBottom: 12,
    lineHeight: sansLineHeight(13, 18),
  },
  actionRow: { flexDirection: "row", alignItems: "center", gap: 10, marginBottom: 8 },
  // The four buttons on this screen all measured 10+10 padding + a ~22px
  // 14px-sans line box = 42, i.e. 2px under the HIG floor. minHeight +
  // justifyContent lifts them to 44 without moving the label off its optical
  // centre; the extra 2px is absorbed by the page's own vertical rhythm.
  copyReport: {
    paddingHorizontal: 18,
    paddingVertical: 10,
    minHeight: TOUCH_MIN,
    justifyContent: "center",
    borderRadius: radius.sm,
    backgroundColor: colors.bgInverted,
  },
  copyReportText: { color: colors.textInverted, fontSize: 14, fontFamily: fonts.sansSemi },
  shareReport: {
    paddingHorizontal: 18,
    paddingVertical: 10,
    minHeight: TOUCH_MIN,
    justifyContent: "center",
    borderRadius: radius.sm,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderDefault,
  },
  shareReportText: { color: colors.textDefault, fontSize: 14, fontFamily: fonts.sansSemi },
  fallbackBox: {
    marginBottom: 12,
    padding: 10,
    borderRadius: radius.sm,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderDefault,
    backgroundColor: colors.bgMuted,
  },
  section: {
    fontSize: 11,
    fontFamily: fonts.sansSemi,
    color: colors.textSubtle,
    letterSpacing: 0.6,
    marginTop: 22,
    marginBottom: 8,
  },
  exitRow: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.borderDefault,
    paddingVertical: 8,
  },
  exitName: {
    fontSize: 14,
    fontFamily: fonts.sansSemi,
    color: colors.textEmphasis,
    marginBottom: 2,
  },
  mono: {
    fontFamily: fonts.monoRegular,
    fontSize: 12,
    color: colors.textDefault,
    marginVertical: 1,
  },
  monoDim: {
    fontFamily: fonts.monoRegular,
    fontSize: 11,
    color: colors.textMuted,
    marginVertical: 1,
  },
  muted: { fontSize: 13, fontFamily: fonts.sansRegular, color: colors.textMuted },
  copyHint: {
    fontSize: 11,
    fontFamily: fonts.sansRegular,
    color: colors.textMuted,
    marginBottom: 8,
    // No fontStyle. This was the ONLY italic in the app, and lib/fonts.ts
    // registers upright faces only — so RN either synthesises a fake oblique
    // or silently swaps in a system fallback face, which is worse: one line of
    // non-Vazirmatn text in the middle of a Vazirmatn screen.
  },
  warn: {
    fontFamily: fonts.monoRegular,
    fontSize: 12,
    color: colors.danger,
    marginTop: 6,
    // JetBrains Mono's natural height at 12px is 16, so the old raw 17 cleared
    // the iOS clip by 1px by luck. Route it through the helper so a future
    // size bump can't silently behead the glyphs.
    lineHeight: monoLineHeight(12, 17),
  },
  // PARKED (mesh): only referenced by the commented-out sync-log block above.
  // Radius snapped for consistency; its ~36px height is deliberately NOT lifted
  // to TOUCH_MIN here — re-measure it against the live layout when mesh ships.
  refreshGhost: {
    marginTop: 12,
    alignSelf: "flex-start",
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderRadius: radius.sm,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderDefault,
  },
  refreshGhostText: { color: colors.textMuted, fontSize: 13, fontFamily: fonts.sansSemi },
  refresh: {
    marginTop: 28,
    alignSelf: "flex-start",
    paddingHorizontal: 18,
    paddingVertical: 10,
    minHeight: TOUCH_MIN,
    justifyContent: "center",
    borderRadius: radius.sm,
    backgroundColor: colors.bgInverted,
  },
  refreshText: { color: colors.textInverted, fontSize: 14, fontFamily: fonts.sansSemi },
  dangerBtn: {
    marginTop: 12,
    alignSelf: "flex-start",
    paddingHorizontal: 18,
    paddingVertical: 10,
    minHeight: TOUCH_MIN,
    justifyContent: "center",
    borderRadius: radius.sm,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.danger,
  },
  dangerBtnArmed: { backgroundColor: colors.danger },
  dangerBtnText: { color: colors.danger, fontSize: 14, fontFamily: fonts.sansSemi },
  dangerBtnTextArmed: { color: colors.textInverted },
});
