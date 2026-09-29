// Data layer for the admin dashboard. Types mirror the backend structs
// (apps/backend/internal/admin/service.go `Stats`, users.go `UsersResult`,
// outreach.go `OutreachResult`) and the /v1/admin/growth contract from the
// dashboard spec. Every endpoint shares the paste-once Bearer key; a 401
// anywhere throws AuthError, which the QueryCache in AdminApp catches to clear
// the stored key and re-show the prompt (the same "wrong key" UX the old
// single-file dashboard had). Reads are GETs through `fetchAdmin`; the
// Outreach section's writes (2026-09-29) are JSON POSTs through `postAdmin` —
// POST rather than PATCH/DELETE because the backend's CORS allow-list is
// GET/POST/OPTIONS only.

import { useQuery } from "@tanstack/react-query";
import { createContext, useContext } from "react";
import { BACKEND_URL } from "../../env";

// Key name is load-bearing: existing operator browsers already hold the admin
// key under this exact name — renaming would sign everyone out.
export const TOKEN_KEY = "kaata_admin_token";

export class AuthError extends Error {
  constructor() {
    super("Wrong admin key.");
    this.name = "AuthError";
  }
}

// ---- /v1/admin/stats ----

// `store_clicks` (deduped like downloads) ships with the store-era backend;
// optional so a dashboard deployed ahead of that backend still renders — the
// funnel falls back to the legacy APK-downloads stage when it's absent.
export type SourceRow = {
  source: string;
  visits: number;
  downloads: number;
  store_clicks?: number;
  attributed: number;
  // Traffic the aggregate REJECTED for this source (operator IPs, bot/preview
  // user agents) plus the undeduped visit count. Optional for the same
  // old-backend reason as store_clicks. Without these a campaign scanned only
  // by the operator reads 0/0/0/0 — identical to a QR nobody ever scanned,
  // which is how a working QR gets reported as broken.
  raw_visits?: number;
  excluded?: number;
};
export type LocaleCount = { locale: string; count: number };
export type SeriesPoint = { t: string; installs: number; active: number };

export type Stats = {
  installs_total: number;
  onboarded: number;
  with_entries: number;
  with_shares: number;
  active_7d: number;
  active_30d: number;
  ever_active: number;
  distinct_accounts: number;
  entries_sum: number;
  customers_sum: number;
  shares_sum: number;
  visits: number;
  downloads: number;
  // Optional for the same old-backend reason as SourceRow.store_clicks.
  store_clicks?: number;
  raw_visits: number;
  excluded_installs: number;
  excluded_visits: number;
  dau: number;
  wau: number;
  mau: number;
  ret_d1_eligible: number;
  ret_d1_retained: number;
  ret_d7_eligible: number;
  ret_d7_retained: number;
  ret_d30_eligible: number;
  ret_d30_retained: number;
  languages: LocaleCount[];
  series: SeriesPoint[];
  bucket: string;
  points: number;
  by_source: SourceRow[];
  // Older activity was stored as UTC dates without times and cannot be
  // accurately reassigned to Kabul days. Optional during backend rollout.
  activity_timezone_since?: string;
  generated_at: string;
};

// ---- /v1/admin/users ----

export type KaataMember = { name: string; email: string; role: string };
export type UserKaata = {
  vault_id: string;
  name: string;
  role: string;
  archived: boolean;
  member_count: number;
  tally_count: number;
  customer_count: number;
  members: KaataMember[];
};
export type UserRow = {
  account_id: string;
  name: string;
  email: string;
  locale: string;
  created_at: string;
  last_login_at: string;
  last_seen: string;
  ledger_name: string;
  ledger_phone: string;
  shop_name: string;
  platform: string;
  app_version: string;
  installed_at: string;
  // Optional so a dashboard deployed ahead of the backend that adds it still
  // renders — same reason as SourceRow.store_clicks. Read it as the fallback
  // for installed_at, which is device-supplied and often empty.
  first_seen?: string;
  last_activity_at: string;
  has_onboarded: boolean;
  source: string;
  install_count: number;
  kaatas: UserKaata[];
};
export type InstallRow = {
  install_id: string;
  self_name: string;
  self_phone: string;
  shop_name: string;
  platform: string;
  app_version: string;
  locale: string;
  installed_at: string;
  first_seen: string;
  last_seen: string;
  last_activity_at: string;
  has_onboarded: boolean;
  source: string;
  attribution_method: string;
  usage_entries: number;
  usage_customers: number;
  usage_shares: number;
  check_in_count: number;
};
export type UsersResult = {
  users: UserRow[];
  anonymous_installs: InstallRow[];
  signed_in_count: number;
  anonymous_count: number;
  total_installs: number;
  generated_at: string;
};

