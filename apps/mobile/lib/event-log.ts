// The event log: append-only source of truth for every ledger mutation.
//
// This module owns the APPEND side of the event log: each appendXxx helper
// constructs a typed LedgerEvent, stamps device_id / vault_id / account_id
// from the cached singletons, and hands it to applyEvent (lib/projection)
// which is the single transactional entry point that BOTH local writes
// (via these helpers) and remote writes (Phase 3+ sync worker) funnel
// through. Idempotent by event_id, transactional, dispatches to projection
// appliers via a small registry.
//
// Projection appliers themselves live in lib/projection/ (one sub-module
// per event-type domain) so the Go projection in
// apps/backend/internal/sync/project.go has a clean TS counterpart to
// mirror against the shared JSON conformance corpus.
//
// Adding a new event type is: (a) widen LedgerEvent in lib/events.ts,
// (b) add an applier in the right lib/projection/*.ts sub-module,
// (c) register it in lib/projection/index.ts's APPLIERS table,
// (d) add an append helper here, (e) mirror in Go + add a corpus fixture.

import * as Crypto from "expo-crypto";

import {
  getAccountIdSync,
  getActiveVaultIdSync,
  getDb,
  getInstallIdSync,
  getLocalSelfUserIdSync,
} from "./db-tx";
import { ensureDeviceKey, getDevicePubkey, signWithDeviceKey } from "./mesh/device-key";
import { canonicalizeEvent, signEvent, type SignableEvent } from "./event-sig";
import type {
  AccountBoundEvent,
  EntryAmendedEvent,
  EntryCreatedEvent,
  EntryDeletedEvent,
  PersonAddedEvent,
  PersonArchivedEvent,
  PersonPhoneChangedEvent,
  PersonRenamedEvent,
  PersonUnarchivedEvent,
  ShopProfileUpdatedEvent,
  VaultMemberAddedEvent,
  VaultMemberRemovedEvent,
  VaultMemberRoleChangedEvent,
  VaultRole,
  VaultSettingSetEvent,
} from "./events";
import { applyEvent } from "./projection";
import type { EntryType } from "./types";

// Re-exported so existing callers that do `import { applyEvent,
// _dispatchProjectionApplier } from "./event-log"` keep compiling. New code
// should import directly from "./projection".
export { _dispatchProjectionApplier, applyEvent } from "./projection";

// Phase 1 payload schema version. Bumped when the canonical payload shape
// changes; appliers will dispatch on (event_type, payload_schema).
const CURRENT_PAYLOAD_SCHEMA = 1;

// ---------- Phase 8: event signing helper ----------
//
// Stamps a freshly-constructed local event with the device's Ed25519
// signature so the role-gate on receiving peers can verify authorship
// via the device_pubkey looked up by device_id, rather than trusting
// the wire's claimed actor_account_id. See lib/event-sig.ts for the
// canonicalization contract.
//
// HLC, target_id, and payload are read from the EVENT AS PASSED IN.
// applyEvent overwrites event.hlc with the result of tickLocal inside
// the same transaction that does the INSERT — but it leaves every other
// envelope field untouched. So as long as we sign over the
// pre-tick-local HLC AND propagate that same HLC through tickLocal's
// output untouched, the signature stays consistent end-to-end. The HLC
// MUST be stamped BEFORE we call stampSignature; the actual mechanic
// is: the append helper computes the local HLC via a sneak peek
// (getLocalHlcSync) and writes it into event.hlc before signing.
//
// For now we use the device_id directly as the HLC.did (matching
// tickLocal's behaviour) and let applyEvent re-tick on a future-dated
// frontier. The sign-then-apply ordering means the inside-tx tickLocal
// CAN produce a different HLC than the one we signed — in which case
// applyEvent re-signs with the new HLC before INSERT. See applyEvent.
async function stampSignature<E extends SignableEvent>(
  event: E,
): Promise<{
  event_sig_b64: string;
  signer_device_pubkey: string;
}> {
  // Lazy device-key bootstrap: the very first local event on a fresh
  // install may run before any explicit ensureDeviceKey() call (the
  // mesh subsystem normally triggers it). Calling ensureDeviceKey here
  // is idempotent and cheap once primed.
  const { pubkey_b64 } = await ensureDeviceKey();
  const sig = await signEvent(event, signWithDeviceKey);
  return { event_sig_b64: sig, signer_device_pubkey: pubkey_b64 };
}

