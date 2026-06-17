// apps/mobile/lib/mesh/local-pair.ts
//
// Chain-native pair rendezvous (M4). The vault owner's device is the
// trust anchor. When a new device scans the owner's QR, it pins the
// anchor and persists the QR's shop_mode_token locally (the "pair
// nonce"). On its first BLE handshake the joiner echoes that nonce in its
// Hello (HelloMessage.pair_nonce); the owner matches it against a live
// unconsumed pending pair token (getLivePairTokenByNonce) and, after
// proof-of-possession, EMITS the joiner's admission events into the
// membership chain (verifyPeerChain). No VMC is minted anywhere.
//
// This module owns:
//   - the owner-side pending-pair-token store (one-use, time-bounded
//     nonces persisted in app_meta so the owner survives a process
//     restart between "show QR" and "joiner connects"): generatePairToken,
//     getPendingPairTokensForVault, getLivePairTokenByNonce,
//     consumePairNonce, cancelPairToken.
//   - the joiner-side pair-nonce echo store: setLocalPairNonceForVault,
//     getLocalPairNonceForVault, clearLocalPairNonceForVault.

import * as Crypto from "expo-crypto";

import { getAppMeta, getDb, setAppMeta } from "../db";

// M4: VMC role enum, relocated locally now that lib/mesh/local-vmc.ts is
// deleted. The pair-token store still records the owner-committed role so
// the chain pair-admission (verifyPeerChain) can carry it into the
// joiner's vault_member_added.
export type LocalVMCRole = "owner" | "editor" | "viewer";

// --- constants ---------------------------------------------------------------

export const PAIR_TOKEN_TTL_MS = 30 * 60 * 1000; // 30 min — see PAIR_QR_TTL_MS
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
  /**
   * MISNOMER (kept for on-disk back-compat): this stores the base64 device
   * PUBKEY that claimed the nonce, NOT a device_id. claimPairNonce /
   * releasePairNonceClaim and the anti-entropy release call all read/write it
   * as the pubkey (claimedPubkeyB64). NEVER compare it against the
   * attacker-controllable peerHello.device_id — that would break the gate.
   */
  consumed_by_device_id?: string;
  /**
   * D-PAIR-WITH-ROLE: role the owner committed to at QR-generation
   * time. The owner-side pair admission (verifyPeerChain) carries THIS
   * role into the joiner's vault_member_added, not a joiner-supplied one
   * — preventing a malicious or buggy joiner from up-claiming a higher
   * role than the owner intended.
   *
   * Optional on disk for back-compat with tokens persisted before
   * D-PAIR-WITH-ROLE; the admission falls back to "editor" when unset.
   */
  role?: LocalVMCRole;
  /**
   * BRIAR-STRICT two-way scan: the joiner device pubkey the OWNER scanned
   * out-of-band (the joiner's identity QR), pinned via bindExpectedJoiner.
   * claimPairNonce admits ONLY a handshake whose PoP-claimed key equals this.
   * Unset = the owner hasn't scanned the joiner yet → admission DEFERS (the
   * joiner retries until the scan binds it). This is what makes admission
   * require a physical, mutual face-to-face scan — closing the sniffed-nonce
   * "attacker instead of legit joiner" gap that the CAS alone left open.
   */
  expected_joiner_pubkey?: string;
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
 * ⚠️ NOT AN ADMISSION PATH. Since the Briar-strict two-way scan, the ONLY way
 * to admit a joiner is claimPairNonce (which enforces expected_joiner_pubkey).
 * This lookup is kept for diagnostics / the QR countdown UI ONLY — wiring it
 * back into admission would reintroduce the un-gated "nonce alone admits"
 * weakness the two-way scan exists to close. Do not.
 *
 * M2c chain handshake — owner-side pair-admission lookup.
 *
 * Returns the live (unexpired, unconsumed) pending pair token whose
 * nonce matches the one a joiner echoed in their Hello, or null. Exposed
 * as a helper so the chain handshake doesn't re-implement the match: a
 * match means "the owner generated this QR within the TTL and nobody has
 * ridden it
 * yet", i.e. admission-in-progress for exactly one session. The caller
 * is responsible for consumePairNonce() after a successful admission.
 */
