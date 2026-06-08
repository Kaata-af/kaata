// apps/mobile/lib/mesh/transport-ble.ts
//
// Phase 6: BLE transport for mesh sync. Scaffolds the GATT-based
// MeshConnection over react-native-ble-plx (central role) + a future
// peripheral library (TODO — see PERIPHERAL_TODO below).
//
// ---------------------------------------------------------------------------
// PROTOCOL OVERVIEW
// ---------------------------------------------------------------------------
//
// Service UUID (128-bit, randomly generated for Kaata — registered nowhere
// because we own both ends):
//   KAATA_MESH_SERVICE_UUID = "6b616174-6133-4d65-7368-000000000001"
//                               (k a a t  a 3   Me     s h     v1)
//
// Characteristics:
//   HANDSHAKE_CHAR  (write-without-response from central, indicate from
//                    peripheral) — carries the framed VMC handshake + PoP +
//                    NOISE-IK-style X25519 ECDH exchange. STREAM_CHAR writes
//                    are REFUSED until handshake+PoP+key-derivation completes
//                    (see C3 of security critique).
//   STREAM_CHAR     (write-without-response both directions) — AEAD-encrypted
//                    framed JSON payloads after the handshake completes.
//
// We use 128-bit service UUIDs (not 16-bit) because Android only reliably
// advertises 128-bit custom UUIDs in the primary advertising payload. 31-byte
// adv budget breakdown:
//   - 3 B  flags
//   - 18 B service-UUID (16 raw + AD-type/length)
//   - 1 B  capability flags byte (bit 0 = supports wifi upgrade,
//          bits 1-7 RESERVED — see comment below)
//   - 1 B  vault_epoch hint (low 8 bits)
//   - 8 B  manufacturer-specific data wrapper
//   → leaves ~14 B inside manufacturer payload for vault-hash prefixes:
//     2 × 4-byte vault hashes is the safe ceiling. Beyond 2 we use the
//     31-byte scan response packet (also 31 B) for a second batch — total
//     ceiling ~5 hashes. See M2 below.
//
// SECURITY POSTURE — CRITICAL OPEN ITEM (Phase 6 follow-up):
//   The BLE link layer is NOT encrypted unless OS-level pairing/bonding is
//   used. Kaata uses UNPAIRED GATT (no OS "Pair this device?" dialog), so
//   ledger data crosses this transport IN CLEARTEXT today. Anti-entropy
//   ships full event payloads — debt amounts, person names, vault_ids —
//   over a $30-nRF-sniffable channel.
//
//   This file is structured to accept an application-layer AEAD layer
//   (X25519 ECDH between the two device_pubkeys that the VMC already
//   authenticates → HKDF-SHA512 → ChaCha20-Poly1305 per-frame) — see the
//   `encryptFrame` / `decryptFrame` hooks below. The actual key derivation
//   and AEAD impl is queued for the next sub-phase; until then this module
//   uses null-AEAD framing and HEADER_VERSION_BLE = 0 so a future flag-day
//   can bump to 1 with AEAD enabled.
//
//   --- DO NOT SHIP TO PRODUCTION UNTIL EITHER:
//   ---   (a) bonded BLE is chosen (with OS pair dialog UX cost), OR
//   ---   (b) the X25519+ChaCha20-Poly1305 layer below is implemented.
//   --- The export `BLE_TRANSPORT_PRODUCTION_READY` below is the gate.
//
// ---------------------------------------------------------------------------
// FRAMING (BLE-specific, distinct from WebRTC's framing in transport.ts)
// ---------------------------------------------------------------------------
//
// BLE characteristics deliver bytes in MTU-sized chunks (~244 B on a
// negotiated 247-MTU link; 20 B on the 23-MTU minimum). NOTIFY operations
// on a single characteristic are ORDERED on a per-link basis, but writes
// from multiple centrals to the same peripheral characteristic are NOT
// inherently ordered. We frame every logical message with:
//
//   <2-byte frame_id><1-byte chunk_index><1-byte chunk_count>
//   <2-byte payload_length><payload bytes...>
//
// The receiver reassembles per (frame_id) and emits when chunk_index ==
// chunk_count - 1 AND all prior indices have arrived. Frames older than
// FRAME_ASSEMBLY_TIMEOUT_MS are GC'd to bound memory. This is strictly
// more defensive than the WebRTC framing (which can rely on SCTP ordering)
// and matches the engineering critique's "frame_id + chunk_index + total"
// requirement.

