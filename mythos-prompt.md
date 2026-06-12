# Kaata mid-use CRASH — diagnosis request for Mythos

I'm Matee's middleman again. He's frustrated: the app **crashes after a few minutes of active use** and he's reported it multiple times across our sessions. Several fixes were attempted (BUG-B connections-map leak, P1 killing a 500ms broadcast-restart, FGS gating for MIUI, stopWithTask, an SDK-36 BLE-advertiser patch) and **none of them stopped the crash.** I ran five parallel read-only agents over the entire mesh + native + app-resource + build surface. Their findings are below. Diagnose the crash and tell me exactly what to fix.

## The crash, precisely

- **Symptom:** app dies after ~2-10 minutes of active use (mesh sync on, two phones).
- **Samsung A17:** the OS shows a **"Clear cache"** prompt around the crash. (Could be RAM OOM-killer, could be storage — the agents weighed in below.)
- **Xiaomi 10T:** also crashes mid-use.
- **Reproduces with Nearby sync ON.** The user has not run the dumpsys/meminfo/bugreport protocol yet (he dislikes adb — which is _why_ he's asking for a backend crash-reporter as a separate task; that's not yet built).
- We do **NOT** have a meminfo slope or a crash bugreport. So part of your answer should be: given the code evidence, what's the highest-probability cause, AND what single piece of device data would confirm it (so the upcoming backend crash-reporter can capture exactly that).

## Hard constraints (do not suggest violating these)

- `newArchEnabled = false` (legacy bridge) — locked by project constraint.
- Hermes JS engine.
- Mobile uses npm (Expo SDK 54 needs package-lock.json).
- `react-native-ble-advertiser` is archived (2022) and already patched 3x via config plugins; a custom Kotlin advertiser is a known-but-deferred option.
- EAS keystore is irrecoverable; never regenerate.
- The encryption stays (AEAD per BLE frame).

## The consensus suspect (all agents converged)

Every agent independently landed on the same prime suspect: **react-native-ble-plx's RxAndroidBle Device cache, which caches one BluetoothDevice/BluetoothGatt object per MAC address with NO eviction**, combined with `startDeviceScan(null, { allowDuplicates: true })`. Native heap, invisible to JS heap snapshots — which matches "OS clear-cache OOM, not a JS crash." P1 (killing the 500ms advertiser MAC churn) should have _reduced_ the inflow, but the central scan still uses allowDuplicates:true and nothing ever evicts the manager's Device registry except destroying the BleManager on Shop-Mode-OFF (which never happens mid-session). The Kotlin GATT server's per-central maps mostly DO clean up on disconnect, but there are flagged gaps around pending-notify drain and rapid-reconnect. Full evidence per area below.

---

## Area 1 — Mesh connection lifecycle (timers, maps, subscriptions)

_Every timer/interval/Map/subscription across connect→handshake→teardown, and whether close() cleanup runs on all paths._

### Summary

HIGH native ble-plx Device cache leak; native not JS, BUG-B fixed only the JS map.

### Code

#### Shared BleManager singleton only destroyed on Shop Mode off

`c:/Users/Matee/Desktop/Projects/Kaata/kaata/apps/mobile/lib/mesh/transport-ble.ts` lines `677-688` — SUSPECT 1 root. Manager plus native Device registry live the whole session; cancelConnection never evicts; only the discovery-ble stop fn destroys it.

```
getSharedBleManager returns an existing module-level singleton or assigns a new blePlx BleManager; discovery-ble injects the same instance.
```

#### dialBLEPeer teardown cancelConnection only no manager evict

`c:/Users/Matee/Desktop/Projects/Kaata/kaata/apps/mobile/lib/mesh/transport-ble.ts` lines `541-671` — SUSPECT 1 mechanism. teardown closes the link but never forgets the Device; RxAndroidBle keeps it referenced. Native growth invisible to JS heap snapshots, matches OS clear-cache OOM.

```
device equals manager connectToDevice; teardown removes the two subs and calls device cancelConnection; no manager forget or clearCache anywhere.
```

#### discovery-ble stop fn ONLY place BleManager is destroyed

`c:/Users/Matee/Desktop/Projects/Kaata/kaata/apps/mobile/lib/mesh/discovery-ble.ts` lines `326-348` — manager destroy the only clear of the native Device registry runs only on Shop Mode off; during a multi-minute session it never runs, so every dial Device accumulates.

```
Stop fn clears scanRestartTimer, removes stateSub, calls stopDeviceScan then manager destroy.
```

#### BleMeshConnection markClosed JS cleanup is complete

`c:/Users/Matee/Desktop/Projects/Kaata/kaata/apps/mobile/lib/mesh/transport-ble.ts` lines `291-498` — Per-connection JS state is NOT the leak - interval, Map, resolvers and both native subs are released. Narrows the hunt to the native manager Device cache.

```
assemblyGcTimer is a 5000ms setInterval; markClosed clears it, drains resolvers, clears the assembly Map, calls both unsubs; close calls markClosed then adapter teardown.
```

---

## Area 2 — Native layer (Kotlin GATT server, ble-advertiser, ble-plx)

_The prime OOM surface: per-central maps, BluetoothGatt handle lifecycle, ble-plx Device cache._

### Summary

## Mid-Use OOM Crash — Native Bluetooth Layer Analysis

**Crash Profile**: App dies after 2-10 minutes of sync, Samsung A17 shows "Clear cache" prompt (OOM killer), affects both Xiaomi 10T + Samsung A17.

**Root Cause Suspects** (ranked by severity and evidence):

### 1. **CRITICAL: react-native-ble-plx Device Cache Explosion**

**File**: `apps/mobile/lib/mesh/discovery-ble.ts` (line 240-250)
**Evidence**: `startDeviceScan(null, { allowDuplicates: true })` + RxAndroidBle device caching

- allowDuplicates:true emits a callback for EVERY BLE advertisement packet (~500ms cadence per peer)
- ble-plx internally uses RxAndroidBle which caches ONE BluetoothDevice object per MAC address with NO eviction policy
- Each cached Device object holds: BluetoothGatt native reference, service/characteristic discovery results, and GATT handle state
- **Before Mythos #1 fix** (lines 816-840): transport-ble.ts was calling `BLEAdvertiser.broadcast()` every 500ms to rotate vault hashes, which mints a fresh random BLE MAC on most Android stacks → OUR OWN ADVERTISER was the MAC churn engine, not NRPA's privacy rotation
- Result: ble-plx Device cache grew linearly with number of MAC addresses seen (we were generating hundreds from our own phone)
- **Severity**: HIGH — native heap allocation per Device object, never freed until app restart

### 2. **HIGH: Kotlin Per-Central Maps — BluetoothGatt Handle Lifecycle Issues**

**File**: `apps/mobile/modules/kaata-gatt-server/android/src/main/java/expo/modules/kaatagattserver/KaataGattServerModule.kt`
**Evidence**:

- `connectedDevices.remove(address)` on STATE_DISCONNECTED (line 581) ✓
- `clearPerAddressState(address)` removes from all other maps (lines 530-533) ✓
- internalClose() clears all maps and snapshot+invokes pending resolvers (lines 375-390) ✓
- **BUT**: onConnectionStateChange at line 557 detects rapid-reconnect and replaces old Device (line 570) WITHOUT guaranteeing native BluetoothDevice object's Binder-thread state is released
- **No pre-close drain of pending notifications** before server.close() (line 369) — if onNotificationSent callbacks never fire (on bad health), resolvers wait forever and GATT handles may not be released
- **Severity**: HIGH — Android has ~32 global GATT slots; leaked handles cause "GATT status 135" on new dials

### 3. **HIGH: BluetoothGattServer.close() May Not Release All Handles**

**File**: `KaataGattServerModule.kt` lines 359-393 (internalClose)
**Evidence**:

- Iterates `connectedDevices.values.toList()` and calls `cancelConnection()` (lines 363-365)
- BUT if STATE_DISCONNECTED callback is in-flight on Binder thread, device may already be removed from map by the time we iterate
- No explicit flush/drain of pending notifies before close — pendingNotifyByAddress map is snapshot+cleared but if onNotificationSent never fired, handles may not be released by OS
- **Severity**: HIGH — exhausts global GATT pool, subsequent dials fail

### 4. **MEDIUM-HIGH: ble-plx Subscription Leaks on Exception Path**

**File**: `apps/mobile/lib/mesh/transport-ble.ts` lines 591-665 (central) and lines 1010-1226 (peripheral)
**Evidence**:

- `monitorCharacteristicForService` subscription stored in `sub` and removed in teardown (lines 651-652)
- Closure over `chunkListeners` Set keeps Device reference alive
- If BleMeshConnection constructor throws (line 1144) before connection is handed off, teardown never fires → subscription persists
- Exception handler at line 1145-1152 swallows errors but doesn't guarantee cleanup
- **Severity**: MEDIUM-HIGH — each leaked subscription = one active native listener keeping memory bound

### 5. **MEDIUM: BleManager Instance Accumulation on Start-Stop Cycles**

**File**: `apps/mobile/lib/mesh/discovery-ble.ts` lines 140-153, 341-348
**Evidence**:

- New BleManager() created at startBle() entry (line 143)
- Stop function calls `manager.destroy?.()` (line 344)
- BUT if destroy() fails or swallows exception (line 345), manager leaks
- If user toggles mesh on/off repeatedly, each instance's internal RxAndroidBle cache persists
- **Severity**: MEDIUM — cumulative leak over app lifetime if stop/start cycles occur

### 6. **MEDIUM: Idle-Connect Reaper Timer on Rapid-Reconnect Churn**

**File**: `KaataGattServerModule.kt` lines 509-524
**Evidence**:

- Launches 30s delay coroutine per connect (line 511-523)
- Device object held in closure until timeout or completion
- On rapid reconnect, old device replaced but reaper coroutine still running for 30s
- Rapid churn (thousands of devices) = thousands of in-flight coroutines = coroutine scheduler thrashing
- **Severity**: MEDIUM — dangerous only if device churn is high (e.g., BLE advertising environment)

### 7. **MEDIUM: Frame Assembly Map Growth on Slow/Dropped Frames**

**File**: `apps/mobile/lib/mesh/transport-ble.ts` lines 290, 363-371, 398-422
**Evidence**:

- AssemblyEntry map accumulates per-frameId state (line 290)
- gcAssembly() prunes entries older than 30s every 5s (line 316)
- Under high peer churn, hundreds of entries can accumulate before GC
- JS heap accumulation (not critical for native OOM) but still memory pressure
- **Severity**: MEDIUM — affects JS heap, competes with native for OS free memory

