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
   * The peer's Bluetooth Classic MAC, when known: the dialed MAC on an
   * outgoing conn (dialBtcPeer), or the accept event's remoteMac on an
   * incoming one (startBtcListener). Paired with the authenticated
   * remoteDeviceId (set by the handshake), this is what M-BTC-3.3 stores so
   * steady-state sync can re-dial the peer directly without a classic inquiry.
   */
  remoteMac: string | null = null;
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
// Bound pre-attach buffering: bytes for a socket whose conn hasn't attached a
// handler yet are queued, but a flood (or a socket nobody ever owns) must not
// grow unbounded — close it past this cap.
const MAX_PREATTACH_QUEUE_CHUNKS = 64;

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
    const sink = getSink(e.socketId); // auto-create to buffer early bytes
    const bytes = new Uint8Array(Buffer.from(e.valueBase64, "base64"));
    if (sink.onData) {
      sink.onData(bytes);
      return;
    }
    if (sink.dataQueue.length >= MAX_PREATTACH_QUEUE_CHUNKS) {
      // No handler has attached and the buffer is full — a flood or an unowned
      // socket. Close it so the queue can't grow unbounded toward the crash.
      void closeRfcomm(e.socketId).catch(() => {});
      sinks.delete(e.socketId);
      return;
    }
    sink.dataQueue.push(bytes);
  });
  onRfcommClosed((e) => {
    const sink = sinks.get(e.socketId);
    if (!sink) return;
    if (sink.onClose) {
      sink.onClose();
      sinks.delete(e.socketId); // conn was notified — free the entry
    } else {
      // No conn attached yet — keep the entry so a soon-to-attach conn still
      // learns of the close (closedPending). makeBtcAdapter.destroy() / the
      // dialBtcPeer cleanup path will delete it; a truly-orphaned entry is tiny.
      sink.closedPending = true;
    }
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
  /**
   * Construct the conn with failure-toast suppression already ON. Background
   * dials (steady-state sync) set this so that if the socket closes in the tiny
   * window before the caller can set conn.suppressFailures, onSocketClose
   * doesn't emit a user-facing "couldn't connect" toast from a silent re-sync.
   */
  suppressFailures?: boolean;
};

/** Dial a peer over insecure RFCOMM and return a BtcMeshConnection. */
export async function dialBtcPeer(opts: DialBtcPeerOpts): Promise<BtcMeshConnection> {
  ensureNativeWired();
  const socketId = await connectRfcomm(opts.mac, opts.uuid);
  try {
    const conn = new BtcMeshConnection(makeBtcAdapter(socketId));
    conn.remoteMac = opts.mac;
    if (opts.suppressFailures) conn.suppressFailures = true;
    return conn;
  } catch (err) {
    // connectRfcomm already opened a native socket + spawned its reader
    // coroutine. If anything after it throws, that socket would leak (a key
    // contributor to the ~300MB RSS crash). Close it before rethrowing.
    void closeRfcomm(socketId).catch(() => {});
    sinks.delete(socketId);
    throw err;
  }
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
      conn.remoteMac = e.remoteMac;
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
  /**
   * The host's REAL Bluetooth MAC (from the QR). When present we dial it
   * DIRECTLY — no inquiry, no name match — exactly like Briar's QR pairing
   * (BQP §6.1 descriptor address). This is the reliable primary path; inquiry
   * is only the fallback for hosts that can't advertise their MAC.
   */
  hostMac?: string;
  /** The host's Bluetooth name (from the QR) — a SORT hint for the inquiry
   *  fallback only; NEVER a match gate (Android name resolution is unreliable). */
  hostName?: string;
  discoveryMs?: number;
  onLog?: (s: string) => void;
  /**
   * Cooperative abort, polled during inquiry. Lets a higher-priority radio user
   * (QR pairing) reclaim the single BT radio from a low-priority steady-sync
   * inquiry: when this returns true the inquiry stops + this call throws
   * `btc_aborted` instead of cross-cancelling the other inquiry. The pair path
   * passes nothing (it IS the priority); steady passes `() => pairPauseCount>0`.
   */
  shouldAbort?: () => boolean;
}): Promise<BtcMeshConnection> {
  ensureNativeWired();
  const log = opts.onLog ?? (() => {});
  // Diagnostics folded into the final btc_no_host error so the pair screen shows
  // exactly WHERE it failed without adb (host MAC present? scan started? devices
  // found? dial errors?). The pair-scan screen renders err.message verbatim.
  let directDialError: string | null = null;
  let discoveryStarted = false;
  const dialErrors: string[] = [];

  // PRIMARY (Briar): the QR carried the host's real MAC — dial it directly. Only
  // the host answers the derived UUID, so this is deterministic + skips the
  // multi-second inquiry entirely. Fall through to inquiry if it fails (MAC
  // stale / host re-paired / transient radio error).
  if (opts.hostMac) {
    try {
      log(`→ dialing host directly ${opts.hostMac}`);
      const conn = await dialBtcPeer({ mac: opts.hostMac, uuid: opts.uuid });
      log("✓ connected directly");
      return conn;
    } catch (err) {
      directDialError = (err as Error).message;
      log(`  ✗ direct dial failed: ${directDialError} — scanning instead`);
    }
  }

  const discoveryMs = opts.discoveryMs ?? 15_000;
  const DIAL_WALL_BUDGET_MS = 25_000;
  // DIAL-AS-DISCOVERED retry-collect (member-add speed). The OLD path waited the
  // WHOLE ~15s inquiry window before dialing ANYTHING; with a masked host MAC (no
  // direct-dial fast path) that made member-add ~15-25s even though the host
  // usually surfaces in the first 1-3s. Now we dial each non-LE device the moment
  // it appears (~200ms poll granularity), so masked-MAC pairing drops to ~2-4s.
  // A FAILED dial NEVER ends the search — we keep collecting and RESTART discovery
  // until the original window deadline, so a slow host in a dense room is still
  // found (the property the removed grace-early-stop protected; only a successful
  // handshake or the deadline ends it). Bounded by discoveryMs + DIAL_WALL_BUDGET.
  // Dials stay SERIAL (one connectRfcomm at a time) — no fan-out, so MAX_SOCKETS
  // and the RSS/JAVA_CRASH discipline hold. shouldAbort + cancel-discovery-before-
  // dial are preserved verbatim (the pair-vs-steady seesaw guard, 8b9a6a2/80cdee5).
  const nameHint = opts.hostName ? opts.hostName.trim().toLowerCase() : null;
  // mac -> { name, type }
  const found = new Map<string, { name: string; type: number }>();
  const tried = new Set<string>();
  let finished = false;
  let aborted = false;

  const subFound = onDeviceFound((d) => {
    if (!d.mac) return;
    const type = d.type ?? -1;
    // Skip BLE-only devices — they can never answer an RFCOMM SDP dial.
    if (type === 2 /* DEVICE_TYPE_LE */) return;
    const name = d.name ?? "";
    const prev = found.get(d.mac);
    if (prev === undefined) {
      found.set(d.mac, { name, type });
      log(`· found ${name || d.mac}`);
    } else if (prev.name === "" && name !== "") {
      // Android often reports the friendly name in a LATER ACTION_FOUND for the
      // same MAC — upgrade the stored name (used only as a sort hint).
      found.set(d.mac, { name, type });
    }
  });
  const subDone = onDiscoveryFinished(() => {
    finished = true;
  });

  const overallDeadline = Date.now() + discoveryMs;
  const dialDeadline = Date.now() + DIAL_WALL_BUDGET_MS;
  const untried = (): Array<[string, { name: string; type: number }]> =>
    [...found.entries()].filter(([mac]) => !tried.has(mac));

  try {
    let discovering = false;
    while (Date.now() < overallDeadline && Date.now() < dialDeadline) {
      // A higher-priority radio user (QR pairing) asked us to release the radio.
      if (opts.shouldAbort?.()) {
        aborted = true;
        break;
      }
      // Ensure an inquiry is running (a prior round stopped it to dial).
      if (!discovering) {
        finished = false;
        log("scanning for nearby Bluetooth devices…");
        if ((await startClassicDiscovery()) === true) discoveryStarted = true;
        else log("  ⚠ classic discovery did NOT start");
        discovering = true;
      }
      // Nothing dialable yet and the inquiry is still running — wait a beat, then
      // re-check (this is where the early-dial win comes from: a hit ends the wait
      // within ~200ms instead of after the full window).
      if (untried().length === 0 && !finished) {
        await new Promise((r) => setTimeout(r, 200));
        continue;
      }
      // Have candidate(s) OR the inquiry finished — MUST cancel discovery before
      // connect (Android requires cancelDiscovery(); connectRfcomm settles 250ms).
      try {
        await stopClassicDiscovery();
      } catch {
        /* */
      }
      discovering = false;
      if (opts.shouldAbort?.()) {
        aborted = true;
        break;
      }
      // Dial untried non-LE candidates SERIALLY; first successful handshake wins.
      // Shuffle so a dense room doesn't deterministically retry the same wrong
      // device first; the QR name (when present) re-orders the likely host first.
      const candidates = untried();
      for (let i = candidates.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
      }
      if (nameHint) {
        candidates.sort((a, b) => {
          const am = a[1].name.toLowerCase() === nameHint ? 0 : 1;
          const bm = b[1].name.toLowerCase() === nameHint ? 0 : 1;
          return am - bm;
        });
      }
      for (const [mac, info] of candidates) {
        if (opts.shouldAbort?.()) {
          aborted = true;
          break;
        }
        if (Date.now() > dialDeadline) break;
        tried.add(mac);
        try {
          log(`→ dialing ${info.name || mac}`);
          const conn = await dialBtcPeer({ mac, uuid: opts.uuid });
          log(`✓ connected to ${info.name || mac}`);
          return conn;
        } catch (err) {
          // Log WHY each dial failed — the host's error is the diagnostic.
          const m = (err as Error).message;
          dialErrors.push(m);
          log(`  ✗ ${info.name || mac}: ${m}`);
        }
      }
      if (aborted) break;
      // Inquiry finished AND every discovered device tried — room covered, no host.
      // Otherwise loop: restart discovery to keep looking for a slow host.
      if (finished && untried().length === 0) break;
    }
  } finally {
    subFound.remove();
    subDone.remove();
    // MUST leave discovery stopped — Android requires cancelDiscovery() before any
    // later connect, and we owe the radio back for the pair-vs-steady handoff.
    try {
      await stopClassicDiscovery();
    } catch {
      /* */
    }
  }

  // Released the radio for a higher-priority inquiry (QR pairing) — don't dial.
  if (aborted) {
    throw new MeshTransportError("inquiry aborted (radio reclaimed for pairing)", "btc_aborted");
  }
  // Rich diagnostic in the message (shown on the pair-scan error screen):
  //   hostMac=y/n   was the host's MAC in the QR (did getLocalAddress work)
  //   directErr=…   why the direct-MAC dial failed (when hostMac=y)
  //   scanStarted   did classic discovery actually start
  //   found=N       how many non-LE devices the inquiry discovered
  //                 (0 ⇒ host not discoverable / scan delivering nothing)
  //   dials=N       how many we attempted by UUID
  //   dialErrs=…    the actual RFCOMM connect errors (host not listening vs
  //                 SDP/connect failure on the hardware)
  const uniqErrs = [...new Set(dialErrors)].slice(0, 3).join(" | ");
  throw new MeshTransportError(
    "no RFCOMM host found " +
      `[hostMac=${opts.hostMac ? "y" : "n"}` +
      `${directDialError ? ` directErr=${directDialError}` : ""}` +
      `, scanStarted=${discoveryStarted}, found=${found.size}, dials=${tried.size}` +
      `${uniqErrs ? `, dialErrs=${uniqErrs}` : ""}]`,
    "btc_no_host",
  );
}
