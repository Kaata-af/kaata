// apps/mobile/lib/crash-report.ts
//
// Mythos crash-reporter. The mobile half of "get crash logs into the
// backend DB so we never fight adb again."
//
// Two responsibilities:
//   1. queueCrashReport(...) — durably append a diagnostic item to the
//      crash_outbox SQLite table (migration 017). Called from the boot
//      pipeline, the mesh failure bridge, and the sync scheduler. Durable
//      because the row is committed BEFORE the process can die — an
//      in-memory queue would lose exactly the reports we most want.
//   2. flushCrashReports(installId) — POST the unflushed batch to the
//      backend /v1/crash-reports, mark rows flushed on success. Called
//      from BackgroundCheckIn (which already gates on connectivity).
//
// Plus queueExitInfoAndSamples() — on boot, read the OS's verdict for the
// PREVIOUS process death (ApplicationExitInfo) and, if it wasn't a clean
// user-requested exit, queue the verdict + the trailing memory samples so
// the backend sees the slope leading to the death.
//
// PII boundary (matches check-in): install_id, app_version, platform, an
// error name/kind/stage, a TRUNCATED message, timestamps, and two numeric
// memory fields. NEVER a customer name, phone, balance, or ledger payload.
// We deliberately do NOT include stack traces — boot-error.ts established
// that error messages can carry user-typed strings, so we cap message
// length and never attach a stack.

import * as Application from "expo-application";

import { getDb } from "./db-tx";
import { getAppMeta, setAppMeta } from "./db";
import { getBackendUrl } from "./api";
import { getSessionJWT } from "./auth";
import { getLastExitReasons } from "../modules/kaata-gatt-server";

// Matches the app_version stamped on /v1/check-in (app/_layout.tsx).
const APP_VERSION = Application.nativeApplicationVersion || "0.1.0";

export type CrashKind = "boot" | "mesh" | "sync" | "exit" | "memsample" | "js" | "native";

const MESSAGE_CAP = 500;
const FLUSH_BATCH = 50;
const FLUSH_TIMEOUT_MS = 5_000;
// Ring-cap the outbox. queueCrashReport is fed by every failed boot step, every
// unexpected sync-scheduler tick, and 20 memsample rows per abnormal exit, while
// the DELETE only prunes rows that have flushed — so on a device where
// /v1/crash-reports keeps failing (endpoint down, blocked host, long-offline)
// the table grew without bound and bloated storage on the 8-16GB target devices.
// Keep only the newest rows (like mem_samples=240 / sync-diag=120).
const OUTBOX_CAP = 500;

type QueueArgs = {
  kind: CrashKind;
  stage?: string | null;
  name?: string | null;
  message: string;
  rssKb?: number | null;
  auxKb?: number | null;
  createdAtMs?: number;
};

/**
 * Durably append one diagnostic item. Never throws — crash reporting must
 * never itself cause a crash.
 */
