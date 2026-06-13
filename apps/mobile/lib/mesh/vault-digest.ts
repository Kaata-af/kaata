// Salted daily vault digests for mDNS discovery (Sync v2 M3,
// docs/m3-lan-transport.md §4). PURE module — no RN, no SQLite, no static
// crypto shim — so it's exercised directly under bun by
// lib/mesh/__dev__/vault-digest-selftest.ts.
//
// PROBLEM the old scheme had: discovery.ts advertised SHA256(vault_id)[0:8],
// stable forever. An outsider who once learned that a given digest maps to a
// given shop could then track that shop across LANs and across days — a
// social-graph leak (a rival noticing "the same kaata is here every Tuesday").
//
// FIX: rotate the advertised tag daily AND key it on the vault_id itself.
//   digest(vault, day) = HMAC-SHA256(key = vault_id_bytes, msg = "kaata-mesh-day:" + day)[0:8]
// The vault_id is the shared secret: every member of the vault holds it, no
// outsider does. So all members compute identical digests for a given day
// (they can correlate), while an outsider can compute none (no linkability,
// no tracking). The tag changes every UTC day, so even a leaked mapping
// expires in <24h.

import { hmac } from "@noble/hashes/hmac";
import { sha256 } from "@noble/hashes/sha2";

const DOMAIN = "kaata-mesh-day:";
const DIGEST_BYTES = 8;
export const MS_PER_DAY = 86_400_000;

/** UTC day number for a wall-clock ms. Both peers must agree on this; a ±1
 *  day window (see currentAdvertiseDays / acceptableScanDays) absorbs the
 *  midnight rollover and realistic clock skew. */
export function dayNumber(nowMs: number): number {
  return Math.floor(nowMs / MS_PER_DAY);
}

function toBase64Url(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  // btoa exists in Hermes and in bun; standard base64 then url-safe-ize and
  // strip padding (TXT records are length-sensitive).
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** The 8-byte daily digest for (vault_id, day), base64url (11 chars). */
export function vaultDigest(vaultId: string, day: number): string {
  const key = new TextEncoder().encode(vaultId);
  const msg = new TextEncoder().encode(DOMAIN + String(day));
  const mac = hmac(sha256, key, msg);
  return toBase64Url(mac.slice(0, DIGEST_BYTES));
}

/** Days a publisher advertises: today + tomorrow, so a peer that has already
 *  rolled past midnight (or runs slightly ahead) still finds us. */
export function advertiseDays(nowMs: number): number[] {
  const d = dayNumber(nowMs);
  return [d, d + 1];
}

/** Days a scanner will accept a match against: yesterday, today, tomorrow —
 *  the union that covers either side being up to a day off. */
export function acceptableScanDays(nowMs: number): number[] {
  const d = dayNumber(nowMs);
  return [d - 1, d, d + 1];
}

/** Digests this device advertises for one vault (today + tomorrow). */
export function advertiseDigests(vaultId: string, nowMs: number): string[] {
  return advertiseDays(nowMs).map((day) => vaultDigest(vaultId, day));
}

/** The set of digests a scanner treats as "could be one of my vaults" for a
 *  single vault, across the ±1-day window. A resolved peer's advertised
 *  digests are intersected with the union of these across all member vaults. */
export function scanDigests(vaultId: string, nowMs: number): string[] {
  return acceptableScanDays(nowMs).map((day) => vaultDigest(vaultId, day));
}

/** Build digest → vault_id lookup for scanning. Maps every acceptable-day
 *  digest of every member vault to its vault_id; a resolved peer's `h=` tags
 *  are looked up here. Last-writer-wins on the (astronomically unlikely)
 *  8-byte collision is fine — the handshake's membership proof is the real
 *  gate, the digest is only a discovery hint. */
export function buildScanIndex(vaultIds: string[], nowMs: number): Map<string, string> {
  const index = new Map<string, string>();
  for (const vaultId of vaultIds) {
    for (const digest of scanDigests(vaultId, nowMs)) {
      index.set(digest, vaultId);
    }
  }
  return index;
}
