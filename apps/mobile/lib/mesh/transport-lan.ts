// apps/mobile/lib/mesh/transport-lan.ts
//
// Sync v2 M3 — LAN (TCP) transport. A third `MeshConnection` implementation
// alongside BLE, used when two phones share a Wi-Fi LAN (router with or
// WITHOUT internet — the "Wi-Fi but no internet" scenario). See
// docs/m3-lan-transport.md.
//
// WHY THIS IS SMALL: the recon (docs/m3-lan-transport.md §1) established that
// the seam already exists. `transport-interface.ts` defines MeshConnection;
// `anti-entropy.ts` consumes ONLY that and is already transport-agnostic; the
// M2c Hello/PoP handshake on top of it already IS the "Noise-XX binding a
// membership proof" the architecture asks for. So LAN does NOT invent a new
// SecureStream or handshake — it is one more MeshConnection over a TCP socket,
// reusing aead.ts verbatim. The handshake + delta loop run unchanged.
//
// ---------------------------------------------------------------------------
// FRAMING (TCP-specific, distinct from BLE's 203-byte chunking)
// ---------------------------------------------------------------------------
//
// TCP is a reliable, ordered byte stream, so there is NO chunking — one
// MeshConnection message is exactly one frame. Framing only has to recover
// message boundaries from the stream (a single send can arrive split across
// many `data` events, or several sends coalesced into one):
//
//   on-wire frame:  [4-byte BE frame_len][ 7-byte header (AAD) ][ body ]
//                    \__ frame_len = 7 + body.length ___________________/
//
//   - body is plaintext JSON pre-AEAD (handshake), or ChaCha20-Poly1305
//     sealed JSON post-AEAD (steady state). The 7-byte header is ALWAYS
//     present and is the AEAD AAD — identical layout to transport-ble.ts so
//     the seal/open contract (aead.ts sealChunk/openChunk) is reused verbatim:
//       [0..1] frame_id (BE u16, monotonic, debug/telemetry only)
//       [2]    chunk_index — always 0 (no chunking on TCP)
//       [3]    chunk_count — always 1
//       [4..6] plaintext length (BE u24) — lets the receiver validate the
//              decrypted size and pre-size buffers
//   - Pre-AEAD the body == plaintext and the header passes through aead=null;
//     post-AEAD the body == plaintext+16 (Poly1305 tag). Both sides install
//     the session AEAD at the SAME protocol point (the instant PoP verifies,
//     mirroring transport-ble.ts installAead), so the framing shape never
//     straddles the transition — the next message after PoP is the first
//     sealed one. A packet capture therefore shows ciphertext for every
//     ledger byte (done-criterion 2).
//   - 16 MiB hard frame cap (OOM defense). Anti-entropy deltas are KiB-scale;
//     the cap only exists so a hostile/garbage peer can't make us allocate an
//     attacker-chosen multi-GB buffer from a 4-byte length prefix.
//
// The class takes an INJECTABLE socket adapter so the bun selftest
// (__dev__/transport-lan-selftest.ts) drives two back-to-back connections
// through an in-memory pipe and runs the REAL framing + AEAD. The native side
// (M3b) wires react-native-tcp-socket into the same adapter shape.

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

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const LAN_FRAME_HEADER_BYTES = 7;
// 24-bit plaintext length field ceiling (0xFFFFFF ≈ 16 MiB). Bounds both the
// header's length field AND the on-wire frame; a declared frame_len above the
// derived max is rejected before allocation.
export const MAX_LAN_PLAINTEXT_BYTES = 0xffffff;
export const MAX_LAN_FRAME_BYTES = LAN_FRAME_HEADER_BYTES + MAX_LAN_PLAINTEXT_BYTES + TAG_BYTES;

export type LanAeadContext = AeadCtx;

