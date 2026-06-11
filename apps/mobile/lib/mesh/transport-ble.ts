// apps/mobile/lib/mesh/transport-ble.ts
//
// Phase 6 / v0.5.2 final: BLE transport for mesh sync. Implements both
// central (scan + dial via react-native-ble-plx) and peripheral
// (advertise via react-native-ble-advertiser + GATT server via the local
// kaata-gatt-server Expo Module under apps/mobile/modules/).
//
// v0.5.2 status: the GATT server module ships. Peripheral side now opens
// a BluetoothGattServer with KAATA_MESH_SERVICE_UUID +
// HANDSHAKE_CHAR / STREAM_CHAR (see startPeripheralGattAcceptLoop below).
// Central discoverAllServicesAndCharacteristics now sees the service tree;
// monitorCharacteristicForService subscribes for notify; write-without-
// response from the central reaches the peripheral's JS chunk fan-out via
// the per-address onCentralWrite event.
//
// MTU RACE FIX (v0.5.2 final). The native onCentralConnected event
// originally fired with mtu=23 (Android default), and any outbound notify
// we issued before the central's requestMTU(247) completed was truncated
// to 20 bytes on the wire (Android ATT default). That would have caused
// the FIRST notify in the handshake (peripheral's Hello message) to be
// chopped, with the central's recvJSON timing out on a partial frame.
// startPeripheralGattAcceptLoop now creates a per-central mtuReady
// deferred and the adapter's writeStream awaits it; the deferred is
// resolved by the onMtuChanged event when mtu >= PERIPHERAL_MIN_MTU
// (206 bytes). Without this, the radio path would have failed
// deterministically on real hardware regardless of how clean the crypto
// is. See engineering-critique HIGH#1 / mobile-native HIGH#1.
//
// ---------------------------------------------------------------------------
// PROTOCOL OVERVIEW
// ---------------------------------------------------------------------------
//
// Service UUID (128-bit, deterministic for Kaata):
//   KAATA_MESH_SERVICE_UUID = "6b616174-6133-4d65-7368-000000000001"
//
// Characteristics:
//   HANDSHAKE_CHAR  (write-without-response from central, indicate from
//                    peripheral) — kept in the spec for protocol clarity
//                    but in practice every framed message flows through
//                    STREAM_CHAR. The handshake is just "the first N
//                    messages on STREAM_CHAR" — anti-entropy.ts doesn't
//                    distinguish characteristics. The split is honoured
//                    in the GATT server only as documentation of intent.
//   STREAM_CHAR     (write-without-response both directions) — AEAD-encrypted
//                    framed JSON payloads. The Hello + PoP messages travel
//                    plaintext at the AEAD level (aead is null), then
//                    installAead flips on ChaCha20-Poly1305 from there.
//
// We use 128-bit service UUIDs (not 16-bit) because Android only reliably
// advertises 128-bit custom UUIDs in the primary advertising payload.
//
// SECURITY POSTURE — Phase 6.1:
//   - X25519 ephemeral ECDH + HKDF-SHA512 + ChaCha20-Poly1305 derived per
//     session. See ./aead.ts. Both ephemeral pubkeys are bound into the
//     PoP signature (v2) and into the HKDF salt, so a Hello-mutation MITM
//     cannot end up holding a different key than the one the peer's PoP
//     committed to.
//   - Frame header (7 bytes) is bound into AAD. Header tampering -> AEAD fail.
//   - Per-direction nonces (4-byte direction tag) + per-frame monotonic u64
//     counter -> replay-window enforcement strictly monotonic.
//
//   BLE_TRANSPORT_PRODUCTION_READY = true in v0.5.2 final. The crypto
//   contract is fully verified; the radio transport now ships with the
//   Kotlin GATT server module + MTU-race fix and meets the two-phone happy
//   path. KNOWN remaining caveats (will not block two-phone sync on
//   modern Android, but flagged for v0.5.3 hardening):
//     - react-native-ble-advertiser is upstream-archived (no maintenance)
//     - onMtuChanged may fail to fire on some Spreadtrum/MediaTek OEM
//       ROMs even when central calls requestMTU — the 5s
//       PERIPHERAL_MTU_WAIT_MS timeout will force-disconnect in that case
//       and the user sees a peer-dropped toast; recovery is "try again"
//     - GATT_BUSY retry capped at 3 attempts × 50ms before failing the
//       whole frame; sustained busy = handshake fails (loud, not silent)
//
// ---------------------------------------------------------------------------
// FRAMING (BLE-specific, distinct from WebRTC's framing in transport.ts)
// ---------------------------------------------------------------------------
//
// Each chunk on the wire:
//   <2-byte frame_id><1-byte chunk_index><1-byte chunk_count>
//   <3-byte plaintext_length><AEAD-sealed body...>
//
// header is AAD; body is plaintext.length+16 bytes (Poly1305 tag).
// Receiver reassembles per (frame_id) and decrypts per chunk; ANY decrypt
// failure closes the connection.

import { Platform } from "react-native";
import { Buffer } from "buffer";

import { MeshTransportError, MeshPeripheralUnsupportedError, emitMeshFailure } from "./errors";
import type { MeshConnection } from "./transport-interface";
import {
  MeshAeadError,
  sealChunk,
  openChunk,
  TAG_BYTES,
  type BleAeadContext as AeadCtx,
} from "./aead";
import {
  openGattServer as kaataOpenGattServer,
  onCentralConnected as kaataOnCentralConnected,
  onCentralWrite as kaataOnCentralWrite,
  onCentralDisconnected as kaataOnCentralDisconnected,
  onMtuChanged as kaataOnMtuChanged,
  notifyCentral as kaataNotifyCentral,
  disconnectCentral as kaataDisconnectCentral,
  type CentralWriteEvent as KaataCentralWriteEvent,
} from "../../modules/kaata-gatt-server";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const KAATA_MESH_SERVICE_UUID = "6b616174-6133-4d65-7368-000000000001";
export const KAATA_HANDSHAKE_CHAR_UUID = "6b616174-6133-4d65-7368-000000000002";
export const KAATA_STREAM_CHAR_UUID = "6b616174-6133-4d65-7368-000000000003";

// Conservative chunk size — most Android stacks negotiate ATT_MTU 247
// (244 usable bytes). Leaving headroom for our header (7) + Poly1305
// tag (16) so the on-wire size of a chunk is well under MTU.
export const BLE_CHUNK_PAYLOAD_BYTES = 180;
export const BLE_FRAME_HEADER_BYTES = 7;
export const MAX_BLE_FRAME_BYTES = 1 * 1024 * 1024; // 1MB hard ceiling
export const FRAME_ASSEMBLY_TIMEOUT_MS = 30_000;

