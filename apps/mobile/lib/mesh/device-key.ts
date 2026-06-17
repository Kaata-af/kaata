// apps/mobile/lib/mesh/device-key.ts
//
// Phase 5: per-device Ed25519 identity for mesh sync.
//
// Each install owns ONE Ed25519 keypair that uniquely identifies the
// physical device in the mesh. The private key lives in expo-secure-store
// (Android Keystore / iOS Keychain — hardware-backed where available); the
// public key is mirrored into app_meta for fast synchronous reads (no
// SecureStore round-trip on every event signature header).
//
// Lifecycle:
//   - First call to ensureDeviceKey() on a fresh install generates the
//     keypair, persists both halves, and registers the public half with
//     the backend so other peers can verify our signatures.
//   - Subsequent calls are idempotent: read pubkey from app_meta, no
//     SecureStore I/O on the warm path.
//   - signWithDeviceKey() hits SecureStore once, caches the private key in
//     module-local memory for the rest of the process lifetime, and signs
//     thereafter. The cache is intentionally NOT persisted — process restart
//     forces a fresh SecureStore read, which re-validates that the user can
//     still unlock the keystore.
//
// The backend's /v1/devices/register-key endpoint UPSERTs by install_id,
// so re-registration on every sign-in (defensive) is a free no-op once
// the row exists.

// @noble/ed25519 v2 Hermes shims — INLINED at the top of this module
// because vault/new.tsx imports device-key.ts directly (not via the mesh
// barrel) and Metro HMR doesn't reliably pick up side-effect-only modules.
// Both shims are idempotent — re-importing this file just reassigns the
// same functions; no double-init hazard.
import { sha512 } from "@noble/hashes/sha512";
import { etc as _ed25519etc } from "@noble/ed25519";
import * as _ExpoCrypto from "expo-crypto";
_ed25519etc.sha512Sync = (...m: Uint8Array[]) => sha512(_ed25519etc.concatBytes(...m));
// Hermes has no globalThis.crypto.getRandomValues — wire expo-crypto's
// getRandomBytes (backed by SecureRandom on Android, SecRandomCopyBytes on iOS).
_ed25519etc.randomBytes = (len?: number) => _ExpoCrypto.getRandomBytes(len ?? 32);

import * as ed25519 from "@noble/ed25519";
import * as SecureStore from "expo-secure-store";

import { getBackendUrl } from "../api";
import { getSessionJWT } from "../auth";
import { getAppMeta, setAppMeta } from "../db";

// SecureStore key for the 32-byte Ed25519 private seed (base64). Naming
// is namespaced ("kaata_mesh_") so a future second keypair (e.g. a
// vault-binding key) doesn't collide.
const SECURE_PRIVKEY_KEY = "kaata_mesh_device_privkey";

// app_meta key mirroring the base64-encoded 32-byte public key. Read
// synchronously by mesh handshake / VMC issuance code paths that can't
// afford a SecureStore round-trip.
const META_PUBKEY_KEY = "mesh_device_ed25519_pubkey";

// Process-local cache of the private key bytes. Populated on first
// signWithDeviceKey() call, dropped on process exit. Holding raw bytes
// in JS memory is fine — Hermes runs in our app's sandbox; anything
// that can read this can already read SecureStore.
let _cachedPrivkey: Uint8Array | null = null;

// Process-local cache of the public key (base64) so getDevicePubkey()
// is truly synchronous after the first ensureDeviceKey() resolution.
let _cachedPubkeyB64: string | null = null;

// -------------------- base64 helpers --------------------

function bytesToB64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  // btoa is shipped by Hermes on RN >= 0.74 (we're on 0.81).
  // eslint-disable-next-line no-undef
  return btoa(s);
}

function b64ToBytes(b64: string): Uint8Array {
  // eslint-disable-next-line no-undef
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}

// -------------------- public API --------------------

