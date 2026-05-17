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

// View types — what the rest of the app sees. These are derived by joining
// users + relationships + entry aggregates. Field names match v0 so screens
// remain unchanged.

export type Shopkeeper = {
  id: number; // always 1, from shop_profile
  shop_name: string;
  owner_name: string | null;
  created_at: number;
};

// The local user (always exists once onboarded). Shop name is optional —
// Kaata supports personal use without a store.
export type Self = {
  user_id: string;
  name: string; // user.display_name
  shop_name: string | null; // null if user didn't set up a store
};

export type Customer = {
  id: string; // user_id
  name: string; // user.display_name
  phone: string | null; // user.phone_e164 (E.164)
  created_at: number;
  archived_at: number | null; // relationship.archived_at
};

export type CustomerWithBalance = Customer & {
  balance: number;
};

// Result of attempting to create a customer. The phone-collision and
// phone-invalid cases let the screen render targeted errors instead of
// silently dropping the phone to NULL.
export type CreateCustomerResult =
  | { ok: true; id: string }
  | { ok: false; error: "phone_invalid" }
  | { ok: false; error: "phone_conflict"; existing: { id: string; name: string } };

// Same error shape as create, returned by updateCustomer.
export type UpdateCustomerResult =
  | { ok: true }
  | { ok: false; error: "phone_invalid" }
  | { ok: false; error: "phone_conflict"; existing: { id: string; name: string } };

// Backend check-in response — unchanged.
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
};