### 8. **LOW: Notifee ForegroundService Auto-Restart Cascade**

**File**: `apps/mobile/plugins/withNotifeeForegroundService.js` lines 40-58
**Evidence**:

- `stopWithTask=false` allows OS to auto-restart service when app is killed (OOM trigger)
- If service restarts before JS bundle loads, BLE teardown callbacks never fire
- Orphaned connections continue trying to operate, secondary resource exhaustion
- **Severity**: LOW — cascade symptom, not primary cause

---

## Synthesis: Most Likely Root Cause Chain

1. **Primary**: ble-plx Device cache explosion from `startDeviceScan(null, { allowDuplicates: true })`
   - Especially if Mythos #1 fix (stable payload, 20-min restart) NOT deployed
   - OUR advertiser restarting every 500ms minted new MACs → Device cache unbounded → native heap filled

2. **Secondary**: BluetoothGatt handle exhaustion (32 global slots)
   - After cache fills, new dial attempts get "status 135" (connection refused)
   - Rapid reconnect loop from retry logic stresses Binder thread

3. **Tertiary**: Rapid-reconnect map churn + pending-notify timeout
   - connectedDevices.replace() on same MAC may not fully release old Device native reference
   - onNotificationSent callbacks may never fire on bad-health links
   - GATT handles not released by OS → cascades to exhaustion

---

## Verified Clean Paths

✓ **Kotlin per-central map cleanup**: All maps removed in `clearPerAddressState()` and final clear in `internalClose()`

✓ **TypeScript subscription cleanup**: `startPeripheralGattAcceptLoop` collects subscriptions in array and removes all on stop

✓ **Advertiser frequency**: Mythos #1 fix now builds ONE stable payload and only restarts every 20 min (not 500ms)

✓ **ble-plx Device teardown**: `dialBLEPeer` teardown calls sub.remove(), discSub.remove(), device.cancelConnection()

---

## Known Gotchas & OEM Variability

- **onMtuChanged may never fire** on some Spreadtrum/MediaTek ROMs → peripheral's MTU-ready promise times out after 5s
- **GATT_BUSY retry** only 3 attempts × 50ms before notify fails — sustained busy = cascade failure
- **allowDuplicates: true** without Mythos #1 fix (MAC-rotation in advertiser) WILL cause Device cache explosion
- **RxAndroidBle cache not visible** in app code — can only be cleared via BleManager.destroy()

### Ranked leak suspects

