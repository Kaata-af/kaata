// Role enforcement gate for applyEvent (Phase 8 — D-ROLE-ENFORCEMENT-MOBILE).
//
// PROBLEM (founder, 2026-06-08): Phase 7 local-CA hands mesh peers a signed
// VMC that survives offline-forever once minted. If a former editor's device
// re-emits a vault_member_role_changed event after their VMC was minted but
// before revocation gossip reaches a peer, the projection applier blindly
// applies it — the editor self-promotes to owner by mesh propagation alone.
//
// MITIGATION (security reviewer 2026-06-08): the gate now AUTHENTICATES the
// actor via the event's Ed25519 signature, not the wire's claimed
// actor_account_id string. For every event:
//   1. Pre-013 / origin='local' bootstrap exception: if event_sig_b64 is
//      null AND origin in ('local','backfill'), we trust the wire's
//      actor_account_id (local-self appended it before signing was
//      wired; backfill events are synthetic).
//   2. Remote-origin events MUST carry a valid signature OR be refused
//      with reason='unsigned_event'. The signer's device_pubkey is
//      looked up from vault_credentials by (vault_id, device_id) —
//      that row was itself signature-bound via the VMC chain at cache
//      time, so the device_id->account_id->role binding is
//      cryptographically authenticated end-to-end.
//   3. The role-gate uses the LOOKED-UP account_id (from
//      vault_credentials) as the actor for role resolution, NOT the
//      wire's actor_account_id. The latter is informational metadata
//      only — a forged value cannot impersonate the owner because the
//      role-gate ignores it.
//
// This mirrors the server-side ACL check in apps/backend/internal/sync —
// the mesh path now enforces the same lawful-at-HLC ACL as the server-pull
// path AND additionally proves the actor's identity via signature.
//
// PERFORMANCE: large delta syncs can move 10k+ events. A SQL hit per event
// is unacceptable. We cache (vault_id, account_id, hlc-fingerprint) -> role
// in a bounded LRU; the key uses the full HLC tuple so sub-second role
// transitions are not collapsed (engineering critique #1 fix).

import type { SQLiteTx } from "../db-tx";
import { getAccountIdSync } from "../db-tx";
import { verifyEventSignature, type SignableEvent } from "../event-sig";
import type { EventType, LedgerEvent, VaultRole } from "../events";
import type { HLC } from "../hlc";

// ---------- required-role table ----------
//
// Mirrors apps/mobile/lib/vault-roles.ts PERMISSIONS but keyed by event_type
// instead of VaultAction. Kept here (not in vault-roles.ts) because that
// table is action-keyed (UI intent) while applyEvent dispatches on
// event_type (log shape). The two tables must stay aligned; reviewer
// checklist on any new event_type: add a row here AND a column in
// vault-roles PERMISSIONS.
//
// "none" = no role check (the event is its own self-binding). Currently:
//   - account_bound: it IS the binding, can't check itself.

type RoleRequirement = "owner" | "editor" | "none";

const REQUIRED_ROLE: Record<EventType, RoleRequirement> = {
  // Ledger writes — editor or owner
  entry_created: "editor",
  entry_amended: "editor",
  entry_deleted: "editor",
  entry_settled: "editor",

  // People writes — editor or owner (UI gates person.archive at owner-only,
  // but the projection gate stays at 'editor' — projection's job is to
  // refuse outright attacks, not enforce nuanced per-action UI policy).
  person_added: "editor",
  person_renamed: "editor",
  person_phone_changed: "editor",
  person_archived: "editor",
  person_unarchived: "editor",

  // Vault config — owner only
  shop_profile_updated: "owner",
  vault_setting_set: "owner",

  // Vault membership — owner only (the attack vector this gate exists for)
  vault_member_added: "owner",
  vault_member_role_changed: "owner",
  vault_member_removed: "owner",

  // Self-binding event — cannot be role-checked (the event itself BINDS
  // the actor to an account). Dispatch unconditionally.
  account_bound: "none",
};

