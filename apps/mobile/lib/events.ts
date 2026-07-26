// Discriminated union of every event that can land in the append-only event
// log. Phase 1 (v0.5.0) will only ever append entry_* events; the rest are
// declared from day one so the wire format never has to widen later — adding
// a new event type in Phase 4 is a code change in projection appliers, not a
// schema migration.
//
// This file is types + a known-types set. No runtime applier dispatch yet —
// that arrives in lib/event-log.ts with migration 005.

import type { HLC } from "./hlc";
import type { EntryType } from "./types";

// Roles v2 (docs/roles-v2-design.md): viewer < clerk < editor < manager <
// owner. clerk = append-only (create entries/people, never amend/delete);
// manager = editor + member management strictly below manager rank.
// Phase A: every layer understands these; no UI grants them yet.
// ALSO declared structurally in lib/trust/chain.ts — change BOTH together.
export type VaultRole = "owner" | "manager" | "editor" | "clerk" | "viewer";

// Common envelope around every payload. Kept separate so payload-only
// changes don't need to re-spell the envelope.
type EventEnvelope = {
  event_id: string; // UUIDv4 from Crypto.randomUUID
  vault_id: string | null; // null until Phase 2 backfill, then required
  target_id: string; // entry_id | users.id | account_id | vault_id (per event type)
  relationship_id: string | null; // only set on entry events
  hlc: HLC;
  device_id: string; // == hlc.did, kept on the envelope for query convenience
  author_user_id_local_only: string; // device-local users.id at authoring time; NEVER sent over wire
  actor_account_id: string | null; // null pre-sign-in; later resolved via account_bound
  payload_schema: number; // forward-compat; current = 1
  appended_at: number; // local Date.now() at insert
  server_acked_at: number | null; // null until backend ack
  rejected_at: number | null; // non-null when server rejected (insufficient role etc.)
  origin: "local" | "remote" | "backfill";
  // Phase 8 D-ROLE-ENFORCEMENT-MOBILE event signing (migration 013).
  // Ed25519 signature over canonicalizeEvent(<this envelope w/o sig>+payload),
  // base64-encoded (64 bytes raw -> 88 chars b64). Required on every
  // origin='local' event authored from Phase 8 onward; required on every
  // origin='remote' event accepted via mesh / sync pull. Optional only for
  // origin='backfill' (pre-013 synthetic events) and origin='local' events
  // appended before the device key was generated (edge case during the
  // very first install bootstrap before ensureDeviceKey resolves).
  event_sig_b64?: string | null;
  // Snapshot of the signing device's Ed25519 pubkey (base64). Bound at
  // authoring time so a replay can re-verify even if the corresponding
  // vault_credentials row has since been evicted. Required when
  // event_sig_b64 is non-null; null otherwise.
  signer_device_pubkey?: string | null;
  // Sync v2 M1 (migration 018): per-author sequence number, scoped to
  // (vault_id, device_id), assigned at append time by the authoring device.
  // TRANSFER BOOKKEEPING ONLY: deliberately NOT in the signed envelope
  // (lib/event-sig.ts) and never consulted by projection/merge — HLC stays
  // the merge order. Replicas use it to express version vectors
  // (lib/replication). As of M3.5 it travels on the MESH wire too
  // (WireMeshEvent.author_seq) and the mesh ingest persists it, so it is the
  // authoritative completeness mechanism on every channel; null only on a
  // slot-conflict sacrifice (a fresh honest system never hits that).
  author_seq?: number | null;
};

// ---------- Entry events (Phase 1) ----------