- **[HIGH] ble-plx RxAndroidBle Device Cache Explosion from allowDuplicates:true Scan**
  - Evidence: discovery-ble.ts line 250 enables allowDuplicates:true which emits callback for every BLE packet (~500ms per peer). ble-plx uses RxAndroidBle internally which caches one BluetoothDevice object per MAC with NO eviction. Each Device holds native BluetoothGatt references and service discovery results. If advertiser (before Mythos #1 fix) called BLEAdvertiser.broadcast() every 500ms, it minted fresh MAC on most Android stacks, causing OUR advertiser to generate hundreds of distinct MACs. Device cache grew unboundedly; native heap exhausted on Samsung A17.
- **[HIGH] BluetoothGatt Global Handle Pool Exhaustion (Android ~32 slots)**
  - Evidence: KaataGattServerModule.kt internalClose() (lines 359-393) calls server.close() but does NOT guarantee all GATT handle slots released if: (1) pendingNotifyByAddress resolvers waiting but onNotificationSent never fires (bad health links), (2) monitorCharacteristicForService subscriptions alive but device disconnected. Once slot pool exhausted, new dials fail with 'GATT status 135' (connection refused), triggering rapid reconnect loops stressing Binder thread.
- **[HIGH] Rapid-Reconnect BluetoothDevice Reference Replacement Without Full GC**
  - Evidence: KaataGattServerModule.kt line 557-570: STATE_CONNECTED for address already in connectedDevices triggers rapid-reconnect detection. clearPerAddressState() removes old maps but OLD BluetoothDevice reference replaced (line 570) in connectedDevices without explicit Java-side release. Native BluetoothDevice on Binder thread may hold internal GATT handle state outliving Java reference, causing handle leaks. Code comment at line 551-556 confirms 'rapid-reconnect handling' scenario.
- **[MEDIUM] ble-plx monitorCharacteristicForService Subscription Leak on Exception**
  - Evidence: transport-ble.ts lines 591-610 and 1116-1120: subscriptions stored in Sets and closures keep Device reference alive. If BleMeshConnection constructor throws (line 1144) before connection added to centrals map, teardown never fires. Subscriptions persist forever keeping native listener active. Exception handlers swallow errors without guaranteeing cleanup.
- **[MEDIUM] BleManager Instance Accumulation on Start-Stop Cycles**
  - Evidence: discovery-ble.ts lines 140-153: new BleManager() created at startBle entry, destroy() called in stop (line 344). If destroy() throws or swallowed exception (line 345), manager instance leaks. If user toggles mesh on/off repeatedly, multiple BleManager instances accumulate, each with internal RxAndroidBle cache not freed. No lifecycle tracking across restart boundaries.
- **[MEDIUM] Idle-Connect Reaper Coroutine Holds Device Reference for 30 Seconds**
  - Evidence: KaataGattServerModule.kt lines 509-524: scope.launch creates coroutine delaying 30s and checking if device connected. Device object held in closure until timeout. On rapid reconnect, old device replaced but reaper coroutine still runs 30s. If device churn is high (thousands connecting/disconnecting), thousands of in-flight coroutines cause scheduler thrashing and memory accumulation.
- **[MEDIUM] Frame Assembly Map Unbounded Growth on Slow/Dropped Frames**
  - Evidence: transport-ble.ts lines 290, 363-371, 398-422: AssemblyEntry map accumulates per-frameId state. gcAssembly() prunes entries older than 30s every 5s. Under high peer churn, hundreds of entries accumulate before GC. JS heap accumulation (not critical for native OOM) but memory pressure competing with native allocation.
- **[LOW] Notifee ForegroundService Auto-Restart Before JS Loads**
  - Evidence: withNotifeeForegroundService.js line 58: stopWithTask=false allows OS auto-restart when app killed (OOM trigger). Service restarts before JS bundle loads; notifee callback for BLE teardown never fires. Orphaned connections continue operating, secondary resource exhaustion amplifying leak impact.

### Code

#### Kotlin GATT Server Module — Per-Central Maps and Cleanup

`c:/Users/Matee/Desktop/Projects/Kaata/kaata/apps/mobile/modules/kaata-gatt-server/android/src/main/java/expo/modules/kaatagattserver/KaataGattServerModule.kt` lines `118-133` — These are the per-central state maps holding BluetoothDevice objects and callbacks. Each map is the critical cleanup verification point.

```
  // Per-connection state (concurrent so callback path doesn't need the
  // top-level mutex on the binder thread).
  private val connectedDevices = ConcurrentHashMap<String, BluetoothDevice>()
  private val mtuByAddress = ConcurrentHashMap<String, Int>()
  // One mutex per device serializes notification dispatch.
  private val notifyMutexByAddress = ConcurrentHashMap<String, Mutex>()
  // Pending notify resolver, set BEFORE notifyCharacteristicChanged fires.
  // Passes the Int status code from onNotificationSent (GATT_SUCCESS=0,
  // GATT_BUSY=0x84, etc.) so the caller can branch on retry-able codes.
  // Sentinel values for synchronous failures: -1 (pre-33 boolean false),
  // -2 (close drained pending).
  private val pendingNotifyByAddress = ConcurrentHashMap<String, (Int) -> Unit>()
  // Idle-connect reaper: tracks first-valid-write per address so a central
  // that never authenticates is force-disconnected after IDLE timeout.
  private val firstValidWriteAtByAddress = ConcurrentHashMap<String, Long>()
```

#### Kotlin Disconnect Handler — Map Removal on STATE_DISCONNECTED

`c:/Users/Matee/Desktop/Projects/Kaata/kaata/apps/mobile/modules/kaata-gatt-server/android/src/main/java/expo/modules/kaatagattserver/KaataGattServerModule.kt` lines `580-588` — Disconnect handler removes from connectedDevices and calls clearPerAddressState, which removes from all other per-address maps.

```
        BluetoothProfile.STATE_DISCONNECTED -> {
          connectedDevices.remove(address)  // REMOVES from map ✓
          clearPerAddressState(address)      // Calls remove on other maps ✓
          val payload = HashMap<String, Any?>()
          payload["address"] = address
          payload["status"] = status
          sendEvent(EVENT_DISCONNECTED, payload)
          Log.i(TAG, "central disconnected addr=$address status=$status")
```

#### Kotlin clearPerAddressState Function — Per-Address Map Removals

`c:/Users/Matee/Desktop/Projects/Kaata/kaata/apps/mobile/modules/kaata-gatt-server/android/src/main/java/expo/modules/kaatagattserver/KaataGattServerModule.kt` lines `529-534` — All per-address maps are explicitly removed here. mtuByAddress.remove(), notifyMutexByAddress.remove(), firstValidWriteAtByAddress.remove() all present; pendingNotifyByAddress.remove() + invoke sentinel. Cleanup logic is present.

```
  private fun clearPerAddressState(address: String) {
    mtuByAddress.remove(address)                        // mtuByAddress.remove() ✓
    notifyMutexByAddress.remove(address)                // notifyMutexByAddress.remove() ✓
    firstValidWriteAtByAddress.remove(address)          // firstValidWriteAtByAddress.remove() ✓
    pendingNotifyByAddress.remove(address)?.invoke(-2)  // pendingNotifyByAddress.remove() + invoke(-2) ✓
```

#### Kotlin internalClose Function — Final Map Clear and Pending Resolver Drain

`c:/Users/Matee/Desktop/Projects/Kaata/kaata/apps/mobile/modules/kaata-gatt-server/android/src/main/java/expo/modules/kaatagattserver/KaataGattServerModule.kt` lines `360-393` — Close path snapshot+clears pendingNotifyByAddress and invokes all resolvers with sentinel -2. All other maps cleared. Final cleanup when server torn down.

```
  private fun internalClose() {
    val server = gattServer ?: return
    try {
      for (dev in connectedDevices.values.toList()) {
        try { server.cancelConnection(dev) } catch (_: Throwable) { /* */ }
      }
      service?.let {
        try { server.removeService(it) } catch (_: Throwable) { /* */ }
      }
      try { server.close() } catch (_: Throwable) { /* */ }
    } finally {
      gattServer = null
      service = null
      handshakeChar = null
      streamChar = null
      connectedDevices.clear()              // connectedDevices.clear() ✓
      mtuByAddress.clear()                  // mtuByAddress.clear() ✓
      notifyMutexByAddress.clear()          // notifyMutexByAddress.clear() ✓
      firstValidWriteAtByAddress.clear()    // firstValidWriteAtByAddress.clear() ✓
      val pending = pendingNotifyByAddress.toMap()  // snapshot BEFORE clear
      pendingNotifyByAddress.clear()        // pendingNotifyByAddress.clear() ✓
      for ((_, resolve) in pending) {
        try { resolve(-2) } catch (_: Throwable) { /* */ }
      }
```

#### Discovery BLE — allowDuplicates:true Scan Setup (Critical Leak Point)

`c:/Users/Matee/Desktop/Projects/Kaata/kaata/apps/mobile/lib/mesh/discovery-ble.ts` lines `240-263` — allowDuplicates:true emits callback for EVERY advertisement. Combined with RxAndroidBle per-MAC caching, floods Device cache if our advertiser rotates MACs.

```
      manager.startDeviceScan(
        null,  // CRITICAL: null UUID filter, not [KAATA_MESH_SERVICE_UUID]
        // BUG-C: allowDuplicates: true — emit a callback for every
        // advertising packet (~500ms cadence). Without this, the
        // scanner emits each peer exactly once per 20-min scan
        // restart, so any transient failure on first sighting
        // (vault index stale, pair token not yet persisted, MTU
        // race, CCCD race) becomes terminal until the next restart.
        // The PER_DEVICE_EMIT_INTERVAL_MS guard above bounds the
        // emit rate to 1 per peer per 5s.
        { allowDuplicates: true },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (error: any, device: any) => {
          if (stopped) return;
          if (error) {
            if (__DEV__) console.warn("[discovery-ble] scan error", error?.message);
            return;
          }
          if (!device) return;
          const raw = parseAdvertisement(device);
          if (!raw) return;
          emit(raw);
        },
      );
```

#### Transport BLE — Mythos #1 Fix: Stable Payload, 20-min Restart Only

`c:/Users/Matee/Desktop/Projects/Kaata/kaata/apps/mobile/lib/mesh/transport-ble.ts` lines `816-884` — This is the critical fix for MAC-rotation leak. Old code restarted advertiser every 500ms (minting new MACs for cache explosion). New code builds one payload and restarts every 20 min only.

```
  // Mythos #1 fix: build ONE stable payload containing all vault hashes
  // and advertise ONCE. No 500ms rotation. The previous code called
  // BLEAdvertiser.broadcast() every ADV_ROTATION_MS to cycle hashes,
  // which on most Android stacks minted a NEW random BLE MAC on each
  // call — making OUR advertiser the MAC-rotation engine. That defeated
  // the central side's per-MAC dedup (BUG-Q symptom) AND triggered the
  // ble-plx Device cache growth that's the leading suspect for the
  // mid-use OOM crash on Samsung A17.
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

  await broadcastStable();
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
```

#### Transport BLE Central — Subscription Cleanup in Teardown

`c:/Users/Matee/Desktop/Projects/Kaata/kaata/apps/mobile/lib/mesh/transport-ble.ts` lines `587-667` — Central side subscriptions correctly removed in teardown. However, if teardown never called (exception in BleMeshConnection constructor), subscriptions leak.

```
  const chunkListeners = new Set<(c: Uint8Array) => void>();
  const disconnectListeners = new Set<() => void>();

  const sub = device.monitorCharacteristicForService(
    serviceUuid,
    streamCharUuid,
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

  const discSub = device.onDisconnected(() => {
    for (const l of disconnectListeners) {
      try {
        l();
      } catch {
        /* */
      }
    }
  });

  teardown: async () => {
    try {
      sub.remove?.();           // sub.remove() removes monitorCharacteristic subscription ✓
    } catch {
      /* */
    }
    try {
      discSub.remove?.();       // discSub.remove() removes disconnect subscription ✓
    } catch {
      /* */
    }
    try {
      await device.cancelConnection();  // Closes GATT connection ✓
    } catch {
      /* */
    }
  },
```

#### Transport BLE Peripheral — Event Subscription Collection and Cleanup

`c:/Users/Matee/Desktop/Projects/Kaata/kaata/apps/mobile/lib/mesh/transport-ble.ts` lines `1004-1227` — Peripheral side collects all native module subscriptions in array and removes all on stop. Cleanup is thorough.

```
  const centrals = new Map<string, PeripheralCentralState>();
  const subscriptions: Array<{ remove: () => void }> = [];  // Subscription array for cleanup ✓
  let stopped = false;

  const subConn = kaataOnCentralConnected(({ address, mtu }) => { /* ... */ });
  subscriptions.push(subConn);  // Push to array ✓

  const subMtu = kaataOnMtuChanged(({ address, mtu }) => { /* ... */ });
  subscriptions.push(subMtu);  // Push to array ✓

  const subWrite = kaataOnCentralWrite((evt: KaataCentralWriteEvent) => { /* ... */ });
  subscriptions.push(subWrite);  // Push to array ✓

  const subDisc = kaataOnCentralDisconnected(({ address, status }) => { /* ... */ });
  subscriptions.push(subDisc);  // Push to array ✓

  return async () => {
    stopped = true;
    for (const sub of subscriptions) {
      try {
        sub.remove();            // Remove all subscriptions ✓
      } catch {
        /* */
      }
    }
    for (const cs of centrals.values()) {
      if (!cs.mtuReadyDone) {
        cs.mtuReadyDone = true;
        cs.rejectMtuReady(new Error("accept loop stopped"));
      }
      for (const h of cs.disconnectListeners) {
        try {
          h();  // Call disconnect listeners ✓
        } catch {
          /* */
        }
      }
    }
    centrals.clear();            // Clear centrals map ✓
    if (gattStop) {
      try {
        await gattStop();        // Close GATT server ✓
      } catch {
        /* */
      }
      gattStop = null;
    }
  };
```

#### TypeScript GATT Server Binding — Event Subscription Handlers

`c:/Users/Matee/Desktop/Projects/Kaata/kaata/apps/mobile/modules/kaata-gatt-server/src/index.ts` lines `143-174` — All four event subscriptions return EventSubscription with .remove() method. These are collected by startPeripheralGattAcceptLoop and properly removed on stop.

```
export function onCentralConnected(
  handler: (event: CentralConnectedEvent) => void,
): EventSubscription {
  if (Platform.OS !== "android") return { remove: () => {} };
  return getNative().addListener("onCentralConnected", (e: any) =>
    handler(e as CentralConnectedEvent),
  );  // Returns EventSubscription with .remove() ✓
}

export function onCentralDisconnected(
  handler: (event: CentralDisconnectedEvent) => void,
): EventSubscription {
  if (Platform.OS !== "android") return { remove: () => {} };
  return getNative().addListener("onCentralDisconnected", (e: any) =>
    handler(e as CentralDisconnectedEvent),
  );  // Returns EventSubscription with .remove() ✓
}

export function onCentralWrite(handler: (event: CentralWriteEvent) => void): EventSubscription {
  if (Platform.OS !== "android") return { remove: () => {} };
  return getNative().addListener("onCentralWrite", (e: any) => handler(e as CentralWriteEvent));
  // Returns EventSubscription with .remove() ✓
}

export function onMtuChanged(handler: (event: MtuChangedEvent) => void): EventSubscription {
  if (Platform.OS !== "android") return { remove: () => {} };
  return getNative().addListener("onMtuChanged", (e: any) => handler(e as MtuChangedEvent));
  // Returns EventSubscription with .remove() ✓
}
```

### Open questions

- Has Mythos #1 fix (stable payload, 20-min restart only) been deployed to affected Samsung A17 and Xiaomi 10T users? If old code calling BLEAdvertiser.broadcast() every 500ms still running, it WILL generate MAC churn and trigger Device cache explosion.
- What is BLE environment where crash occurs? High peer density (retail floor with many BLE devices)? Circuit breaker keys on vault-hash-set fingerprint after Mythos P3 fix; older code has MAC-keyed accounting which trips within a minute.
- Are there logcat entries showing 'GATT status 135' or 'GATT_BUSY' warnings? This confirms global GATT handle exhaustion or sustained notify failures.
- Does crash always occur after exactly 2-10 minutes, or duration varies? Fixed duration suggests timeout or timer; variable suggests accumulation (cache filling over time).
- Are there other native modules besides react-native-ble-advertiser, react-native-ble-plx, and kaata-gatt-server that allocate BluetoothGatt or Device objects?
- Is JS bridge in high traffic during 2-10 min window or idle? If idle, BleMeshConnection's 5s assembly GC timer still running, indicating high frame-drop rate.

---

## Area 3 — App-level resources (FGS/notifee, camera, reanimated, WAL)

_Resource lifecycle outside the mesh transport; plus the RAM-vs-storage question for the 'Clear cache' prompt._

### Summary

Mid-use OOM is most likely RAM (native heap) from BLE central scanning, NOT storage/WAL. The repo confirms it: transport-ble.ts:816-823 names ble-plx Device cache growth as the leading Samsung A17 OOM suspect; index.ts:226-230 documents a prior connections-Map leak (BUG-B). Samsung Clear cache is Android low-memory dialog, not file bloat. Storage ruled out: WAL uses default wal_autocheckpoint (self-truncates) and SQLite is in databases not cache. HIGH: discovery-ble.ts:240-263 startDeviceScan with allowDuplicates true fires ~every 500ms with a fresh native ble-plx device; JS dedup Maps are pruned but native Device objects accumulate for the BleManager lifetime, and Shop Mode never auto-offs (MeshController.tsx:38-44), so native heap climbs to OOM. MEDIUM: updateShopModeNotification re-issues a full displayNotification on every status change (foreground.ts:211, emitStatusChange on handshake close index.ts:992). MEDIUM: discovery-ble.ts:344 manager.destroy does not null transport-ble.ts \_sharedBleManager (678-688), a stale handle for the dial path. MEDIUM: connections Map may retain BleMeshConnection objects (assembly Map + 5s timer at transport-ble.ts:316 + AEAD ctx) if close is skipped on an error path. LOW (ruled out): home rail spring stops in cleanup; Toast animations stop on unmount; expo-camera only renders in scanning step; all app intervals have paired clears. db.ts:118-121 is the entire PRAGMA setup; a periodic wal_checkpoint TRUNCATE would be tidy but will not fix the crash.</summary>
<parameter name="leak_suspects">[{"suspect":"ble-plx native Device cache growth under allowDuplicates true scan, held for the never-auto-off BleManager lifetime","evidence":"discovery-ble.ts:240-263 fires ~every 500ms with a fresh native device; JS Maps pruned (166-203,284-285) but native Device objects retained; manager only destroyed on teardown (344); Shop Mode never auto-offs (MeshController.tsx:38-44); code names it the leading Samsung A17 OOM suspect (transport-ble.ts:821-823).","severity":"high"},{"suspect":"Foreground notification re-issued on every handshake start/close via full displayNotification","evidence":"MeshController.tsx:181-199 calls updateShopModeNotification on every status change; emitStatusChange fires on handshake success (index.ts:978) and close (992); foreground.ts:211-241 re-emits a complete notification.","severity":"medium"},{"suspect":"Stale destroyed shared BleManager handle reused by the dial path","evidence":"discovery-ble.ts:344 destroy does not null transport-ble.ts:678 _sharedBleManager; getSharedBleManager returns the destroyed instance until next start; stop-then-dial race uses a dead manager.","severity":"medium"},{"suspect":"connections Map possibly retaining BleMeshConnection objects if close is skipped on an error path","evidence":"index.ts:226-230 documents BUG-B where connections were never removed; transport-ble.ts:424-453 cleans up only if markClosed runs; ctor 5s setInterval at 316 orphaned otherwise.","severity":"medium"},{"suspect":"SQLite WAL growth / storage exhaustion","evidence":"db.ts:118-121 sets WAL with no wal_autocheckpoint override and no manual checkpoint anywhere in lib; default autocheckpoint self-truncates; SQLite is in databases not cache. Ruled out as primary.","severity":"low"}]

### Code

#### ble-plx Device cache is the named OOM suspect

`apps/mobile/lib/mesh/transport-ble.ts` lines `816-823` — Codebase names ble-plx Device cache growth as the leading OOM suspect; advertiser MAC churn fixed but central scan still uses allowDuplicates true.

```
triggered the ble-plx Device cache growth that is the leading suspect for the mid-use OOM crash on Samsung A17
```

#### Central scan allowDuplicates true, fresh native Device ~500ms

`apps/mobile/lib/mesh/discovery-ble.ts` lines `240-263` — Callback fires per advertising packet handing JS a native Device; JS Maps pruned but native objects accumulate for the manager lifetime while shop mode never auto-offs.

```
manager.startDeviceScan(null, { allowDuplicates: true }, (error, device) => { if (!device) return; const raw = parseAdvertisement(device); if (!raw) return; emit(raw); });
```

#### Shared BleManager not nulled after destroy

`apps/mobile/lib/mesh/transport-ble.ts` lines `678-688` — discovery-ble.ts:344 destroy does not null this global; the dial path gets the destroyed instance until next start re-sets it.

```
let _sharedBleManager = null; function getSharedBleManager(blePlx){ if(_sharedBleManager) return _sharedBleManager; _sharedBleManager = new blePlx.BleManager(); return _sharedBleManager; }
```

#### Shop Mode does not auto-off

`apps/mobile/components/MeshController.tsx` lines `38-44` — With no auto-off the BleManager and its native device cache run for hours, so RAM climbs monotonically to OOM.

```
Phase 7 founder decision: Nearby sync does NOT auto-off. Foreground service keeps the radio alive until the user toggles off.
```

#### Notification re-issued on every status change

`apps/mobile/components/MeshController.tsx` lines `181-199` — Full displayNotification each time; emitStatusChange fires on handshake success and close, so a busy BLE room churns notifee state many times per minute.

```
mesh.onShopModeStatusChange((s) => { await fg.updateShopModeNotification({ body }); });
```

#### WAL setup at DB open, no checkpoint

`apps/mobile/lib/db.ts` lines `118-121` — Entire PRAGMA setup; default autocheckpoint self-truncates WAL; no checkpoint in lib; SQLite is in databases not cache, so storage is not the crash driver.

```
PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;
```

#### BUG-B prior connections Map leak

`apps/mobile/lib/mesh/index.ts` lines `226-230` — Confirms a prior monotonic-growth leak; counter fixed but verify the connections Map itself is deleted on close.

```
BUG-B: state.connections.size used to be the activePeers source and leaked monotonically because connections were never removed. activePeers: state.liveSessionCount
```

#### BLE connection 5s timer cleared on close

`apps/mobile/lib/mesh/transport-ble.ts` lines `424-453` — Each connection has a 5s setInterval (ctor:316); markClosed clears it; risk only if close is never reached on an error path.

```
private markClosed(){ if(this.closed) return; this.closed=true; if(this.assemblyGcTimer){ clearInterval(this.assemblyGcTimer); } this.assembly.clear(); }
```

#### Home rail spring stopped in cleanup

`apps/mobile/app/index.tsx` lines `361-370` — Rules out the home swipe rail: single useRef value, spring stopped on cleanup, gesture memoized.

```
useEffect(() => { const animation = Animated.spring(translateX, { toValue: target }); animation.start(); return () => animation.stop(); }, [direction, screenWidth, translateX]);
```

#### expo-camera only in scanning step

`apps/mobile/app/vault/pair-scan.tsx` lines `474-487` — CameraView mounts only in scanning; other steps unmount it and navigation releases the native camera; transient screen, not the OOM surface.

```
{step.kind === 'scanning' ? (<CameraView onBarcodeScanned={onBarcodeScanned} />) : null}
```

### Open questions

- Does state.connections actually delete(key) on handshake close, or only liveSessionCount--? Confirm the Map is pruned or BleMeshConnection objects accumulate.
- Does the scan restart (discovery-ble.ts:280-290) reuse the SAME BleManager (keeping the native Device cache) or destroy+recreate? If same manager, the native cache is never flushed between restarts.
- Does the installed ble-plx version retain scanned Device objects for the manager lifetime? Check package.json ble-plx version and take a native heap dump.
- Confirm expo-sqlite SDK54 on-device default for PRAGMA wal_autocheckpoint; if disabled, a periodic wal_checkpoint TRUNCATE becomes necessary.
- Is the crash reproducible with Shop Mode OFF? If yes, BLE suspects are eliminated and the focus shifts to the event-log apply path or the Google avatar Image cache (index.tsx:566-567).

_Files consulted: apps/mobile/lib/mesh/foreground.ts, apps/mobile/lib/mesh/foreground-bootstrap.ts, apps/mobile/components/MeshController.tsx, apps/mobile/app/\_layout.tsx, apps/mobile/app/index.tsx, apps/mobile/app/vault/pair-scan.tsx, apps/mobile/components/Toast.tsx, apps/mobile/components/AutoSync.tsx, apps/mobile/components/ProjectionConflictsListener.tsx, apps/mobile/lib/db.ts, apps/mobile/lib/db-tx.ts, apps/mobile/lib/projection-conflicts.ts, apps/mobile/lib/use-vault-summary.ts, apps/mobile/lib/mesh/transport-ble.ts, apps/mobile/lib/mesh/discovery-ble.ts, apps/mobile/lib/mesh/scheduler.ts, apps/mobile/lib/mesh/index.ts_

---

## Area 4 — Crash history + prior fix attempts

_What's already been tried so you don't re-suggest a dead end._

### Summary

CRASH HISTORY — "app dies after a few minutes of active use; Samsung A17 shows OS Clear-cache prompt; Xiaomi 10T also crashes; reported multiple times; prior fixes didn't work."

There are TWO distinct documented crash families in this repo's history, and the existing fixes attack the SECOND one (FGS lifecycle) while the SYMPTOM the user reports (dies after a few minutes of _active use_, OS "Clear cache" prompt) matches the FIRST one (OOM / monotonic resource growth in the mesh layer). This is the key insight for Mythos: the FGS fixes are real but address a startup/teardown crash, not a steady-state leak.

================= TIMELINE OF MESH/CRASH WORK =================

v0.5.0 (d1899f0): "multi-Kaata, offline staff management, Bluetooth Nearby sync" — first mesh.
ef70bdb: "disable New Architecture (fixes launch crash)" — an earlier, separate launch-time crash, unrelated to mid-use.
v0.5.2 (d454592 / 4f68b9b): BLE peripheral GATT server + AEAD + foreground service stopWithTask + rename mirror.

d8391ad "Local Android build fixes" — TWO OOM-adjacent items but both are BUILD-TIME, not runtime:

- withGradleJvmArgs: bumped org.gradle.jvmargs to -Xmx8192m / MaxMetaspaceSize=2048m because the Expo template's 4096m/512m OOMed during kspReleaseKotlin + lintVitalAnalyzeRelease. (This is the Gradle daemon OOMing on the build machine — NOT the phone. Mythos should not confuse this with the device crash.)
- withBleAdvertiser: bumped react-native-ble-advertiser compileSdk/targetSdk 28→36 (AGP8+JDK17 rejected <30) and fixed an upstream package-name typo `bleavertiser`. Build-only.

5f4e301 "v0.5.2 fixes: ... defensive FGS cleanup ... FGS stopWithTask, BLE advertiser SDK 36 patch" — ADDED a step-4 to foreground-bootstrap.ts that called notifee.stopForegroundService() unconditionally at JS boot as "defensive cleanup of zombie FGS state." THIS WAS THE BUG, not the fix.

574a101 "Fix Xiaomi/MIUI FGS crash: gate stopForegroundService on actual running state" — REVERTED the 5f4e301 step-4. Root cause (confirmed via logcat on 10T / MIUI 14): an unconditional stopForegroundService() at boot dispatches a notifee HeadlessJS task via Context.startService(); MIUI's HardenedAccessControl treats it as a real FGS start; the headless task never calls Service.startForeground(); after 5s the OS throws ForegroundServiceDidNotStartInTimeException and force-kills → "Send feedback" dialog. Fix: only call stopForegroundService() when state.running/wasRunning is true (the wasRunning gate in stopShopMode), plus the big DO-NOT-call warning block now permanently in foreground-bootstrap.ts lines 123-144.

921cf7e "v0.5.3: 9-bug mesh + crash fix pass" — contains THE leak fix the user is probably thinking of:

- BUG-B (conn leak): state.connections Map grew monotonically — every successful handshake added an entry that was NEVER removed; per-conn AEAD ctx, frame-assembly Map, 5s assemblyGcTimer, and native event-subscription closures all retained. Comment explicitly says "Samsung A17 OOM-crashed after a few minutes." Fix: treat anti-entropy as a "one-shot burst" — after runAntiEntropy returns, conn.close() and drop it; Map now only holds mid-handshake conns; activePeers is a separate bounded liveSessionCount counter.
- BUG-C (allowDuplicates): scanner switched to allowDuplicates:true (was emitting peers once per 20-min scan), guarded by a 5s PER_DEVICE_EMIT_INTERVAL_MS so it doesn't flood.
- FGS rollback: stopWithTask flipped false (Briar-style keep-running on swipe-away) in withNotifeeForegroundService.js, with partial-failure teardownRadios rollback (BUG-J).
- role-cache eviction bug fix (NUL vs space separator).

2855ca9 / 2ba249b "Mythos audit P1-P4: kill 500ms ad churn ..." — P1 removed the 500ms BLE advertiser rotation timer entirely (transport-ble.ts). The OLD code called BLEAdvertiser.broadcast() every ~500ms to rotate hashes, and because broadcast() mints a fresh random BLE MAC on most stacks, OUR OWN advertiser was the MAC-rotation engine — defeating dedup AND churning native advertiser objects twice a second. P3 re-keyed the circuit breaker from MAC to vault-hash-set (the MAC churn tripped it within a minute in an empty room). P4 made the crypto.getRandomValues polyfill a structural first-import (index.js) so a BLE-handshake getRandomValues path couldn't throw and fail bundle load. Kept the 20-min OEM-throttle restart timer (single restart, not churn).

16e9375 / 10d61e8: migration 014 data-loss fix — unrelated to crash.

================= WHY THE SHIPPED FIXES MIGHT NOT HAVE STOPPED AN OOM =================

1. BUG-B fixed the connections Map, but the "one-shot burst" close path is on the HAPPY path only. If runAntiEntropy throws after liveSessionCount++ but the inner conn.close() also throws, or if a handshake never reaches the close (timeout/MTU-fail), the per-conn native subscriptions and the 5s assemblyGcTimer in BleMeshConnection are only released by adapter.teardown()/markClosed — verify every failure branch actually calls close(). With allowDuplicates:true + 500ms-MAC-churn (pre-P1) the dial/handshake-fail rate was very high, so the leak could live on the FAILURE path even after BUG-B "fixed" the success path.
2. The fixes target the connections Map and the advertiser timer, but the PERIPHERAL side (startPeripheralGattAcceptLoop) keeps a `centrals` Map and a per-central setTimeout (MTU timeout, line 1075) whose timer ref is "intentionally not stored" so it can't be cleared — under rapid reconnect churn these timers and PeripheralCentralState entries accumulate until disconnect fires. If STATE_DISCONNECTED is missed (the H3 case the code itself acknowledges), entries are only replaced on the next same-MAC connect — but MAC randomization means the next connect has a DIFFERENT address, so the stale entry is never replaced or deleted → unbounded centrals Map growth.
3. The FGS crash fixes (574a101, stopWithTask reversal) address a STARTUP/teardown crash (5s ForegroundServiceDidNotStartInTimeException), which presents as an immediate crash on launch/toggle — NOT "after a few minutes of active use." The user's symptom timing points at steady-state growth, not the FGS path.
4. stopWithTask=false (v0.5.3) means the mesh + BLE scan/advertise + GATT server KEEP RUNNING after swipe-away. The plugin comment itself admits the trade-off: "an OS-killed FGS that auto-restarts BEFORE JS loads can still crash on very low-end devices" and flags a native AndroidService as the real 0.5.4 fix — i.e. they KNOW the FGS path is not fully fixed.
5. None of the fixes added device-side memory instrumentation; every diagnosis so far is from logcat breadcrumbs + a code-read inference ("Samsung A17 OOM-crashed after a few minutes" is asserted in a comment, not backed by a captured meminfo trace). So there is no proof the A17 crash was ever the connections Map and not something else (Hermes heap, native BLE buffers, notifee).

CRASH-CAPTURE TOOLING: scripts/capture-crash.sh exists (adb logcat, filters AndroidRuntime:E/I, ReactNativeJS:V, ActivityManager:I, KaataGattServer:I; --auto = 30s, else wait-for-ENTER; writes crash.log gitignored). It captures FATAL exceptions and JS breadcrumbs but does NOT capture meminfo/heap — it cannot prove or disprove an OOM. No dumpsys meminfo / bugreport tooling exists.

DOCS: No crash/OOM/FGS guidance in docs/architecture.md, docs/backlog.md, docs/phase-2-roadmap.md, docs/refactor-notes.md (the only "memory"/"OOM" hits in docs are backend gzip-bomb limits and force_update-in-memory — unrelated). CLAUDE.md / AGENTS.md contain NO crash guidance either; all crash knowledge lives in code comments (foreground-bootstrap.ts, mesh/index.ts BUG-B block, withNotifeeForegroundService.js).

### Ranked leak suspects

- **[HIGH] Peripheral-side `centrals` Map + per-central uncleared MTU setTimeout in startPeripheralGattAcceptLoop (transport-ble.ts ~1006-1091)**
  - Evidence: centrals Map is keyed on BLE MAC `address`; entries are deleted only on kaataOnCentralDisconnected for that exact MAC (line 1208-1210) or on a same-MAC re-connect replacement (line 1012-1037). Android NRPA rotates the MAC, so a peer that reconnects after randomization arrives as a NEW address — the old entry is never replaced/deleted if STATE_DISCONNECTED was missed (the H3 case the code explicitly acknowledges). Each entry also spawns an uncleared setTimeout (line 1075, 'timer ref intentionally not stored'). BUG-B's one-shot-burst fix is on the CENTRAL/dialer side (state.connections), so it does NOT cover this peripheral-side accumulation. This matches 'few minutes of active use' under MAC churn.
- **[HIGH] Per-connection cleanup on the handshake FAILURE path (not the success path BUG-B fixed)**
  - Evidence: BUG-B's enumerated release (AEAD ctx, frame-assembly Map, inbox arrays, 5s assemblyGcTimer, native subscription closures) happens via conn.close() AFTER runAntiEntropy returns successfully (index.ts 964-991). The catch branch at line 995 does call conn.close(), but with the pre-P1 500ms-MAC-churn the dial/handshake FAILURE rate was very high. If any throw path inside runAntiEntropy or a timeout in BleMeshConnection.recvJSON (transport-ble.ts 467-489) leaves the assemblyGcTimer (set at line 316, cleared only in close/markClosed at 427) or native subscriptions un-torn-down, the leak survives on the failure path BUG-B never addressed.
- **[MEDIUM] BLE advertiser MAC/native-object churn (pre-Mythos-P1 500ms broadcast rotation)**
  - Evidence: Before commit 2ba249b, transport-ble.ts restarted BLEAdvertiser.broadcast() every ~500ms (ADV_ROTATION_MS) to rotate vault hashes; broadcast() mints a fresh BLE MAC and a new native advertiser object on most stacks twice a second. P1 removed the rotation, keeping only a single 20-min OEM-throttle restart. If the user is on a build at or before v0.5.3 (921cf7e) this churn is still present and is a strong native-side allocation-pressure candidate. Need to confirm which APK version the A17/10T are actually running.
- **[LOW] discovery-ble lastEmitByDevice / seenVaultHashSets / emitTimestamps maps under MAC flood**
  - Evidence: lastEmitByDevice (discovery-ble.ts 136) and seenVaultHashSets (130) are pruned on every emit by time-cutoff, and emitTimestamps is filtered to a 1s window — these are bounded by design and prune-pruned, so LOW risk post-P1. Pre-P1 under 500ms MAC churn they could spike between prunes but are self-healing. Listed for completeness; unlikely to be the primary OOM.
- **[MEDIUM] notifee FGS auto-restart-before-JS path (stopWithTask=false)**
  - Evidence: withNotifeeForegroundService.js sets stopWithTask=false so the mesh keeps running after swipe-away; the plugin comment admits an OS-killed FGS that auto-restarts before the JS bundle registers the notifee callback 'can still crash on very low-end devices' (5s startForeground window). This is a crash, not strictly a leak, and presents at restart rather than steadily — but it's an open, self-acknowledged gap flagged as 0.5.4 work (native AndroidService).

### Code

#### BUG-B connections-map leak fix — the canonical OOM comment ('Samsung A17 OOM-crashed after a few minutes')

`c:/Users/Matee/Desktop/Projects/Kaata/kaata/apps/mobile/lib/mesh/index.ts` lines `165-182` — This is THE documented mid-use OOM fix (BUG-B). It claims connections are now 'one-shot burst' closed and that the leak was the connections Map. Mythos must not re-suggest 'the connections map leaks' — it's already been addressed for the happy path. The open question is whether the FAILURE path also closes.

```
  /** Post-handshake connections (key = `${remoteDeviceId}:${vaultId}`).
   *  BUG-B: this used to leak indefinitely — every successful handshake
   *  added an entry that was never removed. Per-conn state (AEAD ctx,
   *  frame-assembly Map, GC interval, native event subscriptions) all
   *  retained. Samsung A17 OOM-crashed after a few minutes.
   *
   *  Fix: treat anti-entropy as a one-shot burst. After runAntiEntropy
   *  returns successfully, we close the connection and remove the
   *  entry. The Map only holds CURRENTLY-RUNNING handshakes (mid-burst);
   *  activePeers status uses the separate liveSessionCount below. */
  connections: Map<string, MeshConnection>;
  /** Pre-handshake in-flight installIdShorts (so we don't dial twice). */
  inflight: Set<string>;
  /** Monotonic count of currently-mid-anti-entropy sessions. Decoupled
   *  from `connections` so that even if a conn linger-bug returns, the
   *  status surface is correct. Bumped on handshake success, decremented
   *  on close. */
  liveSessionCount: number;
```

#### BUG-B one-shot-burst close (happy-path only) — what gets released on close

`c:/Users/Matee/Desktop/Projects/Kaata/kaata/apps/mobile/lib/mesh/index.ts` lines `964-994` — Enumerates EXACTLY what the per-connection leak consisted of (AEAD ctx, frame-assembly Map, inbox arrays, 5s assemblyGcTimer, native subscription closures). The close() that frees all this is only on the success path after runAntiEntropy returns — the catch branch (line 995+) calls conn.close() too, but Mythos should verify timeouts/MTU-fails inside runAntiEntropy reach a close.

```
    // BUG-B: Anti-entropy is a one-shot burst. By this point
    // runAntiEntropy has already exchanged hello/PoP/AEAD/summary/delta
    // and applied everything; the connection has no further useful work
    // to do. Closing the GATT/WebRTC link releases:
    //   - AEAD ctx (~80 bytes nonces + 32-byte key per direction)
    //   - frame-assembly Map and inbox arrays
    //   - the 5s assemblyGcTimer in transport-ble.ts
    //   - native event subscription closures (chunkListener,
    //     disconnectListener)
    // and lets the OS reclaim the BLE link layer slot. The next
    // discovery emit (allowDuplicates: true post-BUG-C) reconnects
    // on demand. State.connections is no longer used as the dedup
    // surface (the pre-handshake inflight set already covers that
    // window).
    state.liveSessionCount++;
    emitStatusChange();
    await touchLastActive();
    console.log(
      "[mesh.peer] connected (one-shot burst complete) device=",
      result.peerDeviceId.slice(0, 8) + "…",
      "live=",
      state.liveSessionCount,
    );
    try {
      await conn.close();
    } catch (closeErr) {
      if (__DEV__) console.warn("[mesh.peer] conn.close threw after burst", closeErr);
    }
    state.liveSessionCount = Math.max(0, state.liveSessionCount - 1);
    emitStatusChange();
    void direction;
```

#### MIUI/Xiaomi FGS HeadlessJS crash mechanism — DO-NOT-call-stopForegroundService block

`c:/Users/Matee/Desktop/Projects/Kaata/kaata/apps/mobile/lib/mesh/foreground-bootstrap.ts` lines `123-144` — Documents the Xiaomi/MIUI FGS crash mechanism and the fix (574a101). This is a STARTUP/teardown crash (immediate 5s timeout), NOT a few-minutes-of-active-use OOM. Mythos should treat this as a SEPARATE, already-fixed crash family and not conflate it with the A17 mid-use crash. Note the comment still references stopWithTask='true' but the plugin was later flipped to 'false' in v0.5.3.

```
    // !!! DO NOT call notifee.stopForegroundService() defensively here. !!!
    //
    // It looks tempting as belt-and-suspenders cleanup of zombie FGS state,
    // but it ACTIVELY CRASHES the app on Xiaomi/MIUI (confirmed via logcat
    // on a 10T running MIUI 14). The mechanism:
    //   1. stopForegroundService() dispatches a notifee HeadlessJS task
    //      via Context.startService(intent) to run the teardown callback.
    //   2. On Android 12+ Xiaomi treats that startService call as if it
    //      were a foreground-service start (presumably because
    //      app.notifee.core.ForegroundService is declared as one in the
    //      manifest, and MIUI's HardenedAccessControl can't distinguish
    //      a headless cleanup invocation from a real FGS start).
    //   3. The headless task has no notification to display, so it never
    //      calls Service.startForeground(notification).
    //   4. After 5s, the OS fires ForegroundServiceDidNotStartInTimeException
    //      and force-kills the process. "Send feedback" dialog appears.
    //
    // The correct teardown path is MeshController calling
    // stopForegroundService() ONLY when it knows the FGS is currently
    // running (i.e. when shop_mode_enabled flips from '1' to '0').
    // Manifest-level android:stopWithTask="true" + that gated teardown
    // covers every realistic zombie scenario without the headless trap.
```

#### stopWithTask flipped false in v0.5.3 — admits FGS path still crashable on low-end devices (0.5.4 work)

`c:/Users/Matee/Desktop/Projects/Kaata/kaata/apps/mobile/plugins/withNotifeeForegroundService.js` lines `37-58` — Explicit admission that the FGS crash is NOT fully fixed — with stopWithTask=false the mesh keeps running after swipe-away and an OS-killed-then-auto-restarted FGS can still crash before JS loads. Also explains why the mesh keeps consuming resources in the background, which is consistent with a few-minutes-later crash. Mythos: do NOT re-suggest stopWithTask=true (already tried in v0.5.2, reverted) and do NOT re-suggest defensive stopForegroundService at boot (that WAS the MIUI crash).

```
// stopWithTask=false (v0.5.3 reversal of the v0.5.2 fix): the user
// expects Briar-like behaviour — when they swipe Kaata out of recents,
// the "Connecting with your paired phones" notification should KEEP
// running, the BLE mesh should keep listening, so a staff phone joining
// the shop later can sync without the shopkeeper re-opening the app.
//
// The original v0.5.2 crash that drove stopWithTask=true was the OS
// auto-restarting an orphaned FGS BEFORE the JS bundle could register
// the notifee callback. That issue is now addressed from a different
// angle: lib/mesh/index.ts:stopShopMode gates the
// notifee.stopForegroundService() call on `wasRunning` ...
//
// Trade-off accepted: an OS-killed FGS that auto-restarts BEFORE JS
// loads (the 5s startForeground timeout window) can still crash on
// very low-end devices. A native AndroidService that doesn't depend
// on a JS callback (drop notifee for the FGS layer) is the real long-
// term fix; flagged as 0.5.4 work.
const STOP_WITH_TASK = "false";
```

#### Peripheral GATT MTU-timeout timer intentionally not cleared + centrals Map keyed on rotating MAC (leak suspect)

`c:/Users/Matee/Desktop/Projects/Kaata/kaata/apps/mobile/lib/mesh/transport-ble.ts` lines `1075-1091` — A leak suspect NOT covered by BUG-B (BUG-B was the central-side connections Map). On the PERIPHERAL side, every incoming central spawns an uncleared setTimeout and a PeripheralCentralState in the `centrals` Map. The map is keyed on `address` (BLE MAC), which rotates via NRPA — so stale entries from a disconnected central with an old MAC are only deleted if STATE_DISCONNECTED fires for that exact MAC. The code itself flags the missed-disconnect (H3) case. Under churn this can grow unboundedly — a candidate for the A17/10T mid-use crash that the BUG-B central-side fix would not have touched.

```
      const t = setTimeout(() => {
        if (!cs.mtuReadyDone) {
          cs.mtuReadyDone = true;
          cs.rejectMtuReady(
            new Error(`MTU upgrade timed out at ${PERIPHERAL_MTU_WAIT_MS}ms (still at default 23)`),
          );
          // Force-disconnect so the central also unwinds cleanly. ...
          void kaataDisconnectCentral(address).catch(() => {});
        }
      }, PERIPHERAL_MTU_WAIT_MS);
      // Note: timer ref intentionally not stored — clearTimeout would race
      // with the same code path that flips mtuReadyDone. The mtuReadyDone
      // guard inside the timer callback is the source of truth.
      void t;
```

### Open questions

- Which APK VERSION are the Samsung A17 and Xiaomi 10T actually running? The fixes land across v0.5.2 (FGS), v0.5.3/921cf7e (BUG-B conn leak), and Mythos P1/2ba249b (500ms ad churn). If the crashing devices are on <=v0.5.2 they never got BUG-B; if <=v0.5.3 they never got the 500ms-rotation removal. 'Prior fixes didn't work' may mean the user never installed them.
- Is the crash actually an OOM, or an FGS ForegroundServiceDidNotStartInTimeException? These present completely differently: OOM = lowmemorykiller / 'Clear cache' after minutes of growth; FGS = immediate ANR-style kill at start/restart. The A17 'Clear cache' prompt + 'after a few minutes' strongly suggests OOM/lowmemkill, NOT the FGS path the recent commits fixed. capture-crash.sh's AndroidRuntime:E filter would show the FGS exception but would NOT show a native lowmemorykiller OOM (that's in /proc/lowmemorykiller or `dmesg`, not logcat app tags).
- DIAGNOSTIC PROTOCOL to disambiguate (no meminfo tooling exists yet): (a) `adb shell dumpsys meminfo af.kaata.app` sampled every 30-60s during active use — watch TOTAL PSS, 'Native Heap', and 'Views'/'AppContexts'/'Activities' object counts climb. A steadily rising Native Heap points at BLE/notifee native; rising Dalvik/Java points at Hermes/JS retained closures (the connections/centrals Maps). (b) `adb shell dumpsys activity meminfo --local` for the running process. (c) `adb bugreport` after a repro for the lowmemorykiller verdict and the exact RSS at kill. (d) On Hermes, capture a heap snapshot via the React DevTools / `global.gc()` + sampling to see which JS objects retain — would confirm/deny whether centrals or any Map is the retainer.
- Does the crash reproduce with Shop Mode / Nearby sync OFF? If it only crashes with mesh active, that isolates it to the BLE/mesh layer (all the suspects above). If it crashes with mesh off, the leak is elsewhere entirely (e.g. the home swipe-rail Animated values, db, or notifee) and NONE of the shipped mesh fixes were ever relevant.
- On the peripheral side, is kaataOnCentralDisconnected reliably delivered on these OEMs? The centrals-Map leak suspect hinges on missed STATE_DISCONNECTED events under MAC randomization. dumpsys for the native GATT server (KaataGattServer logs via capture-crash.sh) + counting [ble-gatt] central connected vs disconnected log lines over a session would prove whether the map drains.

