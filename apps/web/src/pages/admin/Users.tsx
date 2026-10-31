import { languageLabel } from "./outreach-model";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Fragment, useEffect, useId, useMemo, useState, type ReactNode } from "react";
import { useToast } from "../../components/Toast";
import { postExclusion, useAdminToken, useUsers, type OutreachExclusionBody } from "./api";
import { fmtDateTimeParts, reportingDay } from "./dates";
import { ErrorCard, PageHeader, SkeletonCard, fmtDateTime, fmtInt, lastSeenInfo } from "./ui";
import { AccountDetail, InstallDetail } from "./UsersDetails";
import { DeviceEstimateCard } from "./DeviceEstimateCard";
import { platformFacets, platformLabel, platformsLabel } from "./platforms";
import {
  DEFAULT_FILTERS,
  PRESETS,
  activePreset,
  filterUsers,
  isIdentified,
  matchesActivity,
  parsePreferences,
  presetFilters,
  quickDateRange,
  reportedDevices,
  reportedRows,
  sortUsers,
  userRows,
  type SortKey,
  type UserFilters,
  type UserListRow,
  type UserPreferences,
  type UserPreset,
} from "./users-model";

// Test data (2026-10-12): a row's details can exclude the account or device
// from every install metric — the Overview, weekly growth (past weeks
// included) and cohorts — through the same POST the Outreach page uses, so
// one "this is test data" decision applies everywhere and shows in both
// places with its Undo. Excluded rows are hidden unless the directory is
// asked to include them.
type ExclusionHandler = (body: OutreachExclusionBody, message: string) => void;

const STORAGE_KEY = "kaata_admin_user_filters_v1";
const FIELD =
  "min-h-11 min-w-0 w-full max-w-full rounded-lg border border-brand-border bg-white px-3 py-2 text-base text-brand-ink outline-none transition focus:border-brand-primary focus:ring-2 focus:ring-brand-primary/10 md:text-sm";
const BUTTON =
  "inline-flex min-h-11 min-w-11 max-w-full items-center justify-center gap-2 rounded-lg border border-brand-border bg-white px-3 py-2 text-sm font-medium text-brand-ink transition hover:border-neutral-300 hover:bg-brand-ivory focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-40";
const PAGE_SIZES = [25, 50, 100];
const SORT_OPTIONS: [SortKey, string][] = [
  ["last_seen", "Last seen"],
  ["installed_at", "First used"],
  ["name", "Name"],
  ["entries", "Entries"],
  ["customers", "Customers"],
  ["shares", "Shares"],
];
const SELECTS: {
  key: "signIn" | "onboarding" | "activity" | "entries" | "contact";
  label: string;
  options: [string, string][];
}[] = [
  {
    key: "signIn",
    label: "Sign-in status",
    options: [
      ["all", "Everyone"],
      ["signed-in", "Signed in"],
      ["signed-out", "Signed out"],
    ],
  },
  {
    key: "onboarding",
    label: "Onboarding",
    options: [
      ["all", "Any status"],
      ["complete", "Completed"],
      ["incomplete", "Not completed"],
    ],
  },
  {
    key: "activity",
    label: "Last seen",
    options: [
      ["all", "Any time"],
      ["online", "Within 10 minutes"],
      ["today", "Today · Kabul"],
      ["7d", "Within 7 days"],
      ["30d", "Within 30 days"],
      ["inactive", "7+ days ago"],
      ["never", "No valid check-in time"],
    ],
  },
  {
    key: "entries",
    label: "Reported entries",
    options: [
      ["all", "Any count"],
      ["with", "Has entries"],
      ["without", "No entries reported"],
    ],
  },
  {
    key: "contact",
    label: "Contact details",
    options: [
      ["all", "Any profile"],
      ["available", "Phone or email available"],
      ["missing", "No phone or email"],
    ],
  },
];

