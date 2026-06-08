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
import { getCachedVMC } from "./vmc";
import {
  configureDiscoveryRouter,
  onPeerFound,
  publishVaultHashIndex,
  startDiscovery as routerStartDiscovery,
  stopDiscovery as routerStopDiscovery,
  type RoutedPeer,
} from "./discovery-router";
import {
  startDiscovery as mdnsStartDiscovery,
  stopDiscovery as mdnsStopDiscovery,
  vaultHashTag,
  type DiscoveredPeer as MdnsDiscoveredPeer,
} from "./discovery";
import { startBle } from "./discovery-ble";
import { startTransportListener, stopTransportListener } from "./transport";
import type { MeshConnection } from "./transport-interface";
import { dialPeerScheduled, reset as resetDialScheduler } from "./scheduler";
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
} from "./errors";

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
    // Wrap the Phase 5 mDNS module's startDiscovery() in the
    // RouterAdapters shape (a single function that resolves to a stop
    // function). Adapter holds the listener subscription so stop() can
    // tear it down idempotently.
    const unsub = onPeerFoundMdns(opts.onPeerFound);
    await mdnsStartDiscovery({ listenPort: opts.listenPort });
    return async () => {
      unsub();
      await mdnsStopDiscovery();
    };
  },
});

// Forward mDNS peer events into the router's adapter callback. Phase 5's
// onPeerFound in discovery.ts is a global emitter — multiple listeners are
// fine, the router just adds one more.
function onPeerFoundMdns(handler: (peer: MdnsDiscoveredPeer) => void): () => void {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { onPeerFound } = require("./discovery") as typeof import("./discovery");
  return onPeerFound(handler);
}

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
  /** Post-handshake connections (key = `${remoteDeviceId}:${vaultId}`). */
  connections: Map<string, MeshConnection>;
  /** Pre-handshake in-flight installIdShorts (so we don't dial twice). */
  inflight: Set<string>;
  unsubscribeDiscovery: (() => void) | null;
  listenPort: number;
};

