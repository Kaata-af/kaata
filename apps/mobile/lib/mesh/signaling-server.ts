// apps/mobile/lib/mesh/signaling-server.ts
//
// Tiny HTTP signaling server for WebRTC SDP + ICE exchange.
//
// Why hand-rolled HTTP?
//   React Native has no built-in HTTP server. The smallest viable option
//   is react-native-tcp-socket (raw TCP) + a stripped-down HTTP parser.
//   We only support what the mesh dialer sends:
//     POST /mesh/signal  Content-Type: application/json  body: <json>
//   Anything else returns 400 / 404. This is NOT a general-purpose HTTP
//   server.
//
// SESSION MODEL
//   Each dialer attempt is one `sid`. The first POST with that sid is an
//   "offer" — we instantiate a SignalingSession, hand it to transport.ts,
//   and reply with the answer SDP. Subsequent POSTs with the same sid
//   ("candidate" / "poll-candidates" / "close") are routed to that
//   session. Sessions older than SESSION_TTL_MS without traffic are GC'd
//   to bound memory if a peer disappears mid-handshake.

import { MeshTransportError } from "./errors";

const SESSION_TTL_MS = 60_000;
const MAX_REQUEST_BYTES = 64 * 1024; // single SDP rarely exceeds 8 KB
const GC_INTERVAL_MS = 15_000;
// Slowloris defense: drop a socket that hasn't completed its request
// within this window. A naive listener with no idle timeout lets an
// attacker open many sockets and dribble bytes forever, each consuming
// up to MAX_REQUEST_BYTES of buffer. 30s is well above any legitimate
// SDP POST round-trip from a LAN peer.
const SOCKET_IDLE_TIMEOUT_MS = 30_000;

export type SignalingServerHandle = {
  port: number;
  stop: () => Promise<void>;
};

export type SignalingSession = {
  sid: string;
  offerSdp: string;
  // Called once after we've created our local answer.
  sendAnswer: (sdp: string) => Promise<void>;
  // Called to flush a failure back to the dialer (rare; usually we just
  // let the session time out).
  fail: (reason: string) => Promise<void>;
  // Push a local ICE candidate we just gathered; will be returned to the
  // dialer the next time it polls. Passing null indicates end-of-candidates.
  pushLocalCandidate: (cand: any | null) => void;
  // Register a callback for inbound remote ICE candidates posted by the
  // dialer.
  onRemoteCandidate: (cb: (cand: any | null) => void) => void;
};

// Internal session record kept by the server.
type SessionRecord = {
  sid: string;
  createdAt: number;
  lastSeenAt: number;
  // Promise that resolves when transport.ts has produced an answer SDP.
  answerResolve: ((sdp: string | null) => void) | null;
  answerPromise: Promise<string | null>;
  // Pending local candidates queued for the next dialer poll.
  pendingLocalCandidates: any[];
  localCandidatesDone: boolean;
  // Callback into the peer connection for remote candidates.
  remoteCandidateCb: ((cand: any | null) => void) | null;
  closed: boolean;
};

// Conditionally load react-native-tcp-socket. On web / unit-test it's
// absent — startSignalingServer throws cleanly via the
// MeshTransportError("not_implemented") path the transport.ts caller
// already handles.
type TcpSocketModule = {
  createServer: (cb: (socket: any) => void) => any;
};
let tcpSocket: TcpSocketModule | null = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  tcpSocket = require("react-native-tcp-socket");
} catch {
  tcpSocket = null;
}

