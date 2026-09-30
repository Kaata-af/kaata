// Data layer for the admin dashboard. Types mirror the backend structs
// (apps/backend/internal/admin/service.go `Stats`, users.go `UsersResult`,
// outreach.go `OutreachResult`) and the /v1/admin/growth contract from the
// dashboard spec. Every endpoint shares the paste-once Bearer key; a 401
// anywhere throws AuthError, which the QueryCache in AdminApp catches to clear
// the stored key and re-show the prompt (the same "wrong key" UX the old
// single-file dashboard had). Reads are GETs through `fetchAdmin`; the
// Outreach section's writes (2026-09-29; outcome + exclude 2026-09-30) are
// JSON POSTs through `postAdmin` — POST rather than PATCH/DELETE because the
// backend's CORS allow-list is GET/POST/OPTIONS only. An outcome's 409 is a
// StaleError ("stale outcome") or a ConflictError (any other reason, e.g.
// "contact stopped"): the write failures the page answers with a refetch,
// never a retry. Every POST gives up after 20 s (2026-09-30) with an error
// that says so; that is never retried either.

import { useQuery } from "@tanstack/react-query";
import { createContext, useContext } from "react";
import { BACKEND_URL } from "../../env";
import { withOutreachDefaults } from "./outreach-model";

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
  | "do_not_contact"
  | "no_whatsapp"
  | "invalid";
// libphonenumber's verdict on the normalized number (backend
// describeOutreachNumber). Plausibility only — nothing here says whether the
// number uses WhatsApp.
export type OutreachNumber = {
  valid: boolean;
  possible: boolean;
  // mobile | fixed_line | fixed_line_or_mobile | voip | toll_free | premium_rate
  // | shared_cost | personal | pager | uan | voicemail | unknown
  type: string;
  region: string; // "AF"; "" when unknown
  national: string; // "070 000 0001"; "" when unparsable
};
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
  // Every install that contributed this number, so one anonymous install can
  // be excluded as a test source on its own. Never null.
  install_ids: string[];
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
  kind: "sent" | "replied" | "status" | "note" | "opened" | "skipped" | "retry";
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
  // First contact only (2026-09-30), read over the WHOLE touch log
  // server-side: true when no send was ever recorded AND every chat ever
  // opened for the number was resolved as "nothing sent" (skip, retry, not
  // on WhatsApp, invalid). A pending chat reads false; any counted send makes
  // it false for good; a number with no row reads true. Open next and the
  // Prospects view offer only these. An older backend omits it and
  // withStateDefaults derives it conservatively.
  never_messaged: boolean;
  note: string;
  updated_at: string;
  touches: OutreachTouch[]; // never null; newest first; max 20
  opened_at: string; // last chat open; RFC3339 UTC or ""
  pending_since: string; // opened, no outcome recorded since; "" otherwise
  skipped_at: string; // "skip for now"; a Kabul-day fact, see isSkippedToday
  open_count: number;
  // Bumped on every write. Outcome POSTs send it back as `expected_version`;
  // a mismatch is a 409 (StaleError), never a silent overwrite. 0 = no row.
  version: number;
};
export type OutreachContact = {
  phone: string;
  kind: "shopkeeper" | "customer" | "both";
  name: string;
  shop_name: string;
  locale: string;
  number: OutreachNumber;
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
  pending: number; // pending_since set
  unreachable: number; // status no_whatsapp + invalid
  invalid: number; // number.valid == false
  opened_today: number; // opened touches since Kabul midnight
};
// An operator-verified test source. Excluding one drops only that source's
// contribution to a number; a number that also appears in a real book stays.
export type OutreachExclusionKind = "vault" | "account" | "install";
export type OutreachExclusion = {
  kind: OutreachExclusionKind;
  id: string;
  // vault: "<vault name> · <owner name>"; account: name or email; install:
  // self_name / shop_name / install id prefix.
  label: string;
  reason: string;
  created_at: string;
};
export type OutreachResult = {
  contacts: OutreachContact[]; // never null
  settings: Record<string, string>; // never null
  counts: OutreachCounts;
  exclusions: OutreachExclusion[]; // never null
  generated_at: string;
};
// POST /v1/admin/outreach/mark. Absent fields are left alone server-side, so
// every optional key is genuinely optional — never send `note: ""` to mean
// "unchanged". A `status` together with `contacted` or `replied` is refused
// whole (400 invalid body, 2026-09-30): the page never combines them.
export type OutreachMarkBody = {
  phones: string[];
  status?: OutreachStatus;
  note?: string;
  contacted?: boolean;
  replied?: boolean;
  template_key?: string;
  // Lifts a stop (2026-09-30). A status mark that would move a Declined or
  // Do-not-contact row to any other status skips that row unless this is
  // true. Only a row's own status menu sends it; bulk actions never do, so a
  // stop is lifted one row at a time. Setting a stop needs no flag.
  lift_stop?: boolean;
};
// `updated` carries every requested phone's CURRENT state, in input order.
// `skipped` (2026-09-30) lists every row the mark left untouched: a bulk
// `contacted` mark records only a FIRST message, so it counts rows that are
// New, Not on WhatsApp or Invalid AND never recorded as sent, and skips the
// rest (already messaged, stopped); a status mark skips Declined /
// Do-not-contact rows it would move to another status without `lift_stop`.
// Optional for a backend that predates it.
export type OutreachMarkResult = { updated: OutreachState[]; skipped?: string[] };
export type OutreachSettingResult = { key: string; value: string; updated_at: string };
// POST /v1/admin/outreach/outcome — ONE contact, one outcome. `opened` is what
// a chat open records (never sent); `sent` is the operator's confirmation;
// `no_whatsapp` / `invalid` / `skip` / `retry` are the other verdicts.
// `expected_version` is the row's `version` as last read; the server refuses
// a mismatch with 409 (StaleError). The page sends it with EVERY outcome,
// `opened` included (2026-09-30): a chat opens only after its record was
// accepted, so refusing a stale open loses nothing. Required here so no call
// site can drop it.
export type OutreachOutcome = "opened" | "sent" | "no_whatsapp" | "invalid" | "skip" | "retry";
export type OutreachOutcomeBody = {
  phone: string;
  outcome: OutreachOutcome;
  template_key?: string;
  reason?: string;
  expected_version: number;
};
export type OutreachOutcomeResult = { state: OutreachState };
// POST /v1/admin/outreach/exclude — `excluded: true` upserts (reason
// replaces), `false` deletes. The answer is the full current list.
export type OutreachExclusionBody = {
  kind: OutreachExclusionKind;
  id: string;
  excluded: boolean;
  reason?: string;
};
export type OutreachExclusionResult = { exclusions: OutreachExclusion[] };

