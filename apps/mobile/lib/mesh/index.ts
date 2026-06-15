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
//      ./plugins/withKaataForegroundService is enabled (declares the native
//      KaataForegroundService with the `connectedDevice` FGS type).

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
import { startLanListener, dialLanPeer } from "./transport-lan";
import { markPeerSeen } from "./presence";
import type { MeshConnection } from "./transport-interface";
import { Platform } from "react-native";

import {
  MeshHandshakeError,
  MeshTransportError,
  MeshVMCExpiredError,
  MeshVMCRevokedError,
  ShopModeForegroundServiceFailedError,
  ShopModeNotAvailableError,
  emitMeshFailure,
} from "./errors";

// M-BTC-3.4: BLE peripheral/GATT/advertiser + the BLE→wifi upgrade path are
// RETIRED. The proximity transports are now Bluetooth Classic RFCOMM
// (btc-steady.ts, transport-btc.ts) for first-contact + steady sync, and
// mDNS/LAN (discovery-router → discovery-lan, transport-lan) as the steady
// same-network transport. transport-ble.ts + discovery-ble.ts were deleted;
// wifi-upgrade.ts is dead (the upgrade only ran over BLE).

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
  // BLE retired (M-BTC-3.4) — mDNS/LAN is the only router-driven discovery now.
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
  /** Last matched LAN peer per (installIdShort:vaultId), so a local write can
   *  immediately re-dial it (push) instead of waiting for the next mDNS emit —
   *  LAN previously had NO push-on-write at all (the dominant latency source). */
  lanPeerCache: Map<string, { routed: RoutedPeer; vaultId: string }>;
  /** Unsubscribe from the ledger-applied emitter (the LAN push trigger). */
  unsubLanLedger: (() => void) | null;
  /** Debounce timer for the LAN push re-dial. */
  lanKickTimer: ReturnType<typeof setTimeout> | null;
  /** Vaults edited within the current debounce window — so a burst across
   *  MULTIPLE vaults pushes ALL of them, not just the first. */
  lanKickVaults: Set<string>;
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
  lanPeerCache: new Map(),
  unsubLanLedger: null,
  lanKickTimer: null,
  lanKickVaults: new Set(),
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
 * BUG-A: Tell mesh that the local vault set has changed (pair-join, vault
 * create, archive, restore, epoch-bump). Without this, startShopMode reads the
 * anchored-vault set ONCE and a just-joined vault never gets a steady channel —
 * the UI shows it as active but sync stays dark until the user power-cycles
 * Nearby sync. That frozen-set bug confused users into thinking pair succeeded
 * but sync was broken.
 *
 * No-op when mesh is not running (state.running === false). When running, it
 * rebuilds the hash index and restarts the BTC steady channel with the new
 * anchored-vault set (idempotent). Safe to call from a SQLite transaction's
 * commit callback or from React effects.
 */
export async function notifyVaultSetChanged(): Promise<void> {
  if (!state.running) return;
  try {
    await rebuildVaultHashIndex();
  } catch (err) {
    console.warn("[mesh.notifyVaultSetChanged] rebuildVaultHashIndex failed", err);
    // continue — peripheral refresh is still useful
  }
  // M-BTC-3.4: refresh the steady BTC channel so a just-joined/created vault is
  // synced without a full Shop Mode power-cycle. startBtcSteadySync is idempotent
  // — it restarts with the new anchored-vault set.
  try {
    const db = await getDb();
    const anchored = await db.getAllAsync<{ id: string }>(
      `SELECT id FROM vaults WHERE archived_at IS NULL AND vault_trust_anchor_pubkey IS NOT NULL`,
    );
    const { startBtcSteadySync } = await import("./btc-steady");
    await startBtcSteadySync({ vaultIds: anchored.map((v) => v.id) });
  } catch (err) {
    console.warn("[mesh.notifyVaultSetChanged] steady-channel refresh failed", err);
  }
  // Refresh LAN discovery so a new vault is advertised + matched (discovery-lan
  // freezes its TXT digests + scan index at start — the BUG-A frozen-set trap).
  // A DEBOUNCED full restart re-snapshots cleanly: an in-place unpublish+publish
  // races Android NSD's ASYNC unregister (re-registering under the same name
  // before the old tears down silently fails or mangles the name, leaving stale
  // TXT advertised forever). Debounced so a burst of vault changes is ONE restart
  // (not a resolve storm). The onPeerFound listener survives the router restart.
  if (lanRestartTimer) clearTimeout(lanRestartTimer);
  lanRestartTimer = setTimeout(() => {
    lanRestartTimer = null;
    void (async () => {
      if (!state.running || !state.listenPort) return;
      try {
        await routerStopDiscovery();
        await routerStartDiscovery({ listenPort: state.listenPort });
        console.log("[mesh.notifyVaultSetChanged] LAN discovery restarted for new vault set");
      } catch (err) {
        console.warn("[mesh.notifyVaultSetChanged] LAN restart failed", err);
      }
    })();
  }, LAN_RESTART_DEBOUNCE_MS);
}

