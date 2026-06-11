# Kaata mesh sync — deep debugging request

## What I'm building

Kaata is an offline-first SQLite ledger app for Afghan shopkeepers. Think
WhatsApp simplicity, no sign-up required, works without internet.
React Native + Expo SDK 54 + Hermes, custom Kotlin Expo Modules where
needed. Production target: Android first (Xiaomi MIUI + Samsung One UI
are the realistic devices), iOS later. The app is local-first — every
ledger feature writes to SQLite directly; there's an optional Go
backend that handles cross-device sync for users who Google-sign-in.

## The feature I'm trying to land — BLE mesh sync between paired phones

A shopkeeper pairs a staff phone via QR. After pairing, when both
phones have "Nearby sync" toggled on AND are in BLE range (same shop),
they should sync their event-sourced ledgers automatically — entries
added on either phone propagate within seconds. No internet, no
account, no Google sign-in required.

Architecture:

- **Event-sourced ledger**: every mutation (add person, add entry,
  rename, archive, role change) is an append-only event with a Hybrid
  Logical Clock (HLC) timestamp. Mirror tables (vault_members_mirror,
  shop_profile, etc) are projections. CRDT-style: idempotent appliers,
  conflict-free merge via HLC ordering.
- **Trust model**: each device has an Ed25519 keypair stored in
  SecureStore. A "VMC" (Vault Membership Credential) is a signed
  JSON blob attesting (device_id, account_id, vault_id, role, epoch,
  expiry). For local-CA vaults (no Google sign-in), the OWNER's
  device key is the trust anchor.
- **Pair flow**: owner generates a v=3 QR carrying
  {vault_id, vault_name, issuer_device_pubkey, issuer_account_id,
  issuer_display_name, role_offered, shop_mode_token (nonce),
  vault_trust_anchor_pubkey, expires_at_ms}. TTL = 5 minutes.
  Joiner scans → pins the owner's identity into vault_credentials,
  self-issues their own VMC, stores vault row + mirror rows + emits
  vault_member_added event.
- **Discovery**: BLE advertise with manufacturer data containing
  4-byte vault_id hashes. Scanner matches hash → dialBLEPeer →
  GATT connect → handshake. Custom Kotlin GATT server module
  (kaata-gatt-server) handles peripheral side. react-native-ble-plx
  handles central side. react-native-ble-advertiser (ARCHIVED 2022)
  handles advertising.
- **Handshake** (in anti-entropy.ts): both sides exchange Hello
  (vmc_blob, pop_nonce, ephemeral_pubkey, capability_flags), verify
  peer's VMC (3-path fallback chain — see vmc.ts), do PoP signature,
  X25519 ECDH → HKDF → ChaCha20-Poly1305 AEAD key install, then
  symmetric anti-entropy (summary + delta exchange).
- **Authentication**: for remote events, role-gate looks up peer's
  credential in vault_credentials by device_id, gets account_id +
  device_pubkey, verifies event signature against device_pubkey,
  resolves the account's role at the event's HLC.

## The journey (and how many bugs we've found)

I spent the last several sessions with another Claude instance
debugging this. We ran a 6-agent parallel audit workflow that found 16
bugs. I shipped 11 of them. Here's the list, ranked by impact (the
audit's synthesis ranking):

| Bug   | What was broken                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| BUG-A | rebuildVaultHashIndex + advertise snapshot ran exactly ONCE in startShopMode. Pair-join didn't tell mesh → just-paired vault invisible to discovery until toggle off/on.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| BUG-B | state.connections.set had no matching delete. Every handshake leaked AEAD ctx, frame Map, GC interval, native event subs → Samsung A17 OOM in minutes.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| BUG-C | ble-plx allowDuplicates: false → peer emitted once per 20-min scan restart. Any transient → terminal for 20 min.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| BUG-F | Scanner with null UUID filter (correct fix) saw every BLE advert in range. No fingerprint check → strangers (AirPods, beacons) inflated seenDevices → 200-device circuit breaker tripped in any retail environment.                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| BUG-I | cachePeerVMC failure swallowed with console.warn. Handshake "succeeded" but every subsequent peer event got refused at role-gate (unknown_actor) silently.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| BUG-J | startShopMode set state.running=true before FGS start. FGS fail → radios kept running, next start no-op'd via idempotent guard.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| BUG-L | invalidateRoleGateCache prefix used " " (space) but cacheKey built keys with NUL. Per-vault eviction was a no-op for years → silent role staleness across delta batch boundary.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| BUG-M | pair-scan swallowed issueLocalVMC / cacheVMC failures with console.warn and advanced to "joined" screen. User thought they paired, actually had no self-VMC → handshake never sent a hello.                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| BUG-O | pair-scan pinned owner with peerVmcBlob: '' for +365 days. Broke extractRoleFromVmcBlob.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| BUG-Q | **NEW: Android BLE MAC randomization (NRPA, ~500ms rotation) made same physical peer appear as new MAC every scan tick. Our inflight dedup keyed on installIdShort which was derived from MAC. Every "new" peer triggered a fresh dialBLEPeer that CANCELLED the previous in-flight dial at the BLE driver layer. No handshake ever completed.** Fix: key inflight on vault_id for BLE transport.                                                                                                                                                                                                                                                                  |
| BUG-R | **NEW: Hermes doesn't ship globalThis.crypto. Our \_ed25519-setup.ts only shimmed @noble/ed25519's etc.randomBytes namespace. AEAD layer uses @noble/ciphers (ChaCha20-Poly1305) and @noble/curves (X25519) which call globalThis.crypto.getRandomValues() directly. Throws "[Error: crypto.getRandomValues must be defined]" → caught as MeshHandshakeError → handshake fails silently. This is THE bug — every prior "silent handshake failure" trace was actually this throwing, masked by BUG-Q's dial cancellations.** Fix: install crypto.getRandomValues polyfill via expo-crypto in \_ed25519-setup.ts, import it as the first import of app/\_layout.tsx. |