// 409 "stale outcome": the row's version moved since this page last read it
// (another tab, or an earlier click that already landed). The write was not
// applied; the page refetches instead of retrying, because retrying is how a
// second message gets sent.
export class StaleError extends Error {
  constructor(message: string) {
    super(message || "Already recorded elsewhere.");
    this.name = "StaleError";
  }
}
// Any other 409 from an outcome (2026-09-30): the row's CURRENT status
// refuses it — "contact stopped" (Declined / Do not contact refuse opened,
// sent, not-on-WhatsApp and invalid) or "not retryable" (retry on a row that
// is not unreachable). Nothing was written; the message is the server's
// reason, which the page maps to its own wording.
export class ConflictError extends Error {
  constructor(message: string) {
    super(message || "Refused by the server.");
    this.name = "ConflictError";
  }
}

// Every POST gives up after 20 s (2026-09-30). A write that never answers
// would otherwise hold the page's `busy` flag, and with it every outcome
// button, until the tab is closed. The timeout is surfaced, never retried:
// the server may still have applied the write, so the operator refreshes
// before trying again (the page refetches once the write settles anyway).
const POST_TIMEOUT_MS = 20_000;
const POST_TIMEOUT_MESSAGE = "No answer from the server in 20 s — refresh before trying again.";
// AbortSignal.timeout rejects with a TimeoutError DOMException, and the same
// reason again if it fires while the body is read. Nothing here aborts a
// POST any other way, so an AbortError is the timeout too.
function isTimeout(error: unknown): boolean {
  return (
    error instanceof DOMException && (error.name === "TimeoutError" || error.name === "AbortError")
  );
}
async function readJson<T>(res: Response): Promise<T> {
  try {
    return (await res.json()) as T;
  } catch (error) {
    throw isTimeout(error) ? new Error(POST_TIMEOUT_MESSAGE) : error;
  }
}

// A 4xx from the outreach writes carries `{"error":"invalid phone"}` etc.;
// surface that text so the toast says why, and fall back to the status.
async function responseError(res: Response): Promise<Error> {
  try {
    const body = (await res.json()) as { error?: unknown };
    if (typeof body.error === "string" && body.error) return new Error(body.error);
  } catch (error) {
    if (isTimeout(error)) return new Error(POST_TIMEOUT_MESSAGE);
    /* Not JSON — the status is all we know. */
  }
  return new Error(`Server error (${res.status}).`);
}

async function postAdminResponse(path: string, token: string, body: unknown): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(`${BACKEND_URL}${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(POST_TIMEOUT_MS),
    });
  } catch (error) {
    throw isTimeout(error) ? new Error(POST_TIMEOUT_MESSAGE) : error;
  }
  if (res.status === 401) throw new AuthError();
  return res;
}

export async function postAdmin<T>(path: string, token: string, body: unknown): Promise<T> {
  const res = await postAdminResponse(path, token, body);
  if (!res.ok) throw await responseError(res);
  return readJson<T>(res);
}

// Like useGrowth: the outreach endpoints deploy with the backend, so a 404
// resolves to `null` ("not deployed yet") rather than an error. Fields added
// after the first deploy are defaulted by `withOutreachDefaults`, so a page
// deployed ahead of its backend still renders every row.
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
      return withOutreachDefaults(await res.json());
    },
    enabled: !!token,
  });
}

export function markOutreach(token: string, body: OutreachMarkBody): Promise<OutreachMarkResult> {
  return postAdmin<OutreachMarkResult>("/v1/admin/outreach/mark", token, body);
}

export async function postOutcome(
  token: string,
  body: OutreachOutcomeBody,
): Promise<OutreachOutcomeResult> {
  const res = await postAdminResponse("/v1/admin/outreach/outcome", token, body);
  if (res.status === 409) {
    const reason = (await responseError(res)).message;
    throw reason === "stale outcome" ? new StaleError(reason) : new ConflictError(reason);
  }
  if (!res.ok) throw await responseError(res);
  return readJson<OutreachOutcomeResult>(res);
}

export function postExclusion(
  token: string,
  body: OutreachExclusionBody,
): Promise<OutreachExclusionResult> {
  return postAdmin<OutreachExclusionResult>("/v1/admin/outreach/exclude", token, body);
}

// An empty/whitespace value deletes the row server-side (back to the default).
export function saveOutreachSetting(
  token: string,
  key: string,
  value: string,
): Promise<OutreachSettingResult> {
  return postAdmin<OutreachSettingResult>("/v1/admin/outreach/setting", token, { key, value });
}
