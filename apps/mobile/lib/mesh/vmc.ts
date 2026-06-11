// apps/mobile/lib/mesh/vmc.ts
//
// VMC = Vault Membership Credential. Server-signed token (Ed25519) that
// proves "this device has this role in this vault at this epoch until this
// expiry." Two peers exchange VMCs during a mesh handshake and verify each
// other's signature against a pinned server pubkey.
//
// Wire format:
//   base64(canonical_json) + "." + base64(ed25519_signature)
//
// canonical_json (sorted keys, no whitespace):
//   {
//     "v": 1,
//     "vault_id": "uuid",
//     "account_id": "uuid",
//     "device_id": "uuid",                 // install_id of holder
//     "device_pubkey": "base64",           // 32 bytes
//     "role": "owner" | "editor" | "viewer",
//     "vault_epoch": 5,
//     "issued_at_ms": 1733000000000,
//     "expires_at_ms": 1738000000000,
//     "iss": "kaata-mesh-v1"
//   }
//
// The ed25519 signature is over the RAW payload bytes (NOT a re-encoded
// canonical JSON we rebuild on this side). We extract the payload bytes
// from inside the base64 envelope verbatim and feed them to ed.verify
// (sync — Hermes has no crypto.subtle for the async variant), avoiding
// any cross-language canonicalization hazard.
//
// Verification trust model:
//   1. Pinned server pubkey lives in app_meta.mesh_server_pubkey_primary
//      (and optionally _rotation during a rotation window).
//   2. The check-in response echoes the current pubkeys on every response;
//      we cache them on first sight. Rotation pubkey is accepted too.
//   3. If neither pinned pubkey is present we refuse to verify.

// Side-effect import: installs sha512Sync + randomBytes shims on
// @noble/ed25519 v2's `etc` namespace BEFORE any sign/verify/keygen call
// in this module. Critical — vmc.ts can be reached from entry points
// (background tasks, future workers) that don't transitively pull
// db.ts/event-log.ts/event-sig.ts, where the shim is otherwise installed.
// Adding it here directly is one redundant assignment at boot and closes
// the latent "etc.sha512Sync not set" hazard.
import "./_ed25519-setup";
import * as ed from "@noble/ed25519";

import { getDb } from "../db-tx";
import { getAppMeta, setAppMeta } from "../db";
import { getInstallIdSync } from "../db-tx";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const VMC_SCHEMA_VERSION = 1;
// Phase 5 server-anchored issuer string.
const VMC_ISSUER_SERVER = "kaata-mesh-v1";
// Phase 7 local-anchored issuer string (local-CA path).
const VMC_ISSUER_LOCAL = "kaata-mesh-local-v1";
const VMC_ALLOWED_ISSUERS = new Set([VMC_ISSUER_SERVER, VMC_ISSUER_LOCAL]);

/** Tolerance on expires_at to accommodate phone clock drift. Exported so
 *  the mid-session reverify in anti-entropy.ts can apply the SAME leeway
 *  the initial verify used — without this, a peer with a slow clock that
 *  passed verifyVMC would immediately fail reverifyVMCWindow on the first
 *  batch boundary, producing a livelock. */
export const EXPIRY_SKEW_TOLERANCE_MS = 60_000;

/** Renewal threshold: we ask the server for a refresh this long before
 *  the cached VMC expires. With a 60-day lifetime, 7 days is 53 days
 *  headroom — a device offline for 53 days arrives with a still-valid
 *  VMC and only THEN needs a renewal round-trip on the next check-in. */
export const RENEW_BEFORE_MS = 7 * 24 * 60 * 60 * 1000;

const META_KEY_PRIMARY = "mesh_server_pubkey_primary";
const META_KEY_ROTATION = "mesh_server_pubkey_rotation";
const META_KEY_LAST_REVOCATION_SEEN = "last_revocation_seen_at_ms";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type VMCRole = "owner" | "editor" | "viewer";

export type ParsedVMC = {
  v: number;
  vault_id: string;
  account_id: string;
  device_id: string;
  device_pubkey: string;
  role: VMCRole;
  vault_epoch: number;
  issued_at_ms: number;
  expires_at_ms: number;
  iss: string;
};

export type VerifyErrorCode =
  | "malformed_blob"
  | "malformed_json"
  | "schema_mismatch"
  | "issuer_mismatch"
  | "missing_field"
  | "no_pinned_pubkey"
  | "bad_signature"
  | "expired"
  | "not_yet_valid"
  | "invalid_role";

export type VerifyResult =
  | { valid: true; vmc: ParsedVMC }
  | { valid: false; error: VerifyErrorCode; detail?: string };

export type CachedVMC = {
  blob: string;
  expires_at: number;
  vault_epoch: number;
};

export type ServerRevocation = {
  vault_id: string;
  device_id: string;
  revoked_at_ms: number;
};

// Alias kept for the anti-entropy layer where the "verified peer VMC"
// shape is consumed.
export type VerifiedVMC = ParsedVMC;

// ---------------------------------------------------------------------------
// base64 helpers (Hermes-safe via atob/btoa, latin-1 round-trip)
// ---------------------------------------------------------------------------