function meetsRequirement(actor: VaultRole, required: "owner" | "editor"): boolean {
  if (required === "owner") return actor === "owner";
  // required === "editor": editor or owner satisfies it
  return actor === "owner" || actor === "editor";
}

// ---------- LRU role cache ----------
//
// Key: `${vault_id}\0${account_id}\0${pms}-${l}-${did}` keyed on the
// FULL HLC tuple. Engineering critique #1 fix: the previous
// floor-to-1-second bucketing collapsed two events on either side of a
// sub-second role transition into the same cache key, returning a
// stale role for the post-change event. The full-HLC key is uniquely
// identified per event so a stale read is structurally impossible
// (different events with different HLCs miss the cache and resolve
// fresh; two appliers of the SAME event already short-circuit via
// INSERT OR IGNORE before reaching here).

const ROLE_CACHE_MAX = 1024;
const roleCache = new Map<string, VaultRole | null>();

function cacheKey(vaultId: string, accountId: string, hlc: HLC): string {
  // Engineering critique: separator must be a character that cannot
  // appear in vault_id / account_id / device_id. We previously used a
  // space — vault_id is opaque but no spec forbids a space — so two
  // distinct (vault_id, account_id) pairs could theoretically collide
  // (e.g. vault_id="foo " + account_id="bar" vs vault_id="foo" +
  // account_id=" bar"). The HLC tail (pms-l-did) is fine because pms is
  // a number and `-` is a fixed separator inside it, but the leading
  // ids need a separator no row can produce. NUL ("\0") is illegal in
  // every reasonable id format (it terminates C strings, breaks SQLite
  // text, etc.) and is what the comment block above promised.
  return `${vaultId}\0${accountId}\0${hlc.pms}-${hlc.l}-${hlc.did}`;
}

function cacheGet(key: string): VaultRole | null | undefined {
  if (!roleCache.has(key)) return undefined;
  // LRU touch: re-insert moves to end.
  const v = roleCache.get(key);
  roleCache.delete(key);
  roleCache.set(key, v as VaultRole | null);
  return v as VaultRole | null;
}

function cacheSet(key: string, role: VaultRole | null): void {
  if (roleCache.has(key)) roleCache.delete(key);
  roleCache.set(key, role);
  if (roleCache.size > ROLE_CACHE_MAX) {
    // Evict oldest (first inserted).
    const firstKey = roleCache.keys().next().value;
    if (firstKey !== undefined) roleCache.delete(firstKey);
  }
}

// Exported so lib/use-vault-role.invalidateVaultRoleCache can blow away
// this process-local cache too whenever vault_members_mirror mutates.
// Without this hook, an in-flight delta-sync batch could observe a stale
// role across the mirror update boundary.
export function invalidateRoleGateCache(vaultId?: string): void {
  if (vaultId == null) {
    roleCache.clear();
    return;
  }
  const prefix = `${vaultId} `;
  for (const k of Array.from(roleCache.keys())) {
    if (k.startsWith(prefix)) roleCache.delete(k);
  }
}

