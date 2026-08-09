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
import { getBackendUrl } from "./api";
import { isSignedIn } from "./auth";
import { getAppMeta } from "./db";
import { getActiveVaultIdSyncMaybe, getDb } from "./db-tx";
import { getLocale } from "./i18n";
import { getSyncIndicator } from "./sync/cursor";
import { getLastSyncError } from "./sync/last-error";

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
//
// The build number MUST be read per-platform. Android's `versionCode` and iOS's
// `buildNumber` are independent counters over the same release — 1.0.7 shipped
// as versionCode 33 and buildNumber 13 — so reading `android.versionCode`
// unconditionally made every iOS install report a native/JS mismatch (native
// buildNumber 13 vs "JS" 33). That was worse than cosmetic: the stale-build
// warning fired constantly on iOS, which both alarmed users and guaranteed a
// REAL stale iOS bundle would be lost in the noise.
export function jsVersionLabel(): { version: string; build: string } {
  const cfg = Constants.expoConfig;
  const build =
    Platform.OS === "ios"
      ? (cfg?.ios?.buildNumber ?? null)
      : cfg?.android?.versionCode != null
        ? String(cfg.android.versionCode)
        : null;
  return {
    version: cfg?.version ?? "?",
    build: build != null ? String(build) : "?",
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
  const section = (title: string) => {
    push("");
    push(title);
  };
  const fmtMaybe = (ms: number | null | undefined): string => (ms ? fmtTime(ms) : "never");

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
  // What the server says is the latest available — if it's ahead of the native
  // build, the user is on an old APK (the "fixes did nothing" confound).
  try {
    const latest = await getAppMeta("latest_known_version");
    if (latest && latest !== nat.version) {
      push(`Latest available (server): ${latest} — this build may be outdated`);
    }
  } catch {
    /* omit */
  }

  // --- Platform + applied schema (a low schema name = stale build / failed migration) ---
  push(`Platform: ${Platform.OS} ${String(Platform.Version)}`);
  try {
    const db = await getDb();
    const top = await db.getFirstAsync<{ name: string }>(
      "SELECT name FROM schema_migrations ORDER BY name DESC LIMIT 1",
    );
    const cnt = await db.getFirstAsync<{ c: number }>(
      "SELECT COUNT(*) AS c FROM schema_migrations",
    );
    push(`Schema: ${top?.name ?? "—"} (${cnt?.c ?? 0} applied)`);
  } catch {
    push("Schema: —");
  }

  // --- Account / backup wiring ---
  // install_id is the join key to back-end telemetry + crash_reports; account_id
  // is the opaque cloud-account id (NOT email / Google sub). "Live session" is a
  // boolean derived from the JWT presence — the JWT itself is never included.
  section("Account / backup");
  let accountId: string | null = null;
  try {
    accountId = (await getAppMeta("account_id")) || null;
    push(`Account: ${accountId ?? "local-only"}`);
  } catch {
    push("Account: —");
  }
  try {
    push(`Live session: ${(await isSignedIn()) ? "yes" : "no"}`);
  } catch {
    push("Live session: —");
  }
  try {
    push(`Install: ${(await getAppMeta("install_id")) ?? "—"}`);
  } catch {
    push("Install: —");
  }
  try {
    push(`Backend: ${await getBackendUrl()}`);
  } catch {
    push("Backend: —");
  }
  try {
    const last = await getAppMeta("last_checkin_at");
    push(`Last check-in: ${fmtMaybe(last ? Number(last) : null)}`);
  } catch {
    push("Last check-in: —");
  }
  try {
    const inst = await getAppMeta("installed_at_unix_ms");
    if (inst) {
      const days = Math.floor((Date.now() - Number(inst)) / 86_400_000);
      push(`Installed: ${fmtTime(Number(inst))} (~${days}d ago)`);
    }
  } catch {
    /* omit */
  }
  try {
    const pref = (await getAppMeta("locale_pref")) ?? "system";
    push(`Locale: ${getLocale()} (pref ${pref})`);
  } catch {
    push(`Locale: ${getLocale()}`);
  }
  push(`Nearby sync: ${MESH_PARKED ? "parked" : "enabled"}`);

  // --- Sync / vault state (the "is this device actually backing up" block) ---
  section("Sync");
  const vaultId = (() => {
    try {
      return getActiveVaultIdSyncMaybe();
    } catch {
      return null;
    }
  })();
  push(`Active kaata: ${vaultId ? vaultId.slice(0, 8) : "none"}`);
  // Per-vault server registration. A NULL registered_with_server_at on an owned
  // vault is the silent-403 root cause of reinstall data loss.
  try {
    const db = await getDb();
    const vaults = await db.getAllAsync<{ id: string; registered_with_server_at: number | null }>(
      "SELECT id, registered_with_server_at FROM vaults WHERE archived_at IS NULL",
    );
    if (vaults.length > 0) {
      push(
        "Vaults: " +
          vaults
            .map(
              (v) =>
                `${v.id.slice(0, 8)}${v.id === vaultId ? "*" : ""}=${v.registered_with_server_at ? "reg" : "UNREG"}`,
            )
            .join(" "),
      );
    }
  } catch {
    /* omit */
  }
  if (vaultId) {
    try {
      const ind = await getSyncIndicator(vaultId);
      push(
        `Sync: push=${fmtMaybe(ind.lastPushAt?.getTime())} pull=${fmtMaybe(ind.lastPullAt?.getTime())} seq=${ind.lastPulledServerSeq}`,
      );
    } catch {
      push("Sync: —");
    }
    try {
      const db = await getDb();
      const unsent = await db.getFirstAsync<{ c: number }>(
        "SELECT COUNT(*) AS c FROM event_log WHERE vault_id = ? AND server_acked_at IS NULL AND rejected_at IS NULL",
        vaultId,
      );
      const rejected = await db.getFirstAsync<{ c: number }>(
        "SELECT COUNT(*) AS c FROM event_log WHERE vault_id = ? AND rejected_at IS NOT NULL",
        vaultId,
      );
      push(`Unsent events: ${unsent?.c ?? "—"}  ·  Rejected: ${rejected?.c ?? "—"}`);
    } catch {
      push("Unsent/rejected events: —");
    }
  }
  // Orphan events with no vault can never push — surface only when present.
  try {
    const db = await getDb();
    const orphan = await db.getFirstAsync<{ c: number }>(
      "SELECT COUNT(*) AS c FROM event_log WHERE vault_id IS NULL",
    );
    if ((orphan?.c ?? 0) > 0) {
      push(`⚠ Unassigned events: ${orphan?.c} (cannot back up)`);
    }
  } catch {
    /* omit */
  }
  try {
    const le = await getLastSyncError();
    if (le) {
      push(`Last sync error: ${le.name} @ ${fmtTime(le.at)}`);
      if (le.message && le.message !== le.name) push(`  ${le.message}`);
    } else {
      push("Last sync error: none");
    }
  } catch {
    /* omit */
  }
  if (accountId) {
    try {
      if (await getAppMeta(`restore_skipped_for_account_${accountId}`)) {
        push("Restore skipped by user: yes");
      }
    } catch {
      /* omit */
    }
  }

  // --- Ledger size (counts only — never names / phones / amounts / notes) ---
  section("Ledger");
  try {
    if (vaultId) {
      const db = await getDb();
      const people = await db.getFirstAsync<{ c: number }>(
        "SELECT COUNT(DISTINCT user_b_id) AS c FROM relationships WHERE vault_id = ? AND archived_at IS NULL",
        vaultId,
      );
      const entries = await db.getFirstAsync<{ c: number }>(
        "SELECT COUNT(*) AS c FROM entries WHERE vault_id = ? AND deleted_at IS NULL",
        vaultId,
      );
      const kaatas = await db.getFirstAsync<{ c: number }>(
        "SELECT COUNT(*) AS c FROM vaults WHERE archived_at IS NULL",
      );
      push(`people=${people?.c ?? "—"} entries=${entries?.c ?? "—"} kaatas=${kaatas?.c ?? "—"}`);
    } else {
      push("people=0 entries=0 (no active kaata)");
    }
  } catch {
    push("Ledger: —");
  }

  // --- Database health: integrity + the local backup safety net ---
  // Surfaced so a corrupt DB or a silently-failing backup is visible from the
  // App health screen rather than only at the moment it ruins someone's day.
  section("Database");
  try {
    const db = await getDb();
    const sync = await db.getFirstAsync<{ v: number }>("PRAGMA synchronous");
    const journal = await db.getFirstAsync<{ journal_mode: string }>("PRAGMA journal_mode");
    push(
      `journal=${journal?.journal_mode ?? "—"} synchronous=${sync ? Object.values(sync)[0] : "—"}`,
    );
    const { probeDatabaseIntegrity } = await import("./db-health");
    push(`Integrity: ${(await probeDatabaseIntegrity(db)) ?? "check failed"}`);
  } catch {
    push("Database: —");
  }
  try {
    const { listLocalBackups } = await import("./db-backup");
    const backups = listLocalBackups();
    if (backups.length === 0) {
      push("Local backups: none yet");
    } else {
      for (const b of backups) {
        // MILLISECONDS. The new expo-file-system File API reports epoch ms;
        // only the legacy getInfoAsync returned seconds. Multiplying by 1000
        // here dated every backup to the year ~50,000.
        const when = b.modifiedAt ? fmtTime(b.modifiedAt) : "—";
        const mb = b.size != null ? (b.size / (1024 * 1024)).toFixed(1) + "MB" : "—";
        push(`Backup ${b.name}: ${when} (${mb})`);
      }
    }
  } catch {
    push("Local backups: —");
  }

  // --- Memory right now + why it died (ANDROID ONLY; native module) ---
  //
  // Skipped entirely off Android. modules/kaata-gatt-server is
  // platforms: ["android"] — ApplicationExitInfo and Debug.MemoryInfo have no
  // iOS equivalent, and its JS wrappers early-return {} and [] there. Emitting
  // the section anyway put "Memory now: nativePss=— dalvikPss=— …" and "Recent
  // exits: none recorded" into every report a shopkeeper sends us from an
  // iPhone: pure noise in the one artifact support actually reads, and it looks
  // like a failure rather than an inapplicable probe.
  if (Platform.OS === "android") {
    section("Memory");
    try {
      const { getMemorySnapshot, getLastExitReasons } =
        await import("../modules/kaata-gatt-server");
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
            push(
              `  ${fmtTime(e.timestamp)} ${e.reasonName} rss=${mb(e.rssKb)} imp=${e.importance}`,
            );
          }
        }
      } catch {
        push("Recent exits: —");
      }
    } catch {
      push("Memory / exits: native module unavailable");
    }
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

  push("");
  push(`Generated: ${fmtTime(Date.now())}`);
  return lines.join("\n");
}