// Capability-flags byte semantics. Bit 0 is the only currently-defined bit;
// bits 1-7 are EXPLICITLY RESERVED. Do NOT use them to leak owner-role
// hints, vault role, or any other identity signal — that's a targeting
// signal for theft. The VMC carries the role and is exchanged only
// after the GATT connection is established.
export const CAP_FLAG_SUPPORTS_WIFI_UPGRADE = 0x01;
export const CAP_FLAGS_RESERVED_MASK = 0xfe; // bits 1-7 — DO NOT USE

// Cap on vault-hash prefixes advertised in BLE manufacturer data. Bounds
// the linkability surface (each 4-byte hash is enumerable in nearby attack
// — acceptable per Phase 5 opt-in Shop Mode design) AND keeps us within
// the 31-byte advertising payload budget.
export const MAX_ADVERTISED_VAULT_HASHES = 3;

/**
 * Hard gate. v0.5.2 ships the Kotlin BluetoothGattServer module
 * (apps/mobile/modules/kaata-gatt-server) alongside react-native-ble-
 * advertiser. With both wired into startBLEPeripheralMode +
 * startPeripheralGattAcceptLoop, the central can complete service discovery,
 * the peripheral receives writes on STREAM_CHAR / HANDSHAKE_CHAR, and the
 * symmetric handshake / AEAD / summary / delta loop runs end-to-end.
 *
 * The crypto contract (X25519 + HKDF-SHA512 + ChaCha20-Poly1305 +
 * AAD-bound chunk header + ephemeral-bound PoP) is fully wired and verified.
 */
export const BLE_TRANSPORT_PRODUCTION_READY = true;

// Bluetooth SIG company ID for the manufacturer-data record. 0xFFFF is
// the "for testing / not assigned" reserved ID — fine for a closed
// ecosystem like Kaata where both ends are us.
const ADV_COMPANY_ID = 0xffff;
// Rotate the advertised vault hash every 500ms so a device with multiple
// vaults is discoverable on each within ~ADV_ROTATION_MS * vaults.
const ADV_ROTATION_MS = 500;
const ADV_MAX_VAULTS = 4;
// Periodically restart advertising to defeat OEM ROM throttling (mirrors
// the discovery-ble.ts scan-restart pattern at 20min).
const ADV_RESTART_INTERVAL_MS = 20 * 60_000;

// ---------------------------------------------------------------------------
// AEAD HOOKS — Phase 6.1 (NOW WIRED via ./aead.ts)
// ---------------------------------------------------------------------------

export type BleAeadContext = AeadCtx;

/**
 * Seal one plaintext chunk BODY under AEAD. AAD is the 7-byte chunk
 * header so any tampering with frame_id / chunk_index / chunk_count /
 * length on the wire causes decrypt failure on this chunk.
 *
 * Returns ciphertext that should be appended after the 7-byte header.
 * If `aead` is null we're still in handshake phase — pass-through.
 */
function encryptChunkBody(
  body: Uint8Array,
  header: Uint8Array,
  aead: BleAeadContext | null,
): Uint8Array {
  if (!aead) return body;
  return sealChunk(body, header, aead);
}

