# Briar-architecture port plan (mesh/sync)

Goal (user mandate, 2026-06-18): kaata's mesh should **be** Briar's architecture,
not kaata's design with Briar-flavored patches. "If it isn't Briar, I don't want
it." Transports: Bluetooth + WiFi-LAN + WiFi-hotspot, no internet.

Derived from a 16-agent file-by-file extraction of the real Briar source
(`~/Projects/briar-reference`, `~/Projects/dont-kill-me-lib-reference`). Branch:
`headless-bg-sync`.

## Verdict
Feasible; ~60% already exists. kaata's native engine already runs resident in the
FGS (`KaataForegroundService`), already has `MeshConnection` (fromBluetooth +
fromTcp), already keeps the strong layers (`MeshTrust` chain-fold, `MeshHandshake`
PoP-v3, `MeshCrypto` ephemeral AEAD, `MeshIngest`, `MeshEventSig` — parity-tested).
What is NOT Briar is the SHAPE: `MeshEngine.runWindow()` is a monolithic,
per-tick-spawned, BT-only blob with no Plugin model, no ConnectionManager/Registry,
no Poller/Backoff, no record protocol, no resident lifecycle.

## Keep vs replace
REPLACE WITH BRIAR (engine shape): `discovery-router.ts` + `btc-steady.ts` (JS) →
Poller+Backoff + `Plugin.poll()` resident-native; `MeshEngine.runWindow` monolith →
PluginManager + per-transport Plugins + ConnectionManager + ConnectionRegistry +
Poller/Backoff; inline `runSession` → two-threaded duplex sessions on an ioExecutor;
JSON-over-JSON wire → Briar Record framing (VERSIONS/PRIORITY/delta) with a v3-JSON
fallback during cutover; per-window run → resident `MeshLifecycleManager` +
`MeshEventBus` started once in `FGS.onCreate`; native LAN (NEW).

KEEP (kaata's strong layers become Briar's pluggable validation — this IS how Briar
is built: trust-agnostic sync + pluggable `ValidationManager`): `MeshTrust` →
`KaataMessageValidator`; `MeshHandshake` PoP-v3 → connection-auth gate; `MeshCrypto`
ephemeral AEAD → transport security (forward-secret; stronger than Briar's static
TransportKeys — do NOT port Briar's BTP here); `MeshEvent/MeshEventSig/MeshIngest/
MeshPlanner/MeshDb/MeshHlc` unchanged, under the Briar layers.

Clean line: **Briar owns "how bytes move + connections are managed"; kaata owns
"who is allowed + whether an event is real."** Security is NOT downgraded.

## Phases (each compiles; app keeps syncing via the JS path behind the gate until P8)
1. **Plugin seam** — `TransportId/PluginState/TransportPlugin/TransportPluginCallback/
   TransportPluginFactory` + `BtcRfcommPlugin` wrapping today's accept/dial logic;
   `MeshEngine.runWindow` becomes a thin shim. No behavior change. (L)
2. **PluginManager + resident lifecycle** — `TransportPluginManager`,
   `MeshLifecycleManager`, `MeshEventBus`, `Backoff`, `MeshPoller`; FGS flips from
   per-tick spawn to resident-start-once (gated). (L)
3. **ConnectionManager + ConnectionRegistry** — two-threaded duplex sessions on an
   ioExecutor; per-vault dedup → registry. (L)
4. **Record protocol** — `RecordWriter/Reader` + `SyncRecordWriter/Reader`
   (VERSIONS/PRIORITY/delta) under the AEAD byte stream; VERSIONS negotiation so
   v3-JSON and v4-Record peers interoperate. (L)
5. **Event-driven sessions** — `IncomingMeshSession`/`OutgoingMeshSession` +
   factory; local writes wake the outgoing session via `MeshEventBus`. (XL)
6. **Native LAN plugin** — `LanTcpPlugin` (ServerSocket accept + NsdManager mDNS +
   TCP dial) reusing `MeshConnection.fromTcp`; suppress JS discovery-lan when native
   active. (XL)
7. **Hotspot plugin (Briar-style)** — `HotspotPlugin` + `WifiDirectGroupManager`
   (`WifiP2pManager.createGroup` → AP at 192.168.49.1 → mDNS → LAN TCP stack);
   driven by the existing wifi-upgrade lex-winner race. Briar has no hotspot
   transport — it folds WiFi-Direct into LAN; we expose it as its own Plugin. (XL)
8. **Validation seam + retire JS** — `ValidationManager` + `KaataMessageValidator` +
   `KaataIncomingMessageHook`; delete JS `anti-entropy.ts/discovery-router.ts/
   btc-steady.ts` + `KaataMeshHeadlessService`; native flag defaults ON w/ remote
   rollback. (XL)

## Migration risks + staging
- Two engines on one radio → `KaataBgMeshGate` single-mesh guard gates native-vs-JS;
  native flag default OFF until JS suppressed for a cohort; JS stays default until P8.
- Wire incompatibility → VERSIONS negotiation + JSON fallback; SUPPORTED=[3,4] until
  the fleet is past v4.
- MeshDb thread-safety under the pool → WAL + busy_timeout (present); add a 2-peer
  concurrent-write test before P3 lands the pool.
- Resident lifecycle vs FGS 5s rule → `startServices()` off the `startForeground`
  critical path (own thread); keep wakelock + revival alarm + START_STICKY.
- Hotspot/WifiP2p OEM flakiness → own flag, createGroup retry + LocalOnlyHotspot
  fallback, BT always-available bootstrap.
- Every phase: `gradlew compileDebugKotlin` green + app syncs via JS path behind gate.

Full extraction output: workflow `wfa1363b6`. See [[briar_parity_audit]] memory.
