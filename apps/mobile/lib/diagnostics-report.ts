// apps/mobile/lib/diagnostics-report.ts
//
// Assembles a single plain-text "App health" report the user can copy and send
// us — replacing the old "screenshot the diagnostics screen" flow. Shared by the
// Account screen's App-health Copy button and the /diagnostics screen.
//
// It includes BOTH the JS-bundle version (app.json, via expo-constants) AND the
// NATIVE version (the actual installed APK, via expo-application). If those two
// diverge it means the build shipped a stale JS bundle or a stale native binary
// — the exact failure mode that recently made fixes "do nothing" — so surfacing
// both turns an invisible problem into a one-line giveaway in the report.
//
// Every section is best-effort: a failure in one (e.g. the native memory module
// on a platform that lacks it) degrades to a "—" line and never throws, so the
// Copy button always produces something useful.

import * as Application from "expo-application";
import Constants from "expo-constants";
import { Platform } from "react-native";

import { MESH_PARKED } from "../constants/env";
import { getAppMeta } from "./db";
import { getActiveVaultIdSyncMaybe, getDb } from "./db-tx";
import { getLocale } from "./i18n";

function mb(kb: number | null | undefined): string {
  if (kb == null) return "—";
  return (kb / 1024).toFixed(1) + "MB";
}

function fmtTime(ms: number): string {
  try {
    const d = new Date(ms);
    const p = (n: number) => n.toString().padStart(2, "0");
    return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  } catch {
    return String(ms);
  }
}

// The JS-bundle (app.json) version + build, as embedded by Metro.
export function jsVersionLabel(): { version: string; build: string } {
  return {
    version: Constants.expoConfig?.version ?? "?",
    build:
      Constants.expoConfig?.android?.versionCode != null
        ? String(Constants.expoConfig.android.versionCode)
        : "?",
  };
}

// The NATIVE (installed APK) version + build. This is the truth about what's
// actually running on the device, independent of the JS bundle.
export function nativeVersionLabel(): { version: string; build: string } {
  return {
    version: Application.nativeApplicationVersion ?? "?",
    build: Application.nativeBuildVersion ?? "?",
  };
}

export async function buildDiagnosticsReport(): Promise<string> {
  const lines: string[] = [];
  const push = (s: string) => lines.push(s);

  push("Kaata — App health");

  // --- Versions: JS bundle vs native APK (divergence = stale build) ---
  const js = jsVersionLabel();
  const nat = nativeVersionLabel();
  push(`App (native): ${nat.version} (build ${nat.build})`);
  push(`App (JS bundle): ${js.version} (build ${js.build})`);
  const versionMismatch =
    (nat.version !== "?" && js.version !== "?" && nat.version !== js.version) ||
    (nat.build !== "?" && js.build !== "?" && nat.build !== js.build);
  if (versionMismatch) {
    push("⚠ native/JS version mismatch — likely a stale build (rebuild from clean)");
  }

  // --- Platform ---
  push(`Platform: ${Platform.OS} ${String(Platform.Version)}`);

  // --- App state ---
  try {
    const accountId = await getAppMeta("account_id");
    push(`Signed in: ${accountId ? "yes" : "no"}`);
  } catch {
    push("Signed in: —");
  }
  try {
    const vid = getActiveVaultIdSyncMaybe();
    push(`Active kaata: ${vid ? vid.slice(0, 8) : "none"}`);
  } catch {
    push("Active kaata: —");
  }
  try {
    const pref = (await getAppMeta("locale_pref")) ?? "system";
    push(`Locale: ${getLocale()} (pref ${pref})`);
  } catch {
    push(`Locale: ${getLocale()}`);
  }
  push(`Nearby sync: ${MESH_PARKED ? "parked" : "enabled"}`);

  // --- Memory right now + why it died (native module; best-effort) ---
  try {
    const { getMemorySnapshot, getLastExitReasons } = await import("../modules/kaata-gatt-server");
    try {
      const now = getMemorySnapshot() as Record<string, unknown>;
      push(
        `Memory now: nativePss=${mb(now.nativePssKb as number)} dalvikPss=${mb(now.dalvikPssKb as number)} js=${mb(now.javaHeapUsedKb as number)} avail=${(now.systemAvailMemMb as number) ?? "—"}MB storageFree=${(now.storageFreeMb as number) ?? "—"}MB lowMem=${String(now.systemLowMemory ?? "—")}`,
      );
    } catch {
      push("Memory now: —");
    }
    try {
      const exits = getLastExitReasons();
      if (exits.length === 0) {
        push("Recent exits: none recorded");
      } else {
        push("Recent exits (newest first):");
        for (const e of exits.slice(0, 5)) {
          push(`  ${fmtTime(e.timestamp)} ${e.reasonName} rss=${mb(e.rssKb)} imp=${e.importance}`);
        }
      }
    } catch {
      push("Recent exits: —");
    }
  } catch {
    push("Memory / exits: native module unavailable");
  }

  // --- Memory slope (last 10 samples) ---
  try {
    const db = await getDb();
    const rows = await db.getAllAsync<{
      at: number;
      native_pss_kb: number | null;
      dalvik_pss_kb: number | null;
      js_heap_kb: number | null;
      avail_mb: number | null;
      storage_free_mb: number | null;
    }>(
      `SELECT at, native_pss_kb, dalvik_pss_kb, js_heap_kb, avail_mb, storage_free_mb
         FROM mem_samples ORDER BY id DESC LIMIT 10`,
    );
    if (rows.length > 0) {
      push("Memory slope (newest first): time nativePss dalvikPss js avail store");
      for (const s of rows) {
        push(
          `  ${fmtTime(s.at).slice(6)} ${mb(s.native_pss_kb)} ${mb(s.dalvik_pss_kb)} ${mb(s.js_heap_kb)} ${s.avail_mb ?? "—"}MB ${s.storage_free_mb ?? "—"}MB`,
        );
      }
    }
  } catch {
    /* no samples table / not android — fine, omit the slope */
  }

  push(`Generated: ${fmtTime(Date.now())}`);
  return lines.join("\n");
}