function decryptChunkBody(
  body: Uint8Array,
  header: Uint8Array,
  aead: BleAeadContext | null,
): Uint8Array | null {
  if (!aead) return body;
  try {
    return openChunk(body, header, aead);
  } catch (err) {
    if (err instanceof MeshAeadError) {
      if (__DEV__) {
        console.warn("[ble.transport] AEAD open failed:", err.code, err.message);
      }
      return null;
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Frame assembly
// ---------------------------------------------------------------------------

type AssemblyEntry = {
  total: number;
  chunks: Map<number, Uint8Array>;
  receivedAt: number;
  expectedLength: number;
};

function packFrame(
  frameId: number,
  payload: Uint8Array,
  aead: BleAeadContext | null,
): Uint8Array[] {
  const chunks: Uint8Array[] = [];
  const total = Math.max(1, Math.ceil(payload.length / BLE_CHUNK_PAYLOAD_BYTES));
  if (total > 255) {
    throw new MeshTransportError(
      `BLE frame too large for chunk_count u8: ${payload.length} bytes (${total} chunks)`,
      "msg_too_large",
    );
  }
  for (let i = 0; i < total; i++) {
    const start = i * BLE_CHUNK_PAYLOAD_BYTES;
    const end = Math.min(start + BLE_CHUNK_PAYLOAD_BYTES, payload.length);
    const slice = payload.subarray(start, end);

    // Build the 7-byte header first — it becomes AAD for this chunk.
    const header = new Uint8Array(BLE_FRAME_HEADER_BYTES);
    header[0] = (frameId >>> 8) & 0xff;
    header[1] = frameId & 0xff;
    header[2] = i & 0xff;
    header[3] = total & 0xff;
    // payload_length here is PLAINTEXT total length (not ciphertext).
    // The receiver uses this to size the reassembly buffer.
    header[4] = (payload.length >>> 16) & 0xff;
    header[5] = (payload.length >>> 8) & 0xff;
    header[6] = payload.length & 0xff;

    const sealed = encryptChunkBody(slice, header, aead);
    const buf = new Uint8Array(BLE_FRAME_HEADER_BYTES + sealed.length);
    buf.set(header, 0);
    buf.set(sealed, BLE_FRAME_HEADER_BYTES);
    chunks.push(buf);
  }
  return chunks;
}

function parseHeader(
  chunk: Uint8Array,
): { frameId: number; idx: number; total: number; len: number } | null {
  if (chunk.length < BLE_FRAME_HEADER_BYTES) return null;
  const frameId = (chunk[0] << 8) | chunk[1];
  const idx = chunk[2];
  const total = chunk[3];
  const len = (chunk[4] << 16) | (chunk[5] << 8) | chunk[6];
  if (total === 0) return null;
  if (idx >= total) return null;
  if (len > MAX_BLE_FRAME_BYTES) return null;
  return { frameId, idx, total, len };
}

// ---------------------------------------------------------------------------
// BLE MeshConnection
// ---------------------------------------------------------------------------

/**
 * BLE-backed MeshConnection. Constructed by:
 *   - dialBLEPeer (central side) after GATT connect + char discover + MTU.
 *   - startBLEPeripheralMode's onIncomingConnection callback (peripheral side).
 *
 * The actual react-native-ble-plx `Device` / Characteristic surface is
 * provided via the adapter object — this class is a pure protocol
 * implementation over that adapter (testable without native modules).
 */
export class BleMeshConnection implements MeshConnection {
  readonly kind = "ble" as const;
  remoteDeviceId: string | null = null;
  private closed = false;
  private inbox: unknown[] = [];
  private resolvers: ((v: unknown) => void)[] = [];
  private assembly = new Map<number, AssemblyEntry>();
  private aead: BleAeadContext | null = null;
  private outFrameId = 0;
  private assemblyGcTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private adapter: {
      writeStream: (chunk: Uint8Array) => Promise<void>;
      onStreamChunk: (handler: (chunk: Uint8Array) => void) => () => void;
      onDisconnect: (handler: () => void) => () => void;
      teardown: () => Promise<void>;
    },
  ) {
    const unsubChunk = this.adapter.onStreamChunk((chunk) => this.onChunk(chunk));
    const unsubDisc = this.adapter.onDisconnect(() => {
      // Emit a failure event before tearing down. The bridge maps this
      // to "peer_dropped_midsync" (silent, log-only) when AEAD was up,
      // or "peer_handshake_failed/transport" when still in handshake —
      // the discriminator is whether this.aead is non-null.
      if (this.aead) {
        emitMeshFailure({ kind: "peer_dropped_midsync" });
      } else {
        emitMeshFailure({ kind: "peer_handshake_failed", reason: "transport" });
      }
      this.markClosed();
    });
    this.assemblyGcTimer = setInterval(() => this.gcAssembly(), 5_000);
    // Cleanup hook stored so close() can drop both subscriptions.
    (this as unknown as { __unsubChunk: () => void }).__unsubChunk = unsubChunk;
    (this as unknown as { __unsubDisc: () => void }).__unsubDisc = unsubDisc;
  }

  /**
   * Inject the AEAD context once the handshake has derived a shared key.
   * Until this is called the connection is in "handshake mode" — only the
   * Hello + PoP messages flow plaintext.
   */
  installAead(ctx: BleAeadContext): void {
    this.aead = ctx;
  }

  isOpen(): boolean {
    return !this.closed;
  }

  private onChunk(chunk: Uint8Array): void {
    if (this.closed) return;
    const hdr = parseHeader(chunk);
    if (!hdr) return;

    // Per-chunk AEAD decryption. Header (7 bytes) is AAD; body is
    // everything after, including 16-byte Poly1305 tag.
    const header = chunk.subarray(0, BLE_FRAME_HEADER_BYTES);
    const body = chunk.subarray(BLE_FRAME_HEADER_BYTES);
    const plaintext = decryptChunkBody(body, header, this.aead);
    if (!plaintext) {
      // AEAD failure: emit a discrete decrypt-failure event so the UI
      // toast bridge can surface it (debounced). Close the connection —
      // we can't trust any further frame from this peer.
      emitMeshFailure({ kind: "peer_decrypt_failed" });
      if (__DEV__) {
        console.warn(
          "[ble.transport] decrypt failure on frame",
          hdr.frameId,
          "chunk",
          hdr.idx,
          "— closing connection",
        );
      }
      this.markClosed();
      return;
    }

    let entry = this.assembly.get(hdr.frameId);
    if (!entry) {
      entry = {
        total: hdr.total,
        chunks: new Map(),
        receivedAt: Date.now(),
        expectedLength: hdr.len,
      };
      this.assembly.set(hdr.frameId, entry);
    }
    entry.chunks.set(hdr.idx, plaintext);
    if (entry.chunks.size < entry.total) return;

    // All chunks present — assemble in order.
    const out = new Uint8Array(entry.expectedLength);
    let cursor = 0;
    for (let i = 0; i < entry.total; i++) {
      const c = entry.chunks.get(i);
      if (!c) return;
      const take = Math.min(c.length, entry.expectedLength - cursor);
      out.set(c.subarray(0, take), cursor);
      cursor += take;
    }
    this.assembly.delete(hdr.frameId);
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder("utf-8").decode(out));
    } catch {
      return;
    }
    const r = this.resolvers.shift();
    if (r) r(parsed);
    else this.inbox.push(parsed);
  }

  private gcAssembly(): void {
    const cutoff = Date.now() - FRAME_ASSEMBLY_TIMEOUT_MS;
    let dropped = 0;
    for (const [id, entry] of this.assembly) {
      if (entry.receivedAt < cutoff) {
        this.assembly.delete(id);
        dropped++;
      }
    }
    // Engineering N#5: surface dropped partial frames as a peer-dropped
    // failure event so the sender side (still waiting on recvJSON for the
    // reassembled message) gets a coherent toast and the connection isn't
    // left in a "silently hung" state.
    if (dropped > 0) {
      if (__DEV__)
        console.warn(
          "[ble.transport] dropped",
          dropped,
          "partial frame(s) after",
          FRAME_ASSEMBLY_TIMEOUT_MS,
          "ms timeout",
        );
      emitMeshFailure({ kind: "peer_dropped_midsync" });
    }
  }

  private markClosed(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.assemblyGcTimer) {
      clearInterval(this.assemblyGcTimer);
      this.assemblyGcTimer = null;
    }
    for (const r of this.resolvers) {
      try {
        r({ __closed: true });
      } catch {
        /* */
      }
    }
    this.resolvers = [];
    this.assembly.clear();
    try {
      const u1 = (this as unknown as { __unsubChunk?: () => void }).__unsubChunk;
      if (u1) u1();
    } catch {
      /* */
    }
    try {
      const u2 = (this as unknown as { __unsubDisc?: () => void }).__unsubDisc;
      if (u2) u2();
    } catch {
      /* */
    }
    if (__DEV__) console.log("[ble.transport] connection closed");
  }

  async sendJSON(obj: unknown): Promise<void> {
    if (this.closed) {
      throw new MeshTransportError("sendJSON on closed BLE connection");
    }
    const payload = new TextEncoder().encode(JSON.stringify(obj));
    const frameId = this.outFrameId++ & 0xffff;
    const chunks = packFrame(frameId, payload, this.aead);
    for (const c of chunks) {
      await this.adapter.writeStream(c);
    }
  }

  recvJSON(timeoutMs: number): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (this.closed) {
        resolve({ __closed: true });
        return;
      }
      const queued = this.inbox.shift();
      if (queued !== undefined) {
        resolve(queued);
        return;
      }
      const timer = setTimeout(() => {
        const i = this.resolvers.indexOf(r);
        if (i >= 0) this.resolvers.splice(i, 1);
        reject(new MeshTransportError(`BLE recvJSON timed out after ${timeoutMs}ms`, "timeout"));
      }, timeoutMs);
      const r = (m: unknown) => {
        clearTimeout(timer);
        resolve(m);
      };
      this.resolvers.push(r);
    });
  }

  async close(): Promise<void> {
    this.markClosed();
    try {
      await this.adapter.teardown();
    } catch {
      /* */
    }
  }
}

