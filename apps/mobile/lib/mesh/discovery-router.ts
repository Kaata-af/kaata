// apps/mobile/lib/mesh/discovery-router.ts
//
// Phase 6: Discovery transport router.
//
// Phase 5 had a single mDNS discovery loop. Phase 6 has TWO discovery
// transports:
//   - BLE (primary, always-on while Shop Mode is enabled)
//   - mDNS (opportunistic, only spun up during a wifi-upgrade window)
//
// This module owns the lifecycle of both. The MeshController component
// talks ONLY to discovery-router; it never imports discovery.ts or
// discovery-ble.ts directly. This keeps the upgrade-then-fallback
// state machine in one file.
//
// Modes:
//   - "off"       — Shop Mode disabled. Nothing is running.
//   - "ble"       — Shop Mode on, BLE only. Default steady state.
//   - "ble+mdns"  — Wifi-upgrade window open. Both transports scan/listen.
//                   mDNS is auto-torn-down after UPGRADE_WINDOW_MS so we
//                   don't burn battery once the upgrade decision is made.
//
// State transitions are explicit (start / stop / openUpgradeWindow /
// closeUpgradeWindow). The router NEVER auto-transitions on a timer
// other than the upgrade-window timeout — all other transitions come
// from MeshController in response to user toggles or anti-entropy
// signals.

import type { DiscoveredPeer as MDNSDiscoveredPeer } from "./discovery";
import type { PeerInfo } from "./transport-interface";

// ---- types ---------------------------------------------------------

export type DiscoveryMode = "off" | "ble" | "ble+mdns";

/** BLE-side raw discovery payload — mirrors the BLEDiscoveredPeer shape from discovery-ble. */
export type BLEPeerRaw = {
  kind: "ble";
  /** react-native-ble-plx Device.id (MAC on Android, opaque UUID on iOS). */
  deviceId: string;
  /** RSSI at observation, useful for proximity logging. */
  rssi: number | null;
  /** 4-byte vault hash prefixes the peer advertised (hex-encoded for
   * index lookup). Capped to MAX_ADVERTISED_VAULT_HASHES (3) at the
   * discovery-ble.ts parser to bound the linkability surface. */
  vaultHashes: string[];
  /**
   * Capability flags byte. Bit 0 = supports wifi upgrade. Bits 1-7
   * RESERVED. DO NOT use to leak vault role / owner-role hints; an
   * attacker scanning a market with a $30 sniffer must not be able to
   * distinguish "owner phone" vs "viewer phone" advertisements — that's
   * a targeting signal for theft. Role lives in the VMC and is only
   * exchanged after GATT connect.
   */
  capabilityFlags: number;
  /** Low 8 bits of peer's vault_epoch hint. */
  vaultEpochHint: number;
};

/**
 * Peer event emitted by the router. Wraps the underlying transport's
 * discovery payload with a stable `transport` discriminator so the
 * dial code knows which transport module to invoke.
 */
export type RoutedPeer =
  | {
      transport: "ble";
      peerInfo: PeerInfo;
      raw: BLEPeerRaw;
    }
  | {
      transport: "mdns";
      peerInfo: PeerInfo;
      raw: MDNSDiscoveredPeer;
    };

// ---- constants -----------------------------------------------------

/**
 * How long an opened wifi-upgrade window stays open before the router
 * tears mDNS back down. Both phones need to open their windows roughly
 * concurrently for the discovery to succeed, so this needs slack — but
 * not so much that we run mDNS pointlessly.
 *
 * 10s matches the wifi-upgrade.ts MDNS_DISCOVERY_TIMEOUT_MS.
 */
export const UPGRADE_WINDOW_MS = 10_000;

// ---- module-private state -----------------------------------------

type Listener = (peer: RoutedPeer) => void;

type RouterState = {
  mode: DiscoveryMode;
  listeners: Set<Listener>;
  /** Monotonic counter; bumped on every full start/stop. Late events from a stopped transport are dropped. */
  generation: number;

  // ble lifecycle handles
  bleStop: (() => Promise<void>) | null;

  // mdns lifecycle handles
  mdnsStop: (() => Promise<void>) | null;
  /** Auto-close timer for the upgrade window. */
  upgradeWindowTimer: ReturnType<typeof setTimeout> | null;
};

const state: RouterState = {
  mode: "off",
  listeners: new Set(),
  generation: 0,
  bleStop: null,
  mdnsStop: null,
  upgradeWindowTimer: null,
};

// ---- discovery transport adapters ---------------------------------

/**
 * Dependencies are injected so this module can be unit-tested without
 * the native BLE / mDNS modules loaded. MeshController wires real
 * adapters via `configureDiscoveryRouter()` at startup.
 */