// Debounce window for the LAN-discovery restart on a vault-set change. Coalesces
// a burst (e.g. create-then-activate, or rapid pairs) into a single clean
// restart instead of churning Android NSD.
const LAN_RESTART_DEBOUNCE_MS = 1500;
let lanRestartTimer: ReturnType<typeof setTimeout> | null = null;

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

  // M-BTC-3.3: steady-state Bluetooth Classic sync. Re-syncs ALREADY-PAIRED
  // peers (MAC cached at pair time) on a stable per-vault RFCOMM UUID, every
  // ~30s, with no QR re-scan and no classic inquiry. Android-only; the module
  // no-ops elsewhere. Non-fatal: a failure here must not abort shop mode.
  try {
    const anchoredVaults = await db.getAllAsync<{ id: string }>(
      `SELECT id FROM vaults
        WHERE archived_at IS NULL AND vault_trust_anchor_pubkey IS NOT NULL`,
    );
    const { startBtcSteadySync } = await import("./btc-steady");
    await startBtcSteadySync({ vaultIds: anchoredVaults.map((v) => v.id) });
    console.log("[mesh.start] BTC steady-state sync for", anchoredVaults.length, "vault(s)");
  } catch (err) {
    console.warn("[mesh.start] BTC steady-state start failed (non-fatal)", err);
  }

  // M-BTC-3.4: steady mDNS/LAN discovery (the discovery-router now drives LAN,
  // not BLE). Discovered same-network peers are dialed over TCP in
  // handleRoutedPeer. Incoming LAN dials land on the startLanListener above; the
  // BTC channel (started above) handles Bluetooth. No BLE peripheral/GATT/advert.
  await routerStartDiscovery({ listenPort: port });
  state.unsubscribeDiscovery = onPeerFound((peer) => {
    void handleRoutedPeer(peer, currentGen);
  });

  // LAN PUSH-ON-WRITE: previously LAN had NO push — an edit only synced when
  // mDNS happened to re-emit the peer (seconds to minutes, or never). Now a
  // LOCAL write immediately re-dials the cached LAN peer(s) for that vault
  // (debounced; deduped by the inflight gate). Mirrors btc-steady's kick.
  try {
    const { onLedgerApplied } = await import("../ledger-events");
    state.unsubLanLedger = onLedgerApplied((vaultId, origin) => {
      if (origin !== "local") return;
      scheduleLanKick(vaultId, currentGen);
    });
  } catch (err) {
    console.warn("[mesh.start] LAN push subscribe failed (non-fatal)", err);
  }
  console.log("[mesh.start] LAN/mDNS discovery started");

  // Flip running BEFORE the FGS block so notifyVaultSetChanged() + the
  // startShopMode idempotent guard observe "running" during the failure-path FGS
  // retry window (~2.4s) — otherwise a vault-set change there silently no-ops
  // (frozen-set) and a re-entrant start could run startShopModeBody twice. The
  // startShopMode catch resets running on any throw. emitStatusChange still runs
  // AFTER the FGS start, preserving START-before-UPDATE.
  state.running = true;

  // Phase 6: promote to a foreground service for BACKGROUND survival (Doze
  // otherwise kills the radios when the app is backgrounded). The service type
  // (connectedDevice|dataSync) is declared in the manifest.
  //
  // Started before emitStatusChange so the START path runs before MeshController's
  // UPDATE path (a status-change-driven displayNotification).
  //
  // NON-FATAL + RETRIED: a flaky notifee start must not tear down working
  // foreground sync (that was the "sync silently turns off" bug), but we try
  // hard — the persistent notification is what keeps BACKGROUND sync alive, so a
  // transient miss is retried with backoff before degrading to foreground-only.
  // (Note: true persistence across an MIUI process-kill needs a native
  // START_STICKY service — notifee's FGS is START_NOT_STICKY; tracked separately.)
  try {
    const fg = await import("./foreground");
    let ok = await fg.startShopModeForegroundService();
    for (let attempt = 1; !ok && attempt <= 2 && Platform.OS === "android"; attempt++) {
      await new Promise((r) => setTimeout(r, attempt * 800));
      ok = await fg.startShopModeForegroundService();
    }
    console.log("[mesh.start] FGS started=", ok);
    if (!ok && Platform.OS === "android") {
      console.warn(
        "[mesh.start] foreground service did not start after retries — foreground-only sync (background may be unreliable)",
      );
    }
  } catch (err) {
    console.warn("[mesh] foreground service start threw (non-fatal, foreground-only)", err);
  }

  emitStatusChange();
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
  if (lanRestartTimer) {
    clearTimeout(lanRestartTimer);
    lanRestartTimer = null;
  }
  if (state.unsubscribeDiscovery) {
    state.unsubscribeDiscovery();
    state.unsubscribeDiscovery = null;
  }
  if (state.unsubLanLedger) {
    state.unsubLanLedger();
    state.unsubLanLedger = null;
  }
  if (state.lanKickTimer) {
    clearTimeout(state.lanKickTimer);
    state.lanKickTimer = null;
  }
  state.lanKickVaults.clear();
  state.lanPeerCache.clear();
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
  // M-BTC-3.3: stop steady-state Bluetooth Classic sync (listeners + dial loop).
  try {
    const { stopBtcSteadySync } = await import("./btc-steady");
    await stopBtcSteadySync();
  } catch (err) {
    if (__DEV__) console.warn("[mesh] BTC steady-state stop threw, continuing", err);
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
 *
 * `shop_mode_enabled` is the PERSISTED USER INTENT — "the shopkeeper wants
 * offline sync on" — NOT a live mirror of whether the radios are currently up.
 * Only a deliberate user toggle-off (`userInitiated: true`) clears it. Every
 * other caller (component unmount, dev fast-refresh, an internal restart) tears
 * the radios down but LEAVES the intent set, so the mesh auto-resumes on the
 * next launch. Conflating the two is what made the toggle read OFF on every
 * reopen and forced a manual re-enable.
 */
export async function stopShopMode(opts?: { userInitiated?: boolean }): Promise<void> {
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

  // Only a deliberate user toggle-off clears the persisted intent (see the
  // doc comment above). Teardown paths must not, or auto-resume can't fire.
  if (opts?.userInitiated) {
    await setAppMeta(SHOP_MODE_ENABLED_KEY, "0");
  }
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

// Debounce for the LAN push re-dial (coalesce an edit burst into one re-dial of
// the cached peers). Short — the win is pushing promptly, not coalescing hard.
const LAN_KICK_DEBOUNCE_MS = 150;

/** LAN push: on a local write, re-dial the cached LAN peer(s) for the vault so
 *  the edit syncs now instead of waiting for the next mDNS emit. Debounced;
 *  handleRoutedPeer's inflight gate dedups concurrent dials. */
function scheduleLanKick(vaultId: string, gen: number): void {
  // Accumulate every edited vault in the window so a burst across multiple
  // vaults re-dials peers for ALL of them (not just the first) when the timer
  // fires — the shared-timer leading-skip would otherwise drop later vaults.
  state.lanKickVaults.add(vaultId);
  if (state.lanKickTimer) return;
  state.lanKickTimer = setTimeout(() => {
    state.lanKickTimer = null;
    const vaults = state.lanKickVaults;
    state.lanKickVaults = new Set();
    if (gen !== state.generation) return;
    for (const entry of state.lanPeerCache.values()) {
      if (!vaults.has(entry.vaultId)) continue;
      void handleRoutedPeer(entry.routed, state.generation);
    }
  }, LAN_KICK_DEBOUNCE_MS);
}

async function handleRoutedPeer(routed: RoutedPeer, gen: number): Promise<void> {
  if (gen !== state.generation) return;
  const peerInfo = routed.peerInfo;
  // BLE retired (M-BTC-3.4): the router only emits mDNS/LAN peers now.
  if (routed.transport !== "mdns") return;
  if (routed.raw.isSelf) return;

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

  // Remember this LAN peer so a local write can re-dial it immediately (the LAN
  // push path) instead of waiting for the next mDNS emit. Keyed the same as the
  // inflight gate. A stale host just fails the re-dial; mDNS refreshes it.
  state.lanPeerCache.set(`${peerInfo.installIdShort}:${chosenVaultId}`, {
    routed,
    vaultId: chosenVaultId,
  });

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
  const inflightKey = `${peerInfo.installIdShort}:${chosenVaultId}`;
  if (state.inflight.has(inflightKey)) return;
  state.inflight.add(inflightKey);

  try {
    // mDNS discovered a LAN peer (discovery-lan.ts). Dial it over TCP; the
    // handshake/anti-entropy runs identically to BTC (transport-agnostic).
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

// How long an inbound LAN connection waits for the dialer's vault_offer before
// giving up. The dialer sends it immediately, pre-handshake.
const VAULT_OFFER_TIMEOUT_MS = 10_000;

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
    // Announce the vault we're dialing for FIRST, so the inbound peer folds the
    // membership chain against THIS vault. Previously the inbound side had no
    // way to learn the dialer's vault and defaulted to whatever vault it had
    // FOREGROUNDED (getActiveVaultIdSyncMaybe) — when that differed from the
    // shared vault, the verdict was device_not_bound -> spurious "different
    // Kaata" toast AND LAN sync silently failed in BOTH directions (every LAN
    // conn has an inbound side). Plaintext pre-handshake frame (vault_id is not
    // secret — it's in the pair QR).
    try {
      await conn.sendJSON({ vault_offer: vaultId });
    } catch {
      void conn.close();
      return;
    }
  } else {
    // Learn the dialer's intended vault from its offer instead of guessing the
    // foregrounded one. recvJSON resolves a close-sentinel ({__closed}) on drop,
    // which fails the string check below -> clean close.
    let offer: unknown;
    try {
      offer = await conn.recvJSON(VAULT_OFFER_TIMEOUT_MS);
    } catch {
      void conn.close();
      return;
    }
    const offered = (offer as { vault_offer?: unknown } | null)?.vault_offer;
    if (typeof offered !== "string" || offered.length === 0) {
      void conn.close();
      return;
    }
    vaultId = offered;
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

  try {
    // M-BTC-3.4: the BLE→wifi upgrade hook is gone (it only ran over BLE). BTC
    // and LAN are both first-class transports, so there's nothing to upgrade
    // FROM. runAntiEntropy runs identically over every transport.
    const result = await runAntiEntropy(conn, {
      vaultId,
      vaultTrustAnchorPubkey,
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
    markPeerSeen(result.peerDeviceId); // presence: this device is reachable now
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
      // Carry a precise on-device diagnostic (the verdict reason from the error
      // message + which vault we folded against) so a residual failure is
      // self-explaining without adb. e.g. "device_not_bound [vault=ab12]".
      const detail = `${err.message} [vault=${vaultId.slice(0, 8)} ${direction}]`;
      if (err instanceof MeshHandshakeError) {
        emitMeshFailure({ kind: "peer_handshake_failed", reason: err.kind, detail });
      } else if (err instanceof MeshVMCExpiredError) {
        emitMeshFailure({ kind: "peer_handshake_failed", reason: "vmc_invalid", detail });
      } else if (err instanceof MeshVMCRevokedError) {
        emitMeshFailure({ kind: "peer_handshake_failed", reason: "vmc_invalid", detail });
      } else {
        emitMeshFailure({ kind: "peer_handshake_failed", reason: "transport", detail });
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