import { MeshTransportError } from "./errors";
import type { MeshConnection } from "./transport-interface";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const KAATA_MESH_SERVICE_UUID = "6b616174-6133-4d65-7368-000000000001";
export const KAATA_HANDSHAKE_CHAR_UUID = "6b616174-6133-4d65-7368-000000000002";
export const KAATA_STREAM_CHAR_UUID = "6b616174-6133-4d65-7368-000000000003";

// Conservative chunk size — most Android stacks negotiate ATT_MTU 247
// (244 usable bytes), but a healthy 22 leaves headroom for our own header
// (7 bytes) without bumping into the MTU ceiling on under-spec'd phones.
export const BLE_CHUNK_PAYLOAD_BYTES = 180;
export const BLE_FRAME_HEADER_BYTES = 7;
export const MAX_BLE_FRAME_BYTES = 1 * 1024 * 1024; // 1MB hard ceiling
export const FRAME_ASSEMBLY_TIMEOUT_MS = 30_000;

// Capability-flags byte semantics. Bit 0 is the only currently-defined bit;
// bits 1-7 are EXPLICITLY RESERVED. Do NOT use them to leak owner-role
// hints, vault role, or any other identity signal — that's a targeting
// signal for theft. The VMC already carries the role and is exchanged only
// after the GATT connection is established.
export const CAP_FLAG_SUPPORTS_WIFI_UPGRADE = 0x01;
export const CAP_FLAGS_RESERVED_MASK = 0xfe; // bits 1-7 — DO NOT USE

// Cap on vault-hash prefixes advertised in BLE manufacturer data. Bounds
// the linkability surface (each 4-byte hash is enumerable in nearby attack
// — acceptable per Phase 5 design since Shop Mode is opt-in) AND keeps us
// within the 31-byte advertising payload budget. See header comment.
export const MAX_ADVERTISED_VAULT_HASHES = 3;

/**
 * Hard gate: set to true only after the BLE wire-encryption design lands
 * (see CRITICAL OPEN ITEM in the header). Until then, MeshController will
 * keep this transport from being selected as the primary in production
 * builds. Engineering scaffolding is allowed to flow regardless.
 */
export const BLE_TRANSPORT_PRODUCTION_READY = false;

// ---------------------------------------------------------------------------
// AEAD HOOKS — Phase 6 follow-up
// ---------------------------------------------------------------------------

/**
 * Per-session AEAD context. Populated after the handshake derives a shared
 * secret from (own_device_privkey × peer_device_pubkey) → HKDF-SHA512.
 *
 * Today this is a placeholder; encryptFrame/decryptFrame are pass-through
 * when `null`. The structure is in place so the bump-from-v0-to-v1 work is
 * just "fill in the key + cipher".
 */
export type BleAeadContext = {
  // 32-byte ChaCha20-Poly1305 key derived from HKDF-SHA512.
  key: Uint8Array;
  // Monotonic 12-byte nonce — 8-byte big-endian counter, 4-byte direction
  // domain. Resets per session. Replay-window enforcement at the receiver.
  sendCounter: bigint;
  recvLastCounter: bigint;
};

function encryptFrame(payload: Uint8Array, aead: BleAeadContext | null): Uint8Array {
  if (!aead) return payload; // TODO Phase 6 follow-up: enforce AEAD always
  // Placeholder: implement ChaCha20-Poly1305 over (payload, nonce=counter,
  // aad=KAATA_MESH_SERVICE_UUID-bytes). See @noble/ciphers or
  // expo-crypto's coming AES-GCM support.
  return payload;
}

function decryptFrame(framed: Uint8Array, aead: BleAeadContext | null): Uint8Array | null {
  if (!aead) return framed;
  return framed; // TODO Phase 6 follow-up
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

function packFrame(frameId: number, payload: Uint8Array): Uint8Array[] {
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
    const buf = new Uint8Array(BLE_FRAME_HEADER_BYTES + slice.length);
    buf[0] = (frameId >>> 8) & 0xff;
    buf[1] = frameId & 0xff;
    buf[2] = i & 0xff;
    buf[3] = total & 0xff;
    buf[4] = (payload.length >>> 16) & 0xff;
    buf[5] = (payload.length >>> 8) & 0xff;
    buf[6] = payload.length & 0xff;
    buf.set(slice, BLE_FRAME_HEADER_BYTES);
    chunks.push(buf);
  }
  return chunks;
}

function parseHeader(
  chunk: Uint8Array,
): { frameId: number; idx: number; total: number; len: number; payload: Uint8Array } | null {
  if (chunk.length < BLE_FRAME_HEADER_BYTES) return null;
  const frameId = (chunk[0] << 8) | chunk[1];
  const idx = chunk[2];
  const total = chunk[3];
  const len = (chunk[4] << 16) | (chunk[5] << 8) | chunk[6];
  if (total === 0) return null;
  if (idx >= total) return null;
  if (len > MAX_BLE_FRAME_BYTES) return null;
  return {
    frameId,
    idx,
    total,
    len,
    payload: chunk.subarray(BLE_FRAME_HEADER_BYTES),
  };
}

