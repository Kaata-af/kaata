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

// View types — what the rest of the app sees.

// Home-screen tab identifier. Not a property of a person — only a filter
// over net balance signs.
export type Direction = "collect" | "pay";

export type Self = {
  user_id: string;
  name: string;
  shop_name: string | null;
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
  next_backend_url?: string | null;
};