function b64decode(s: string): Uint8Array {
  const std = s.replace(/-/g, "+").replace(/_/g, "/");
  const padded = std + "=".repeat((4 - (std.length % 4)) % 4);
  // eslint-disable-next-line no-undef
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function safeDecode(b64: string): Uint8Array | null {
  try {
    const k = b64decode(b64);
    return k.length === 32 ? k : null;
  } catch {
    return null;
  }
}

/**
 * Decode the device_pubkey embedded in a VMC body. Returns null on malformed
 * input. Exported because the handshake's proof-of-possession step needs the
 * raw 32-byte pubkey to verify a challenge signature.
 */
export function decodeDevicePubkey(b64: string): Uint8Array | null {
  return safeDecode(b64);
}

// ---------------------------------------------------------------------------
// Server pubkey pinning
// ---------------------------------------------------------------------------

async function getPinnedServerPubkeys(): Promise<{
  primary: Uint8Array | null;
  rotation: Uint8Array | null;
}> {
  const [primaryB64, rotationB64] = await Promise.all([
    getAppMeta(META_KEY_PRIMARY),
    getAppMeta(META_KEY_ROTATION),
  ]);
  return {
    primary: primaryB64 ? safeDecode(primaryB64) : null,
    rotation: rotationB64 ? safeDecode(rotationB64) : null,
  };
}

/**
 * Persist the pinned server pubkeys announced in a /v1/check-in response.
 *
 * SECURITY MODEL — Trust-On-First-Use (TOFU):
 *   1. The FIRST time we see a primary pubkey we pin it. From that moment
 *      on, the pinned value is the root of trust for VMC verification.
 *   2. A subsequent response whose primary EQUALS the pinned value is
 *      accepted silently (no-op).
 *   3. A subsequent response whose primary DIFFERS from the pinned value is
 *      a candidate for rotation: it is accepted IF AND ONLY IF the wire's
 *      rotation slot ALSO carries the existing pinned primary (i.e. the
 *      server has promoted rotation -> primary and is informing us of the
 *      old key in the rotation slot for a grace window). In that case we
 *      atomically: store the new primary, store the old key as rotation,
 *      and bump META_KEY_PINNED_AT.
 *   4. If the response's primary differs AND the rotation slot does NOT
 *      carry the previous primary, we REFUSE the overwrite and log loudly
 *      — this is the symptom of a TLS-MITM trying to install their own
 *      key. The user keeps their original pin; mesh handshakes against
 *      attacker-minted VMCs will fail until the user explicitly resets.
 *
 * This blocks the "compromise the TLS once, mint VMCs forever" attack
 * even though the server itself is fully trusted (a compromised server
 * is out of scope: it can already do worse).
 *
 * `rotationB64`:
 *   - non-null on this call: store it as rotation key (after the TOFU
 *     gate above). Both keys are accepted by verifyVMC.
 *   - null/undefined on this call: clear any previously-stored rotation
 *     key (used after a rotation window closes).
 */
const META_KEY_PINNED_AT = "mesh_server_pubkey_pinned_at_ms";

export type PubkeyPinOutcome =
  | "first_pin"
  | "no_change"
  | "rotation_accepted"
  | "rotation_refused_mitm";

export async function persistPinnedServerPubkeys(
  primaryB64: string,
  rotationB64: string | null | undefined,
): Promise<PubkeyPinOutcome> {
  if (!primaryB64) return "no_change"; // never clear primary — that breaks mesh entirely
  const db = await getDb();
  const existingPrimary = await getAppMeta(META_KEY_PRIMARY);

  if (!existingPrimary) {
    // First-sight pin (TOFU).
    await setAppMeta(META_KEY_PRIMARY, primaryB64);
    await setAppMeta(META_KEY_PINNED_AT, String(Date.now()));
    if (rotationB64) {
      await setAppMeta(META_KEY_ROTATION, rotationB64);
    } else {
      await db.runAsync(`DELETE FROM app_meta WHERE key = ?`, META_KEY_ROTATION);
    }
    return "first_pin";
  }

  if (existingPrimary === primaryB64) {
    // No primary change — only update rotation if the wire payload differs.
    if (rotationB64 == null) {
      await db.runAsync(`DELETE FROM app_meta WHERE key = ?`, META_KEY_ROTATION);
    } else {
      await setAppMeta(META_KEY_ROTATION, rotationB64);
    }
    return "no_change";
  }

  // Primary disagrees with our pin. Accept ONLY if the server is performing
  // a clean rotation: rotation slot of the wire payload MUST carry the OLD
  // pinned primary so we can verify the handoff was authored by a chain
  // anchored at our existing root of trust. Otherwise refuse and warn.
  if (rotationB64 && rotationB64 === existingPrimary) {
    await setAppMeta(META_KEY_PRIMARY, primaryB64);
    await setAppMeta(META_KEY_ROTATION, existingPrimary);
    await setAppMeta(META_KEY_PINNED_AT, String(Date.now()));
    return "rotation_accepted";
  }

  console.warn(
    "[mesh] REFUSED server pubkey overwrite — pinned primary differs from " +
      "wire primary and rotation slot does not carry the previous primary. " +
      "This is the symptom of TLS MITM. Keeping original pin.",
    { existingPrefix: existingPrimary.slice(0, 8), wirePrefix: primaryB64.slice(0, 8) },
  );
  return "rotation_refused_mitm";
}

// ---------------------------------------------------------------------------
// Core verification
// ---------------------------------------------------------------------------

function splitBlob(blob: string): { payloadBytes: Uint8Array; sigBytes: Uint8Array } | null {
  const dot = blob.indexOf(".");
  if (dot < 0 || dot === blob.length - 1) return null;
  try {
    const payloadBytes = b64decode(blob.slice(0, dot));
    const sigBytes = b64decode(blob.slice(dot + 1));
    if (sigBytes.length !== 64) return null;
    return { payloadBytes, sigBytes };
  } catch {
    return null;
  }
}

function parsePayload(payloadBytes: Uint8Array): ParsedVMC | null {
  let obj: unknown;
  try {
    // TextDecoder is shipped by Hermes on RN >= 0.74.
    // eslint-disable-next-line no-undef
    obj = JSON.parse(new TextDecoder().decode(payloadBytes));
  } catch {
    return null;
  }
  if (!obj || typeof obj !== "object") return null;
  const o = obj as Record<string, unknown>;
  if (
    typeof o.v !== "number" ||
    typeof o.vault_id !== "string" ||
    typeof o.account_id !== "string" ||
    typeof o.device_id !== "string" ||
    typeof o.device_pubkey !== "string" ||
    typeof o.role !== "string" ||
    typeof o.vault_epoch !== "number" ||
    typeof o.issued_at_ms !== "number" ||
    typeof o.expires_at_ms !== "number" ||
    typeof o.iss !== "string"
  ) {
    return null;
  }
  return {
    v: o.v,
    vault_id: o.vault_id,
    account_id: o.account_id,
    device_id: o.device_id,
    device_pubkey: o.device_pubkey,
    role: o.role as VMCRole,
    vault_epoch: o.vault_epoch,
    issued_at_ms: o.issued_at_ms,
    expires_at_ms: o.expires_at_ms,
    iss: o.iss,
  };
}

function isValidRole(r: string): r is VMCRole {
  return r === "owner" || r === "editor" || r === "viewer";
}

/**
 * Verify a VMC blob.
 *
 * Two trust paths (Phase 7):
 *   - Local-anchored vault: caller passes the vault's
 *     `vault_trust_anchor_pubkey` (32-byte Ed25519 pubkey) as
 *     `vaultTrustAnchorPubkey`. The signature is verified ONLY against
 *     this key. iss MUST be "kaata-mesh-local-v1".
 *   - Server-anchored vault: caller passes null/undefined for
 *     `vaultTrustAnchorPubkey`. The signature is verified against the
 *     pinned server pubkey(s) in app_meta. iss MUST be "kaata-mesh-v1".
 *
 * Mode is determined by the trust-anchor argument, NOT by the blob's
 * iss field — that prevents a hostile peer from flipping the
 * verification path by setting `iss` to whichever issuer they can sign
 * for. We additionally cross-check that iss matches the mode, so a
 * server-signed blob can't be presented for local-CA verification or
 * vice versa.
 *
 * @param blob — base64-encoded "<payload>.<sig>"
 * @param expectedVaultId — vault we expect the credential to be about;
 *   pass null/undefined to skip the vault-match check (e.g., during
 *   wire-format sanity at cache time)
 * @param vaultTrustAnchorPubkey — 32-byte Ed25519 pubkey for local-CA
 *   verification, or null/undefined for server-pinned verification.
 */
export async function verifyVMC(
  blob: string,
  expectedVaultId?: string | null,
  vaultTrustAnchorPubkey?: Uint8Array | null,
): Promise<VerifyResult> {
  const split = splitBlob(blob);
  if (!split) return { valid: false, error: "malformed_blob" };
  const { payloadBytes, sigBytes } = split;

  const vmc = parsePayload(payloadBytes);
  if (!vmc) return { valid: false, error: "malformed_json" };
  if (vmc.v !== VMC_SCHEMA_VERSION) {
    return { valid: false, error: "schema_mismatch", detail: `v=${vmc.v}` };
  }
  if (!VMC_ALLOWED_ISSUERS.has(vmc.iss)) {
    return { valid: false, error: "issuer_mismatch", detail: vmc.iss };
  }
  // Mode-iss agreement: local-CA verification requires the local issuer
  // tag; server-anchor verification requires the server issuer tag.
  // This binds the trust path to the credential type and prevents a
  // cross-path forgery.
  if (vaultTrustAnchorPubkey) {
    if (vmc.iss !== VMC_ISSUER_LOCAL) {
      return {
        valid: false,
        error: "issuer_mismatch",
        detail: `expected ${VMC_ISSUER_LOCAL} for local-CA vault, got ${vmc.iss}`,
      };
    }
  } else {
    if (vmc.iss !== VMC_ISSUER_SERVER) {
      return {
        valid: false,
        error: "issuer_mismatch",
        detail: `expected ${VMC_ISSUER_SERVER} for server-anchored vault, got ${vmc.iss}`,
      };
    }
  }
  if (!isValidRole(vmc.role)) {
    return { valid: false, error: "invalid_role", detail: vmc.role };
  }
  const now = Date.now();
  if (vmc.expires_at_ms + EXPIRY_SKEW_TOLERANCE_MS < now) {
    return {
      valid: false,
      error: "expired",
      detail: `expired ${now - vmc.expires_at_ms}ms ago`,
    };
  }
  // Reject future-dated VMCs (issued_at_ms > now + skew). A server with
  // a wildly-wrong clock could otherwise mint VMCs years from now that
  // stay "valid" once the issuer clock is corrected. The same skew
  // tolerance is applied here as for expires_at.
  if (vmc.issued_at_ms - EXPIRY_SKEW_TOLERANCE_MS > now) {
    return {
      valid: false,
      error: "not_yet_valid",
      detail: `issued ${vmc.issued_at_ms - now}ms in future`,
    };
  }
  if (expectedVaultId && vmc.vault_id !== expectedVaultId) {
    return {
      valid: false,
      error: "missing_field",
      detail: `vault_id mismatch: ${vmc.vault_id} != ${expectedVaultId}`,
    };
  }

  // Local-CA path: verify ONLY against the supplied trust anchor.
  if (vaultTrustAnchorPubkey) {
    if (vaultTrustAnchorPubkey.length !== 32) {
      return {
        valid: false,
        error: "no_pinned_pubkey",
        detail: `trust anchor wrong length ${vaultTrustAnchorPubkey.length}`,
      };
    }
    try {
      // SYNC verify — Hermes has no crypto.subtle for the async variant.
      if (ed.verify(sigBytes, payloadBytes, vaultTrustAnchorPubkey)) {
        return { valid: true, vmc };
      }
    } catch {
      // fall through to bad_signature
    }
    return { valid: false, error: "bad_signature" };
  }

  // Server-anchor path: verify against pinned server pubkey(s) — primary
  // first, then rotation slot during a rotation window.
  const { primary, rotation } = await getPinnedServerPubkeys();
  if (!primary && !rotation) {
    return { valid: false, error: "no_pinned_pubkey" };
  }

  try {
    if (primary && ed.verify(sigBytes, payloadBytes, primary)) {
      return { valid: true, vmc };
    }
  } catch {
    // fall through to rotation
  }
  try {
    if (rotation && ed.verify(sigBytes, payloadBytes, rotation)) {
      return { valid: true, vmc };
    }
  } catch {
    // both failed
  }
  return { valid: false, error: "bad_signature" };
}

// ---------------------------------------------------------------------------
// vault_credentials cache (per-device local VMC store)
// ---------------------------------------------------------------------------

/**
 * Briar-style bidirectional pair verification.
 *
 * Tries verifyVMC against the vault's trust anchor first (the legacy
 * local-CA path: owner self-signs their own VMC, joiner verifies it
 * against owner's pubkey from the QR). If that fails, looks up the
 * peer's pinned credential in vault_credentials (keyed on device_id
 * from the VMC payload) and verifies the signature against the pinned
 * device_pubkey. The pinned credential was populated at QR-scan time
 * — i.e. the user physically scanned this peer's QR, so the pubkey is
 * trusted-by-physical-presence.
 *
 * This is the privacy guarantee Kaata needs: only peers whose QR you
 * scanned (and whose pubkey is therefore pinned) can ever produce a
 * verifiable VMC. A stranger's BLE advert can reach us; their
 * handshake hello cannot.
 *
 * Returns the same VerifyResult shape as verifyVMC — caller does not
 * need to know which path succeeded.
 */
export type VerifyVMCExtras = {
  /**
   * Mythos P2 fix. Echoed by the joiner from the QR's shop_mode_token.
   * Path C TOFU now REQUIRES this field to match a live unconsumed pair
   * token's nonce for the verifying vault. Without it, Path C is skipped
   * entirely — preventing a stranger in BLE range from riding the
   * 5-minute pair window without having seen the QR.
   *
   * Undefined for any handshake AFTER the joiner is already pinned
   * (Path B succeeds without needing the nonce).
   */
  pairNonceFromPeerHello?: string;
};

/**
 * Mythos P2 fix: VerifyResult is now extended with a `tofuMatchedToken`
 * marker so the caller (anti-entropy.handshake) can know to invoke
 * consumePairToken with the same nonce after a successful Path-C verify.
 * The field is OPTIONAL — Path A and Path B successes don't set it.
 */
export type VerifyVMCAgainstPinnedPeerResult = VerifyResult & {
  tofuMatchedTokenNonce?: string;
};

export async function verifyVMCAgainstPinnedPeer(
  blob: string,
  expectedVaultId: string,
  vaultTrustAnchorPubkey?: Uint8Array | null,
  extras?: VerifyVMCExtras,
): Promise<VerifyVMCAgainstPinnedPeerResult> {
  // Path A: standard trust-anchor verification (owner-self or
  // owner-issued VMCs verified by owner's own pubkey).
  const primary = await verifyVMC(blob, expectedVaultId, vaultTrustAnchorPubkey);
  if (primary.valid) return primary;

  // Path B: pinned-peer fallback. The peer self-signed a VMC at pair
  // time and the scanner pinned their device_pubkey. The fallback is
  // ONLY tried when the signature failed (bad_signature) — issuer
  // mismatches, expiry, schema problems all stay as the primary
  // verdict so genuinely-malformed VMCs surface clean errors.
  if (primary.error !== "bad_signature") return primary;
  const peeked = peekVMCDeviceId(blob);
  if (!peeked) return primary;
  if (peeked.vault_id !== expectedVaultId) return primary;
  const db = await getDb();
  const row = await db.getFirstAsync<{ device_pubkey: string }>(
    `SELECT device_pubkey
       FROM vault_credentials
      WHERE vault_id = ? AND device_id = ?
      LIMIT 1`,
    expectedVaultId,
    peeked.device_id,
  );
  if (row) {
    let pinnedPubkeyBytes: Uint8Array;
    try {
      // eslint-disable-next-line no-undef
      const bin = atob(row.device_pubkey);
      pinnedPubkeyBytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) pinnedPubkeyBytes[i] = bin.charCodeAt(i);
    } catch {
      return primary;
    }
    if (pinnedPubkeyBytes.length !== 32) return primary;
    // Re-verify the same blob against the pinned pubkey. This works
    // because verifyVMC's signature check is just Ed25519 over the
    // canonical payload bytes — the verifier pubkey is interchangeable
    // as long as the iss validation also passes (which it does because
    // pinned peers also use iss="local-CA").
    console.log("[mesh.verify] trying pinned-peer path for device=", peeked.device_id.slice(0, 8));
    const pinnedResult = await verifyVMC(blob, expectedVaultId, pinnedPubkeyBytes);
    console.log(
      "[mesh.verify] pinned-peer result",
      pinnedResult.valid ? "OK" : `FAIL (${pinnedResult.error})`,
    );
    return pinnedResult;
  }

  // Path C: TOFU bound to a recent pair token.
  //
  // The OWNER just generated a pair QR within the last 5 minutes. A
  // joiner that scanned it now connects over BLE. The owner has no
  // pinned credential for the joiner yet — they're meeting for the
  // first time. We accept the joiner's self-signed VMC for THIS
  // handshake only if the owner has a valid unconsumed pair token for
  // this vault. After successful verification, the caller's downstream
  // logic (anti-entropy handshake's cachePeerVMC, plus the pair-token
  // consume) closes the TOFU window so a stranger arriving 10 minutes
  // later cannot use the same path.
  //
  // The privacy contract this preserves: a stranger phone that picks
  // up Kaata's BLE advert can only TOFU into a vault if the owner has
  // an active, unconsumed pair token RIGHT NOW. A passive eavesdropper
  // who later attempts to spoof gets no window — the token is
  // single-use and TTL-bound.
  // Mythos P2: Path C TOFU now REQUIRES pair_nonce from the joiner's
  // Hello to exactly match a live unconsumed token's nonce for THIS
  // vault. Without it: skip Path C entirely. Without it would mean any
  // stranger in BLE range who learned the vault_id (from any plaintext
  // Hello on the same vault, or from the QR over-the-shoulder) could
  // self-issue a VMC and ride the pair window.
  const peerPairNonce = extras?.pairNonceFromPeerHello;
  if (typeof peerPairNonce !== "string" || peerPairNonce.length === 0) {
    console.log("[mesh.verify] TOFU refused — peer Hello had no pair_nonce");
    return primary;
  }
  // Parse the VMC payload first so we can role-clamp before any verify
  // work. Cheap parse — no signature math.
  const split = splitBlob(blob);
  if (!split) return primary;
  const vmcPayload = parsePayload(split.payloadBytes);
  if (!vmcPayload) return primary;
  let matchedToken: { nonce: string; expires_at_ms: number; role?: string } | null = null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const localPair = require("./local-pair") as {
      getPendingPairTokensForVault: (vaultId: string) => Promise<
        Array<{
          nonce: string;
          expires_at_ms: number;
          consumed_at_ms?: number | null;
          role?: string;
        }>
      >;
    };
    const tokens = await localPair.getPendingPairTokensForVault(expectedVaultId);
    const now = Date.now();
    matchedToken =
      tokens.find(
        (t) =>
          t.nonce === peerPairNonce &&
          t.expires_at_ms > now &&
          (t.consumed_at_ms == null || t.consumed_at_ms === 0),
      ) ?? null;
    console.log(
      "[mesh.verify] TOFU nonce check — vault=",
      expectedVaultId.slice(0, 8),
      "tokens=",
      tokens.length,
      "matched=",
      matchedToken != null,
    );
    if (!matchedToken) {
      console.log("[mesh.verify] TOFU refused — pair_nonce did not match any live token");
      return primary;
    }
  } catch (err) {
    console.warn("[mesh.verify] TOFU lookup threw", err);
    return primary;
  }

  // Mythos P2 role clamp. If the joiner's self-issued VMC claims a
  // ROLE STRICTLY GREATER than what the owner offered in the pair
  // token, REFUSE. The honest client uses the QR's offered role; a
  // hostile client could mint a VMC with role="owner" to escalate.
  // Without this check the carve-out in role-gate would accept the
  // higher role and the attacker could remove the real owner, rewrite
  // settings, etc.
  const ROLE_RANK: Record<string, number> = { viewer: 0, editor: 1, owner: 2 };
  const tokenRole = matchedToken.role ?? "editor"; // fallback matches deriveOfferedRole
  const vmcRole = vmcPayload.role;
  const tokenRank = ROLE_RANK[tokenRole] ?? 1;
  const vmcRank = ROLE_RANK[vmcRole] ?? -1;
  if (vmcRank < 0) {
    console.warn("[mesh.verify] TOFU refused — VMC role not recognized:", vmcRole);
    return primary;
  }
  if (vmcRank > tokenRank) {
    console.warn(
      "[mesh.verify] TOFU refused — role escalation attempt: token offered",
      tokenRole,
      "but VMC claims",
      vmcRole,
    );
    return primary;
  }

  // Parse the VMC payload to extract the CLAIMED device_pubkey, then
  // verify the signature against that. If the signature matches, the
  // VMC is internally consistent and we accept it under the pair-token
  // TOFU policy above.
  let claimedPubkeyBytes: Uint8Array;
  try {
    // eslint-disable-next-line no-undef
    const bin = atob(vmcPayload.device_pubkey);
    claimedPubkeyBytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) claimedPubkeyBytes[i] = bin.charCodeAt(i);
  } catch {
    return primary;
  }
  if (claimedPubkeyBytes.length !== 32) return primary;
  console.log(
    "[mesh.verify] TOFU verifying against claimed device_pubkey=",
    vmcPayload.device_pubkey.slice(0, 12),
  );
  const tofuResult = await verifyVMC(blob, expectedVaultId, claimedPubkeyBytes);
  console.log(
    "[mesh.verify] TOFU result",
    tofuResult.valid ? "OK — peer ACCEPTED via pair-token window" : `FAIL (${tofuResult.error})`,
  );
  if (tofuResult.valid) {
    // Bubble up the matched token nonce so the caller can call
    // consumePairToken after a successful handshake (closes the window
    // so another joiner can't reuse the same nonce).
    return { ...tofuResult, tofuMatchedTokenNonce: matchedToken.nonce };
  }
  return tofuResult;
}