// ---------- role resolution ----------
//
// Resolves the actor's role IN this vault AT the given HLC. Strategy:
//
//   1. Scan event_log for the most recent vault_member_* event targeting
//      (vault_id, account_id) with HLC STRICTLY LESS THAN event.hlc.
//      EXCLUDES the event being applied (which may not have committed
//      yet anyway, and a vault_member_role_changed event cannot
//      self-authorize).
//   2. If that event is vault_member_removed -> role is null (revoked).
//   3. If vault_member_added or vault_member_role_changed -> role from
//      payload.
//   4. If no membership event in log -> fall back to vault_credentials:
//      if a VMC was issued for (vault_id, account_id) at issued_at <=
//      event.hlc.pms, use the VMC's role (mesh-issued local-CA path —
//      the QR carried the role per Phase A).
//   5. If no VMC either -> null (unknown / unauthenticated actor).
//
// Security critique #4 fix: the SQL upper-bound clause now uses STRICT
// less-than on the HLC device-id tiebreak (was `<=`) — at parity of
// (pms, l, did) we have the same event identity, which the
// `excludingEventId` filter would already catch, but tightening the
// comparison eliminates any "look-alike but different event_id"
// pathology and matches compareHLC() semantics exactly.
async function resolveRoleAt(
  tx: SQLiteTx,
  vaultId: string,
  accountId: string,
  atHlc: HLC,
  excludingEventId: string,
): Promise<VaultRole | null> {
  // Step 1-3: most recent membership event with HLC < atHlc, not self.
  const row = await tx.getFirstAsync<{
    event_type: string;
    payload_json: string;
  }>(
    `SELECT event_type, payload_json
       FROM event_log
      WHERE vault_id = ?
        AND event_type IN
              ('vault_member_added',
               'vault_member_role_changed',
               'vault_member_removed')
        AND target_id = ?
        AND event_id != ?
        AND ( hlc_physical_ms < ?
              OR (hlc_physical_ms = ? AND hlc_logical < ?)
              OR (hlc_physical_ms = ? AND hlc_logical = ? AND hlc_device_id < ?)
            )
      ORDER BY hlc_physical_ms DESC, hlc_logical DESC, hlc_device_id DESC
      LIMIT 1`,
    vaultId,
    accountId,
    excludingEventId,
    atHlc.pms,
    atHlc.pms,
    atHlc.l,
    atHlc.pms,
    atHlc.l,
    atHlc.did,
  );
  if (row != null) {
    if (row.event_type === "vault_member_removed") return null;
    try {
      const p = JSON.parse(row.payload_json) as { role?: VaultRole };
      if (p.role === "owner" || p.role === "editor" || p.role === "viewer") {
        return p.role;
      }
    } catch {
      /* fall through to VMC lookup */
    }
  }

  // Step 4: VMC fallback. The local-CA pair flow (Phase A) embeds the
  // role in the issued VMC even though there's no vault_member_added
  // event yet. vault_credentials.vmc_blob is the signed VMC; rather
  // than re-verifying the signature here (the mesh handshake already
  // did), we extract the role field directly. The blob being present
  // means cacheVMC accepted it earlier.
  const vmcRow = await tx.getFirstAsync<{ vmc_blob: string; issued_at: number }>(
    `SELECT vmc_blob, issued_at
       FROM vault_credentials
      WHERE vault_id = ?
        AND account_id = ?
        AND issued_at <= ?
      ORDER BY issued_at DESC
      LIMIT 1`,
    vaultId,
    accountId,
    atHlc.pms,
  );
  if (vmcRow != null) {
    const role = extractRoleFromVmcBlob(vmcRow.vmc_blob);
    if (role != null) return role;
  }

  return null;
}

// Best-effort role extraction from a base64-encoded VMC JSON blob.
// Format mirrors mesh/local-vmc.ts issueLocalVMC: payload has fields
// { v, vault_id, account_id, device_id, device_pubkey, role,
//   vault_epoch, issued_at_ms, expires_at_ms, iss } encoded as base64
// followed by "." and the base64-encoded signature.
//
// We're trusting the persisted blob here because vault_credentials only
// receives blobs that passed verifyAndCacheVMC's signature check, OR
// were minted by THIS device (vault/new.tsx and consumePairToken both
// cache freshly-minted owner-signed VMCs). cacheVMC is a low-level
// helper not exposed to untrusted callers.
function extractRoleFromVmcBlob(blob: string): VaultRole | null {
  try {
    const dot = blob.indexOf(".");
    const headerB64 = dot >= 0 ? blob.slice(0, dot) : blob;
    // eslint-disable-next-line no-undef
    const bin = atob(headerB64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i) & 0xff;
    // Hermes ships TextDecoder on RN >= 0.74 — engineering critique #10
    // (replace the hand-rolled UTF-8 decoder).
    // eslint-disable-next-line no-undef
    const json = new TextDecoder().decode(bytes);
    const parsed = JSON.parse(json) as { role?: VaultRole };
    if (parsed.role === "owner" || parsed.role === "editor" || parsed.role === "viewer") {
      return parsed.role;
    }
  } catch {
    /* malformed blob — fall through */
  }
  return null;
}

