// apps/mobile/lib/sync/last-error.ts
//
// Records the most recent sync/backup failure to app_meta so the "App health"
// report (which the user copies and sends to us) can show WHY backup last
// failed — e.g. VaultNotRegisteredError, which is the silent-403 reinstall-loss
// signature. The sync loop otherwise only console.warn's these, so they're
// invisible once the user is off a debugger.
//
// Contract: every function here is best-effort and NEVER throws — it must not
// disturb the sync loop. The error is cleared on the next successful sync tick,
// so a stale failure doesn't linger in the report after recovery.
//
// Privacy: only the error NAME, a short MESSAGE, and a timestamp are stored.
// Sync errors are network / permission / registration errors — they never carry
// ledger content. The message is truncated as a belt-and-braces measure.

import { getAppMeta, setAppMeta } from "../db";

const KEY = "last_sync_error";
const MAX_MESSAGE_LEN = 200;

export type LastSyncError = { name: string; message: string; at: number };

export async function recordLastSyncError(err: unknown): Promise<void> {
  try {
    const value: LastSyncError = {
      name: (err instanceof Error ? err.name : "") || "unknown",
      message: (err instanceof Error ? err.message : String(err)).slice(0, MAX_MESSAGE_LEN),
      at: Date.now(),
    };
    await setAppMeta(KEY, JSON.stringify(value));
  } catch {
    /* best-effort — never disturb the caller */
  }
}

export async function clearLastSyncError(): Promise<void> {
  try {
    await setAppMeta(KEY, "");
  } catch {
    /* best-effort */
  }
}

export async function getLastSyncError(): Promise<LastSyncError | null> {
  try {
    const raw = await getAppMeta(KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<LastSyncError>;
    if (!v || typeof v.name !== "string" || typeof v.at !== "number") return null;
    return { name: v.name, message: typeof v.message === "string" ? v.message : "", at: v.at };
  } catch {
    return null;
  }
}