function presetFromHash(): UserPreset | undefined {
  if (window.location.hash.split("?")[0].replace(/^#\/?/, "") !== "users") return undefined;
  const value = new URLSearchParams(window.location.hash.split("?")[1] ?? "").get("view");
  return PRESETS.find((p) => p.id === value)?.id;
}
function initialPreferences(): UserPreferences {
  let saved: unknown;
  try {
    saved = JSON.parse(sessionStorage.getItem(STORAGE_KEY) ?? "null");
  } catch {
    /* Storage may be unavailable. */
  }
  const preferences = parsePreferences(saved);
  const preset = presetFromHash();
  return preset ? { ...preferences, filters: presetFilters(preset) } : preferences;
}
function fmtDay(day: string): string {
  if (!day) return "—";
  const [year, month, date] = day.split("-").map(Number);
  return new Date(year, month - 1, date).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}
function initials(row: UserListRow): string {
  return (row.name || row.shop || row.email || "?")
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => Array.from(part)[0])
    .join("")
    .toUpperCase();
}
function displayName(row: UserListRow): string {
  return (
    row.name ||
    row.shop ||
    row.email ||
    row.phone ||
    (row.kind === "account" ? "Signed-in account" : "Unidentified install")
  );
}
function humanValue(value: string): string {
  return value === "__unknown__" ? "Unknown" : value;
}

function PlatformsSummary({ row }: { row: UserListRow }) {
  return (
    <>
      {platformsLabel(row.platforms)}
      {row.version && row.version !== "web" ? (
        <span className="mt-0.5 block text-[11px] font-normal text-brand-muted">
          {row.platforms.length > 1 ? `Latest: ${platformLabel(row.platform)} · ` : ""}v
          {row.version}
        </span>
      ) : null}
    </>
  );
}

export function Users() {
  const users = useUsers();
  const token = useAdminToken();
  const client = useQueryClient();
  const toast = useToast();
  // Every report changes with an exclusion, so every admin query refetches.
  const exclusion = useMutation({
    mutationFn: (body: OutreachExclusionBody) => postExclusion(token, body),
    onError: (error) => toast.push(error.message || "Couldn't update the exclusion.", "error"),
    onSettled: () => client.invalidateQueries({ queryKey: ["admin"] }),
  });
  const onExclusion: ExclusionHandler = (body, message) =>
    exclusion.mutate(body, { onSuccess: () => toast.push(message, "success") });
  const [preferences, setPreferences] = useState(initialPreferences);
  const { filters, sortKey, sortDesc, pageSize } = preferences;
  const [search, setSearch] = useState("");
  const [showFilters, setShowFilters] = useState(false);
  const [page, setPage] = useState(0);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [clockTick, setNow] = useState(Date.now);
  // Fresh query results can contain check-ins after the last local clock tick.
  const now = Math.max(clockTick, users.dataUpdatedAt);
  const selectedPreset = activePreset(filters);
  const allRows = useMemo(() => userRows(users.data), [users.data]);
  const result = useMemo(
    () => filterUsers(allRows, filters, search, now),
    [allRows, filters, search, now],
  );
  const sorted = useMemo(
    () => sortUsers(result.visible, sortKey, sortDesc),
    [result.visible, sortKey, sortDesc],
  );
  const pageCount = Math.max(1, Math.ceil(sorted.length / pageSize));
  const currentPage = Math.min(page, pageCount - 1);
  const pageRows = sorted.slice(currentPage * pageSize, (currentPage + 1) * pageSize);
  const invalidRange = !!(filters.from && filters.to && filters.from > filters.to);
  const activeFilters = filterChips(filters);
  // The cards count what the reports count (test data left out), so each
  // equals the list its click opens, which hides test data the same way.
  const summary = useMemo(() => {
    const counted = reportedRows(allRows);
    return {
      known: counted.filter(isIdentified).length,
      active: counted.filter((row) => matchesActivity(row, "7d", now) && isIdentified(row)).length,
      onboarding: counted.filter((row) => !row.onboarded).length,
      accounts: counted.filter((row) => row.kind === "account").length,
      installations: reportedDevices(allRows),
    };
  }, [allRows, now]);

  useEffect(() => {
    try {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(preferences));
    } catch {
      /* Filters still work without storage. */
    }
  }, [preferences]);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    setPage((current) => Math.min(current, pageCount - 1));
  }, [pageCount]);
  useEffect(() => {
    const onHash = () => {
      const preset = presetFromHash();
      if (!preset) return;
      setPreferences((p) => ({ ...p, filters: presetFilters(preset) }));
      setSearch("");
      setPage(0);
      setExpanded({});
      // Consume preset links once so later section navigation restores edits.
      window.history.replaceState(
        null,
        "",
        `${window.location.pathname}${window.location.search}#users`,
      );
    };
    onHash();
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  function updateFilters(patch: Partial<UserFilters>) {
    setPreferences((p) => ({ ...p, filters: { ...p.filters, ...patch } }));
    setPage(0);
    setExpanded({});
  }
  function applyPreset(preset: UserPreset) {
    setPreferences((p) => ({ ...p, filters: presetFilters(preset) }));
    setSearch("");
    setPage(0);
    setExpanded({});
  }
  function reset() {
    applyPreset("all");
  }
  function sortBy(key: SortKey) {
    setPreferences((p) => ({
      ...p,
      sortKey: key,
      sortDesc: p.sortKey === key ? !p.sortDesc : key !== "name",
    }));
    setPage(0);
  }
  const facetOptions = (
    field: "platform" | "locale" | "source" | "version",
    selected: string,
  ): [string, string][] => {
    const values = [
      ...new Set(
        allRows.flatMap((row) =>
          field === "platform" ? [...platformFacets(row.platforms)] : [row[field] || "__unknown__"],
        ),
      ),
    ];
    if (selected && !values.includes(selected)) values.push(selected);
    return [
      ["", "All"],
      ...values
        .sort()
        .map((value): [string, string] => [
          value,
          field === "platform"
            ? platformLabel(value)
            : field === "locale"
              ? value === "__unknown__"
                ? humanValue(value)
                : languageLabel(value)
              : field === "version" && value !== "__unknown__"
                ? `v${value}`
                : humanValue(value),
        ]),
    ];
  };

  return (
    <div className="min-w-0 w-full max-w-full">
      <PageHeader
        title="Users"
        description="Who is using Kaata, their installations, and what they have reported."
      />
      {users.isPending ? (
        <SkeletonCard lines={10} />
      ) : users.isError ? (
        <ErrorCard message="Couldn't load users." onRetry={() => void users.refetch()} />
      ) : (
        <>
          <div className="mb-5 grid min-w-0 grid-cols-2 gap-2 sm:gap-3 xl:grid-cols-4">
            <SummaryCard
              label="Identified people"
              value={summary.known}
              sub="Accounts and reported profiles"
              onClick={() => applyPreset("all")}
              icon="people"
            />
            <SummaryCard
              label="Signed-in accounts"
              value={summary.accounts}
              sub={`${fmtInt(summary.installations)} app installations in total`}
              onClick={() => {
                reset();
                updateFilters({ signIn: "signed-in" });
              }}
              icon="account"
            />
            <SummaryCard
              label="Seen in 7 days"
              value={summary.active}
              sub="Identified people · check-ins"
              onClick={() => applyPreset("active")}
              icon="activity"
            />
            <SummaryCard
              label="Not onboarded"
              value={summary.onboarding}
              sub="Includes unidentified installs"
              onClick={() => applyPreset("onboarding")}
              icon="onboarding"
            />
          </div>
          <div className="mb-5 min-w-0">
            <DeviceEstimateCard
              estimate={users.data.device_estimate}
              installations={summary.installations}
            />
          </div>
          <section
            className="min-w-0 w-full max-w-full rounded-xl border border-brand-border bg-white shadow-sm"
            aria-label="User directory"
          >
            <div className="border-b border-brand-faint px-4 pt-5 sm:px-6">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <h2 className="text-base font-semibold text-brand-ink">People directory</h2>
                  <p className="mt-1 text-xs leading-5 text-brand-muted">
                    One row per account or signed-out installation. Expand a person for details.
                  </p>
                </div>
                <span className="rounded-full bg-brand-faint px-3 py-1 text-xs font-medium tabular-nums text-brand-muted">
                  {fmtInt(allRows.length)} total rows
                </span>
              </div>
              <div
                className="mt-4 grid min-w-0 grid-cols-2 gap-1 sm:flex sm:flex-wrap"
                aria-label="Quick views"
              >
                {PRESETS.map((preset) => (
                  <button
                    key={preset.id}
                    onClick={() => applyPreset(preset.id)}
                    aria-pressed={selectedPreset === preset.id}
                    title={preset.description}
                    className={`min-h-11 min-w-0 border-b-2 px-2 py-2 text-sm font-medium transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-primary sm:px-3 ${selectedPreset === preset.id ? "border-brand-primary text-brand-ink" : "border-transparent text-brand-muted hover:text-brand-ink"}`}
                  >
                    {preset.label}
                  </button>
                ))}
              </div>
            </div>
            <div className="min-w-0 space-y-3 px-3 py-4 sm:space-y-4 sm:px-6 sm:py-5">
              <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] gap-2 sm:gap-3">
                <div className="relative min-w-0">
                  <span className="pointer-events-none absolute left-3 top-3 text-neutral-400">
                    <Icon name="search" />
                  </span>
                  <input
                    aria-label="Search people by name, phone, email or shop"
                    type="search"
                    value={search}
                    onChange={(event) => {
                      setSearch(event.target.value);
                      setPage(0);
                    }}
                    placeholder="Search people…"
                    className={`${FIELD} pl-10`}
                  />
                </div>
                <button
                  className={BUTTON}
                  aria-expanded={showFilters}
                  aria-controls="user-filters"
                  onClick={() => setShowFilters((show) => !show)}
                >
                  <Icon name="filter" />
                  Filters
                  {activeFilters.length > 0 ? (
                    <span className="rounded bg-brand-faint px-1.5 text-xs text-brand-ink">
                      {activeFilters.length}
                    </span>
                  ) : null}
                  <Icon
                    name="chevron"
                    className={`hidden sm:block ${showFilters ? "rotate-180" : ""}`}
                  />
                </button>
              </div>
              {selectedPreset && selectedPreset !== "all" ? (
                <p className="text-xs leading-5 text-brand-muted">
                  {PRESETS.find((preset) => preset.id === selectedPreset)?.description}
                </p>
              ) : null}
              {showFilters ? (
                <div
                  id="user-filters"
                  className="min-w-0 max-w-full rounded-xl border border-brand-border bg-brand-ivory p-3 sm:p-4"
                >
                  <div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                    {SELECTS.slice(0, 3).map((field) => (
                      <FilterSelect
                        key={field.key}
                        label={field.label}
                        value={filters[field.key]}
                        options={field.options}
                        onChange={(value) => updateFilters({ [field.key]: value })}
                      />
                    ))}
                    <FilterSelect
                      label="Platform"
                      value={filters.platform}
                      options={facetOptions("platform", filters.platform)}
                      onChange={(platform) => updateFilters({ platform })}
                    />
                    <FilterSelect
                      label="Language"
                      value={filters.language}
                      options={facetOptions("locale", filters.language)}
                      onChange={(language) => updateFilters({ language })}
                    />
                    <FilterSelect
                      label="Acquisition source"
                      value={filters.source}
                      options={facetOptions("source", filters.source)}
                      onChange={(source) => updateFilters({ source })}
                    />
                    <FilterSelect
                      label="App version"
                      value={filters.version}
                      options={facetOptions("version", filters.version)}
                      onChange={(version) => updateFilters({ version })}
                    />
                    {SELECTS.slice(3).map((field) => (
                      <FilterSelect
                        key={field.key}
                        label={field.label}
                        value={filters[field.key]}
                        options={field.options}
                        onChange={(value) => updateFilters({ [field.key]: value })}
                      />
                    ))}
                  </div>
                  <div className="mt-4 border-t border-brand-border pt-4">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <h3 className="text-xs font-semibold text-brand-sub">
                        First used date range
                      </h3>
                      <div
                        className="flex flex-wrap gap-1"
                        aria-label="Quick first used date ranges"
                      >
                        {[
                          [1, "Today"],
                          [7, "Last 7 days"],
                          [30, "Last 30 days"],
                        ].map(([days, label]) => (
                          <button
                            key={days}
                            className="min-h-11 rounded-md px-2 py-1 text-xs font-medium text-brand-ink hover:bg-brand-faint focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary"
                            onClick={() => updateFilters(quickDateRange(Number(days), Date.now()))}
                          >
                            {label}
                          </button>
                        ))}
                        <button
                          onClick={() => updateFilters({ from: "", to: "" })}
                          className="min-h-11 rounded-md px-2 py-1 text-xs text-brand-muted hover:bg-brand-faint"
                        >
                          Any date
                        </button>
                      </div>
                    </div>
                    <div className="mt-2 grid grid-cols-1 gap-3 sm:grid-cols-2">
                      <label className="min-w-0 text-xs font-medium text-brand-muted">
                        From
                        <input
                          type="date"
                          aria-label="First used from"
                          aria-invalid={invalidRange}
                          value={filters.from}
                          max={reportingDay(now)}
                          onChange={(event) => updateFilters({ from: event.target.value })}
                          className={`${FIELD} mt-1`}
                        />
                      </label>
                      <label className="min-w-0 text-xs font-medium text-brand-muted">
                        Through
                        <input
                          type="date"
                          aria-label="First used through"
                          aria-invalid={invalidRange}
                          value={filters.to}
                          max={reportingDay(now)}
                          onChange={(event) => updateFilters({ to: event.target.value })}
                          className={`${FIELD} mt-1`}
                        />
                      </label>
                    </div>
                    {invalidRange ? (
                      <p role="alert" className="mt-2 text-xs text-red-700">
                        The end date must be on or after the start date.
                      </p>
                    ) : (
                      <p className="mt-2 text-xs leading-5 text-brand-muted">
                        Both dates are included. Dates use Kabul time, the same day each row shows.
                      </p>
                    )}
                  </div>
                </div>
              ) : null}
              {activeFilters.length > 0 || search ? (
                <div
                  className="flex min-w-0 flex-wrap items-center gap-2"
                  aria-label="Active filters"
                >
                  {activeFilters.map((chip) => (
                    <button
                      key={chip.key}
                      className="inline-flex min-h-11 min-w-0 max-w-full items-center gap-1.5 rounded-xl border border-brand-border bg-brand-faint px-2.5 py-1 text-left text-xs text-brand-ink hover:bg-brand-faint focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary md:min-h-8"
                      aria-label={`Remove ${chip.label} filter`}
                      onClick={() => updateFilters({ [chip.key]: DEFAULT_FILTERS[chip.key] })}
                    >
                      <span className="min-w-0 [overflow-wrap:anywhere]">{chip.label}</span>
                      <Icon name="close" className="h-3 w-3" />
                    </button>
                  ))}
                  {search ? (
                    <button
                      className="inline-flex min-h-11 min-w-0 max-w-full items-center gap-1.5 rounded-xl border border-brand-border px-2.5 py-1 text-xs text-brand-sub md:min-h-8"
                      onClick={() => {
                        setSearch("");
                        setPage(0);
                      }}
                      aria-label="Clear search"
                    >
                      Search: <span className="min-w-0 max-w-40 truncate">{search}</span>
                      <Icon name="close" className="h-3 w-3" />
                    </button>
                  ) : null}
                  <button
                    className="min-h-11 px-1 py-1 text-xs font-medium text-brand-muted underline decoration-neutral-300 underline-offset-4 hover:text-brand-ink"
                    onClick={reset}
                  >
                    Reset all
                  </button>
                </div>
              ) : null}
            </div>
            <div className="flex flex-wrap items-center justify-between gap-3 border-y border-brand-faint bg-brand-ivory px-4 py-3 sm:px-6">
              <p className="min-w-0 text-xs leading-5 text-brand-muted" role="status">
                <strong className="font-semibold tabular-nums text-brand-ink">
                  {fmtInt(result.matching.length)} matching rows
                </strong>
                <span className="mx-1.5">·</span>
                {fmtInt(result.identified)} identified<span className="mx-1.5">·</span>
                {fmtInt(result.unidentified)} unidentified
                {result.hidden ? ` (${fmtInt(result.hidden)} hidden)` : ""}
                {result.excluded ? (
                  <>
                    <span className="mx-1.5">·</span>
                    {fmtInt(result.excluded)} excluded as test data
                    {result.excludedHidden ? " (hidden)" : ""}
                  </>
                ) : null}
              </p>
              <div className="flex min-w-0 flex-wrap items-center gap-x-4">
                <label className="flex min-h-11 min-w-0 cursor-pointer items-center gap-2 text-xs text-brand-sub">
                  <input
                    type="checkbox"
                    checked={filters.includeUnidentified}
                    onChange={(event) =>
                      updateFilters({ includeUnidentified: event.target.checked })
                    }
                    className="h-4 w-4 shrink-0 rounded accent-brand-primary"
                  />
                  Include unidentified installs
                </label>
                <label
                  className="flex min-h-11 min-w-0 cursor-pointer items-center gap-2 text-xs text-brand-sub"
                  title="Accounts and installations left out of the reports as operator or test data"
                >
                  <input
                    type="checkbox"
                    checked={filters.includeExcluded}
                    onChange={(event) => updateFilters({ includeExcluded: event.target.checked })}
                    className="h-4 w-4 shrink-0 rounded accent-brand-primary"
                  />
                  Include excluded test data
                </label>
              </div>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-6">
              <span className="text-xs text-brand-muted">
                {sorted.length
                  ? `${currentPage * pageSize + 1}–${Math.min((currentPage + 1) * pageSize, sorted.length)} of ${fmtInt(sorted.length)} visible rows`
                  : "No visible rows"}
              </span>
              <div className="flex min-w-0 max-w-full items-center gap-2">
                <label className="flex min-w-0 items-center gap-2 text-xs text-brand-muted">
                  Sort by
                  <select
                    value={sortKey}
                    onChange={(event) => sortBy(event.target.value as SortKey)}
                    className="min-h-11 min-w-0 max-w-full rounded-md border border-brand-border bg-white py-1.5 pl-2 pr-6 text-base text-brand-ink focus-visible:outline-brand-primary md:text-xs"
                  >
                    {SORT_OPTIONS.map(([key, label]) => (
                      <option key={key} value={key}>
                        {label}
                      </option>
                    ))}
                  </select>
                </label>
                <button
                  className="flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-md p-1.5 text-brand-muted hover:bg-brand-faint focus-visible:outline-brand-primary"
                  aria-label={sortDesc ? "Sort ascending" : "Sort descending"}
                  title={sortDesc ? "Descending" : "Ascending"}
                  onClick={() => sortBy(sortKey)}
                >
                  <Icon name="sort" className={sortDesc ? "" : "rotate-180"} />
                </button>
              </div>
            </div>
            {pageRows.length ? (
              <UserResults
                rows={pageRows}
                now={now}
                sortKey={sortKey}
                sortDesc={sortDesc}
                onSort={sortBy}
                expanded={expanded}
                onToggle={(id) => setExpanded((value) => ({ ...value, [id]: !value[id] }))}
                busy={exclusion.isPending}
                onExclusion={onExclusion}
              />
            ) : (
              <div className="flex min-h-64 flex-col items-center justify-center px-6 py-10 text-center">
                <span className="mb-4 rounded-full bg-brand-faint p-4 text-neutral-400">
                  <Icon name="search" className="h-6 w-6" />
                </span>
                <h3 className="text-base font-semibold text-brand-ink">
                  {invalidRange
                    ? "Check your date range"
                    : result.hidden
                      ? "These matches have no reported identity"
                      : result.excludedHidden
                        ? "These matches are excluded as test data"
                        : allRows.length
                          ? "No people match these filters"
                          : "Your user directory is ready"}
                </h3>
                <p className="mt-2 max-w-md text-sm leading-6 text-brand-muted">
                  {invalidRange
                    ? "Choose an end date on or after the start date."
                    : result.hidden
                      ? `${fmtInt(result.hidden)} matching installs are hidden. Include unidentified installs to inspect them.`
                      : result.excludedHidden
                        ? `${fmtInt(result.excludedHidden)} matching rows are left out of the reports as operator or test data. Include excluded test data to inspect them.`
                        : allRows.length
                          ? "Try a wider date range, remove a filter, or search with fewer words."
                          : "Profiles and activity appear after devices check in."}
                </p>
                {result.hidden ? (
                  <button
                    className={`${BUTTON} mt-5`}
                    onClick={() => updateFilters({ includeUnidentified: true })}
                  >
                    Show unidentified installs
                  </button>
                ) : result.excludedHidden ? (
                  <button
                    className={`${BUTTON} mt-5`}
                    onClick={() => updateFilters({ includeExcluded: true })}
                  >
                    Show excluded test data
                  </button>
                ) : allRows.length && (activeFilters.length > 0 || search) ? (
                  <button className={`${BUTTON} mt-5`} onClick={reset}>
                    Reset filters
                  </button>
                ) : null}
              </div>
            )}
            {sorted.length > 0 ? (
              <div className="flex flex-wrap items-center justify-between gap-3 border-t border-brand-faint px-4 py-4 sm:px-6">
                <label className="flex items-center gap-2 text-xs text-brand-muted">
                  Rows per page
                  <select
                    aria-label="Rows per page"
                    className="min-h-11 rounded-md border border-brand-border bg-white px-2 py-1.5 text-base focus-visible:outline-brand-primary md:text-xs"
                    value={pageSize}
                    onChange={(event) => {
                      setPreferences((p) => ({ ...p, pageSize: Number(event.target.value) }));
                      setPage(0);
                    }}
                  >
                    {PAGE_SIZES.map((size) => (
                      <option key={size} value={size}>
                        {size}
                      </option>
                    ))}
                  </select>
                </label>
                <nav
                  aria-label="User directory pages"
                  className="flex max-w-full items-center gap-2 sm:gap-3"
                >
                  <button
                    className={BUTTON}
                    disabled={currentPage === 0}
                    onClick={() => {
                      setPage(currentPage - 1);
                      setExpanded({});
                    }}
                  >
                    <Icon name="chevron" className="rotate-90" />
                    <span className="hidden sm:inline">Previous</span>
                    <span className="sr-only sm:hidden">Previous page</span>
                  </button>
                  <span className="text-xs tabular-nums text-brand-muted">
                    Page {currentPage + 1} of {pageCount}
                  </span>
                  <button
                    className={BUTTON}
                    disabled={currentPage >= pageCount - 1}
                    onClick={() => {
                      setPage(currentPage + 1);
                      setExpanded({});
                    }}
                  >
                    <span className="hidden sm:inline">Next</span>
                    <span className="sr-only sm:hidden">Next page</span>
                    <Icon name="chevron" className="-rotate-90" />
                  </button>
                </nav>
              </div>
            ) : null}
          </section>
          <p className="mt-4 text-xs leading-5 text-brand-muted">
            Accounts can include several installations. Account entries come from synced kaatas;
            signed-out entries come from reported usage. “No entries reported” does not prove an
            empty local ledger. Last seen is a device check-in, not a ledger edit.
          </p>
        </>
      )}
    </div>
  );
}