I'm about to push BUG-Q + BUG-R and rebuild. I want a fresh pair of
eyes on this before I do. **The app also still crashes mid-use after a
few minutes on both phones** (Xiaomi 10T and Samsung A17). Samsung
shows the "Clear cache" OS prompt — that's an OOM indicator. I shipped
BUG-B which was the strongest leak candidate, but the crash persists.

## What I want from you

I want a deep adversarial review. Specifically:

1. **Architecture review** of the mesh feature. Is the bidirectional
   QR pair flow + TOFU + role-gate carve-out sound? What attack
   surfaces have I left open? Are there race conditions I haven't
   seen? What corner cases will break in production but not in my
   testing?

2. **The crypto polyfill** (BUG-R fix). Is installing
   globalThis.crypto.getRandomValues via expo-crypto safe? Are there
   better alternatives (react-native-get-random-values, a native
   shim)? What about subtle crypto?

3. **The inflight dedup fix** (BUG-Q). Is keying on vault_id correct?
   What happens if two STAFF phones (same vault) come in BLE range of
   the OWNER simultaneously? The current fix would only dial the
   first; the second is dropped until the first completes. Is that
   right?

4. **The mid-use crash that persists.** Samsung A17 has 4-6GB RAM.
   Both phones crash after a few minutes. BUG-B was the strongest
   candidate (BleMeshConnection leak in state.connections) and is
   fixed. What else could be leaking? Suspects I'm worried about:
   - WebRTC peer connections from transport.ts (might not be closing
     on error)
   - kaata-gatt-server Kotlin module: per-central maps
     (connectedDevices, mtuByAddress, notifyMutexByAddress,
     firstValidWriteAtByAddress, pendingNotifyByAddress) — do they
     shrink on disconnect?
   - react-native-ble-advertiser's broadcast() being called every
     500ms from a rotation timer
   - BleMeshConnection's gcAssembly setInterval that markClosed is
     supposed to clear, but only if close() is actually called
   - expo-camera (pair-scan): does it release on navigation?
   - Notifee state from frequent updateShopModeNotification calls
   - Reanimated shared values

5. **react-native-ble-advertiser is archived since 2022.** We've
   patched it three times via expo config plugins (AGP 8 namespace,
   location permission leaks, compileSdkVersion bump to 36). Each
   Expo SDK upgrade is a roll of the dice. Should I rip it out and
   write a custom Kotlin Expo Module (the same way we did for
   kaata-gatt-server)? Or is there a better-maintained alternative?