// ---------- public gate ----------
//
// Called from applyEvent BEFORE the type-specific applier dispatch.
// Returns:
//   { ok: true }                              — proceed with dispatch
//   { ok: false, reason, current_role,
//     required_role }                          — log to projection_conflicts,
//                                                SKIP dispatch (event still
//                                                lands in event_log for audit
//                                                + replay)
export type RoleGateResult =
  | { ok: true }
  | {
      ok: false;
      reason: "insufficient_role" | "unknown_actor" | "unsigned_event" | "bad_signature";
      current_role: VaultRole | null;
      required_role: "owner" | "editor";
    };

// Look up the authenticated (account_id, device_pubkey) for the signer
// of a remote-origin event. The lookup is keyed on the event's
// device_id; the row in vault_credentials was itself signature-bound
// at cache time via the VMC chain, so the (device_id -> account_id,
// device_pubkey) mapping is cryptographically authenticated.
//
// Returns null when no credential row exists for the (vault_id,
// device_id) pair — i.e. the peer's VMC has not yet been gossiped to
// this device. Caller refuses the event in that case (unknown_actor).
async function lookupSignerCredential(
  tx: SQLiteTx,
  vaultId: string,
  deviceId: string,
): Promise<{ account_id: string; device_pubkey: string } | null> {
  const row = await tx.getFirstAsync<{ account_id: string; device_pubkey: string }>(
    `SELECT account_id, device_pubkey
       FROM vault_credentials
      WHERE vault_id = ? AND device_id = ?
      LIMIT 1`,
    vaultId,
    deviceId,
  );
  return row ?? null;
}

