# M3 — LAN Transport (mDNS + TCP + Noise)

**Status:** ✅ IMPLEMENTED (code-gated; device smoke test pending), 2026-06-13. Child of
`sync-v2-architecture.md` §6.2. Adds the LAN driver, deletes WebRTC + the local signaling
server, retargets the BLE→bulk-channel upgrade at LAN.

**Done-criteria (from §9-M3):** two phones on an offline router converge a 1,000-event
delta < 10s; a packet capture shows ciphertext only; a third non-member phone on the same
LAN cannot complete a handshake.

---

## AS BUILT (deviations from the design below — read these first)

- **Files:** `lib/mesh/vault-digest.ts` (+ bun selftest), `lib/mesh/transport-lan.ts`
  (`LanMeshConnection` + framing/AEAD + native `dialLanPeer`/`startLanListener`; + bun
  selftest), `lib/mesh/discovery-lan.ts`. **Deleted:** `transport.ts`,
  `signaling-server.ts`, `scheduler.ts` (all WebRTC-coupled). Removed `react-native-webrtc`
  - `@config-plugins/react-native-webrtc` deps, the app.json plugin, and the now-orphaned
    `RECORD_AUDIO` + `MODIFY_AUDIO_SETTINGS` Android permissions (WebRTC-only). `kind` union:
    `"webrtc"` → `"lan"`.

- **Framing deviation (important):** §3 below shows the pre-AEAD frame as `[len][JSON]` and
  the post-AEAD frame as `[len][7-byte header][sealed]`. As built, the **7-byte header is
  ALWAYS present** (pre- and post-AEAD), body is pass-through when `aead===null` — i.e.
  structurally identical to `transport-ble.ts`. This was deliberate: it makes the AEAD
  transition use ONE parser instead of a state-dependent one, so a frame can never straddle
  the plaintext→sealed switch, and reuses `aead.ts sealChunk/openChunk` with the header as
  AAD verbatim. The header carries `frame_id`/`chunk_index=0`/`chunk_count=1`/`plaintext_len`.

- **AEAD fail-loud hardening:** `anti-entropy.ts` installs the session AEAD on any conn that
  exposes `installAead()` (LAN does). The fail-loud guard (missing installer ⇒ throw) was
  extended from `kind==="ble"` to also cover `kind==="lan"` — so a LAN conn can never
  silently run plaintext (defends done-criterion 2).

- **Trigger model = OPPORTUNISTIC (unchanged from the WebRTC era), not always-on.** LAN
  discovery (discovery-lan) spins up inside the BLE-coordinated wifi-upgrade window
  (`openUpgradeWindow`); the big-BLE-delta prompt now dials **LAN** instead of WebRTC. This
  satisfies all three done-criteria for two in-range phones (BLE bootstraps, then the
  1,000-event delta jumps to TCP). **Known characteristic:** LAN currently requires BLE to
  bootstrap the rendezvous, so a "shared Wi-Fi but BLE disabled/unsupported" pair won't
  auto-form a LAN session. If device testing shows that case matters, the clean follow-up is
  an **always-on `startLan` router adapter** (parallel to BLE) — orthogonal to the transport
  itself, which is done and tested.

- **Still deferred:** M3.5 (swap the HLC-frontier summary for the author_seq version vector);
  the device smoke test (1,000-event convergence < 10s, ciphertext-only packet capture,
  third-phone refusal) — none of these can run in CI.

---

---

## 1. The seam already exists

The recon settled the architecture question: `lib/mesh/transport-interface.ts` already
defines `MeshConnection { sendJSON; recvJSON; close; kind; remoteDeviceId }`, and
`anti-entropy.ts` consumes ONLY that — it is already transport-agnostic. The M2c handshake
(Hello v2: ephemeral X25519 + membership proof_bundle + PoP-v3 signature over the
transcript) running on top of it IS the "Noise-XX binding membership proof" §6.2 asks for.

So M3 does **not** invent a SecureStream abstraction or a new handshake. It adds one more
`MeshConnection` implementation — over a TCP socket — and a discovery driver that finds
LAN peers and dials it. The handshake + delta loop are reused unchanged.

