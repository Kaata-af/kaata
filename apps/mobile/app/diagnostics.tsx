// apps/mobile/app/diagnostics.tsx
//
// Mythos crash-diagnosis screen. Renders, as plain screenshot-able text:
//   1. WHY the previous process(es) died — ApplicationExitInfo verdict
//      (LOW_MEMORY = OOM/LMK kill, NATIVE_CRASH = Hermes abort, etc.) plus
//      the RSS at death.
//   2. The last ~20 per-minute memory samples — native_pss vs dalvik_pss
//      slope over the crash window, plus storage_free.
//
// This replaces "adb logcat + dumpsys meminfo" with a screen the user
// screenshots after a crash. Reachable from the menu (a hidden/diagnostic
// nav row) or directly at /diagnostics.

import { useRouter } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { ScreenHeader } from "../components/SettingsScreen";
import { colors } from "../lib/colors";
import { fonts } from "../lib/fonts";
import { getDb } from "../lib/db-tx";
import { getAppMeta } from "../lib/db";
import { getSyncDiagLines, onSyncDiag, clearSyncDiag } from "../lib/mesh/sync-diag";
import { isBtcSteadyRunning, isBtcPairPaused } from "../lib/mesh/btc-steady";
import {
  getLastExitReasons,
  getMemorySnapshot,
  type ProcessExitReason,
} from "../modules/kaata-gatt-server";

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
  const [exits, setExits] = useState<ProcessExitReason[]>([]);
  const [samples, setSamples] = useState<MemRow[]>([]);
  const [now, setNow] = useState<Record<string, unknown>>({});
  const [syncLines, setSyncLines] = useState<string[]>([]);
  const [syncSnap, setSyncSnap] = useState<{ steady: boolean; paused: boolean; shop: string }>({
    steady: false,
    paused: false,
    shop: "?",
  });

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
    void refreshSync();
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
  }, [load]);

  // Live-update the sync log: push-driven on each new line, plus a 2s poll so the
  // running/paused snapshot stays fresh while the user watches.
  useEffect(() => {
    const off = onSyncDiag(() => void refreshSync());
    const t = setInterval(() => void refreshSync(), 2000);
    return () => {
      off();
      clearInterval(t);
    };
  }, [refreshSync]);

  return (
    <SafeAreaView style={styles.root} edges={["top", "bottom"]}>
      <ScreenHeader title="Diagnostics" onBack={() => router.back()} isRTL={false} />
      <ScrollView contentContainerStyle={styles.scroll}>
        <Text style={styles.hint}>
          Screenshot this after a crash and send it. The top block says WHY the app died last time;
          the table is the memory slope while sync was on.
        </Text>

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

        {/* ---- Memory slope ---- */}
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
    marginBottom: 20,
    lineHeight: 18,
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
});
