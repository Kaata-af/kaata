import type { InstallRow, UserRow, UsersResult } from "./api";
import { reportingDay, reportingInstallDay } from "./dates.ts";

// The API combines signed-in accounts (possibly several devices) and
// signed-out installs. Keep these units explicit; rows are not device counts.
export type UserListRow = {
  id: string;
  kind: "account" | "install";
  name: string;
  phone: string;
  shop: string;
  email: string;
  locale: string;
  source: string;
  platform: string;
  version: string;
  onboarded: boolean;
  installed_at: string;
  installed_day: string;
  last_seen: string;
  entries: number;
  customers: number;
  shares: number | null;
  account?: UserRow;
  install?: InstallRow;
};

export type UserFilters = {
  signIn: "all" | "signed-in" | "signed-out";
  onboarding: "all" | "complete" | "incomplete";
  activity: "all" | "online" | "today" | "7d" | "30d" | "inactive" | "never";
  platform: string;
  language: string;
  source: string;
  version: string;
  entries: "all" | "with" | "without";
  contact: "all" | "available" | "missing";
  from: string;
  to: string;
  includeUnidentified: boolean;
};
export type SortKey = "name" | "installed_at" | "last_seen" | "entries" | "customers" | "shares";
export type UserPreferences = {
  filters: UserFilters;
  sortKey: SortKey;
  sortDesc: boolean;
  pageSize: number;
};

export const DEFAULT_FILTERS: UserFilters = {
  signIn: "all",
  onboarding: "all",
  activity: "all",
  platform: "",
  language: "",
  source: "",
  version: "",
  entries: "all",
  contact: "all",
  from: "",
  to: "",
  includeUnidentified: false,
};
export const PRESETS = [
  {
    id: "all",
    label: "All people",
    description: "Signed-in accounts and signed-out people with a reported profile.",
  },
  {
    id: "active",
    label: "Active",
    description: "Seen in the last 7 days, based on device check-ins.",
  },
  {
    id: "follow-up",
    label: "Needs follow-up",
    description: "Onboarded, not seen for 7+ days, and a phone or email is available.",
  },
  {
    id: "onboarding",
    label: "Not onboarded",
    description:
      "Devices or accounts that have not reported completed onboarding, including unidentified installs.",
  },
] as const;
export type UserPreset = (typeof PRESETS)[number]["id"];

export function presetFilters(preset: UserPreset): UserFilters {
  if (preset === "active") return { ...DEFAULT_FILTERS, activity: "7d" };
  if (preset === "follow-up")
    return {
      ...DEFAULT_FILTERS,
      onboarding: "complete",
      activity: "inactive",
      contact: "available",
    };
  if (preset === "onboarding")
    return { ...DEFAULT_FILTERS, onboarding: "incomplete", includeUnidentified: true };
  return { ...DEFAULT_FILTERS };
}

export function activePreset(filters: UserFilters): UserPreset | undefined {
  return PRESETS.find((p) => {
    const preset = presetFilters(p.id);
    return (Object.keys(preset) as (keyof UserFilters)[]).every(
      (key) => preset[key] === filters[key],
    );
  })?.id;
}

export function isIdentified(row: UserListRow): boolean {
  return row.kind === "account" || !!(row.name.trim() || row.shop.trim() || row.phone.trim());
}
export function hasContact(row: UserListRow): boolean {
  return !!(row.phone.trim() || row.email.trim());
}

