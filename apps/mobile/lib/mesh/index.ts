// apps/mobile/lib/mesh/index.ts
//
// Phase 6 mesh public API.
//
// SHIPPED IN THIS BUILD:
//   - Per-device Ed25519 keypair + SecureStore (`device-key.ts`).
//   - Server-signed VMC issuance + verify + cache + TOFU pinning
//     (`vmc.ts`, backend `internal/mesh/`).
//   - mDNS discovery with vault-tag matching (`discovery.ts`).
//   - HLC anti-entropy with proof-of-possession handshake + epoch
//     comparison + asymmetric-sync-safe batch budget (`anti-entropy.ts`).
//   - Same-account QR pairing (`vault/pair.tsx`, `vault/pair-scan.tsx`).
//   - Mesh-received events bridge to HTTP push via `server_acked_at:NULL`.
//   - PHASE 6: Discovery-router state machine (`discovery-router.ts`)
//     that owns the BLE-primary + mDNS-opportunistic lifecycle, wired
//     in this file at startShopMode().
//   - PHASE 6: Opportunistic wifi-upgrade flow (`wifi-upgrade.ts`)
//     called from anti-entropy.ts when a BLE delta exchange would
//     exceed BLE_WIFI_UPGRADE_PROMPT_SECONDS.
//   - PHASE 6: Foreground service declaring connectedDevice|dataSync
//     types (`foreground.ts` + plugin), required by Android 14+ for
//     holding open BLE GATT connections while backgrounded.
//
// NOT YET SHIPPED (deferred to Phase 6.1 — DO NOT remove from docstrings
// without flipping the implementation):
//   - BLE peripheral mode (advertising + GATT server) — react-native-ble-plx
//     3.x only supports central; needs either react-native-ble-advertiser
//     or a custom Kotlin module. Without peripheral support, central-only
//     mesh cannot form pairs in a real shop scenario. See PERIPHERAL_TODO
//     in transport-ble.ts for options.
//   - BLE application-layer encryption (X25519 ECDH from device_pubkeys →
//     HKDF-SHA512 → ChaCha20-Poly1305 per frame). transport-ble.ts has
//     the structural hooks (`installAead`, `encryptFrame`/`decryptFrame`);
//     until this lands, BLE wire traffic is plaintext over the air. See
//     SECURITY CALLOUT in the PR description.
//   - iOS-side mesh (Multipeer Connectivity).
//
// BUILD / DEPLOY PROCEDURE:
//
//   1. EAS dev client APK is REQUIRED. `react-native-ble-plx`,
//      `react-native-webrtc`, and `react-native-zeroconf` are native
//      modules — Expo Go does not include them.
//
//        cd apps/mobile
//        eas build --profile development --platform android
//
//      Must be run from `apps/mobile/`, NOT from the repo root.
//
//   2. New Android permissions added in Phase 6 (see app.json):
//        FOREGROUND_SERVICE_CONNECTED_DEVICE
//        REQUEST_IGNORE_BATTERY_OPTIMIZATIONS
//      Existing BLUETOOTH_SCAN now ships with neverForLocation flag
//      (plugins/withNearbyWifiNeverForLocation.js was generalized).
//
//   3. Confirm @config-plugins/react-native-webrtc is intact and
//      ./plugins/withNotifeeForegroundService is enabled (declares
//      the `connectedDevice|dataSync` FGS type).

// Side-effect import — installs the @noble/ed25519 Hermes shims
// (sha512Sync + randomBytes via expo-crypto). Centralized in
// _ed25519-setup.ts so device-key.ts can import it independently
// without creating a circular dep on the mesh barrel.
import "./_ed25519-setup";

import { getAppMeta, setAppMeta } from "../db";
import { getActiveVaultIdSyncMaybe, getDb } from "../db-tx";

import { ensureDeviceKey, registerDeviceKey, getDevicePubkey } from "./device-key";
import { runAntiEntropy, loadVaultTrustAnchor } from "./anti-entropy";
import {
  configureDiscoveryRouter,
  onPeerFound,
  publishVaultHashIndex,
  startDiscovery as routerStartDiscovery,
  stopDiscovery as routerStopDiscovery,
  type RoutedPeer,
} from "./discovery-router";
// vaultHashTag still drives the BLE manufacturer-data 4-byte hash; the mDNS
// side has moved to discovery-lan (salted daily digests) below.
import { vaultHashTag } from "./discovery";
import {
  startLanDiscovery,
  stopLanDiscovery,
  onPeerFound as onLanPeerFound,
} from "./discovery-lan";
import { startBle } from "./discovery-ble";
import { startLanListener, dialLanPeer } from "./transport-lan";
import type { MeshConnection } from "./transport-interface";
import {
  coordinateWifiUpgrade,
  estimateBleSeconds,
  shouldOfferWifiUpgrade,
  shouldPromptForWifi,
} from "./wifi-upgrade";
import { Platform } from "react-native";