## 2. What's in M3 (and what is deliberately NOT)

**In:**

- `transport-lan.ts` — `LanMeshConnection` (a `MeshConnection` over an injectable socket
  adapter, AEAD-sealed post-handshake), a TCP listener, and `dialLanPeer({host, port})`.
- `discovery-lan.ts` — mDNS publish/scan advertising the TCP listen port + **salted daily
  vault digests** (replaces the current unsalted `SHA256(vault_id)[0:8]`).
- Orchestration wiring: LAN listener under Shop Mode; LAN adapter in the discovery router;
  LAN peers dial through the existing `handlePeerConnection` path; dedup by device_id;
  preference LAN > BLE.
- Delete WebRTC: `transport.ts`, `signaling-server.ts`, the `react-native-webrtc` +
  `@config-plugins/react-native-webrtc` deps and the app.json plugin.
- Retarget the wifi-upgrade escalation: BLE detects a big delta → prompt → dial the **LAN**
  transport instead of WebRTC.

**NOT in M3 (explicitly deferred to M3.5):** swapping the delta protocol's
`max_hlc_per_device` summary for the M1 author_seq **version vector**. The architecture
(§5) flags M3 as "where strict vectors take over," but that is a protocol change to the
SHARED (BLE + LAN) anti-entropy loop and is independent of the transport. Shipping the LAN
transport on the proven HLC-frontier summary hits all three done-criteria with bounded
risk; the vector swap layers on afterward without touching the transport. (The author_seq
bookkeeping stays advisory-correct on every channel meanwhile.)

## 3. Framing & encryption (TCP)

TCP is a reliable ordered byte stream, so framing is trivial vs BLE's 203-byte chunks:

```
wire frame (pre-AEAD handshake):   [4-byte BE length][JSON bytes]
wire frame (post-AEAD, steady):    [4-byte BE length][ 7-byte AEAD header (AAD) ][ ChaCha20-Poly1305 sealed JSON ]
```

- The handshake messages (Hello, PoP) travel **plaintext-framed** (length-prefixed JSON),
  exactly as today — they carry their own ephemeral-key agreement + signatures; an
  eavesdropper learns only the membership-proof bundle (public membership events) and
  pubkeys, never ledger content. The session AEAD is installed the instant PoP succeeds
  (mirroring `transport-ble.ts installAead`); every delta/summary message after is sealed.
  Result: a packet capture shows ciphertext for all ledger data (done-criterion 2).
- Reuse `aead.ts` verbatim (`deriveSessionAead` / `sealChunk` / `openChunk`, the 7-byte
  header as AAD, direction-tag + monotonic-counter nonces). No new crypto.
- `LanMeshConnection` takes an injectable socket adapter
  `{ write(bytes); onData(cb); onClose(cb); destroy() }` — same inversion as the BLE
  adapter — so the bun selftest drives two back-to-back connections through an in-memory
  pipe and runs the REAL handshake + a real delta. The native side wires
  `react-native-tcp-socket` (`createConnection` for dial, `createServer` for listen) into
  that adapter.
- 16 MiB hard frame cap (OOM defense, same as WebRTC's reassembler).

## 4. Discovery — salted daily vault digests

The current mDNS TXT advertises `SHA256(vault_id)[0:8]` — stable forever, so an outsider
who once learns the mapping can track a shop across LANs and days. M3 fixes the linkability
(§6.2):

- `digest(vault_id, dayNumber) = HMAC-SHA256(key = vault_id_bytes, msg = "kaata-mesh-day:" + dayNumber)[0:8]`,
  base64url. The **vault_id is itself the shared secret** — every member holds it, no
  outsider does — so members compute identical digests for a day while an outsider cannot
  compute any. `dayNumber = floor(unixMs / 86_400_000)`.
- Publishers advertise digests for **today and tomorrow** (and accept today/yesterday/
  tomorrow on scan) to bridge the midnight rollover + ±1-day clock skew.
- mDNS service `_kaata-mesh._tcp.`, TXT `h="<digest>,<digest>,..."` (cap 3, like BLE),
  `d="<install_id_short>"`, `pt="<tcp_port>"`, `v="3"`. The advertised port is now the
  **TCP listener**, not the dead WebRTC signaling port. A scanner resolves a service,
  matches any advertised digest against its own member-vault digest set, and on a hit dials
  `dialLanPeer({ host, port })`.
- A non-member can't produce a matching digest (no vault_id) and, even if it dials, the
  handshake's membership-proof verification refuses it (done-criterion 3 — defense in depth:
  digest privacy is for unlinkability, the chain is the actual access control).

