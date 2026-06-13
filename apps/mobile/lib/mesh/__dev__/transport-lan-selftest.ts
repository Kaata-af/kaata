// In-memory selftest for the M3 LAN transport's framing + AEAD. No RN, no
// SQLite, no sockets — run from apps/mobile/:
//   bun lib/mesh/__dev__/transport-lan-selftest.ts
// Exits non-zero on the first failure.
//
// Covers the real-risk surface of transport-lan.ts (docs/m3-lan-transport.md
// §7): length-prefix reassembly across arbitrary chunk boundaries, multiple
// frames coalesced into one delivery, AEAD seal/open both directions, tamper
// → fail-closed, and the frame-size cap. The full handshake+delta convergence
// needs SQLite + the trust chain and is the device smoke test.

import { LanMeshConnection, MAX_LAN_FRAME_BYTES, type LanSocketAdapter } from "../transport-lan";
import {
  deriveSessionAead,
  generateEphemeralKeyPair,
  bytesToB64Url,
  type BleAeadContext,
} from "../aead";

// @ts-expect-error — __DEV__ is defined by the RN bundler; stub it under bun.
globalThis.__DEV__ = false;

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) console.log(`  ok  ${name}`);
  else {
    failures++;
    console.error(`FAIL  ${name}`, detail !== undefined ? JSON.stringify(detail) : "");
  }
}

// A controllable endpoint: captures bytes the LanMeshConnection writes (so a
// test can re-feed them in chosen fragment sizes) and exposes feed()/fireClose().
function makeRawEndpoint() {
  let dataHandler: ((b: Uint8Array) => void) | null = null;
  let closeHandler: (() => void) | null = null;
  const sent: Uint8Array[] = [];
  const adapter: LanSocketAdapter = {
    write: (bytes) => {
      sent.push(new Uint8Array(bytes));
    },
    onData: (h) => {
      dataHandler = h;
    },
    onClose: (h) => {
      closeHandler = h;
    },
    destroy: () => {
      /* local destroy: no peer notification in this stub */
    },
  };
  return {
    adapter,
    sent,
    feed: (b: Uint8Array) => dataHandler?.(b),
    fireClose: () => closeHandler?.(),
    concatSent: (): Uint8Array => {
      const total = sent.reduce((n, c) => n + c.length, 0);
      const out = new Uint8Array(total);
      let o = 0;
      for (const c of sent) {
        out.set(c, o);
        o += c.length;
      }
      return out;
    },
  };
}

// A pair of AEAD contexts (A↔B) derived from a real X25519 handshake, the same
// way deriveSessionAead is used after PoP. Returns matched contexts with
// opposite direction tags.
function makeAeadPair(): { a: BleAeadContext; b: BleAeadContext } {
  const kpA = generateEphemeralKeyPair();
  const kpB = generateEphemeralKeyPair();
  const nonceA = bytesToB64Url(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]));
  const nonceB = bytesToB64Url(new Uint8Array([13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24]));
  const a = deriveSessionAead({
    ownPriv: kpA.privateKey,
    ownPub: kpA.publicKey,
    peerPub: kpB.publicKey,
    ownNonceB64: nonceA,
    peerNonceB64: nonceB,
  });
  const b = deriveSessionAead({
    ownPriv: kpB.privateKey,
    ownPub: kpB.publicKey,
    peerPub: kpA.publicKey,
    ownNonceB64: nonceB,
    peerNonceB64: nonceA,
  });
  return { a, b };
}

