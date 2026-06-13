// lib/trust/account-id.ts
//
// M4: relocated out of lib/mesh/local-vmc.ts (which is deleted with the VMC
// retirement). `buildLocalAccountId` is load-bearing for the CHAIN path — the
// membership backfill (lib/trust/backfill.ts) and the chain handshake derive a
// local account sentinel from a device pubkey when no real (server) account_id
// exists. Zero VMC dependency — pure base64 of a device Ed25519 pubkey.

function bytesToB64Url(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  // eslint-disable-next-line no-undef
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64ToBytes(b64: string): Uint8Array {
  const std = b64.replace(/-/g, "+").replace(/_/g, "/");
  const padded = std + "=".repeat((4 - (std.length % 4)) % 4);
  // eslint-disable-next-line no-undef
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i) & 0xff;
  return out;
}

/**
 * Derive the deterministic "local:" account sentinel for a device that has no
 * server account_id (local-only / pre-sign-in). `local:<first 16 b64url chars
 * of the 32-byte device pubkey>`. Stable for a given device key.
 */
export function buildLocalAccountId(devicePubkey: Uint8Array | string): string {
  const bytes = typeof devicePubkey === "string" ? b64ToBytes(devicePubkey) : devicePubkey;
  if (bytes.length !== 32) {
    throw new Error(`buildLocalAccountId: device pubkey must be 32 bytes (got ${bytes.length})`);
  }
  return "local:" + bytesToB64Url(bytes).slice(0, 16);
}
