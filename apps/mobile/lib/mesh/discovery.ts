// apps/mobile/lib/mesh/discovery.ts
//
// Phase 5 mesh discovery via mDNS (react-native-zeroconf).
//
// PRIVACY POSTURE (per founder decision: no application-layer encryption):
//   We broadcast a short (8-byte url-safe-base64) UNSALTED hash of every
//   vault we are a member of via the mDNS TXT record. This LEAKS a short
//   vault_id prefix to anyone on the same wifi. This is acceptable because:
//     (a) Discovery only runs while shop_mode_enabled = 1 (opt-in).
//     (b) The broadcast is local-link only (mDNS does not cross subnets).
//     (c) An 8-byte hash gives ~2^32 collision resistance — enough to
//         filter peers but not enough to map back to vault_id.
//     (d) Transport DTLS (WebRTC) plus the VMC handshake authenticates the
//         peer; an attacker who guesses the hash cannot impersonate.
//
//   ARCHITECTURAL NOTE on "salted hash" alternative: a per-device salt
//   would protect privacy but breaks rendezvous — peer B can't derive the
//   same tag for vault V as peer A. The `mesh_per_device_salt` app_meta
//   key is reserved for a future server-mediated rendezvous design.
//
// Service shape:
//   Type:  _kaata-mesh._tcp.local.
//   Name:  random per-process UUID. Not derived from install_id so a
//          passive sniffer can't cross-correlate this device across
//          different LANs (home / bazaar / friend's wifi).
//   Port:  the WebRTC signaling listener port (transport.ts)
//   TXT:   h="<base64-8>,<base64-8>,..."  (vault hashes)
//          d="<install_id_short8>"        (own install_id, first 8 chars,
//                                          shared so peers can map a
//                                          revocation list entry's full
//                                          install_id back to a TXT
//                                          broadcast)
//          v="1"                          (mesh protocol version)
//
// react-native-zeroconf does NOT ship Expo Go support — needs an EAS dev
// client. Mesh stays dormant in Expo Go because shop_mode_enabled is
// always off there.

import * as Crypto from "expo-crypto";

import { getDb } from "../db-tx";
import { getInstallIdSync } from "../db-tx";

const SERVICE_TYPE = "kaata-mesh";
const SERVICE_PROTOCOL = "tcp";
const SERVICE_DOMAIN = "local.";
const MESH_PROTOCOL_VERSION = "1";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DiscoveredPeer = {
  installIdShort: string;
  serviceName: string;
  host: string;
  port: number;
  protocolVersion: string;
  matchedVaultIds: string[];
  // True when zeroconf echoed our own broadcast back. Always filtered out
  // by handleDiscoveredPeer but exposed in case a higher layer wants the
  // signal (e.g., "discovery is actually running").
  isSelf: boolean;
};

export type DiscoveryHandle = {
  stop: () => void;
};

type RawZeroconfService = {
  name?: string;
  host?: string;
  port?: number;
  addresses?: string[];
  txt?: Record<string, string | undefined> | null;
};

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

// We accept any-typed zeroconf so this module type-checks even on
// platforms where the native binding isn't linked (web, Expo Go). The
// MeshController gates start/stop on shop_mode_enabled which can only be
// true in a dev-client build.
let zc: any = null;
let activeHandle: DiscoveryHandle | null = null;
let cachedVaultHashIndex: Map<string, string> = new Map();
let peerListeners: Set<(peer: DiscoveredPeer) => void> = new Set();
let peerLostListeners: Set<(serviceName: string) => void> = new Set();

// ---------------------------------------------------------------------------
// Hash helpers (8-byte url-safe-base64 of sha256(vault_id))
// ---------------------------------------------------------------------------

export async function vaultHashTag(vaultId: string): Promise<string> {
  const digest = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, vaultId, {
    encoding: Crypto.CryptoEncoding.HEX,
  });
  const eightBytesHex = digest.slice(0, 16);
  return hexToBase64Url(eightBytesHex);
}