// Re-exported so projection/index.ts can re-sign an event after
// applyEvent's tickLocal mutates the HLC.
export { stampSignature };

// ---------- typed error for role-gate refusal ----------
//
// Thrown by the append helpers when applyEvent reports applied=false with
// reason="role_gate". UI callers (entry/new save handler, person/new,
// vault/settings rename) catch this specifically to surface a
// "view only — owner permission required" toast instead of the generic
// "save failed" — without this, every role-gate rejection looked like a
// random storage error to shopkeepers. See projection-conflicts hook for
// the reactive surface that mirrors the same condition.
export class RoleGateRejectionError extends Error {
  readonly kind = "role_gate" as const;
  readonly reason: "insufficient_role" | "unknown_actor" | "unsigned_event" | "bad_signature";
  readonly current_role: string | null;
  readonly required_role: "owner" | "editor";
  constructor(detail: {
    reason: "insufficient_role" | "unknown_actor" | "unsigned_event" | "bad_signature";
    current_role: string | null;
    required_role: "owner" | "editor";
  }) {
    super(`role_gate_rejected (reason=${detail.reason}, required=${detail.required_role})`);
    this.name = "RoleGateRejectionError";
    this.reason = detail.reason;
    this.current_role = detail.current_role;
    this.required_role = detail.required_role;
  }
}

// ---------- public append helpers (Phase 1 entry_* writes) ----------

export async function appendEntryCreated(args: {
  relationshipId: string;
  type: EntryType;
  amountAfn: number;
  note: string | null;
  occurredAtMs?: number;
}): Promise<{ event_id: string; entry_id: string }> {
  const entryId = Crypto.randomUUID();
  const eventId = Crypto.randomUUID();
  const occurredAtMs = args.occurredAtMs ?? Date.now();
  const installId = getInstallIdSync();
  const authorUserId = requireLocalSelfUserId();
  // After migration 007 every entry belongs to a vault; the active vault is
  // the authoring source-of-truth. The applier throws if this is null, so
  // we stamp it here rather than leaving it for backend re-stamping.
  const vaultId = getActiveVaultIdSync();
  // Post-sign-in events carry their own actor_account_id directly so the
  // backend never has to re-attribute them. Pre-sign-in this is null and
  // a later account_bound event covers retroactive re-attribution.
  const accountId = getAccountIdSync();

  const event: EntryCreatedEvent = {
    event_id: eventId,
    event_type: "entry_created",
    vault_id: vaultId,
    target_id: entryId,
    relationship_id: args.relationshipId,
    hlc: { pms: 0, l: 0, did: installId }, // overwritten inside the tx after tickLocal
    device_id: installId,
    author_user_id_local_only: authorUserId,
    actor_account_id: accountId,
    payload_schema: CURRENT_PAYLOAD_SCHEMA,
    appended_at: 0, // overwritten inside the tx
    server_acked_at: null,
    rejected_at: null,
    origin: "local",
    payload: {
      entry_id: entryId,
      relationship_id: args.relationshipId,
      type: args.type,
      amount_afn: args.amountAfn,
      note: args.note,
      occurred_at_ms: occurredAtMs,
    },
  };

  const result = await applyEvent(event, { origin: "local" });
  if (!result.applied) {
    // Discriminated by reason:
    //   role_gate  — caller (entry/new) catches RoleGateRejectionError and
    //                surfaces "view only" copy.
    //   duplicate  — UUIDv4 collision is statistically zero; treat as bug.
    //   preflight  — entry_created has no preflightAbort, so this can't fire.
    if (result.reason === "role_gate" && result.role_gate) {
      throw new RoleGateRejectionError(result.role_gate);
    }
    throw new Error(`entry_created event_id collision: ${eventId}`);
  }
  return { event_id: eventId, entry_id: entryId };
}