export type EntryCreatedEvent = EventEnvelope & {
  event_type: "entry_created";
  payload: {
    entry_id: string;
    relationship_id: string;
    type: EntryType; // 'debt' = I gave; 'payment' = I received
    amount_afn: number;
    note: string | null;
    occurred_at_ms: number;
    // Optional backfill flags carried by migration 006 so that replaying the
    // event log on a fresh device rebuilds the legacy timestamp columns
    // (accepted_at / disputed_at / settled_at). Applier projects them only
    // when present. Phase 4 will replace these with dedicated events
    // (entry_settled / entry_accepted / entry_disputed); this is the
    // single-event compatibility bridge until then.
    backfill_synthetic?: true;
    backfill_accepted_at?: number | null;
    backfill_disputed_at?: number | null;
    backfill_disputed_reason?: string | null;
    backfill_settled_at?: number | null;
  };
};

// Delta only. LWW-by-field needs to know which fields the author intended to
// change, so a concurrent edit on a different field survives.
export type EntryAmendedEvent = EventEnvelope & {
  event_type: "entry_amended";
  payload: {
    changes: Partial<{
      amount_afn: number;
      note: string | null;
      type: EntryType;
      occurred_at_ms: number;
    }>;
    // Set by migration 006 when the pre-amendment value can't be recovered
    // from the existing entries row.
    backfill_synthetic?: true;
  };
};

export type EntryDeletedEvent = EventEnvelope & {
  event_type: "entry_deleted";
  payload: Record<string, never>;
};

// Reserved for Phase 4 (customer-side ack).
export type EntrySettledEvent = EventEnvelope & {
  event_type: "entry_settled";
  payload: { settled_at_ms: number };
};

// ---------- Person events (Phase 2/3) ----------

export type PersonAddedEvent = EventEnvelope & {
  event_type: "person_added";
  payload: {
    user_id: string;
    name: string;
    phone_e164: string | null;
    relationship_context: "peer";
  };
};

export type PersonRenamedEvent = EventEnvelope & {
  event_type: "person_renamed";
  payload: { name: string };
};

export type PersonPhoneChangedEvent = EventEnvelope & {
  event_type: "person_phone_changed";
  payload: { phone_e164: string | null };
};

export type PersonArchivedEvent = EventEnvelope & {
  event_type: "person_archived";
  payload: Record<string, never>;
};

export type PersonUnarchivedEvent = EventEnvelope & {
  event_type: "person_unarchived";
  payload: Record<string, never>;
};

// ---------- Shop profile events (Phase 2/3) ----------

export type ShopProfileUpdatedEvent = EventEnvelope & {
  event_type: "shop_profile_updated";
  payload: {
    // Delta only, same reason as entry_amended.
    changes: Partial<{
      shop_name: string;
      owner_name: string | null;
    }>;
  };
};

// ---------- Vault setting events (Phase 2+) ----------

export type VaultSettingSetEvent = EventEnvelope & {
  event_type: "vault_setting_set";
  payload: { key: string; value: string };
};

// ---------- Vault membership events (Phase 4; M2 membership chain) ----------

// M2 (docs/m2-membership-chain.md §2): a server-witness attestation attached
// to membership events admitted via the ONLINE path (email invite / new
// device of a signed-in member). The witness proves what the owner's device
// couldn't sign in person: "the server verified this account/device claim".
// Verified against the pinned server signing pubkey(s); ±7d freshness vs
// the event HLC. Offline/QR-path events carry NO witness — they're signed
// directly by an owner-bound device, which is the stronger statement.
export type MembershipWitness = {
  sig_b64: string;
  server_key_id: string;
  issued_at_ms: number;
  // member_added witnesses additionally name the inviter whose brokered
  // invite proves owner intent.
  inviter_account_id?: string;
};

export type VaultMemberAddedEvent = EventEnvelope & {
  event_type: "vault_member_added";
  payload: {
    account_id: string;
    role: VaultRole;
    display_name?: string | null;
    witness?: MembershipWitness;
    // Set on chain-genesis backfill admissions (M2 §5) so replicas can
    // distinguish "owner attested pre-chain membership" from organic adds.
    backfill_synthetic?: true;
  };
};

export type VaultMemberRoleChangedEvent = EventEnvelope & {
  event_type: "vault_member_role_changed";
  payload: { account_id: string; role: VaultRole };
};

