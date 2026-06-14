// apps/mobile/lib/mesh/transport-btc.ts
//
// Bluetooth Classic (insecure RFCOMM) transport — the Briar approach, and the
// replacement for the failed hand-rolled BLE peripheral/GATT path. An RFCOMM
// BluetoothSocket is a reliable ordered bidirectional byte stream ("TCP over
// Bluetooth"), so this is a NEAR-COPY of transport-lan.ts: same 4-byte length +
// 7-byte AAD-header framing, same aead.ts seal/open, kind="btc". The handshake
// (Hello/PoP), AEAD install, and anti-entropy delta loop run UNCHANGED on top —
// that reuse is the whole point of the pivot.
//
// The byte stream is fed by the kaata-bt-classic native Expo module, whose
// events are GLOBAL (one onRfcommData/onRfcommClosed stream for all sockets),
// so we fan them out per socketId via a small registry that ALSO buffers any
// bytes that arrive before the BtcMeshConnection registers its handler (the
// native reader thread starts the instant a socket connects/accepts).
//
// Framing rationale + the 16 MiB OOM cap are identical to transport-lan.ts —
// see that file's header for the full description.

import { Buffer } from "buffer";

import { MeshTransportError, emitMeshFailure } from "./errors";
import type { MeshConnection } from "./transport-interface";
import {
  MeshAeadError,
  sealChunk,
  openChunk,
  TAG_BYTES,
  type BleAeadContext as AeadCtx,
} from "./aead";
import {
  closeRfcomm,
  connectRfcomm,
  onDeviceFound,
  onDiscoveryFinished,
  onRfcommAccepted,
  onRfcommClosed,
  onRfcommData,
  openRfcommServer,
  startClassicDiscovery,
  stopClassicDiscovery,
  stopRfcommServer,
  writeRfcomm,
} from "../../modules/kaata-bt-classic";
import { sha256 } from "@noble/hashes/sha2";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const BTC_FRAME_HEADER_BYTES = 7;
export const MAX_BTC_PLAINTEXT_BYTES = 0xffffff;
export const MAX_BTC_FRAME_BYTES = BTC_FRAME_HEADER_BYTES + MAX_BTC_PLAINTEXT_BYTES + TAG_BYTES;

// Fixed dev service UUID for milestone M-BTC-1 (skips discovery + per-vault
// rotation). M-BTC-2 derives a per-(vault,day) UUID from lib/mesh/vault-digest.
export const KAATA_BTC_DEV_UUID = "6b616174-6233-4d65-7368-000000000001";

export type BtcAeadContext = AeadCtx;

/**
 * The transport seam (mirrors LanSocketAdapter). The native side feeds it via
 * the kaata-bt-classic per-socket event registry below.
 */
export interface BtcSocketAdapter {
  write(bytes: Uint8Array): void | Promise<void>;
  onData(handler: (bytes: Uint8Array) => void): void;
  onClose(handler: () => void): void;
  destroy(): void;
}

// ---------------------------------------------------------------------------
// Framing helpers (identical to transport-lan.ts)
// ---------------------------------------------------------------------------

function readBE32(buf: Uint8Array, off: number): number {
  return ((buf[off] << 24) | (buf[off + 1] << 16) | (buf[off + 2] << 8) | buf[off + 3]) >>> 0;
}

function readBE24(buf: Uint8Array, off: number): number {
  return (buf[off] << 16) | (buf[off + 1] << 8) | buf[off + 2];
}

function buildHeader(frameId: number, plaintextLen: number): Uint8Array {
  const h = new Uint8Array(BTC_FRAME_HEADER_BYTES);
  h[0] = (frameId >>> 8) & 0xff;
  h[1] = frameId & 0xff;
  h[2] = 0; // chunk_index — RFCOMM carries the whole message in one frame
  h[3] = 1; // chunk_count
  h[4] = (plaintextLen >>> 16) & 0xff;
  h[5] = (plaintextLen >>> 8) & 0xff;
  h[6] = plaintextLen & 0xff;
  return h;
}

// ---------------------------------------------------------------------------
// BTC MeshConnection
// ---------------------------------------------------------------------------

/**
 * RFCOMM-backed MeshConnection. Pure protocol over the injected adapter — no
 * native dependency in the class itself, so it shares the LAN transport's
 * test-seam shape. Constructed by dialBtcPeer (outbound) and the listener's
 * onConnection (inbound).
 */