_Files consulted: c:/Users/Matee/Desktop/Projects/Kaata/kaata/apps/mobile/lib/mesh/index.ts, c:/Users/Matee/Desktop/Projects/Kaata/kaata/apps/mobile/lib/mesh/foreground-bootstrap.ts, c:/Users/Matee/Desktop/Projects/Kaata/kaata/apps/mobile/lib/mesh/transport-ble.ts, c:/Users/Matee/Desktop/Projects/Kaata/kaata/apps/mobile/lib/mesh/discovery-ble.ts, c:/Users/Matee/Desktop/Projects/Kaata/kaata/apps/mobile/plugins/withNotifeeForegroundService.js, c:/Users/Matee/Desktop/Projects/Kaata/kaata/apps/mobile/plugins/withGradleJvmArgs.js, c:/Users/Matee/Desktop/Projects/Kaata/kaata/apps/mobile/plugins/withBleAdvertiser.js, c:/Users/Matee/Desktop/Projects/Kaata/kaata/scripts/capture-crash.sh, c:/Users/Matee/Desktop/Projects/Kaata/kaata/apps/mobile/app.json, c:/Users/Matee/Desktop/Projects/Kaata/kaata/CLAUDE.md, c:/Users/Matee/Desktop/Projects/Kaata/kaata/AGENTS.md_