/**
 * Verify the supplied VMC blob (against the pinned server pubkey) and cache
 * it. Returns the parsed body on success; throws on verification failure so
 * the caller (e.g. /vault/pair-scan) doesn't accidentally persist an
 * unverifiable blob into vault_credentials.
 *
 * Use this from any path that obtains a VMC from a non-server-of-truth path
 * such as the HTTP /credential endpoint — `cacheVMC` is the lower-level
 * helper for callers that already verified.
 */
export async function verifyAndCacheVMC(
  vaultId: string,
  vmcBlob: string,
  vaultTrustAnchorPubkey?: Uint8Array | null,
): Promise<ParsedVMC> {
  const result = await verifyVMC(vmcBlob, vaultId, vaultTrustAnchorPubkey);
  if (!result.valid) {
    throw new Error(
      `verifyAndCacheVMC: refused to cache unverifiable blob (${result.error}${result.detail ? `: ${result.detail}` : ""})`,
    );
  }
  await cacheVMC(
    vaultId,
    vmcBlob,
    result.vmc.expires_at_ms,
    result.vmc.account_id,
    result.vmc.device_pubkey,
    result.vmc.vault_epoch,
  );
  return result.vmc;
}

export async function cacheVMC(
  vaultId: string,
  vmcBlob: string,
  expiresAt: number,
  accountId: string,
  devicePubkeyB64: string,
  vaultEpoch: number,
): Promise<void> {
  const db = await getDb();
  const deviceId = getInstallIdSync();
  const now = Date.now();
  await db.runAsync(
    `INSERT INTO vault_credentials
       (vault_id, account_id, device_id, device_pubkey, vmc_blob,
        issued_at, expires_at, vault_epoch)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (vault_id, device_id) DO UPDATE SET
       account_id    = excluded.account_id,
       device_pubkey = excluded.device_pubkey,
       vmc_blob      = excluded.vmc_blob,
       issued_at     = excluded.issued_at,
       expires_at    = excluded.expires_at,
       vault_epoch   = excluded.vault_epoch`,
    vaultId,
    accountId,
    deviceId,
    devicePubkeyB64,
    vmcBlob,
    now,
    expiresAt,
    vaultEpoch,
  );
}

