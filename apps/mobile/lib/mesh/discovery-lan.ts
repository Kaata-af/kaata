// apps/mobile/lib/mesh/discovery-lan.ts
//
// Sync v2 M3 — LAN discovery via mDNS (react-native-zeroconf). Replaces the
// WebRTC-era discovery.ts for the LAN transport: it advertises the TCP
// listener's port and SALTED DAILY vault digests instead of the dead
// signaling port and the stable unsalted SHA256(vault_id)[0:8] hash. See
// docs/m3-lan-transport.md §4.
//
// WHY SALTED DAILY DIGESTS (the privacy fix):
//   discovery.ts advertised SHA256(vault_id)[0:8] — stable forever, so an
//   outsider who once mapped a digest to a shop could track that shop across
//   LANs and days (a social-graph leak: "the same kaata is here every
//   Tuesday"). vault-digest.ts rotates the tag daily AND keys it on the
//   vault_id itself — the shared secret every member holds and no outsider
//   does. Members compute identical digests for a day (they correlate); an
//   outsider computes none (no linkability); a leaked mapping expires in <24h.
//
// The digest is a DISCOVERY HINT, not access control. A non-member can't
// produce a matching digest, and even if one dials anyway, the anti-entropy
// handshake's membership-proof verification refuses it. Privacy is the
// digest's job; the trust chain is the gate.
//
// Service shape (mDNS):
//   Type:  _kaata-mesh._tcp.local.
//   Name:  random per-process UUID (unlinkable across LANs — NOT install_id).
//   Port:  the TCP listener's OS-assigned port (transport-lan.ts startLanListener).
//   TXT:   h="<digest>,<digest>"   today+tomorrow salted digests, cap 3
//          d="<install_id_short8>" own install_id prefix (revocation cross-ref)
//          pt="<tcp_port>"         redundant-but-explicit TCP port
//          v="3"                   mesh protocol version (M3 LAN)
//
// react-native-zeroconf needs an EAS dev client (no Expo Go). Mesh stays
// dormant in Expo Go because shop_mode_enabled is always off there.

import * as Crypto from "expo-crypto";

import { getDb, getInstallIdSync } from "../db-tx";
import { advertiseDigests, buildScanIndex, dayNumber } from "./vault-digest";

const SERVICE_TYPE = "kaata-mesh";
const SERVICE_PROTOCOL = "tcp";
const SERVICE_DOMAIN = "local.";
// M3 bumps the mesh protocol version to "3": the TXT now carries salted daily
// digests + the TCP port. A v1 (WebRTC-era) peer and a v3 peer don't LAN-sync
// (different transport entirely), so the version gate cleanly partitions them.
const MESH_PROTOCOL_VERSION = "3";
// Cap on advertised digests (today + tomorrow = 2; cap at 3 for headroom).
const MAX_ADVERTISED_DIGESTS = 3;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type LanDiscoveredPeer = {
  installIdShort: string;
  serviceName: string;
  host: string;
  port: number;
  protocolVersion: string;
  matchedVaultIds: string[];
  /** True when zeroconf echoed our own broadcast back (filtered upstream). */
  isSelf: boolean;
};