---

## Area 5 — Build + runtime config (Hermes, newArch, heap, native modules)

_Config-level OOM factors: largeHeap, Hermes heap, the native-module roster._

### Summary

The Kaata mobile app is a React Native 0.81.5 / Expo SDK 54 app running on the legacy bridge (newArchEnabled=false) with explicit Gradle JVM heap tuning but NO android:largeHeap manifest setting and NO jsEngine/Hermes configuration. The app is a BLE-heavy mesh-sync ledger with multiple off-heap buffer consumers (BLE advertiser, BLE GATT server, WebRTC, TCP sockets, camera, notifications). Native heap OOM could stem from: (1) missing android:largeHeap="true" for BLE peripheral/scanner buffers, (2) Gradle build-time OOM mitigations (8GB heap set, Metaspace 2GB) suggesting tight resource margins, (3) large native modules (react-native-ble-plx, react-native-webrtc, react-native-tcp-socket, @notifee) holding buffers independently of JS heap, or (4) runtime JS heap exceeding Hermes/default allocations (though Hermes is not explicitly enabled). The KaataGattServerModule (Kotlin) holds state in ConcurrentHashMaps per connected device with per-address mutexes and notification queues—no heap pressure mitigations there. No metro/babel heap config found.

### Ranked leak suspects