export async function appendEntryAmended(args: {
  entryId: string;
  changes: Partial<{
    amount_afn: number;
    note: string | null;
    type: EntryType;
    occurred_at_ms: number;
  }>;
}): Promise<{ event_id: string } | null> {
  // Drop explicit-undefined keys so JSON round-trip and projection get the
  // same shape ("note: undefined" would survive in-process as a present key
  // but be stripped by JSON.stringify on persistence — leading to inconsistent
  // applier behavior between local write and replay). Callers communicate
  // "don't touch" by omitting the key, not by passing undefined.
  const normalizedChanges: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args.changes)) {
    if (v !== undefined) normalizedChanges[k] = v;
  }
  // Nothing to amend — silently skip rather than emit a no-op event into the
  // log. Callers can rely on null to mean "no write happened."
  if (Object.keys(normalizedChanges).length === 0) return null;

  const eventId = Crypto.randomUUID();
  const installId = getInstallIdSync();
  const authorUserId = requireLocalSelfUserId();
  const vaultId = getActiveVaultIdSync();
  const accountId = getAccountIdSync();

  // Read relationship_id + is_deleted as a pre-flight outside the tx so we
  // can short-circuit on the common "deleted entry" case without paying for
  // a transaction. The real authority is the inside-tx re-check via the
  // preflightAbort hook below, which protects against an interleaved local
  // mutation (extremely unlikely on a single JS thread + WAL connection,
  // but cheap to add and makes the contract explicit).
  const db = await getDb();
  const row = await db.getFirstAsync<{
    relationship_id: string;
    is_deleted: number | null;
  }>("SELECT relationship_id, is_deleted FROM entries WHERE id = ?", args.entryId);
  if (!row || row.is_deleted === 1) return null;

  const event: EntryAmendedEvent = {
    event_id: eventId,
    event_type: "entry_amended",
    vault_id: vaultId,
    target_id: args.entryId,
    relationship_id: row.relationship_id,
    hlc: { pms: 0, l: 0, did: installId },
    device_id: installId,
    author_user_id_local_only: authorUserId,
    actor_account_id: accountId,
    payload_schema: CURRENT_PAYLOAD_SCHEMA,
    appended_at: 0,
    server_acked_at: null,
    rejected_at: null,
    origin: "local",
    payload: {
      changes: normalizedChanges as EntryAmendedEvent["payload"]["changes"],
    },
  };

  const result = await applyEvent(event, {
    origin: "local",
    // Inside-tx re-check: if the target entry became deleted between the
    // pre-flight SELECT above and the tx open, abort without inserting the
    // event_log row.
    preflightAbort: async (tx) => {
      const r = await tx.getFirstAsync<{ is_deleted: number | null }>(
        "SELECT is_deleted FROM entries WHERE id = ?",
        args.entryId,
      );
      return !r || r.is_deleted === 1;
    },
  });
  if (!result.applied) {
    if (result.reason === "role_gate" && result.role_gate) {
      throw new RoleGateRejectionError(result.role_gate);
    }
    return null;
  }
  return { event_id: eventId };
}

