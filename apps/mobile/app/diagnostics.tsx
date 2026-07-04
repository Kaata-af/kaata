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
// Also renders the live Nearby-sync (BT steady) state + log and the
// per-minute memory-slope table (un-parked with the 2026-07 mesh revive) —
// the on-device instruments that cracked the Jun-19 sync bugs.

import * as Application from "expo-application";
import * as Clipboard from "expo-clipboard";
import Constants from "expo-constants";
import { useRouter } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import { DevSettings, Pressable, ScrollView, Share, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { ScreenHeader } from "../components/SettingsScreen";
import { useToast } from "../components/Toast";
import { colors } from "../lib/colors";
import { buildDiagnosticsReport } from "../lib/diagnostics-report";
import { fonts } from "../lib/fonts";
import { getAppMeta, resetAllLocalData } from "../lib/db";
import { getDb } from "../lib/db-tx";
import { getSyncDiagLines, onSyncDiag, clearSyncDiag } from "../lib/mesh/sync-diag";
import { isBtcSteadyRunning, isBtcPairPaused } from "../lib/mesh/btc-steady";
import {
  getLastExitReasons,
  getMemorySnapshot,
  type ProcessExitReason,
} from "../modules/kaata-gatt-server";

// Row shape for the memory-slope table (mem_samples).
type MemRow = {
  at: number;
  native_pss_kb: number | null;
  dalvik_pss_kb: number | null;
  native_alloc_kb: number | null;
  js_heap_kb: number | null;
  avail_mb: number | null;
  storage_free_mb: number | null;
};

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
  const [copyingReport, setCopyingReport] = useState(false);
  const [copied, setCopied] = useState(false);
  const [sharingReport, setSharingReport] = useState(false);
  // When the clipboard write fails (rare), we drop the report into a selectable
  // text block so the user can long-press → Select all → Copy by hand.
  const [fallbackText, setFallbackText] = useState<string | null>(null);
  const [exits, setExits] = useState<ProcessExitReason[]>([]);
  const [now, setNow] = useState<Record<string, unknown>>({});
  // Live sync state/log + memory-slope samples.
  const [samples, setSamples] = useState<MemRow[]>([]);
  const [syncLines, setSyncLines] = useState<string[]>([]);
  const [syncSnap, setSyncSnap] = useState<{ steady: boolean; paused: boolean; shop: string }>({
    steady: false,
    paused: false,
    shop: "?",
  });
  // DEV-only: two-tap arm→confirm for the destructive reset button below.
  const [resetArmed, setResetArmed] = useState(false);

  // Live Nearby-sync (BT steady) state + diag log.
  const refreshSync = useCallback(async () => {
    setSyncLines(getSyncDiagLines());
    let shop = "?";
    try {
      shop = (await getAppMeta("shop_mode_enabled")) ?? "0";
    } catch {
      /* */
    }
    setSyncSnap({ steady: isBtcSteadyRunning(), paused: isBtcPairPaused(), shop });
  }, []);

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
    // The memory-slope samples come from the mem-probe, which only runs while
    // the mesh sync loop is active.
    try {
      const db = await getDb();
      const rows = await db.getAllAsync<MemRow>(
        `SELECT at, native_pss_kb, dalvik_pss_kb, native_alloc_kb,
                js_heap_kb, avail_mb, storage_free_mb
           FROM mem_samples
          ORDER BY id DESC
          LIMIT 20`,
      );
      setSamples(rows);
    } catch {
      setSamples([]);
    }
  }, []);

  useEffect(() => {
    void load();
    void refreshSync();
  }, [load, refreshSync]);

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
      toast.push("Copied — now send it to us on WhatsApp", "success");
    } catch (err) {
      console.warn("[diagnostics] copy report failed", err);
      try {
        setFallbackText(await buildDiagnosticsReport());
      } catch {
        setFallbackText(null);
      }
      toast.push("Couldn’t auto-copy — copy the text below", "error");
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
      toast.push("Couldn’t open share", "error");
    } finally {
      setSharingReport(false);
    }
  }, [sharingReport, toast]);

  // Live-update the sync log — push-driven on each new line, plus a 2s poll
  // so the running/paused snapshot stays fresh while the user watches.
  useEffect(() => {
    const off = onSyncDiag(() => void refreshSync());
    const t = setInterval(() => void refreshSync(), 2000);
    return () => {
      off();
      clearInterval(t);
    };
  }, [refreshSync]);

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
  const buildNumber =
    Application.nativeBuildVersion ??
    (Constants.expoConfig?.android?.versionCode != null
      ? String(Constants.expoConfig.android.versionCode)
      : null);
  const jsBundleVersion = Constants.expoConfig?.version ?? null;

  return (
    <SafeAreaView style={styles.root} edges={["top", "bottom"]}>
      <ScreenHeader title="App health" onBack={() => router.back()} isRTL={false} />
      <ScrollView contentContainerStyle={styles.scroll}>
        <Text style={styles.hint}>
          Something not working? Tap Copy (or Share), then send this to us on WhatsApp so we can see
          what’s happening and fix it.
        </Text>
        <View style={styles.actionRow}>
          <Pressable
            style={[styles.copyReport, copyingReport && { opacity: 0.6 }]}
            onPress={onCopyReport}
            disabled={copyingReport}
          >
            <Text style={styles.copyReportText}>
              {copyingReport ? "Copying…" : copied ? "Copied ✓" : "Copy report"}
            </Text>
          </Pressable>
          <Pressable
            style={[styles.shareReport, sharingReport && { opacity: 0.6 }]}
            onPress={onShareReport}
            disabled={sharingReport}
          >
            <Text style={styles.shareReportText}>{sharingReport ? "…" : "Share"}</Text>
          </Pressable>
        </View>

        {fallbackText ? (
          <View style={styles.fallbackBox}>
            <Text style={styles.copyHint}>
              Long-press the text below → Select all → Copy, then send it to us.
            </Text>
            <Text style={styles.mono} selectable>
              {fallbackText}
            </Text>
          </View>
        ) : null}

        {/* ---- App version + build (moved here from Account) ---- */}
        <Text style={styles.section}>VERSION</Text>
        <Text style={styles.mono}>
          app {appVersion}
          {buildNumber ? ` · build ${buildNumber}` : ""}
        </Text>
        {jsBundleVersion && jsBundleVersion !== appVersion ? (
          <Text style={styles.warn}>
            ⚠ bundled JS {jsBundleVersion} ≠ native {appVersion} — running a stale build; reinstall
            the latest APK.
          </Text>
        ) : null}

        {/* ---- Nearby sync (BT steady) live state + log ---- */}
        <Text style={styles.section}>NEARBY SYNC — STATE</Text>
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

        <Text style={styles.section}>NEARBY SYNC — LOG (newest first)</Text>
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

        {/* ---- Last exit reasons ---- */}
        <Text style={styles.section}>WHY THE APP DIED (most recent first)</Text>
        {exits.length === 0 ? (
          <Text style={styles.muted}>
            No exit records (Android &lt; 11, or fresh install with no prior death).
          </Text>
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

        {/* ---- Current snapshot ---- */}
        <Text style={styles.section}>RIGHT NOW</Text>
        <Text style={styles.mono}>
          nativePss={mb(now.nativePssKb as number)} dalvikPss=
          {mb(now.dalvikPssKb as number)} js={mb(now.javaHeapUsedKb as number)}
        </Text>
        <Text style={styles.mono}>
          availMem={(now.systemAvailMemMb as number) ?? "—"}MB lowMem=
          {String(now.systemLowMemory ?? "—")} storageFree=
          {(now.storageFreeMb as number) ?? "—"}MB
        </Text>

        {/* ---- Memory slope (mem_samples ring) ----
            The mem-probe only samples while the mesh sync loop runs. */}
        <Text style={styles.section}>MEMORY SLOPE (last 20 min, newest first)</Text>
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

        <Pressable style={styles.refresh} onPress={() => void load()}>
          <Text style={styles.refreshText}>Refresh</Text>
        </Pressable>

        {__DEV__ ? (
          <>
            <Text style={styles.section}>DEV ONLY</Text>
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
    lineHeight: 18,
  },
  actionRow: { flexDirection: "row", alignItems: "center", gap: 10, marginBottom: 8 },
  copyReport: {
    paddingHorizontal: 18,
    paddingVertical: 10,
    borderRadius: 8,
    backgroundColor: colors.bgInverted,
  },
  copyReportText: { color: colors.textInverted, fontSize: 14, fontFamily: fonts.sansSemi },
  shareReport: {
    paddingHorizontal: 18,
    paddingVertical: 10,
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderDefault,
  },
  shareReportText: { color: colors.textDefault, fontSize: 14, fontFamily: fonts.sansSemi },
  fallbackBox: {
    marginBottom: 12,
    padding: 10,
    borderRadius: 8,
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
    fontStyle: "italic",
  },
  warn: {
    fontFamily: fonts.monoRegular,
    fontSize: 12,
    color: colors.danger,
    marginTop: 6,
    lineHeight: 17,
  },
  refreshGhost: {
    marginTop: 12,
    alignSelf: "flex-start",
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderDefault,
  },
  refreshGhostText: { color: colors.textMuted, fontSize: 13, fontFamily: fonts.sansSemi },
  refresh: {
    marginTop: 28,
    alignSelf: "flex-start",
    paddingHorizontal: 18,
    paddingVertical: 10,
    borderRadius: 8,
    backgroundColor: colors.bgInverted,
  },
  refreshText: { color: colors.textInverted, fontSize: 14, fontFamily: fonts.sansSemi },
  dangerBtn: {
    marginTop: 12,
    alignSelf: "flex-start",
    paddingHorizontal: 18,
    paddingVertical: 10,
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.danger,
  },
  dangerBtnArmed: { backgroundColor: colors.danger },
  dangerBtnText: { color: colors.danger, fontSize: 14, fontFamily: fonts.sansSemi },
  dangerBtnTextArmed: { color: colors.textInverted },
});