export type VaultMemberRemovedEvent = EventEnvelope & {
  event_type: "vault_member_removed";
  payload: { account_id: string };
};

// M2: binds a device public key to a member account inside the chain.
// Signed by an owner-bound device (QR path) OR self-signed by the named
// device with a server witness (online path). The device registry fold
// (vault_device_registry) is what lets the role-gate authenticate a remote
// event's signer without the legacy vault_credentials VMC cache.
export type VaultDeviceAddedEvent = EventEnvelope & {
  event_type: "vault_device_added";
  payload: {
    account_id: string;
    device_id: string;
    device_pubkey: string; // base64 Ed25519, same encoding as signer_device_pubkey
    witness?: MembershipWitness;
    backfill_synthetic?: true;
  };
};

export type VaultDeviceRemovedEvent = EventEnvelope & {
  event_type: "vault_device_removed";
  payload: { device_id: string };
};

// ---------- Account binding (Phase 2) ----------

// Emitted once when the local-self user signs in to Google for the first
// time. Backend projection treats every event with event_id <=
// retroactive_through_event_id on the same vault as authored by account_id
// for ACL purposes. Preserves append-only purity instead of mutating the
// actor_account_id column on prior events.
export type AccountBoundEvent = EventEnvelope & {
  event_type: "account_bound";
  payload: {
    from_user_id: string;
    account_id: string;
    retroactive_through_event_id: string;
  };
};

// ---------- Union & helpers ----------

export type LedgerEvent =
  | EntryCreatedEvent
  | EntryAmendedEvent
  | EntryDeletedEvent
  | EntrySettledEvent
  | PersonAddedEvent
  | PersonRenamedEvent
  | PersonPhoneChangedEvent
  | PersonArchivedEvent
  | PersonUnarchivedEvent
  | ShopProfileUpdatedEvent
  | VaultSettingSetEvent
  | VaultMemberAddedEvent
  | VaultMemberRoleChangedEvent
  | VaultMemberRemovedEvent
  | VaultDeviceAddedEvent
  | VaultDeviceRemovedEvent
  | AccountBoundEvent;

export type EventType = LedgerEvent["event_type"];

// Used by applyEvent (Phase 1) to reject unknown event_type strings at insert
// time. New event types added here MUST also have a projection applier in
// lib/projection/ AND a Go counterpart at apps/backend/internal/sync/project.go
// AND a fixture in apps/_shared/projection-corpus/.
export const KNOWN_EVENT_TYPES: ReadonlySet<EventType> = new Set([
  "entry_created",
  "entry_amended",
  "entry_deleted",
  "entry_settled",
  "person_added",
  "person_renamed",
  "person_phone_changed",
  "person_archived",
  "person_unarchived",
  "shop_profile_updated",
  "vault_setting_set",
  "vault_member_added",
  "vault_member_role_changed",
  "vault_member_removed",
  "vault_device_added",
  "vault_device_removed",
  "account_bound",
]);

export function isKnownEventType(t: string): t is EventType {
  // Set.has accepts any value; no narrowing cast needed.
  return (KNOWN_EVENT_TYPES as ReadonlySet<string>).has(t);
}

// Event types that carry the user's actual LEDGER DATA (tallies, contacts, shop
// profile) — as opposed to membership / device / vault-config / account events.
// These must NEVER be permanently discarded (push rejected_at, or a sweep
// tombstone) over a recoverable condition: the product invariant is "a tally
// never disappears". Membership/device/vault events are NOT here — the server
// holds their canonical copy and a genuinely-bad one of those must not loop or
// resurface forever.
const USER_LEDGER_EVENT_TYPES: ReadonlySet<string> = new Set<string>([
  "entry_created",
  "entry_amended",
  "entry_deleted",
  "entry_settled",
  "person_added",
  "person_renamed",
  "person_phone_changed",
  "person_archived",
  "person_unarchived",
  "shop_profile_updated",
]);

export function isUserLedgerEventType(t: string): boolean {
  return USER_LEDGER_EVENT_TYPES.has(t);
}
