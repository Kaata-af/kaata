// Typed errors thrown by the sync layer. Callers (scheduler.ts in particular)
// switch on instanceof to decide whether to back off + retry, stop the worker
// outright, or surface to the user.

// 401 from any sync endpoint. The local JWT is stale (signed out on another
// device, account deleted, secret rotated, etc.). Scheduler reacts by clearing
// the SecureStore session and backing off; the loop keeps ticking, so a fresh
// sign-in mid-session resumes syncing without an app restart.
export class SessionExpiredError extends Error {
  constructor(message = "session expired") {
    super(message);
    this.name = "SessionExpiredError";
  }
}

// 403 / per-event rejection with reason=insufficient_role. The event was
// authored at an HLC that falls outside the member's "lawful at HLC" role
// window. Not a transport error — the row is already marked rejected_at in
// event_log and a projection_conflicts row exists.
export class PermissionRejectedError extends Error {
  constructor(message = "permission rejected") {
    super(message);
    this.name = "PermissionRejectedError";
  }
}

// AbortController fired before the response arrived. 30s is the per-request
// budget; anything slower is treated as a network problem.
export class SyncTimeoutError extends Error {
  constructor(message = "sync request timed out") {
    super(message);
    this.name = "SyncTimeoutError";
  }
}

// 403 from a sync endpoint (pull/push) for a vault the server has no accepted,
// non-revoked owner membership row for — i.e. the vault was never registered
// via POST /v1/vaults. NOT a permanent failure: the scheduler reacts by kicking
// a registration sweep and retrying on the normal cadence (no backoff escalation,
// no crash report). Distinct from PermissionRejectedError, which is a per-event
// role verdict on an already-registered vault. Without this dedicated type a 403
// fell through to a plain Error → mis-classified as "unexpected" → blind backoff
// + a crash report every tick, while the backup status read "Not backed up yet"
// forever because the cycle aborted before push could stamp last_push_at.
export class VaultNotRegisteredError extends Error {
  constructor(message = "vault not registered on server") {
    super(message);
    this.name = "VaultNotRegisteredError";
  }
}

// 429 or any 5xx. Scheduler reads retryAfterMs (set by the thrower from
// Retry-After header when present) and uses max(retryAfterMs, next backoff
// slot) for the next attempt.
export class SyncTransientError extends Error {
  retryAfterMs: number | null;
  status: number;
  constructor(status: number, retryAfterMs: number | null = null, message?: string) {
    super(message ?? `sync transient error: ${status}`);
    this.name = "SyncTransientError";
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}