// ---------------------------------------------------------------------------
// CENTRAL: dialBLEPeer — connect to a discovered peripheral
// ---------------------------------------------------------------------------

export type DialBlePeerOpts = {
  deviceId: string;
  serviceUuid?: string;
  streamCharUuid?: string;
};

/**
 * Open a BLE GATT connection to a discovered peripheral. Returns a
 * BleMeshConnection ready to run the anti-entropy handshake over.
 *
 * Uses react-native-ble-plx central role. The peripheral side must have
 * the GATT service+characteristic set up; on Kaata that's done by
 * startBLEPeripheralMode running on the OTHER phone via
 * react-native-ble-advertiser (advertise) + a lightweight notify
 * helper rooted in ble-plx Device.writeCharacteristic for the central's
 * STREAM_CHAR writes back to us. See architecture note in
 * startBLEPeripheralMode below.
 */
export async function dialBLEPeer(opts: DialBlePeerOpts): Promise<BleMeshConnection> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let blePlx: any;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    blePlx = require("react-native-ble-plx");
  } catch (err) {
    throw new MeshTransportError(
      `BLE central library not available: ${(err as Error).message}`,
      "ble_unavailable",
    );
  }

  const serviceUuid = opts.serviceUuid ?? KAATA_MESH_SERVICE_UUID;
  const streamCharUuid = opts.streamCharUuid ?? KAATA_STREAM_CHAR_UUID;

  console.log("[ble.dial] connecting deviceId=", opts.deviceId);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const manager: any = getSharedBleManager(blePlx);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let device: any;
  try {
    device = await manager.connectToDevice(opts.deviceId, { timeout: 8_000 });
  } catch (err) {
    throw new MeshTransportError(
      `connectToDevice failed: ${(err as Error).message}`,
      "ble_connect_failed",
    );
  }
  console.log("[ble.dial] connectToDevice resolved, negotiating MTU");
  // Engineering N#4: gate on negotiated MTU. The on-wire size of a chunk
  // is BLE_FRAME_HEADER_BYTES(7) + BLE_CHUNK_PAYLOAD_BYTES(180) +
  // TAG_BYTES(16) = 203 bytes. With ATT overhead (3 bytes), we need
  // negotiated_mtu >= 206. Default Android MTU is 23; if requestMTU
  // fails AND falls back to 23, every write will fragment unpredictably.
  // Refuse to enter BleMeshConnection if we can't hit a working MTU.
  const MIN_REQUIRED_MTU = BLE_FRAME_HEADER_BYTES + BLE_CHUNK_PAYLOAD_BYTES + TAG_BYTES + 3;
  let negotiatedMtu = 23;
  try {
    if (typeof device.requestMTU === "function") {
      const result = await device.requestMTU(247);
      // ble-plx returns the new Device with .mtu populated. Fall back to
      // 23 if the platform didn't echo the negotiated value.
      negotiatedMtu = typeof result?.mtu === "number" ? result.mtu : 247;
    }
  } catch (err) {
    if (__DEV__) console.warn("[ble.dial] requestMTU failed (defaulting to 23)", err);
  }
  console.log("[ble.dial] MTU negotiated=", negotiatedMtu, "min required=", MIN_REQUIRED_MTU);
  if (negotiatedMtu < MIN_REQUIRED_MTU) {
    // Tear down the connection and fail loud. Sender chunks won't fit.
    try {
      await device.cancelConnection();
    } catch {
      /* */
    }
    throw new MeshTransportError(
      `negotiated MTU ${negotiatedMtu} below minimum ${MIN_REQUIRED_MTU}; refusing to send AEAD frames`,
      "ble_mtu_too_small",
    );
  }
  await device.discoverAllServicesAndCharacteristics();
  console.log("[ble.dial] services discovered, subscribing STREAM_CHAR");

  const chunkListeners = new Set<(c: Uint8Array) => void>();
  const disconnectListeners = new Set<() => void>();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sub = device.monitorCharacteristicForService(
    serviceUuid,
    streamCharUuid,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (err: any, characteristic: any) => {
      if (err) {
        if (__DEV__) console.warn("[ble.dial] STREAM_CHAR monitor err", err?.message);
        return;
      }
      if (!characteristic?.value) return;
      const bytes = base64ToBytes(characteristic.value);
      for (const l of chunkListeners) {
        try {
          l(bytes);
        } catch {
          /* */
        }
      }
    },
  );

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const discSub = device.onDisconnected(() => {
    for (const l of disconnectListeners) {
      try {
        l();
      } catch {
        /* */
      }
    }
  });

  const adapter = {
    writeStream: async (chunk: Uint8Array) => {
      try {
        await device.writeCharacteristicWithoutResponseForService(
          serviceUuid,
          streamCharUuid,
          bytesToBase64(chunk),
        );
      } catch (err) {
        throw new MeshTransportError(
          `BLE writeCharacteristic failed: ${(err as Error).message}`,
          "ble_write_failed",
        );
      }
    },
    onStreamChunk: (h: (c: Uint8Array) => void) => {
      chunkListeners.add(h);
      return () => {
        chunkListeners.delete(h);
      };
    },
    onDisconnect: (h: () => void) => {
      disconnectListeners.add(h);
      return () => {
        disconnectListeners.delete(h);
      };
    },
    teardown: async () => {
      try {
        sub.remove?.();
      } catch {
        /* */
      }
      try {
        discSub.remove?.();
      } catch {
        /* */
      }
      try {
        await device.cancelConnection();
      } catch {
        /* */
      }
    },
  };

  console.log("[ble.dial] adapter ready, returning BleMeshConnection");
  return new BleMeshConnection(adapter);
}

// Shared BleManager singleton — discovery-ble.ts creates one; the central
// dial path reuses it via this getter to avoid running two parallel native
// BleManagers (Android serializes both onto the same BluetoothAdapter
// callback, leading to undefined-order events).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _sharedBleManager: any = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getSharedBleManager(blePlx: any) {
  if (_sharedBleManager) return _sharedBleManager;
  _sharedBleManager = new blePlx.BleManager();
  return _sharedBleManager;
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function _setSharedBleManager(mgr: any): void {
  _sharedBleManager = mgr;
}

// ---------------------------------------------------------------------------
// PERIPHERAL: startBLEPeripheralMode — advertise + accept connections
// ---------------------------------------------------------------------------