export async function appendEntryDeleted(args: {
  entryId: string;
}): Promise<{ event_id: string } | null> {
  const eventId = Crypto.randomUUID();
  const installId = getInstallIdSync();
  const authorUserId = requireLocalSelfUserId();
  const vaultId = getActiveVaultIdSync();
  const accountId = getAccountIdSync();

  const db = await getDb();
  const row = await db.getFirstAsync<{
    relationship_id: string;
    is_deleted: number | null;
  }>("SELECT relationship_id, is_deleted FROM entries WHERE id = ?", args.entryId);
  if (!row) return null;
  // Sticky tombstone: deleting twice is a no-op, not an error. The first
  // entry_deleted event already won — appending a second would just churn
  // the log.
  if (row.is_deleted === 1) return null;

  const event: EntryDeletedEvent = {
    event_id: eventId,
    event_type: "entry_deleted",
    vault_id: vaultId,
    target_id: args.entryId,
    relationship_id: row.relationship_id,
    hlc: { pms: 0, l: 0, did: installId },
    device_id: installId,
    author_user_id_local_only: authorUserId,
    actor_account_id: accountId,
    payload_schema: CURRENT_PAYLOAD_SCHEMA,
    appended_at: 0,
    server_acked_at: null,
    rejected_at: null,
    origin: "local",
    payload: {},
  };

  const result = await applyEvent(event, {
    origin: "local",
    // Inside-tx re-check: another local delete might have landed between
    // the pre-flight SELECT and the tx open. Abort the second delete to
    // keep the log clean (sticky tombstone).
    preflightAbort: async (tx) => {
      const r = await tx.getFirstAsync<{ is_deleted: number | null }>(
        "SELECT is_deleted FROM entries WHERE id = ?",
        args.entryId,
      );
      return !r || r.is_deleted === 1;
    },
  });
  if (!result.applied) {
    if (result.reason === "role_gate" && result.role_gate) {
      throw new RoleGateRejectionError(result.role_gate);
    }
    return null;
  }
  return { event_id: eventId };
}

// ---------- Phase 2 append helpers (persons / shop profile / account_bound) ----------

// Per-vault phone uniqueness check used by createPerson / updatePerson before
// emitting person_added / person_phone_changed. Returns the conflicting user
// when one exists in the SAME vault on an ACTIVE relationship; null otherwise.
// excludeUserId lets updatePerson skip the row being edited.
export async function findPhoneConflictInVault(
  phoneE164: string,
  vaultId: string,
  excludeUserId: string | null,
): Promise<{ id: string; name: string } | null> {
  const db = await getDb();
  const sql = `
    SELECT DISTINCT u.id, u.display_name
      FROM users u
      INNER JOIN relationships r
        ON (r.user_a_id = u.id OR r.user_b_id = u.id)
     WHERE u.phone_e164 = ?
       AND r.vault_id   = ?
       AND r.archived_at IS NULL
       ${excludeUserId ? "AND u.id != ?" : ""}
     LIMIT 1`;
  const row = excludeUserId
    ? await db.getFirstAsync<{ id: string; display_name: string }>(
        sql,
        phoneE164,
        vaultId,
        excludeUserId,
      )
    : await db.getFirstAsync<{ id: string; display_name: string }>(sql, phoneE164, vaultId);
  return row ? { id: row.id, name: row.display_name } : null;
}

export async function appendPersonAdded(args: {
  userId: string;
  relationshipId: string;
  name: string;
  phoneE164: string | null;
  vaultId: string;
}): Promise<{ event_id: string }> {
  const eventId = Crypto.randomUUID();
  const installId = getInstallIdSync();
  const authorUserId = requireLocalSelfUserId();
  const accountId = getAccountIdSync();

  const event: PersonAddedEvent = {
    event_id: eventId,
    event_type: "person_added",
    vault_id: args.vaultId,
    target_id: args.userId,
    relationship_id: args.relationshipId,
    hlc: { pms: 0, l: 0, did: installId },
    device_id: installId,
    author_user_id_local_only: authorUserId,
    actor_account_id: accountId,
    payload_schema: CURRENT_PAYLOAD_SCHEMA,
    appended_at: 0,
    server_acked_at: null,
    rejected_at: null,
    origin: "local",
    payload: {
      user_id: args.userId,
      name: args.name,
      phone_e164: args.phoneE164,
      relationship_context: "peer",
    },
  };

  const result = await applyEvent(event, { origin: "local" });
  if (!result.applied) {
    if (result.reason === "role_gate" && result.role_gate) {
      throw new RoleGateRejectionError(result.role_gate);
    }
    throw new Error(`person_added event_id collision: ${eventId}`);
  }
  return { event_id: eventId };
}