export async function queueCrashReport(args: QueueArgs): Promise<void> {
  try {
    const db = await getDb();
    const msg = (args.message ?? "").slice(0, MESSAGE_CAP);
    await db.runAsync(
      `INSERT INTO crash_outbox (kind, stage, name, message, rss_kb, aux_kb, app_version, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      args.kind,
      args.stage ?? null,
      args.name ?? null,
      msg,
      args.rssKb ?? null,
      args.auxKb ?? null,
      APP_VERSION,
      args.createdAtMs ?? Date.now(),
    );
    // Drop the oldest rows beyond the cap so a device that can never flush
    // doesn't accumulate outbox rows forever. rowid is monotonic with insertion.
    await db.runAsync(
      `DELETE FROM crash_outbox
        WHERE rowid NOT IN (SELECT rowid FROM crash_outbox ORDER BY rowid DESC LIMIT ?)`,
      OUTBOX_CAP,
    );
  } catch {
    /* swallow — diagnostics are best-effort */
  }
}

/**
 * On boot: ask the OS why the PREVIOUS process died and queue the verdict
 * if it wasn't a clean user-requested exit. Also queues the trailing
 * memory samples (the slope into the death). Idempotent across launches
 * via the lastExitTimestamp marker so a verdict is queued at most once.
 */
export async function queueExitInfoAndSamples(): Promise<void> {
  try {
    const exits = getLastExitReasons();
    if (exits.length === 0) return;
    const db = await getDb();

    // De-dup: only queue verdicts newer than the last one we recorded.
    const marker = await getAppMeta("last_exit_reported_ts");
    const lastReportedTs = marker ? Number(marker) || 0 : 0;

    const fresh = exits
      .filter((e) => e.timestamp > lastReportedTs)
      // USER_REQUESTED = clean exit (swipe-away). Not interesting.
      .filter((e) => e.reasonName !== "USER_REQUESTED");

    if (fresh.length === 0) {
      // Still advance the marker to the newest seen so we don't re-scan.
      const newest = exits.reduce((m, e) => Math.max(m, e.timestamp), lastReportedTs);
      await setAppMeta("last_exit_reported_ts", String(newest));
      return;
    }

    for (const e of fresh) {
      await queueCrashReport({
        kind: "exit",
        name: e.reasonName,
        message: e.description || e.reasonName,
        rssKb: e.rssKb ?? null,
        auxKb: e.pssKb ?? null,
        createdAtMs: e.timestamp,
      });
    }

    // Attach the trailing memory slope (last 20 samples) so the backend
    // can see what the memory was doing in the minutes before the death.
    try {
      const samples = await db.getAllAsync<{
        at: number;
        native_pss_kb: number | null;
        dalvik_pss_kb: number | null;
      }>(
        `SELECT at, native_pss_kb, dalvik_pss_kb
           FROM mem_samples ORDER BY id DESC LIMIT 20`,
      );
      for (const s of samples) {
        await queueCrashReport({
          kind: "memsample",
          name: "mem",
          message: "",
          rssKb: s.native_pss_kb ?? null,
          auxKb: s.dalvik_pss_kb ?? null,
          createdAtMs: s.at,
        });
      }
    } catch {
      /* samples are a bonus; the exit verdict already queued */
    }

    const newest = exits.reduce((m, e) => Math.max(m, e.timestamp), lastReportedTs);
    await setAppMeta("last_exit_reported_ts", String(newest));
  } catch {
    /* best-effort */
  }
}

/**
 * Flush a batch of unflushed outbox rows to the backend. Marks rows
 * flushed on a 2xx; leaves them for the next attempt otherwise. Never
 * throws. Called from BackgroundCheckIn.
 */
export async function flushCrashReports(installId: string): Promise<void> {
  try {
    const db = await getDb();
    const rows = await db.getAllAsync<{
      id: number;
      kind: string;
      stage: string | null;
      name: string | null;
      message: string;
      rss_kb: number | null;
      aux_kb: number | null;
      created_at: number;
    }>(
      `SELECT id, kind, stage, name, message, rss_kb, aux_kb, created_at
         FROM crash_outbox WHERE flushed_at IS NULL ORDER BY id ASC LIMIT ?`,
      FLUSH_BATCH,
    );
    if (rows.length === 0) return;

    const baseUrl = await getBackendUrl();
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    const jwt = await getSessionJWT().catch(() => null);
    if (jwt) headers.Authorization = `Bearer ${jwt}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FLUSH_TIMEOUT_MS);
    try {
      const res = await fetch(`${baseUrl}/v1/crash-reports`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          install_id: installId,
          app_version: APP_VERSION,
          platform: "android",
          reports: rows.map((r) => ({
            kind: r.kind,
            stage: r.stage,
            name: r.name,
            message: r.message,
            rss_kb: r.rss_kb,
            aux_kb: r.aux_kb,
            created_at_unix_ms: r.created_at,
          })),
        }),
        signal: controller.signal,
      });
      if (!res.ok) return; // leave unflushed; retry next check-in
      const now = Date.now();
      // Mark this batch flushed.
      const ids = rows.map((r) => r.id);
      const placeholders = ids.map(() => "?").join(",");
      await db.runAsync(
        `UPDATE crash_outbox SET flushed_at = ? WHERE id IN (${placeholders})`,
        now,
        ...ids,
      );
      // Prune old flushed rows (keep ~7 days).
      await db.runAsync(
        `DELETE FROM crash_outbox WHERE flushed_at IS NOT NULL AND flushed_at < ?`,
        now - 7 * 24 * 60 * 60 * 1000,
      );
    } finally {
      clearTimeout(timer);
    }
  } catch {
    /* best-effort */
  }
}