// ---- /v1/admin/growth (typed from the spec; endpoint may not be live yet) ----

export type WeeklyCohort = {
  week: string; // ISO week start (Monday), date only
  size: number;
  retained: number[]; // index i = active in week+i; [0] = install week
};
export type GrowthWeek = {
  week: string;
  new: number;
  retained: number;
  resurrected: number;
  churned: number; // positive number; chart negates it below the axis
};
export type Adoption = {
  signed_in: number;
  multi_member: number;
  with_shares: number;
  with_settlements: number;
};
export type Growth = {
  weekly_cohorts: WeeklyCohort[];
  growth_accounting: GrowthWeek[];
  adoption: Adoption | null;
  generated_at: string;
};

// ---- fetch + hooks ----

async function fetchAdmin<T>(path: string, token: string): Promise<T> {
  const res = await fetch(`${BACKEND_URL}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (res.status === 401) throw new AuthError();
  if (!res.ok) throw new Error(`Server error (${res.status}).`);
  return (await res.json()) as T;
}

// The admin key flows to the query hooks via context so every section shares
// one source of truth (and sign-out invalidates everything at once).
export const AdminTokenContext = createContext("");
export const useAdminToken = () => useContext(AdminTokenContext);

export function useStats(points = 30) {
  const token = useAdminToken();
  return useQuery({
    queryKey: ["admin", "stats", token, points],
    // Only the chart range changes; DAU/WAU/MAU retain their fixed windows.
    queryFn: () => fetchAdmin<Stats>(`/v1/admin/stats?bucket=day&points=${points}`, token),
    // Keep the chart visible while changing its range, never across keys.
    placeholderData: (previousData, previousQuery) =>
      previousQuery?.queryKey[2] === token ? previousData : undefined,
    enabled: !!token,
  });
}

export function useUsers() {
  const token = useAdminToken();
  return useQuery({
    queryKey: ["admin", "users", token],
    queryFn: () => fetchAdmin<UsersResult>("/v1/admin/users", token),
    enabled: !!token,
  });
}

// The growth endpoint is deployed separately from this frontend — a 404 means
// "not shipped yet", which is data (`null`), not an error, so the dashboard
// renders honest em-dashes instead of a retry loop against a missing route.
export function useGrowth() {
  const token = useAdminToken();
  return useQuery({
    queryKey: ["admin", "growth", token],
    queryFn: async (): Promise<Growth | null> => {
      const res = await fetch(`${BACKEND_URL}/v1/admin/growth`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.status === 401) throw new AuthError();
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`Server error (${res.status}).`);
      const g = (await res.json()) as Partial<Growth>;
      // Defensive normalization — never let an absent array crash a render.
      return {
        weekly_cohorts: Array.isArray(g.weekly_cohorts) ? g.weekly_cohorts : [],
        growth_accounting: Array.isArray(g.growth_accounting) ? g.growth_accounting : [],
        adoption: g.adoption ?? null,
        generated_at: g.generated_at ?? "",
      };
    },
    enabled: !!token,
  });
}

// ---- /v1/admin/outreach (mirrors internal/admin/outreach.go field-for-field) ----

export type OutreachStatus =
  | "new"
  | "sent"
  | "replied"
  | "interested"
  | "installed"
  | "declined"
  | "do_not_contact";
export type OutreachKaata = {
  vault_id: string;
  name: string;
  currency: string;
  role: string;
  archived: boolean;
  member_count: number;
  people: number;
  tallies: number;
  receivable: string; // "1234.50"
  payable: string;
  last_tally_at: string; // RFC3339 UTC or ""
};
export type OutreachShopkeeper = {
  account_id: string;
  email: string;
  signed_in: boolean;
  install_count: number;
  platform: string;
  app_version: string;
  locale: string;
  source: string;
  attribution: string;
  installed_at: string;
  first_seen: string;
  last_seen: string;
  last_activity_at: string;
  has_onboarded: boolean;
  check_in_count: number;
  usage_entries: number;
  usage_customers: number;
  usage_shares: number;
  kaatas: OutreachKaata[]; // never null
  people: number;
  tallies: number;
  receivable_total: string;
  payable_total: string;
  currency: string;
  last_tally_at: string;
};
export type OutreachListing = {
  vault_id: string;
  vault_name: string;
  currency: string;
  owner_name: string;
  owner_phone: string;
  person_name: string;
  context: string;
  archived: boolean;
  first_added_at: string;
  last_tally_at: string;
  tallies: number;
  balance: string; // signed "300.00"; positive = the person owes the shop
  role: string; // customer | supplier | settled
  // The contact is linked to a mutual tab in this kaata (tab_parties). The
  // fold covers local entries only, so `balance`/`tallies` leave the tab's
  // rows out.
  linked: boolean;
};
export type OutreachCustomer = {
  listings: OutreachListing[]; // never null
  mention_count: number;
  first_added_at: string;
  last_tally_at: string;
  tallies_total: number;
  archived_everywhere: boolean;
  is_supplier_anywhere: boolean;
  is_customer_anywhere: boolean;
  is_wholesaler: boolean;
};
export type OutreachTouch = {
  kind: "sent" | "replied" | "status" | "note";
  detail: string;
  at: string;
};
export type OutreachState = {
  phone: string;
  status: OutreachStatus;
  contacted_at: string;
  first_contacted_at: string;
  replied_at: string;
  contact_count: number;
  note: string;
  updated_at: string;
  touches: OutreachTouch[]; // never null; newest first; max 20
};
export type OutreachContact = {
  phone: string;
  kind: "shopkeeper" | "customer" | "both";
  name: string;
  shop_name: string;
  locale: string;
  shopkeeper: OutreachShopkeeper | null; // null for pure customers
  customer: OutreachCustomer | null; // null for pure shopkeepers
  outreach: OutreachState;
  converted: boolean;
  follow_up_due: boolean;
};
export type OutreachCounts = {
  total: number;
  shopkeepers: number;
  customers: number;
  both: number;
  wholesalers: number;
  to_contact: number;
  sent: number;
  replied: number;
  interested: number;
  installed: number;
  declined: number; // declined + do_not_contact
  follow_ups_due: number;
  converted: number;
  sent_today: number; // since Kabul midnight
  replied_today: number;
};
export type OutreachResult = {
  contacts: OutreachContact[]; // never null
  settings: Record<string, string>; // never null
  counts: OutreachCounts;
  generated_at: string;
};
// POST /v1/admin/outreach/mark. Absent fields are left alone server-side, so
// every optional key is genuinely optional — never send `note: ""` to mean
// "unchanged".
export type OutreachMarkBody = {
  phones: string[];
  status?: OutreachStatus;
  note?: string;
  contacted?: boolean;
  replied?: boolean;
  template_key?: string;
};
export type OutreachMarkResult = { updated: OutreachState[] };
export type OutreachSettingResult = { key: string; value: string; updated_at: string };

const EMPTY_OUTREACH_COUNTS: OutreachCounts = {
  total: 0,
  shopkeepers: 0,
  customers: 0,
  both: 0,
  wholesalers: 0,
  to_contact: 0,
  sent: 0,
  replied: 0,
  interested: 0,
  installed: 0,
  declined: 0,
  follow_ups_due: 0,
  converted: 0,
  sent_today: 0,
  replied_today: 0,
};

// A 4xx from the outreach writes carries `{"error":"invalid phone"}` etc.;
// surface that text so the toast says why, and fall back to the status.
async function responseError(res: Response): Promise<Error> {
  try {
    const body = (await res.json()) as { error?: unknown };
    if (typeof body.error === "string" && body.error) return new Error(body.error);
  } catch {
    /* Not JSON — the status is all we know. */
  }
  return new Error(`Server error (${res.status}).`);
}

export async function postAdmin<T>(path: string, token: string, body: unknown): Promise<T> {
  const res = await fetch(`${BACKEND_URL}${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (res.status === 401) throw new AuthError();
  if (!res.ok) throw await responseError(res);
  return (await res.json()) as T;
}

// Like useGrowth: the outreach endpoints deploy with the backend, so a 404
// resolves to `null` ("not deployed yet") rather than an error.
export function useOutreach() {
  const token = useAdminToken();
  return useQuery({
    queryKey: ["admin", "outreach", token],
    queryFn: async (): Promise<OutreachResult | null> => {
      const res = await fetch(`${BACKEND_URL}/v1/admin/outreach`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.status === 401) throw new AuthError();
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`Server error (${res.status}).`);
      const r = (await res.json()) as Partial<OutreachResult>;
      return {
        contacts: Array.isArray(r.contacts) ? r.contacts : [],
        settings: r.settings && typeof r.settings === "object" ? r.settings : {},
        counts: { ...EMPTY_OUTREACH_COUNTS, ...(r.counts ?? {}) },
        generated_at: r.generated_at ?? "",
      };
    },
    enabled: !!token,
  });
}

export function markOutreach(token: string, body: OutreachMarkBody): Promise<OutreachMarkResult> {
  return postAdmin<OutreachMarkResult>("/v1/admin/outreach/mark", token, body);
}

// An empty/whitespace value deletes the row server-side (back to the default).
export function saveOutreachSetting(
  token: string,
  key: string,
  value: string,
): Promise<OutreachSettingResult> {
  return postAdmin<OutreachSettingResult>("/v1/admin/outreach/setting", token, { key, value });
}