export async function appendPersonRenamed(args: {
  userId: string;
  vaultId: string;
  name: string;
}): Promise<{ event_id: string } | null> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ display_name: string }>(
    "SELECT display_name FROM users WHERE id = ?",
    args.userId,
  );
  if (!row) return null;
  if (row.display_name === args.name) return null;

  const eventId = Crypto.randomUUID();
  const installId = getInstallIdSync();
  const authorUserId = requireLocalSelfUserId();
  const accountId = getAccountIdSync();

  const event: PersonRenamedEvent = {
    event_id: eventId,
    event_type: "person_renamed",
    vault_id: args.vaultId,
    target_id: args.userId,
    relationship_id: null,
    hlc: { pms: 0, l: 0, did: installId },
    device_id: installId,
    author_user_id_local_only: authorUserId,
    actor_account_id: accountId,
    payload_schema: CURRENT_PAYLOAD_SCHEMA,
    appended_at: 0,
    server_acked_at: null,
    rejected_at: null,
    origin: "local",
    payload: { name: args.name },
  };

  const result = await applyEvent(event, { origin: "local" });
  if (!result.applied) {
    if (result.reason === "role_gate" && result.role_gate) {
      throw new RoleGateRejectionError(result.role_gate);
    }
    return null;
  }
  return { event_id: eventId };
}

export async function appendPersonPhoneChanged(args: {
  userId: string;
  vaultId: string;
  phoneE164: string | null;
}): Promise<{ event_id: string } | null> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ phone_e164: string | null }>(
    "SELECT phone_e164 FROM users WHERE id = ?",
    args.userId,
  );
  if (!row) return null;
  if ((row.phone_e164 ?? null) === (args.phoneE164 ?? null)) return null;

  const eventId = Crypto.randomUUID();
  const installId = getInstallIdSync();
  const authorUserId = requireLocalSelfUserId();
  const accountId = getAccountIdSync();

  const event: PersonPhoneChangedEvent = {
    event_id: eventId,
    event_type: "person_phone_changed",
    vault_id: args.vaultId,
    target_id: args.userId,
    relationship_id: null,
    hlc: { pms: 0, l: 0, did: installId },
    device_id: installId,
    author_user_id_local_only: authorUserId,
    actor_account_id: accountId,
    payload_schema: CURRENT_PAYLOAD_SCHEMA,
    appended_at: 0,
    server_acked_at: null,
    rejected_at: null,
    origin: "local",
    payload: { phone_e164: args.phoneE164 },
  };

  const result = await applyEvent(event, { origin: "local" });
  if (!result.applied) {
    if (result.reason === "role_gate" && result.role_gate) {
      throw new RoleGateRejectionError(result.role_gate);
    }
    return null;
  }
  return { event_id: eventId };
}

export async function appendPersonArchived(args: {
  userId: string;
  relationshipId: string;
  vaultId: string;
}): Promise<{ event_id: string } | null> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ archived_at: number | null }>(
    "SELECT archived_at FROM relationships WHERE id = ? AND vault_id = ?",
    args.relationshipId,
    args.vaultId,
  );
  if (!row) return null;
  if (row.archived_at != null) return null;

  const eventId = Crypto.randomUUID();
  const installId = getInstallIdSync();
  const authorUserId = requireLocalSelfUserId();
  const accountId = getAccountIdSync();

  const event: PersonArchivedEvent = {
    event_id: eventId,
    event_type: "person_archived",
    vault_id: args.vaultId,
    target_id: args.userId,
    relationship_id: args.relationshipId,
    hlc: { pms: 0, l: 0, did: installId },
    device_id: installId,
    author_user_id_local_only: authorUserId,
    actor_account_id: accountId,
    payload_schema: CURRENT_PAYLOAD_SCHEMA,
    appended_at: 0,
    server_acked_at: null,
    rejected_at: null,
    origin: "local",
    payload: {},
  };

  const result = await applyEvent(event, {
    origin: "local",
    preflightAbort: async (tx) => {
      const r = await tx.getFirstAsync<{ archived_at: number | null }>(
        "SELECT archived_at FROM relationships WHERE id = ? AND vault_id = ?",
        args.relationshipId,
        args.vaultId,
      );
      return !r || r.archived_at != null;
    },
  });
  if (!result.applied) {
    if (result.reason === "role_gate" && result.role_gate) {
      throw new RoleGateRejectionError(result.role_gate);
    }
    return null;
  }
  return { event_id: eventId };
}

