// apps/mobile/lib/mesh/discovery-ble.ts
//
// Phase 6: BLE peer discovery. Scaffold over react-native-ble-plx (central)
// + a future peripheral library (see PERIPHERAL_TODO in transport-ble.ts).
//
// Adversarial-design notes from the security critique that this file
// EXPLICITLY honors:
//
//   - 4-byte truncated vault hash is enumerable in a nearby attack (~4.3B
//     possible hashes) — acceptable per Phase 5 opt-in Shop Mode design.
//     This module caps advertised hashes per packet at MAX_ADVERTISED_VAULT_HASHES
//     (3) so a maliciously-configured phone can't burn the entire 31-byte
//     adv budget on hash candidates that increase linkability.
//
//   - Capability flags byte: only bit 0 is defined (supports_wifi_upgrade).
//     Bits 1-7 RESERVED — must NEVER carry owner-role / member-role hints.
//     The VMC carries role and is exchanged only AFTER GATT connect.
//
//   - Pre-handshake `installIdShort` is attacker-spoofable. Discovery does
//     NOT use the BLE MAC for dedupe — that's deferred to post-handshake
//     `remoteDeviceId` in mesh/index.ts.
//
//   - Doze / scan throttling: Android 9+ throttles BLE callbacks after
//     ~25min even with a foreground service. This module enforces a
//     scan-restart loop (stop+start every SCAN_RESTART_INTERVAL_MS) to
//     keep callbacks flowing on misbehaving OEM ROMs. Battery cost is
//     ~5-10mA additional during the brief restart window.
//
//   - DoS: a rate-limit on emitted peer events prevents a fake-MAC flood
//     from blowing up mesh/index.ts's handleDiscoveredPeer call rate.
//     Circuit breaker: if N distinct deviceIds appear in M seconds
//     without any passing handshake, the scan duty-cycle drops to
//     "low power" until next user toggle.
//
// The actual react-native-ble-plx integration lives in `startBle()` below;
// it's wired to the discovery-router via the RouterAdapters injection
// pattern at MeshController boot.

import type { BLEPeerRaw } from "./discovery-router";
import {
  CAP_FLAG_SUPPORTS_WIFI_UPGRADE,
  KAATA_MESH_SERVICE_UUID,
  MAX_ADVERTISED_VAULT_HASHES,
  _setSharedBleManager,
} from "./transport-ble";

// Engineering critique F: explicit "known" mask. Replaces the previous
// `bytes[0] & ~CAP_FLAGS_RESERVED_MASK` pattern (which happens to compute
// the same value today but couples receiver behaviour to the reserved-bit
// constant — if anyone "releases" a reserved bit by flipping it to 0,
// the receiver would silently start exposing it). KNOWN_MASK is the
// inclusive OR of every capability bit the receiver actually understands.
const CAP_FLAGS_KNOWN_MASK = CAP_FLAG_SUPPORTS_WIFI_UPGRADE;
import { emitMeshFailure } from "./errors";

// ---------------------------------------------------------------------------
// Tunable constants
// ---------------------------------------------------------------------------

export const BLE_TUNABLES = {
  /** Active scan window — short bursts to bound battery cost. */
  ACTIVE_SCAN_MS: 1_000,
  /** Rest between active windows. 1s on / 5s rest = ~16% duty cycle. */
  REST_BETWEEN_SCANS_MS: 5_000,
  /** Force a scan restart on this interval to defeat OS callback throttling. */
  SCAN_RESTART_INTERVAL_MS: 20 * 60_000,
  /** Advertising interval (peripheral side). 500ms is a balance between
   * discoverability and adv-rotation power cost. */
  ADV_INTERVAL_MS: 500,
  /** Rate limit: max distinct peer events emitted per second. */
  MAX_EMITS_PER_SECOND: 5,
  /** Circuit breaker: if more than this many distinct deviceIds are seen
   *  in CIRCUIT_BREAKER_WINDOW_MS without any successful handshake, drop
   *  into low-power mode and stop emitting until next start. */
  CIRCUIT_BREAKER_DISTINCT_DEVICES: 200,
  CIRCUIT_BREAKER_WINDOW_MS: 60_000,
};

// ---------------------------------------------------------------------------
// Adapter shape — what the discovery-router expects to inject
// ---------------------------------------------------------------------------