/**
 * The transport seam the native side (react-native-tcp-socket) and the
 * in-memory test both implement. Deliberately tiny:
 *   - write(bytes)    push raw bytes to the socket (the class has already
 *                     framed them). May be sync or async; awaited.
 *   - onData(cb)      register the single inbound-bytes handler. TCP delivers
 *                     arbitrary-sized, arbitrarily-split chunks.
 *   - onClose(cb)     register the single socket-closed handler.
 *   - destroy()       close the underlying socket. Idempotent on the native
 *                     side; the class only calls it once.
 */
export interface LanSocketAdapter {
  write(bytes: Uint8Array): void | Promise<void>;
  onData(handler: (bytes: Uint8Array) => void): void;
  onClose(handler: () => void): void;
  destroy(): void;
}

// ---------------------------------------------------------------------------
// Framing helpers
// ---------------------------------------------------------------------------

function readBE32(buf: Uint8Array, off: number): number {
  return ((buf[off] << 24) | (buf[off + 1] << 16) | (buf[off + 2] << 8) | buf[off + 3]) >>> 0;
}

function readBE24(buf: Uint8Array, off: number): number {
  return (buf[off] << 16) | (buf[off + 1] << 8) | buf[off + 2];
}

/** Build the 7-byte AAD header: frame_id, chunk_index=0, chunk_count=1, len. */
function buildHeader(frameId: number, plaintextLen: number): Uint8Array {
  const h = new Uint8Array(LAN_FRAME_HEADER_BYTES);
  h[0] = (frameId >>> 8) & 0xff;
  h[1] = frameId & 0xff;
  h[2] = 0; // chunk_index — TCP carries the whole message in one frame
  h[3] = 1; // chunk_count
  h[4] = (plaintextLen >>> 16) & 0xff;
  h[5] = (plaintextLen >>> 8) & 0xff;
  h[6] = plaintextLen & 0xff;
  return h;
}

// ---------------------------------------------------------------------------
// LAN MeshConnection
// ---------------------------------------------------------------------------

/**
 * TCP-backed MeshConnection. Constructed by:
 *   - dialLanPeer (outbound, M3b) after createConnection resolves.
 *   - the LAN listener's onConnection (inbound, M3b) per accepted socket.
 * Pure protocol over the injected adapter — no react-native-tcp-socket
 * dependency here, so it is exercised end-to-end under bun.
 */
export class LanMeshConnection implements MeshConnection {
  readonly kind = "lan" as const;
  remoteDeviceId: string | null = null;
  private closed = false;
  private inbox: unknown[] = [];
  private resolvers: ((v: unknown) => void)[] = [];
  private aead: LanAeadContext | null = null;
  private outFrameId = 0;
  // Reassembly buffer for the byte stream. Grows on each `data` event and is
  // trimmed as complete frames are drained.
  private recvBuf: Uint8Array = new Uint8Array(0);

  constructor(private adapter: LanSocketAdapter) {
    this.adapter.onData((bytes) => this.onData(bytes));
    this.adapter.onClose(() => this.onSocketClose());
  }

  /**
   * Inject the AEAD context once the handshake has derived a shared key.
   * Until called the connection is in "handshake mode" — Hello + PoP flow
   * plaintext-framed; every message after is sealed.
   */
  installAead(ctx: LanAeadContext): void {
    this.aead = ctx;
  }

  isOpen(): boolean {
    return !this.closed;
  }

  // --- inbound -------------------------------------------------------------

  private onData(bytes: Uint8Array): void {
    if (this.closed) return;
    if (bytes.length === 0) return;
    // Always copy into a fresh buffer: the native socket may hand us a reused
    // Buffer, and `set` copies regardless of whether `bytes` is a view.
    const merged = new Uint8Array(this.recvBuf.length + bytes.length);
    merged.set(this.recvBuf, 0);
    merged.set(bytes, this.recvBuf.length);
    this.recvBuf = merged;
    this.drainFrames();
  }

