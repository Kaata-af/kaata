// apps/mobile/lib/mesh/mem-probe.ts
//
// Mythos crash-diagnosis instrumentation. A 60-second memory/storage
// sampler that runs ONLY while shop mode is on, writing into the capped
// mem_samples ring table (migration 016). The Diagnostics screen renders
// the slope as plain text the user can screenshot — no adb.
//
// The point: rising native_pss_kb convicts BLE/WebRTC native allocation;
// rising dalvik_pss_kb convicts JS/Java retention; collapsing
// storage_free_mb means the Samsung "Clear cache" prompt was a STORAGE
// warning, not RAM. Combined with getLastExitReasons() (the death verdict),
// this replaces three rounds of crash-by-inference with a measurement.

import { getDb } from "../db-tx";
import { getMemorySnapshot } from "../../modules/kaata-gatt-server";

const SAMPLE_INTERVAL_MS = 60_000;
// ~4 hours of history at 60s cadence. The Diagnostics screen only needs
// the last ~15, but keeping a few hours lets a slow leak show its slope.
const RING_CAP = 240;

let timer: ReturnType<typeof setInterval> | null = null;

async function sampleOnce(): Promise<void> {
  try {
    const s = getMemorySnapshot();
    // Off-Android (or native call failed) → empty object → skip.
    if (s.nativePssKb == null && s.dalvikPssKb == null) return;
    const db = await getDb();
    await db.runAsync(
      `INSERT INTO mem_samples
         (at, native_pss_kb, dalvik_pss_kb, native_alloc_kb, js_heap_kb, avail_mb, storage_free_mb)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      Date.now(),
      s.nativePssKb ?? null,
      s.dalvikPssKb ?? null,
      s.nativeHeapAllocKb ?? null,
      s.javaHeapUsedKb ?? null,
      s.systemAvailMemMb ?? null,
      s.storageFreeMb ?? null,
    );
    // Cap the ring — delete everything but the newest RING_CAP rows.
    await db.runAsync(
      `DELETE FROM mem_samples
        WHERE id NOT IN (SELECT id FROM mem_samples ORDER BY id DESC LIMIT ?)`,
      RING_CAP,
    );
  } catch {
    // Never let the probe affect the app — diagnostics are best-effort.
  }
}

/** Start the per-minute sampler. Idempotent. Called from startShopModeBody. */
export function startMemProbe(): void {
  if (timer) return;
  // Take an immediate baseline sample so the first crash window has a
  // start point even if the app dies before the first 60s tick.
  void sampleOnce();
  timer = setInterval(() => void sampleOnce(), SAMPLE_INTERVAL_MS);
}

/** Stop the sampler. Idempotent. Called from teardownRadios. */
export function stopMemProbe(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