function filterChips(filters: UserFilters): { key: keyof UserFilters; label: string }[] {
  const chips: { key: keyof UserFilters; label: string }[] = [];
  for (const select of SELECTS) {
    if (filters[select.key] !== DEFAULT_FILTERS[select.key])
      chips.push({
        key: select.key,
        label: `${select.label}: ${select.options.find(([value]) => value === filters[select.key])?.[1]}`,
      });
  }
  for (const [key, label] of [
    ["platform", "Platform"],
    ["language", "Language"],
    ["source", "Source"],
    ["version", "Version"],
  ] as const) {
    if (filters[key]) chips.push({ key, label: `${label}: ${humanValue(filters[key])}` });
  }
  if (filters.from) chips.push({ key: "from", label: `From ${fmtDay(filters.from)}` });
  if (filters.to) chips.push({ key: "to", label: `Through ${fmtDay(filters.to)}` });
  if (filters.includeUnidentified)
    chips.push({ key: "includeUnidentified", label: "Unidentified included" });
  if (filters.includeExcluded)
    chips.push({ key: "includeExcluded", label: "Excluded test data included" });
  return chips;
}
function FilterSelect(props: {
  label: string;
  value: string;
  options: [string, string][];
  onChange: (value: string) => void;
}) {
  return (
    <label className="min-w-0 max-w-full text-xs font-medium text-brand-muted">
      {props.label}
      <select
        className={`${FIELD} mt-1`}
        value={props.value}
        onChange={(event) => props.onChange(event.target.value)}
      >
        {props.options.map(([value, label]) => (
          <option key={value} value={value}>
            {label}
          </option>
        ))}
      </select>
    </label>
  );
}
function SummaryCard(props: {
  label: string;
  value: number;
  sub: string;
  onClick: () => void;
  icon: IconName;
}) {
  return (
    <button
      onClick={props.onClick}
      className="group min-w-0 rounded-xl border border-brand-border bg-white p-3 text-left transition hover:border-brand-border hover:shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary sm:p-5"
    >
      <div className="flex min-w-0 items-start justify-between gap-2">
        <span className="min-w-0 text-xs font-medium leading-5 text-brand-muted">
          {props.label}
        </span>
        <span className="hidden shrink-0 rounded-lg bg-brand-faint p-2 text-brand-ink sm:block">
          <Icon name={props.icon} />
        </span>
      </div>
      <div className="mt-2 text-2xl font-semibold tracking-tight tabular-nums text-brand-ink [overflow-wrap:anywhere] sm:text-3xl">
        {fmtInt(props.value)}
      </div>
      <p className="mt-1 text-[11px] leading-5 text-brand-muted">{props.sub}</p>
    </button>
  );
}
function Pill(props: { children: ReactNode; tone?: "green" | "amber" | "gray" }) {
  return (
    <span
      className={`inline-flex min-w-0 max-w-full items-center rounded-md px-2 py-0.5 text-[11px] font-medium [overflow-wrap:anywhere] ${props.tone === "green" ? "bg-[#e8f5ed] text-[#116b4f]" : props.tone === "amber" ? "bg-[#fff4df] text-[#8c621a]" : "bg-brand-faint text-brand-muted"}`}
    >
      {props.children}
    </span>
  );
}
const HEADERS: { label: string; key?: SortKey; className?: string }[] = [
  { label: "Person", key: "name", className: "min-w-[260px]" },
  { label: "Status" },
  { label: "Platforms" },
  { label: "First used", key: "installed_at" },
  { label: "Last seen", key: "last_seen" },
  { label: "Entries", key: "entries", className: "text-right" },
  { label: "Details" },
];
type UserResultsProps = {
  rows: UserListRow[];
  now: number;
  sortKey: SortKey;
  sortDesc: boolean;
  onSort: (key: SortKey) => void;
  expanded: Record<string, boolean>;
  onToggle: (id: string) => void;
  busy: boolean;
  onExclusion: ExclusionHandler;
};