async function main(): Promise<void> {
  console.log("framing: plaintext round-trip, byte-at-a-time fragmentation");
  {
    const txEnd = makeRawEndpoint();
    const rxEnd = makeRawEndpoint();
    const tx = new LanMeshConnection(txEnd.adapter);
    const rx = new LanMeshConnection(rxEnd.adapter);
    const msg = { hello: "v2", proof: [1, 2, 3], nested: { k: "ɛ-unicode-π" } };
    await tx.sendJSON(msg);
    const wire = txEnd.concatSent();
    // Feed the receiver ONE byte at a time — worst-case fragmentation.
    const recvP = rx.recvJSON(2_000);
    for (let i = 0; i < wire.length; i++) rxEnd.feed(wire.subarray(i, i + 1));
    const got = await recvP;
    check(
      "byte-at-a-time reassembly yields the exact object",
      JSON.stringify(got) === JSON.stringify(msg),
      got,
    );
    void rx;
  }

  console.log("framing: multiple frames coalesced into one delivery");
  {
    const txEnd = makeRawEndpoint();
    const rxEnd = makeRawEndpoint();
    const tx = new LanMeshConnection(txEnd.adapter);
    const rx = new LanMeshConnection(rxEnd.adapter);
    const msgs = [{ n: 1 }, { n: 2, s: "two" }, { n: 3 }];
    for (const m of msgs) await tx.sendJSON(m);
    // Deliver ALL three frames in a single onData call.
    rxEnd.feed(txEnd.concatSent());
    const got = [await rx.recvJSON(2_000), await rx.recvJSON(2_000), await rx.recvJSON(2_000)];
    check(
      "three coalesced frames parse in order",
      JSON.stringify(got) === JSON.stringify(msgs),
      got,
    );
  }

  console.log("framing: a frame split exactly on the length-prefix boundary");
  {
    const txEnd = makeRawEndpoint();
    const rxEnd = makeRawEndpoint();
    const tx = new LanMeshConnection(txEnd.adapter);
    const rx = new LanMeshConnection(rxEnd.adapter);
    await tx.sendJSON({ boundary: "test", pad: "xxxxxxxxxxxxxxxxxxxx" });
    const wire = txEnd.concatSent();
    const recvP = rx.recvJSON(2_000);
    rxEnd.feed(wire.subarray(0, 2)); // partial length prefix
    rxEnd.feed(wire.subarray(2, 4)); // rest of length prefix, no body yet
    rxEnd.feed(wire.subarray(4, 4 + 7)); // header only
    rxEnd.feed(wire.subarray(4 + 7)); // body
    const got = await recvP;
    check(
      "split on prefix/header/body boundaries reassembles",
      (got as { boundary?: string }).boundary === "test",
      got,
    );
  }

  console.log("AEAD: sealed round-trip both directions over a live pipe");
  {
    // Auto-delivering pipe: each side's write lands in the other's onData.
    const aEnd = makeRawEndpoint();
    const bEnd = makeRawEndpoint();
    // Re-wire write() to deliver straight to the peer endpoint.
    aEnd.adapter.write = (bytes) => bEnd.feed(new Uint8Array(bytes));
    bEnd.adapter.write = (bytes) => aEnd.feed(new Uint8Array(bytes));
    const a = new LanMeshConnection(aEnd.adapter);
    const b = new LanMeshConnection(bEnd.adapter);
    const { a: aeadA, b: aeadB } = makeAeadPair();
    a.installAead(aeadA);
    b.installAead(aeadB);

    // A→B several messages (exercises monotonic counter), then B→A.
    const bRecv = [b.recvJSON(2_000), b.recvJSON(2_000)];
    await a.sendJSON({ dir: "a2b", i: 0 });
    await a.sendJSON({ dir: "a2b", i: 1 });
    const gotB = await Promise.all(bRecv);
    check(
      "A→B sealed messages decrypt in order",
      JSON.stringify(gotB) ===
        JSON.stringify([
          { dir: "a2b", i: 0 },
          { dir: "a2b", i: 1 },
        ]),
      gotB,
    );

    const aRecv = a.recvJSON(2_000);
    await b.sendJSON({ dir: "b2a", ok: true });
    const gotA = await aRecv;
    check(
      "B→A sealed message decrypts",
      JSON.stringify(gotA) === JSON.stringify({ dir: "b2a", ok: true }),
      gotA,
    );
  }

  console.log("AEAD: body tamper fails closed");
  {
    const txEnd = makeRawEndpoint();
    const rxEnd = makeRawEndpoint();
    const tx = new LanMeshConnection(txEnd.adapter);
    const rx = new LanMeshConnection(rxEnd.adapter);
    const { a: aeadA, b: aeadB } = makeAeadPair();
    tx.installAead(aeadA);
    rx.installAead(aeadB);
    await tx.sendJSON({ secret: "ledger-row" });
    const wire = txEnd.concatSent().slice();
    // Flip a byte inside the sealed body (after 4-byte len + 7-byte header).
    wire[4 + 7 + 1] ^= 0xff;
    const recvP = rx.recvJSON(1_000);
    rxEnd.feed(wire);
    const got = await recvP;
    check(
      "tampered ciphertext closes the connection (recv → __closed)",
      (got as { __closed?: boolean }).__closed === true,
      got,
    );
    check("connection reports closed after tamper", rx.isOpen() === false);
  }

  console.log("AEAD: header (AAD) tamper fails closed");
  {
    const txEnd = makeRawEndpoint();
    const rxEnd = makeRawEndpoint();
    const tx = new LanMeshConnection(txEnd.adapter);
    const rx = new LanMeshConnection(rxEnd.adapter);
    const { a: aeadA, b: aeadB } = makeAeadPair();
    tx.installAead(aeadA);
    rx.installAead(aeadB);
    await tx.sendJSON({ secret: "ledger-row-2" });
    const wire = txEnd.concatSent().slice();
    // Flip the frame_id inside the 7-byte header (AAD). openChunk must reject.
    wire[4] ^= 0xff;
    const recvP = rx.recvJSON(1_000);
    rxEnd.feed(wire);
    const got = await recvP;
    check(
      "tampered AAD header closes the connection",
      (got as { __closed?: boolean }).__closed === true,
      got,
    );
  }

  console.log("cap: an over-cap declared frame length closes before allocation");
  {
    const rxEnd = makeRawEndpoint();
    const rx = new LanMeshConnection(rxEnd.adapter);
    const recvP = rx.recvJSON(1_000);
    // 4-byte length prefix claiming a frame just above the cap.
    const declared = MAX_LAN_FRAME_BYTES + 1;
    const prefix = new Uint8Array(4);
    prefix[0] = (declared >>> 24) & 0xff;
    prefix[1] = (declared >>> 16) & 0xff;
    prefix[2] = (declared >>> 8) & 0xff;
    prefix[3] = declared & 0xff;
    rxEnd.feed(prefix);
    const got = await recvP;
    check(
      "over-cap length prefix closes the connection",
      (got as { __closed?: boolean }).__closed === true,
      got,
    );
    check("no giant buffer retained (connection closed)", rx.isOpen() === false);
  }

  console.log("cap: an over-cap outbound message throws rather than sending");
  {
    const txEnd = makeRawEndpoint();
    const tx = new LanMeshConnection(txEnd.adapter);
    // Build a JSON string whose UTF-8 length exceeds the 24-bit plaintext cap.
    const huge = { blob: "x".repeat(0xffffff + 16) };
    let threw = false;
    try {
      await tx.sendJSON(huge);
    } catch {
      threw = true;
    }
    check("over-cap sendJSON throws (msg_too_large)", threw);
    check("nothing was written for the over-cap message", txEnd.sent.length === 0);
  }

  console.log("close: socket close resolves a pending recvJSON with __closed");
  {
    const rxEnd = makeRawEndpoint();
    const rx = new LanMeshConnection(rxEnd.adapter);
    const recvP = rx.recvJSON(2_000);
    rxEnd.fireClose();
    const got = await recvP;
    check(
      "peer socket close → recvJSON resolves __closed",
      (got as { __closed?: boolean }).__closed === true,
      got,
    );
  }

  if (failures > 0) {
    console.error(`\n${failures} failure(s)`);
    process.exit(1);
  }
  console.log("\nall transport-lan selftests passed");
}

void main();