// ---------------------------------------------------------------------------
// BLE MeshConnection (skeleton)
// ---------------------------------------------------------------------------

/**
 * BLE-backed MeshConnection. Constructed by the BLE central after GATT
 * connect + characteristic discover + (future) handshake-then-key-derive.
 *
 * The actual react-native-ble-plx `Device` / `Characteristic` are passed
 * in via the adapter object — this class stays testable without the
 * native module by being a pure protocol implementation over the adapter.
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
    const unsubDisc = this.adapter.onDisconnect(() => this.markClosed());
    this.assemblyGcTimer = setInterval(() => this.gcAssembly(), 5_000);
    // Cleanup hook stored so close() can drop both subscriptions.
    (this as unknown as { __unsubChunk: () => void }).__unsubChunk = unsubChunk;
    (this as unknown as { __unsubDisc: () => void }).__unsubDisc = unsubDisc;
  }

  /**
   * Inject the AEAD context once the handshake has derived a shared key.
   * Until this is called the connection is in "handshake mode" — only
   * the handshake messages may flow. STREAM_CHAR writes from a peer that
   * haven't yet completed the handshake must be enforced server-side by
   * the peripheral (TODO peripheral implementation).
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
    entry.chunks.set(hdr.idx, hdr.payload);
    if (entry.chunks.size < entry.total) return;
    // All chunks present — assemble in order.
    const out = new Uint8Array(entry.expectedLength);
    let cursor = 0;
    for (let i = 0; i < entry.total; i++) {
      const c = entry.chunks.get(i);
      if (!c) return; // partial — bail; GC will clean up
      const take = Math.min(c.length, entry.expectedLength - cursor);
      out.set(c.subarray(0, take), cursor);
      cursor += take;
    }
    this.assembly.delete(hdr.frameId);
    const decrypted = decryptFrame(out, this.aead);
    if (!decrypted) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder("utf-8").decode(decrypted));
    } catch {
      return;
    }
    const r = this.resolvers.shift();
    if (r) r(parsed);
    else this.inbox.push(parsed);
  }

  private gcAssembly(): void {
    const cutoff = Date.now() - FRAME_ASSEMBLY_TIMEOUT_MS;
    for (const [id, entry] of this.assembly) {
      if (entry.receivedAt < cutoff) {
        this.assembly.delete(id);
      }
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
  }

  async sendJSON(obj: unknown): Promise<void> {
    if (this.closed) {
      throw new MeshTransportError("sendJSON on closed BLE connection");
    }
    const payload = new TextEncoder().encode(JSON.stringify(obj));
    const enc = encryptFrame(payload, this.aead);
    const frameId = this.outFrameId++ & 0xffff;
    const chunks = packFrame(frameId, enc);
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
// PERIPHERAL_TODO
// ---------------------------------------------------------------------------
//
// react-native-ble-plx 3.x supports CENTRAL mode (scan, connect to peers,
// read/write/notify their characteristics). It does NOT support PERIPHERAL
// mode (advertise our own service + serve our own characteristics). Phase
// 6's protocol REQUIRES peripheral mode on both phones — each phone needs
// to advertise its capability/vault-hashes and serve a HANDSHAKE_CHAR +
// STREAM_CHAR.
//
// Options for the follow-up phase:
//   (a) react-native-ble-advertiser (3rd party, MIT) — covers advertising
//       but not GATT-server. We'd still need a custom Kotlin module for
//       GattServer. Most credible path.
//   (b) Custom native module wrapping Android's BluetoothLeAdvertiser +
//       BluetoothGattServer APIs end-to-end. ~600 LOC Kotlin. Most control.
//   (c) Dual-central rendezvous: both phones scan, neither advertises,
//       handshake via mutual scan-callback timing. Fragile, doesn't work
//       on phones in pocket. Not recommended.
//
// On OEMs where BluetoothAdapter.isMultipleAdvertisementSupported()
// returns false (common on MediaTek-chipped phones in the AF market),
// Kaata must surface a clear "this phone can't broadcast" message
// rather than silently fail. The toast i18n key
// `menu.ble.unsupported` is wired for this.
//
// The shape `MeshConnection` exposed here is intentionally agnostic of
// central vs peripheral — both sides expose the same sendJSON/recvJSON.
// The adapter passed to BleMeshConnection abstracts the underlying GATT
// role. Peripheral implementation will plug its own writeStream / chunk
// listeners into the same surface.
