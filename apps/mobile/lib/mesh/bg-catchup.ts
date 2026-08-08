// apps/mobile/lib/mesh/bg-catchup.ts
//
// #43 P2 — bounded background mesh catch-up, run in the headless background entry:
// Phase 1 (expo-background-task, ~15min periodic) and Phase 2 (HeadlessJS spawned
// by the FGS) both call runBackgroundCatchup().
//
// VM REALITY: the headless task runs in a SEPARATE Hermes VM only when the
// process was fully killed first. When the process survived swipe-kill (the
// common case while an FGS held it), the headless task REUSES the app's
// singleton React context + the same getDb() connection.
//
// This is NOT architecture-specific — it was written under the legacy
// architecture but bridgeless ReactHost is also one instance per process, so
// the shared-VM case persists unchanged under the New Architecture. The guards
// below are correct for BOTH cases either way: the per-connection PRAGMAs are
// an idempotent re-apply on a shared connection, and we never call initDb (the
// schema-guard + "only the foreground boot migrates" is the protection — see
// db.ts initDb).
//
// Defense-in-depth crypto-polyfill ordering (the headless ReactContext re-enters
// this bundle): import the polyfills first; @noble/* capture globalThis.crypto
// eagerly at load.
import "./_crypto-polyfill";
import "./_ed25519-setup";

import { Platform } from "react-native";

import { isForegroundMeshAlive, markBgMeshWindowOk } from "../../modules/kaata-bt-classic";
import { getAppMeta } from "../db";
import {
  getDb,
  primeActiveVaultId,
  refreshAccountIdCache,
  refreshLocalSelfUserIdCache,
  setInstallIdCache,
} from "../db-tx";
import { ensureInstallId } from "../install-id";

// The schema must be at this migration before the headless path runs the mesh.
// Absent => this install isn't fully migrated yet — bail (NEVER run initDb from
// here). Bump when a new migration becomes a hard mesh prerequisite.
const REQUIRED_MIGRATION = "019_vault_device_registry";

export type CatchupResult = "ran" | "skipped";

/**
 * One bounded background sync window. Fail-closed + data-safe:
 *  - PRAGMA busy_timeout + foreign_keys on the connection (a freshly-opened VM's
 *    connection defaults busy_timeout=0; idempotent re-apply when sharing the
 *    foreground connection). WAL is a persistent DB property, inherited either way.
 *  - schema-guard (never migrate from here).
 *  - re-check the kill-switch + shop-mode.
 *  - single-mesh: bail if a foreground mesh is alive (cross-VM heartbeat, NOT
 *    AppState — AppState is per-context), and bail mid-window if it comes alive.
 *  - prime the per-VM sync caches or the event-log hot path throws.
 * A clean exit (any "skipped" or "ran") CLEARS the crash-loop breaker. The
 * native service that used to increment it before spawning (and the only code
 * here that touched React Native internals) was deleted with the mesh cleanup
 * on 2026-08-08, so nothing increments the breaker today and the clears are
 * harmless no-ops.
 */
export async function runBackgroundCatchup(maxMs: number): Promise<CatchupResult> {
  if (Platform.OS !== "android") return "skipped";

  // Single-mesh guard: never run while a FOREGROUND mesh owns the radio + DB.
  if (await isForegroundMeshAlive()) {
    await markBgMeshWindowOk();
    return "skipped";
  }

  const db = await getDb();
  // Per-connection pragmas (idempotent; the freshly-opened-VM case defaults to 0).
  await db.execAsync("PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;");

  // Schema-guard: only proceed on a fully-migrated DB; never migrate from headless.
  const migrated = await db.getFirstAsync<{ n: number }>(
    "SELECT 1 AS n FROM schema_migrations WHERE name = ? LIMIT 1",
    REQUIRED_MIGRATION,
  );
  if (migrated == null) {
    await markBgMeshWindowOk();
    return "skipped";
  }

  // Kill-switch + sync-enabled re-check (JS side; the native gate already passed).
  const [bgOn, shopOn] = await Promise.all([
    getAppMeta("bg_mesh_enabled"),
    getAppMeta("shop_mode_enabled"),
  ]);
  if (bgOn !== "1" || shopOn !== "1") {
    await markBgMeshWindowOk();
    return "skipped";
  }

  // Prime the per-VM sync caches (installId / activeVault / account / localSelf) —
  // the event-log + projection hot path reads these SYNCHRONOUSLY and THROWS when
  // unprimed. A throw here is a REAL failure: it propagates (the caller swallows it)
  // and the breaker stays incremented, NOT cleared.
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
  if (anchored.length === 0) {
    await markBgMeshWindowOk();
    return "skipped";
  }

  // Bounded BT steady sync: open listeners + dial known peers + anti-entropy, then
  // tear down. Reuses the proven steady machinery for one short window.
  const { startBtcSteadySync, stopBtcSteadySync } = await import("./btc-steady");
  try {
    await startBtcSteadySync({ vaultIds: anchored });
    const deadline = Date.now() + maxMs;
    while (Date.now() < deadline) {
      // Hand the radio back the instant a foreground mesh comes alive (the user
      // reopened the app). Poll fast so the foreground listener bind isn't blocked.
      if (await isForegroundMeshAlive()) break;
      await new Promise((r) => setTimeout(r, 250));
    }
  } finally {
    await stopBtcSteadySync();
  }
  await markBgMeshWindowOk();
  return "ran";
}
