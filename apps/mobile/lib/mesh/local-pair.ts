// apps/mobile/lib/mesh/local-pair.ts
//
// Phase 7 Part B: local-CA pair flow (no server roundtrip).
//
// The vault owner's device is the trust anchor. When a new device scans
// the owner's QR, it connects over the mesh handshake channel and
// exchanges:
//
//   New device  -> owner:  pair_claim   { nonce, device_id, device_pubkey }
//   Owner       -> new:    pair_grant   { vmc_blob }                (success)
//   Owner       -> new:    pair_error   { reason }                  (failure)
//
// The owner's device privkey signs the VMC (via issueLocalVMC in
// local-vmc.ts). The new device verifies it against
// vault_trust_anchor_pubkey carried in the QR (which on success it
// stores into the local vaults row alongside the cached VMC).
//
// Pair tokens are one-use, time-bounded nonces persisted in app_meta so
// the owner survives a process restart between "show QR" and "scanner
// connects".
//
// NOTE: the over-the-wire pair_claim / pair_grant exchange is wired
// from the mesh handshake layer in a follow-up phase (BLE peripheral
// mode is currently blocked — Phase 6.1). This module ships the pure
// logic + DB integration so the host UI can call into it and so the
// handshake glue is a small additive change later.

import * as Crypto from "expo-crypto";

import { getAppMeta, getDb, setAppMeta } from "../db";
import {
  buildLocalAccountId,
  issueLocalVMC,
  LOCAL_ISSUER_TAG,
  type LocalVMCRole,
} from "./local-vmc";
import { ensureDeviceKey, getDevicePubkey } from "./device-key";
import { cacheVMC, verifyVMC } from "./vmc";

// --- constants ---------------------------------------------------------------

export const PAIR_TOKEN_TTL_MS = 5 * 60 * 1000; // 5 minutes
const PAIR_TOKEN_BYTES = 32;
const META_KEY_PENDING_PAIR_TOKENS = "pending_pair_tokens";

// --- types -------------------------------------------------------------------

export type PendingPairToken = {
  nonce: string; // base64-url
  vault_id: string;
  vault_name: string;
  issued_at_ms: number;
  expires_at_ms: number;
  consumed_at_ms?: number;
  consumed_by_device_id?: string;
  /**
   * D-PAIR-WITH-ROLE: role the owner committed to at QR-generation
   * time. The VMC minted in consumePairToken uses THIS role, not a
   * scanner-supplied one — preventing a malicious or buggy scanner
   * from up-claiming a higher role than the owner intended.
   *
   * Optional on disk for back-compat with tokens persisted before
   * D-PAIR-WITH-ROLE; consumePairToken falls back to its `role` arg
   * (which itself defaults to "editor") when this is unset.
   */
  role?: LocalVMCRole;
};

export type PairErrorReason =
  | "not_found"
  | "already_consumed"
  | "expired"
  | "bad_pubkey"
  | "unknown_vault"
  | "vault_not_local_anchored"
  | "no_device_key"
  | "not_trust_anchor"
  | "qr_expired"
  | "vmc_wrong_device"
  | "vmc_malformed_blob"
  | "vmc_malformed_json"
  | "vmc_bad_signature"
  | "vmc_expired"
  | "vmc_invalid"
  | "internal";

export class PairError extends Error {
  reason: PairErrorReason;
  constructor(reason: PairErrorReason) {
    super(`pair: ${reason}`);
    this.reason = reason;
    this.name = "PairError";
  }
}

// --- base64 helpers ----------------------------------------------------------

function bytesToB64Url(bytes: Uint8Array): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  let out = "";
  let i = 0;
  for (; i + 3 <= bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out += alphabet[(n >> 18) & 63];
    out += alphabet[(n >> 12) & 63];
    out += alphabet[(n >> 6) & 63];
    out += alphabet[n & 63];
  }
  if (i < bytes.length) {
    const rem = bytes.length - i;
    const n = (bytes[i] << 16) | ((rem > 1 ? bytes[i + 1] : 0) << 8);
    out += alphabet[(n >> 18) & 63];
    out += alphabet[(n >> 12) & 63];
    if (rem === 2) out += alphabet[(n >> 6) & 63];
  }
  return out;
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

// --- token storage (app_meta) ------------------------------------------------

function isPendingPairToken(x: unknown): x is PendingPairToken {
  if (!x || typeof x !== "object") return false;
  const r = x as Record<string, unknown>;
  return (
    typeof r.nonce === "string" &&
    typeof r.vault_id === "string" &&
    typeof r.vault_name === "string" &&
    typeof r.issued_at_ms === "number" &&
    typeof r.expires_at_ms === "number"
  );
}

