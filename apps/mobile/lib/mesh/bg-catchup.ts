// apps/mobile/lib/mesh/bg-catchup.ts
//
// #43 P2 — bounded background mesh catch-up, run in a HEADLESS JS context (a 2nd
// Hermes VM with no Activity): Phase 1 (expo-background-task, ~15min periodic) and
// Phase 2 (continuous HeadlessJS under the FGS) both call runBackgroundCatchup().
//
// Defense-in-depth crypto-polyfill ordering: the headless context loads the same
// bundle as the app (index.js imports the polyfills first), but we import them
// here too so this module is safe to import from any entry order. @noble/* capture
// globalThis.crypto eagerly at load, so the polyfill MUST precede any of them.
import "./_crypto-polyfill";
import "./_ed25519-setup";

import { Platform } from "react-native";

import { isForegroundMeshAlive, markBgMeshWindowOk } from "../../modules/kaata-bt-classic";
import { getAppMeta, markHeadlessMode } from "../db";
import {
  getDb,
  primeActiveVaultId,
  refreshAccountIdCache,
  refreshLocalSelfUserIdCache,
  setInstallIdCache,
} from "../db-tx";
import { ensureInstallId } from "../install-id";

// The schema must be at this migration before the headless path runs the mesh.
// If absent, the DB isn't fully migrated on THIS install yet — bail (NEVER run
// initDb from headless; see markHeadlessMode + the initDb guard in db.ts). Bump
// this when a NEW migration becomes a hard prerequisite for the mesh.
const REQUIRED_MIGRATION = "019_vault_device_registry";

export type CatchupResult = "ran" | "skipped";

/**
 * One bounded background sync window. Fail-closed + data-safe in a 2nd JS VM:
 *  - markHeadlessMode() so a stray initDb call throws instead of double-migrating.
 *  - PRAGMA busy_timeout + foreign_keys on THIS connection (a fresh VM's
 *    connection defaults busy_timeout=0; WAL is a persistent DB property so it's
 *    inherited, but busy_timeout/foreign_keys are per-connection). Without the
 *    timeout, any contention with another writer is an instant SQLITE_BUSY.
 *  - schema-guard (never migrate from here).
 *  - re-check the kill-switch + shop-mode (the native gate already passed).
 *  - bail if the foreground app is active (single-mesh: never two meshes on the
 *    one BT radio), and bail mid-window if it becomes active.
 *  - prime the per-VM sync caches or the event-log hot path throws.
 * Returns "skipped" on any guard miss (caller treats that as a clean no-op, NOT a
 * crash-loop-breaker failure). Throws only on a genuine unexpected error.
 */
export async function runBackgroundCatchup(maxMs: number): Promise<CatchupResult> {
  if (Platform.OS !== "android") return "skipped";
  // Single-mesh guard: never run while the FOREGROUND JS mesh is alive (it owns
  // the radio + DB). Uses the cross-VM heartbeat, NOT AppState — a headless VM's
  // AppState is always "background", so it can't see the foreground app.
  if (await isForegroundMeshAlive()) return "skipped";

  // A stray initDb from here must fail loudly, not double-migrate the 2nd connection.
  markHeadlessMode();

  const db = await getDb();
  // Per-connection pragmas (initDb set these only on the foreground connection).
  await db.execAsync("PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;");

  // Schema-guard: only proceed on a fully-migrated DB; never migrate from headless.
  const migrated = await db.getFirstAsync<{ n: number }>(
    "SELECT 1 AS n FROM schema_migrations WHERE name = ? LIMIT 1",
    REQUIRED_MIGRATION,
  );
  if (migrated == null) return "skipped";

  // Kill-switch + sync-enabled re-check (JS side; native KaataBgMeshGate already
  // gated the spawn, but defense in depth + the JS flag governs the JS path).
  const [bgOn, shopOn] = await Promise.all([
    getAppMeta("bg_mesh_enabled"),
    getAppMeta("shop_mode_enabled"),
  ]);
  if (bgOn !== "1" || shopOn !== "1") return "skipped";

  // Prime the per-VM sync caches (installId / activeVault / account / localSelf).
  // The event-log + projection hot path reads these SYNCHRONOUSLY and THROWS when
  // unprimed (getInstallIdSync, getActiveVaultIdSync) — a fresh VM has them all
  // null, so without this the first mesh write throws.
  const id = await ensureInstallId();
  setInstallIdCache(id);
  await primeActiveVaultId();
  await refreshAccountIdCache();
  await refreshLocalSelfUserIdCache();

  // Anchored (mesh-eligible) vaults only — same gate as startShopMode.
  const anchored = (
    await db.getAllAsync<{ id: string }>(
      "SELECT id FROM vaults WHERE archived_at IS NULL AND vault_trust_anchor_pubkey IS NOT NULL",
    )
  ).map((v) => v.id);
  if (anchored.length === 0) return "skipped";

  // Bounded BT steady sync: open listeners + dial known peers + anti-entropy, then
  // tear down. Reuses the proven steady machinery (dial gate runs because
  // steadyRunning is set) for a single short window instead of persistently.
  const { startBtcSteadySync, stopBtcSteadySync } = await import("./btc-steady");
  try {
    await startBtcSteadySync({ vaultIds: anchored });
    const deadline = Date.now() + maxMs;
    while (Date.now() < deadline) {
      // Hand the radio back the instant the foreground mesh comes alive (the user
      // reopened the app) — re-check the cross-VM heartbeat, not AppState.
      if (await isForegroundMeshAlive()) break;
      await new Promise((r) => setTimeout(r, 1000));
    }
  } finally {
    await stopBtcSteadySync();
  }
  // Clean window — clear the crash-loop breaker (native incremented it before the
  // spawn in Phase 2; harmless no-op in Phase 1 where it wasn't incremented).
  await markBgMeshWindowOk();
  return "ran";
}
