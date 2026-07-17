// Role enforcement gate for applyEvent (D-ROLE-ENFORCEMENT-MOBILE).
//
// PROBLEM: a former editor's device that re-emits a
// vault_member_role_changed event must not be able to self-promote by mesh
// propagation — the projection applier must not blindly apply role-bearing
// events authored by an unauthorized actor.
//
// MITIGATION: the gate AUTHENTICATES the actor via the event's Ed25519
// signature, not the wire's claimed actor_account_id string. For every
// event:
//   1. Pre-013 / origin='local' bootstrap exception: if event_sig_b64 is
//      null AND origin in ('local','backfill'), we trust the wire's
//      actor_account_id (local-self appended it before signing was
//      wired; backfill events are synthetic).
//   2. Remote-origin events MUST carry a valid signature OR be refused
//      with reason='unsigned_event'. The signer's device_pubkey ->
//      account_id binding is resolved from the membership-chain device
//      registry (vault_device_registry, the fold of owner-signed /
//      witnessed vault_device_added events) — so the
//      device_id->account_id->role binding is cryptographically
//      authenticated end-to-end against the vault anchor (M4: the chain is
//      the sole trust source; the legacy VMC fallback is retired).
//   3. The role-gate uses the LOOKED-UP account_id (from the chain) as the
//      actor for role resolution, NOT the wire's actor_account_id. The
//      latter is informational metadata only — a forged value cannot
//      impersonate the owner because the role-gate ignores it.
//
// This mirrors the server-side ACL check in apps/backend/internal/sync —
// the mesh path enforces the same lawful-at-HLC ACL as the server-pull
// path AND additionally proves the actor's identity via signature.
//
// PERFORMANCE: large delta syncs can move 10k+ events. A SQL hit per event
// is unacceptable. We cache (vault_id, account_id, hlc-fingerprint) -> role
// in a bounded LRU; the key uses the full HLC tuple so sub-second role
// transitions are not collapsed (engineering critique #1 fix).

import type { SQLiteTx } from "../db-tx";
import { getAccountIdSync } from "../db-tx";
import { resolveAccountIdCandidates } from "../effective-account";
import { verifyEventSignature, type SignableEvent } from "../event-sig";
import type { EventType, LedgerEvent, VaultRole } from "../events";
import { compareHLC, type HLC } from "../hlc";
import {
  deviceWitnessTuple,
  memberWitnessTuple,
  WITNESS_FRESHNESS_MS,
  type MembershipWitnessLike,
} from "../trust/chain";
import { runtimeChainCrypto } from "../trust/crypto-runtime";

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

  // M2 device binding — owner only, with two carve-outs handled inline in
  // checkRoleForEvent: (a) witnessed self-binding (online invite path),
  // (b) a member removing their own account's other device.
  vault_device_added: "owner",
  vault_device_removed: "owner",

  // Self-binding event — cannot be role-checked (the event itself BINDS
  // the actor to an account). Dispatch unconditionally.
  account_bound: "none",
};

function meetsRequirement(actor: VaultRole, required: "owner" | "editor"): boolean {
  if (required === "owner") return actor === "owner";
  // required === "editor": editor or owner satisfies it
  return actor === "owner" || actor === "editor";
}