export async function checkRoleForEvent(tx: SQLiteTx, event: LedgerEvent): Promise<RoleGateResult> {
  const requirement = REQUIRED_ROLE[event.event_type];
  if (requirement === "none") return { ok: true };
  if (event.vault_id == null) {
    // applyEvent already rejects this for local origin; remote/backfill
    // events with null vault_id are legacy pre-migration-007 rows that
    // the gate cannot reason about. Bypass.
    return { ok: true };
  }

  // ----------------------------------------------------------------------
  // SECURITY: authenticate the actor.
  //
  //   - origin='local':   the appending device is local-self; we trust
  //                       its own writes implicitly. (Per-action UI gates
  //                       in vault-roles.ts already refuse non-owner
  //                       attempts; this gate is a defense-in-depth
  //                       layer for replayed-from-mesh attacks.) If the
  //                       event was signed (steady state from Phase 8
  //                       onward) the wire's actor_account_id matches
  //                       the local account binding; we trust the wire.
  //   - origin='backfill': synthetic event from migration 006; unsigned
  //                       by definition. Treat as trusted (it represents
  //                       a pre-Phase-8 row authored by local-self).
  //   - origin='remote':  the actor identity is whatever the SIGNATURE
  //                       authenticates. The wire's actor_account_id is
  //                       informational metadata; the role-gate uses
  //                       the looked-up account_id from
  //                       vault_credentials (keyed on device_id).
  //
  // ----------------------------------------------------------------------
  let actorAccountId = event.actor_account_id;

  if (event.origin === "remote") {
    const sig = event.event_sig_b64;
    if (!sig) {
      // Unsigned remote event — refuse outright. Phase 8 contract: every
      // event crossing the wire from another device MUST carry a
      // signature. This closes the membership-event forgery attack
      // (SECURITY #2/#3).
      return {
        ok: false,
        reason: "unsigned_event",
        current_role: null,
        required_role: requirement,
      };
    }
    // Authenticate via the SIGNER's device_pubkey. Lookup is keyed on
    // device_id; vault_credentials was populated via verifyAndCacheVMC
    // (signature-bound) so the device_id -> (account_id, device_pubkey)
    // mapping is itself authenticated.
    let signerPubkey: string | null = event.signer_device_pubkey ?? null;
    let authenticatedAccountId: string | null = null;
    const cred = await lookupSignerCredential(tx, event.vault_id, event.device_id);
    if (cred != null) {
      // Prefer the credential-bound pubkey: it's what authentication
      // rests on. If the envelope-claimed pubkey disagrees, refuse —
      // an attacker who stole an event row cannot present a different
      // pubkey to dodge the credential binding.
      if (signerPubkey != null && signerPubkey !== cred.device_pubkey) {
        return {
          ok: false,
          reason: "bad_signature",
          current_role: null,
          required_role: requirement,
        };
      }
      signerPubkey = cred.device_pubkey;
      authenticatedAccountId = cred.account_id;
    } else if (signerPubkey != null) {
      // No credential row yet (the peer's VMC hasn't been gossiped to
      // us). We can still cryptographically verify the signature
      // against the envelope-claimed pubkey, but we have NO way to
      // bind that pubkey to an account_id without the VMC. Refuse as
      // unknown_actor — wait for the VMC to land first, then this
      // event re-applies cleanly on the next pass (event_log row
      // stays via INSERT OR IGNORE; only the projection update is
      // skipped).
      return {
        ok: false,
        reason: "unknown_actor",
        current_role: null,
        required_role: requirement,
      };
    } else {
      // No credential AND no envelope pubkey: structurally
      // unauthenticated.
      return {
        ok: false,
        reason: "unsigned_event",
        current_role: null,
        required_role: requirement,
      };
    }

    // Cryptographically verify the signature over the canonical
    // event bytes. ANY tampering (vault_id, hlc, payload,
    // actor_account_id, device_id) invalidates the signature.
    const signable: SignableEvent = {
      event_id: event.event_id,
      event_type: event.event_type,
      vault_id: event.vault_id,
      target_id: event.target_id,
      relationship_id: event.relationship_id,
      hlc: event.hlc,
      device_id: event.device_id,
      actor_account_id: event.actor_account_id,
      payload: event.payload,
      payload_schema: event.payload_schema,
    };
    const verify = verifyEventSignature(signable, sig, signerPubkey);
    if (!verify.valid) {
      return {
        ok: false,
        reason: "bad_signature",
        current_role: null,
        required_role: requirement,
      };
    }
    // Authentication succeeded. Use the CREDENTIAL-BOUND account_id
    // for role resolution, ignoring the wire's actor_account_id.
    actorAccountId = authenticatedAccountId;
  } else {
    // origin in ('local','backfill') — trust the wire's claim.
    if (actorAccountId == null && event.origin === "local") {
      actorAccountId = getAccountIdSync();
    }
  }

  // LOCAL-ONLY OWNER fallback. The founder constraint "local-only mode
  // must remain 100% functional" plus the local-CA model (device creator
  // is the trust anchor) means: when no account is bound, the device's
  // own writes are implicitly owner-authored. This MUST NOT fire for
  // origin='remote' events — for those we already required the
  // signature verification above.
  if (actorAccountId == null) {
    if (event.origin === "remote") {
      return {
        ok: false,
        reason: "unknown_actor",
        current_role: null,
        required_role: requirement,
      };
    }
    return { ok: true };
  }

  // Cache hit?
  const key = cacheKey(event.vault_id, actorAccountId, event.hlc);
  let role = cacheGet(key);
  if (role === undefined) {
    role = await resolveRoleAt(tx, event.vault_id, actorAccountId, event.hlc, event.event_id);
    cacheSet(key, role);
  }

  if (role == null) {
    // Unknown actor at this HLC. On local origin (the device's own
    // implicit writes for a vault it owns), give the benefit of the
    // doubt — this protects the "no membership event seeded yet, no
    // VMC issued yet" cold-start path. On remote origin we refuse.
    if (event.origin === "remote") {
      return {
        ok: false,
        reason: "unknown_actor",
        current_role: null,
        required_role: requirement,
      };
    }
    return { ok: true };
  }
  if (!meetsRequirement(role, requirement)) {
    return {
      ok: false,
      reason: "insufficient_role",
      current_role: role,
      required_role: requirement,
    };
  }

  // Last-owner protection (security critique #8): membership events
  // that would leave the vault with ZERO owners are refused at the
  // applier layer, not just the UI. This catches: (a) a forged event
  // demoting the last owner via a stolen owner-device's signature,
  // (b) a locally-rebuilt mobile attacker that bypasses the UI guard.
  if (
    event.event_type === "vault_member_role_changed" ||
    event.event_type === "vault_member_removed"
  ) {
    const wouldLeaveOwnerless = await wouldDropLastOwner(tx, event);
    if (wouldLeaveOwnerless) {
      return {
        ok: false,
        reason: "insufficient_role",
        current_role: role,
        required_role: requirement,
      };
    }
  }

  return { ok: true };
}