- **[HIGH] Missing android:largeHeap manifest setting**
  - Evidence: app.json android block has no largeHeap="true" attribute. The BLE peripheral/scanner (react-native-ble-plx, react-native-ble-advertiser) and WebRTC native modules allocate large buffers off-heap. On low-RAM devices (< 512MB app heap), native allocations can push the process over the OS limit without largeHeap=true to request 512MB->1GB heap bump.
- **[MEDIUM] Hermes JS engine NOT enabled; default V8/JavaScriptCore heap**
  - Evidence: app.json has no jsEngine field (defaults to JavaScriptCore on iOS, V8 on Android). RN 0.81.5 without Hermes defaults to ~256MB JS heap on low-end devices; large Redux state or event queues in a mesh-sync ledger can exhaust this independently of native heap. No Hermes config to enable shrinking GC or bytecode caching.
- **[MEDIUM] BUILD-TIME Gradle OOM mitigations indicate tight resource margins**
  - Evidence: withGradleJvmArgs.js sets -Xmx8192m/-XX:MaxMetaspaceSize=2048m because default 4096m/512m caused three parallel OutOfMemoryError failures during expo-updates KSP + expo-dev-menu lintVitalAnalyze. This signals that the build system itself is under stress, suggesting developer machines have marginal RAM. Such machines are likely to run the app with even tighter native/JS heap budgets.