export function userRows(data: UsersResult | undefined, cutover?: string): UserListRow[] {
  if (!data) return [];
  return [
    ...data.users.map((u): UserListRow => {
      const installedAt = u.installed_at || u.first_seen || "";
      return {
        id: `a:${u.account_id}`,
        kind: "account",
        name: u.ledger_name || u.name || "",
        phone: u.ledger_phone,
        shop: u.shop_name,
        email: u.email,
        locale: u.locale,
        source: u.source,
        platform: (u.platform || "").toLowerCase(),
        version: u.app_version,
        onboarded: u.has_onboarded,
        installed_at: installedAt,
        installed_day: reportingInstallDay(installedAt, cutover),
        last_seen: u.last_seen,
        entries: u.kaatas.reduce((sum, k) => sum + k.tally_count, 0),
        customers: u.kaatas.reduce((sum, k) => sum + k.customer_count, 0),
        shares: null,
        account: u,
      };
    }),
    ...(data.anonymous_installs ?? []).map((d): UserListRow => {
      const installedAt = d.installed_at || d.first_seen || "";
      return {
        id: `i:${d.install_id}`,
        kind: "install",
        name: d.self_name,
        phone: d.self_phone,
        shop: d.shop_name,
        email: "",
        locale: d.locale,
        source: d.source,
        platform: (d.platform || "").toLowerCase(),
        version: d.app_version,
        onboarded: d.has_onboarded,
        installed_at: installedAt,
        installed_day: reportingInstallDay(installedAt, cutover),
        last_seen: d.last_seen,
        entries: d.usage_entries,
        customers: d.usage_customers,
        shares: d.usage_shares,
        install: d,
      };
    }),
  ];
}

export function matchesActivity(
  row: UserListRow,
  activity: UserFilters["activity"],
  now: number,
): boolean {
  if (activity === "all") return true;
  const timestamp = Date.parse(row.last_seen);
  const known = Number.isFinite(timestamp) && timestamp <= now;
  if (activity === "never") return !known;
  if (!known) return false;
  const age = now - timestamp;
  if (activity === "online") return age < 10 * 60_000;
  if (activity === "today") return reportingDay(timestamp) === reportingDay(now);
  if (activity === "7d") return age < 7 * 86_400_000;
  if (activity === "30d") return age < 30 * 86_400_000;
  return age >= 7 * 86_400_000;
}

function normalizedText(value: string): string {
  return value.toLocaleLowerCase().replace(/[۰-۹٠-٩]/g, (digit) => {
    const code = digit.charCodeAt(0);
    return String(code >= 0x6f0 ? code - 0x6f0 : code - 0x660);
  });
}

function matchesSearch(row: UserListRow, search: string): boolean {
  const query = normalizedText(search.trim());
  if (!query) return true;
  const fields = [row.name, row.phone, row.shop, row.email].map(normalizedText);
  const compactPhone = normalizedText(row.phone).replace(/\D/g, "");
  if (/^[+\d\s()\-]+$/.test(query)) {
    const digits = query.replace(/\D/g, "");
    if (digits && compactPhone.includes(digits)) return true;
    const international = digits.startsWith("00")
      ? digits.slice(2)
      : digits.length === 10 && digits.startsWith("0")
        ? `93${digits.slice(1)}`
        : digits;
    if (international && compactPhone === international) return true;
  }
  // Every word must appear in the profile, allowing “Ahmad grocery”.
  return query.split(/\s+/).every((word) => fields.some((field) => field.includes(word)));
}

export function filterUsers(
  rows: UserListRow[],
  filters: UserFilters,
  search: string,
  now: number,
) {
  const matching = rows.filter((row) => {
    if (filters.signIn === "signed-in" && row.kind !== "account") return false;
    if (filters.signIn === "signed-out" && row.kind !== "install") return false;
    if (filters.onboarding !== "all" && row.onboarded !== (filters.onboarding === "complete"))
      return false;
    if (!matchesActivity(row, filters.activity, now)) return false;
    for (const key of ["platform", "source", "version"] as const) {
      if (filters[key] && filters[key] !== (row[key] || "__unknown__")) return false;
    }
    if (filters.language && filters.language !== (row.locale || "__unknown__")) return false;
    if (filters.entries === "with" && row.entries === 0) return false;
    if (filters.entries === "without" && row.entries > 0) return false;
    if (filters.contact !== "all" && hasContact(row) !== (filters.contact === "available"))
      return false;
    if ((filters.from || filters.to) && !row.installed_day) return false;
    if (filters.from && row.installed_day < filters.from) return false;
    if (filters.to && row.installed_day > filters.to) return false;
    return matchesSearch(row, search);
  });
  const unidentified = matching.filter((row) => !isIdentified(row));
  return {
    matching,
    visible: filters.includeUnidentified ? matching : matching.filter(isIdentified),
    hidden: filters.includeUnidentified ? 0 : unidentified.length,
    identified: matching.length - unidentified.length,
    unidentified: unidentified.length,
  };
}