export class BtcMeshConnection implements MeshConnection {
  readonly kind = "btc" as const;
  remoteDeviceId: string | null = null;
  /**
   * Dev/test escape hatch: when true, a socket close does NOT emit a global
   * mesh-failure toast. Set by the M-BTC dev screen, which runs a raw byte-pipe
   * ping/pong with NO AEAD/handshake — so a perfectly normal close would
   * otherwise be misclassified as a pre-handshake transport failure. Unused
   * (false) on the real mesh path.
   */
  suppressFailures = false;
  private closed = false;
  private inbox: unknown[] = [];
  private resolvers: ((v: unknown) => void)[] = [];
  private aead: BtcAeadContext | null = null;
  private outFrameId = 0;
  private recvBuf: Uint8Array = new Uint8Array(0);

  constructor(private adapter: BtcSocketAdapter) {
    this.adapter.onData((bytes) => this.onData(bytes));
    this.adapter.onClose(() => this.onSocketClose());
  }

  installAead(ctx: BtcAeadContext): void {
    this.aead = ctx;
  }

  isOpen(): boolean {
    return !this.closed;
  }

  // --- inbound -------------------------------------------------------------

  private onData(bytes: Uint8Array): void {
    if (this.closed) return;
    if (bytes.length === 0) return;
    const merged = new Uint8Array(this.recvBuf.length + bytes.length);
    merged.set(this.recvBuf, 0);
    merged.set(bytes, this.recvBuf.length);
    this.recvBuf = merged;
    this.drainFrames();
  }

  private drainFrames(): void {
    for (;;) {
      if (this.closed) return;
      if (this.recvBuf.length < 4) return;
      const frameLen = readBE32(this.recvBuf, 0);
      if (frameLen < BTC_FRAME_HEADER_BYTES || frameLen > MAX_BTC_FRAME_BYTES) {
        if (__DEV__) console.warn("[btc.transport] bad frame_len", frameLen, "— closing");
        emitMeshFailure({ kind: "peer_dropped_midsync" });
        this.markClosed();
        return;
      }
      if (this.recvBuf.length < 4 + frameLen) return;
      const frame = this.recvBuf.subarray(4, 4 + frameLen);
      this.handleFrame(frame);
      if (this.closed) return;
      this.recvBuf = this.recvBuf.slice(4 + frameLen);
    }
  }

  private handleFrame(frame: Uint8Array): void {
    const header = frame.subarray(0, BTC_FRAME_HEADER_BYTES);
    const body = frame.subarray(BTC_FRAME_HEADER_BYTES);
    const declaredPlainLen = readBE24(header, 4);

    let plaintext: Uint8Array;
    if (this.aead) {
      try {
        plaintext = openChunk(body, header, this.aead);
      } catch (err) {
        if (err instanceof MeshAeadError) {
          if (__DEV__) console.warn("[btc.transport] AEAD open failed:", err.code, err.message);
          emitMeshFailure({ kind: "peer_decrypt_failed" });
          this.markClosed();
          return;
        }
        throw err;
      }
    } else {
      plaintext = body;
    }

    if (plaintext.length !== declaredPlainLen) {
      if (__DEV__)
        console.warn(
          "[btc.transport] length mismatch hdr=",
          declaredPlainLen,
          "actual=",
          plaintext.length,
          "— closing",
        );
      emitMeshFailure({ kind: "peer_dropped_midsync" });
      this.markClosed();
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder("utf-8").decode(plaintext));
    } catch {
      if (__DEV__) console.warn("[btc.transport] frame was not valid JSON — dropping");
      return;
    }
    const r = this.resolvers.shift();
    if (r) r(parsed);
    else this.inbox.push(parsed);
  }

  private onSocketClose(): void {
    if (this.closed) return; // already torn down (e.g. we called close())
    if (this.suppressFailures) {
      this.markClosed();
      return;
    }
    if (this.aead) {
      emitMeshFailure({ kind: "peer_dropped_midsync" });
    } else {
      emitMeshFailure({ kind: "peer_handshake_failed", reason: "transport" });
    }
    this.markClosed();
  }

  private markClosed(): void {
    if (this.closed) return;
    this.closed = true;
    for (const r of this.resolvers) {
      try {
        r({ __closed: true });
      } catch {
        /* */
      }
    }
    this.resolvers = [];
    this.recvBuf = new Uint8Array(0);
    if (__DEV__) console.log("[btc.transport] connection closed");
  }

  // --- outbound ------------------------------------------------------------

  async sendJSON(obj: unknown): Promise<void> {
    if (this.closed) {
      throw new MeshTransportError("sendJSON on closed BTC connection");
    }
    const plaintext = new TextEncoder().encode(JSON.stringify(obj));
    if (plaintext.length > MAX_BTC_PLAINTEXT_BYTES) {
      throw new MeshTransportError(
        `BTC message too large: ${plaintext.length} bytes > ${MAX_BTC_PLAINTEXT_BYTES}`,
        "msg_too_large",
      );
    }
    const frameId = this.outFrameId++ & 0xffff;
    const header = buildHeader(frameId, plaintext.length);
    const body = this.aead ? sealChunk(plaintext, header, this.aead) : plaintext;
    const frameLen = BTC_FRAME_HEADER_BYTES + body.length;
    const out = new Uint8Array(4 + frameLen);
    out[0] = (frameLen >>> 24) & 0xff;
    out[1] = (frameLen >>> 16) & 0xff;
    out[2] = (frameLen >>> 8) & 0xff;
    out[3] = frameLen & 0xff;
    out.set(header, 4);
    out.set(body, 4 + BTC_FRAME_HEADER_BYTES);
    try {
      await this.adapter.write(out);
    } catch (err) {
      throw new MeshTransportError(
        `BTC socket write failed: ${(err as Error).message}`,
        "btc_write_failed",
      );
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
        reject(new MeshTransportError(`BTC recvJSON timed out after ${timeoutMs}ms`, "timeout"));
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
      this.adapter.destroy();
    } catch {
      /* */
    }
  }
}