- **[MEDIUM] ConcurrentHashMap per-device state in KaataGattServerModule**
  - Evidence: Lines 120-132: 5 ConcurrentHashMaps per connected peer (connectedDevices, mtuByAddress, notifyMutexByAddress, pendingNotifyByAddress, firstValidWriteAtByAddress). Each entry holds BluetoothDevice + Mutex + Lambda/Function. With MAX_CONCURRENT_CENTRALS=8, up to 8 entries × ~2KB each = ~16KB of native Kotlin/Java objects. No explicit heap-pressure mitigation if entries accumulate rapidly or stale entries survive the 30s idle timeout.
- **[HIGH] Large native module buffering: react-native-webrtc, react-native-tcp-socket**
  - Evidence: package.json lists react-native-webrtc@^124.0.5 (large media buffers for peer-to-peer comms) and react-native-tcp-socket@^6.3.0 for Phase 5.1 mDNS fallback. These hold off-heap buffers (video frames, socket recv bufs) that don't show up in JS heap profilers. No runtime buffer-pool sizing or backpressure configuration visible in app.json or plugins.
- **[MEDIUM] Foreground Service via @notifee keeps process in memory indefinitely**
  - Evidence: plugins/withNotifeeForegroundService.js registers app.notifee.core.ForegroundService with android:stopWithTask="false" (line 58, reversed v0.5.2 change). The persistent "Kaata — Nearby sync active" notification keeps the process alive during mesh sync, holding all BLE/WebRTC/TCP buffers in memory. On devices with < 2GB RAM, this can exhaust native heap while app is backgrounded.

### Code

#### app.json: expo config with newArchEnabled=false, no jsEngine or largeHeap

`c:/Users/Matee/Desktop/Projects/Kaata/kaata/apps/mobile/app.json` lines `1-106` — Shows that newArchEnabled is explicitly FALSE (legacy bridge), no jsEngine/Hermes config, no android:largeHeap setting, and lists all plugins including custom Gradle/BLE patchers. The android.permissions array shows this is a heavy BLE+comms app.

```
{
  "expo": {
    "name": "Kaata",
    "slug": "kaata",
    "scheme": "kaata",
    "version": "0.5.2",
    "newArchEnabled": false,
    "orientation": "portrait",
    "icon": "./assets/icon.png",
    "userInterfaceStyle": "light",
    "splash": {
      "image": "./assets/splash-icon.png",
      "resizeMode": "contain",
      "backgroundColor": "#000000"
    },
    "ios": {
      "supportsTablet": true,
      "bundleIdentifier": "af.kaata.app",
      "infoPlist": {
        "NSBluetoothAlwaysUsageDescription": "Kaata uses Bluetooth to sync your ledger with nearby phones in your shop."
      }
    },
    "android": {
      "package": "af.kaata.app",
      "adaptiveIcon": {
        "backgroundColor": "#000000",
        "foregroundImage": "./assets/android-icon-foreground.png"
      },
      "predictiveBackGestureEnabled": false,
      "usesCleartextTraffic": true,
      "permissions": [
        "android.permission.INTERNET",
        "android.permission.ACCESS_NETWORK_STATE",
        "android.permission.ACCESS_WIFI_STATE",
        "android.permission.CHANGE_WIFI_MULTICAST_STATE",
        "android.permission.NEARBY_WIFI_DEVICES",
        "android.permission.BLUETOOTH_SCAN",
        "android.permission.BLUETOOTH_CONNECT",
        "android.permission.BLUETOOTH_ADVERTISE",
        "android.permission.FOREGROUND_SERVICE",
        "android.permission.FOREGROUND_SERVICE_DATA_SYNC",
        "android.permission.FOREGROUND_SERVICE_CONNECTED_DEVICE",
        "android.permission.POST_NOTIFICATIONS",
        "android.permission.WAKE_LOCK",
        "android.permission.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS",
        "android.permission.CAMERA",
        "android.permission.RECORD_AUDIO",
        "android.permission.MODIFY_AUDIO_SETTINGS"
      ]
    },
    "web": {
      "favicon": "./assets/favicon.png"
    },
    "plugins": [
      "expo-router",
      "expo-font",
      "expo-localization",
      ["expo-contacts", {...}],
      ["@react-native-google-signin/google-signin", {...}],
      "expo-secure-store",
      ["expo-camera", {...}],
      "expo-task-manager",
      ["expo-notifications", {...}],
      ["@config-plugins/react-native-webrtc", {...}],
      "./plugins/withNearbyWifiNeverForLocation",
      "./plugins/withNotifeeForegroundService",
      "./plugins/withBleAdvertiser",
      "./plugins/withGradleJvmArgs"
    ],
    "extra": {
      "router": {},
      "eas": {
        "projectId": "a612156b-0f0b-47ea-ac66-b54d880d98aa"
      }
    },
    "owner": "mateesaafi"
  }
}
```

#### package.json: RN 0.81.5, Expo SDK 54, major off-heap modules

`c:/Users/Matee/Desktop/Projects/Kaata/kaata/apps/mobile/package.json` lines `15-62` — RN 0.81.5 with Expo SDK 54. Lists native modules that hold large off-heap buffers: react-native-ble-plx (BLE scanner), react-native-ble-advertiser (BLE advertiser, archived upstream), react-native-webrtc (124.0.5, often large media buffers), react-native-tcp-socket, expo-camera, @notifee (foreground service notifications, keeps process alive). These are independent OOM contributors.

```
"dependencies": {
    "@config-plugins/react-native-webrtc": "^13.0.0",
    "@expo-google-fonts/inter": "^0.4.2",
    "@expo-google-fonts/jetbrains-mono": "^0.4.1",
    "@expo-google-fonts/vazirmatn": "^0.4.1",
    "@noble/ciphers": "^1.0.0",
    "@noble/curves": "^1.6.0",
    "@noble/ed25519": "^2.1.0",
    "@noble/hashes": "^1.5.0",
    "@notifee/react-native": "^9.1.8",
    "@react-native-google-signin/google-signin": "^16.1.2",
    "expo": "~54.0.0",
    "expo-application": "~7.0.0",
    "expo-blur": "~15.0.8",
    "expo-camera": "~17.0.8",
    "expo-constants": "~18.0.0",
    "expo-contacts": "~15.0.11",
    "expo-crypto": "~15.0.0",
    "expo-dev-client": "~6.0.21",
    "expo-font": "~14.0.11",
    "expo-haptics": "~15.0.8",
    "expo-linking": "~8.0.0",
    "expo-localization": "~17.0.9",
    "expo-network": "~8.0.0",
    "expo-notifications": "~0.32.12",
    "expo-router": "~6.0.0",
    "expo-secure-store": "~15.0.8",
    "expo-sqlite": "~16.0.0",
    "expo-status-bar": "~3.0.9",
    "expo-task-manager": "~14.0.7",
    "expo-updates": "~29.0.18",
    "kaata-gatt-server": "file:./modules/kaata-gatt-server",
    "react": "19.1.0",
    "react-dom": "19.1.0",
    "react-native": "0.81.5",
    "react-native-ble-advertiser": "^0.0.17",
    "react-native-ble-plx": "^3.5.1",
    "react-native-gesture-handler": "~2.28.0",
    "react-native-qrcode-svg": "^6.3.15",
    "react-native-restart": "^0.0.28",
    "react-native-safe-area-context": "~5.6.0",
    "react-native-screens": "~4.16.0",
    "react-native-svg": "15.12.1",
    "react-native-tcp-socket": "^6.3.0",
    "react-native-web": "~0.21.0",
    "react-native-webrtc": "^124.0.5",
    "react-native-zeroconf": "^0.13.8"
  }
```

#### withGradleJvmArgs.js: BUILD-TIME Gradle heap tuning to 8GB + 2GB Metaspace

`c:/Users/Matee/Desktop/Projects/Kaata/kaata/apps/mobile/plugins/withGradleJvmArgs.js` lines `1-47` — Sets Gradle JVM args to -Xmx8192m (8GB heap) and -XX:MaxMetaspaceSize=2048m (2GB Metaspace) at PREBUILD time. The default Expo template (4096m/512m) caused OOMs during KSP + lintVitalAnalyze. Indicates tight resource margins and complex build-time dependencies. CRITICAL: this is BUILD-TIME only, NOT RUNTIME heap allocation.