export async function appendPersonUnarchived(args: {
  userId: string;
  relationshipId: string;
  vaultId: string;
}): Promise<{ event_id: string } | null> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ archived_at: number | null }>(
    "SELECT archived_at FROM relationships WHERE id = ? AND vault_id = ?",
    args.relationshipId,
    args.vaultId,
  );
  if (!row) return null;
  if (row.archived_at == null) return null;

  const eventId = Crypto.randomUUID();
  const installId = getInstallIdSync();
  const authorUserId = requireLocalSelfUserId();
  const accountId = getAccountIdSync();

  const event: PersonUnarchivedEvent = {
    event_id: eventId,
    event_type: "person_unarchived",
    vault_id: args.vaultId,
    target_id: args.userId,
    relationship_id: args.relationshipId,
    hlc: { pms: 0, l: 0, did: installId },
    device_id: installId,
    author_user_id_local_only: authorUserId,
    actor_account_id: accountId,
    payload_schema: CURRENT_PAYLOAD_SCHEMA,
    appended_at: 0,
    server_acked_at: null,
    rejected_at: null,
    origin: "local",
    payload: {},
  };

  const result = await applyEvent(event, {
    origin: "local",
    preflightAbort: async (tx) => {
      const r = await tx.getFirstAsync<{ archived_at: number | null }>(
        "SELECT archived_at FROM relationships WHERE id = ? AND vault_id = ?",
        args.relationshipId,
        args.vaultId,
      );
      return !r || r.archived_at == null;
    },
  });
  if (!result.applied) {
    if (result.reason === "role_gate" && result.role_gate) {
      throw new RoleGateRejectionError(result.role_gate);
    }
    return null;
  }
  return { event_id: eventId };
}

export async function appendShopProfileUpdated(args: {
  vaultId: string;
  changes: Partial<{ shop_name: string; owner_name: string | null }>;
}): Promise<{ event_id: string } | null> {
  const normalizedChanges: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args.changes)) {
    if (v !== undefined) normalizedChanges[k] = v;
  }
  if (Object.keys(normalizedChanges).length === 0) return null;

  const eventId = Crypto.randomUUID();
  const installId = getInstallIdSync();
  const authorUserId = requireLocalSelfUserId();
  const accountId = getAccountIdSync();

  const event: ShopProfileUpdatedEvent = {
    event_id: eventId,
    event_type: "shop_profile_updated",
    vault_id: args.vaultId,
    // After migration 007 shop_profile is keyed by vault_id (no more id=1).
    target_id: args.vaultId,
    relationship_id: null,
    hlc: { pms: 0, l: 0, did: installId },
    device_id: installId,
    author_user_id_local_only: authorUserId,
    actor_account_id: accountId,
    payload_schema: CURRENT_PAYLOAD_SCHEMA,
    appended_at: 0,
    server_acked_at: null,
    rejected_at: null,
    origin: "local",
    payload: {
      changes: normalizedChanges as ShopProfileUpdatedEvent["payload"]["changes"],
    },
  };

  const result = await applyEvent(event, { origin: "local" });
  if (!result.applied) {
    if (result.reason === "role_gate" && result.role_gate) {
      throw new RoleGateRejectionError(result.role_gate);
    }
    return null;
  }
  return { event_id: eventId };
}