export type RouterAdapters = {
  startBle: (opts: {
    listenPort: number | null;
    onPeerFound: (peer: BLEPeerRaw) => void;
  }) => Promise<() => Promise<void>>;

  startMdns: (opts: {
    listenPort: number;
    onPeerFound: (peer: MDNSDiscoveredPeer) => void;
  }) => Promise<() => Promise<void>>;
};

let adapters: RouterAdapters | null = null;

/**
 * Maps BLE-advertised vault-hash-prefix bytes back to the local
 * vault_id UUID. Populated by MeshController at boot from the local
 * vaults table. Without this, blePeerInfo would forward opaque 4-byte
 * hex strings as matchedVaultIds, and the anti-entropy handshake would
 * refuse to start because the cached VMC is keyed by UUID, not hash.
 *
 * Caller is responsible for re-publishing this map when the local vault
 * set changes (vault create/archive/restore). Empty map = no peer match
 * possible (anti-entropy skips).
 */
let vaultHashIndex: Map<string, string> = new Map();

export function configureDiscoveryRouter(a: RouterAdapters): void {
  adapters = a;
}

/**
 * Re-publish the local vault-hash → vault_id resolution map. Called by
 * MeshController whenever the local vault set changes.
 */
export function publishVaultHashIndex(index: Map<string, string>): void {
  vaultHashIndex = index;
}

// ---- public API ---------------------------------------------------

export function getDiscoveryMode(): DiscoveryMode {
  return state.mode;
}

/**
 * Register a peer listener. Returns an unsubscribe function. Listeners
 * are invoked in registration order; exceptions in one listener never
 * affect the others.
 */
export function onPeerFound(handler: Listener): () => void {
  state.listeners.add(handler);
  return () => state.listeners.delete(handler);
}

/**
 * Transition to "ble" mode. Idempotent — if already running BLE, this
 * is a no-op. If running "ble+mdns", mDNS stays up until its window
 * closes naturally; only the BLE side is verified.
 *
 * `listenPort` is the WebRTC signaling listener port; passed through
 * to BLE so the manufacturer-data payload can advertise it for later
 * wifi upgrade. Pass null if WebRTC listener isn't up yet.
 */
export async function startDiscovery(opts: { listenPort: number | null }): Promise<void> {
  if (!adapters) {
    throw new Error("discovery-router: configureDiscoveryRouter() not called");
  }
  if (state.mode !== "off") return; // idempotent

  const gen = ++state.generation;

  const stopBle = await adapters.startBle({
    listenPort: opts.listenPort,
    onPeerFound: (raw) => {
      if (gen !== state.generation) return; // stale
      emit({
        transport: "ble",
        peerInfo: blePeerInfo(raw),
        raw,
      });
    },
  });

  if (gen !== state.generation) {
    // We were stopped mid-start. Tear down what we just brought up.
    await stopBle().catch(() => {
      /* */
    });
    return;
  }

  state.bleStop = stopBle;
  state.mode = "ble";
}

/**
 * Open a wifi-upgrade window: spin up mDNS alongside BLE for
 * UPGRADE_WINDOW_MS, then automatically close it.
 *
 * Called by MeshController when anti-entropy.ts decides a transfer is
 * large enough to merit prompting the user to upgrade.
 *
 * `listenPort` is required (WebRTC listener must be up by the time we
 * want to upgrade; the caller must start it first).
 *
 * Idempotent: calling this while a window is already open RESTARTS the
 * timer (giving both phones 10s from the most recent open call).
 *
 * Concurrent-call safety: a `openInFlight` flag prevents two concurrent
 * `openUpgradeWindow` calls from both invoking `startMdns` — without
 * this, the second call's `state.mdnsStop` would overwrite the first's
 * and the first's stop handle would leak (fix per engineering critique).
 */
let openUpgradeInFlight: Promise<void> | null = null;