/**
 * Cache a PEER's VMC into vault_credentials. Distinct from cacheVMC
 * (which hardcodes getInstallIdSync() — our own device_id). Without this,
 * role-gate.ts:lookupSignerCredential returns null for any remote event
 * signer and the role-gate silently rejects with reason='unknown_actor'.
 *
 * Must be called from the mesh handshake AFTER the peer's VMC is
 * cryptographically verified against the vault's trust anchor (or the
 * server-pinned pubkey for server-anchored vaults). The peer device_id
 * comes from peerHello (the install_id the peer reports during the
 * mesh handshake; an attacker can spoof but only by re-signing the VMC,
 * which the verification step rejected).
 *
 * Idempotent on (vault_id, device_id) via the same ON CONFLICT clause.
 */
export async function cachePeerVMC(args: {
  vaultId: string;
  peerDeviceId: string;
  peerVmcBlob: string;
  peerExpiresAt: number;
  peerAccountId: string;
  peerDevicePubkeyB64: string;
  peerVaultEpoch: number;
}): Promise<void> {
  const db = await getDb();
  const now = Date.now();
  await db.runAsync(
    `INSERT INTO vault_credentials
       (vault_id, account_id, device_id, device_pubkey, vmc_blob,
        issued_at, expires_at, vault_epoch)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (vault_id, device_id) DO UPDATE SET
       account_id    = excluded.account_id,
       device_pubkey = excluded.device_pubkey,
       vmc_blob      = excluded.vmc_blob,
       issued_at     = excluded.issued_at,
       expires_at    = excluded.expires_at,
       vault_epoch   = excluded.vault_epoch`,
    args.vaultId,
    args.peerAccountId,
    args.peerDeviceId,
    args.peerDevicePubkeyB64,
    args.peerVmcBlob,
    now,
    args.peerExpiresAt,
    args.peerVaultEpoch,
  );
  // Migration 014 trigger (b): a new credential MAY cure events
  // currently quarantined as unknown_actor (or role_insufficient if
  // the credential carries a higher role than what we last knew).
  // Lazy-import to avoid pulling projection/sweep into the mesh
  // module graph at import time.
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { scheduleSweep } = require("../projection/sweep") as {
      scheduleSweep: (vaultId: string) => void;
    };
    scheduleSweep(args.vaultId);
  } catch {
    /* sweep is best-effort — credential is already cached */
  }
}