export async function startSignalingServer(opts: {
  onOffer: (session: SignalingSession) => Promise<void>;
}): Promise<SignalingServerHandle> {
  if (!tcpSocket) {
    throw new MeshTransportError(
      "react-native-tcp-socket not available (web / Expo Go); mesh requires a dev/preview build",
      "not_implemented",
    );
  }
  const sessions = new Map<string, SessionRecord>();
  let gcTimer: any = null;

  const server = tcpSocket.createServer((socket: any) => {
    handleConnection(socket, sessions, opts.onOffer);
  });

  const port = await new Promise<number>((resolve, reject) => {
    const t = setTimeout(() => reject(new MeshTransportError("listen timeout")), 5000);
    const tryResolve = async () => {
      // react-native-tcp-socket@6.x has historically been inconsistent on
      // whether server.address() is synchronously populated inside the
      // listen callback. Poll for up to 1s before giving up — port 0 on
      // mDNS means peers see us but cannot dial, which is silently fatal.
      for (let i = 0; i < 10; i++) {
        const addr = (server as any).address?.();
        if (addr && typeof addr.port === "number" && addr.port > 0) {
          clearTimeout(t);
          resolve(addr.port);
          return;
        }
        await new Promise((r) => setTimeout(r, 100));
      }
      clearTimeout(t);
      reject(
        new MeshTransportError(
          "listen succeeded but server.address() never reported a port (react-native-tcp-socket regression)",
        ),
      );
    };
    server.listen({ port: 0, host: "0.0.0.0" }, () => {
      void tryResolve();
    });
    server.on?.("error", (e: any) => {
      clearTimeout(t);
      reject(new MeshTransportError(`listen failed: ${e?.message ?? e}`));
    });
  });

  gcTimer = setInterval(() => {
    const now = Date.now();
    for (const [sid, rec] of sessions) {
      if (now - rec.lastSeenAt > SESSION_TTL_MS) {
        rec.closed = true;
        sessions.delete(sid);
      }
    }
  }, GC_INTERVAL_MS);

  return {
    port,
    async stop() {
      if (gcTimer) clearInterval(gcTimer);
      gcTimer = null;
      for (const rec of sessions.values()) rec.closed = true;
      sessions.clear();
      await new Promise<void>((resolve) => {
        try {
          server.close(() => resolve());
        } catch {
          resolve();
        }
      });
    },
  };
}

// ---------------------------------------------------------------------------
// Per-socket request handling
// ---------------------------------------------------------------------------

function handleConnection(
  socket: any,
  sessions: Map<string, SessionRecord>,
  onOffer: (session: SignalingSession) => Promise<void>,
): void {
  let buf = new Uint8Array(0);
  let dispatched = false;

  // Slowloris defense — see SOCKET_IDLE_TIMEOUT_MS above. Both setTimeout
  // (Node-style) and a manual setTimeout fallback are honored because
  // react-native-tcp-socket v6.2-v6.4 exposes these inconsistently.
  let idleTimer: any = null;
  const resetIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      if (!dispatched) {
        dispatched = true;
        try {
          socket.destroy?.();
        } catch {
          /* */
        }
        try {
          socket.end?.();
        } catch {
          /* */
        }
      }
    }, SOCKET_IDLE_TIMEOUT_MS);
  };
  try {
    socket.setTimeout?.(SOCKET_IDLE_TIMEOUT_MS);
  } catch {
    /* fall back to manual timer below */
  }
  resetIdleTimer();

  const writeResponse = (status: number, body: string | null, contentType = "application/json") => {
    const statusText = STATUS_TEXTS[status] ?? "OK";
    const bodyBytes = body != null ? new TextEncoder().encode(body) : new Uint8Array(0);
    const head =
      `HTTP/1.1 ${status} ${statusText}\r\n` +
      `Content-Type: ${contentType}\r\n` +
      `Content-Length: ${bodyBytes.length}\r\n` +
      `Connection: close\r\n` +
      `\r\n`;
    const headBytes = new TextEncoder().encode(head);
    const full = new Uint8Array(headBytes.length + bodyBytes.length);
    full.set(headBytes, 0);
    full.set(bodyBytes, headBytes.length);
    try {
      socket.write(full);
    } catch {
      /* socket already closed */
    }
    try {
      socket.end();
    } catch {
      /* */
    }
  };

  socket.on("data", (chunk: any) => {
    if (dispatched) return;
    resetIdleTimer();
    const incoming = toUint8(chunk);
    if (!incoming) return;
    const merged = new Uint8Array(buf.length + incoming.length);
    merged.set(buf, 0);
    merged.set(incoming, buf.length);
    buf = merged;
    if (buf.length > MAX_REQUEST_BYTES) {
      dispatched = true;
      if (idleTimer) clearTimeout(idleTimer);
      writeResponse(413, '{"error":"request too large"}');
      return;
    }
    const parsed = tryParseHttpRequest(buf);
    if (parsed === "incomplete") return;
    dispatched = true;
    if (idleTimer) clearTimeout(idleTimer);
    if (parsed === "bad") {
      writeResponse(400, '{"error":"bad request"}');
      return;
    }
    dispatchSignalRequest(parsed, sessions, onOffer, writeResponse).catch((e) => {
      writeResponse(500, JSON.stringify({ error: e?.message ?? String(e) }));
    });
  });

  // Some TCP-socket forks emit a "timeout" event from setTimeout instead of
  // calling our manual timer; handle both.
  socket.on?.("timeout", () => {
    if (!dispatched) {
      dispatched = true;
      if (idleTimer) clearTimeout(idleTimer);
      try {
        socket.destroy?.();
      } catch {
        /* */
      }
    }
  });

  socket.on("error", () => {
    if (idleTimer) clearTimeout(idleTimer);
    /* ignore — socket teardown will follow */
  });

  socket.on?.("close", () => {
    if (idleTimer) clearTimeout(idleTimer);
  });
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

