// apps/mobile/lib/mesh/errors.ts
//
// Typed errors for the mesh subsystem. Mirrors the convention from
// lib/sync/errors.ts so a future MeshController scheduler can pattern-match
// on the same error shapes.

/**
 * Coarse discriminator for handshake failure reasons, surfaced to the UI
 * so the toast bridge can pick the right copy. Free-form `code` continues
 * to exist on MeshTransportError for adb diagnosis; the UI never
 * branches on it.
 *
 * Phase 9 D-FALLBACK-UX:
 *   "vmc_invalid"     — peer's VMC failed verification (wrong signer,
 *                       wrong vault, expired, revoked, epoch mismatch).
 *   "pop_failed"      — proof-of-possession signature did not verify.
 *   "decrypt_failed"  — post-handshake AEAD decrypt returned null.
 *   "transport"       — generic plumbing failure (timeout, channel closed
 *                       mid-handshake, BLE GATT error).
 */
export type MeshHandshakeKind = "vmc_invalid" | "pop_failed" | "decrypt_failed" | "transport";

export class MeshHandshakeError extends Error {
  kind: MeshHandshakeKind;
  constructor(message: string, kind: MeshHandshakeKind = "transport") {
    super(message);
    this.name = "MeshHandshakeError";
    this.kind = kind;
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

/**
 * Phase 9: thrown by transport-ble.ts during startup peripheral probe when
 * the OS rejects startAdvertising() with FEATURE_UNSUPPORTED — typically
 * on budget Spreadtrum/MediaTek chips common in the AF market.
 *
 * NOT fatal: central scan keeps working, so the device can still pair
 * with phones that DO have peripheral support. MeshController catches
 * this via the failure bridge and surfaces a one-shot "your phone can't
 * broadcast" toast, then lets shop mode keep running.
 */
export class MeshPeripheralUnsupportedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MeshPeripheralUnsupportedError";
  }
}

/**
 * Phase 9: thrown when the BLE adapter is OFF at the moment startShopMode()
 * tries to install the scan/advertise loop. Distinct from
 * MeshPeripheralUnsupportedError — adapter-off is recoverable (user flips
 * BT on), unsupported-chip is permanent for this hardware.
 *
 * Also surfaced via the failure bridge when discovery-ble's onStateChange
 * fires PoweredOff mid-session — currently scan silently pauses with no
 * UI feedback.
 */
export class MeshAdapterOffError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MeshAdapterOffError";
  }
}

/**
 * Phase 9 D-FALLBACK-UX runtime failure events. The mesh layer emits
 * these through setMeshFailureBridge — MeshController switches on `kind`
 * and picks the appropriate toast (debounced + coalesced).
 *
 * NOT the same as the Error classes above. The bridge wraps thrown
 * errors into one of these so MeshController can switch() on `kind`
 * without instanceof — instanceof checks fail intermittently across the
 * dynamic-import boundary used by MeshController.
 */
export type MeshFailureEvent =
  | { kind: "peripheral_unsupported" }
  | { kind: "adapter_off" }
  | { kind: "adapter_on" }
  | { kind: "peer_handshake_failed"; reason: MeshHandshakeKind }
  | { kind: "peer_decrypt_failed" }
  | { kind: "peer_dropped_midsync" };

// ---------------------------------------------------------------------------
// Failure bridge (Phase 9 D-FALLBACK-UX)
//
// Mirrors the wifi-upgrade.ts bridge pattern: MeshController registers a
// single function at mount; mesh internals call emitMeshFailure() at the
// relevant sites; no-op if no bridge is registered (tests).
// ---------------------------------------------------------------------------

type MeshFailureBridge = (event: MeshFailureEvent) => void;
let _meshFailureBridge: MeshFailureBridge | null = null;

export function setMeshFailureBridge(fn: MeshFailureBridge | null): void {
  _meshFailureBridge = fn;
}

export function emitMeshFailure(event: MeshFailureEvent): void {
  if (!_meshFailureBridge) return;
  try {
    _meshFailureBridge(event);
  } catch (err) {
    if (__DEV__) console.warn("[mesh] failure bridge threw", err);
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