export async function getCachedVMC(vaultId: string): Promise<CachedVMC | null> {
  const db = await getDb();
  const deviceId = getInstallIdSync();
  const row = await db.getFirstAsync<{
    vmc_blob: string;
    expires_at: number;
    vault_epoch: number;
  }>(
    `SELECT vmc_blob, expires_at, vault_epoch
     FROM vault_credentials
     WHERE vault_id = ? AND device_id = ?`,
    vaultId,
    deviceId,
  );
  if (!row) return null;
  return {
    blob: row.vmc_blob,
    expires_at: row.expires_at,
    vault_epoch: row.vault_epoch,
  };
}

/**
 * Return vault_ids whose cached VMC is within RENEW_BEFORE_MS of expiry
 * (or already expired). Used by BackgroundCheckIn to populate the
 * vmc_renewals_needed payload.
 */
export async function findVMCsNeedingRenewal(nowMs: number = Date.now()): Promise<string[]> {
  const db = await getDb();
  const deviceId = getInstallIdSync();
  const threshold = nowMs + RENEW_BEFORE_MS;
  const rows = await db.getAllAsync<{ vault_id: string }>(
    `SELECT vault_id
     FROM vault_credentials
     WHERE device_id = ? AND expires_at < ?`,
    deviceId,
    threshold,
  );
  return rows.map((r) => r.vault_id);
}