// Ensures the device has an Ed25519 keypair, generating one on first
// call. Returns the base64-encoded public key (32 bytes raw → 44 chars
// base64) for callers that want to immediately POST it to the backend.
//
// Idempotent: safe to call from multiple boot paths (auth.ts after
// sign-in, BackgroundCheckIn defensively, mesh handshake lazily).
export async function ensureDeviceKey(): Promise<{ pubkey_b64: string }> {
  if (_cachedPubkeyB64) return { pubkey_b64: _cachedPubkeyB64 };

  // Probe app_meta first (cheaper than SecureStore on Android).
  const existing = await getAppMeta(META_PUBKEY_KEY);
  if (existing) {
    _cachedPubkeyB64 = existing;
    return { pubkey_b64: existing };
  }

  // Generate the 32-byte seed ourselves via expo-crypto.
  //
  // We can NOT use ed25519.utils.randomPrivateKey() — @noble/ed25519 v2.1
  // hardcodes a closure-local randomBytes() that calls crypto.getRandomValues,
  // which is undefined in Hermes. The exported etc.randomBytes IS reassignable
  // (and we do shim it at the top of this file for other call paths), but
  // utils.randomPrivateKey reaches the closure-local function NOT etc, so
  // the shim doesn't affect it. Bypass entirely with expo-crypto's CSPRNG.
  const priv = _ExpoCrypto.getRandomBytes(32);
  // Use the SYNC getPublicKey — it relies on our sha512Sync shim. The async
  // variant uses crypto.subtle which is undefined in Hermes.
  const pub = ed25519.getPublicKey(priv);

  const privB64 = bytesToB64(priv);
  const pubB64 = bytesToB64(pub);

  // Persist BOTH before populating caches — if SecureStore fails we
  // don't want a half-state where app_meta thinks we have a key but
  // the private half was never written. setItemAsync throws on failure.
  await SecureStore.setItemAsync(SECURE_PRIVKEY_KEY, privB64);
  await setAppMeta(META_PUBKEY_KEY, pubB64);

  _cachedPrivkey = priv;
  _cachedPubkeyB64 = pubB64;
  return { pubkey_b64: pubB64 };
}

// Synchronous read of the cached public key. Returns null if
// ensureDeviceKey() has not yet been awaited in this process; callers
// must handle null (e.g., by deferring mesh handshake until next tick).
//
// Never throws. Never touches I/O.
export function getDevicePubkey(): string | null {
  return _cachedPubkeyB64;
}

// Signs a message with the device's private key. First call loads from
// SecureStore (~10-30ms on Android); subsequent calls sign from memory.
export async function signWithDeviceKey(message: Uint8Array): Promise<Uint8Array> {
  if (!_cachedPrivkey) {
    const privB64 = await SecureStore.getItemAsync(SECURE_PRIVKEY_KEY);
    if (!privB64) {
      throw new Error(
        "signWithDeviceKey: no device key in SecureStore — call ensureDeviceKey() first",
      );
    }
    _cachedPrivkey = b64ToBytes(privB64);
  }
  // SYNC sign — uses sha512Sync shim. The async variant would need
  // crypto.subtle (undefined on Hermes).
  return ed25519.sign(message, _cachedPrivkey);
}

// Returns the raw 32-byte device seed as standard base64, for injecting into
// the NATIVE mesh engine (KeystoreSeedStore) so it can sign proof-of-possession
// after a swipe-kill. The seed already lives in expo-secure-store; this only
// moves it within the trusted boundary (native re-encrypts it under AndroidKeyStore).
// null when no key exists yet. Used by the cutover seed-injection path only.
export async function getDeviceSeedB64(): Promise<string | null> {
  return await SecureStore.getItemAsync(SECURE_PRIVKEY_KEY);
}

// -------------------- backend registration --------------------

// clearDeviceKey wipes the in-memory privkey cache. Called from auth.ts
// signOut so a subsequent sign-in (potentially as a different user on
// the same physical device) does not unintentionally reuse the previous
// session's loaded-into-memory privkey copy. The SecureStore-backed key
// is left in place — `install_id` is per-device-not-per-account, so the
// next mesh handshake re-reads it on first signWithDeviceKey() call.
//
// resetAllLocalData (dev only) additionally deletes the SecureStore
// row; that's a heavier hammer for the "reset everything" flow.
export function clearDeviceKey(): void {
  _cachedPrivkey = null;
  _cachedPubkeyB64 = null;
}

// POSTs the device's public key to the backend so other peers can verify
// our signatures. Idempotent: backend UPSERTs by install_id.
//
// Fire-and-forget from auth.ts — failures are NOT thrown to the caller;
// the next check-in's defensive call will retry.
export async function registerDeviceKey(): Promise<void> {
  try {
    const { pubkey_b64 } = await ensureDeviceKey();
    const jwt = await getSessionJWT().catch(() => null);
    if (!jwt) {
      // Local-only mode — no backend to register with. ensureDeviceKey
      // still ran (good: the keypair is ready for whenever the user
      // signs in later).
      return;
    }
    const baseUrl = await getBackendUrl();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    try {
      const res = await fetch(`${baseUrl}/v1/devices/register-key`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${jwt}`,
        },
        body: JSON.stringify({ ed25519_pubkey: pubkey_b64 }),
        signal: controller.signal,
      });
      if (!res.ok) {
        console.warn(`[mesh] register-key returned ${res.status}`);
      }
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    console.warn("[mesh] registerDeviceKey failed", err);
  }
}