async function dispatchSignalRequest(
  req: HttpRequest,
  sessions: Map<string, SessionRecord>,
  onOffer: (session: SignalingSession) => Promise<void>,
  writeResponse: (status: number, body: string | null, ct?: string) => void,
): Promise<void> {
  if (req.method !== "POST" || req.path !== "/mesh/signal") {
    writeResponse(404, '{"error":"not found"}');
    return;
  }
  let body: any;
  try {
    body = JSON.parse(new TextDecoder("utf-8").decode(req.body));
  } catch {
    writeResponse(400, '{"error":"bad json"}');
    return;
  }
  const sid = typeof body?.sid === "string" ? body.sid : null;
  if (!sid) {
    writeResponse(400, '{"error":"missing sid"}');
    return;
  }

  if (body.type === "offer") {
    if (typeof body.sdp !== "string") {
      writeResponse(400, '{"error":"missing sdp"}');
      return;
    }
    if (sessions.has(sid)) {
      writeResponse(409, '{"error":"sid in use"}');
      return;
    }
    const rec: SessionRecord = {
      sid,
      createdAt: Date.now(),
      lastSeenAt: Date.now(),
      answerResolve: null,
      answerPromise: Promise.resolve(null),
      pendingLocalCandidates: [],
      localCandidatesDone: false,
      remoteCandidateCb: null,
      closed: false,
    };
    rec.answerPromise = new Promise<string | null>((resolve) => {
      rec.answerResolve = resolve;
    });
    sessions.set(sid, rec);

    const session: SignalingSession = {
      sid,
      offerSdp: body.sdp,
      async sendAnswer(sdp) {
        rec.answerResolve?.(sdp);
        rec.answerResolve = null;
      },
      async fail(_reason) {
        rec.answerResolve?.(null);
        rec.answerResolve = null;
        rec.closed = true;
      },
      pushLocalCandidate(cand) {
        if (rec.closed) return;
        if (cand == null) {
          rec.localCandidatesDone = true;
          return;
        }
        rec.pendingLocalCandidates.push(cand);
      },
      onRemoteCandidate(cb) {
        rec.remoteCandidateCb = cb;
      },
    };
    // Kick off the peer connection setup; this populates the answer.
    onOffer(session).catch(() => {
      rec.answerResolve?.(null);
      rec.answerResolve = null;
    });

    // Wait (bounded) for the answer.
    const answer = await raceWithTimeout(rec.answerPromise, 10_000);
    if (!answer) {
      writeResponse(504, '{"error":"answer not produced"}');
      return;
    }
    writeResponse(200, JSON.stringify({ type: "answer", sid, sdp: answer }));
    return;
  }

  const rec = sessions.get(sid);
  if (!rec || rec.closed) {
    writeResponse(404, '{"error":"unknown sid"}');
    return;
  }
  rec.lastSeenAt = Date.now();

  if (body.type === "candidate") {
    try {
      rec.remoteCandidateCb?.(body.candidate ?? null);
    } catch {
      /* */
    }
    writeResponse(204, null);
    return;
  }

  if (body.type === "poll-candidates") {
    const candidates = rec.pendingLocalCandidates.splice(0);
    const done = rec.localCandidatesDone && candidates.length === 0;
    writeResponse(200, JSON.stringify({ candidates, done }));
    return;
  }

  if (body.type === "close") {
    rec.closed = true;
    sessions.delete(sid);
    writeResponse(204, null);
    return;
  }

  writeResponse(400, '{"error":"unknown type"}');
}

