// apps/mobile/lib/mesh/errors.ts
//
// Typed errors for the mesh subsystem. Mirrors the convention from
// lib/sync/errors.ts so a future MeshController scheduler can pattern-match
// on the same error shapes.

export class MeshHandshakeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MeshHandshakeError";
  }
}

export class MeshVMCExpiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MeshVMCExpiredError";
  }
}

export class MeshVMCRevokedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MeshVMCRevokedError";
  }
}

/**
 * Phase 7: thrown by startShopMode() when the device has no vault that
 * can participate in the mesh (no vault with a trust anchor pubkey).
 * The UI catches this and surfaces `message` directly as a toast, then
 * reverts the toggle. Distinct from MeshHandshakeError so the caller
 * doesn't conflate "couldn't even start" with "started but peer
 * dropped".
 */
export class ShopModeNotAvailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ShopModeNotAvailableError";
  }
}

/**
 * Phase 8: thrown by startShopMode() on Android when the foreground
 * service fails to start (notifee.displayNotification throws — usually
 * missing POST_NOTIFICATIONS permission or a corrupted notifee channel).
 *
 * On Android, FGS is REQUIRED for the radio to survive Doze. If it
 * doesn't start, the user thinks "Nearby sync" is on but it'll be killed
 * within minutes. The UI catches this and toasts a specific actionable
 * error, then reverts the toggle (mirrors ShopModeNotAvailableError).
 */
export class ShopModeForegroundServiceFailedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ShopModeForegroundServiceFailedError";
  }
}

export class MeshTransportError extends Error {
  // Optional code for routing — "channel_not_open" / "timeout" /
  // "signaling_connect_failed" etc. Free-form; consumers should not switch
  // on it for control flow.
  code?: string;
  constructor(message: string, code?: string) {
    super(message);
    this.name = "MeshTransportError";
    this.code = code;
  }
}