function hexToBase64Url(hex: string): string {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  // eslint-disable-next-line no-undef
  const b64 = btoa(bin);
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// ---------------------------------------------------------------------------
// Build outbound TXT record
// ---------------------------------------------------------------------------

async function getLocalVaultIds(): Promise<string[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<{ id: string }>(
    `SELECT id FROM vaults WHERE archived_at IS NULL`,
  );
  return rows.map((r) => r.id);
}

async function buildTxtRecord(): Promise<{
  txt: Record<string, string>;
  hashIndex: Map<string, string>;
}> {
  const vaultIds = await getLocalVaultIds();
  const hashes: string[] = [];
  const index = new Map<string, string>();
  for (const v of vaultIds) {
    const h = await vaultHashTag(v);
    hashes.push(h);
    index.set(h, v);
  }
  const installId = getInstallIdSync();
  const txt: Record<string, string> = {
    v: MESH_PROTOCOL_VERSION,
    d: installId.slice(0, 8),
    h: hashes.join(","),
  };
  return { txt, hashIndex: index };
}

// ---------------------------------------------------------------------------
// Public observer registration
// ---------------------------------------------------------------------------

export function onPeerFound(handler: (peer: DiscoveredPeer) => void): () => void {
  peerListeners.add(handler);
  return () => peerListeners.delete(handler);
}

export function onPeerLost(handler: (serviceName: string) => void): () => void {
  peerLostListeners.add(handler);
  return () => peerLostListeners.delete(handler);
}

// ---------------------------------------------------------------------------
// startDiscovery / stopDiscovery
// ---------------------------------------------------------------------------

// listenPort is the WebRTC signaling listener's bound port. discovery.ts
// just advertises it; transport.ts owns the actual socket.
export type StartDiscoveryOptions = {
  listenPort: number;
};

export async function startDiscovery(
  opts: StartDiscoveryOptions = { listenPort: 0 },
): Promise<DiscoveryHandle> {
  if (activeHandle) {
    activeHandle.stop();
    activeHandle = null;
  }

  // Lazy require so platforms without the native module (Expo Go, web)
  // don't fail to bundle. shop_mode_enabled is always false in those
  // environments anyway.
  // NOTE (2026-07-26): react-native-zeroconf was REMOVED from package.json —
  // its rx2dnssd dependency bundled 4KB-aligned libjdns_sd*.so prebuilts,
  // the only libs failing Google Play's 16KB-page-size requirement. This
  // require() already degrades gracefully when the package is absent (the
  // Expo Go path below), and the mesh is parked anyway. To revive LAN
  // discovery: re-add the package ONLY after verifying its native libs are
  // 16KB-aligned (llvm-readelf -l: every PT_LOAD p_align >= 0x4000), or
  // switch to an NsdManager-based module.
  let Zeroconf: any;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    Zeroconf = require("react-native-zeroconf").default;
  } catch (err) {
    console.warn("[mesh] react-native-zeroconf unavailable; discovery disabled", err);
    return { stop: () => {} };
  }

  zc = new Zeroconf();

  const { txt, hashIndex } = await buildTxtRecord();
  cachedVaultHashIndex = hashIndex;

  // Random per-process name so a passive observer cannot fingerprint this
  // device across networks via the mDNS service name. install_id_short
  // still leaks via the TXT 'd' field (rendezvous needs it for revocation-
  // list cross-referencing), but the name itself is unlinkable.
  const serviceName = Crypto.randomUUID();

  const onResolved = (raw: RawZeroconfService) => {
    try {
      const name = raw?.name ?? "";
      const isSelf = name === serviceName;
      const host = pickIPv4Address(raw) ?? raw?.host;
      const port = raw?.port;
      if (!host || !port) return;

      const peerTxt = (raw?.txt ?? {}) as Record<string, string | undefined>;
      const peerHashes = ((peerTxt.h ?? "") as string).split(",").filter(Boolean);
      const peerVersion = (peerTxt.v ?? "0") as string;
      const peerInstallShort = (peerTxt.d ?? "") as string;

      if (peerVersion !== MESH_PROTOCOL_VERSION) return;
      const matched: string[] = [];
      for (const h of peerHashes) {
        const vid = cachedVaultHashIndex.get(h);
        if (vid) matched.push(vid);
      }
      if (matched.length === 0 && !isSelf) return;

      const peer: DiscoveredPeer = {
        installIdShort: peerInstallShort,
        serviceName: name,
        host,
        port,
        protocolVersion: peerVersion,
        matchedVaultIds: matched,
        isSelf,
      };
      for (const listener of peerListeners) {
        try {
          listener(peer);
        } catch (err) {
          console.warn("[mesh] onPeerFound listener threw", err);
        }
      }
    } catch (err) {
      console.warn("[mesh] zeroconf resolved-handler threw", err);
    }
  };

  const onRemoved = (raw: { name?: string }) => {
    if (!raw?.name || raw.name === serviceName) return;
    for (const listener of peerLostListeners) {
      try {
        listener(raw.name);
      } catch (err) {
        console.warn("[mesh] onPeerLost listener threw", err);
      }
    }
  };

  try {
    zc.on("resolved", onResolved);
    zc.on("remove", onRemoved);
    zc.on("error", (err: unknown) => {
      console.warn("[mesh] zeroconf error", err);
    });
  } catch (err) {
    console.warn("[mesh] failed to register zeroconf listeners", err);
  }

  // Publish own service.
  try {
    zc.publishService(
      SERVICE_TYPE,
      SERVICE_PROTOCOL,
      SERVICE_DOMAIN,
      serviceName,
      opts.listenPort,
      txt,
    );
  } catch (err) {
    console.warn("[mesh] publishService failed", err);
  }

  // Start browsing.
  try {
    zc.scan(SERVICE_TYPE, SERVICE_PROTOCOL, SERVICE_DOMAIN);
  } catch (err) {
    console.warn("[mesh] zeroconf scan failed", err);
  }

  const handle: DiscoveryHandle = {
    stop: () => {
      if (!zc) return;
      try {
        zc.unpublishService(serviceName);
      } catch {
        /* best-effort */
      }
      try {
        zc.stop();
      } catch {
        /* best-effort */
      }
      try {
        zc.removeAllListeners();
      } catch {
        /* best-effort */
      }
      zc = null;
      activeHandle = null;
      cachedVaultHashIndex = new Map();
    },
  };
  activeHandle = handle;
  return handle;
}

export async function stopDiscovery(): Promise<void> {
  if (activeHandle) {
    activeHandle.stop();
    activeHandle = null;
  }
}

function pickIPv4Address(raw: RawZeroconfService): string | null {
  if (!raw?.addresses || raw.addresses.length === 0) return null;
  const v4 = raw.addresses.find((a) => !a.includes(":"));
  return v4 ?? raw.addresses[0];
}