export type LanDiscoveryHandle = {
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

// any-typed so this module type-checks on platforms where the native binding
// isn't linked (web, Expo Go). start/stop is gated on shop_mode_enabled.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let zc: any = null;
let activeHandle: LanDiscoveryHandle | null = null;
let peerListeners: Set<(peer: LanDiscoveredPeer) => void> = new Set();
let peerLostListeners: Set<(serviceName: string) => void> = new Set();

// Local member-vault ids, snapshotted at startDiscovery. The scan index is
// derived from these per-day (rebuilt lazily on day rollover) so a session
// that runs across midnight keeps matching without a republish.
let localVaultIds: string[] = [];
let scanIndexCache: { day: number; index: Map<string, string> } | null = null;

function currentScanIndex(nowMs: number): Map<string, string> {
  const day = dayNumber(nowMs);
  if (!scanIndexCache || scanIndexCache.day !== day) {
    scanIndexCache = { day, index: buildScanIndex(localVaultIds, nowMs) };
  }
  return scanIndexCache.index;
}

// ---------------------------------------------------------------------------
// Local vault snapshot + outbound TXT
// ---------------------------------------------------------------------------

async function getLocalVaultIds(): Promise<string[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<{ id: string }>(
    `SELECT id FROM vaults WHERE archived_at IS NULL`,
  );
  return rows.map((r) => r.id);
}

function buildTxtRecord(
  vaultIds: string[],
  tcpPort: number,
  nowMs: number,
): Record<string, string> {
  // Advertise today+tomorrow digests for every member vault, capped. With a
  // single vault that's 2 tags; the cap only bites for multi-shop devices,
  // where we round-robin would be ideal — but the realistic case is 1-2
  // vaults, so we just take the first MAX_ADVERTISED_DIGESTS in id order.
  const digests: string[] = [];
  for (const v of vaultIds) {
    for (const d of advertiseDigests(v, nowMs)) {
      if (digests.length >= MAX_ADVERTISED_DIGESTS) break;
      digests.push(d);
    }
    if (digests.length >= MAX_ADVERTISED_DIGESTS) break;
  }
  const installId = getInstallIdSync();
  return {
    v: MESH_PROTOCOL_VERSION,
    d: installId.slice(0, 8),
    h: digests.join(","),
    pt: String(tcpPort),
  };
}

// ---------------------------------------------------------------------------
// Observer registration
// ---------------------------------------------------------------------------

export function onPeerFound(handler: (peer: LanDiscoveredPeer) => void): () => void {
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

export type StartLanDiscoveryOptions = {
  /** The TCP listener's OS-assigned port (transport-lan.ts startLanListener). */
  tcpPort: number;
};

export async function startLanDiscovery(
  opts: StartLanDiscoveryOptions,
): Promise<LanDiscoveryHandle> {
  if (activeHandle) {
    activeHandle.stop();
    activeHandle = null;
  }

  // Lazy require so Expo Go / web don't fail to bundle.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let Zeroconf: any;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    Zeroconf = require("react-native-zeroconf").default;
  } catch (err) {
    console.warn("[mesh-lan] react-native-zeroconf unavailable; discovery disabled", err);
    return { stop: () => {} };
  }

  zc = new Zeroconf();

  localVaultIds = await getLocalVaultIds();
  scanIndexCache = null; // force rebuild on first match with the current day
  const nowMs = Date.now();
  const txt = buildTxtRecord(localVaultIds, opts.tcpPort, nowMs);

  // Random per-process name — a passive observer can't fingerprint this device
  // across networks via the service name. install_id_short still leaks via TXT
  // 'd' (needed for revocation-list cross-referencing), but the name is unlinkable.
  const serviceName = Crypto.randomUUID();

  const onResolved = (raw: RawZeroconfService) => {
    try {
      const name = raw?.name ?? "";
      const isSelf = name === serviceName;
      const host = pickIPv4Address(raw) ?? raw?.host;

      const peerTxt = (raw?.txt ?? {}) as Record<string, string | undefined>;
      const peerVersion = (peerTxt.v ?? "0") as string;
      if (peerVersion !== MESH_PROTOCOL_VERSION) return;

      // Prefer the explicit pt= TXT port; fall back to the resolved service
      // port (they should agree — pt is belt-and-suspenders).
      const txtPort = peerTxt.pt ? parseInt(peerTxt.pt, 10) : NaN;
      const port = Number.isFinite(txtPort) && txtPort > 0 ? txtPort : raw?.port;
      if (!host || !port) return;

      const peerDigests = ((peerTxt.h ?? "") as string).split(",").filter(Boolean);
      const peerInstallShort = (peerTxt.d ?? "") as string;

      const index = currentScanIndex(Date.now());
      const matched: string[] = [];
      for (const d of peerDigests) {
        const vid = index.get(d);
        if (vid && !matched.includes(vid)) matched.push(vid);
      }
      if (matched.length === 0 && !isSelf) return;

      const peer: LanDiscoveredPeer = {
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
          console.warn("[mesh-lan] onPeerFound listener threw", err);
        }
      }
    } catch (err) {
      console.warn("[mesh-lan] zeroconf resolved-handler threw", err);
    }
  };

  const onRemoved = (raw: { name?: string }) => {
    if (!raw?.name || raw.name === serviceName) return;
    for (const listener of peerLostListeners) {
      try {
        listener(raw.name);
      } catch (err) {
        console.warn("[mesh-lan] onPeerLost listener threw", err);
      }
    }
  };

  try {
    zc.on("resolved", onResolved);
    zc.on("remove", onRemoved);
    zc.on("error", (err: unknown) => {
      console.warn("[mesh-lan] zeroconf error", err);
    });
  } catch (err) {
    console.warn("[mesh-lan] failed to register zeroconf listeners", err);
  }

  try {
    zc.publishService(
      SERVICE_TYPE,
      SERVICE_PROTOCOL,
      SERVICE_DOMAIN,
      serviceName,
      opts.tcpPort,
      txt,
    );
  } catch (err) {
    console.warn("[mesh-lan] publishService failed", err);
  }

  try {
    zc.scan(SERVICE_TYPE, SERVICE_PROTOCOL, SERVICE_DOMAIN);
  } catch (err) {
    console.warn("[mesh-lan] zeroconf scan failed", err);
  }

  const handle: LanDiscoveryHandle = {
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
      localVaultIds = [];
      scanIndexCache = null;
    },
  };
  activeHandle = handle;
  return handle;
}

export async function stopLanDiscovery(): Promise<void> {
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