import {
  MeshHandshakeError,
  MeshTransportError,
  MeshVMCExpiredError,
  MeshVMCRevokedError,
  ShopModeForegroundServiceFailedError,
  ShopModeNotAvailableError,
  MeshPeripheralUnsupportedError,
  emitMeshFailure,
} from "./errors";
import {
  startBLEPeripheralMode,
  startPeripheralGattAcceptLoop,
  dialBLEPeer,
  CAP_FLAG_SUPPORTS_WIFI_UPGRADE,
} from "./transport-ble";

// ---------------------------------------------------------------------------
// app_meta keys (mirrored in db.ts migration documentation).
// ---------------------------------------------------------------------------
export const SHOP_MODE_ENABLED_KEY = "shop_mode_enabled";
export const SHOP_MODE_LAST_ACTIVE_AT_KEY = "shop_mode_last_active_at";

// ---------------------------------------------------------------------------
// Discovery-router configuration. Wired once at module load — the router
// stays uninitialized otherwise and throws on first start (engineering
// critique #2: `configureDiscoveryRouter() not called`). Adapter functions
// are injected via require-style wrappers so test environments can swap
// them out.
// ---------------------------------------------------------------------------
configureDiscoveryRouter({
  startBle,
  startMdns: async (opts) => {
    // M3: the opportunistic mDNS window is now the LAN driver
    // (discovery-lan.ts) — it advertises the TCP listener port (opts.listenPort
    // is the LAN listener's OS-assigned port) + salted daily vault digests.
    // Adapter holds the listener subscription so stop() tears it down
    // idempotently.
    const unsub = onLanPeerFound(opts.onPeerFound);
    await startLanDiscovery({ tcpPort: opts.listenPort });
    return async () => {
      unsub();
      await stopLanDiscovery();
    };
  },
});

// ---------------------------------------------------------------------------
// Module-level state.
//
// connections is keyed by `${remoteDeviceId}:${vaultId}` POST-handshake
// (the cryptographically authenticated device_id). Pre-handshake
// scheduling still uses installIdShort so we don't dial the same peer
// twice in parallel — but it is best-effort. Spoofing the
// pre-handshake key only triggers extra dial attempts that all fail at
// VMC verify; no security impact (per critique C4).
// ---------------------------------------------------------------------------
type RunState = {
  running: boolean;
  generation: number;
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
  unsubscribeDiscovery: (() => void) | null;
  listenPort: number;
  /** Stop fn for the M3 LAN (TCP) listener. Null when not running. */
  lanListenerStop: (() => Promise<void>) | null;
  /** Stop fn returned by startBLEPeripheralMode. Null when peripheral is
   *  not running (unsupported chip or not yet started). */
  peripheralStop: (() => Promise<void>) | null;
  /** Stop fn returned by startPeripheralGattAcceptLoop. Null when the GATT
   *  server module isn't loaded or open failed. */
  peripheralGattStop: (() => Promise<void>) | null;
};

const state: RunState = {
  running: false,
  generation: 0,
  connections: new Map(),
  inflight: new Set(),
  liveSessionCount: 0,
  unsubscribeDiscovery: null,
  listenPort: 0,
  lanListenerStop: null,
  peripheralStop: null,
  peripheralGattStop: null,
};

function makeConnKey(deviceId: string, vaultId: string): string {
  return `${deviceId}:${vaultId}`;
}

let cachedLastActiveAt: number | null = null;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export type ShopModeStatus = {
  enabled: boolean;
  lastActiveAt: number | null;
  activePeers: number;
};

/** Synchronous status snapshot. Cheap — no DB. */
export function getShopModeStatus(): ShopModeStatus {
  return {
    enabled: state.running,
    lastActiveAt: cachedLastActiveAt,
    // BUG-B: state.connections.size used to be the activePeers source
    // and leaked monotonically because connections were never removed.
    // liveSessionCount is incremented on handshake success and
    // decremented on close — accurate AND bounded.
    activePeers: state.liveSessionCount,
  };
}