## 5. Orchestration

- `startShopMode` additionally starts the TCP listener (OS-assigned port) and passes that
  port to the discovery router's new LAN adapter; `stopShopMode` tears both down. Gated by
  the same generation counter as today.
- The discovery router gains a `startLan` adapter alongside `startBle`/`startMdns`. mDNS is
  now driven by the LAN driver (not the WebRTC discovery.ts), so the old `openUpgradeWindow`
  WebRTC path is replaced: BLE's big-delta prompt opens an mDNS window and dials LAN.
- Inbound (listener-accepted) and outbound (dialed) connections both flow into the existing
  `handlePeerConnection`; the post-handshake `device_id` dedup + `liveSessionCount` are
  unchanged. **Preference LAN > BLE:** when the router has both a LAN and a BLE candidate
  for the same `install_id_short`, hold the BLE dial briefly and prefer LAN; if LAN fails,
  fall back to BLE. (Cheap because a redundant second channel converges to a no-op delta.)

## 6. Deleting WebRTC

- Remove `lib/mesh/transport.ts`, `lib/mesh/signaling-server.ts`.
- Remove `react-native-webrtc` + `@config-plugins/react-native-webrtc` from
  `package.json` and the plugin from `app.json` (one fewer native dep, smaller APK, no more
  ICE/SDP timeout towers). `react-native-tcp-socket` STAYS (the LAN listener uses it; the
  signaling server's old use of it goes away).
- `wifi-upgrade.ts`: keep the BLE→bulk escalation UX (estimator, prompt, concurrent-init
  `dropme` arbitration) but point its dial at `dialLanPeer`. The `upgradeListenPort`
  becomes the TCP port.
- Verify nothing else imports the deleted modules (`transport-interface.ts` `kind` union
  loses `"webrtc"`, gains `"lan"`).

## 7. Tests (bun, in-memory — the real-risk surface)

- **digest**: determinism (same vault+day → same digest), member-vs-outsider (outsider
  without vault_id can't reproduce), rollover/skew window membership.
- **framing + AEAD round-trip**: two `LanMeshConnection`s over an in-memory pipe;
  length-prefix reassembly across arbitrary chunk boundaries; AEAD seal/open; 16 MiB cap.
- **handshake + delta (the keystone)**: drive the REAL `runAntiEntropy` between two
  in-memory-paired `LanMeshConnection`s with two seeded local event logs — wait, that needs
  SQLite, so this test runs the handshake-and-framing layer with a stubbed
  ingest/summary; the full delta convergence is the device smoke test. The handshake state
  machine (Hello/PoP/AEAD-install) IS exercised in-memory.
- Device smoke test (manual, can't run here): two phones on an offline router, Shop Mode
  on, 1,000-event delta converges < 10s; packet capture ciphertext-only; a third phone not
  in the vault is refused.

## 8. Implementation order

- **M3a** salted-digest module + bun test; `transport-lan.ts` framing/AEAD over the
  injectable adapter + in-memory pipe test.
- **M3b** `discovery-lan.ts` (mDNS retarget) + native socket adapter (`react-native-tcp-socket`).
- **M3c** orchestration wiring (index.ts + discovery-router LAN adapter, LAN>BLE preference,
  dedup) + retarget wifi-upgrade.
- **M3d** delete WebRTC (transport.ts, signaling-server.ts, deps, plugin) + import sweep.
- **M3e** adversarial review + gate sweep.