// ---------------------------------------------------------------------------
// Minimal HTTP/1.1 request parser (~100 LOC)
// ---------------------------------------------------------------------------
//
// Supports just enough:
//   - Request line: METHOD SP PATH SP HTTP/1.x CRLF
//   - Headers: Name: Value CRLF (case-insensitive lookup)
//   - Content-Length only (no chunked transfer-encoding)
//   - CRLF CRLF terminator before body
//   - Reads exactly Content-Length body bytes

export type HttpRequest = {
  method: string;
  path: string;
  headers: Map<string, string>;
  body: Uint8Array;
};

export function tryParseHttpRequest(buf: Uint8Array): HttpRequest | "incomplete" | "bad" {
  // Find header/body separator: CRLF CRLF.
  let headerEnd = -1;
  for (let i = 3; i < buf.length; i++) {
    if (buf[i - 3] === 0x0d && buf[i - 2] === 0x0a && buf[i - 1] === 0x0d && buf[i] === 0x0a) {
      headerEnd = i + 1;
      break;
    }
  }
  if (headerEnd === -1) return "incomplete";

  const headerText = new TextDecoder("utf-8").decode(buf.slice(0, headerEnd - 4));
  const lines = headerText.split("\r\n");
  if (lines.length === 0) return "bad";

  const reqLine = lines[0].split(" ");
  if (reqLine.length < 3) return "bad";
  const method = reqLine[0].toUpperCase();
  const path = reqLine[1];
  if (!method || !path) return "bad";

  const headers = new Map<string, string>();
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    const colon = line.indexOf(":");
    if (colon <= 0) return "bad";
    const name = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    headers.set(name, value);
  }

  const cl = headers.get("content-length");
  const expected = cl ? parseInt(cl, 10) : 0;
  if (Number.isNaN(expected) || expected < 0) return "bad";
  // Bound the declared length up-front. The accumulating data handler caps
  // buf at MAX_REQUEST_BYTES, so a Content-Length larger than that can
  // never be satisfied; reject early instead of waiting for the buffer to
  // hit the cap.
  if (expected > MAX_REQUEST_BYTES) return "bad";
  if (buf.length < headerEnd + expected) return "incomplete";

  const body = buf.slice(headerEnd, headerEnd + expected);
  return { method, path, headers, body };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toUint8(raw: any): Uint8Array | null {
  if (raw instanceof Uint8Array) return raw;
  if (raw instanceof ArrayBuffer) return new Uint8Array(raw);
  if (raw && typeof raw === "object" && "buffer" in raw && raw.buffer instanceof ArrayBuffer) {
    return new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
  }
  if (typeof raw === "string") return new TextEncoder().encode(raw);
  return null;
}

function raceWithTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(null as any), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      () => {
        clearTimeout(t);
        resolve(null as any);
      },
    );
  });
}

const STATUS_TEXTS: Record<number, string> = {
  200: "OK",
  204: "No Content",
  400: "Bad Request",
  404: "Not Found",
  409: "Conflict",
  413: "Payload Too Large",
  500: "Internal Server Error",
  504: "Gateway Timeout",
};