// ---------------------------------------------------------------------------
// Status observer for the UI. Replaces the AutoSync-style 10s poll with
// an event-driven subscription so peer count changes flow into the
// notification body and the menu hint without lag (UX critique).
// ---------------------------------------------------------------------------
type StatusListener = (s: ShopModeStatus) => void;
const statusListeners = new Set<StatusListener>();

export function onShopModeStatusChange(handler: StatusListener): () => void {
  statusListeners.add(handler);
  return () => statusListeners.delete(handler);
}

function emitStatusChange(): void {
  const snapshot = getShopModeStatus();
  for (const listener of statusListeners) {
    try {
      listener(snapshot);
    } catch (err) {
      if (__DEV__) console.warn("[mesh] status listener threw", err);
    }
  }
}

// ---------------------------------------------------------------------------
// Vault-hash index — needed by the router so BLE-advertised hash prefixes
// resolve to local vault_id UUIDs. Re-built at startShopMode + whenever
// the vault set changes.
// ---------------------------------------------------------------------------
async function rebuildVaultHashIndex(): Promise<void> {
  const db = await getDb();
  const rows = await db.getAllAsync<{ id: string }>(
    `SELECT id FROM vaults WHERE archived_at IS NULL`,
  );
  const index = new Map<string, string>();
  for (const r of rows) {
    // BLE advertises hex(first 4 bytes of sha256(vault_id)); convert from
    // the Phase 5 mDNS base64 form here so the same hashing pipeline lives
    // in vaultHashTag().
    const b64 = await vaultHashTag(r.id);
    // ble parser emits hex of the first 4 bytes. Convert b64 head to hex:
    const decoded = b64UrlToBytes(b64);
    let hex = "";
    for (let i = 0; i < Math.min(4, decoded.length); i++) {
      hex += decoded[i].toString(16).padStart(2, "0");
    }
    if (hex) index.set(hex, r.id);
  }
  publishVaultHashIndex(index);
}