6. **Trust model alternatives.** Current model:
   - Local-CA: owner's device key is the trust anchor for the vault.
   - VMC is a signed JSON blob; one VMC per (device, vault).
   - For joiner's first handshake (before pinned), TOFU bound to a
     5-min pair token window: if owner has a live unconsumed
     pendingPairToken for vault_id, accept any VMC signed by ANY key
     that matches the VMC's claimed device_pubkey. Vulnerable to: a
     stranger in BLE range who knows the vault_id (advertised as
     4-byte hash) and times their attack within the 5-min window.
   - The pair token isn't bound to a specific joiner identity — it's
     bound to "the next person who handshakes during the window".

   The deep audit flagged this and suggested a step 1 fix: extend the
   Hello message to carry pair_nonce, and require payload.pair_nonce
   === a live token's nonce. Step 2: wire consumePairToken from
   anti-entropy. Step 3 (future): mint joiner credential
   server/owner-side via a pair_claim/pair_grant exchange.

   Briar's bidirectional QR is the gold standard — both sides scan
   each other's QR, both end up with peer's pubkey pinned, no TOFU
   needed. Should I implement true bidirectional QR (owner ALSO scans
   joiner's QR) instead of layering more on top of TOFU?

7. **Privacy.** BLE advertiser broadcasts vault hashes (4-byte hex)
   in plaintext manufacturer data. A passive scanner outside a shop
   accumulates (vault_hash, BLE-MAC, timestamp) tuples. MAC is
   rotated by Android (NRPA) every ~500ms, but the vault hash is
   stable across sessions. A neighbour shop sees "vault hash Y is
   active right now". Tracking risk?

   Audit suggested mixing a day-rotor into the hash: hash =
   HMAC(vault_id, day_index). Receiver pre-computes a 1-day-rolling-
   window of tags. Worth doing?

8. **The BLE handshake protocol.** Current shape:
   - Central dials peripheral via GATT
   - MTU negotiation
   - CCCD subscribe to STREAM_CHAR
   - Hello exchange (vmc_blob + pop_nonce + ephemeral_pubkey)
   - VMC verify (3-path fallback: trust-anchor, pinned-peer, TOFU)
   - PoP signature verify
   - X25519 ECDH + HKDF-SHA512 derive AEAD key
   - ChaCha20-Poly1305 frame layer enables
   - Symmetric anti-entropy: summary + delta + apply

   The audit flagged BUG-G (CCCD race): peripheral fires Hello notify
   AS SOON AS mtuReady resolves; central might not have finished CCCD
   subscribe yet → notify silently dropped on Android → 10s recv
   timeout → handshake fail. I deferred this fix. With BUG-R landed,
   I'll know if BUG-G is real after testing. But is there a better
   handshake design that's race-free by construction?

9. **Anti-entropy correctness.** The audit didn't deeply inspect the
   summary/delta exchange logic. Could there be ordering bugs that
   cause events to be sent infinitely or missed?

10. **Anything else.** Adversarial review — I'm a solo dev and have
    been deep in this code for weeks. I'm blind to my own blind
    spots. Tell me everything that worries you.

---

## Files & code

I'm including the critical pieces. The repo is large; ask if you need
anything else.

### `apps/mobile/lib/mesh/_ed25519-setup.ts` (just patched with BUG-R fix)

```typescript
// Side-effect-only module — install the crypto shims that Hermes needs
// before any sign/verify/keygen call AND any AEAD / X25519 ECDH call.

import { sha512 } from "@noble/hashes/sha512";
import { etc } from "@noble/ed25519";
import * as ExpoCrypto from "expo-crypto";

etc.sha512Sync = (...m: Uint8Array[]) => sha512(etc.concatBytes(...m));
etc.randomBytes = (len?: number) => ExpoCrypto.getRandomBytes(len ?? 32);

declare const globalThis: {
  crypto?: { getRandomValues?: <T extends ArrayBufferView>(buf: T) => T };
};
if (typeof globalThis.crypto === "undefined") {
  (globalThis as { crypto: object }).crypto = {};
}
if (globalThis.crypto != null && typeof globalThis.crypto.getRandomValues !== "function") {
  (globalThis.crypto as { getRandomValues: unknown }).getRandomValues = <T extends ArrayBufferView>(
    buf: T,
  ): T => {
    const bytes = ExpoCrypto.getRandomBytes(buf.byteLength);
    new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength).set(bytes);
    return buf;
  };
}
```

### `apps/mobile/lib/mesh/pair-qr.ts` (the v=3 pair-QR schema)

```typescript
export const PAIR_QR_VERSION = 3;
export const PAIR_QR_TTL_MS = 5 * 60 * 1000;
export const PAIR_QR_MAX_PAYLOAD_BYTES = 768;

export type PairQrRole = "owner" | "editor" | "viewer";

export type PairQrPayload = {
  v: 1 | 2 | 3;
  vault_id: string;
  vault_name: string;
  issuer_account_id: string;
  issuer_install_id: string;
  issued_at_ms: number;
  expires_at_ms: number;
  shop_mode_token: string;
  vault_trust_anchor_pubkey?: string;
  role?: PairQrRole;
  // v=3 bidirectional pair fields
  issuer_device_pubkey?: string;
  issuer_display_name?: string;
};

export function decodePairQr(raw: string): PairQrValidationResult {
  // ... validates required fields, then for v=3 additionally requires
  // issuer_device_pubkey and issuer_display_name
}
```

### `apps/mobile/lib/mesh/discovery-ble.ts` (scanner — has BUG-F fingerprint check + BUG-C allowDuplicates)

```typescript
const startScan = () => {
  if (stopped) return;
  try {
    manager.startDeviceScan(
      null, // No UUID filter — react-native-ble-advertiser doesn't put
      // service UUID on the wire, only manufacturer data
      { allowDuplicates: true }, // BUG-C — emit every advert tick
      (error, device) => {
        if (stopped) return;
        if (error) return;
        if (!device) return;
        const raw = parseAdvertisement(device);
        if (!raw) return;
        emit(raw);
      },
    );
  } catch (err) {}
};

const emit = (peer: BLEPeerRaw) => {
  if (stopped || circuitTripped) return;
  const now = Date.now();
  // Per-device 5s suppression bounds emit rate under allowDuplicates: true
  const lastEmit = lastEmitByDevice.get(peer.deviceId);
  if (lastEmit != null && now - lastEmit < PER_DEVICE_EMIT_INTERVAL_MS) {
    return;
  }
  lastEmitByDevice.set(peer.deviceId, now);
  // ... emit rate limit, seenDevices accounting, circuit breaker check
  opts.onPeerFound(peer);
};

function parseAdvertisement(device): BLEPeerRaw | null {
  if (!device?.id) return null;
  const rssi = typeof device.rssi === "number" ? device.rssi : null;
  let capabilityFlags = 0;
  let vaultEpochHint = 0;
  let vaultHashes: string[] = [];
  const mfgB64 = device.manufacturerData;
  if (typeof mfgB64 !== "string" || mfgB64.length === 0) return null;
  let fingerprintOk = false;
  try {
    const bin = atob(mfgB64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    // BUG-F: require Kaata company ID 0xFFFF + reserved capability bits zero
    if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xff) {
      const rawCap = bytes[2];
      if ((rawCap & ~CAP_FLAGS_KNOWN_MASK) !== 0) return null;
      capabilityFlags = rawCap & CAP_FLAGS_KNOWN_MASK;
      vaultEpochHint = bytes[3];
      const hashBytes = bytes.subarray(4);
      const hashCount = Math.min(Math.floor(hashBytes.length / 4), MAX_ADVERTISED_VAULT_HASHES);
      for (let i = 0; i < hashCount; i++) {
        const slice = hashBytes.subarray(i * 4, i * 4 + 4);
        let hex = "";
        for (let j = 0; j < slice.length; j++) {
          hex += slice[j].toString(16).padStart(2, "0");
        }
        vaultHashes.push(hex);
      }
      fingerprintOk = true;
    }
  } catch {}
  if (!fingerprintOk) return null;
  return { kind: "ble", deviceId: device.id, rssi, vaultHashes, capabilityFlags, vaultEpochHint };
}
```

### `apps/mobile/lib/mesh/index.ts` (mesh barrel — has BUG-A, BUG-B, BUG-J, BUG-Q fixes)

```typescript
type RunState = {
  running: boolean;
  generation: number;
  // BUG-B: was leaking — every successful handshake added entry, never removed
  connections: Map<string, MeshConnection>;
  inflight: Set<string>;
  // BUG-B: separate count, increments on handshake success, decrements on close
  liveSessionCount: number;
  unsubscribeDiscovery: (() => void) | null;
  listenPort: number;
  peripheralStop: (() => Promise<void>) | null;
  peripheralGattStop: (() => Promise<void>) | null;
};

// BUG-A: refresh discovery + advertise when vault set changes
let lastAdvertisedHashSetKey = "";
export async function notifyVaultSetChanged(): Promise<void> {
  if (!state.running) return;
  try {
    await rebuildVaultHashIndex();
  } catch (err) {
    console.warn("[mesh.notifyVaultSetChanged] rebuildVaultHashIndex failed", err);
  }
  try {
    const snapshot = await snapshotVaultHashesForAdvertise();
    const key = snapshot
      .map((v) => `${v.vaultId}@${v.epochLow}`)
      .sort()
      .join(",");
    if (key === lastAdvertisedHashSetKey && state.peripheralStop != null) {
      return;
    }
    lastAdvertisedHashSetKey = key;
    if (state.peripheralStop) {
      try {
        await state.peripheralStop();
      } catch (err) {
        console.warn("[mesh.notifyVaultSetChanged] previous peripheral stop threw", err);
      }
      state.peripheralStop = null;
    }
    const next = await startBLEPeripheralMode({
      vaultHashes: snapshot,
      capabilityFlags: CAP_FLAG_SUPPORTS_WIFI_UPGRADE,
    });
    state.peripheralStop = next;
  } catch (err) {
    // ...
  }
}

async function handleRoutedPeer(routed: RoutedPeer, gen: number): Promise<void> {
  if (gen !== state.generation) return;
  const peerInfo = routed.peerInfo;
  if (routed.transport === "mdns" && routed.raw.isSelf) return;

  let chosenVaultId: string | null = null;
  let cachedBlob: string | null = null;
  for (const vid of peerInfo.matchedVaultIds) {
    const cached = await getCachedVMC(vid);
    if (cached) {
      chosenVaultId = vid;
      cachedBlob = cached.blob;
      break;
    }
  }
  if (!chosenVaultId || !cachedBlob) return;

  // BUG-Q: MAC randomization defeated installIdShort-keyed dedup.
  // Use vault_id-keyed gate for BLE — at most one in-flight dial per vault.
  const inflightKey =
    routed.transport === "ble"
      ? `ble:${chosenVaultId}`
      : `${peerInfo.installIdShort}:${chosenVaultId}`;
  if (state.inflight.has(inflightKey)) return;
  state.inflight.add(inflightKey);

  try {
    if (routed.transport === "mdns") {
      const conn = await dialPeerScheduled(/* ... */);
      await handlePeerConnection(conn, "outgoing", gen, {
        /* ... */
      });
    } else {
      // BLE
      const conn = await dialBLEPeer({ deviceId: routed.raw.deviceId });
      await handlePeerConnection(conn, "outgoing", gen, {
        /* ... */
      });
    }
  } catch (err) {
    if (err instanceof MeshTransportError) {
      console.warn("[mesh] dialPeer failed", peerInfo.serviceName, err.message);
    } else {
      console.warn("[mesh] dialPeer unexpected error", err);
    }
  } finally {
    state.inflight.delete(inflightKey);
  }
}

async function handlePeerConnection(conn, direction, gen, ctx?): Promise<void> {
  // ... resolves vault + cached VMC + trust anchor
  try {
    const result = await runAntiEntropy(conn, {
      /* ... */
    });
    if (gen !== state.generation) {
      void conn.close();
      return;
    }
    // BUG-B: anti-entropy is one-shot. Close conn after burst, don't
    // leak in connections Map. liveSessionCount tracks active sessions
    // for the activePeers status surface.
    state.liveSessionCount++;
    emitStatusChange();
    await touchLastActive();
    try {
      await conn.close();
    } catch {}
    state.liveSessionCount = Math.max(0, state.liveSessionCount - 1);
    emitStatusChange();
  } catch (err) {
    void conn.close();
    if (err instanceof MeshHandshakeError /* ... */) {
      emitMeshFailure({ kind: "peer_handshake_failed", reason: err.kind });
    } else {
      console.warn("[mesh] unexpected handshake/anti-entropy error", err);
      emitMeshFailure({ kind: "peer_handshake_failed", reason: "transport" });
    }
  }
}

// BUG-J: extracted teardown helper for partial-failure rollback
async function teardownRadios(opts: { skipFGS?: boolean } = {}): Promise<void> {
  // ... stops FGS (if !skipFGS), peripheral, GATT server, discovery,
  // router, transport listener; clears connections map, inflight,
  // liveSessionCount; resets dial scheduler
}

export async function startShopMode(): Promise<void> {
  if (state.running) return;
  try {
    await startShopModeBody();
  } catch (err) {
    state.running = false;
    const fgsLikelyFailed =
      err instanceof ShopModeForegroundServiceFailedError ||
      (err instanceof Error && /foreground/i.test(err.message));
    await teardownRadios({ skipFGS: fgsLikelyFailed });
    emitStatusChange();
    throw err;
  }
}

// startShopModeBody: eligibility check → ensureDeviceKey → reissueSelfVMCs
// → rebuildVaultHashIndex → startTransportListener → routerStartDiscovery
// → onPeerFound → startBLEPeripheralMode → startPeripheralGattAcceptLoop
// → state.running = true → startShopModeForegroundService
```

### `apps/mobile/lib/mesh/vmc.ts` (VMC verify + TOFU)

```typescript
// VMC = base64(canonical_json) + "." + base64(ed25519_signature)
// JSON: {v, vault_id, account_id, device_id, device_pubkey, role,
//        vault_epoch, issued_at_ms, expires_at_ms, iss}

export async function verifyVMCAgainstPinnedPeer(
  blob: string,
  expectedVaultId: string,
  vaultTrustAnchorPubkey?: Uint8Array | null,
): Promise<VerifyResult> {
  // Path A: standard trust-anchor verification (owner-self or
  // owner-issued VMCs verified by owner's own pubkey).
  const primary = await verifyVMC(blob, expectedVaultId, vaultTrustAnchorPubkey);
  if (primary.valid) return primary;
  if (primary.error !== "bad_signature") return primary;
  const peeked = peekVMCDeviceId(blob);
  if (!peeked) return primary;
  if (peeked.vault_id !== expectedVaultId) return primary;

  // Path B: pinned-peer fallback.
  const db = await getDb();
  const row = await db.getFirstAsync<{ device_pubkey: string }>(
    `SELECT device_pubkey FROM vault_credentials WHERE vault_id = ? AND device_id = ? LIMIT 1`,
    expectedVaultId,
    peeked.device_id,
  );
  if (row) {
    let pinnedPubkeyBytes: Uint8Array;
    try {
      const bin = atob(row.device_pubkey);
      pinnedPubkeyBytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) pinnedPubkeyBytes[i] = bin.charCodeAt(i);
    } catch {
      return primary;
    }
    if (pinnedPubkeyBytes.length !== 32) return primary;
    return await verifyVMC(blob, expectedVaultId, pinnedPubkeyBytes);
  }

  // Path C: TOFU bound to recent pair token. The OWNER just generated a pair
  // QR within the last 5 minutes. We accept the joiner's self-signed VMC
  // for THIS handshake only if owner has a valid unconsumed pair token.
  try {
    const localPair = require("./local-pair");
    const tokens = await localPair.getPendingPairTokensForVault(expectedVaultId);
    const now = Date.now();
    const live = tokens.some(
      (t) => t.expires_at_ms > now && (t.consumed_at_ms == null || t.consumed_at_ms === 0),
    );
    if (!live) return primary;
  } catch (err) {
    return primary;
  }

  // Parse the VMC payload, verify signature against the CLAIMED device_pubkey
  const peekedFull = peekVMCDeviceId(blob);
  if (!peekedFull) return primary;
  const split = splitBlob(blob);
  if (!split) return primary;
  const vmcPayload = parsePayload(split.payloadBytes);
  if (!vmcPayload) return primary;
  let claimedPubkeyBytes: Uint8Array;
  try {
    const bin = atob(vmcPayload.device_pubkey);
    claimedPubkeyBytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) claimedPubkeyBytes[i] = bin.charCodeAt(i);
  } catch {
    return primary;
  }
  if (claimedPubkeyBytes.length !== 32) return primary;
  return await verifyVMC(blob, expectedVaultId, claimedPubkeyBytes);
}

// cachePeerVMC writes vault_credentials row for a peer (called at
// handshake success after BUG-I retry-with-loud-fail)
```

### `apps/mobile/lib/mesh/anti-entropy.ts` (the handshake — abbreviated)

```typescript
async function handshake(
  conn: MeshConnection,
  ourHello: HelloMessage,
  opts: { vaultId: string; vaultTrustAnchorPubkey: Uint8Array | null },
): Promise<ParsedVMC> {
  // 1. Send our Hello (with VMC blob, pop_nonce, ephemeral_pubkey, cap flags)
  await sendMessage(conn, ourHello);
  // 2. Recv peer's Hello
  const peerHello = await recvTyped<HelloMessage>(conn, "hello", HELLO_RECV_TIMEOUT_MS);
  // 3. Early revocation check on the unverified VMC's device_id
  // 4. Verify peer's VMC (with the pinned-peer + TOFU fallback)
  const verifyResult = await verifyVMCAgainstPinnedPeer(
    peerHello.vmc_blob,
    opts.vaultId,
    opts.vaultTrustAnchorPubkey ?? null,
  );
  if (!verifyResult.valid) {
    throw new MeshHandshakeError(/* ... */);
  }
  const peerVMC = verifyResult.vmc;
  // 5. Re-check revocation against the now-trusted device_id
  // 6. Epoch gate
  // 7. Proof of Possession check (ed25519 sign + verify)
  // 8. Derive AEAD session key via X25519 ECDH + HKDF-SHA512
  //    ← THIS IS WHERE crypto.getRandomValues throws on Hermes
  const aeadCtx: BleAeadContext = deriveSessionAead({
    ownPriv: ourEphemeral.privateKey,
    ownPub: ourEphemeral.publicKey,
    peerPub: peerEphemeralPub,
    ownNonceB64: ourNonceB64,
    peerNonceB64: peerHello.pop_nonce,
  });
  // 9. Install AEAD on the connection
  const installer = (conn as any).installAead;
  if (typeof installer === "function") {
    installer.call(conn, aeadCtx);
  } else if (conn.kind === "ble") {
    throw new MeshHandshakeError("BLE connection has no installAead", "transport");
  }
  // 10. Cache peer's VMC into vault_credentials (BUG-I: retry 3x with backoff,
  //     throw on persistent failure)
  await cachePeerVMC({
    /* ... */
  });
  conn.remoteDeviceId = peerVMC.device_id;
  return peerVMC;
}

// After handshake, both sides exchange Summary + Delta messages
// (anti-entropy proper). Then conn.close() (BUG-B).
```

### `apps/mobile/lib/projection/role-gate.ts` (role check at applyEvent)

```typescript
const REQUIRED_ROLE: Record<EventType, RoleRequirement> = {
  entry_created: "editor",
  // ... most are "editor"
  shop_profile_updated: "owner",
  vault_setting_set: "owner",
  vault_member_added: "owner", // Note: but see self-add carve-out below
  vault_member_role_changed: "owner",
  vault_member_removed: "owner",
  account_bound: "none",
};

export async function checkRoleForEvent(tx, event): Promise<RoleGateResult> {
  const requirement = REQUIRED_ROLE[event.event_type];
  if (requirement === "none") return { ok: true };
  if (event.vault_id == null) return { ok: true };

  let actorAccountId = event.actor_account_id;
  if (event.origin === "remote") {
    const sig = event.event_sig_b64;
    if (!sig) return { ok: false, reason: "unsigned_event" /* ... */ };
    let signerPubkey = event.signer_device_pubkey ?? null;
    let authenticatedAccountId = null;
    const cred = await lookupSignerCredential(tx, event.vault_id, event.device_id);
    if (cred != null) {
      if (signerPubkey != null && signerPubkey !== cred.device_pubkey) {
        return { ok: false, reason: "bad_signature" /* ... */ };
      }
      signerPubkey = cred.device_pubkey;
      authenticatedAccountId = cred.account_id;
    } else if (signerPubkey != null) {
      // No credential row yet — refuse as unknown_actor
      return { ok: false, reason: "unknown_actor" /* ... */ };
    } else {
      return { ok: false, reason: "unsigned_event" /* ... */ };
    }
    // Verify signature
    const verify = verifyEventSignature(/* ... */);
    if (!verify.valid) return { ok: false, reason: "bad_signature" /* ... */ };
    actorAccountId = authenticatedAccountId;
  } else {
    if (actorAccountId == null && event.origin === "local") {
      actorAccountId = getAccountIdSync();
    }
  }

  // SELF-ADD carve-out for vault_member_added (Phase 6.1 interim).
  // Joiner emits vault_member_added(self) — REQUIRED_ROLE is "owner",
  // joiner is "editor", but we let the FIRST self-add through if:
  //   1. event_type === 'vault_member_added'
  //   2. payload.account_id === actorAccountId (self-add only)
  //   3. NO prior vault_members_mirror row (anti-replay)
  if (event.event_type === "vault_member_added") {
    const payload = event.payload as { account_id?: string };
    if (typeof payload?.account_id === "string" && payload.account_id === actorAccountId) {
      const existing = await tx.getFirstAsync<{ account_id: string }>(
        `SELECT account_id FROM vault_members_mirror WHERE vault_id = ? AND account_id = ? LIMIT 1`,
        event.vault_id,
        actorAccountId,
      );
      if (existing == null) return { ok: true };
    }
  }

  // ... rest: local-only fallback, cache lookup, resolveRoleAt, meetsRequirement
}
```

### `apps/mobile/lib/mesh/transport-ble.ts` (BLE peripheral + dial — partial)

```typescript
export const KAATA_MESH_SERVICE_UUID = "6b616174-6133-4d65-7368-000000000001";
// Service UUID — used for GATT server registration. NOT broadcast in
// adverts by react-native-ble-advertiser (only manufacturer data).

export async function startBLEPeripheralMode(
  opts: StartPeripheralOpts,
): Promise<() => Promise<void>> {
  if (Platform.OS !== "android") return async () => {};
  const BLEAdvertiser = require("react-native-ble-advertiser").default;
  // configure company ID, start broadcasting payload
  // payload = [companyId_LE_2bytes, capabilityFlags, vaultEpochHint, ...hashBytes]
  // Rotation: if >1 vault, swap advertised hash every 500ms
  // Restart: stop+restart broadcast every 20 min against OEM throttling
  const broadcastOnce = async (idx: number) => {
    if (stopped) return;
    const payloadBytes = buildPayload(idx);
    try {
      await BLEAdvertiser.broadcast(KAATA_MESH_SERVICE_UUID, Array.from(payloadBytes), {
        advertiseMode: BLEAdvertiser.ADVERTISE_MODE_BALANCED ?? 1,
        txPowerLevel: BLEAdvertiser.ADVERTISE_TX_POWER_MEDIUM ?? 2,
        connectable: true,
        includeDeviceName: false,
      });
    } catch (err) {
      if (__DEV__) console.warn("[ble-peripheral] broadcast iteration failed", err);
    }
  };
  // ... return stop function
}

export async function dialBLEPeer(opts: { deviceId: string }): Promise<MeshConnection> {
  // ble-plx connect + service discovery + CCCD subscribe + MTU negotiate
  // Returns a MeshConnection that has installAead() method
}

export async function startPeripheralGattAcceptLoop(opts): Promise<() => Promise<void>> {
  // Uses kaata-gatt-server custom Expo Module
  // On central connect: builds a MeshConnection wrapper, fires onIncomingConnection
}
```

### `apps/mobile/app/vault/pair-scan.tsx` (joiner side — abbreviated)

```typescript
async function onConfirmJoin() {
  // ... decode QR
  const isLocalCA = Boolean(payload.vault_trust_anchor_pubkey);
  await ensureDeviceKey();
  const devicePubkeyB64 = getDevicePubkey();
  const effectiveAccountId =
    ourAccountId ??
    (devicePubkeyB64
      ? buildLocalAccountId(devicePubkeyB64)
      : `local:${getInstallIdSync().slice(0, 16)}`);

  const db = await getDb();
  await db.withTransactionAsync(async () => {
    // Insert vaults row, shop_profile, vault_members_mirror (self + owner)
  });

  // Emit vault_member_added(self) event
  await eventLog.appendVaultMemberAdded({
    targetVaultId: payload.vault_id,
    accountId: effectiveAccountId,
    role: offered.role,
  });

  if (isLocalCA) {
    // (1) Issue self-VMC + cache as own (BUG-M: fail-loud if this fails)
    const { blob, expiresAtMs } = await issueLocalVMC({
      vaultId: payload.vault_id,
      peerAccountId: effectiveAccountId,
      peerDeviceId: installId,
      peerDevicePubkey: myDevicePubkey,
      role: offered.role,
      vaultEpoch: 0,
    });
    await cacheVMC(payload.vault_id, blob, expiresAtMs, effectiveAccountId, myDevicePubkey, 0);
    // (2) BUG-O dropped the empty-blob placeholder pin of owner identity.
    //     The BLE handshake's cachePeerVMC writes the real blob on first connect.

    await setAppMeta("shop_mode_enabled", "1");
    await setActiveVaultId(payload.vault_id);
    // BUG-A: tell mesh the vault set changed
    const mesh = await import("../../lib/mesh");
    await mesh.notifyVaultSetChanged();
    setStep({ kind: "joined" /* ... */ });
  }
}
```

### `apps/mobile/app/vault/pair.tsx` (owner side — abbreviated)

```typescript
async function issueQr(v, accId, chosenRole) {
  const token = await generateShopModeToken();
  const now = Date.now();
  const expires = now + PAIR_QR_TTL_MS;
  await ensureDeviceKey();
  const devicePubkey = getDevicePubkey();
  const localIssuerId = devicePubkey ? buildLocalAccountId(devicePubkey) : `local:${/* ... */}`;
  const self = await getLocalSelf();
  const ownerDisplayName = (self?.name ?? "").trim() || "Owner";
  const qrVersion: 2 | 3 = devicePubkey ? 3 : 2;
  const next: PairQrPayload = {
    v: qrVersion,
    vault_id: v.id,
    vault_name: v.name,
    issuer_account_id: accId ?? localIssuerId,
    issuer_install_id: getInstallIdSync(),
    issued_at_ms: now,
    expires_at_ms: expires,
    shop_mode_token: token,
    vault_trust_anchor_pubkey: v.vault_trust_anchor_pubkey ?? undefined,
    role: chosenRole,
    ...(qrVersion === 3 && devicePubkey ? {
      issuer_device_pubkey: devicePubkey,
      issuer_display_name: ownerDisplayName,
    } : {}),
  };
  // Server-side token registration (only for server-anchored)
  if (!v.vault_trust_anchor_pubkey && accId) {
    await registerVaultPairToken(v.id, token, expires);
  }
  // Persist token in canonical PendingPairToken format (matches local-pair.ts schema)
  await persistPendingPairToken({
    nonce: token,
    vault_id: v.id,
    vault_name: v.name,
    issued_at_ms: now,
    expires_at_ms: expires,
    role: chosenRole,
  });
  setPayload(next);
}
```

### `apps/mobile/lib/mesh/local-pair.ts` (PendingPairToken canonical type)

```typescript
export type PendingPairToken = {
  nonce: string; // base64-url
  vault_id: string;
  vault_name: string;
  issued_at_ms: number;
  expires_at_ms: number;
  consumed_at_ms?: number;
  consumed_by_device_id?: string;
  role?: LocalVMCRole;
};

export async function getPendingPairTokensForVault(vaultId): Promise<PendingPairToken[]> {
  const all = await readPendingTokens();
  return all.filter((t) => t.vault_id === vaultId);
}

// consumePairToken EXISTS but currently has ZERO callers — was supposed
// to be wired into anti-entropy after a successful TOFU verify, but the
// integration was deferred to a future phase.
export async function consumePairToken(args): Promise<{ vmc_blob; expires_at_ms; vault_id }> {
  /* ... */
}
```

---

## Logcat traces (sanitized)

The trace that revealed BUG-Q (MAC randomization):

```
23:04:18.001 [mesh.ble.dial] BLE peer matched vault= 943ec90a installIdShort= 7ce460df deviceId= 7C:E4:60:DF:BF:DF
23:04:18.001 [ble.dial] connecting deviceId= 7C:E4:60:DF:BF:DF
23:04:18.522 [discovery-ble] peer found id= 77:C6:E7:79:E4:80 vaultHashes= [ 'dcd19817' ]  ← same physical phone, new MAC
23:04:18.781 [mesh] dialPeer failed 7D:D2:6F:15:5D:A8 connectToDevice failed: Operation was cancelled
23:04:19.029 [discovery-ble] peer found id= 55:A4:49:32:E5:6E vaultHashes= [ 'b630a983' ]
23:04:19.036 [mesh.ble.dial] BLE peer matched vault= 943ec90a installIdShort= 55a44932 deviceId= 55:A4:49:32:E5:6E
... pattern repeats: same 2 vault hashes, new MAC every ~500ms, every dial cancelled
```

The trace that revealed BUG-R (Web Crypto missing):

```
23:52:55.722 [ble-gatt] central connected addr= 42:A5:9D:20:22:5F mtu= 23
23:52:55.723 [mesh.start.gatt] incoming BLE central accepted
23:52:55.736 [mesh.hs] start vault= 1b779c91 transport= ble
23:52:55.741 [mesh] unexpected handshake/anti-entropy error [Error: crypto.getRandomValues must be defined]
23:52:55.742 [mesh-ctl] peer handshake failed: transport
```

The trace shows the AEAD setup (deriveSessionAead) was the throw site
— it uses @noble/curves x25519 ECDH (which calls
globalThis.crypto.getRandomValues internally for the ephemeral key) AND
@noble/ciphers ChaCha20-Poly1305 (which calls getRandomValues for nonce
generation).

---

## Open questions

1. Architecturally — is this a sensible mesh design? Or am I building
   the wrong abstraction?
2. What's the real fix for trust model — keep TOFU + carve-out + nonce
   binding, or bite the bullet and ship true Briar-style bidirectional
   QR scan?
3. What's causing the mid-use crash? BUG-B was the strongest candidate
   and is fixed; what else?
4. Is the BLE handshake protocol robust enough, or do I need to
   redesign?
5. Should I rip out react-native-ble-advertiser and write custom
   Kotlin?
6. What attack surfaces have I left open? What can a hostile peer in
   BLE range do?
7. Anti-entropy summary/delta correctness — I haven't deeply
   inspected the exchange logic.
8. Anything else worth raising — fresh eyes catch what tired ones
   miss.

I appreciate honest, adversarial review. Don't sugarcoat.