// Phase 4: vault-scoped settings (currency, display prefs). Each
// (vault_id, key) row in vault_settings is LWW-resolved per-key by the
// vault_setting_set applier.
export async function appendVaultSettingSet(args: {
  targetVaultId: string;
  key: string;
  value: string;
}): Promise<{ event_id: string }> {
  const eventId = Crypto.randomUUID();
  const installId = getInstallIdSync();
  const authorUserId = requireLocalSelfUserId();
  const accountId = getAccountIdSync();

  const event: VaultSettingSetEvent = {
    event_id: eventId,
    event_type: "vault_setting_set",
    vault_id: args.targetVaultId,
    // target_id is the vault_id — the setting is scoped to it.
    target_id: args.targetVaultId,
    relationship_id: null,
    hlc: { pms: 0, l: 0, did: installId },
    device_id: installId,
    author_user_id_local_only: authorUserId,
    actor_account_id: accountId,
    payload_schema: CURRENT_PAYLOAD_SCHEMA,
    appended_at: 0,
    server_acked_at: null,
    rejected_at: null,
    origin: "local",
    payload: { key: args.key, value: args.value },
  };

  const result = await applyEvent(event, { origin: "local" });
  if (!result.applied && result.reason === "role_gate" && result.role_gate) {
    throw new RoleGateRejectionError(result.role_gate);
  }
  return { event_id: eventId };
}

// ---------- Phase 8 / D-OFFLINE-* : vault membership append helpers ----------
//
// These three helpers let the owner mutate vault membership OFFLINE. The
// projection appliers in lib/projection/vault_members.ts own the side
// effects (mirror update + revocation_list rows + vault_epoch bump) so
// that locally-authored writes and remotely-received gossip converge to
// the same state.
//
// We intentionally do NOT block on the server here. The sync worker (Part G)
// will fire-and-forget the event whenever the device comes online; mesh
// anti-entropy gossips it to nearby peers regardless of internet.
//
// Local-CA threat model: the owner's device key IS the vault trust anchor
// (Phase 7), so an owner-emitted vault_member_* event landing in the local
// event_log IS the authoritative mutation. Other devices apply it through
// the same applier path on receipt — no server consensus required.

export async function appendVaultMemberAdded(args: {
  targetVaultId: string;
  accountId: string;
  role: VaultRole;
}): Promise<{ event_id: string }> {
  const eventId = Crypto.randomUUID();
  const installId = getInstallIdSync();
  const authorUserId = requireLocalSelfUserId();
  const actorAccountId = getAccountIdSync();

  const event: VaultMemberAddedEvent = {
    event_id: eventId,
    event_type: "vault_member_added",
    vault_id: args.targetVaultId,
    // target_id keys the (vault_id, target_id) HLC sidecar lookup; for
    // membership events the target IS the account being added.
    target_id: args.accountId,
    relationship_id: null,
    hlc: { pms: 0, l: 0, did: installId },
    device_id: installId,
    author_user_id_local_only: authorUserId,
    actor_account_id: actorAccountId,
    payload_schema: CURRENT_PAYLOAD_SCHEMA,
    appended_at: 0,
    server_acked_at: null,
    rejected_at: null,
    origin: "local",
    payload: { account_id: args.accountId, role: args.role },
  };

  const result = await applyEvent(event, { origin: "local" });
  if (!result.applied && result.reason === "role_gate" && result.role_gate) {
    throw new RoleGateRejectionError(result.role_gate);
  }
  return { event_id: eventId };
}

export async function appendVaultMemberRoleChanged(args: {
  targetVaultId: string;
  accountId: string;
  role: VaultRole;
}): Promise<{ event_id: string }> {
  const eventId = Crypto.randomUUID();
  const installId = getInstallIdSync();
  const authorUserId = requireLocalSelfUserId();
  const actorAccountId = getAccountIdSync();

  const event: VaultMemberRoleChangedEvent = {
    event_id: eventId,
    event_type: "vault_member_role_changed",
    vault_id: args.targetVaultId,
    target_id: args.accountId,
    relationship_id: null,
    hlc: { pms: 0, l: 0, did: installId },
    device_id: installId,
    author_user_id_local_only: authorUserId,
    actor_account_id: actorAccountId,
    payload_schema: CURRENT_PAYLOAD_SCHEMA,
    appended_at: 0,
    server_acked_at: null,
    rejected_at: null,
    origin: "local",
    payload: { account_id: args.accountId, role: args.role },
  };

  const result = await applyEvent(event, { origin: "local" });
  if (!result.applied && result.reason === "role_gate" && result.role_gate) {
    throw new RoleGateRejectionError(result.role_gate);
  }
  return { event_id: eventId };
}