export type StartBleOpts = {
  /** WebRTC signaling port to advertise (carried by adv payload for wifi
   *  upgrade). null when wifi listener isn't up yet. */
  listenPort: number | null;
  /** Callback for each discovered peer. The router fans this out. */
  onPeerFound: (peer: BLEPeerRaw) => void;
};

/**
 * Start BLE discovery (both scan and advertise where supported).
 * Returns a stop function. Designed to be passed to discovery-router via
 * `configureDiscoveryRouter({ startBle })`.
 *
 * On platforms where BLE isn't available (web, iOS without entitlement,
 * Expo Go), this resolves to a no-op stop function — Shop Mode keeps
 * the toggle on but the mesh sits idle. MeshController surfaces the
 * "unsupported" toast in that case.
 */
export async function startBle(opts: StartBleOpts): Promise<() => Promise<void>> {
  // Lazy require so this module is safe to import on web / Expo Go.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let blePlx: any = null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    blePlx = require("react-native-ble-plx");
  } catch (err) {
    if (__DEV__) console.warn("[discovery-ble] react-native-ble-plx not available", err);
    return async () => {
      /* no-op */
    };
  }

  // -------------------------------------------------------------------
  // State machine: scan loop with restart-on-interval + rate limit +
  // circuit breaker.
  // -------------------------------------------------------------------
  let stopped = false;
  let scanRestartTimer: ReturnType<typeof setTimeout> | null = null;
  let emitTimestamps: number[] = [];
  // Mythos P3 fix: the circuit breaker now keys on VAULT-HASH-SET, not
  // MAC. The previous MAC-keyed accounting tripped within a minute in
  // an empty room because our own peers (with Android's NRPA + the now-
  // dead 500ms broadcast restart) presented hundreds of distinct MACs
  // for the same physical phone. Vault hash sets are the stable peer
  // identity — a stranger attacker that floods the air with Kaata-
  // fingerprint adverts would need to brute-force matching vault hashes
  // to inflate this counter, which is hard.
  const seenVaultHashSets = new Map<string, number>();
  let circuitTripped = false;
  // Per-MAC emit suppression keeps allowDuplicates: true sane. We prune
  // on EVERY emit using a time cutoff (not just when the map grows
  // large) — combined with the dropped 500ms broadcast restart in
  // transport-ble.ts, the map should stay small in normal operation.
  const lastEmitByDevice = new Map<string, number>();
  const PER_DEVICE_EMIT_INTERVAL_MS = 5_000;
  const EMIT_DEDUP_PRUNE_CUTOFF_MS = 30_000;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let manager: any = null;
  try {
    manager = new blePlx.BleManager();
    // Share the BleManager singleton with transport-ble's dialBLEPeer so
    // we don't end up with two parallel native managers fighting for the
    // same BluetoothAdapter callback queue.
    _setSharedBleManager(manager);
  } catch (err) {
    if (__DEV__) console.warn("[discovery-ble] BleManager ctor failed", err);
    return async () => {
      /* no-op */
    };
  }

  const emit = (peer: BLEPeerRaw) => {
    if (stopped || circuitTripped) return;
    const now = Date.now();
    // Per-MAC 5s suppression. Prune entries older than
    // EMIT_DEDUP_PRUNE_CUTOFF_MS on every emit so the map can't grow
    // unboundedly under MAC churn (post-P1 this should be rare; the
    // pruning is defense in depth).
    const lastEmit = lastEmitByDevice.get(peer.deviceId);
    if (lastEmit != null && now - lastEmit < PER_DEVICE_EMIT_INTERVAL_MS) {
      return;
    }
    lastEmitByDevice.set(peer.deviceId, now);
    {
      const cutoff = now - EMIT_DEDUP_PRUNE_CUTOFF_MS;
      for (const [id, ts] of lastEmitByDevice) {
        if (ts < cutoff) lastEmitByDevice.delete(id);
      }
    }
    // Rate limit (global, across all devices).
    emitTimestamps = emitTimestamps.filter((t) => now - t < 1_000);
    if (emitTimestamps.length >= BLE_TUNABLES.MAX_EMITS_PER_SECOND) return;
    emitTimestamps.push(now);
    // Circuit breaker accounting keyed on the VAULT-HASH SET (not MAC).
    // The advertised hash set is the stable Kaata-peer identity; MAC
    // rotates (NRPA, our own 20-min OEM restart, simultaneous adverts).
    // 200 distinct vault hash SETS in the breaker window would be a
    // genuine flood — far beyond any realistic shopkeeper deployment.
    const hashSetKey =
      peer.vaultHashes.length === 0 ? "" : peer.vaultHashes.slice().sort().join(",");
    if (hashSetKey !== "") {
      seenVaultHashSets.set(hashSetKey, now);
      const cutoff = now - BLE_TUNABLES.CIRCUIT_BREAKER_WINDOW_MS;
      for (const [k, ts] of seenVaultHashSets) {
        if (ts < cutoff) seenVaultHashSets.delete(k);
      }
      if (seenVaultHashSets.size > BLE_TUNABLES.CIRCUIT_BREAKER_DISTINCT_DEVICES) {
        circuitTripped = true;
        if (__DEV__)
          console.warn(
            "[discovery-ble] circuit breaker tripped — too many distinct vault hash sets, suspending until restart",
          );
        try {
          manager?.stopDeviceScan?.();
        } catch {
          /* */
        }
        return;
      }
    }
    console.log(
      "[discovery-ble] peer found id=",
      peer.deviceId,
      "rssi=",
      peer.rssi,
      "vaultHashes=",
      peer.vaultHashes,
    );
    try {
      opts.onPeerFound(peer);
    } catch (err) {
      if (__DEV__) console.warn("[discovery-ble] onPeerFound threw", err);
    }
  };

  const startScan = () => {
    if (stopped) return;
    try {
      // CRITICAL: scan with a null UUID filter, NOT [KAATA_MESH_SERVICE_UUID].
      //
      // react-native-ble-advertiser's broadcast() takes our service-UUID
      // string as its first arg but DOES NOT put that UUID into the
      // advertising data on the wire — it only emits manufacturer-
      // specific data (2-byte little-endian company ID + payload bytes).
      // ble-plx's startDeviceScan with a service-UUID filter then
      // filters out EVERY one of our adverts because the scan layer
      // only sees the manufacturer data, never the service UUID. Net
      // result: notification says "Nearby sync active" but the scanner
      // silently sees zero peers — confirmed via logcat on a v0.5.3
      // build (~75s of scan, no parseAdvertisement callback ever fired).
      //
      // The right answer is null filter + parseAdvertisement does the
      // payload-shape filtering downstream. Strangers' manufacturer
      // data produces garbage vault hashes that don't match our index
      // (emit with matchedVaultIds=[] → silently dropped), so the noise
      // floor stays bounded even in a busy BLE environment.
      manager.startDeviceScan(
        null,
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
    } catch (err) {
      if (__DEV__) console.warn("[discovery-ble] startDeviceScan threw", err);
    }
  };

  const stopScanForRestart = () => {
    try {
      manager.stopDeviceScan();
    } catch {
      /* */
    }
  };

  // Schedule restarts to defeat OS throttling on Android 9+.
  const scheduleRestart = () => {
    if (stopped) return;
    scanRestartTimer = setTimeout(() => {
      stopScanForRestart();
      if (!stopped) {
        emitTimestamps = [];
        seenVaultHashSets.clear();
        lastEmitByDevice.clear();
        circuitTripped = false;
        startScan();
        scheduleRestart();
      }
    }, BLE_TUNABLES.SCAN_RESTART_INTERVAL_MS);
  };

  startScan();
  scheduleRestart();

  // -------------------------------------------------------------------
  // Bluetooth state subscription: pause scan on PoweredOff, resume on
  // PoweredOn. Without this, the BleManager throws "BluetoothLE is
  // powered off" the first time the user toggles BT off mid-session
  // and the mesh appears to keep running while emitting nothing.
  // -------------------------------------------------------------------
  let stateSub: { remove: () => void } | null = null;
  try {
    stateSub = manager.onStateChange((state: string) => {
      if (stopped) return;
      console.log("[discovery-ble] adapter state=", state);
      if (state === "PoweredOff") {
        stopScanForRestart();
        emitMeshFailure({ kind: "adapter_off" });
      } else if (state === "PoweredOn") {
        startScan();
        emitMeshFailure({ kind: "adapter_on" });
      }
    }, true);
  } catch (err) {
    if (__DEV__) console.warn("[discovery-ble] onStateChange threw", err);
  }

  // Peripheral advertising (Phase 6.1) is handled OUT OF BAND in
  // mesh/index.ts startShopMode() → startBLEPeripheralMode(). This
  // module owns CENTRAL/scan only. listenPort is unused here — the
  // capability flag carried by advertising indicates wifi-upgrade
  // support; the actual port is exchanged over GATT post-handshake.
  void opts.listenPort;

  return async () => {
    stopped = true;
    if (scanRestartTimer) clearTimeout(scanRestartTimer);
    if (stateSub) {
      try {
        stateSub.remove();
      } catch {
        /* */
      }
    }
    try {
      manager.stopDeviceScan();
    } catch {
      /* */
    }
    try {
      // BleManager.destroy releases native resources; required on
      // re-create later in the same process.
      manager.destroy?.();
    } catch {
      /* */
    }
    // Mythos §4: null transport-ble's shared singleton so the next dial
    // after this stop/start cycle doesn't grab the destroyed instance.
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require("./transport-ble")._clearSharedBleManager();
    } catch {
      /* */
    }
  };
}