function b64UrlToBytes(b64Url: string): Uint8Array {
  const std = b64Url.replace(/-/g, "+").replace(/_/g, "/");
  const padded = std + "=".repeat((4 - (std.length % 4)) % 4);
  // eslint-disable-next-line no-undef
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * Snapshot of (vault_id, 4-byte hash hex, low-8-bits of vault_epoch) for
 * every non-archived vault on the device. Used by startBLEPeripheralMode
 * to populate the advertising manufacturer-data payload.
 *
 * Order = active vault first (so it gets advertised on the first rotation
 * tick), then by vault.created_at DESC to bias recently-opened vaults.
 */
async function snapshotVaultHashesForAdvertise(): Promise<
  Array<{ vaultId: string; hashHex: string; epochLow: number }>
> {
  const db = await getDb();
  const rows = await db.getAllAsync<{
    id: string;
    vault_epoch: number | null;
  }>(
    `SELECT id, vault_epoch FROM vaults
      WHERE archived_at IS NULL
      ORDER BY created_at DESC`,
  );
  const activeVaultId = getActiveVaultIdSyncMaybe();
  const out: Array<{ vaultId: string; hashHex: string; epochLow: number }> = [];
  for (const r of rows) {
    const b64 = await vaultHashTag(r.id);
    const decoded = b64UrlToBytes(b64);
    let hex = "";
    for (let i = 0; i < Math.min(4, decoded.length); i++) {
      hex += decoded[i].toString(16).padStart(2, "0");
    }
    if (!hex) continue;
    out.push({
      vaultId: r.id,
      hashHex: hex,
      epochLow: (r.vault_epoch ?? 0) & 0xff,
    });
  }
  // Push the active vault to the front of the pool so it's the first
  // advertised hash (lowest discovery latency for the dominant case of
  // "two phones, one vault").
  if (activeVaultId) {
    const idx = out.findIndex((r) => r.vaultId === activeVaultId);
    if (idx > 0) {
      const [active] = out.splice(idx, 1);
      out.unshift(active);
    }
  }
  return out;
}

/**
 * BUG-A: Tell mesh that the local vault set has changed (pair-join, vault
 * create, archive, restore, epoch-bump). Without this, startShopMode
 * snapshots the vault index ONCE and the just-joined vault is invisible
 * to BLE discovery + missing from the advertise payload — even though
 * the UI shows it as the active vault — until the user power-cycles
 * Nearby sync. The frozen-index bug confused users into thinking pair
 * succeeded but sync was broken.
 *
 * No-op when mesh is not running (state.running === false). When running:
 *   1. Rebuild the receive-side hash → vault_id index. Instant; affects
 *      the very next [discovery-ble] peer match.
 *   2. Tear down + restart the BLE advertiser with the new hash snapshot.
 *      The advertiser stop ONLY tears down the rotation/restart timers
 *      and stops broadcasting; the GATT server stays up so any in-flight
 *      handshake is unaffected.
 *
 * Safe to call from a SQLite transaction's commit callback or from React
 * effects — the function is idempotent and self-throttling (we don't
 * restart the advertiser if the new hash set is identical to the prior
 * snapshot).
 */
let lastAdvertisedHashSetKey = "";
export async function notifyVaultSetChanged(): Promise<void> {
  if (!state.running) return;
  try {
    await rebuildVaultHashIndex();
  } catch (err) {
    console.warn("[mesh.notifyVaultSetChanged] rebuildVaultHashIndex failed", err);
    // continue — peripheral refresh is still useful
  }
  try {
    const snapshot = await snapshotVaultHashesForAdvertise();
    // Dedup: avoid tearing down a healthy advertiser when nothing
    // actually changed (e.g. multiple events firing on the same vault
    // mutation). Hash set key = sorted list of vaultId@epochLow.
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
    console.log("[mesh.notifyVaultSetChanged] re-advertising", snapshot.length, "vault(s)");
  } catch (err) {
    if (err instanceof MeshPeripheralUnsupportedError) {
      console.warn("[mesh.notifyVaultSetChanged] peripheral not supported on this chip");
    } else {
      console.warn("[mesh.notifyVaultSetChanged] peripheral refresh failed", err);
    }
  }
}

/**
 * Turn shop mode on. Idempotent.
 *
 * Phase 7 D-SHOP-MODE-UNGATING: sign-in is NO LONGER required. The gate
 * becomes "at least one non-archived vault on this device has either a
 * trust anchor (local-CA mode) OR a cached server-issued VMC
 * (server-anchored mode)". Without one of those, mesh has nothing to
 * advertise / nothing for peers to verify against, so we refuse early
 * with a typed error the UI can surface as a toast.
 */
export async function startShopMode(): Promise<void> {
  if (state.running) {
    console.log("[mesh.start] already running, no-op");
    return;
  }
  console.log("[mesh.start] begin");
  // BUG-J: wrap the body in try/catch so a partial failure (e.g. FGS
  // start fails on MIUI) rolls back the radios we already brought up.
  // Without this, advertiser+GATT+scanner+listener all keep burning
  // battery while state.running stays "true-but-not-really", and the
  // next startShopMode call no-ops via the idempotent guard above.
  try {
    await startShopModeBody();
  } catch (err) {
    console.warn("[mesh.start] partial-failure rollback", err);
    state.running = false;
    // skipFGS=true: if the FGS was the failing step it never came up,
    // and calling stopForegroundService unnecessarily can spawn the
    // notifee headless-task that crashes MIUI.
    const fgsLikelyFailed =
      err instanceof ShopModeForegroundServiceFailedError ||
      (err instanceof Error && /foreground/i.test(err.message));
    await teardownRadios({ skipFGS: fgsLikelyFailed });
    emitStatusChange();
    throw err;
  }
}

async function startShopModeBody(): Promise<void> {
  const db = await getDb();
  // M4: a vault is mesh-eligible iff it's chain-anchored
  // (vault_trust_anchor_pubkey populated) — the chain is the sole trust
  // path, so there's no VMC fallback. We need at least one such vault.
  const eligible = await db.getFirstAsync<{ id: string }>(
    `SELECT v.id AS id
       FROM vaults v
      WHERE v.archived_at IS NULL
        AND v.vault_trust_anchor_pubkey IS NOT NULL
      LIMIT 1`,
  );
  if (!eligible) {
    console.warn("[mesh.start] no eligible vault — refusing");
    throw new ShopModeNotAvailableError("Create or join a Kaata first");
  }
  console.log("[mesh.start] eligible vault=", eligible.id.slice(0, 8));

  await setAppMeta(SHOP_MODE_ENABLED_KEY, "1");

  await ensureDeviceKey();
  console.log("[mesh.start] device key ready pubkey=", (getDevicePubkey() ?? "").slice(0, 8) + "…");

  // M4: no self-VMC re-issuance. Trust is chain-native — every vault is
  // anchored and the owner's genesis vault_member_added is its membership
  // proof. The handshake builds its proof bundle from the chain, so there
  // is no per-vault credential to mint at mesh start.

  // Bump generation so a previous-generation in-flight handshake's
  // commit-to-map step sees the change and abandons.
  state.generation++;
  const currentGen = state.generation;

  // Refresh the vault-hash index so BLE peer events can resolve to
  // local vault_id UUIDs.
  await rebuildVaultHashIndex();
  console.log("[mesh.start] vault hash index rebuilt");

  // M3: start the LAN (TCP) listener first so discovery has a real port to
  // advertise. The OS assigns the port; inbound accepted sockets flow into the
  // SAME handlePeerConnection pipeline the BLE peripheral feeds, so
  // runAntiEntropy runs role-agnostically on the inbound side.
  const lan = await startLanListener({
    onConnection: (conn) => {
      void handlePeerConnection(conn, "incoming", currentGen);
    },
  });
  const port = lan.port;
  state.listenPort = port;
  state.lanListenerStop = lan.stop;
  console.log("[mesh.start] LAN listener on port", port);

  // Phase 6: route through discovery-router, which owns BOTH BLE and
  // mDNS lifecycles. Pre-router we imported from `./discovery` directly
  // — that path is now retired here (still imported below as the
  // adapter implementation).
  await routerStartDiscovery({ listenPort: port });
  state.unsubscribeDiscovery = onPeerFound((peer) => {
    void handleRoutedPeer(peer, currentGen);
  });
  console.log("[mesh.start] discovery router started (BLE scan)");

  // Phase 6.1: bring up the peripheral (advertise) so other Kaata phones
  // can find US. Soft-fails: if the chip lacks peripheral support,
  // MeshPeripheralUnsupportedError is thrown — we catch and continue
  // central-only. The failure bridge surfaces the toast.
  try {
    const vaultHashes = await snapshotVaultHashesForAdvertise();
    const peripheralStop = await startBLEPeripheralMode({
      vaultHashes,
      capabilityFlags: CAP_FLAG_SUPPORTS_WIFI_UPGRADE,
    });
    state.peripheralStop = peripheralStop;
    console.log("[mesh.start] peripheral started, advertising", vaultHashes.length, "vault(s)");
  } catch (err) {
    if (err instanceof MeshPeripheralUnsupportedError) {
      // Soft failure: scan keeps running, we stay invisible to others.
      // emitMeshFailure already fired in startBLEPeripheralMode.
      console.warn("[mesh.start] peripheral unsupported on this chip; scan-only mode");
      state.peripheralStop = null;
    } else {
      console.warn("[mesh.start] peripheral start failed (non-fatal)", err);
      state.peripheralStop = null;
    }
  }

  // v0.5.2 GATT SERVER: open the BluetoothGattServer alongside the
  // advertiser. Without this, centrals that dial our advertisement see an
  // empty service tree and STREAM_CHAR writes return GATT_INVALID_HANDLE.
  // The accept loop wraps each incoming central connection as a
  // BleMeshConnection and routes it into the SAME handlePeerConnection
  // pipeline that incoming LAN (TCP) connections use (see the LAN listener's
  // onConnection above). runAntiEntropy is
  // role-symmetric — both sides exchange Hello, PoP, AEAD-derive, Summary,
  // Delta over the same code path.
  //
  // Only attempt if the advertiser also started. If the chip can't advertise,
  // no central will ever try to connect to us, so the GATT server would just
  // sit idle.
  if (state.peripheralStop) {
    try {
      const gattStop = await startPeripheralGattAcceptLoop({
        onIncomingConnection: (conn) => {
          console.log("[mesh.start.gatt] incoming BLE central accepted");
          void handlePeerConnection(conn, "incoming", currentGen);
        },
      });
      state.peripheralGattStop = gattStop;
      console.log("[mesh.start] GATT server open, accepting central connections");
    } catch (err) {
      // MeshPeripheralUnsupportedError already emitted via failure bridge.
      // We keep the advertiser running so the other phone can still scan
      // us — they just can't complete a write. This is a degraded mode but
      // not a fatal one.
      console.warn("[mesh.start] GATT accept loop failed (non-fatal)", err);
      state.peripheralGattStop = null;
    }
  } else {
    if (__DEV__) console.log("[mesh.start] skipping GATT server because advertiser is not running");
  }

  state.running = true;
  emitStatusChange();

  // Phase 6: promote to a foreground service. The service type declared
  // in the manifest (connectedDevice|dataSync) matches the JS-side bitmask
  // passed by foreground.ts.
  //
  // UX critique #6 fix: on Android, FGS failure is NOT optional — without
  // it, the OS Doze kills the BLE radio within minutes and the user
  // believes "Nearby sync" is on while no peer can actually reach them.
  // Surface the failure so the caller (MeshController) reverts the
  // shop_mode_enabled toggle and shows a specific error toast. On
  // non-Android (Expo Go / web / iOS) the FGS no-op is still fine —
  // foreground.ts returns false but we let it slide.
  try {
    const fg = await import("./foreground");
    const ok = await fg.startShopModeForegroundService();
    console.log("[mesh.start] FGS started=", ok);
    if (!ok && Platform.OS === "android") {
      throw new ShopModeForegroundServiceFailedError(
        "Couldn't start the nearby-sync notification.",
      );
    }
  } catch (err) {
    if (err instanceof ShopModeForegroundServiceFailedError) throw err;
    if (Platform.OS === "android") {
      throw new ShopModeForegroundServiceFailedError(
        err instanceof Error ? err.message : "Foreground service start failed",
      );
    }
    if (__DEV__) console.warn("[mesh] foreground service start failed", err);
  }
  // Mythos crash-diagnosis: sample memory/storage every 60s while shop
  // mode is on so the Diagnostics screen can render the leak slope over a
  // crash window. Best-effort; never throws.
  try {
    const { startMemProbe } = await import("./mem-probe");
    startMemProbe();
  } catch {
    /* */
  }
  console.log("[mesh.start] DONE — Nearby sync active");
}

/**
 * BUG-J: extracted teardown so it can be called from both the public
 * stopShopMode AND from startShopMode's catch block on partial failure
 * (e.g. FGS start failed → advertiser/scanner/GATT-server kept running
 * and silently burning battery). Without this, the next startShopMode
 * call no-op'd via the idempotent guard while state.running was true.
 *
 * Optional `skipFGS` arg: when called from startShopMode catch where
 * the FGS was the failing step, don't try to stop a service that never
 * came up (would trigger the same MIUI HeadlessJS crash that
 * stopShopMode normally avoids via the wasRunning gate).
 */
async function teardownRadios(opts: { skipFGS?: boolean } = {}): Promise<void> {
  // Mythos crash-diagnosis: stop the memory sampler when shop mode ends.
  try {
    const { stopMemProbe } = await import("./mem-probe");
    stopMemProbe();
  } catch {
    /* */
  }
  if (!opts.skipFGS) {
    try {
      const fg = await import("./foreground");
      await fg.stopShopModeForegroundService();
    } catch (err) {
      if (__DEV__) console.warn("[mesh] foreground service stop failed", err);
    }
  }
  if (state.peripheralStop) {
    try {
      await state.peripheralStop();
    } catch (err) {
      console.warn("[mesh] peripheral stop threw, continuing", err);
    }
    state.peripheralStop = null;
  }
  if (state.peripheralGattStop) {
    try {
      await state.peripheralGattStop();
    } catch (err) {
      console.warn("[mesh] GATT accept loop stop threw, continuing", err);
    }
    state.peripheralGattStop = null;
  }
  if (state.unsubscribeDiscovery) {
    state.unsubscribeDiscovery();
    state.unsubscribeDiscovery = null;
  }
  try {
    await routerStopDiscovery();
  } catch (err) {
    console.warn("[mesh] router stopDiscovery threw, continuing", err);
  }
  if (state.lanListenerStop) {
    try {
      await state.lanListenerStop();
    } catch (err) {
      console.warn("[mesh] LAN listener stop threw, continuing", err);
    }
    state.lanListenerStop = null;
  }
  for (const conn of state.connections.values()) {
    try {
      void conn.close();
    } catch {
      /* */
    }
  }
  state.connections.clear();
  state.inflight.clear();
  state.liveSessionCount = 0;
  state.listenPort = 0;
}

/**
 * Turn shop mode off. Idempotent.
 */
export async function stopShopMode(): Promise<void> {
  // Capture whether we were actually running BEFORE we flip state.running.
  // If we were never running (process startup with shop_mode_enabled='0',
  // which is the common case), skip the foreground-service teardown
  // entirely. Calling notifee.stopForegroundService() when no FGS is
  // active triggers a notifee HeadlessJS task spawn that crashes the
  // app on Xiaomi/MIUI — see the comment block in foreground-bootstrap.ts
  // for the full mechanism. The teardown only runs when there's actually
  // something to tear down.
  const wasRunning = state.running;
  state.generation++;
  state.running = false;
  emitStatusChange();
  // BUG-J: shared teardown. skipFGS is false here (we want to actually
  // stop the notification when shop mode goes off via user toggle).
  await teardownRadios({ skipFGS: !wasRunning });

  await setAppMeta(SHOP_MODE_ENABLED_KEY, "0");
  const db = await import("../db");
  await db.setAppMeta("shop_mode_started_at", "");
}

/** One-time hydrator. Call once during boot. Safe to call repeatedly. */
export async function hydrateLastActiveAt(): Promise<void> {
  const raw = await getAppMeta(SHOP_MODE_LAST_ACTIVE_AT_KEY);
  cachedLastActiveAt = raw ? Number(raw) : null;
}

// ---------------------------------------------------------------------------
// Internal peer drivers
// ---------------------------------------------------------------------------

async function handleRoutedPeer(routed: RoutedPeer, gen: number): Promise<void> {
  if (gen !== state.generation) return;
  const peerInfo = routed.peerInfo;
  if (routed.transport === "mdns" && routed.raw.isSelf) return;

  // M4 dispatch gate: a vault is mesh-eligible iff it's chain-anchored
  // (loadVaultTrustAnchor non-null). The real membership check stays in
  // verifyPeerChain; this gate only filters which vault we dial for.
  let chosenVaultId: string | null = null;
  for (const vid of peerInfo.matchedVaultIds) {
    if (await loadVaultTrustAnchor(vid)) {
      chosenVaultId = vid;
      break;
    }
  }
  if (!chosenVaultId) return;

  // Pre-handshake dedup.
  //
  // BUG (from handshake-fail-2.log): Android BLE uses MAC randomization
  // (NRPA — non-resolvable private addresses) that rotates every ~500ms.
  // The same physical phone advertises with a fresh MAC each tick, so
  // `peerInfo.installIdShort` (derived from the MAC) was DIFFERENT every
  // time the scanner emitted the peer. The previous inflightKey was
  // therefore useless as a gate — every emit triggered a new dialBLEPeer
  // which CANCELLED the previous in-flight dial at the BLE driver level
  // (logged as "connectToDevice failed: Operation was cancelled"). No
  // handshake ever completed. Symptom: menu.ble.peerHandshakeFailed toast
  // 10-30s after pairing, after dozens of cancelled dials.
  //
  // Fix: for BLE, key the inflight gate ONLY on the vault. There can be
  // at most one in-flight dial per (vault, this device) on BLE; if a
  // second peer for the same vault comes in mid-handshake, drop it. The
  // current in-flight handshake will succeed (or transient-fail and the
  // next emit retries within 5s thanks to BUG-C). For mDNS the
  // installIdShort is stable (service name, not MAC), so the legacy key
  // is fine there.
  const inflightKey =
    routed.transport === "ble"
      ? `ble:${chosenVaultId}`
      : `${peerInfo.installIdShort}:${chosenVaultId}`;
  if (state.inflight.has(inflightKey)) return;
  state.inflight.add(inflightKey);

  try {
    if (routed.transport === "mdns") {
      // M3: mDNS discovered a LAN peer (discovery-lan.ts). Dial it over TCP.
      const raw = routed.raw;
      console.log(
        "[mesh.lan.dial] LAN peer matched vault=",
        chosenVaultId.slice(0, 8),
        "host=",
        raw.host,
        "port=",
        raw.port,
      );
      const conn = await dialLanPeer({ host: raw.host, port: raw.port });
      await handlePeerConnection(conn, "outgoing", gen, {
        vaultId: chosenVaultId,
        installIdShort: peerInfo.installIdShort,
      });
    } else {
      // BLE transport — Phase 6.1 wired path. The peripheral side on the
      // OTHER phone advertised the vault hash; we dial here.
      //
      // Race note: if both phones discover each other simultaneously,
      // they both dial. Post-handshake dedup at the connections.set
      // step below catches the loser and closes the duplicate. This is
      // the simplest correct path — no need for a "lower-deviceId
      // suppresses" pre-handshake protocol when the worst case is a
      // ~5s wasted handshake.
      const raw = routed.raw;
      console.log(
        "[mesh.ble.dial] BLE peer matched vault=",
        chosenVaultId.slice(0, 8),
        "installIdShort=",
        peerInfo.installIdShort,
        "deviceId=",
        raw.deviceId,
      );
      const conn = await dialBLEPeer({ deviceId: raw.deviceId });
      console.log("[mesh.ble.dial] GATT connected, starting handshake");
      await handlePeerConnection(conn, "outgoing", gen, {
        vaultId: chosenVaultId,
        installIdShort: peerInfo.installIdShort,
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

type ConnectionContext = {
  vaultId: string;
  installIdShort: string;
};

async function handlePeerConnection(
  conn: MeshConnection,
  direction: "incoming" | "outgoing",
  gen: number,
  ctx?: ConnectionContext,
): Promise<void> {
  if (gen !== state.generation) {
    void conn.close();
    return;
  }
  let vaultId: string;
  if (ctx) {
    vaultId = ctx.vaultId;
  } else {
    const activeVaultId = getActiveVaultIdSyncMaybe();
    if (!activeVaultId) {
      void conn.close();
      return;
    }
    vaultId = activeVaultId;
  }

  // M4 dispatch gate: the vault must be chain-anchored. Look up the
  // per-vault trust anchor (the owner's device pubkey, fixed at vault
  // creation). Null means the vault isn't chain-anchored — there is no
  // other trust path, so refuse. The chain handshake folds the peer's
  // membership proof against this key.
  const vaultTrustAnchorPubkey = await loadVaultTrustAnchor(vaultId);
  if (!vaultTrustAnchorPubkey) {
    void conn.close();
    return;
  }

  // Determine our own device_id (Ed25519 pubkey, base64) for the
  // wifi-upgrade race-resolver. Fall back to install_id-short if unset.
  const ownDeviceId = getDevicePubkey() ?? "";

  try {
    const result = await runAntiEntropy(conn, {
      vaultId,
      vaultTrustAnchorPubkey,
      coordinateUpgrade: ownDeviceId
        ? {
            ownDeviceId,
            shouldPromptForWifi,
            estimateBleSeconds,
            shouldOfferWifiUpgrade,
            coordinateWifiUpgrade,
          }
        : undefined,
      upgradeListenPort: state.listenPort,
    });

    if (gen !== state.generation) {
      void conn.close();
      return;
    }
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
  } catch (err) {
    void conn.close();
    if (
      err instanceof MeshHandshakeError ||
      err instanceof MeshVMCExpiredError ||
      err instanceof MeshVMCRevokedError ||
      err instanceof MeshTransportError
    ) {
      console.warn(`[mesh] ${direction} peer dropped: ${err.message}`);
      // Surface the failure to the toast bridge with the most useful
      // discriminator we can. MeshHandshakeError already carries `kind`;
      // the other types map to generic "transport".
      if (err instanceof MeshHandshakeError) {
        emitMeshFailure({ kind: "peer_handshake_failed", reason: err.kind });
      } else if (err instanceof MeshVMCExpiredError) {
        emitMeshFailure({ kind: "peer_handshake_failed", reason: "vmc_invalid" });
      } else if (err instanceof MeshVMCRevokedError) {
        emitMeshFailure({ kind: "peer_handshake_failed", reason: "vmc_invalid" });
      } else {
        emitMeshFailure({ kind: "peer_handshake_failed", reason: "transport" });
      }
    } else {
      console.warn("[mesh] unexpected handshake/anti-entropy error", err);
      emitMeshFailure({ kind: "peer_handshake_failed", reason: "transport" });
    }
  }
}

async function touchLastActive(): Promise<void> {
  const now = Date.now();
  cachedLastActiveAt = now;
  await setAppMeta(SHOP_MODE_LAST_ACTIVE_AT_KEY, String(now));
}

// ---------------------------------------------------------------------------
// Public re-exports.
// ---------------------------------------------------------------------------

export { ensureDeviceKey, registerDeviceKey } from "./device-key";

export {
  MeshHandshakeError,
  MeshVMCExpiredError,
  MeshVMCRevokedError,
  MeshTransportError,
  ShopModeForegroundServiceFailedError,
  ShopModeNotAvailableError,
  MeshPeripheralUnsupportedError,
  MeshAdapterOffError,
  setMeshFailureBridge,
} from "./errors";

export { setWifiUpgradePromptBridge, setWifiUpgradeToastBridge } from "./wifi-upgrade";