// ---------------------------------------------------------------------------
// revocation_list
// ---------------------------------------------------------------------------

/**
 * Apply revocations announced in a check-in response. Idempotent: the
 * UPSERT on (vault_id, device_id) re-applying a known revocation is a
 * no-op.
 *
 * Side effect: if a revocation targets THIS device, also DELETE the
 * cached VMC so we don't keep retrying handshakes that will be refused.
 */
export async function applyServerRevocations(revocations: ServerRevocation[]): Promise<void> {
  if (revocations.length === 0) return;
  const db = await getDb();
  const myDeviceId = getInstallIdSync();
  // perVaultMaxPersisted tracks the largest revoked_at_ms we ACTUALLY
  // committed to the local revocation_list table (post ON CONFLICT MIN).
  // Advancing the high-water mark against the wire-side max would skip
  // older revocations the server later sends out of order. Since the
  // backend (mesh/revocation.go GetRevocationsForVault) emits ORDER BY
  // revoked_at ASC, persisted == wire-side in practice — but we mirror
  // the semantic correctly so a future re-ordering at the server doesn't
  // silently lose revocations.
  const perVaultMaxPersisted: Record<string, number> = {};

  await db.withTransactionAsync(async () => {
    for (const r of revocations) {
      // Use RETURNING-equivalent two-step (SQLite supports RETURNING since
      // 3.35; expo-sqlite ships a recent enough engine) so we know the
      // value that actually landed.
      const before = await db.getFirstAsync<{ revoked_at: number }>(
        `SELECT revoked_at FROM revocation_list WHERE vault_id = ? AND device_id = ?`,
        r.vault_id,
        r.device_id,
      );
      await db.runAsync(
        `INSERT INTO revocation_list (vault_id, device_id, revoked_at)
         VALUES (?, ?, ?)
         ON CONFLICT (vault_id, device_id) DO UPDATE SET
           revoked_at = MIN(revocation_list.revoked_at, excluded.revoked_at)`,
        r.vault_id,
        r.device_id,
        r.revoked_at_ms,
      );
      const persisted = before ? Math.min(before.revoked_at, r.revoked_at_ms) : r.revoked_at_ms;
      if (r.device_id === myDeviceId) {
        await db.runAsync(
          `DELETE FROM vault_credentials WHERE vault_id = ? AND device_id = ?`,
          r.vault_id,
          myDeviceId,
        );
      }
      const prev = perVaultMaxPersisted[r.vault_id] ?? -Infinity;
      if (persisted > prev) {
        perVaultMaxPersisted[r.vault_id] = persisted;
      }
    }
  });

  // Bump the per-vault high-water mark for the next check-in. We use the
  // actually-persisted timestamp so a still-missing older revocation isn't
  // skipped on the next /v1/check-in.
  const prev = await getLastRevocationSeenAtMs();
  let changed = false;
  for (const [vaultId, ms] of Object.entries(perVaultMaxPersisted)) {
    if (!(vaultId in prev) || ms > prev[vaultId]) {
      prev[vaultId] = ms;
      changed = true;
    }
  }
  if (changed) {
    await setAppMeta(META_KEY_LAST_REVOCATION_SEEN, JSON.stringify(prev));
  }
}

