// apps/mobile/lib/mesh/btc-peers.ts
//
// M-BTC-3.3 — a tiny local store mapping an AUTHENTICATED peer (vault_id +
// device_id, learned from the membership handshake) to its last-seen Bluetooth
// Classic MAC. Written after a successful pair/sync; read by the steady-state
// loop (btc-steady.ts) so it can re-dial a known peer directly via
// connectRfcomm(mac, uuid) and SKIP the ~15s classic inquiry entirely.
//
// Why app_meta (a JSON blob) and not a table: this is unsigned, mutable,
// per-radio transport hint state — NOT membership truth (that lives in the
// signed chain → vault_device_registry). The MAC is only ever written AFTER the
// chain handshake authenticates the peer, so a spoofed discovery-time MAC can
// never land here. Keeping it out of the schema also avoids a migration.

import { getAppMeta, setAppMeta } from "../db";

const KEY = "btc_known_peers";

export type KnownPeer = {
  vaultId: string;
  /** Authenticated device id (BtcMeshConnection.remoteDeviceId post-handshake). */
  deviceId: string;
  /** Bluetooth Classic MAC to dial directly (stable per device, unlike BLE). */
  mac: string;
  lastSeenAt: number;
};

// Classic BT MAC shape "AA:BB:CC:DD:EE:FF". We only ever cache a MAC that came
// from an authenticated session, but some OEMs hand back a placeholder
// (00:00:00:00:00:00) or null for an accepted insecure-RFCOMM socket — never
// overwrite a known-good mapping with one of those.
const MAC_RE = /^([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}$/;
function isDialableMac(mac: string): boolean {
  return MAC_RE.test(mac) && mac !== "00:00:00:00:00:00";
}

function parse(raw: string | null): KnownPeer[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (e): e is KnownPeer =>
        e != null &&
        typeof e === "object" &&
        typeof e.vaultId === "string" &&
        typeof e.deviceId === "string" &&
        typeof e.mac === "string" &&
        typeof e.lastSeenAt === "number",
    );
  } catch {
    return [];
  }
}

// Serialize the read-modify-write over the app_meta JSON blob: getAppMeta and
// setAppMeta each open their own autocommit tx, so concurrent callers (an inbound
// accept session + an outbound dial session finishing in the same tick) would
// lost-update each other. A simple in-process promise chain makes writes atomic.
let writeChain: Promise<void> = Promise.resolve();

/** Upsert (vault_id, device_id) → mac. Skips the write when the MAC is unchanged
 *  (avoids per-tick churn) and ignores non-dialable MACs. */
export async function addKnownPeer(p: {
  vaultId: string;
  deviceId: string;
  mac: string;
}): Promise<void> {
  if (!p.vaultId || !p.deviceId || !p.mac || !isDialableMac(p.mac)) return;
  const run = writeChain.then(async () => {
    const list = parse(await getAppMeta(KEY));
    const existing = list.find((e) => e.vaultId === p.vaultId && e.deviceId === p.deviceId);
    if (existing && existing.mac === p.mac) return; // unchanged — skip the write
    const filtered = list.filter((e) => !(e.vaultId === p.vaultId && e.deviceId === p.deviceId));
    filtered.push({ vaultId: p.vaultId, deviceId: p.deviceId, mac: p.mac, lastSeenAt: Date.now() });
    await setAppMeta(KEY, JSON.stringify(filtered));
  });
  // Keep the chain alive even if one write throws.
  writeChain = run.catch(() => {});
  return run;
}

/** All known peers for a vault (most-recent first). */
export async function listKnownPeers(vaultId: string): Promise<KnownPeer[]> {
  return parse(await getAppMeta(KEY))
    .filter((e) => e.vaultId === vaultId)
    .sort((a, b) => b.lastSeenAt - a.lastSeenAt);
}
