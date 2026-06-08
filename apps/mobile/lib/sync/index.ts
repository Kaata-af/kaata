// Public surface for the sync layer. Everything else (push.ts, pull.ts,
// cursor.ts internals) is package-private — callers outside lib/sync/
// should only ever import from this file.

export { syncOnce, startSyncScheduler } from "./scheduler";
export type { SyncOnceResult, StartSyncSchedulerOpts } from "./scheduler";

export {
  SessionExpiredError,
  PermissionRejectedError,
  SyncTimeoutError,
  SyncTransientError,
} from "./errors";

export { getSyncIndicator } from "./cursor";
export type { SyncIndicator } from "./cursor";
