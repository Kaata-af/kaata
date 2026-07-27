// Data layer for the admin dashboard. Types mirror the backend structs
// (apps/backend/internal/admin/service.go `Stats`, users.go `UsersResult`) and
// the /v1/admin/growth contract from the dashboard spec. All three endpoints
// share the paste-once Bearer key; a 401 anywhere throws AuthError, which the
// QueryCache in AdminApp catches to clear the stored key and re-show the
// prompt (the same "wrong key" UX the old single-file dashboard had).

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

export function useStats() {
  const token = useAdminToken();
  return useQuery({
    queryKey: ["admin", "stats", token],
    // Overview's activity card is speced as the daily 30-point series; other
    // sections read the point-in-time KPIs off the same response.
    queryFn: () => fetchAdmin<Stats>("/v1/admin/stats?bucket=day&points=30", token),
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
