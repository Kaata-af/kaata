// apps/mobile/lib/tabs/types.ts
//
// Mutual tab (Kaata 2.0) — the wire shapes shared with apps/backend/internal/tabs
// and the local cache rows (migration 028). Normative source:
// docs/mutual-tab-design.md §3.4 (wire) and §4.1 (tables). Anything here that
// drifts from those sections is a bug in this file, not in the doc.
//
// Two conventions worth restating because they are the ones people get wrong:
//   - Direction is ABSOLUTE on the wire (D4): `a_to_b` means value moved from
//     party a to party b. Each side derives "I gave" / "I received" from its
//     own role (lib/tabs/direction.ts). Nothing here is "relative to me".
//   - Money on the wire is a decimal STRING in major units (D16); locally it is
//     INTEGER hundredths in tab_entries.amount_minor — unlike entries.amount_afn,
//     which stores major units. lib/tabs/wire.ts converts; never go through a
//     float.

/** Which side of the tab: the creator is `a`, the invitee is `b`. */
export type TabRole = "a" | "b";
/** Value moved from X to Y. The target now owes the source more. */
export type TabDirection = "a_to_b" | "b_to_a";
/** Pending/accepted tallies count; rejected (wire: disputed) tallies do not. */
export type TabEntryStatus = "pending" | "accepted" | "disputed";
/** `opening` is the carried-over balance at link time (D7); `void` is the
 *  visible cancellation row that references the original (D5). */
export type TabEntryKind = "entry" | "opening" | "void";
/** Outbox operations, in the order the server exposes them as routes. */
export type TabOutboxOp = "append" | "accept" | "dispute" | "void" | "label" | "close";

// ---------------------------------------------------------------------------
// Wire (§3.4). All timestamps are epoch ms; all amounts are decimal strings.

export type WireEntry = {
  id: string;
  seq: number;
  rev: number;
  created_by: TabRole;
  direction: TabDirection;
  amount: string;
  kind: TabEntryKind;
  note: string | null;
  occurred_at_ms: number;
  created_at_ms: number;
  status: TabEntryStatus;
  status_at_ms: number | null;
  dispute_reason: string | null;
  voids_entry_id: string | null;
  voided_by_entry_id: string | null;
};

export type WireParty = {
  /** How this party names ITSELF; shown to the other side. */
  label: string;
  joined_at_ms: number | null;
  /** True once an account is bound to the party (JWT access works). */
  bound: boolean;
};

export type WireTab = {
  id: string;
  currency: string;
  rev: number;
  created_at_ms: number;
  closed_at_ms: number | null;
  closed_by: TabRole | null;
  /** The caller's role, as the server resolved it from the token / JWT. */
  you: TabRole;
  parties: Record<TabRole, WireParty>;
  /** Signed balance from EACH party's view, "0" when settled. */
  balance: Record<TabRole, string>;
  /** Entries by the other party with status 'pending' and not voided. */
  pending_for_you: number;
};

export type OpeningRequest = {
  direction: TabDirection;
  amount: string;
  note: string | null;
  occurred_at_ms: number;
};

export type CreateRequest = {
  linked_at_ms?: number;
  currency: string;
  label: string;
  vault_id: string | null;
  relationship_id: string | null;
  opening: OpeningRequest | null;
};

export type CreateResponse = {
  tab: WireTab;
  entries: WireEntry[];
  my_token: string;
  invite_token: string;
  invite_url: string;
};

export type JoinRequest = {
  linked_at_ms?: number;
  label: string;
  vault_id: string | null;
  relationship_id: string | null;
};

export type AppendRequest = {
  id: string;
  direction: TabDirection;
  amount: string;
  note: string | null;
  occurred_at_ms: number;
};

/** D17: the same transfer, as the OTHER party recorded it within ±24 h. */
export type DuplicateHint = { entry_id: string; by: TabRole; at_ms: number };

export type EntryResponse = {
  entry: WireEntry;
  tab: WireTab;
  duplicate_hint: DuplicateHint | null;
};

export type VoidResponse = { voided: WireEntry; void: WireEntry };

export type TabResponse = {
  tab: WireTab;
  /** Entries with rev > after_rev, ordered by rev ASC. */
  entries: WireEntry[];
  /** True when after_rev was 0/absent: the client may replace its cache. */
  full: boolean;
};

export type MineResponse = {
  tabs: Array<{
    tab: WireTab;
    role: TabRole;
    vault_id: string | null;
    relationship_id: string | null;
    linked_at_ms?: number | null;
  }>;
};

// ---------------------------------------------------------------------------
// Local cache rows (§4.1). Column-for-column with migration 028 in lib/db.ts.

export type TabLink = {
  tab_id: string;
  vault_id: string;
  relationship_id: string;
  role: TabRole;
  currency: string;
  /** NULL when only JWT-bound (recovered via GET /v1/tabs/mine). */
  party_token: string | null;
  my_label: string;
  other_label: string;
  other_joined_at: number | null;
  /** Party a keeps B's link for re-sharing; NULL on party b. */
  invite_url: string | null;
  /** Pull cursor = highest rev applied. */
  rev: number;
  closed_at: number | null;
  linked_at: number;
  last_synced_at: number | null;
  last_error: string | null;
};

export type TabEntryRow = {
  id: string;
  tab_id: string;
  seq: number;
  rev: number;
  created_by: TabRole;
  direction: TabDirection;
  /** Integer hundredths — NOT major units like entries.amount_afn. */
  amount_minor: number;
  kind: TabEntryKind;
  note: string | null;
  occurred_at: number;
  created_at: number;
  status: TabEntryStatus;
  status_at: number | null;
  dispute_reason: string | null;
  voids_entry_id: string | null;
  voided_by_entry_id: string | null;
  /** 1 = optimistic row not yet acked by the server. */
  local_pending: number;
};

export type TabOutboxRow = {
  /** Op id (uuid); for 'append' this IS the entry id (server idempotency key). */
  id: string;
  tab_id: string;
  op: TabOutboxOp;
  /** JSON, shape per op — see lib/tabs/sync.ts performOp. */
  payload: string;
  created_at: number;
  attempts: number;
  next_at: number | null;
  last_error: string | null;
};

/**
 * What EntryRow and the exporters need about a tab row, attached to the
 * mapped `Entry` as `entry.tab`. Absent on ordinary local entries.
 */
export type TabEntryMeta = {
  by: "me" | "them";
  status: TabEntryStatus;
  dispute_reason: string | null;
  kind: TabEntryKind;
  /** The original was cancelled by a later void row; render struck. */
  voided: boolean;
  /** Optimistic row the server has not acked yet ("Sending…"). */
  local_pending: boolean;
  other_label: string;
};

/** Payload of the onTabApplied notifier (lib/tabs/events.ts). */
export type TabAppliedEvent = {
  tabId: string;
  relationshipId: string;
  vaultId: string;
  /** Rows by the OTHER party newly seen (kind != 'void'). */
  newFromThem: number;
  /** MY rows whose status or voided flag changed. */
  statusChangedOnMine: number;
  /** "pull" = server state landed; "local" = this device's own optimistic write. */
  origin: "pull" | "local";
  changes?: Array<{ entryId: string; rev: number; kind: "entry_created" | "entry_accepted" | "entry_rejected" | "entry_voided" }>;

};