export async function openUpgradeWindow(opts: { listenPort: number }): Promise<void> {
  if (!adapters) {
    throw new Error("discovery-router: configureDiscoveryRouter() not called");
  }
  if (state.mode === "off") {
    // Don't spin up mDNS without BLE; would be a stray scanner.
    return;
  }
  if (openUpgradeInFlight) {
    // Coalesce — return the in-flight promise so the second caller
    // shares the same startMdns invocation rather than racing it.
    return openUpgradeInFlight;
  }

  // Reset the auto-close timer.
  if (state.upgradeWindowTimer) {
    clearTimeout(state.upgradeWindowTimer);
    state.upgradeWindowTimer = null;
  }
  state.upgradeWindowTimer = setTimeout(() => {
    void closeUpgradeWindow();
  }, UPGRADE_WINDOW_MS);

  if (state.mode === "ble+mdns") return; // mDNS already running, timer reset above

  const gen = state.generation; // do NOT bump — we want existing BLE listeners to keep working

  const work = (async () => {
    const stopMdns = await adapters!.startMdns({
      listenPort: opts.listenPort,
      onPeerFound: (raw) => {
        if (gen !== state.generation) return; // stale: full router stop happened
        if (state.mode !== "ble+mdns") return; // window closed already
        emit({
          transport: "mdns",
          peerInfo: mdnsPeerInfo(raw),
          raw,
        });
      },
    });

    // TypeScript can't see that `mode` may have been mutated by stopDiscovery
    // racing with our await above; widen via cast.
    if ((state.mode as DiscoveryMode) === "off" || gen !== state.generation) {
      await stopMdns().catch(() => {
        /* */
      });
      return;
    }

    state.mdnsStop = stopMdns;
    state.mode = "ble+mdns";
  })();

  openUpgradeInFlight = work.finally(() => {
    openUpgradeInFlight = null;
  });
  return openUpgradeInFlight;
}

/**
 * Close the wifi-upgrade window: tear down mDNS, leave BLE running.
 * Idempotent.
 */
export async function closeUpgradeWindow(): Promise<void> {
  if (state.upgradeWindowTimer) {
    clearTimeout(state.upgradeWindowTimer);
    state.upgradeWindowTimer = null;
  }
  if (state.mode !== "ble+mdns") return;

  const stop = state.mdnsStop;
  state.mdnsStop = null;
  state.mode = "ble";

  if (stop) {
    try {
      await stop();
    } catch (err) {
      if (__DEV__) console.warn("[discovery-router] mdns stop failed", err);
    }
  }
}

/**
 * Stop all discovery. Idempotent. Bumps the generation counter, so any
 * in-flight `startDiscovery` or `openUpgradeWindow` resolves into a
 * no-op tear-down.
 */
export async function stopDiscovery(): Promise<void> {
  state.generation++; // invalidates everything in flight

  if (state.upgradeWindowTimer) {
    clearTimeout(state.upgradeWindowTimer);
    state.upgradeWindowTimer = null;
  }

  const mdnsStop = state.mdnsStop;
  const bleStop = state.bleStop;
  state.mdnsStop = null;
  state.bleStop = null;
  state.mode = "off";

  await Promise.all([
    mdnsStop
      ? mdnsStop().catch((e) => {
          if (__DEV__) console.warn("[discovery-router] mdns stop failed", e);
        })
      : Promise.resolve(),
    bleStop
      ? bleStop().catch((e) => {
          if (__DEV__) console.warn("[discovery-router] ble stop failed", e);
        })
      : Promise.resolve(),
  ]);
}

// ---- internals -----------------------------------------------------

function emit(peer: RoutedPeer): void {
  for (const listener of state.listeners) {
    try {
      listener(peer);
    } catch (err) {
      if (__DEV__) console.warn("[discovery-router] listener threw", err);
    }
  }
}

function blePeerInfo(raw: BLEPeerRaw): PeerInfo {
  // BLE peripheral id isn't an install_id; we treat the alphanumerics of
  // the device id as the discovery-time identifier. Anti-entropy replaces
  // this with the real device_id from the VMC after handshake.
  //
  // NOTE: pre-handshake dedup using `installIdShort` is best-effort only;
  // post-handshake dedup keys on the cryptographically-authenticated
  // `remoteDeviceId` in mesh/index.ts. Android randomizes BLE MACs every
  // ~15min by default, so installIdShort will roll over per peer.
  const flat = raw.deviceId.replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
  // Resolve advertised hash prefixes to real vault_ids via the published
  // index. Drop unknowns — without a vault_id we can't look up the
  // cached VMC, so anti-entropy would refuse the handshake anyway.
  const matched: string[] = [];
  for (const h of raw.vaultHashes) {
    const vid = vaultHashIndex.get(h);
    if (vid && !matched.includes(vid)) matched.push(vid);
  }
  return {
    installIdShort: flat.slice(0, 8),
    serviceName: raw.deviceId,
    matchedVaultIds: matched,
    discoveredVia: "ble",
  };
}

function mdnsPeerInfo(raw: MDNSDiscoveredPeer): PeerInfo {
  return {
    installIdShort: raw.installIdShort,
    serviceName: raw.serviceName,
    matchedVaultIds: raw.matchedVaultIds,
    discoveredVia: "mdns",
  };
}