```
// apps/mobile/plugins/withGradleJvmArgs.js
//
// Bumps Gradle's JVM heap + Metaspace at prebuild time.
//
// The Expo SDK 54 template ships android/gradle.properties with
//   org.gradle.jvmargs=-Xmx4096m -XX:MaxMetaspaceSize=512m
// which is too tight for our build: KSP (expo-updates) and lintVitalAnalyze
// (expo-dev-menu, expo-modules-core) blow the metaspace and the build dies
// with three parallel OutOfMemoryError: Metaspace failures.
//
// android/ is regenerated every prebuild so manually editing the file is
// futile; this plugin rewrites the org.gradle.jvmargs line each time.
//
// Tune these if you're on a low-RAM machine — 8 GB heap assumes the dev
// machine has 16 GB+ system RAM. Lowest values that have built clean:
//   -Xmx6144m -XX:MaxMetaspaceSize=1024m

const fs = require("fs");
const path = require("path");
const { withDangerousMod } = require("@expo/config-plugins");

const JVM_ARGS = "-Xmx8192m -XX:MaxMetaspaceSize=2048m -Dfile.encoding=UTF-8";

module.exports = function withGradleJvmArgs(config) {
  return withDangerousMod(config, [
    "android",
    async (cfg) => {
      const propsPath = path.join(cfg.modRequest.projectRoot, "android", "gradle.properties");
      try {
        let props = fs.existsSync(propsPath) ? fs.readFileSync(propsPath, "utf8") : "";
        if (/^\s*org\.gradle\.jvmargs\s*=/m.test(props)) {
          props = props.replace(
            /^\s*org\.gradle\.jvmargs\s*=.*$/m,
            `org.gradle.jvmargs=${JVM_ARGS}`,
          );
        } else {
          props = `${props.replace(/\s*$/, "")}\norg.gradle.jvmargs=${JVM_ARGS}\n`;
        }
        fs.writeFileSync(propsPath, props, "utf8");
      } catch (err) {
        console.warn("[withGradleJvmArgs] failed to patch gradle.properties:", err?.message);
      }
      return cfg;
    },
  ]);
};
```

#### KaataGattServerModule.kt: GATT server state management with per-device maps

`c:/Users/Matee/Desktop/Projects/Kaata/kaata/apps/mobile/modules/kaata-gatt-server/android/src/main/java/expo/modules/kaatagattserver/KaataGattServerModule.kt` lines `94-133` — Shows 5 ConcurrentHashMaps per-device-address (connectedDevices, mtuByAddress, notifyMutexByAddress, pendingNotifyByAddress, firstValidWriteAtByAddress). Each connected BLE peer adds mutex+resolver objects. With MAX_CONCURRENT_CENTRALS=8 (line 62), unbounded growth isn't possible, but each entry (device object, mutex, closure) holds native memory. No explicit cleanup of Mutex/Lambda GC pressure mitigation.

```
class KaataGattServerModule : Module() {

  private var scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

  // State guarded by stateMutex. Volatile so the callback path on the
  // Binder thread sees the latest writes without entering the suspend
  // mutex (pickCharacteristic / onCharacteristicWriteRequest etc.).
  private val stateMutex = Mutex()
  @Volatile private var gattServer: BluetoothGattServer? = null
  @Volatile private var service: BluetoothGattService? = null
  @Volatile private var handshakeChar: BluetoothGattCharacteristic? = null
  @Volatile private var streamChar: BluetoothGattCharacteristic? = null

  // Resolver for onServiceAdded. Set by openInternal before calling
  // addService, completed by the GATT callback. null when not waiting.
  @Volatile private var serviceAddedResolver: ((Boolean) -> Unit)? = null

  // Engineering critique #2 — class-level mutex serializing
  // characteristic.value mutation on the pre-33 notify path. Without this,
  // concurrent notifies to two different addresses race on the shared
  // BluetoothGattCharacteristic instance and one writes can be smashed by
  // the other before notifyCharacteristicChanged reads it.
  private val pre33NotifyMutex = Mutex()

  // Per-connection state (concurrent so callback path doesn't need the
  // top-level mutex on the binder thread).
  private val connectedDevices = ConcurrentHashMap<String, BluetoothDevice>()
  private val mtuByAddress = ConcurrentHashMap<String, Int>()
  // One mutex per device serializes notification dispatch.
  private val notifyMutexByAddress = ConcurrentHashMap<String, Mutex>()
  // Pending notify resolver, set BEFORE notifyCharacteristicChanged fires.
  // Passes the Int status code from onNotificationSent (GATT_SUCCESS=0,
  // GATT_BUSY=0x84, etc.) so the caller can branch on retry-able codes.
  // Sentinel values for synchronous failures: -1 (pre-33 boolean false),
  // -2 (close drained pending).
  private val pendingNotifyByAddress = ConcurrentHashMap<String, (Int) -> Unit>()
  // Idle-connect reaper: tracks first-valid-write per address so a central
  // that never authenticates is force-disconnected after IDLE timeout.
  private val firstValidWriteAtByAddress = ConcurrentHashMap<String, Long>()
```

#### KaataGattServerModule.kt: Idle-connect reaper and MAX_CONCURRENT_CENTRALS cap

`c:/Users/Matee/Desktop/Projects/Kaata/kaata/apps/mobile/modules/kaata-gatt-server/android/src/main/java/expo/modules/kaatagattserver/KaataGattServerModule.kt` lines `55-62` — Defensive bounds: max 8 simultaneous GATT connections + 30s idle timeout. Prevents unbounded ConcurrentHashMap growth, but each device entry is a BluetoothDevice + Mutex + callback objects—still native memory pressure under sustained mesh activity. No heap-size config to compensate.

```
// Mobile-Native critique H2 — idle-connect reaper. A central that completes
// link-layer connect but never writes is force-disconnected after this many
// ms. Bounds the connectedDevices map against probe-connects from non-Kaata
// devices and battery-pull stale entries.
private const val IDLE_CONNECT_TIMEOUT_MS = 30_000L

// Cap on simultaneous central connections. Above this, new connects are
// force-cancelled. Defensive — prevents map / mutex growth under attack.
private const val MAX_CONCURRENT_CENTRALS = 8
```

### Open questions

- Does the OOM crash occur during RUNTIME (app in foreground, mesh-syncing with multiple peers) or BUILDTIME (EAS build failing)? If runtime, what is the device RAM (e.g., < 1GB, 1-2GB, 2-3GB) and how many peers are connected when it crashes?
- Has android:largeHeap="true" been tested in AndroidManifest? This is the quickest lever to boost native heap from ~384MB to ~512-1024MB and may alone prevent OOM if the bottleneck is BLE/WebRTC buffers.
- Is Hermes JS engine available in Expo SDK 54? If so, enabling it (jsEngine: "hermes" in app.json) would reduce JS heap pressure and enable bytecode caching for faster cold starts. What is the current JS heap usage under load (via Android Profiler or logcat GC logs)?
- What is the actual native heap usage breakdown? A heap dump would show: (1) BluetoothDevice / GattServer objects from KaataGattServerModule, (2) WebRTC buffers, (3) TCP socket recv bufs, (4) Kotlin coroutine overhead (Mutex, CompletableDeferred per notification). Is one category dominating?
- Does the idle-connect reaper (30s timeout) reliably fire, or do stale device entries accumulate in the 5 ConcurrentHashMaps? If reaper is failing, entries could grow unbounded on a device with flaky Bluetooth (repeated connects/disconnects).
- Is the OOM specific to certain device models or Android versions (e.g., Android 11 with older Bluetooth stack, or low-end Chinese phones with < 1GB heap)? If so, a targeted fix (largeHeap + Hermes) would focus on that segment.
- What is the app's target minSdkVersion and targetSdkVersion? The Gradle jvmargs plugin bumps react-native-ble-advertiser to compileSdkVersion 36; does the app match that, or is there a mismatch that causes deprecated/slow code paths?

_Files consulted: c:/Users/Matee/Desktop/Projects/Kaata/kaata/apps/mobile/app.json, c:/Users/Matee/Desktop/Projects/Kaata/kaata/apps/mobile/package.json, c:/Users/Matee/Desktop/Projects/Kaata/kaata/apps/mobile/eas.json, c:/Users/Matee/Desktop/Projects/Kaata/kaata/apps/mobile/plugins/withGradleJvmArgs.js, c:/Users/Matee/Desktop/Projects/Kaata/kaata/apps/mobile/plugins/withBleAdvertiser.js, c:/Users/Matee/Desktop/Projects/Kaata/kaata/apps/mobile/plugins/withNotifeeForegroundService.js, c:/Users/Matee/Desktop/Projects/Kaata/kaata/apps/mobile/plugins/withNearbyWifiNeverForLocation.js, c:/Users/Matee/Desktop/Projects/Kaata/kaata/apps/mobile/modules/kaata-gatt-server/android/build.gradle, c:/Users/Matee/Desktop/Projects/Kaata/kaata/apps/mobile/modules/kaata-gatt-server/android/src/main/AndroidManifest.xml, c:/Users/Matee/Desktop/Projects/Kaata/kaata/apps/mobile/modules/kaata-gatt-server/android/src/main/java/expo/modules/kaatagattserver/KaataGattServerModule.kt_

---

## What I need from you

1. **The diagnosis.** Given the code evidence (no meminfo slope yet), what is the single highest-probability root cause of the mid-use crash? If it's the ble-plx Device cache, explain the exact mechanism and why P1 didn't fix it. If you think the "Clear cache" prompt is storage (WAL) not RAM, say so and explain.

2. **The fix, as literal code.** Copy-pasteable snippets with file paths. If the fix is "evict the ble-plx Device on teardown," show the exact call (`manager.cancelDeviceConnection` / a periodic `manager.destroy()`+recreate / dropping allowDuplicates with a different retry strategy / etc.). If it's a Kotlin change to the GATT server, show the .kt edit. If it's largeHeap or a Hermes config, show the app.json / plugin change.

3. **The one confirming measurement.** Name the single `adb shell dumpsys` or `/proc` value (or the in-app metric) that would confirm your diagnosis, so the backend crash-reporter we're about to build captures exactly that and we stop guessing. (Candidates the agents raised: `dumpsys meminfo` Native vs Java slope, `dumpsys bluetooth_manager` GATT client count, WAL file size on /data/data.)

4. **A ranked fix order** if there are several contributing leaks — what to ship first, what to measure, what to defer.

The user's tolerance for rounds is low and he can't easily run adb. Favor a fix that's correct-by-construction from the code evidence, plus the ONE measurement that the backend reporter can grab automatically. Be exhaustive in this single response.

If you need a specific file I didn't include (e.g. the full KaataGattServerModule.kt, or transport-ble.ts dialBLEPeer in full), name it and I'll grab it in the next round.