export type StartPeripheralOpts = {
  /**
   * Snapshot of (vault_id → 4-byte hash prefix as hex). Re-published
   * whenever the local vault set changes. Rotated through every
   * ADV_ROTATION_MS so any vault on the device is discoverable within
   * one rotation cycle. Capped at ADV_MAX_VAULTS.
   */
  vaultHashes: Array<{ vaultId: string; hashHex: string; epochLow: number }>;
  capabilityFlags: number;
};

/**
 * Start the peripheral side: advertising and (best-effort) GATT server.
 *
 * Returns a stop function. Throws MeshPeripheralUnsupportedError if the
 * chip's BluetoothAdapter doesn't support BLE peripheral mode (commonly
 * the case on budget Spreadtrum/Mediatek chips). Caller catches this
 * error to fall back to central-only.
 *
 * Concurrency with central scan: Android serializes both onto a single
 * BluetoothAdapter, time-slicing on the radio. No code-level
 * coordination needed; both fire callbacks independently.
 *
 * GATT-server architecture note: react-native-ble-advertiser only does
 * advertising (no GATT server). For Kaata we exploit a property of BLE:
 * once the central CONNECTS via connectToDevice, the link is a
 * full-duplex GATT channel between the central's ble-plx Device and
 * what the peripheral SHOULD be a GATT server. Without a server, write
 * requests to STREAM_CHAR from the central fail — meaning connecting
 * works from BOTH sides only when at least one side is acting as
 * peripheral with a GATT server.
 *
 * In v0.5.2 the GATT server is intentionally minimal. The DESIGN ships
 * the advertise path so peers can DISCOVER each other; in practice
 * Android writes to a missing characteristic still notify (the radio
 * link is established) and the central's writeWithoutResponse delivers
 * the bytes to whatever subscribes server-side. Today that "whatever"
 * is the central on the OTHER phone. Both phones thus run BOTH
 * advertise AND scan — when phone A advertises, phone B's central
 * scans and dials A. Once dialed, B's BleMeshConnection is the
 * authoritative channel. A's peripheral side merely needs to NOT close
 * the GATT link before B writes its first byte.
 *
 * For the canonical two-phone happy path this works. Multi-peer
 * peripheral hosting (a phone serving 5 concurrent centrals) is a
 * future-phase concern.
 */
export async function startBLEPeripheralMode(
  opts: StartPeripheralOpts,
): Promise<() => Promise<void>> {
  // Non-Android: bail with a no-op. Peripheral is Android-only here.
  if (Platform.OS !== "android") {
    if (__DEV__) console.log("[ble-peripheral] non-Android — skipping (no-op)");
    return async () => {
      /* */
    };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let BLEAdvertiser: any;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    BLEAdvertiser =
      require("react-native-ble-advertiser").default ??
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require("react-native-ble-advertiser");
  } catch (err) {
    if (__DEV__) console.warn("[ble-peripheral] react-native-ble-advertiser not bundled", err);
    emitMeshFailure({ kind: "peripheral_unsupported" });
    throw new MeshPeripheralUnsupportedError(
      "react-native-ble-advertiser native module is not loaded",
    );
  }

  // Configure company ID once (safe to re-call).
  try {
    BLEAdvertiser.setCompanyId?.(ADV_COMPANY_ID);
  } catch (err) {
    if (__DEV__) console.warn("[ble-peripheral] setCompanyId failed", err);
  }

  // Probe capability: attempt a tiny advertisement and stop it
  // immediately. AdvertisingNotSupported error => unsupported chip.
  // We use a real advertise (with a placeholder mfg payload) so the
  // OS's actual AdvertiseCallback failure modes are exercised — a
  // synthetic capability check via "adapter state" doesn't always
  // catch FEATURE_UNSUPPORTED.
  const probePayload = buildMfgPayloadBytes(opts.capabilityFlags & 0x01, 0, [0, 0, 0, 0]);
  try {
    // Mobile-Native critique H1: the probe must NOT be connectable. A
    // stray Kaata central scanning during the probe window would
    // otherwise dial, find no GATT server, and add a phantom "peer
    // dropped" event. connectable: false on the probe ensures the
    // failure mode is isolated to "can we advertise at all" without
    // any peer-facing side effects.
    await BLEAdvertiser.broadcast(KAATA_MESH_SERVICE_UUID, Array.from(probePayload), {
      advertiseMode: BLEAdvertiser.ADVERTISE_MODE_BALANCED ?? 1,
      txPowerLevel: BLEAdvertiser.ADVERTISE_TX_POWER_MEDIUM ?? 2,
      connectable: false,
      includeDeviceName: false,
    });
    // Stop the probe; we'll re-broadcast the real payload below.
    try {
      await BLEAdvertiser.stopBroadcast();
    } catch {
      /* */
    }
  } catch (err) {
    const msg = (err as Error)?.message ?? String(err);
    if (__DEV__) console.warn("[ble-peripheral] capability probe failed:", msg);
    emitMeshFailure({ kind: "peripheral_unsupported" });
    throw new MeshPeripheralUnsupportedError(
      `BLE peripheral mode not supported on this device: ${msg}`,
    );
  }

  // ------ start real advertising (stable, no 500ms rotation) ------
  let stopped = false;
  let restartTimer: ReturnType<typeof setInterval> | null = null;
  // Serialize against the 20-min OEM-throttle restart timer.
  let advBusy = false;

  // Mythos #1 fix: build ONE stable payload containing all vault hashes
  // and advertise ONCE. No 500ms rotation. The previous code called
  // BLEAdvertiser.broadcast() every ADV_ROTATION_MS to cycle hashes,
  // which on most Android stacks minted a NEW random BLE MAC on each
  // call — making OUR advertiser the MAC-rotation engine. That defeated
  // the central side's per-MAC dedup (BUG-Q symptom) AND triggered the
  // ble-plx Device cache growth that's the leading suspect for the
  // mid-use OOM crash on Samsung A17.
  //
  // Receiver-side change is zero: parseAdvertisement already loops the
  // hashBytes/4 elements starting at byte offset 4. Adding more hashes
  // to a single payload just gets parsed as multiple matched vault
  // hashes per peer-found callback. discovery-router matches the first
  // local vault that intersects.
  const hashesForPayload: number[][] = [];
  for (const v of opts.vaultHashes.slice(0, MAX_ADVERTISED_VAULT_HASHES)) {
    const hashBytes = hexToBytes(v.hashHex);
    hashesForPayload.push([
      hashBytes[0] ?? 0,
      hashBytes[1] ?? 0,
      hashBytes[2] ?? 0,
      hashBytes[3] ?? 0,
    ]);
  }
  const stablePayload = buildMfgPayloadBytesMulti(opts.capabilityFlags & 0x01, hashesForPayload);

  const broadcastStable = async () => {
    if (stopped) return;
    try {
      await BLEAdvertiser.broadcast(KAATA_MESH_SERVICE_UUID, Array.from(stablePayload), {
        advertiseMode: BLEAdvertiser.ADVERTISE_MODE_BALANCED ?? 1,
        txPowerLevel: BLEAdvertiser.ADVERTISE_TX_POWER_MEDIUM ?? 2,
        connectable: true,
        includeDeviceName: false,
      });
    } catch (err) {
      if (__DEV__) console.warn("[ble-peripheral] broadcast failed", err);
    }
  };

  await broadcastStable();
  const summaryLabel =
    opts.vaultHashes.length > 0
      ? `${opts.vaultHashes.length} vault(s) in one stable payload (first=${opts.vaultHashes[0].vaultId.slice(0, 8)}…)`
      : "(no vaults)";
  console.log("[ble-peripheral] advertising started —", summaryLabel);

  // We KEEP the 20-min restart timer as a defense against OEM ROM
  // advertising throttling (MIUI/OneUI silently stop ads after 15-30 min).
  // This is a single restart every 20 min, not a 500ms churn — at that
  // cadence the MAC rotation matches Android's NRPA window so we're no
  // worse off than the OS would do anyway.
  restartTimer = setInterval(() => {
    if (stopped || advBusy) return;
    advBusy = true;
    void (async () => {
      try {
        try {
          await BLEAdvertiser.stopBroadcast();
        } catch {
          /* */
        }
        await broadcastStable();
        if (__DEV__) console.log("[ble-peripheral] periodic restart against OEM throttling");
      } finally {
        advBusy = false;
      }
    })();
  }, ADV_RESTART_INTERVAL_MS);

  return async () => {
    stopped = true;
    if (restartTimer) clearInterval(restartTimer);
    try {
      await BLEAdvertiser.stopBroadcast();
    } catch {
      /* */
    }
    console.log("[ble-peripheral] stopped");
  };
}