  private drainFrames(): void {
    for (;;) {
      if (this.closed) return;
      if (this.recvBuf.length < 4) return; // need the length prefix
      const frameLen = readBE32(this.recvBuf, 0);
      if (frameLen < LAN_FRAME_HEADER_BYTES || frameLen > MAX_LAN_FRAME_BYTES) {
        // Malformed or oversized: a frame must contain at least the 7-byte
        // header and may not exceed the OOM cap. Either is unrecoverable on a
        // byte stream (we've lost sync) — fail loud and close.
        if (__DEV__)
          console.warn("[lan.transport] bad frame_len", frameLen, "— closing connection");
        emitMeshFailure({ kind: "peer_dropped_midsync" });
        this.markClosed();
        return;
      }
      if (this.recvBuf.length < 4 + frameLen) return; // frame not fully arrived
      const frame = this.recvBuf.subarray(4, 4 + frameLen);
      this.handleFrame(frame);
      // handleFrame may have closed us (AEAD/length failure), which clears
      // recvBuf — don't slice the now-empty buffer; the loop-top guard would
      // catch it next iteration but bail explicitly for clarity.
      if (this.closed) return;
      // Advance past the consumed frame (slice copies the remainder).
      this.recvBuf = this.recvBuf.slice(4 + frameLen);
    }
  }

