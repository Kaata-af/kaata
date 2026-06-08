// Typed errors thrown by the sync layer. Callers (scheduler.ts in particular)
// switch on instanceof to decide whether to back off + retry, stop the worker
// outright, or surface to the user.

// 401 from any sync endpoint. The local JWT is stale (signed out on another
// device, account deleted, secret rotated, etc.). Scheduler reacts by clearing
// the SecureStore session and unmounting the worker; the next foreground
// sign-in restarts it.
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