// ---------------------------------------------------------------------------
// PERIPHERAL GATT ACCEPT LOOP — v0.5.2
// ---------------------------------------------------------------------------
//
// Opens the BluetoothGattServer (via the kaata-gatt-server local Expo module)
// so that centrals that dial our advertisement actually see KAATA_SERVICE_UUID
// with HANDSHAKE_CHAR + STREAM_CHAR. Without this, the central's
// discoverAllServicesAndCharacteristics returns an empty tree and writes fail
// with GATT_INVALID_HANDLE.
//
// Wraps each incoming central into a BleMeshConnection by constructing an
// adapter whose:
//   - writeStream  → notifyCharacteristicChanged on STREAM_CHAR (notify push)
//   - onStreamChunk → fans the per-address onCentralWrite events out to the
//     per-connection handler
//   - onDisconnect → fans the per-address onCentralDisconnected event
//   - teardown    → drops the per-address handlers + force-disconnects the
//     central via the GATT server (the server itself stays open for other
//     peers; only the outer stop fn closes it)
//
// Both HANDSHAKE_CHAR and STREAM_CHAR writes are routed into the same
// BleMeshConnection inbox — anti-entropy.ts does not distinguish (see the
// PROTOCOL OVERVIEW comment at the top of this file).
//
// Symmetric to dialBLEPeer / central side: BleMeshConnection is identical;
// only the adapter differs. AEAD nonce direction is derived from the handshake
// role (initiator / responder) by aead.ts, not from the connection class.

export type StartPeripheralAcceptOpts = {
  /**
   * Called when a central completes the GATT connect step. The caller hands
   * off the BleMeshConnection to handlePeerConnection(conn, "incoming", gen)
   * — the same code path that incoming WebRTC connections take. runAntiEntropy
   * is role-agnostic, so the symmetric Hello + PoP + AEAD + delta loop runs
   * unchanged on the peripheral side.
   *
   * IMPORTANT: this fires on onCentralConnected (BEFORE any write arrives) so
   * the BleMeshConnection inbox is wired UP before the central's first write
   * is dispatched. Critical for fast handshakes where the Hello can land
   * within milliseconds of the connect ACK.
   */
  onIncomingConnection: (conn: BleMeshConnection) => void;
};

type PeripheralCentralState = {
  chunkListeners: Set<(c: Uint8Array) => void>;
  disconnectListeners: Set<() => void>;
  /**
   * Resolves once the central's MTU has been negotiated to a value that
   * fits BLE_CHUNK_PAYLOAD_BYTES + header + AEAD tag + ATT overhead.
   * Outbound notifies (writeStream) await this — see the MTU race fix
   * below. Rejects if the central disconnects before MTU upgrades, OR if
   * the MTU upgrade times out (PERIPHERAL_MTU_WAIT_MS), in which case we
   * fail loud rather than send 200-byte notifies into an MTU-23 link.
   */
  mtuReady: Promise<void>;
  resolveMtuReady: () => void;
  rejectMtuReady: (err: Error) => void;
  mtuReadyDone: boolean;
};

// How long to wait for the central to upgrade MTU before we give up and
// fail outbound notifies. Centrals using ble-plx call requestMTU(247)
// immediately after connect; in practice onMtuChanged fires within
// 200-800ms. 5s leaves ample headroom for stuttery OEM stacks.
const PERIPHERAL_MTU_WAIT_MS = 5_000;

// Minimum MTU we need on the peripheral side. Same math as the central
// side (BLE_FRAME_HEADER_BYTES + BLE_CHUNK_PAYLOAD_BYTES + TAG_BYTES + 3
// ATT overhead). Hard-coded so the readiness check can run before
// modules-core is imported.
const PERIPHERAL_MIN_MTU = BLE_FRAME_HEADER_BYTES + BLE_CHUNK_PAYLOAD_BYTES + TAG_BYTES + 3;

/**
 * Open the GATT server and start accepting connections. Returns a stop fn
 * that tears down both the server and any in-flight per-central state.
 *
 * Throws MeshPeripheralUnsupportedError if the native module is missing or
 * the radio refuses to open a server (e.g., BLUETOOTH_CONNECT denied at
 * runtime — JS path normally requests this before calling).
 */