/** Read the per-vault high-water mark we send to the server. */
export async function getLastRevocationSeenAtMs(): Promise<Record<string, number>> {
  const raw = await getAppMeta(META_KEY_LAST_REVOCATION_SEEN);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const out: Record<string, number> = {};
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof v === "number") out[k] = v;
      }
      return out;
    }
  } catch {
    // fall through
  }
  return {};
}

/**
 * Check whether a (vault_id, device_id) pair has been revoked. Called
 * during mesh handshake before accepting a peer's VMC.
 */
/**
 * Cheap parse-only extraction of (vault_id, device_id) from a VMC blob,
 * WITHOUT verifying the signature. Used by the mesh handshake to perform
 * the local revocation_list check BEFORE spending the Ed25519 verify cost
 * on a peer that we already know is revoked.
 *
 * Returns null if the blob is malformed. The fields are UNTRUSTED — they
 * have NOT been signature-verified. The only safe use is as a key into
 * the local revocation_list (which is itself authoritative; an attacker
 * who forges a different device_id to dodge their own revocation row
 * will be caught by the subsequent verifyVMC signature check anyway).
 */
export function peekVMCDeviceId(blob: string): { vault_id: string; device_id: string } | null {
  const split = splitBlob(blob);
  if (!split) return null;
  const vmc = parsePayload(split.payloadBytes);
  if (!vmc) return null;
  return { vault_id: vmc.vault_id, device_id: vmc.device_id };
}