// Privilege rank for picking the highest role across this device's account-id
// candidates (local-origin multi-id resolution). null = no membership.
function rankRole(r: VaultRole | null): number {
  return r === "owner" ? 3 : r === "editor" ? 2 : r === "viewer" ? 1 : 0;
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
  // SEPARATOR MUST MATCH cacheKey() above — NUL ("\0"), not space.
  // The prefix-based per-vault eviction was a no-op for years because
  // this used " " while cacheKey() built with "\0". Effect: after a
  // role demotion landed, the next event in the same delta batch passed
  // a stale cached role check → silent privilege-escalation by timing.
  // The roleCache.clear() path (vaultId == null) still worked because
  // it doesn't rely on the separator.
  const prefix = `${vaultId}\0`;
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
//   4. If no membership event in log -> null (unknown / unauthenticated
//      actor). M4: the membership chain is the sole role source — there is
//      no VMC fallback. Every member carries a vault_member_added, so a
//      null here means the chain hasn't reached this device yet and the
//      event quarantines until it does.
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
    // SECURITY (M2 review — privilege escalation): only APPLIED membership
    // events grant role. A role-gate-refused event (e.g. an editor's own
    // self-promotion vault_member_role_changed{role:owner}) stays in
    // event_log with applied_at=NULL + quarantine_reason
    // (projection/index.ts). Without this filter, that refused event would
    // resolve the editor to 'owner' for their NEXT owner-only event, which
    // would then APPLY on every replica — an escalation the chain fold
    // refuses (gate/fold divergence). The fold (lib/trust/chain.ts) only
    // ever derives role from authorized events; this makes the apply gate
    // agree.
    `SELECT event_type, payload_json
       FROM event_log
      WHERE vault_id = ?
        AND event_type IN
              ('vault_member_added',
               'vault_member_role_changed',
               'vault_member_removed')
        AND target_id = ?
        AND event_id != ?
        AND applied_at IS NOT NULL
        AND quarantine_reason IS NULL
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
      /* malformed payload — fall through to null */
    }
  }

  // M4: no VMC fallback. The membership chain is the sole role source —
  // every member has a vault_member_added (genesis owner / owner-emitted
  // pair admission / witnessed invite), so the Step 1-3 scan above covers
  // every authenticated actor. A null here means the chain hasn't reached
  // this device yet (e.g. a joiner's entry gossiped to a third peer before
  // the owner's admission did) → the actor is unknown_actor and the event
  // quarantines, healing via the sweep once the admission lands. The
  // retired Step-4 vault_credentials.vmc_blob fallback couldn't have
  // helped that case anyway (it required a locally-cached VMC for the
  // actor, which only direct-handshake peers ever held).
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
  eventHlc: HLC,
  signerPubkey: string | null,
): Promise<{ account_id: string; device_pubkey: string } | "device_removed" | null> {
  // M2: the membership-chain device registry is the PRIMARY binding source
  // (fold of owner-signed / witnessed vault_device_added events — migration
  // 019). A binding removed BEFORE this event's HLC means a retired device
  // is still signing: refuse outright (the stolen-staff-phone case) while
  // events authored pre-removal keep authenticating (lawful-at-HLC).
  //
  // Re-review P1: key on the SIGNER PUBKEY (the registry PK and what the
  // chain fold keys devices by), NOT device_id. A device_id can carry >1
  // pubkey row (key rotation / re-bind): a `WHERE device_id=? LIMIT 1`
  // could return a removed K1 row for an event actually signed by an active
  // K2 — refusing (device_removed) what the fold accepts, a durable,
  // never-healing divergence. Pubkey-exact resolution matches the fold.
  // Fall back to device_id only when the envelope carries no signer pubkey
  // (structurally can't happen for a signed remote event, but keep it
  // total).
  const reg = signerPubkey
    ? await tx.getFirstAsync<{
        account_id: string;
        device_pubkey: string;
        removed_at_ms: number | null;
        removed_at_l: number | null;
        removed_at_did: string | null;
      }>(
        `SELECT account_id, device_pubkey, removed_at_ms, removed_at_l, removed_at_did
           FROM vault_device_registry
          WHERE vault_id = ? AND device_pubkey = ?
          LIMIT 1`,
        vaultId,
        signerPubkey,
      )
    : await tx.getFirstAsync<{
        account_id: string;
        device_pubkey: string;
        removed_at_ms: number | null;
        removed_at_l: number | null;
        removed_at_did: string | null;
      }>(
        `SELECT account_id, device_pubkey, removed_at_ms, removed_at_l, removed_at_did
           FROM vault_device_registry
          WHERE vault_id = ? AND device_id = ?
          LIMIT 1`,
        vaultId,
        deviceId,
      );
  if (reg != null) {
    if (reg.removed_at_ms != null) {
      // FULL-HLC comparison (not pms alone): a removed device can author an
      // event at exactly removed_at_ms with a higher logical counter, which
      // is post-removal in the chain fold's full-HLC order but would tie on
      // pms. Reconstruct the removal HLC; pre-019 rows lack l/did, so fall
      // back to pms-strict for those.
      const removalHlc: HLC = {
        pms: reg.removed_at_ms,
        l: reg.removed_at_l ?? 0,
        did: reg.removed_at_did ?? "",
      };
      const past =
        reg.removed_at_l != null && reg.removed_at_did != null
          ? compareHLC(eventHlc, removalHlc) > 0
          : eventHlc.pms > reg.removed_at_ms;
      if (past) return "device_removed";
    }
    return { account_id: reg.account_id, device_pubkey: reg.device_pubkey };
  }
  // Legacy fallback: the vault_credentials cache. M4 retired every writer
  // of role-bearing credential blobs, so on a fresh install this table is
  // empty and the lookup returns null — the membership-chain device
  // registry above is the sole live binding source. Kept only because the
  // table is preserved (chain appliers still read it for device fan-out).
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

// M2 genesis bootstrap: is this the anchor's own first owner self-admission?
// True iff event is a vault_member_added with role=owner, signed by the
// vault's trust anchor, and no anchor binding exists in the registry yet
// (so it can only fire ONCE per vault — the genesis). The applier seeds the
// binding on apply, after which every later owner event authenticates via
// the registry. Caller has already established that there's no registry/VMC
// binding for the signer's device_id and the signature is about to be (or
// has been) verified.
async function isGenesisBootstrapEvent(
  tx: SQLiteTx,
  event: LedgerEvent,
  signerPubkey: string,
): Promise<boolean> {
  if (event.event_type !== "vault_member_added" || event.vault_id == null) return false;
  if ((event.payload as { role?: string }).role !== "owner") return false;
  const anchorRow = await tx.getFirstAsync<{ vault_trust_anchor_pubkey: string | null }>(
    `SELECT vault_trust_anchor_pubkey FROM vaults WHERE id = ? LIMIT 1`,
    event.vault_id,
  );
  if (anchorRow?.vault_trust_anchor_pubkey == null) return false;
  if (anchorRow.vault_trust_anchor_pubkey !== signerPubkey) return false;
  // Genesis fires once: if the anchor is already bound, this is a later
  // owner event and must go through the normal registry path.
  const bound = await tx.getFirstAsync<{ device_pubkey: string }>(
    `SELECT device_pubkey FROM vault_device_registry
      WHERE vault_id = ? AND device_pubkey = ? LIMIT 1`,
    event.vault_id,
    signerPubkey,
  );
  return bound == null;
}

// M2: membership events that may authenticate via a server witness instead
// of a pre-existing local device binding (docs/m2-membership-chain.md §2).
function isWitnessCapableMembershipEvent(event: LedgerEvent): boolean {
  if (event.event_type !== "vault_member_added" && event.event_type !== "vault_device_added") {
    return false;
  }
  const w = (event.payload as { witness?: unknown } | null)?.witness;
  return w != null && typeof w === "object";
}

// Event types the ANCHOR RESTORE carve-out may authenticate: the user-DATA and
// vault-CONFIG events whose author is the vault owner. EXCLUDES every
// membership/device event (vault_member_* / vault_device_*) and account_bound —
// those keep their dedicated genesis/witness authentication so the carve-out can
// never be used to forge ownership or membership. (entry_* / person_* /
// shop_profile_updated / vault_setting_set are all owner-or-editor writes the
// vault's own anchor is trivially authorized to make.)
function isAnchorAuthableEventType(t: string): boolean {
  return !t.startsWith("vault_member_") && !t.startsWith("vault_device_") && t !== "account_bound";
}

// True iff `pubkey` is THIS vault's pinned trust anchor (the device that minted
// it). The anchor is the vault's root of trust + owner by construction; an event
// whose signature verifies against it is genuinely from the owner device.
async function isVaultAnchorPubkey(
  tx: SQLiteTx,
  vaultId: string,
  pubkey: string | null,
): Promise<boolean> {
  if (!pubkey) return false;
  const row = await tx.getFirstAsync<{ vault_trust_anchor_pubkey: string | null }>(
    "SELECT vault_trust_anchor_pubkey FROM vaults WHERE id = ? LIMIT 1",
    vaultId,
  );
  return row?.vault_trust_anchor_pubkey != null && row.vault_trust_anchor_pubkey === pubkey;
}

// The HLC of the post-restore re-keyed owner admission for the CURRENT signed-in
// account, or null if this vault has no such admission. After a reinstall,
// recovery.ts reestablishOwnerIfConfirmed emits a fresh-"now"-HLC owner
// vault_member_added keyed to getAccountIdSync() — strictly LATER than any
// genuine pre-restore own-history the original anchor authored. We read it from
// the APPLIED event_log (the fold's source), same as resolveRoleAt, so it agrees
// with the chain verdict.
async function rekeyedOwnerAdmissionHlc(tx: SQLiteTx, vaultId: string): Promise<HLC | null> {
  const accountId = getAccountIdSync();
  if (!accountId) return null;
  const row = await tx.getFirstAsync<{
    hlc_physical_ms: number;
    hlc_logical: number;
    hlc_device_id: string;
  }>(
    `SELECT hlc_physical_ms, hlc_logical, hlc_device_id
       FROM event_log
      WHERE vault_id = ?
        AND target_id = ?
        AND event_type IN ('vault_member_added', 'vault_member_role_changed')
        AND json_extract(payload_json, '$.role') = 'owner'
        AND applied_at IS NOT NULL
        AND quarantine_reason IS NULL
      ORDER BY hlc_physical_ms DESC, hlc_logical DESC, hlc_device_id DESC
      LIMIT 1`,
    vaultId,
    accountId,
  );
  if (row == null) return null;
  return { pms: row.hlc_physical_ms, l: row.hlc_logical, did: row.hlc_device_id };
}

// True iff `eventHlc` PREDATES the post-restore re-keyed owner admission (or no
// such admission exists). Scopes the anchor-restore carve-out to genuine
// PRE-restore own-history: once the recovered account re-establishes ownership
// via the chain, the original anchor key is no longer an authoring authority, so
// a later-HLC anchor-signed event is a retired/compromised-key forgery, not
// own-history, and must NOT be blessed by the carve-out.
async function anchorEventPrecedesRekey(
  tx: SQLiteTx,
  vaultId: string,
  eventHlc: HLC,
): Promise<boolean> {
  const boundary = await rekeyedOwnerAdmissionHlc(tx, vaultId);
  return boundary == null || compareHLC(eventHlc, boundary) < 0;
}

async function serverWitnessKeys(tx: SQLiteTx): Promise<string[]> {
  const rows = await tx.getAllAsync<{ value: string }>(
    `SELECT value FROM app_meta
      WHERE key IN ('mesh_server_pubkey_primary', 'mesh_server_pubkey_rotation')
        AND value != ''`,
  );
  return rows.map((r) => r.value);
}

// Active-member / removal probes used by the witness + carve-out paths so
// the gate accepts exactly the events the chain fold accepts.
//
// Re-review P2: these derive from the APPLIED event_log (the fold's
// source), NOT vault_members_mirror. The mirror is INSERT-OR-REPLACE'd with
// revoked_at=NULL by non-chain writers (cacheVMC in local-pair.ts, auth.ts,
// server reconcile), so a chain-removed member can look "active" in the
// mirror while the fold still refuses them — a gate/fold divergence. The
// latest applied+unquarantined membership event for the account, evaluated
// strictly before this event's HLC, is the authoritative chain verdict.
async function latestMembershipKindBefore(
  tx: SQLiteTx,
  vaultId: string,
  accountId: string,
  beforeHlc: HLC,
): Promise<"vault_member_added" | "vault_member_role_changed" | "vault_member_removed" | null> {
  const row = await tx.getFirstAsync<{ event_type: string }>(
    `SELECT event_type FROM event_log
      WHERE vault_id = ?
        AND target_id = ?
        AND event_type IN
              ('vault_member_added','vault_member_role_changed','vault_member_removed')
        AND applied_at IS NOT NULL
        AND quarantine_reason IS NULL
        AND ( hlc_physical_ms < ?
              OR (hlc_physical_ms = ? AND hlc_logical < ?)
              OR (hlc_physical_ms = ? AND hlc_logical = ? AND hlc_device_id < ?)
            )
      ORDER BY hlc_physical_ms DESC, hlc_logical DESC, hlc_device_id DESC
      LIMIT 1`,
    vaultId,
    accountId,
    beforeHlc.pms,
    beforeHlc.pms,
    beforeHlc.l,
    beforeHlc.pms,
    beforeHlc.l,
    beforeHlc.did,
  );
  const t = row?.event_type;
  if (
    t === "vault_member_added" ||
    t === "vault_member_role_changed" ||
    t === "vault_member_removed"
  ) {
    return t;
  }
  return null;
}

async function isActiveMember(
  tx: SQLiteTx,
  vaultId: string,
  accountId: string,
  beforeHlc: HLC,
): Promise<boolean> {
  const kind = await latestMembershipKindBefore(tx, vaultId, accountId, beforeHlc);
  return kind === "vault_member_added" || kind === "vault_member_role_changed";
}

async function isRemovedMember(
  tx: SQLiteTx,
  vaultId: string,
  accountId: string,
  beforeHlc: HLC,
): Promise<boolean> {
  return (
    (await latestMembershipKindBefore(tx, vaultId, accountId, beforeHlc)) === "vault_member_removed"
  );
}

async function isRemovedDevice(
  tx: SQLiteTx,
  vaultId: string,
  devicePubkey: string,
): Promise<boolean> {
  const row = await tx.getFirstAsync<{ removed_at_ms: number | null }>(
    `SELECT removed_at_ms FROM vault_device_registry
      WHERE vault_id = ? AND device_pubkey = ?
      LIMIT 1`,
    vaultId,
    devicePubkey,
  );
  return row != null && row.removed_at_ms != null;
}

// Verifies the witness path for a membership event whose signer has no
// local binding. MUST mirror lib/trust/chain.ts's fold rules exactly — the
// gate (apply) and the fold (handshake/state) have to accept the same
// events or replicas diverge on which membership claims are real.
async function verifyMembershipWitnessForEvent(
  tx: SQLiteTx,
  event: LedgerEvent,
  signerPubkey: string,
): Promise<boolean> {
  if (event.vault_id == null) return false;
  const keys = await serverWitnessKeys(tx);
  if (keys.length === 0) return false;

  const p = event.payload as Record<string, unknown>;
  const w = p.witness as MembershipWitnessLike | undefined;
  if (!w || typeof w.sig_b64 !== "string" || typeof w.issued_at_ms !== "number") return false;
  if (Math.abs(w.issued_at_ms - event.hlc.pms) > WITNESS_FRESHNESS_MS) return false;

  let tuple: Record<string, unknown>;
  if (event.event_type === "vault_device_added") {
    if (
      typeof p.account_id !== "string" ||
      typeof p.device_id !== "string" ||
      typeof p.device_pubkey !== "string"
    ) {
      return false;
    }
    // The envelope must be self-signed by the exact key being bound, by
    // the device claiming that id — a witness alone can never bind a key
    // the presenter doesn't hold.
    if (signerPubkey !== p.device_pubkey || event.device_id !== p.device_id) return false;
    // Parity with chain.ts: the named account must be a currently-active
    // member, and a witness must NOT resurrect a removed device.
    if (!(await isActiveMember(tx, event.vault_id, p.account_id, event.hlc))) return false;
    if (await isRemovedDevice(tx, event.vault_id, p.device_pubkey)) return false;
    tuple = deviceWitnessTuple({
      vault_id: event.vault_id,
      account_id: p.account_id,
      device_id: p.device_id,
      device_pubkey_b64: p.device_pubkey,
      issued_at_ms: w.issued_at_ms,
    });
  } else {
    if (typeof p.account_id !== "string" || typeof w.inviter_account_id !== "string") return false;
    const role =
      p.role === "owner" || p.role === "editor" || p.role === "viewer"
        ? (p.role as VaultRole)
        : null;
    if (!role) return false;
    // Parity with chain.ts: a witness is an invite attestation, never an
    // owner grant — cap to editor/viewer; and it must not resurrect a
    // removed member.
    if (role === "owner") return false;
    if (await isRemovedMember(tx, event.vault_id, p.account_id, event.hlc)) return false;
    tuple = memberWitnessTuple({
      vault_id: event.vault_id,
      account_id: p.account_id,
      inviter_account_id: w.inviter_account_id,
      role,
      issued_at_ms: w.issued_at_ms,
    });
  }

  const msg = new TextEncoder().encode(runtimeChainCrypto.canonicalize(tuple));
  return keys.some((k) => runtimeChainCrypto.verifyRaw(msg, w.sig_b64, k));
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
  // M2 (review P0): envelope target_id integrity. The HLC staleness
  // sidecars (vault_devices.ts / vault_members.ts) key on the target_id
  // COLUMN, while the appliers and fold key on the PAYLOAD's device_id /
  // account_id. target_id is author-chosen and signed, so a malicious
  // signer could set target_id != payload.{device_id,account_id} to make
  // their event invisible to the sidecar (suppressing a real removal,
  // order-dependently) while still folding into the registry — a gate/fold
  // divergence and revocation bypass. Refuse the mismatch outright so the
  // sidecar key and the fold key always agree.
  if (event.event_type === "vault_device_added" || event.event_type === "vault_device_removed") {
    const pd = (event.payload as { device_id?: string }).device_id;
    if (typeof pd !== "string" || pd !== event.target_id) {
      return {
        ok: false,
        reason: "bad_signature",
        current_role: null,
        required_role: requirement as "owner" | "editor",
      };
    }
  } else if (
    event.event_type === "vault_member_added" ||
    event.event_type === "vault_member_role_changed" ||
    event.event_type === "vault_member_removed"
  ) {
    const pa = (event.payload as { account_id?: string }).account_id;
    if (typeof pa !== "string" || pa !== event.target_id) {
      return {
        ok: false,
        reason: "bad_signature",
        current_role: null,
        required_role: requirement as "owner" | "editor",
      };
    }
  }

  // M2 (review P1): a device binding requires the named account be a
  // currently-active member — the chain fold refuses vault_device_added
  // with unknown_member_account otherwise, so the gate must too or the
  // registry diverges from the fold. (The witnessed and local self-add
  // paths re-check this with their own freshness rules; this is the
  // owner-signed path's barrier and a cheap early-out for all.)
  if (event.event_type === "vault_device_added") {
    const pa = (event.payload as { account_id?: string }).account_id;
    if (typeof pa !== "string" || !(await isActiveMember(tx, event.vault_id, pa, event.hlc))) {
      return {
        ok: false,
        reason: "unknown_actor",
        current_role: null,
        required_role: requirement as "owner" | "editor",
      };
    }
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
    // Authenticate via the SIGNER's device_pubkey. The signer pubkey ->
    // (account_id, device_pubkey) binding is resolved from the membership-
    // chain device registry (the fold of owner-signed / witnessed
    // vault_device_added events), so the mapping is authenticated against
    // the vault anchor.
    let signerPubkey: string | null = event.signer_device_pubkey ?? null;
    let authenticatedAccountId: string | null = null;
    // M2: when the signer has no local binding yet, witnessed membership
    // events can still authenticate themselves (the online-invite path
    // delivers the new member's own admission before any binding exists).
    let unknownSignerAwaitingWitness = false;
    // M2: genesis-bootstrap — the anchor's own first owner self-admission,
    // authenticated on the anchor identity (see isGenesisBootstrapEvent).
    let genesisBootstrap = false;
    // Restore carve-out: a non-membership event signed by the vault's OWN
    // pinned trust anchor (the device that minted a pre-sign-in vault), whose
    // device binding never entered the chain server-side and so is absent from
    // this restored device's registry. Authenticated on the anchor identity
    // itself (see the anchorAuthenticated accept after signature verification).
    let anchorAuthenticated = false;
    const cred = await lookupSignerCredential(
      tx,
      event.vault_id,
      event.device_id,
      event.hlc,
      signerPubkey,
    );
    if (cred === "device_removed") {
      // The chain says this device was removed before it authored this
      // event (stolen / retired phone still signing). unknown_actor keeps
      // the quarantine-retry semantics: a later re-admission cures.
      return {
        ok: false,
        reason: "unknown_actor",
        current_role: null,
        required_role: requirement,
      };
    }
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
      if (isWitnessCapableMembershipEvent(event)) {
        // Defer the unknown-actor verdict: verify the envelope signature
        // first (below), then the witness path decides.
        unknownSignerAwaitingWitness = true;
      } else if (await isGenesisBootstrapEvent(tx, event, signerPubkey)) {
        // GENESIS bootstrap (M2 review P0): the chicken-and-egg of "the
        // anchor's genesis event needs a registry binding to authenticate,
        // but only applying genesis seeds that binding". A genesis-shaped
        // member_added (signed by the vault trust anchor, role owner, no
        // anchor binding yet) authenticates on the anchor identity itself.
        // Defer the accept until AFTER signature verification below.
        genesisBootstrap = true;
      } else if (
        isAnchorAuthableEventType(event.event_type) &&
        (await isVaultAnchorPubkey(tx, event.vault_id, signerPubkey)) &&
        !(await isRemovedDevice(tx, event.vault_id, signerPubkey)) &&
        (await anchorEventPrecedesRekey(tx, event.vault_id, event.hlc))
      ) {
        // ANCHOR RESTORE carve-out: a NON-membership event (entry_* / person_* /
        // shop_profile_updated / vault_setting_set) signed by THIS vault's own
        // pinned trust anchor. On a reinstalled solo device the original
        // anchor's device binding never entered the chain server-side (the
        // pre-sign-in genesis is keyed by a local sentinel that the server's
        // genesis ACL rejects — membership.go), so the anchor pubkey is absent
        // from vault_device_registry and these own-history events (e.g. the user
        // deleting a duplicate tally) quarantine forever as unknown_actor. The
        // anchor is the vault's owner BY CONSTRUCTION, so we authenticate it on
        // the anchor identity itself — deferred until AFTER signature
        // verification below, exactly like genesis. Membership/device events are
        // EXCLUDED (kept on their genesis/witness paths) so this can't be used to
        // forge ownership changes. The !isRemovedDevice guard (security-review
        // must-fix) ensures a retired/compromised anchor key cannot author
        // forever once a device-removal flow exists — a no-op for the legitimate
        // restore (the anchor has no registry row yet). And anchorEventPrecedesRekey
        // scopes this to events whose hlc PREDATES the post-restore re-keyed owner
        // admission (recovery.ts reestablishOwnerIfConfirmed), so it only blesses
        // genuine PRE-restore own-history — a newly-authored ("now"-HLC)
        // anchor-signed event lands at/after the boundary and is refused below.
        anchorAuthenticated = true;
      } else {
        // No binding yet (the peer's admission hasn't been gossiped to
        // us). We can still cryptographically verify the signature
        // against the envelope-claimed pubkey, but we have NO way to
        // bind that pubkey to an account_id. Refuse as unknown_actor —
        // when the chain events land, this event re-applies cleanly on
        // the next sweep pass.
        return {
          ok: false,
          reason: "unknown_actor",
          current_role: null,
          required_role: requirement,
        };
      }
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

    if (genesisBootstrap) {
      // Signature verified for the anchor key; this IS the genesis owner
      // self-admission. Accept — applyVaultMemberAdded seeds the anchor
      // device binding, so every subsequent owner event authenticates via
      // the registry normally.
      return { ok: true };
    }

    if (anchorAuthenticated) {
      // Signature verified against the vault's pinned trust anchor pubkey, so
      // this event genuinely came from the device that MINTED the vault — its
      // owner by construction. The else-if above already scoped this to events
      // whose hlc PREDATES the post-restore re-keyed owner admission, so we grant
      // directly here; we must NOT defer to resolveRoleAt, because that re-key
      // admission (recovery.ts reestablishOwnerIfConfirmed) has a LATER hlc than
      // this pre-restore historical event, so a lawful-at-hlc role lookup returns
      // null and the event would wrongly stay quarantined forever (own-history
      // deletes/edits invisible on a reinstalled solo device — the "deleted
      // duplicates come back after restore" bug). Only non-membership events reach
      // here (isAnchorAuthableEventType), so this cannot forge ownership/membership;
      // only the anchor's own private key could produce this signature. NOTE: a
      // forgery that BACKDATES its hlc below the re-key boundary would still pass —
      // that residual vector is the separate ingest-time HLC-clamp's job; this
      // scoping closes the common "compromised key authoring current writes" case.
      return { ok: true };
    }

    if (unknownSignerAwaitingWitness) {
      // M2 witnessed authentication (docs/m2-membership-chain.md §2):
      // the envelope signature is valid for the claimed pubkey; now the
      // server witness must justify the membership claim itself. Mirrors
      // lib/trust/chain.ts's fold rules exactly — the gate and the fold
      // must accept the same events.
      const witnessOk = await verifyMembershipWitnessForEvent(tx, event, signerPubkey);
      if (witnessOk) {
        // Last-owner guard on the witnessed path (re-review P0): a leaked
        // witness key signing a member_added for the sole owner at a lower
        // role would demote them — refuse so the gate matches the fold's
        // wouldDemoteSoleOwner and the vault can't be bricked.
        if (event.event_type === "vault_member_added" && (await wouldDropLastOwner(tx, event))) {
          return {
            ok: false,
            reason: "insufficient_role",
            current_role: null,
            required_role: requirement,
          };
        }
        return { ok: true };
      }
      return {
        ok: false,
        reason: "unknown_actor",
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

  // ----------------------------------------------------------------------
  // SELF-ADD carve-out for vault_member_added (Phase 6.1 interim).
  //
  // REQUIRED_ROLE['vault_member_added'] = 'owner'. The witnessed online
  // invite-accept path has an invited member author a vault_member_added
  // FOR THEMSELVES (carrying a server witness). That member is NOT an
  // owner at the time they author it, so the plain owner-required check
  // would refuse. The witness path authenticates such events earlier
  // (verifyMembershipWitnessForEvent above); this carve-out additionally
  // permits the strictly self-referential first-time self-add so the
  // member's own UI shows the row immediately.
  //
  // M4 note: the QR-join joiner no longer self-adds — the OWNER emits the
  // joiner's admission during the chain handshake (verifyPeerChain). This
  // carve-out remains for the witnessed self-add path above.
  //
  // Carve-out: allow the actor's own vault_member_added IFF:
  //   1. event_type === 'vault_member_added'                        (scope)
  //   2. payload.account_id === actorAccountId                      (self-add only,
  //                                                                  not adding others)
  //   3. NO prior vault_members_mirror row exists for this
  //      (vault_id, account_id) pair — including revoked rows.      (anti-replay:
  //                                                                  a removed
  //                                                                  member cannot
  //                                                                  re-add themselves)
  //
  // For origin='remote', this is AFTER signature verification (so we
  // know the joiner actually authored the event with their private
  // key). For origin='local', the device's own first-time self-add at
  // pair time also benefits from this so the joiner's own UI shows
  // the row immediately.
  if (event.event_type === "vault_member_added") {
    const payload = event.payload as { account_id?: string };
    if (typeof payload?.account_id === "string" && payload.account_id === actorAccountId) {
      const existing = await tx.getFirstAsync<{ account_id: string }>(
        `SELECT account_id FROM vault_members_mirror
          WHERE vault_id = ? AND account_id = ?
          LIMIT 1`,
        event.vault_id,
        actorAccountId,
      );
      if (existing == null) {
        // First-ever self-add for this (vault, account). Permit.
        return { ok: true };
      }
      // Prior row present — fall through to the normal owner-required
      // check (which will refuse for an editor/viewer, preventing a
      // removed member from re-adding themselves).
    }
  }

  // M2 SELF-DEVICE-ADD carve-out (local origin only). A signed-in member
  // emits their own device binding right after invite acceptance (the
  // witnessed online path) — they are not an owner, so the plain
  // owner-required check would refuse. Conditions mirror the member
  // self-add carve-out: strictly self-referential (own account, own
  // device id) and first-time only. REMOTE copies of this event do NOT
  // take this path — they authenticate via the witness
  // (verifyMembershipWitnessForEvent above) or an owner signature, so a
  // forged remote self-bind without a witness still refuses.
  if (event.event_type === "vault_device_added" && event.origin !== "remote") {
    const p = event.payload as {
      account_id?: string;
      device_id?: string;
      device_pubkey?: string;
    };
    if (
      typeof p?.account_id === "string" &&
      p.account_id === actorAccountId &&
      p.device_id === event.device_id
    ) {
      const existing = await tx.getFirstAsync<{ device_pubkey: string }>(
        `SELECT device_pubkey FROM vault_device_registry
          WHERE vault_id = ? AND device_pubkey = ?
          LIMIT 1`,
        event.vault_id,
        p.device_pubkey ?? "",
      );
      if (existing == null) {
        return { ok: true };
      }
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

  // LOCAL/backfill multi-id resolution: a vault created BEFORE Google sign-in
  // keys its owner membership by the device-key account id, but actorAccountId
  // here is the Google id we stamped at sign-in (or vice-versa). If the primary
  // id doesn't resolve to a sufficient role, try this device's OTHER account-id
  // candidates and keep the highest role. This ONLY loosens the already-trusted
  // local path — remote events were signature-verified above and never reach
  // this branch (event.origin === "remote" is excluded), so peer impersonation
  // stays blocked. Fixes owner-only ops (e.g. archiving the pre-sign-in "Main"
  // kaata) being wrongly rejected with the repeated "your role changed" toast.
  if (event.origin !== "remote" && (role == null || !meetsRequirement(role, requirement))) {
    try {
      const candidates = await resolveAccountIdCandidates(actorAccountId);
      for (const cand of candidates) {
        if (cand === actorAccountId) continue;
        const candRole = await resolveRoleAt(tx, event.vault_id, cand, event.hlc, event.event_id);
        if (rankRole(candRole) > rankRole(role)) role = candRole;
      }
    } catch {
      /* keep the primary-id role if candidate resolution fails */
    }

    // TRUST-ANCHOR OWNER carve-out. If the role still doesn't meet the
    // requirement, check whether THIS device is the vault's trust anchor — i.e.
    // the device that MINTED this local-CA vault (vaults.vault_trust_anchor_pubkey
    // == our device pubkey). The anchor device IS the root of trust / owner of
    // its own vault by construction, so its LOCAL owner-ops are legitimate even
    // when account-id binding has drifted (device-key rotated after a reinstall,
    // or the owner membership row is keyed by an id that's no longer
    // resolvable). This is the real reason the "Main" kaata couldn't be archived
    // ("failed to archive" + repeated "your role changed"). Remote events never
    // reach here, and a paired NON-owner device's pubkey != the anchor, so it
    // stays gated — impersonation is still blocked.
    if (role == null || !meetsRequirement(role, requirement)) {
      try {
        const deviceKeyMod = await import("../mesh/device-key");
        await deviceKeyMod.ensureDeviceKey();
        const myPub = deviceKeyMod.getDevicePubkey();
        if (myPub) {
          const anchorRow = await tx.getFirstAsync<{ vault_trust_anchor_pubkey: string | null }>(
            "SELECT vault_trust_anchor_pubkey FROM vaults WHERE id = ?",
            event.vault_id,
          );
          if (anchorRow?.vault_trust_anchor_pubkey === myPub) {
            return { ok: true };
          }
        }
      } catch {
        /* fall through to normal gating if the anchor can't be read */
      }
    }
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
    // M2: a member may remove their OWN account's other device ("remove my
    // old phone") without owner role — mirrors lib/trust/chain.ts's
    // same-account allowance so gate and fold accept identical events.
    // Re-review P2: require EVERY non-removed pubkey row under this
    // device_id to belong to the actor (the applier tombstones ALL rows for
    // the id), matching the fold's `targets.every(...)`. A LIMIT 1 probe
    // could green-light an over-broad removal that the fold refuses.
    if (event.event_type === "vault_device_removed") {
      const p = event.payload as { device_id?: string };
      const rows = await tx.getAllAsync<{ account_id: string }>(
        `SELECT account_id FROM vault_device_registry
          WHERE vault_id = ? AND device_id = ? AND removed_at_ms IS NULL`,
        event.vault_id,
        p?.device_id ?? "",
      );
      if (rows.length > 0 && rows.every((r) => r.account_id === actorAccountId)) {
        return { ok: true };
      }
    }
    // SELF-LEAVE carve-out: a member may remove their OWN membership ("leave
    // kaata") without owner role. Mirrors the vault_device_removed same-account
    // allowance above and the fold's self-leave arm (lib/trust/chain.ts) plus
    // the server's chain ACL (backend sync/membership.go rule b3) — gate and
    // fold must accept identical events. SCOPED TO ANCHORED (local-CA) VAULTS:
    // the server's b3 arm only runs on anchored vaults; on an anchor-less
    // legacy vault the push-side legacy ACL still refuses non-owner removals,
    // so applying the leave locally there would show the user as gone while
    // the server (and every other member) kept them forever — a silent
    // permanent split. Refusing keeps that corner loudly failing (pre-fix
    // behavior); the REST /leave endpoint remains those vaults' path. For
    // origin='remote' the actor is the SIGNATURE-authenticated account, so
    // equality is strict; for local origin the membership row may be keyed
    // under another of this device's ids (Google id vs device-key id — the
    // same drift class leaveVaultRouted resolves), so match against all local
    // candidates. IMPORTANT: this does NOT return ok directly — it falls
    // THROUGH to the last-owner guard below, so a sole owner's self-leave
    // still refuses (the vault must never go ownerless).
    let selfLeave = false;
    if (event.event_type === "vault_member_removed" && actorAccountId != null) {
      const target = (event.payload as { account_id?: string }).account_id;
      if (typeof target === "string") {
        if (target === actorAccountId) {
          selfLeave = true;
        } else if (event.origin !== "remote") {
          try {
            const candidates = await resolveAccountIdCandidates(actorAccountId);
            selfLeave = candidates.includes(target);
          } catch {
            /* keep selfLeave=false — fail closed */
          }
        }
      }
      if (selfLeave) {
        const anchorRow = await tx.getFirstAsync<{ vault_trust_anchor_pubkey: string | null }>(
          "SELECT vault_trust_anchor_pubkey FROM vaults WHERE id = ? LIMIT 1",
          event.vault_id,
        );
        if (anchorRow?.vault_trust_anchor_pubkey == null) selfLeave = false;
      }
    }
    if (!selfLeave) {
      return {
        ok: false,
        reason: "insufficient_role",
        current_role: role,
        required_role: requirement,
      };
    }
  }

  // Last-owner protection (security critique #8): membership events
  // that would leave the vault with ZERO owners are refused at the
  // applier layer, not just the UI. This catches: (a) a forged event
  // demoting the last owner via a stolen owner-device's signature,
  // (b) a locally-rebuilt mobile attacker that bypasses the UI guard.
  // member_added is included (re-review P0): an owner-signed re-add of the
  // sole owner at a lower role demotes them via the upsert.
  if (
    event.event_type === "vault_member_role_changed" ||
    event.event_type === "vault_member_removed" ||
    event.event_type === "vault_member_added"
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
  } else if (event.event_type === "vault_member_added") {
    // M2 (re-review P0): member_added is an UPSERT — re-adding an existing
    // owner at a lower role demotes them, the same lockout vector. Mirrors
    // the fold's wouldDemoteSoleOwner.
    const p = event.payload as { account_id: string; role: VaultRole };
    targetAccountId = p.account_id;
    newRole = p.role;
  } else {
    return false;
  }
  if (newRole === "owner") return false; // promoting to owner cannot drop owners

  // Count owners NOT including the target row. For LOCAL-origin events whose
  // target is one of THIS device's own identity candidates (a self-removal /
  // self-demotion), exclude ALL of those candidates: a pre-sign-in vault can
  // transiently hold both a device-key-sentinel owner row and the signed-in
  // owner row for the SAME person, and counting the sibling row as "another
  // owner" would let the sole real owner remove themselves (the chain fold —
  // which counts CHAIN owners, one per person — would refuse the same event:
  // gate/fold divergence). Remote events keep the exact-id count so the gate
  // stays in lockstep with the server fold's per-account arbitration.
  let excludeIds: string[] = [targetAccountId];
  if (event.origin !== "remote") {
    try {
      const myIds = await resolveAccountIdCandidates(getAccountIdSync());
      if (myIds.includes(targetAccountId)) {
        excludeIds = Array.from(new Set([targetAccountId, ...myIds]));
      }
    } catch {
      /* keep the single-id exclusion — fail closed toward refusing */
    }
  }
  const excludePh = excludeIds.map(() => "?").join(",");
  const row = await tx.getFirstAsync<{ owner_count: number }>(
    `SELECT COUNT(*) AS owner_count
       FROM vault_members_mirror
      WHERE vault_id = ?
        AND role = 'owner'
        AND revoked_at IS NULL
        AND account_id NOT IN (${excludePh})`,
    event.vault_id,
    ...excludeIds,
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