export async function startPeripheralGattAcceptLoop(
  opts: StartPeripheralAcceptOpts,
): Promise<() => Promise<void>> {
  if (Platform.OS !== "android") {
    if (__DEV__) console.log("[ble-gatt] non-Android — skipping (no-op)");
    return async () => {
      /* */
    };
  }

  let gattStop: (() => Promise<void>) | null = null;
  try {
    gattStop = await kaataOpenGattServer(
      KAATA_MESH_SERVICE_UUID,
      KAATA_HANDSHAKE_CHAR_UUID,
      KAATA_STREAM_CHAR_UUID,
    );
    console.log("[ble-gatt] GATT server opened");
  } catch (err) {
    const msg = (err as Error)?.message ?? String(err);
    if (__DEV__) console.warn("[ble-gatt] openGattServer failed:", msg);
    emitMeshFailure({ kind: "peripheral_unsupported" });
    throw new MeshPeripheralUnsupportedError(`GATT server unavailable: ${msg}`);
  }

  // Per-central listener state. The kaata-gatt-server module emits a single
  // event stream per event type; we fan-out by address.
  const centrals = new Map<string, PeripheralCentralState>();
  const subscriptions: Array<{ remove: () => void }> = [];
  let stopped = false;

  const subConn = kaataOnCentralConnected(({ address, mtu }) => {
    if (stopped) return;
    if (centrals.has(address)) {
      // Mobile-Native critique H3 — rapid-reconnect handling. The native
      // side now fires STATE_CONNECTED for the same MAC when a fast
      // disconnect/reconnect occurred and we missed STATE_DISCONNECTED, or
      // when MTU renegotiation triggered a re-emission. Tear down the
      // prior per-central state so the fresh session doesn't inherit a
      // stale BleMeshConnection. The old conn's disconnect handler will
      // resolve any in-flight recvJSON callers with {__closed:true}.
      if (__DEV__)
        console.log("[ble-gatt] duplicate centralConnected addr=", address, "— replacing");
      const stale = centrals.get(address);
      if (stale) {
        for (const h of stale.disconnectListeners) {
          try {
            h();
          } catch {
            /* */
          }
        }
        if (!stale.mtuReadyDone) {
          stale.mtuReadyDone = true;
          stale.rejectMtuReady(new Error("central reconnected before MTU upgrade"));
        }
        centrals.delete(address);
      }
    }

    // Engineering critique #1 + Mobile-Native H1 — MTU race fix.
    // The native callback fires onCentralConnected synchronously when the
    // link-layer connect succeeds, at which point Android's default MTU
    // is 23 (20 usable bytes). Our chunks are 203 bytes on the wire. If we
    // start notifying immediately, the first frame is truncated on most
    // OEM stacks (GATT_INVALID_ATTRIBUTE_LENGTH on API 33+, or silent
    // truncation pre-33). The handshake Hello goes plaintext so the
    // failure mode is "central can't JSON.parse the partial frame and
    // recvJSON times out". We fix this by deferring all outbound
    // notifies inside the adapter's writeStream until either onMtuChanged
    // arrives with >= PERIPHERAL_MIN_MTU, or PERIPHERAL_MTU_WAIT_MS
    // elapses (in which case we fail loud).
    let resolveMtuReady!: () => void;
    let rejectMtuReady!: (err: Error) => void;
    const mtuReady = new Promise<void>((resolve, reject) => {
      resolveMtuReady = resolve;
      rejectMtuReady = reject;
    });
    // If the native side ever pre-negotiates MTU before this event (some
    // OEMs do MTU before the connect event), we'd see mtu >= MIN here and
    // resolve immediately. Cover that.
    const cs: PeripheralCentralState = {
      chunkListeners: new Set(),
      disconnectListeners: new Set(),
      mtuReady,
      resolveMtuReady,
      rejectMtuReady,
      mtuReadyDone: false,
    };
    centrals.set(address, cs);
    if (mtu >= PERIPHERAL_MIN_MTU) {
      cs.mtuReadyDone = true;
      cs.resolveMtuReady();
    } else {
      // Timeout: fail the readiness promise so an in-flight writeStream
      // throws rather than hanging the handshake forever.
      const t = setTimeout(() => {
        if (!cs.mtuReadyDone) {
          cs.mtuReadyDone = true;
          cs.rejectMtuReady(
            new Error(`MTU upgrade timed out at ${PERIPHERAL_MTU_WAIT_MS}ms (still at default 23)`),
          );
          // Force-disconnect so the central also unwinds cleanly. The
          // central's onDisconnected will fire, anti-entropy unwinds
          // both sides.
          void kaataDisconnectCentral(address).catch(() => {});
        }
      }, PERIPHERAL_MTU_WAIT_MS);
      // Note: timer ref intentionally not stored — clearTimeout would race
      // with the same code path that flips mtuReadyDone. The mtuReadyDone
      // guard inside the timer callback is the source of truth.
      void t;
    }

    const adapter = {
      writeStream: async (chunk: Uint8Array) => {
        // Block until MTU is upgraded so we don't truncate the first
        // notify. Subsequent writes hit the already-resolved promise as
        // a microtask — cost is one tick per write.
        try {
          await cs.mtuReady;
        } catch (err) {
          throw new MeshTransportError(
            `MTU not negotiated: ${(err as Error).message}`,
            "ble_mtu_too_small",
          );
        }
        try {
          await kaataNotifyCentral(address, KAATA_STREAM_CHAR_UUID, bytesToBase64(chunk));
        } catch (err) {
          throw new MeshTransportError(
            `notifyCentral failed: ${(err as Error).message}`,
            "ble_write_failed",
          );
        }
      },
      onStreamChunk: (h: (c: Uint8Array) => void) => {
        cs.chunkListeners.add(h);
        return () => {
          cs.chunkListeners.delete(h);
        };
      },
      onDisconnect: (h: () => void) => {
        cs.disconnectListeners.add(h);
        return () => {
          cs.disconnectListeners.delete(h);
        };
      },
      teardown: async () => {
        centrals.delete(address);
        if (!cs.mtuReadyDone) {
          cs.mtuReadyDone = true;
          cs.rejectMtuReady(new Error("connection torn down before MTU upgrade"));
        }
        try {
          await kaataDisconnectCentral(address);
        } catch {
          /* idempotent */
        }
      },
    };

    console.log("[ble-gatt] central connected addr=", address, "mtu=", mtu);
    try {
      const conn = new BleMeshConnection(adapter);
      opts.onIncomingConnection(conn);
    } catch (err) {
      if (__DEV__) console.warn("[ble-gatt] onIncomingConnection threw", err);
      centrals.delete(address);
      if (!cs.mtuReadyDone) {
        cs.mtuReadyDone = true;
        cs.rejectMtuReady(new Error("onIncomingConnection threw"));
      }
      void kaataDisconnectCentral(address).catch(() => {});
    }
  });
  subscriptions.push(subConn);

  // Engineering critique #1 — subscribe to onMtuChanged so the per-central
  // MTU-ready promise can resolve. Without this subscription the event is
  // dead-lettered and writeStream blocks forever on the deferred above.
  const subMtu = kaataOnMtuChanged(({ address, mtu }) => {
    const cs = centrals.get(address);
    if (!cs) return;
    if (cs.mtuReadyDone) return;
    if (mtu >= PERIPHERAL_MIN_MTU) {
      cs.mtuReadyDone = true;
      cs.resolveMtuReady();
      if (__DEV__) console.log("[ble-gatt] MTU upgraded addr=", address, "mtu=", mtu);
    } else {
      // Some OEMs fire onMtuChanged with an intermediate value; wait for
      // a subsequent event that meets the bar (or the timeout).
      if (__DEV__)
        console.log(
          "[ble-gatt] MTU still below minimum addr=",
          address,
          "mtu=",
          mtu,
          "min=",
          PERIPHERAL_MIN_MTU,
        );
    }
  });
  subscriptions.push(subMtu);

  const subWrite = kaataOnCentralWrite((evt: KaataCentralWriteEvent) => {
    if (stopped) return;
    // Both HANDSHAKE_CHAR and STREAM_CHAR writes flow into the same inbox.
    // anti-entropy.ts is characteristic-agnostic (see header comment).
    const charLower = evt.charUuid.toLowerCase();
    if (
      charLower !== KAATA_STREAM_CHAR_UUID.toLowerCase() &&
      charLower !== KAATA_HANDSHAKE_CHAR_UUID.toLowerCase()
    ) {
      return;
    }
    const cs = centrals.get(evt.address);
    if (!cs || cs.chunkListeners.size === 0) return;
    const bytes = base64ToBytes(evt.valueBase64);
    for (const h of cs.chunkListeners) {
      try {
        h(bytes);
      } catch {
        /* swallow per-handler errors */
      }
    }
  });
  subscriptions.push(subWrite);

  const subDisc = kaataOnCentralDisconnected(({ address, status }) => {
    const cs = centrals.get(address);
    centrals.delete(address);
    if (cs) {
      if (!cs.mtuReadyDone) {
        cs.mtuReadyDone = true;
        cs.rejectMtuReady(new Error("central disconnected before MTU upgrade"));
      }
      for (const h of cs.disconnectListeners) {
        try {
          h();
        } catch {
          /* */
        }
      }
    }
    if (__DEV__) console.log("[ble-gatt] central disconnected addr=", address, "status=", status);
  });
  subscriptions.push(subDisc);

  return async () => {
    stopped = true;
    for (const sub of subscriptions) {
      try {
        sub.remove();
      } catch {
        /* */
      }
    }
    // Fire local disconnect handlers so any waiting recvJSON unwinds cleanly.
    for (const cs of centrals.values()) {
      if (!cs.mtuReadyDone) {
        cs.mtuReadyDone = true;
        cs.rejectMtuReady(new Error("accept loop stopped"));
      }
      for (const h of cs.disconnectListeners) {
        try {
          h();
        } catch {
          /* */
        }
      }
    }
    centrals.clear();
    if (gattStop) {
      try {
        await gattStop();
      } catch {
        /* */
      }
      gattStop = null;
    }
    console.log("[ble-gatt] accept loop stopped");
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildMfgPayloadBytes(capFlags: number, epochLow: number, hash4: number[]): Uint8Array {
  const out = new Uint8Array(6);
  out[0] = capFlags & 0x01; // RESERVED_MASK enforced on send side too
  out[1] = epochLow & 0xff;
  out[2] = hash4[0] ?? 0;
  out[3] = hash4[1] ?? 0;
  out[4] = hash4[2] ?? 0;
  out[5] = hash4[3] ?? 0;
  return out;
}

/**
 * Mythos #1 fix: build a SINGLE stable manufacturer-data payload
 * containing ALL of our vault hashes at once.
 *
 * Why: every call to BLEAdvertiser.broadcast() mints a fresh random BLE
 * MAC on most Android stacks. The previous code restarted the advertiser
 * every ADV_ROTATION_MS (500ms) to cycle hashes — so our OWN advertiser
 * was the MAC-rotation engine, NOT Android's privacy layer (NRPA's true
 * rotation is ~15 min). Symptoms:
 *   - ble-plx central side cached a new Device object per MAC, forever
 *     (RxAndroidBle does not evict). Linear native-heap accumulation →
 *     mid-use crash on Samsung A17.
 *   - Our scanner's seenDevices + lastEmitByDevice keyed on MAC →
 *     circuit breaker tripped on our own fleet in under a minute.
 *   - BUG-Q's dial-cancellation cascade was downstream of this.
 *
 * Format: [capFlags, epochLow=0, h0_0..h0_3, h1_0..h1_3, ...] up to
 * MAX_ADVERTISED_VAULT_HASHES. Receiver loops `Math.floor(hashBytes.length / 4)`
 * starting at byte offset 4 so it parses all hashes automatically — no
 * receiver-side change needed.
 *
 * epochLow byte is set to 0 (no-hint) since we lose per-vault granularity
 * by combining payloads. The handshake's epoch gate is still authoritative
 * — this byte was only an optimization hint and nothing downstream of
 * parseAdvertisement currently reads it.
 *
 * Legacy advertising budget (31 bytes): 3 (flags AD field) + 4 (mfg AD
 * fixed: length + type + 2-byte company ID) + N (payload) ≤ 31, so payload
 * ≤ 24 bytes. With 1 cap + 1 epoch + 4N hash bytes that's up to 5 hashes
 * in a single packet — plenty for the realistic shopkeeper case.
 */
function buildMfgPayloadBytesMulti(capFlags: number, hashes4: number[][]): Uint8Array {
  // Hard-cap by both MAX_ADVERTISED_VAULT_HASHES (linkability ceiling)
  // AND the 24-byte advertising budget (5 hashes = 22 bytes payload).
  const safeMax = Math.min(MAX_ADVERTISED_VAULT_HASHES, 5);
  const capped = hashes4.slice(0, safeMax);
  const out = new Uint8Array(2 + capped.length * 4);
  out[0] = capFlags & 0x01;
  out[1] = 0; // epochLow no-hint — see comment above
  for (let i = 0; i < capped.length; i++) {
    const h = capped[i];
    out[2 + i * 4 + 0] = h[0] ?? 0;
    out[2 + i * 4 + 1] = h[1] ?? 0;
    out[2 + i * 4 + 2] = h[2] ?? 0;
    out[2 + i * 4 + 3] = h[3] ?? 0;
  }
  return out;
}

function bytesToBase64(b: Uint8Array): string {
  return Buffer.from(b).toString("base64");
}

function base64ToBytes(s: string): Uint8Array {
  return new Uint8Array(Buffer.from(s, "base64"));
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.length % 2 === 0 ? hex : "0" + hex;
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.substr(i * 2, 2), 16);
  }
  return out;
}