const state: RunState = {
  running: false,
  generation: 0,
  connections: new Map(),
  inflight: new Set(),
  unsubscribeDiscovery: null,
  listenPort: 0,
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
    activePeers: state.connections.size,
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
 * Phase 7 self-VMC lazy re-issuance.
 *
 * Local-anchored vaults need a self-VMC cached at (vault_id, this_device_id)
 * for the handshake to advertise a credential. Normally createSelfProfile
 * (onboarding) and vault/new.tsx (Add a Kaata) mint it at vault-creation
 * time — but those issuance calls are best-effort and can fail without
 * rolling back the vault row. In that case the vault sits in a "trust
 * anchor present but no usable self-VMC" state: startShopMode's eligibility
 * gate accepts it, but actual peer handshake fails because we have nothing
 * to send.
 *
 * This sweep runs at the top of startShopMode(). For every local-anchored
 * vault whose anchor is THIS device's pubkey and which is missing a
 * non-expired cached VMC for this device_id, mint one. Each per-vault
 * issuance is independently best-effort — a failure on one vault must not
 * block mesh startup for the others.
 */
async function reissueSelfVMCsIfMissing(): Promise<void> {
  try {
    const db = await getDb();
    const ownPubkey = getDevicePubkey();
    if (!ownPubkey) return; // ensureDeviceKey hasn't completed yet — caller awaits separately

    // Local-anchored vaults where THIS device is the anchor.
    const rows = await db.getAllAsync<{
      id: string;
      vault_epoch: number | null;
      account_id: string | null;
    }>(
      `SELECT id, vault_epoch, account_id
         FROM vaults
        WHERE archived_at IS NULL
          AND vault_trust_anchor_pubkey IS NOT NULL
          AND vault_trust_anchor_pubkey = ?`,
      ownPubkey,
    );
    if (rows.length === 0) return;

    // Lazy-import the mesh modules to avoid pulling them into the bundle
    // before startShopMode is invoked.
    const dbTx = await import("../db-tx");
    const installId = dbTx.getInstallIdSync();
    const accountId = dbTx.getAccountIdSync();
    const [{ cacheVMC }, { buildLocalAccountId, issueLocalVMC }] = await Promise.all([
      import("./vmc"),
      import("./local-vmc"),
    ]);

    const nowMs = Date.now();
    for (const row of rows) {
      try {
        // Skip if a non-expired self-VMC already exists for THIS device_id.
        // cacheVMC's storage is keyed by (vault_id, device_id) — for our
        // own self-VMC the device_id is the local install_id. Direct DB
        // probe (not getCachedVMC) so we can scope by device_id without
        // refactoring the public helper signature.
        const existing = await db.getFirstAsync<{ expires_at: number }>(
          `SELECT expires_at
             FROM vault_credentials
            WHERE vault_id = ? AND device_id = ?`,
          row.id,
          installId,
        );
        if (existing && existing.expires_at > nowMs) continue;

        const selfAccountId = accountId ?? buildLocalAccountId(ownPubkey);
        const { blob, expiresAtMs } = await issueLocalVMC({
          vaultId: row.id,
          peerAccountId: selfAccountId,
          peerDeviceId: installId,
          peerDevicePubkey: ownPubkey,
          role: "owner",
          vaultEpoch: row.vault_epoch ?? 0,
        });
        await cacheVMC(row.id, blob, expiresAtMs, selfAccountId, ownPubkey, row.vault_epoch ?? 0);
      } catch (err) {
        if (__DEV__) console.warn(`[mesh] reissueSelfVMCsIfMissing: vault ${row.id} failed`, err);
      }
    }
  } catch (err) {
    if (__DEV__) console.warn("[mesh] reissueSelfVMCsIfMissing swept", err);
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
  if (state.running) return;

  const db = await getDb();
  // Match either:
  //   - local-CA vaults: vault_trust_anchor_pubkey populated, OR
  //   - server-anchored vaults: we hold a non-expired cached VMC.
  // We treat either as "at least one mesh-eligible vault on this device".
  const eligible = await db.getFirstAsync<{ id: string }>(
    `SELECT v.id AS id
       FROM vaults v
      WHERE v.archived_at IS NULL
        AND (
          v.vault_trust_anchor_pubkey IS NOT NULL
          OR EXISTS (
            SELECT 1 FROM vault_credentials vc
             WHERE vc.vault_id = v.id
               AND vc.expires_at > ?
          )
        )
      LIMIT 1`,
    Date.now(),
  );
  if (!eligible) {
    throw new ShopModeNotAvailableError("Create or join a Kaata first");
  }

  await setAppMeta(SHOP_MODE_ENABLED_KEY, "1");

  await ensureDeviceKey();

  // Phase 7: lazy re-issue self-VMC for any local-anchored vault that's
  // missing one (e.g. createSelfProfile's best-effort issuance failed at
  // onboarding time, or the cache was wiped). Must come AFTER
  // ensureDeviceKey so getDevicePubkey() returns the cached value. Each
  // per-vault failure is logged and skipped; we never block startShopMode
  // on this — the eligibility gate above already proved at least one
  // vault is mesh-viable.
  await reissueSelfVMCsIfMissing();

  // Bump generation so a previous-generation in-flight handshake's
  // commit-to-map step sees the change and abandons.
  state.generation++;
  const currentGen = state.generation;

  // Refresh the vault-hash index so BLE peer events can resolve to
  // local vault_id UUIDs.
  await rebuildVaultHashIndex();

  // Start transport listener first so discovery has a real port to
  // advertise.
  const { port } = await startTransportListener({
    onIncomingConnection: (conn) => {
      void handlePeerConnection(conn, "incoming", currentGen);
    },
  });
  state.listenPort = port;

  // Phase 6: route through discovery-router, which owns BOTH BLE and
  // mDNS lifecycles. Pre-router we imported from `./discovery` directly
  // — that path is now retired here (still imported below as the
  // adapter implementation).
  await routerStartDiscovery({ listenPort: port });
  state.unsubscribeDiscovery = onPeerFound((peer) => {
    void handleRoutedPeer(peer, currentGen);
  });

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
}

/**
 * Turn shop mode off. Idempotent.
 */
export async function stopShopMode(): Promise<void> {
  state.generation++;
  state.running = false;
  emitStatusChange();
  try {
    const fg = await import("./foreground");
    await fg.stopShopModeForegroundService();
  } catch (err) {
    if (__DEV__) console.warn("[mesh] foreground service stop failed", err);
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
  try {
    await stopTransportListener();
  } catch (err) {
    console.warn("[mesh] stopTransportListener threw, continuing", err);
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
  state.listenPort = 0;
  resetDialScheduler();

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

  // Pre-handshake dedup (best-effort) using the discovery-time short id.
  // Post-handshake we re-key on the authenticated remoteDeviceId.
  const inflightKey = `${peerInfo.installIdShort}:${chosenVaultId}`;
  if (state.inflight.has(inflightKey)) return;
  state.inflight.add(inflightKey);

  try {
    if (routed.transport === "mdns") {
      const raw = routed.raw;
      const conn = await dialPeerScheduled(raw.serviceName, {
        host: raw.host,
        port: raw.port,
        serviceName: raw.serviceName,
      });
      await handlePeerConnection(conn, "outgoing", gen, {
        vaultId: chosenVaultId,
        vmcBlob: cachedBlob,
        installIdShort: peerInfo.installIdShort,
      });
    } else {
      // BLE transport — the actual dial is PERIPHERAL_TODO. transport-ble.ts
      // ships the scaffold; until central+peripheral are both wired, we
      // skip the BLE dial here. No-op keeps the router contract intact.
      if (__DEV__) {
        console.warn(
          "[mesh] BLE peer discovered but dial path not yet implemented",
          peerInfo.installIdShort,
        );
      }
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
  vmcBlob: string;
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
  let cachedBlob: string;
  if (ctx) {
    vaultId = ctx.vaultId;
    cachedBlob = ctx.vmcBlob;
  } else {
    const activeVaultId = getActiveVaultIdSyncMaybe();
    if (!activeVaultId) {
      void conn.close();
      return;
    }
    const cached = await getCachedVMC(activeVaultId);
    if (!cached) {
      void conn.close();
      return;
    }
    vaultId = activeVaultId;
    cachedBlob = cached.blob;
  }

  // Determine our own device_id (Ed25519 pubkey, base64) for the
  // wifi-upgrade race-resolver. Fall back to install_id-short if unset.
  const ownDeviceId = getDevicePubkey() ?? "";

  // Phase 7 Part B: look up the per-vault trust anchor. Non-null →
  // local-CA mode (peer VMC must be signed by the owner's device key,
  // iss=kaata-mesh-local-v1). Null → server-anchored mode (Phase 5
  // back-compat). Either way, the lookup is cheap (one indexed read)
  // and idempotent.
  const vaultTrustAnchorPubkey = await loadVaultTrustAnchor(vaultId);

  try {
    const result = await runAntiEntropy(conn, {
      localVMCBlob: cachedBlob,
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
    // Post-handshake dedup on the cryptographically authenticated
    // device_id. If a same-(device, vault) connection already exists,
    // close the duplicate and keep the established one.
    const key = makeConnKey(result.peerDeviceId, vaultId);
    if (state.connections.has(key)) {
      void conn.close();
      return;
    }
    state.connections.set(key, conn);
    emitStatusChange();
    await touchLastActive();
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
    } else {
      console.warn("[mesh] unexpected handshake/anti-entropy error", err);
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
  applyVMCCheckInResponse,
  collectRenewalsForCheckIn,
  getLastRevocationSeenAtMs,
} from "./vmc";

export {
  MeshHandshakeError,
  MeshVMCExpiredError,
  MeshVMCRevokedError,
  MeshTransportError,
  ShopModeForegroundServiceFailedError,
  ShopModeNotAvailableError,
} from "./errors";

export { setWifiUpgradePromptBridge, setWifiUpgradeToastBridge } from "./wifi-upgrade";