// Last-owner check. Returns true if applying this event would leave the
// vault with zero owners. Used by the role-gate to refuse the event
// before the applier mutates the mirror. Scans vault_members_mirror
// joined to the live event_log to compute the post-application owner
// set without actually applying anything.
async function wouldDropLastOwner(tx: SQLiteTx, event: LedgerEvent): Promise<boolean> {
  if (event.vault_id == null) return false;
  let targetAccountId: string | null = null;
  let newRole: VaultRole | null = null;
  if (event.event_type === "vault_member_role_changed") {
    const p = event.payload as { account_id: string; role: VaultRole };
    targetAccountId = p.account_id;
    newRole = p.role;
  } else if (event.event_type === "vault_member_removed") {
    const p = event.payload as { account_id: string };
    targetAccountId = p.account_id;
    newRole = null; // removed
  } else {
    return false;
  }
  if (newRole === "owner") return false; // promoting to owner cannot drop owners

  // Count owners NOT including the target row.
  const row = await tx.getFirstAsync<{ owner_count: number }>(
    `SELECT COUNT(*) AS owner_count
       FROM vault_members_mirror
      WHERE vault_id = ?
        AND role = 'owner'
        AND revoked_at IS NULL
        AND account_id != ?`,
    event.vault_id,
    targetAccountId,
  );
  const otherOwners = row?.owner_count ?? 0;
  // If the target was an owner and there are no OTHER owners, this
  // event would leave the vault ownerless.
  const targetRow = await tx.getFirstAsync<{ role: VaultRole; revoked_at: number | null }>(
    `SELECT role, revoked_at FROM vault_members_mirror
      WHERE vault_id = ? AND account_id = ? LIMIT 1`,
    event.vault_id,
    targetAccountId,
  );
  const targetWasOwner =
    targetRow != null && targetRow.role === "owner" && targetRow.revoked_at == null;
  return targetWasOwner && otherOwners === 0;
}

// ---------- conflict writer ----------
//
// Records a role-gated reject into projection_conflicts using a fresh
// `kind` discriminator. The UI hook (lib/projection-conflicts) surfaces
// rows uniformly across server-side and local-side rejections.
export async function recordRoleGateReject(
  tx: SQLiteTx,
  event: LedgerEvent,
  result: Extract<RoleGateResult, { ok: false }>,
): Promise<void> {
  const detail = {
    event_id: event.event_id,
    event_type: event.event_type,
    reason: result.reason,
    current_role: result.current_role,
    required_role: result.required_role,
    rejected_by: "local_role_gate",
    actor_account_id: event.actor_account_id,
    hlc_pms: event.hlc.pms,
  };
  await tx.runAsync(
    `INSERT INTO projection_conflicts (kind, vault_id, detail_json, created_at)
     VALUES (?, ?, ?, ?)`,
    "event_rejected_by_local_role_gate",
    event.vault_id,
    JSON.stringify(detail),
    Date.now(),
  );
}