export function sortUsers(rows: UserListRow[], key: SortKey, descending: boolean): UserListRow[] {
  const direction = descending ? -1 : 1;
  const value = (row: UserListRow): string | number | null => {
    if (key === "name") return row.name || row.shop || row.email || row.phone || null;
    if (key === "last_seen" || key === "installed_at") {
      const time = Date.parse(row[key]);
      return Number.isFinite(time) ? time : null;
    }
    return row[key];
  };
  return [...rows].sort((a, b) => {
    const av = value(a),
      bv = value(b);
    if (av === null && bv === null) return a.id.localeCompare(b.id);
    if (av === null) return 1;
    if (bv === null) return -1;
    const result =
      typeof av === "number" && typeof bv === "number"
        ? av - bv
        : String(av).localeCompare(String(bv));
    return result * direction || a.id.localeCompare(b.id);
  });
}

export function quickDateRange(days: number, now: number): { from: string; to: string } {
  const to = reportingDay(now);
  const from = new Date(`${to}T00:00:00Z`);
  from.setUTCDate(from.getUTCDate() - (days - 1));
  return { from: from.toISOString().slice(0, 10), to };
}

// Only explicit non-PII preferences are restored. Search text, expanded user
// IDs, and result data are deliberately absent from this storage contract.
export function parsePreferences(value: unknown): UserPreferences {
  const defaults: UserPreferences = {
    filters: { ...DEFAULT_FILTERS },
    sortKey: "last_seen",
    sortDesc: true,
    pageSize: 25,
  };
  if (!value || typeof value !== "object") return defaults;
  const saved = value as Record<string, unknown>;
  const filters =
    saved.filters && typeof saved.filters === "object"
      ? (saved.filters as Record<string, unknown>)
      : {};
  const enums = {
    signIn: ["all", "signed-in", "signed-out"],
    onboarding: ["all", "complete", "incomplete"],
    activity: ["all", "online", "today", "7d", "30d", "inactive", "never"],
    entries: ["all", "with", "without"],
    contact: ["all", "available", "missing"],
  };
  for (const key of Object.keys(enums) as (keyof typeof enums)[]) {
    if (typeof filters[key] === "string" && enums[key].includes(filters[key] as string)) {
      Object.assign(defaults.filters, { [key]: filters[key] });
    }
  }
  for (const key of ["platform", "language", "source", "version"] as const) {
    if (typeof filters[key] === "string" && filters[key].length <= 128)
      defaults.filters[key] = filters[key];
  }
  for (const key of ["from", "to"] as const) {
    const day = filters[key];
    if (typeof day === "string" && /^\d{4}-\d{2}-\d{2}$/.test(day)) {
      const date = new Date(`${day}T00:00:00Z`);
      if (Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === day)
        defaults.filters[key] = day;
    }
  }
  if (typeof filters.includeUnidentified === "boolean")
    defaults.filters.includeUnidentified = filters.includeUnidentified;
  if (
    ["name", "installed_at", "last_seen", "entries", "customers", "shares"].includes(
      String(saved.sortKey),
    )
  )
    defaults.sortKey = saved.sortKey as SortKey;
  if (typeof saved.sortDesc === "boolean") defaults.sortDesc = saved.sortDesc;
  if ([25, 50, 100].includes(Number(saved.pageSize))) defaults.pageSize = Number(saved.pageSize);
  return defaults;
}