// ---------------------------------------------------------------------------
// Native socket registry (kaata-bt-classic) — fan out the GLOBAL onRfcommData /
// onRfcommClosed events per socketId, buffering bytes that arrive before a
// BtcMeshConnection registers its handler.
// ---------------------------------------------------------------------------

type Sink = {
  onData: ((b: Uint8Array) => void) | null;
  onClose: (() => void) | null;
  dataQueue: Uint8Array[];
  closedPending: boolean;
};

const sinks = new Map<string, Sink>();
let nativeWired = false;

function getSink(socketId: string): Sink {
  let s = sinks.get(socketId);
  if (!s) {
    s = { onData: null, onClose: null, dataQueue: [], closedPending: false };
    sinks.set(socketId, s);
  }
  return s;
}

function ensureNativeWired(): void {
  if (nativeWired) return;
  nativeWired = true;
  onRfcommData((e) => {
    const sink = getSink(e.socketId);
    const bytes = new Uint8Array(Buffer.from(e.valueBase64, "base64"));
    if (sink.onData) sink.onData(bytes);
    else sink.dataQueue.push(bytes);
  });
  onRfcommClosed((e) => {
    const sink = sinks.get(e.socketId);
    if (!sink) return;
    if (sink.onClose) sink.onClose();
    else sink.closedPending = true;
  });
}

function makeBtcAdapter(socketId: string): BtcSocketAdapter {
  ensureNativeWired();
  getSink(socketId); // pre-create so early bytes buffer
  return {
    write: async (bytes) => {
      await writeRfcomm(socketId, Buffer.from(bytes).toString("base64"));
    },
    onData: (handler) => {
      const s = getSink(socketId);
      s.onData = handler;
      if (s.dataQueue.length > 0) {
        const queued = s.dataQueue;
        s.dataQueue = [];
        for (const b of queued) handler(b);
      }
    },
    onClose: (handler) => {
      const s = getSink(socketId);
      s.onClose = handler;
      if (s.closedPending) handler();
    },
    destroy: () => {
      sinks.delete(socketId);
      void closeRfcomm(socketId).catch(() => {});
    },
  };
}

// ---------------------------------------------------------------------------
// Dial / listen
// ---------------------------------------------------------------------------

export type DialBtcPeerOpts = {
  /** Remote Bluetooth MAC (learned via QR/discovery). */
  mac: string;
  /** RFCOMM service UUID both sides agree on. */
  uuid: string;
};

/** Dial a peer over insecure RFCOMM and return a BtcMeshConnection. */
export async function dialBtcPeer(opts: DialBtcPeerOpts): Promise<BtcMeshConnection> {
  ensureNativeWired();
  const socketId = await connectRfcomm(opts.mac, opts.uuid);
  return new BtcMeshConnection(makeBtcAdapter(socketId));
}