export async function isRevoked(vaultId: string, deviceId: string): Promise<boolean> {
  const db = await getDb();
  // ENG #8 fix: a row with lifted_at IS NOT NULL means the device was
  // removed-then-re-added; treat it as NOT revoked. Without this, a
  // re-paired device stays permanently rejected at mesh handshake
  // even though its account is welcome in vault_members_mirror.
  // Try the lifted_at-aware query first; on legacy pre-013 schemas
  // the column is missing and we fall back to the bare lookup.
  try {
    const row = await db.getFirstAsync<{ revoked_at: number; lifted_at: number | null }>(
      `SELECT revoked_at, lifted_at FROM revocation_list
        WHERE vault_id = ? AND device_id = ?`,
      vaultId,
      deviceId,
    );
    if (!row) return false;
    return row.lifted_at == null;
  } catch {
    const row = await db.getFirstAsync<{ revoked_at: number }>(
      `SELECT revoked_at FROM revocation_list WHERE vault_id = ? AND device_id = ?`,
      vaultId,
      deviceId,
    );
    return row != null;
  }
}

/**
 * Return every (device_id) tuple cached locally for the given
 * (vault_id, account_id). Used by applyVaultMemberRemoved to enumerate
 * the devices that need revocation_list rows when a member is removed
 * offline.
 *
 * Why vault_credentials and not the mirror? The mirror is keyed by
 * account_id only — a multi-device account contributes one row. The
 * credentials cache is the only local table that records the per-device
 * identity (because it's where pair-acceptance writes its newly-issued
 * VMC, and where check-in renewals land). For an owner-emitted
 * removal we may not have credentials for every peer device the owner
 * has ever seen, but we WILL have at least those that have ever
 * handshook with us — which is the set we'd otherwise need to refuse on
 * the next round anyway. Stale tombstones for devices we've never seen
 * are harmless.
 */
export async function getDevicesForAccount(vaultId: string, accountId: string): Promise<string[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<{ device_id: string }>(
    `SELECT device_id FROM vault_credentials
      WHERE vault_id = ? AND account_id = ?`,
    vaultId,
    accountId,
  );
  return rows.map((r) => r.device_id);
}

// ---------------------------------------------------------------------------
// Renewal request queue
// ---------------------------------------------------------------------------

const renewalQueue = new Set<string>();

export async function requestVMCRenewal(vaultIds: string[]): Promise<void> {
  for (const id of vaultIds) renewalQueue.add(id);
}

export function drainRenewalQueue(): string[] {
  const list = Array.from(renewalQueue);
  renewalQueue.clear();
  return list;
}

/** Union of "expiring soon" + "manually queued" for the outbound check-in. */
export async function collectRenewalsForCheckIn(): Promise<string[]> {
  const expiring = await findVMCsNeedingRenewal();
  const queued = drainRenewalQueue();
  return Array.from(new Set<string>([...expiring, ...queued]));
}

// ---------------------------------------------------------------------------
// Single-entry hook for check-in response handling
// ---------------------------------------------------------------------------

export type CheckInVMCExtension = {
  vmc_renewals?: Array<{
    vault_id: string;
    vmc_blob: string;
    expires_at_ms: number;
  }>;
  revocations?: ServerRevocation[];
  mesh_server_pubkeys?: {
    primary: string;
    rotation?: string | null;
  };
};

/**
 * Apply all VMC-related fields from a check-in response. Called from
 * lib/app-meta-context.tsx's applyCheckIn after the existing JWT refresh.
 * Failures inside are logged and do NOT propagate — mesh hiccups must
 * never break check-in.
 *
 * Order matters:
 *   1. Pin pubkeys first (so subsequent VMC verifications use them).
 *   2. Apply revocations (so freshly-cached VMCs aren't immediately
 *      shadowed by a revocation arriving in the same response).
 *   3. Cache renewals — each is verified against the (now-current) pinned
 *      pubkey before being persisted.
 */
export async function applyVMCCheckInResponse(ext: CheckInVMCExtension): Promise<void> {
  // 1. Pin pubkeys.
  if (ext.mesh_server_pubkeys?.primary) {
    try {
      await persistPinnedServerPubkeys(
        ext.mesh_server_pubkeys.primary,
        ext.mesh_server_pubkeys.rotation ?? null,
      );
    } catch (err) {
      console.warn("[mesh] persistPinnedServerPubkeys failed", err);
    }
  }

  // 2. Revocations.
  if (ext.revocations && ext.revocations.length > 0) {
    try {
      await applyServerRevocations(ext.revocations);
    } catch (err) {
      console.warn("[mesh] applyServerRevocations failed", err);
    }
  }

  // 3. Renewals. Verify before caching so a hostile server can't trick
  // us into caching a blob signed by someone else.
  if (ext.vmc_renewals && ext.vmc_renewals.length > 0) {
    for (const r of ext.vmc_renewals) {
      try {
        // Server-side check-in only delivers server-signed renewals;
        // pass null trust anchor to take the pinned-server-pubkey path.
        const result = await verifyVMC(r.vmc_blob, r.vault_id, null);
        if (!result.valid) {
          console.warn("[mesh] dropping unverifiable VMC renewal", {
            vault_id: r.vault_id,
            error: result.error,
            detail: result.detail,
          });
          continue;
        }
        await cacheVMC(
          r.vault_id,
          r.vmc_blob,
          r.expires_at_ms,
          result.vmc.account_id,
          result.vmc.device_pubkey,
          result.vmc.vault_epoch,
        );
      } catch (err) {
        console.warn("[mesh] cacheVMC failed for", r.vault_id, err);
      }
    }
  }
}
