// Storage types — match the SQLite schema 1:1.

export type User = {
  id: string;
  phone_e164: string | null;
  display_name: string;
  is_local_self: number; // 0 or 1
  created_at: number;
  updated_at: number;
  archived_at: number | null;
};

export type ShopProfile = {
  id: number; // always 1
  user_id: string;
  shop_name: string;
  owner_name: string | null;
  created_at: number;
  updated_at: number;
};

// Schema-level relationship context. v1.1 collapses every relationship to
// 'peer' — the column is kept for Phase 2 (e.g. distinguishing business credit
// from personal lending) but the UI is direction-agnostic now.
export type RelationshipContext = "customer" | "supplier" | "peer";

export type Relationship = {
  id: string;
  user_a_id: string;
  user_b_id: string;
  context: RelationshipContext;
  created_at: number;
  updated_at: number;
  archived_at: number | null;
};

// Entry types stay 'debt' / 'payment' in the DB but are no longer user-visible
// labels. They now mean:
//   'debt'    → value flowed from me to them ("I gave"). Balance += amount.
//   'payment' → value flowed from them to me ("I received"). Balance -= amount.
// Same semantic regardless of who's currently ahead.
export type EntryType = "debt" | "payment";

export type Entry = {
  id: string;
  relationship_id: string;
  type: EntryType;
  amount_afn: number;
  note: string | null;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
  // Phase 2 columns — nullable in v1, populated when a customer-side app exists.
  proposed_by_user_id: string | null;
  accepted_at: number | null;
  disputed_at: number | null;
  disputed_reason: string | null;
  settled_at: number | null;
};

// Max characters a tally note can hold. Enforced on input (TextInput maxLength)
// AND defensively re-clamped at save time. The `note` column itself is plain
// TEXT (no DB limit), and the shared-ledger snapshot only caps total bytes
// (128 KiB, see backend handler.go maxPayload) and entry count — so this is the
// single source of truth. Worst case is ~105 KB at the 100-entry (share.ts
// MAX_SHARED_ENTRIES) × 500-char max for 2-byte UTF-8 (Dari/Persian, our users)
// — under the 128 KiB cap with graceful overflow, but raising either this limit
// or MAX_SHARED_ENTRIES must re-check that bound. The row preview clamps to one
// line + tap-to-expand, so length here is free to grow.
export const ENTRY_NOTE_MAX_LENGTH = 500;

// View types — what the rest of the app sees.

// Home-screen tab identifier. Not a property of a person — only a filter
// over net balance signs.
export type Direction = "collect" | "pay";

export type Self = {
  user_id: string;
  name: string;
  shop_name: string | null;
  phone: string | null;
};

export type Person = {
  id: string; // user_id
  name: string;
  phone: string | null;
  created_at: number;
  archived_at: number | null;
};

// `balance` is signed: positive = they owe me, negative = I owe them, zero = settled.
// Consumers usually display `Math.abs(balance)` and infer direction from the sign.
export type PersonWithBalance = Person & {
  balance: number;
  last_entry_at: number | null;
};

export type CreatePersonResult =
  | { ok: true; id: string }
  | { ok: false; error: "phone_invalid" }
  | { ok: false; error: "phone_conflict"; existing: { id: string; name: string } };

export type UpdatePersonResult =
  | { ok: true }
  | { ok: false; error: "phone_invalid" }
  | { ok: false; error: "phone_conflict"; existing: { id: string; name: string } };

export type CheckInResponse = {
  server_time: string;
  latest_version: string;
  force_update: boolean;
  update: {
    version: string;
    apk_url: string | null;
    play_store_url: string | null;
    release_notes: string | null;
  } | null;
  announcement: {
    id: number;
    title: string;
    body: string;
    cta_label: string | null;
    cta_url: string | null;
  } | null;
  // When set (string, including ""), mobile persists to `app_meta.backend_url_override`
  // and uses it for the next check-in. Empty string clears any prior override
  // (return to env default). Omitted/null leaves the current setting alone.
  migrate_to_backend_url?: string | null;
  // #43 P2 REMOTE kill-switch for killed-app background mesh sync. Default ABSENT
  // => OFF (so the live fleet sees zero change until the backend flips it for a
  // cohort; a bad rollout is reverted server-side with no APK push). When present,
  // mobile persists to `app_meta.bg_mesh_enabled` AND mirrors it to native
  // SharedPrefs (KaataBgMeshGate) so the background entry can read it post-kill.
  // Like force_update, treat with a fail-closed bias. Omitted/null = leave as-is.
  bg_mesh_enabled?: boolean | null;
  // #43 P2 cutover flag (default ABSENT => OFF): when true the background path
  // runs the NATIVE MeshEngine (resident JVM, Briar-model) instead of the
  // headless-JS window. Mirrored to native (KaataBgMeshGate.native_engine_enabled)
  // + the device seed is injected so the engine can sign post-kill. Staged
  // per-cohort from the backend; omitted/null = leave as-is.
  native_engine_enabled?: boolean | null;
  // Rolling JWT refresh. Backend returns this when an authenticated check-in
  // arrives with a session token older than RefreshIfOlderThan (7 days). The
  // mobile client overwrites SecureStore[kaata.session.jwt] silently — no UI
  // surface. Absent for anonymous check-ins and for tokens still within the
  // freshness window.
  session_jwt_refresh?: string | null;

  // Mesh: incremental revocation list since the client's
  // `last_revocation_seen_at_ms`. The backend re-sources this from
  // membership events (M4). Mobile UPSERTs into revocation_list and bumps
  // the high-water mark.
  revocations?: Array<{
    vault_id: string;
    device_id: string;
    revoked_at_ms: number;
  }> | null;

  // Mesh: pinned server witness signing key(s). When configured
  // server-side, present on EVERY response so first-sight pinning +
  // rotation handoff both ride this channel.
  mesh_server_pubkeys?: {
    primary: string;
    rotation?: string | null;
  } | null;
};
