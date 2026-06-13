// apps/mobile/lib/mesh/transport-interface.ts
//
// Phase 6: Unified transport interface for mesh sync.
//
// Both BLE (primary) and WebRTC (opportunistic wifi-upgrade) implement
// this interface. Anti-entropy, VMC handshake, and projection appliers
// all sit above this layer and have NO knowledge of which transport
// they're running on. The `kind` discriminator exists ONLY for:
//   - telemetry / logging
//   - the wifi-upgrade decision in anti-entropy.ts (BLE-only check)
//   - the MeshController lifecycle (which transport to dial)
//
// Everything else MUST treat MeshConnection as opaque.
//
// We keep the sendJSON / recvJSON / close shape from Phase 5 (rather than
// dropping to byte-level send/onMessage) because:
//   - anti-entropy.ts is already a stable surface; rewriting it to push
//     JSON encoding down would be a churn-for-churn-sake change.
//   - Both BLE and WebRTC transports do their own length-prefix framing
//     internally; exposing JSON at the boundary keeps the test seam clean.

// ---------------------------------------------------------------------------
// MeshConnection — transport-agnostic full-duplex JSON channel
// ---------------------------------------------------------------------------

export interface MeshConnection {
  /**
   * Send a single JSON-shaped message. Implementation handles framing
   * (4-byte big-endian length prefix), chunking to fit transport MTU,
   * and back-pressure. Throws on closed connection or write failure.
   */
  sendJSON(obj: unknown): Promise<void>;

  /**
   * Receive a single JSON-shaped message. Rejects with a timeout error
   * after `timeoutMs` ms. On a closed connection resolves to a
   * `{ __closed: true }` sentinel so callers can detect peer hang-up
   * without an error race.
   */
  recvJSON(timeoutMs: number): Promise<unknown>;

  /**
   * Idempotent. Tears down the underlying transport, resolves any
   * pending recvJSON callers with the closed sentinel. Safe to call
   * from any state and multiple times.
   */
  close(): Promise<void>;

  /** Discriminator for telemetry + wifi-upgrade decision logic.
   *  ("lan" is the M3 TCP-over-LAN transport; "webrtc" was removed in M3d
   *  when the WebRTC transport + local signaling server were deleted.) */
  readonly kind: "ble" | "lan" | "memory";

  /**
   * The peer's device_id, set by anti-entropy.ts after the VMC handshake
   * succeeds. Null until then. Used by the connections-map in mesh/index.ts
   * for dedupe and by the projection layer for actor attribution on
   * locally-emitted vault_member_* events.
   */
  remoteDeviceId: string | null;
}

// ---------------------------------------------------------------------------
// PeerInfo — discovery-time peer descriptor
// ---------------------------------------------------------------------------

/**
 * Stable shape emitted by both BLE and mDNS discovery so the upper
 * layers (MeshController, anti-entropy) don't care which transport
 * surfaced the peer.
 */
export type PeerInfo = {
  /** First 8 chars of the peer's install_id (mDNS) or BLE device id prefix. */
  installIdShort: string;
  /** Discovery-time service identifier (mDNS service name or BLE peripheral id). */
  serviceName: string;
  /** Vault IDs we believe we share with this peer (computed from hash match). */
  matchedVaultIds: string[];
  /** Which transport discovered this peer. */
  discoveredVia: "ble" | "mdns";
};