// The install moment as two unbreakable tokens — the Kabul date, then the
// clock time on its own line — in the list column and the phone card alike.
function InstalledStamp(props: { at: string }) {
  const { date, time } = fmtDateTimeParts(props.at);
  return (
    <>
      <span className="block whitespace-nowrap">{date}</span>
      {time ? (
        <span className="mt-0.5 block whitespace-nowrap text-[11px] text-brand-muted">{time}</span>
      ) : null}
    </>
  );
}

function UserResults(props: UserResultsProps) {
  return (
    <>
      <UserCards {...props} />
      <UsersTable {...props} />
    </>
  );
}

// Phones get their own reading layout. The wide sortable table is only
// displayed from md upward and can scroll inside its bounded container.
function UserCards(props: UserResultsProps) {
  return (
    <div className="grid min-w-0 w-full max-w-full gap-3 border-t border-brand-faint bg-brand-ivory p-3 md:hidden">
      {props.rows.map((row) => {
        const open = !!props.expanded[row.id];
        const detailsId = `user-card-details-${row.id}`;
        const seenValid =
          Number.isFinite(Date.parse(row.last_seen)) && Date.parse(row.last_seen) <= props.now;
        const seen = seenValid
          ? lastSeenInfo(row.last_seen)
          : { label: "Not recorded", online: false };
        return (
          <article
            key={row.id}
            className="min-w-0 max-w-full rounded-xl border border-brand-border bg-white p-4"
            aria-label={displayName(row)}
          >
            <div className="flex min-w-0 items-start gap-3">
              <span
                aria-hidden="true"
                className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${isIdentified(row) ? "bg-brand-faint text-brand-ink" : "bg-brand-faint text-neutral-400"}`}
              >
                {initials(row)}
              </span>
              <div className="min-w-0 flex-1">
                <h3
                  className="text-sm font-semibold leading-6 text-brand-ink [overflow-wrap:anywhere]"
                  dir="auto"
                >
                  {displayName(row)}
                </h3>
                {row.shop && row.shop !== displayName(row) ? (
                  <p
                    className="mt-0.5 text-xs leading-5 text-brand-muted [overflow-wrap:anywhere]"
                    dir="auto"
                  >
                    {row.shop}
                  </p>
                ) : null}
                <p
                  className="mt-0.5 text-xs leading-5 text-brand-muted [overflow-wrap:anywhere]"
                  dir="ltr"
                >
                  {row.phone || row.email || "No contact details"}
                </p>
              </div>
            </div>
            <div className="mt-3 flex min-w-0 flex-wrap items-center gap-2">
              <Pill tone={row.kind === "account" ? "green" : "gray"}>
                {row.kind === "account" ? "Signed in" : "Signed out"}
              </Pill>
              <Pill tone={row.onboarded ? "gray" : "amber"}>
                {row.onboarded ? "Onboarded" : "Not onboarded"}
              </Pill>
              {row.excluded ? <Pill tone="gray">Excluded from reports</Pill> : null}
            </div>
            <dl className="mt-4 grid min-w-0 grid-cols-2 gap-x-3 gap-y-3 border-y border-brand-faint py-3">
              <div className="min-w-0">
                <dt className="text-[11px] text-brand-muted">Last seen</dt>
                <dd className="mt-1 min-w-0 text-sm font-medium text-brand-ink">
                  <span className="flex min-w-0 items-center gap-1.5">
                    {seen.online ? (
                      <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-500" />
                    ) : null}
                    <span className="[overflow-wrap:anywhere]">{seen.label}</span>
                  </span>
                  {seenValid ? (
                    <span className="mt-0.5 block text-[11px] font-normal leading-5 text-brand-muted [overflow-wrap:anywhere]">
                      {fmtDateTime(row.last_seen)}
                    </span>
                  ) : null}
                </dd>
              </div>
              <div className="min-w-0">
                <dt className="text-[11px] text-brand-muted">Entries</dt>
                <dd className="mt-1 text-sm font-semibold tabular-nums text-brand-ink [overflow-wrap:anywhere]">
                  {fmtInt(row.entries)}
                  <span className="mt-0.5 block text-[11px] font-normal text-brand-muted">
                    {fmtInt(row.customers)} customers
                  </span>
                </dd>
              </div>
              <div className="min-w-0">
                <dt className="text-[11px] text-brand-muted">
                  {row.kind === "account" ? "First used" : "Installed"}
                </dt>
                <dd className="mt-1 text-xs leading-5 text-brand-sub">
                  <InstalledStamp at={row.installed_at} />
                </dd>
              </div>
              <div className="min-w-0">
                <dt className="text-[11px] text-brand-muted">Platforms</dt>
                <dd className="mt-1 text-xs leading-5 text-brand-sub [overflow-wrap:anywhere]">
                  <PlatformsSummary row={row} />
                </dd>
              </div>
            </dl>
            <button
              className="mt-2 flex min-h-11 min-w-0 w-full items-center justify-between gap-3 rounded-lg px-1 text-sm font-medium text-brand-ink focus-visible:outline-2 focus-visible:outline-brand-primary"
              aria-expanded={open}
              aria-controls={detailsId}
              aria-label={`${open ? "Hide" : "Show"} details for ${displayName(row)}`}
              onClick={() => props.onToggle(row.id)}
            >
              {open ? "Hide details" : "View details"}
              <Icon name="chevron" className={open ? "rotate-180" : ""} />
            </button>
            {open ? (
              <div className="mt-2 min-w-0 border-t border-brand-border pt-4">
                <UserDetails
                  row={row}
                  id={detailsId}
                  busy={props.busy}
                  onExclusion={props.onExclusion}
                />
              </div>
            ) : null}
          </article>
        );
      })}
    </div>
  );
}

function UsersTable(props: UserResultsProps) {
  // Contain absolutely positioned sr-only labels inside the local scroll area.
  return (
    <div
      className="relative hidden min-w-0 w-full max-w-full overflow-x-auto overscroll-x-contain focus-visible:outline-2 focus-visible:outline-brand-primary md:block"
      role="region"
      aria-label="Scrollable user table"
      tabIndex={0}
    >
      <table
        className="w-full min-w-[850px] border-collapse text-left"
        aria-label="Users and reported activity"
      >
        <thead>
          <tr className="border-y border-brand-faint bg-brand-ivory">
            {HEADERS.map((column) => (
              <th
                key={column.label}
                scope="col"
                aria-sort={
                  column.key === props.sortKey
                    ? props.sortDesc
                      ? "descending"
                      : "ascending"
                    : undefined
                }
                className={`px-4 py-3 text-xs font-medium text-brand-muted ${column.className ?? ""}`}
              >
                {column.key ? (
                  <button
                    className="inline-flex items-center gap-1 rounded focus-visible:outline-2 focus-visible:outline-brand-primary"
                    onClick={() => props.onSort(column.key!)}
                  >
                    {column.label}
                    <span
                      className={
                        column.key === props.sortKey ? "text-brand-ink" : "text-neutral-300"
                      }
                    >
                      {column.key === props.sortKey ? (props.sortDesc ? "↓" : "↑") : "↕"}
                    </span>
                  </button>
                ) : column.label === "Details" ? (
                  <span className="sr-only">Details</span>
                ) : (
                  column.label
                )}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {props.rows.map((row) => {
            const open = !!props.expanded[row.id];
            const seenValid =
              Number.isFinite(Date.parse(row.last_seen)) && Date.parse(row.last_seen) <= props.now;
            const seen = seenValid
              ? lastSeenInfo(row.last_seen)
              : { label: "Not recorded", online: false };
            const detailsId = `user-details-${row.id}`;
            return (
              <Fragment key={row.id}>
                <tr
                  className={`border-b border-brand-faint transition ${open ? "bg-brand-ivory" : "hover:bg-brand-ivory"}`}
                >
                  <td className="px-4 py-4">
                    <div className="flex items-start gap-3">
                      <span
                        aria-hidden="true"
                        className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${isIdentified(row) ? "bg-brand-faint text-brand-ink" : "bg-brand-faint text-neutral-400"}`}
                      >
                        {initials(row)}
                      </span>
                      <div className="min-w-0">
                        <button
                          className="max-w-[260px] truncate rounded text-left text-sm font-semibold text-brand-ink hover:text-brand-ink focus-visible:outline-2 focus-visible:outline-brand-primary"
                          aria-expanded={open}
                          aria-controls={detailsId}
                          onClick={() => props.onToggle(row.id)}
                        >
                          {displayName(row)}
                        </button>
                        {row.shop && row.shop !== displayName(row) ? (
                          <p className="max-w-[260px] truncate text-xs text-brand-muted">
                            {row.shop}
                          </p>
                        ) : null}
                        <p
                          dir="ltr"
                          className="mt-0.5 max-w-[260px] truncate text-xs text-brand-muted"
                        >
                          {row.phone || row.email || "No contact details"}
                        </p>
                      </div>
                    </div>
                  </td>
                  <td className="px-4 py-4">
                    <div className="flex flex-col items-start gap-1.5">
                      <Pill tone={row.kind === "account" ? "green" : "gray"}>
                        {row.kind === "account" ? "Signed in" : "Signed out"}
                      </Pill>
                      <span
                        className={`text-[11px] ${row.onboarded ? "text-brand-muted" : "font-medium text-[#9a681d]"}`}
                      >
                        {row.onboarded ? "Onboarded" : "Not onboarded"}
                      </span>
                      {row.excluded ? <Pill tone="gray">Excluded</Pill> : null}
                    </div>
                  </td>
                  <td className="px-4 py-4">
                    <div className="text-xs font-medium text-brand-sub [overflow-wrap:anywhere]">
                      <PlatformsSummary row={row} />
                    </div>
                    <p
                      className="mt-1 max-w-36 truncate text-[11px] text-brand-muted"
                      title={`${languageLabel(row.locale)} · ${row.source || "Unknown source"}`}
                    >
                      {languageLabel(row.locale)} · {row.source || "Unattributed"}
                    </p>
                  </td>
                  <td className="px-4 py-4 text-xs text-brand-sub">
                    <InstalledStamp at={row.installed_at} />
                  </td>
                  <td className="px-4 py-4">
                    <div className="flex items-center gap-1.5 whitespace-nowrap text-xs text-brand-sub">
                      {seen.online ? (
                        <>
                          <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                          {seen.label}
                        </>
                      ) : (
                        seen.label
                      )}
                    </div>
                    {seenValid ? (
                      <p className="mt-1 whitespace-nowrap text-[11px] text-neutral-400">
                        {fmtDateTime(row.last_seen)}
                      </p>
                    ) : null}
                  </td>
                  <td className="px-4 py-4 text-right">
                    <p className="text-sm font-semibold tabular-nums text-brand-ink">
                      {fmtInt(row.entries)}
                    </p>
                    <p className="mt-1 whitespace-nowrap text-[11px] text-brand-muted">
                      {fmtInt(row.customers)} customers
                    </p>
                  </td>
                  <td className="px-3 py-4">
                    <button
                      className="rounded-lg p-2 text-brand-muted hover:bg-brand-faint hover:text-brand-ink focus-visible:outline-2 focus-visible:outline-brand-primary"
                      aria-label={`${open ? "Hide" : "Show"} details for ${displayName(row)}`}
                      aria-expanded={open}
                      aria-controls={detailsId}
                      onClick={() => props.onToggle(row.id)}
                    >
                      <Icon name="chevron" className={open ? "rotate-180" : ""} />
                    </button>
                  </td>
                </tr>
                {open ? (
                  <tr>
                    <td
                      colSpan={HEADERS.length}
                      className="border-b border-brand-border bg-brand-ivory px-5 py-5"
                    >
                      <UserDetails
                        row={row}
                        id={detailsId}
                        busy={props.busy}
                        onExclusion={props.onExclusion}
                      />
                    </td>
                  </tr>
                ) : null}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
function UserDetails({
  row,
  id,
  busy,
  onExclusion,
}: {
  row: UserListRow;
  id: string;
  busy: boolean;
  onExclusion: ExclusionHandler;
}) {
  return (
    <div id={id} className="min-w-0 max-w-full space-y-4">
      <div className="flex min-w-0 flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 max-w-full">
          <h3 className="text-sm font-semibold text-brand-ink [overflow-wrap:anywhere]" dir="auto">
            {displayName(row)}
          </h3>
          <p className="mt-1 text-xs leading-5 text-brand-muted">
            {row.kind === "account"
              ? `Signed-in account · ${fmtInt(row.account?.install_count ?? 0)} linked app installations`
              : "Signed-out installation profile"}
          </p>
        </div>
        <div className="flex min-w-0 max-w-full flex-wrap gap-2">
          <Pill>{fmtInt(row.entries)} entries</Pill>
          <Pill>{fmtInt(row.customers)} customers</Pill>
          <Pill>
            {row.shares === null
              ? "Shares not reported per account"
              : `${fmtInt(row.shares)} shares`}
          </Pill>
        </div>
      </div>
      <div className="grid min-w-0 grid-cols-1 gap-3 border-y border-brand-border py-3 text-xs sm:grid-cols-3">
        <Detail label="Phone" value={row.phone} />
        <Detail label="Email" value={row.email} />
        <Detail label="Shop" value={row.shop} />
        <Detail label="Language" value={row.locale} />
        <Detail label="Source" value={row.source} />
        {/* The one install time (installTime): the earliest record of the
            account's first device or of this device, in Kabul time. */}
        <Detail
          label={row.kind === "account" ? "First used" : "Installed"}
          value={fmtDateTime(row.installed_at)}
        />
      </div>
      {row.account ? (
        <AccountDetail u={row.account} />
      ) : row.install ? (
        <InstallDetail d={row.install} />
      ) : null}
      <ReportStatus row={row} busy={busy} onExclusion={onExclusion} />
    </div>
  );
}

// Whether the reports count this row, why not, and the way to change it.
// Only a row's own decision can be undone here: a device left out because it
// was used with an operator account, or with an account excluded as test
// data, comes back through OPERATOR_ACCOUNT_IDS or that account's Undo.
function ReportStatus(props: { row: UserListRow; busy: boolean; onExclusion: ExclusionHandler }) {
  const { row } = props;
  const kind = row.kind === "account" ? "account" : "install";
  const id = row.account?.account_id ?? row.install?.install_id ?? "";
  if (!id) return null;
  const subject = row.kind === "account" ? "account" : "installation";
  let body: ReactNode;
  if (row.excluded && row.excludedBy === kind) {
    body = (
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-3">
        <p className="min-w-0 text-xs leading-5 text-brand-sub [overflow-wrap:anywhere]">
          <span className="font-medium text-brand-ink">Excluded from reports</span>
          {row.exclusionReason ? (
            <>
              {" "}
              · <span dir="auto">{row.exclusionReason}</span>
            </>
          ) : null}
          . The Overview, weekly growth and cohorts leave this {subject} out, past weeks included.
        </p>
        <button
          className={BUTTON}
          disabled={props.busy}
          aria-label={`Include again: ${displayName(row)}`}
          onClick={() =>
            props.onExclusion(
              { kind, id, excluded: false },
              `${displayName(row)} is counted in reports again`,
            )
          }
        >
          Include again
        </button>
      </div>
    );
  } else if (row.excluded) {
    body = (
      <p className="text-xs leading-5 text-brand-sub">
        <span className="font-medium text-brand-ink">Excluded from reports</span>: this installation{" "}
        {row.excludedBy === "operator"
          ? "is or was signed in to an operator account (OPERATOR_ACCOUNT_IDS), deleted accounts included."
          : "is or was signed in to an account excluded as test data; that account's Undo counts it again."}
      </p>
    );
  } else {
    body = (
      <div className="min-w-0 space-y-2">
        <p className="text-xs leading-5 text-brand-sub">
          Counted in reports.{" "}
          {row.kind === "account"
            ? "Excluding leaves out every installation this account has used — in the Overview, weekly growth and cohorts, past weeks included — and drops its number and the books it owns from Outreach."
            : "Excluding leaves this installation out of the Overview, weekly growth and cohorts, past weeks included."}
        </p>
        {row.kind === "account" && row.excludedDevices > 0 ? (
          <p className="text-xs leading-5 text-brand-muted">
            {fmtInt(row.excludedDevices)} of {fmtInt(row.account?.install_count ?? 0)} installations
            are already left out on their own.
          </p>
        ) : null}
        <ExcludeForm
          label={row.kind === "account" ? "Exclude account from reports" : "Exclude from reports"}
          name={displayName(row)}
          busy={props.busy}
          onSubmit={(reason) =>
            props.onExclusion(
              { kind, id, excluded: true, reason },
              `${displayName(row)} excluded from reports`,
            )
          }
        />
      </div>
    );
  }
  return (
    <section className="min-w-0 border-t border-brand-border pt-3" aria-label="Reports">
      <h4 className="mb-2 text-xs font-semibold text-brand-sub">Reports</h4>
      {body}
    </section>
  );
}

// "Exclude …" asks for a one-line reason in place, like Outreach's buttons.
function ExcludeForm(props: {
  label: string;
  name: string;
  busy: boolean;
  onSubmit: (reason: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("test data");
  const inputId = useId();
  if (!open)
    return (
      <button
        className={BUTTON}
        disabled={props.busy}
        aria-label={`${props.label}: ${props.name}`}
        onClick={() => setOpen(true)}
      >
        {props.label}
      </button>
    );
  return (
    <form
      className="flex min-w-0 max-w-full flex-wrap items-center gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        props.onSubmit(reason.trim() || "test data");
        setOpen(false);
      }}
    >
      <label className="sr-only" htmlFor={inputId}>
        Reason for excluding
      </label>
      <input
        id={inputId}
        autoFocus
        className={`${FIELD} sm:w-56 sm:flex-none`}
        value={reason}
        maxLength={200}
        dir="auto"
        placeholder="Reason"
        onChange={(event) => setReason(event.target.value)}
      />
      <button
        type="submit"
        className={BUTTON}
        disabled={props.busy}
        aria-label={`Exclude: ${props.name}`}
      >
        Exclude
      </button>
      <button type="button" className={BUTTON} onClick={() => setOpen(false)}>
        Cancel
      </button>
    </form>
  );
}
function Detail(props: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <p className="text-[11px] font-medium text-brand-muted">{props.label}</p>
      <p className="mt-1 leading-5 text-brand-ink [overflow-wrap:anywhere]" dir="auto">
        {props.value || "Not provided"}
      </p>
    </div>
  );
}

type IconName =
  | "search"
  | "filter"
  | "chevron"
  | "close"
  | "sort"
  | "people"
  | "account"
  | "activity"
  | "onboarding";
function Icon(props: { name: IconName; className?: string }) {
  const paths: Record<IconName, ReactNode> = {
    search: (
      <>
        <circle cx="10.5" cy="10.5" r="6.5" />
        <path d="m16 16 4 4" />
      </>
    ),
    filter: (
      <>
        <path d="M4 7h16M4 17h16" />
        <circle cx="9" cy="7" r="2" fill="currentColor" />
        <circle cx="15" cy="17" r="2" fill="currentColor" />
      </>
    ),
    chevron: <path d="m6 9 6 6 6-6" />,
    close: <path d="m6 6 12 12M6 18 18 6" />,
    sort: <path d="M8 4v16m-4-4 4 4 4-4M15 5h5m-5 5h4m-4 5h2" />,
    people: (
      <>
        <circle cx="9" cy="8" r="3" />
        <path d="M3 20v-2a6 6 0 0 1 12 0v2M16 5a3 3 0 0 1 0 6m2 3a5 5 0 0 1 3 4v2" />
      </>
    ),
    account: (
      <>
        <circle cx="12" cy="8" r="3" />
        <path d="M5 21v-2a7 7 0 0 1 14 0v2" />
      </>
    ),
    activity: <path d="M3 12h4l3-8 4 16 3-8h4" />,
    onboarding: (
      <>
        <rect x="5" y="5" width="14" height="16" rx="2" />
        <path d="M9 3h6v4H9zM9 13h6m-6 4h4" />
      </>
    ),
  };
  return (
    <svg
      aria-hidden="true"
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`h-[18px] w-[18px] shrink-0 ${props.className ?? ""}`}
    >
      {paths[props.name]}
    </svg>
  );
}