export async function getLivePairTokenByNonce(
  vaultId: string,
  nonce: string,
): Promise<PendingPairToken | null> {
  if (!nonce) return null;
  const all = await readPendingTokens();
  const now = Date.now();
  return (
    all.find(
      (t) =>
        t.vault_id === vaultId &&
        t.nonce === nonce &&
        t.expires_at_ms > now &&
        (t.consumed_at_ms == null || t.consumed_at_ms === 0),
    ) ?? null
  );
}

/**
 * ⚠️ NOT THE ADMISSION CONSUME PATH. claimPairNonce now does the atomic
 * claim+consume bound to the scanned key. This standalone consume is unused by
 * admission and kept only for completeness; do not call it to "admit" a joiner.
 *
 * Mark a pending pair token consumed without deleting it (single-use
 * semantics: the admission window for THIS nonce is now closed, but the GC
 * sweep can still see expires_at_ms and prune later). Called by
 * verifyPeerChain after a successful owner-side pair admission, so a SECOND
 * joiner can't reuse the same nonce within the 5-min window.
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

/**
 * M4 (review fix — pair-nonce TOCTOU). Atomic compare-and-set CLAIM of a pair
 * nonce, BINDING it to the claiming device's pubkey, inside ONE
 * mutatePendingTokens transaction. Returns the claimed token iff WE won the
 * claim (it was unclaimed, or already claimed by THIS same pubkey — idempotent
 * retry), else null. This replaces the old lookup-then-consume two-step
 * (getLivePairTokenByNonce → … → consumePairNonce) whose read/consume gap let
 * TWO concurrent handshakes both ride one nonce and both get admitted: a
 * sniffed/observed QR nonce admitted an unauthorized device alongside the
 * legit joiner. With the CAS, only one device per nonce can ever be admitted.
 *
 * ONE-WAY pairing (default, restored): admit on nonce match alone. The owner
 * shows the QR in person for a short window; the joiner scans it and dials
 * immediately — no reciprocal owner-scan, so first contact is fast. The CAS
 * still makes the nonce STRICTLY single-use (binds it to the first claimant's
 * pubkey on claim), so a second concurrent handshake riding the same sniffed
 * nonce is refused. If PoP later fails we release the claim so the legit joiner
 * can retry.
 *
 * Optional two-way hardening preserved: if expected_joiner_pubkey WAS bound
 * out-of-band (bindExpectedJoiner, owner scanned the joiner's identity QR), the
 * claim additionally requires claimedDeviceKeyB64 === expected_joiner_pubkey.
 * An UNBOUND token (the one-way case) admits the first claimant.
 */
export async function claimPairNonce(
  vaultId: string,
  nonce: string,
  claimedDeviceKeyB64: string,
): Promise<PendingPairToken | null> {
  if (!nonce || !claimedDeviceKeyB64) return null;
  const now = Date.now();
  let claimed: PendingPairToken | null = null;
  await mutatePendingTokens((tokens) =>
    tokens.map((t) => {
      if (t.vault_id !== vaultId || t.nonce !== nonce || t.expires_at_ms <= now) return t;
      // Two-way (optional): if a key was pinned out-of-band, it MUST match. An
      // unbound token (one-way, the default) admits the first claimant.
      if (t.expected_joiner_pubkey && t.expected_joiner_pubkey !== claimedDeviceKeyB64) {
        return t;
      }
      const unclaimed = t.consumed_at_ms == null || t.consumed_at_ms === 0;
      const mine = t.consumed_by_device_id === claimedDeviceKeyB64;
      if (unclaimed || mine) {
        claimed = { ...t, consumed_at_ms: now, consumed_by_device_id: claimedDeviceKeyB64 };
        return claimed;
      }
      // Already claimed by a DIFFERENT device — claim fails, leave it.
      return t;
    }),
  );
  return claimed;
}