export type BtcListenerHandle = {
  listenerId: string;
  /** Idempotent teardown of the server (does not close already-accepted conns). */
  stop: () => Promise<void>;
};

/**
 * Open an insecure RFCOMM server. Every accepted socket is wrapped into a
 * BtcMeshConnection and handed to onConnection — the same seam the LAN listener
 * and BLE GATT accept loop feed, so runAntiEntropy runs role-agnostically.
 */
export async function startBtcListener(opts: {
  serviceName: string;
  uuid: string;
  onConnection: (conn: BtcMeshConnection) => void;
}): Promise<BtcListenerHandle> {
  ensureNativeWired();
  const listenerId = await openRfcommServer(opts.serviceName, opts.uuid);
  const sub = onRfcommAccepted((e) => {
    if (e.listenerId !== listenerId) return;
    try {
      const conn = new BtcMeshConnection(makeBtcAdapter(e.socketId));
      opts.onConnection(conn);
    } catch (err) {
      if (__DEV__) console.warn("[btc.listen] onConnection threw — closing socket", err);
      void closeRfcomm(e.socketId).catch(() => {});
    }
  });
  return {
    listenerId,
    stop: async () => {
      try {
        sub.remove();
      } catch {
        /* */
      }
      try {
        await stopRfcommServer(listenerId);
      } catch {
        /* */
      }
    },
  };
}

// ---------------------------------------------------------------------------
// QR-based first contact (M-BTC-2) — Briar-style. Both phones derive the SAME
// RFCOMM service UUID from a shared secret carried in the QR; the host goes
// discoverable + listens on it, the scanner runs classic inquiry to learn the
// host's MAC and dials by that UUID (only the host exposes the service).
// ---------------------------------------------------------------------------

/** Deterministic 128-bit RFCOMM service UUID from a shared secret (the QR nonce). */
export function deriveRfcommUuid(secret: string): string {
  const h = sha256(new TextEncoder().encode("kaata-rfcomm-uuid:" + secret));
  const hex = Array.from(h.slice(0, 16))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/**
 * Scanner side: classic inquiry to learn nearby MACs, then dial by the derived
 * UUID — only the host exposes that service, so the first successful dial is the
 * host. Returns its BtcMeshConnection. Throws if no host is found.
 */
export async function discoverAndConnect(opts: {
  uuid: string;
  /** The host's Bluetooth name (from the QR) — dialed first when present. */
  hostName?: string;
  discoveryMs?: number;
  onLog?: (s: string) => void;
}): Promise<BtcMeshConnection> {
  ensureNativeWired();
  const log = opts.onLog ?? (() => {});
  const discoveryMs = opts.discoveryMs ?? 15_000;
  const found = new Map<string, string>();
  let finished = false;
  const subFound = onDeviceFound((d) => {
    if (d.mac && !found.has(d.mac)) {
      found.set(d.mac, d.name ?? "");
      log(`· found ${d.name || d.mac}`);
    }
  });
  const subDone = onDiscoveryFinished(() => {
    finished = true;
  });
  try {
    log("scanning for nearby Bluetooth devices…");
    await startClassicDiscovery();
    const deadline = Date.now() + discoveryMs;
    while (!finished && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 400));
    }
  } finally {
    subFound.remove();
    subDone.remove();
    try {
      await stopClassicDiscovery();
    } catch {
      /* */
    }
  }
  let entries = [...found.entries()];
  // Dial the QR-named host first (the only device we expect to succeed); the
  // rest are tried as a fallback in case the advertised names don't match.
  if (opts.hostName) {
    const target = opts.hostName.toLowerCase();
    entries = entries.sort((a, b) => {
      const am = a[1].toLowerCase() === target ? 0 : 1;
      const bm = b[1].toLowerCase() === target ? 0 : 1;
      return am - bm;
    });
  }
  log(`trying ${entries.length} device(s)…`);
  for (const [mac, name] of entries) {
    try {
      log(`→ dialing ${name || mac}`);
      const conn = await dialBtcPeer({ mac, uuid: opts.uuid });
      log(`✓ connected to ${name || mac}`);
      return conn;
    } catch (err) {
      // Log WHY each dial failed — the host's error is the diagnostic.
      log(`  ✗ ${name || mac}: ${(err as Error).message}`);
    }
  }
  throw new MeshTransportError("no RFCOMM host found among nearby devices", "btc_no_host");
}