export async function appendVaultMemberRemoved(args: {
  targetVaultId: string;
  accountId: string;
}): Promise<{ event_id: string }> {
  const eventId = Crypto.randomUUID();
  const installId = getInstallIdSync();
  const authorUserId = requireLocalSelfUserId();
  const actorAccountId = getAccountIdSync();

  const event: VaultMemberRemovedEvent = {
    event_id: eventId,
    event_type: "vault_member_removed",
    vault_id: args.targetVaultId,
    target_id: args.accountId,
    relationship_id: null,
    hlc: { pms: 0, l: 0, did: installId },
    device_id: installId,
    author_user_id_local_only: authorUserId,
    actor_account_id: actorAccountId,
    payload_schema: CURRENT_PAYLOAD_SCHEMA,
    appended_at: 0,
    server_acked_at: null,
    rejected_at: null,
    origin: "local",
    payload: { account_id: args.accountId },
  };

  const result = await applyEvent(event, { origin: "local" });
  if (!result.applied && result.reason === "role_gate" && result.role_gate) {
    throw new RoleGateRejectionError(result.role_gate);
  }
  return { event_id: eventId };
}

export async function appendAccountBound(args: {
  fromUserId: string;
  accountId: string;
  retroactiveThroughEventId: string;
  vaultId: string;
}): Promise<{ event_id: string } | null> {
  // Idempotent at the local layer: don't emit a second account_bound for
  // the same (target_id, vault_id, account_id) tuple. The account_id is
  // load-bearing on the dedup key because a user may sign out and then
  // sign in with a DIFFERENT Google account on the same install/vault —
  // each switch must emit a fresh account_bound so the backend can
  // re-attribute the events authored under the new account, even though
  // the local-self user (fromUserId) is the same physical row.
  const db = await getDb();
  const existing = await db.getFirstAsync<{ event_id: string }>(
    `SELECT event_id FROM event_log
      WHERE event_type = 'account_bound'
        AND target_id  = ?
        AND vault_id   = ?
        AND actor_account_id = ?
      LIMIT 1`,
    args.fromUserId,
    args.vaultId,
    args.accountId,
  );
  if (existing) return null;

  const eventId = Crypto.randomUUID();
  const installId = getInstallIdSync();
  const authorUserId = requireLocalSelfUserId();

  const event: AccountBoundEvent = {
    event_id: eventId,
    event_type: "account_bound",
    vault_id: args.vaultId,
    target_id: args.fromUserId,
    relationship_id: null,
    hlc: { pms: 0, l: 0, did: installId },
    device_id: installId,
    author_user_id_local_only: authorUserId,
    // This is the first event the local-self user authors as an
    // authenticated principal. Backend uses retroactive_through_event_id
    // to re-attribute every prior event for ACL purposes.
    actor_account_id: args.accountId,
    payload_schema: CURRENT_PAYLOAD_SCHEMA,
    appended_at: 0,
    server_acked_at: null,
    rejected_at: null,
    origin: "local",
    payload: {
      from_user_id: args.fromUserId,
      account_id: args.accountId,
      retroactive_through_event_id: args.retroactiveThroughEventId,
    },
  };

  const result = await applyEvent(event, { origin: "local" });
  if (!result.applied) {
    // account_bound has REQUIRED_ROLE = "none" — role-gate cannot fire on
    // it. Anything other than `duplicate` here would be a programmer
    // error, but we keep the discriminated branching uniform with the
    // other append helpers.
    if (result.reason === "role_gate" && result.role_gate) {
      throw new RoleGateRejectionError(result.role_gate);
    }
    return null;
  }
  return { event_id: eventId };
}

// ---------- internal helpers ----------

function requireLocalSelfUserId(): string {
  const id = getLocalSelfUserIdSync();
  if (!id) {
    throw new Error(
      "cannot append event: no local-self user — onboarding must complete before any entry write",
    );
  }
  return id;
}