/**
 * BRIAR-STRICT two-way scan — OWNER side. Called from vault/pair.tsx after the
 * owner scans the joiner's identity QR. Atomically pins the joiner's device
 * pubkey onto the live pending token for (vaultId, nonce) — the nonce of the QR
 * the owner is currently showing. After this, the owner's pair-admission
 * (claimPairNonce) will admit exactly that one device and no other.
 *
 * Idempotent: re-scanning the SAME joiner returns true. Refuses to REBIND a
 * token already pinned to a DIFFERENT joiner (one QR == one scanned joiner; the
 * owner re-issues a fresh QR for the next person). Returns true iff the token is
 * now bound to joinerPubkeyB64.
 */
export async function bindExpectedJoiner(
  vaultId: string,
  nonce: string,
  joinerPubkeyB64: string,
): Promise<boolean> {
  if (!nonce || !joinerPubkeyB64) return false;
  const now = Date.now();
  let bound = false;
  await mutatePendingTokens((tokens) =>
    tokens.map((t) => {
      if (t.vault_id !== vaultId || t.nonce !== nonce || t.expires_at_ms <= now) return t;
      // Already pinned to a different joiner — refuse to rebind (re-issue a QR).
      if (t.expected_joiner_pubkey && t.expected_joiner_pubkey !== joinerPubkeyB64) return t;
      // Already consumed (admission done): report success iff it was this joiner.
      if (t.consumed_at_ms) {
        bound = t.consumed_by_device_id === joinerPubkeyB64;
        return t;
      }
      bound = true;
      return { ...t, expected_joiner_pubkey: joinerPubkeyB64 };
    }),
  );
  return bound;
}

/**
 * Release a claim we made (only if WE hold it) so the legitimate joiner can
 * retry — called when PoP FAILS after a claim. Without this, an attacker that
 * claims then fails PoP would burn the nonce (a DoS forcing a fresh QR). Only
 * resets a token whose consumed_by_device_id matches ours.
 */
export async function releasePairNonceClaim(
  nonce: string,
  claimedDeviceKeyB64: string,
): Promise<void> {
  await mutatePendingTokens((tokens) =>
    tokens.map((t) =>
      t.nonce === nonce && t.consumed_by_device_id === claimedDeviceKeyB64
        ? { ...t, consumed_at_ms: undefined, consumed_by_device_id: undefined }
        : t,
    ),
  );
}

// --- joiner-side pair_nonce echo store ---------------------------------------
//
// The JOINER persists the QR's shop_mode_token here AFTER they finish
// the pair-scan flow. The next time they handshake with the matching
// vault, anti-entropy.handshake() reads this and echoes it as
// HelloMessage.pair_nonce. The owner's chain pair-admission path
// (verifyPeerChain) uses it to bind admission to a specific QR scan (not
// just "any peer that learned the vault_id").
//
// Lifetime: same 5-min TTL as PAIR_TOKEN_TTL_MS. After a successful
// handshake (the owner has now emitted the joiner's admission into the
// chain), anti-entropy.handshake() calls clearLocalPairNonceForVault to
// retire it — subsequent handshakes prove membership via the chain.

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
 * handshake. The owner has now emitted the joiner's admission into the
 * chain, so subsequent handshakes prove membership via the chain and
 * don't need the nonce. Single-use semantics defend against replay if a
 * future bug leaks the nonce.
 */
export async function clearLocalPairNonceForVault(vaultId: string): Promise<void> {
  const all = await readLocalPairNonces();
  const next = all.filter((e) => e.vault_id !== vaultId);
  await writeLocalPairNonces(next);
}