  private handleFrame(frame: Uint8Array): void {
    const header = frame.subarray(0, LAN_FRAME_HEADER_BYTES);
    const body = frame.subarray(LAN_FRAME_HEADER_BYTES);
    const declaredPlainLen = readBE24(header, 4);

    let plaintext: Uint8Array;
    if (this.aead) {
      try {
        plaintext = openChunk(body, header, this.aead);
      } catch (err) {
        if (err instanceof MeshAeadError) {
          // AEAD failure: header tampering, body tampering, or replay. We can
          // no longer trust any byte from this peer — close hard.
          if (__DEV__) console.warn("[lan.transport] AEAD open failed:", err.code, err.message);
          emitMeshFailure({ kind: "peer_decrypt_failed" });
          this.markClosed();
          return;
        }
        throw err;
      }
    } else {
      plaintext = body;
    }

    // Integrity: the header's plaintext-length must match what we got. In
    // handshake mode this catches a corrupt length prefix; post-AEAD it's a
    // belt-and-suspenders check on top of the Poly1305 tag.
    if (plaintext.length !== declaredPlainLen) {
      if (__DEV__)
        console.warn(
          "[lan.transport] length mismatch hdr=",
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
      // A non-JSON plaintext that nonetheless decrypted/passed length is a
      // protocol violation; drop the frame (don't necessarily kill the link).
      if (__DEV__) console.warn("[lan.transport] frame was not valid JSON — dropping");
      return;
    }
    const r = this.resolvers.shift();
    if (r) r(parsed);
    else this.inbox.push(parsed);
  }

  private onSocketClose(): void {
    // A deliberate close() (markClosed then adapter.destroy) still fires the
    // native 'close' event back into here — without this guard every CLEAN
    // one-shot LAN burst close emitted a spurious peer_dropped_midsync /
    // peer_handshake_failed, each of which the failure bridge queued as a
    // crash report. Only an UNEXPECTED close (peer vanished) should emit.
    // Mirrors the same guard in transport-btc.ts.
    if (this.closed) return;
    // Mirror transport-btc.ts: the discriminator for the toast is whether
    // AEAD was up (mid-sync drop) vs still handshaking (transport).
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
    if (__DEV__) console.log("[lan.transport] connection closed");
  }

  // --- outbound ------------------------------------------------------------

  async sendJSON(obj: unknown): Promise<void> {
    if (this.closed) {
      throw new MeshTransportError("sendJSON on closed LAN connection");
    }
    const plaintext = new TextEncoder().encode(JSON.stringify(obj));
    if (plaintext.length > MAX_LAN_PLAINTEXT_BYTES) {
      throw new MeshTransportError(
        `LAN message too large: ${plaintext.length} bytes > ${MAX_LAN_PLAINTEXT_BYTES}`,
        "msg_too_large",
      );
    }
    const frameId = this.outFrameId++ & 0xffff;
    const header = buildHeader(frameId, plaintext.length);
    const body = this.aead ? sealChunk(plaintext, header, this.aead) : plaintext;
    const frameLen = LAN_FRAME_HEADER_BYTES + body.length;
    const out = new Uint8Array(4 + frameLen);
    out[0] = (frameLen >>> 24) & 0xff;
    out[1] = (frameLen >>> 16) & 0xff;
    out[2] = (frameLen >>> 8) & 0xff;
    out[3] = frameLen & 0xff;
    out.set(header, 4);
    out.set(body, 4 + LAN_FRAME_HEADER_BYTES);
    try {
      await this.adapter.write(out);
    } catch (err) {
      throw new MeshTransportError(
        `LAN socket write failed: ${(err as Error).message}`,
        "lan_write_failed",
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
        reject(new MeshTransportError(`LAN recvJSON timed out after ${timeoutMs}ms`, "timeout"));
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
// Native socket adapter (react-native-tcp-socket)
// ---------------------------------------------------------------------------
//
// react-native-tcp-socket is require()'d LAZILY (mirroring dialBLEPeer's
// require of react-native-ble-plx) so this module stays importable under bun:
// the framing/AEAD selftest constructs LanMeshConnection with an in-memory
// adapter and never reaches these functions.
//
// Wire facts (react-native-tcp-socket@6.4.1, verified against src/Socket.js):
//   - socket.write(Uint8Array, _enc, cb) — cb fires on native 'written' ack.
//   - 'data' is emitted as a Buffer (Uint8Array subclass) when no encoding is
//     set, so we MUST NOT call setEncoding; new Uint8Array(buf) copies it.
//   - server.listen({ port: 0 }, cb) — the cb is the 'listening' handler, by
//     which point server.address().port holds the OS-assigned port.

// Minimal structural type for the bits of the native Socket we touch — the
// real module isn't loaded under bun and isn't worth a full typing.
type NativeTcpSocket = {
  write: (data: Uint8Array, encoding?: undefined, cb?: (err?: Error) => void) => boolean;
  on: (event: string, handler: (...args: unknown[]) => void) => void;
  destroy: () => void;
  setNoDelay?: (noDelay?: boolean) => void;
};

function toBytes(d: unknown): Uint8Array {
  // react-native-tcp-socket emits 'data' as a Buffer (Uint8Array subclass)
  // when no encoding is set — the path we take. The string branch is a
  // defensive fallback (only reachable if setEncoding were ever called).
  if (d instanceof Uint8Array) return new Uint8Array(d); // copy
  if (typeof d === "string") return new Uint8Array(Buffer.from(d, "base64"));
  return new Uint8Array(0);
}

/**
 * Wrap a connected native TCP socket into the injectable LanSocketAdapter.
 * `ready` gates outbound writes until the socket has fired 'connect' (for the
 * inbound/listener path the socket is already connected → Promise.resolve()).
 */
function socketToAdapter(socket: NativeTcpSocket, ready: Promise<void>): LanSocketAdapter {
  return {
    write: async (bytes) => {
      await ready;
      await new Promise<void>((resolve, reject) => {
        try {
          socket.write(bytes, undefined, (err) => (err ? reject(err) : resolve()));
        } catch (e) {
          reject(e as Error);
        }
      });
    },
    onData: (handler) => {
      socket.on("data", (d) => handler(toBytes(d)));
    },
    onClose: (handler) => {
      socket.on("close", () => handler());
      socket.on("error", () => handler());
    },
    destroy: () => {
      try {
        socket.destroy();
      } catch {
        /* idempotent */
      }
    },
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function loadTcpSocket(): any {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require("react-native-tcp-socket");
    return mod.default ?? mod;
  } catch (err) {
    throw new MeshTransportError(
      `react-native-tcp-socket unavailable: ${(err as Error).message}`,
      "lan_unavailable",
    );
  }
}

export type DialLanPeerOpts = {
  host: string;
  port: number;
  /** Connect timeout; defaults to 8s (matches the BLE dial budget). */
  connectTimeoutMs?: number;
};

/**
 * Dial a discovered LAN peer over TCP and return a LanMeshConnection ready for
 * the anti-entropy handshake. The connection's data listener is attached
 * BEFORE 'connect' resolves (so no inbound byte is lost), while outbound
 * writes are gated on 'connect'.
 */
export async function dialLanPeer(opts: DialLanPeerOpts): Promise<LanMeshConnection> {
  const TcpSocket = loadTcpSocket();
  const timeoutMs = opts.connectTimeoutMs ?? 8_000;

  let resolveReady!: () => void;
  let rejectReady!: (err: Error) => void;
  const ready = new Promise<void>((res, rej) => {
    resolveReady = res;
    rejectReady = rej;
  });
  let settled = false;

  const socket: NativeTcpSocket = TcpSocket.createConnection(
    { host: opts.host, port: opts.port },
    () => {
      try {
        socket.setNoDelay?.(true); // small handshake frames — disable Nagle
      } catch {
        /* */
      }
      if (!settled) {
        settled = true;
        resolveReady();
      }
    },
  );

  const timer = setTimeout(() => {
    if (!settled) {
      settled = true;
      rejectReady(
        new MeshTransportError(
          `LAN dial to ${opts.host}:${opts.port} timed out after ${timeoutMs}ms`,
          "lan_connect_timeout",
        ),
      );
      try {
        socket.destroy();
      } catch {
        /* */
      }
    }
  }, timeoutMs);

  socket.on("error", (err) => {
    if (!settled) {
      settled = true;
      clearTimeout(timer);
      rejectReady(
        new MeshTransportError(
          `LAN dial error to ${opts.host}:${opts.port}: ${(err as Error)?.message ?? String(err)}`,
          "lan_connect_failed",
        ),
      );
    }
  });

  // Construct now so the 'data' listener is attached before 'connect' fires.
  const conn = new LanMeshConnection(socketToAdapter(socket, ready));
  try {
    await ready;
  } catch (err) {
    clearTimeout(timer);
    await conn.close();
    throw err;
  }
  clearTimeout(timer);
  return conn;
}

export type LanListenerHandle = {
  /** The OS-assigned TCP port the listener is bound to. */
  port: number;
  /** Idempotent teardown of the server (does not close already-accepted conns). */
  stop: () => Promise<void>;
};

/**
 * Start a TCP listener on an OS-assigned port. Every accepted socket is wrapped
 * into a LanMeshConnection and handed to `onConnection` — the same code path
 * the BLE peripheral's onIncomingConnection feeds, so runAntiEntropy runs
 * role-agnostically on the inbound side.
 */
export async function startLanListener(opts: {
  onConnection: (conn: LanMeshConnection) => void;
  host?: string;
}): Promise<LanListenerHandle> {
  const TcpSocket = loadTcpSocket();

  // noDelay applies to accepted sockets via the server options path.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const server: any = TcpSocket.createServer({ noDelay: true }, (socket: NativeTcpSocket) => {
    try {
      const conn = new LanMeshConnection(socketToAdapter(socket, Promise.resolve()));
      opts.onConnection(conn);
    } catch (err) {
      if (__DEV__) console.warn("[lan.listen] onConnection threw — dropping socket", err);
      try {
        socket.destroy();
      } catch {
        /* */
      }
    }
  });

  const port = await new Promise<number>((resolve, reject) => {
    const onErr = (e: unknown) =>
      reject(
        new MeshTransportError(
          `LAN listen failed: ${(e as Error)?.message ?? String(e)}`,
          "lan_listen_failed",
        ),
      );
    server.once("error", onErr);
    server.listen({ port: 0, host: opts.host ?? "0.0.0.0" }, () => {
      try {
        server.removeListener?.("error", onErr);
      } catch {
        /* */
      }
      const addr = server.address?.();
      resolve(addr?.port ?? 0);
    });
  });

  return {
    port,
    stop: async () => {
      try {
        server.close();
      } catch {
        /* idempotent */
      }
    },
  };
}