async function readPendingTokens(): Promise<PendingPairToken[]> {
  const raw = await getAppMeta(META_KEY_PENDING_PAIR_TOKENS);
  return parsePendingTokensRaw(raw);
}

function parsePendingTokensRaw(raw: string | null): PendingPairToken[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isPendingPairToken);
  } catch {
    return [];
  }
}

// Atomic mutate: SELECT + UPDATE on app_meta join one SQLite transaction.
// Two concurrent calls serialize via the single WAL writer connection,
// so neither sees the other's stale snapshot. Without this, the
// generate/consume/cancel flows are read-modify-write races that
// silently drop tokens (engineering critique #3). The mutator runs
// against `tokens`; whatever it returns is the new array written back.
//
// GC of expired-by->1h tokens happens inside the txn so the bound on
// the JSON blob is enforced atomically too.
async function mutatePendingTokens(
  mutator: (tokens: PendingPairToken[]) => PendingPairToken[] | Promise<PendingPairToken[]>,
): Promise<PendingPairToken[]> {
  const db = await getDb();
  let result: PendingPairToken[] = [];
  await db.withTransactionAsync(async () => {
    const row = await db.getFirstAsync<{ value: string }>(
      "SELECT value FROM app_meta WHERE key = ?",
      META_KEY_PENDING_PAIR_TOKENS,
    );
    const current = parsePendingTokensRaw(row?.value ?? null);
    const next = await mutator(current);
    const cutoff = Date.now() - 60 * 60 * 1000;
    const live = next.filter((t) => t.expires_at_ms > cutoff);
    await db.runAsync(
      `INSERT INTO app_meta (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      META_KEY_PENDING_PAIR_TOKENS,
      JSON.stringify(live),
    );
    result = live;
  });
  return result;
}

// --- public API: owner side --------------------------------------------------

/**
 * Generate a one-use 32-byte pair nonce, persist it as pending (with
 * the owner-selected role), return the base64url-encoded value +
 * expiry. The caller (vault/pair.tsx) embeds the nonce + vault
 * metadata + role into the QR payload.
 *
 * D-PAIR-WITH-ROLE: `role` defaults to "editor" — the safer default
 * when the caller forgets to pass one. The owner picks the role in the
 * UI before the QR renders.
 */
export async function generatePairToken(
  vaultId: string,
  role: LocalVMCRole = "editor",
): Promise<{ nonce: string; expires_at_ms: number }> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ name: string }>(
    `SELECT name FROM vaults WHERE id = ? AND archived_at IS NULL`,
    vaultId,
  );
  if (!row) throw new PairError("unknown_vault");

  const now = Date.now();
  const nonceBytes = await Crypto.getRandomBytesAsync(PAIR_TOKEN_BYTES);
  const nonce = bytesToB64Url(nonceBytes);
  const expires_at_ms = now + PAIR_TOKEN_TTL_MS;

  // Atomic read+append. Without the wrapping txn, two parallel
  // generatePairToken calls (e.g. user re-taps "Show code" while the
  // previous one is still resolving) can each read the same snapshot
  // and clobber the other's write, silently dropping a token.
  await mutatePendingTokens((tokens) => {
    tokens.push({
      nonce,
      vault_id: vaultId,
      vault_name: row.name,
      issued_at_ms: now,
      expires_at_ms,
      role,
    });
    return tokens;
  });

  return { nonce, expires_at_ms };
}

/**
 * Owner consumes a token: verifies it's known + unexpired + unconsumed,
 * then mints a local VMC signed with the owner's device key. The
 * returned blob has the same wire format as a server-issued VMC; the
 * only difference is the `iss` field (LOCAL_ISSUER_TAG) and the
 * signature key.
 *
 * Called from the mesh handshake handler when a peer sends a
 * pair_claim message.
 */
export async function consumePairToken(args: {
  nonce: string;
  peerDevicePubkey: string; // base64
  peerDeviceId: string;
  role?: LocalVMCRole;
}): Promise<{ vmc_blob: string; expires_at_ms: number; vault_id: string }> {
  // Sanity-check the peer pubkey shape BEFORE we touch the token store —
  // a malformed pubkey is a permanent failure for this scan attempt, no
  // reason to reserve a nonce we'd then have to roll back.
  let peerPubkeyBytes: Uint8Array;
  try {
    peerPubkeyBytes = b64ToBytes(args.peerDevicePubkey);
  } catch {
    throw new PairError("bad_pubkey");
  }
  if (peerPubkeyBytes.length !== 32) throw new PairError("bad_pubkey");

  // Reserve-then-mint pattern (engineering critique #3 + security
  // critique pair_token_one_use_atomic_owner_side). The nonce is
  // marked consumed inside a SQLite transaction BEFORE we call
  // issueLocalVMC. If issuance later fails (signing error, vault row
  // missing trust anchor, etc.), we roll back by clearing the
  // consumed_at_ms stamp under the same atomic mutator. The result is
  // a true one-use semantic: two concurrent consumePairToken calls for
  // the same nonce serialize on the WAL writer and exactly one wins.
  const now = Date.now();
  let reserved: PendingPairToken | null = null;
  await mutatePendingTokens((tokens) => {
    const idx = tokens.findIndex((t) => t.nonce === args.nonce);
    if (idx === -1) throw new PairError("not_found");
    const tok = tokens[idx];
    if (tok.consumed_at_ms) throw new PairError("already_consumed");
    if (tok.expires_at_ms <= now) throw new PairError("expired");
    const next: PendingPairToken = {
      ...tok,
      consumed_at_ms: now,
      consumed_by_device_id: args.peerDeviceId,
    };
    tokens[idx] = next;
    reserved = next;
    return tokens;
  });
  if (!reserved) throw new PairError("internal");
  // Typed alias so post-rollback recovery doesn't have to re-narrow.
  const reservedToken: PendingPairToken = reserved;

  try {
    // Fetch vault context.
    const db = await getDb();
    const vault = await db.getFirstAsync<{
      vault_epoch: number;
      account_id: string | null;
      vault_trust_anchor_pubkey: string | null;
    }>(
      `SELECT vault_epoch, account_id, vault_trust_anchor_pubkey
         FROM vaults WHERE id = ?`,
      reservedToken.vault_id,
    );
    if (!vault) throw new PairError("unknown_vault");
    if (!vault.vault_trust_anchor_pubkey) {
      throw new PairError("vault_not_local_anchored");
    }

    // Make sure our own device key is loaded — we'll sign with it.
    await ensureDeviceKey();
    const ownPub = getDevicePubkey();
    if (!ownPub) throw new PairError("no_device_key");
    if (ownPub !== vault.vault_trust_anchor_pubkey) {
      throw new PairError("not_trust_anchor");
    }

    // Local sentinel account_id when the vault has no server account
    // binding. Stable so that two new devices pairing into the same
    // local-only vault see the same account_id, which keeps event ACL
    // checks simple.
    const accountId = vault.account_id ?? buildLocalAccountId(vault.vault_trust_anchor_pubkey);

    // D-PAIR-WITH-ROLE: the role committed at QR-issue time is canonical.
    // A scanner-supplied role can only fill the gap for legacy tokens that
    // pre-date D-PAIR-WITH-ROLE. This prevents a malicious or buggy
    // scanner from minting itself a higher role than the owner
    // intended when the owner re-issued the same nonce.
    const role: LocalVMCRole = reservedToken.role ?? args.role ?? "editor";
    const { blob, expiresAtMs } = await issueLocalVMC({
      vaultId: reservedToken.vault_id,
      peerAccountId: accountId,
      peerDeviceId: args.peerDeviceId,
      peerDevicePubkey: args.peerDevicePubkey,
      role,
      vaultEpoch: vault.vault_epoch ?? 0,
    });

    return {
      vmc_blob: blob,
      expires_at_ms: expiresAtMs,
      vault_id: reservedToken.vault_id,
    };
  } catch (err) {
    // Roll back the reservation so the nonce can be retried (e.g. the
    // owner re-syncs after a transient SecureStore hiccup). Best-effort:
    // a rollback failure leaves the nonce stuck in the consumed state,
    // which is harmless (the owner can re-issue a new code; the stale
    // entry GCs after 1h).
    try {
      await mutatePendingTokens((tokens) => {
        const j = tokens.findIndex((t) => t.nonce === args.nonce);
        if (j !== -1 && tokens[j].consumed_at_ms === now) {
          tokens[j] = {
            ...tokens[j],
            consumed_at_ms: undefined,
            consumed_by_device_id: undefined,
          };
        }
        return tokens;
      });
    } catch (rollbackErr) {
      if (__DEV__) console.warn("[mesh/local-pair] consumePairToken rollback failed", rollbackErr);
    }
    throw err;
  }
}

// --- public API: scanner side ------------------------------------------------

/**
 * Convenience wrapper used by app/vault/pair-scan.tsx: verifies a VMC
 * handed back by the owner against the trust anchor in the QR, then
 * installs the vault row, vault_credentials row, and vault_members_mirror
 * row in a single transaction.
 *
 * NOTE: the over-the-wire mesh exchange is wired in a follow-up phase
 * (BLE peripheral pending). This function is the post-receive install
 * step that takes a vmc_blob the host already obtained from the owner.
 */
export async function verifyAndInstallLocalGrant(args: {
  vaultId: string;
  vaultName: string;
  vaultTrustAnchorPubkey: string; // base64 (32 bytes when decoded)
  vmcBlob: string;
  ownDeviceId: string;
}): Promise<void> {
  let anchorBytes: Uint8Array;
  try {
    anchorBytes = b64ToBytes(args.vaultTrustAnchorPubkey);
  } catch {
    throw new PairError("vmc_bad_signature");
  }
  if (anchorBytes.length !== 32) throw new PairError("vmc_bad_signature");

  // Verify against the QR's trust anchor (not the pinned server pubkey).
  const result = await verifyVMC(args.vmcBlob, args.vaultId, anchorBytes);
  if (!result.valid) {
    const reason: PairErrorReason =
      result.error === "expired"
        ? "vmc_expired"
        : result.error === "bad_signature"
          ? "vmc_bad_signature"
          : result.error === "malformed_blob"
            ? "vmc_malformed_blob"
            : result.error === "malformed_json"
              ? "vmc_malformed_json"
              : "vmc_invalid";
    throw new PairError(reason);
  }
  const vmc = result.vmc;

  // Defense-in-depth: ensure the VMC was issued by the local-CA path
  // (verifyVMC already enforces this via iss check when we pass a trust
  // anchor, but we mirror the assertion here).
  if (vmc.iss !== LOCAL_ISSUER_TAG) throw new PairError("vmc_invalid");

  // Tie-the-knot: the VMC must be addressed to *our* device.
  if (vmc.device_id !== args.ownDeviceId) {
    throw new PairError("vmc_wrong_device");
  }

  const now = Date.now();
  const db = await getDb();
  await db.withTransactionAsync(async () => {
    // 1. Insert vaults row (idempotent on id). account_id is null for
    //    a local sentinel ("local:...") so the local-only mode survives
    //    the round-trip; restoring server sync later will reconcile.
    const existing = await db.getFirstAsync<{ id: string }>(
      `SELECT id FROM vaults WHERE id = ? LIMIT 1`,
      args.vaultId,
    );
    if (!existing) {
      await db.runAsync(
        `INSERT INTO vaults (
           id, name, currency, created_at, updated_at, archived_at,
           is_default, account_id, registered_with_server_at,
           vault_epoch, hlc_logical, hlc_wall_ms,
           vault_trust_anchor_pubkey
         ) VALUES (?, ?, 'AFN', ?, ?, NULL, 0, ?, NULL, ?, 0, 0, ?)`,
        args.vaultId,
        args.vaultName,
        now,
        now,
        vmc.account_id.startsWith("local:") ? null : vmc.account_id,
        vmc.vault_epoch,
        args.vaultTrustAnchorPubkey,
      );
    } else {
      // Backfill the trust anchor on an existing row if it was created
      // earlier without one (e.g. via the Phase 5 server-pair path).
      await db.runAsync(
        `UPDATE vaults
            SET vault_trust_anchor_pubkey = COALESCE(vault_trust_anchor_pubkey, ?)
          WHERE id = ?`,
        args.vaultTrustAnchorPubkey,
        args.vaultId,
      );
    }

    // 2. vault_members_mirror — only for server accounts (NOT local
    //    sentinels). useVaultRole's LOCAL_OWNER_DEFAULT fallback covers
    //    the missing-row case for local-only paths.
    if (!vmc.account_id.startsWith("local:")) {
      await db.runAsync(
        `INSERT OR REPLACE INTO vault_members_mirror
           (vault_id, account_id, role, accepted_at, revoked_at)
         VALUES (?, ?, ?, ?, NULL)`,
        args.vaultId,
        vmc.account_id,
        vmc.role,
        now,
      );
    }
  });

  // 3. Cache the VMC blob for handshake reads. Outside the txn because
  //    cacheVMC owns its own write contract. Idempotent on
  //    (vault_id, device_id).
  await cacheVMC(
    args.vaultId,
    args.vmcBlob,
    vmc.expires_at_ms,
    vmc.account_id,
    vmc.device_pubkey,
    vmc.vault_epoch,
  );
}

// --- diagnostics: pending token introspection (for the QR countdown UI) -----

export async function getPendingPairTokensForVault(vaultId: string): Promise<PendingPairToken[]> {
  const all = await readPendingTokens();
  return all.filter((t) => t.vault_id === vaultId);
}

export async function cancelPairToken(nonce: string): Promise<void> {
  // Atomic filter — keeps two parallel generates/cancels from clobbering
  // each other's view of the array (engineering critique #3).
  await mutatePendingTokens((tokens) => tokens.filter((t) => t.nonce !== nonce));
}

/**
 * Mythos P2c. Mark a pending pair token consumed without deleting it
 * (single-use semantics: the TOFU window for THIS nonce is now closed,
 * but the GC sweep can still see expires_at_ms and prune later). Called
 * by anti-entropy.handshake() after a successful Path C verify.
 *
 * Different from consumePairToken() above (which is the full
 * VMC-minting flow that takes the peer pubkey and issues a VMC for the
 * joiner — currently unused because the live BLE handshake skips that
 * step and uses joiner self-signed VMCs verified via Path C). This
 * function exists solely to flip consumed_at_ms so a SECOND joiner
 * can't reuse the same nonce within the 5-min window.
 */
export async function consumePairNonce(nonce: string): Promise<void> {
  const now = Date.now();
  await mutatePendingTokens((tokens) =>
    tokens.map((t) =>
      t.nonce === nonce && (t.consumed_at_ms == null || t.consumed_at_ms === 0)
        ? { ...t, consumed_at_ms: now }
        : t,
    ),
  );
}

// --- Mythos P2: joiner-side pair_nonce echo store ----------------------------
//
// The JOINER persists the QR's shop_mode_token here AFTER they finish
// the pair-scan flow. The next time they handshake with the matching
// vault, anti-entropy.handshake() reads this and echoes it as
// HelloMessage.pair_nonce. The owner's verifyVMCAgainstPinnedPeer Path C
// uses it to bind TOFU to a specific QR scan (not just "any peer that
// learned the vault_id").
//
// Lifetime: same 5-min TTL as PAIR_TOKEN_TTL_MS. After a successful
// handshake (peer now pinned), anti-entropy.handshake() calls
// clearLocalPairNonceForVault to retire it — subsequent handshakes use
// Path B (pinned credential) instead.

const META_KEY_LOCAL_PAIR_NONCES = "local_pair_nonces";

type LocalPairNonceEntry = {
  vault_id: string;
  nonce: string;
  expires_at_ms: number;
};

function isLocalPairNonceEntry(x: unknown): x is LocalPairNonceEntry {
  if (!x || typeof x !== "object") return false;
  const r = x as Record<string, unknown>;
  return (
    typeof r.vault_id === "string" &&
    typeof r.nonce === "string" &&
    typeof r.expires_at_ms === "number"
  );
}

async function readLocalPairNonces(): Promise<LocalPairNonceEntry[]> {
  const raw = await getAppMeta(META_KEY_LOCAL_PAIR_NONCES);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isLocalPairNonceEntry);
  } catch {
    return [];
  }
}

async function writeLocalPairNonces(entries: LocalPairNonceEntry[]): Promise<void> {
  const now = Date.now();
  const live = entries.filter((e) => e.expires_at_ms > now);
  await setAppMeta(META_KEY_LOCAL_PAIR_NONCES, JSON.stringify(live));
}

/**
 * Joiner side. Called from vault/pair-scan.tsx after a successful join.
 * Replaces any prior entry for the same vault.
 */
export async function setLocalPairNonceForVault(
  vaultId: string,
  nonce: string,
  expiresAtMs: number,
): Promise<void> {
  const existing = await readLocalPairNonces();
  const next = existing.filter((e) => e.vault_id !== vaultId);
  next.push({ vault_id: vaultId, nonce, expires_at_ms: expiresAtMs });
  await writeLocalPairNonces(next);
}

/**
 * Joiner side. Called from anti-entropy.handshake() before building Hello.
 * Returns null when no live entry exists for this vault (either never
 * paired into it on this device, or the 5-min window has elapsed).
 */
export async function getLocalPairNonceForVault(vaultId: string): Promise<string | null> {
  const all = await readLocalPairNonces();
  const now = Date.now();
  const found = all.find((e) => e.vault_id === vaultId && e.expires_at_ms > now);
  return found?.nonce ?? null;
}

/**
 * Joiner side. Called from anti-entropy.handshake() after a successful
 * handshake. The peer is now pinned in vault_credentials, so subsequent
 * handshakes use Path B and don't need the nonce. Single-use semantics
 * defend against replay if a future bug leaks the nonce.
 */
export async function clearLocalPairNonceForVault(vaultId: string): Promise<void> {
  const all = await readLocalPairNonces();
  const next = all.filter((e) => e.vault_id !== vaultId);
  await writeLocalPairNonces(next);
}