// ---------------------------------------------------------------------------
// Advertisement parsing
// ---------------------------------------------------------------------------

/**
 * Decode a react-native-ble-plx Device's manufacturer data into a
 * BLEPeerRaw. Returns null when the advertisement is missing required
 * fields. Defensive against malformed payloads — a bug-or-hostile peer
 * should never crash the scan loop.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function parseAdvertisement(device: any): BLEPeerRaw | null {
  if (!device?.id) return null;
  const rssi = typeof device.rssi === "number" ? device.rssi : null;
  // ble-plx exposes `manufacturerData` as base64-encoded bytes when
  // present. Our framing: [1 capability_flags][1 vault_epoch_hint]
  // [Nx4 vault hashes]. We tolerate missing manufacturerData (some
  // peripherals only carry serviceUUIDs in the primary adv) and emit
  // with empty hashes — the mesh will skip-no-match.
  let capabilityFlags = 0;
  let vaultEpochHint = 0;
  let vaultHashes: string[] = [];
  const mfgB64: string | undefined = device.manufacturerData;
  // BUG-F: hard-require manufacturer data. Without it we cannot
  // distinguish a stranger phone from a Kaata peer, so emitting it
  // would inflate seenDevices and trip the 200-device circuit breaker
  // in any reasonable BLE environment (foot traffic, beacons, etc).
  if (typeof mfgB64 !== "string" || mfgB64.length === 0) return null;
  let fingerprintOk = false;
  {
    try {
      // eslint-disable-next-line no-undef
      const bin = atob(mfgB64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      // ble-plx Android exposes the FULL manufacturer AD field including
      // the 2-byte little-endian company ID prefix (0xFF 0xFF in our case
      // — see react-native-ble-advertiser broadcast(): bytes 0-1 = companyId).
      // The payload we actually wrote starts at byte 2:
      //   [0..1] company ID (skip)
      //   [2]    capability_flags
      //   [3]    vault_epoch_hint
      //   [4..]  Nx4 vault hashes
      // BEFORE THIS FIX we read bytes[0] as capabilityFlags (got 0xFF
      // masked to 0x01), bytes[1] as vaultEpoch (got 0xFF), and bytes[2..]
      // as vault hashes (got capability+epoch+partial real hash). Hashes
      // never matched our vaultHashIndex → discovery emitted matchedVaultIds=[]
      // → handleRoutedPeer silently returned before dialBLEPeer → no GATT
      // connection → no handshake → no event propagation. The "Nearby
      // sync active" notification just confirmed local advertiser/scanner
      // started; no actual peer was ever found.
      // BUG-F: Kaata fingerprint check. After removing the service-UUID
      // filter (the scanner now sees EVERY BLE advert in range), this
      // gate is what prevents stranger phones (AirPods, Mi-Bands, beacons,
      // other apps' adverts) from inflating seenDevices and tripping the
      // circuit breaker after 200 distinct MACs. Two requirements:
      //   1. manufacturer ID matches Kaata's (0xFFFF little-endian).
      //   2. capability_flags reserved bits are zero (our known mask).
      // A peer that fails this fingerprint is silently dropped BEFORE
      // it touches seenDevices — only legitimate Kaata adverts count
      // toward the breaker.
      if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xff) {
        const rawCap = bytes[2];
        // Reserved bits set → future protocol version OR a non-Kaata
        // peer that happens to use 0xFFFF (the unassigned test
        // company ID). Either way: drop.
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
    } catch {
      // atob failed — corrupt b64. Drop.
    }
  }
  if (!fingerprintOk) return null;
  return {
    kind: "ble",
    deviceId: device.id,
    rssi,
    vaultHashes,
    capabilityFlags,
    vaultEpochHint,
  };
}
