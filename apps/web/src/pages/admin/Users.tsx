import { Fragment, useEffect, useMemo, useState, type ReactNode } from "react";
import { useStats, useUsers } from "./api";
import { reportingDay } from "./dates";
import { ErrorCard, PageHeader, SkeletonCard, fmtDate, fmtInt, lastSeenInfo } from "./ui";
import { AccountDetail, InstallDetail } from "./UsersDetails";
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
  sortUsers,
  userRows,
  type SortKey,
  type UserFilters,
  type UserListRow,
  type UserPreferences,
  type UserPreset,
} from "./users-model";

const STORAGE_KEY = "kaata_admin_user_filters_v1";
const FIELD =
  "min-h-10 w-full rounded-lg border border-[#dce1e6] bg-white px-3 py-2 text-sm text-[#344054] outline-none transition focus:border-[#0c745a] focus:ring-2 focus:ring-[#0c745a]/10";
const BUTTON =
  "inline-flex min-h-10 items-center justify-center gap-2 rounded-lg border border-[#dce1e6] bg-white px-3 py-2 text-sm font-medium text-[#344054] transition hover:border-[#aebbb5] hover:bg-[#f8faf9] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0c745a] focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-40";
const PAGE_SIZES = [25, 50, 100];
const SORT_OPTIONS: [SortKey, string][] = [
  ["last_seen", "Last seen"],
  ["installed_at", "Installed"],
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

export function Users() {
  const users = useUsers();
  const stats = useStats();
  const cutover = stats.data?.activity_timezone_since;
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
  const allRows = useMemo(() => userRows(users.data, cutover), [users.data, cutover]);
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
  const summary = useMemo(
    () => ({
      known: allRows.filter(isIdentified).length,
      active: allRows.filter((row) => matchesActivity(row, "7d", now) && isIdentified(row)).length,
      onboarding: allRows.filter((row) => !row.onboarded).length,
    }),
    [allRows, now],
  );

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
    const values = [...new Set(allRows.map((row) => row[field] || "__unknown__"))];
    if (selected && !values.includes(selected)) values.push(selected);
    return [
      ["", "All"],
      ...values
        .sort()
        .map((value): [string, string] => [
          value,
          field === "platform"
            ? value === "ios"
              ? "iOS"
              : value === "android"
                ? "Android"
                : humanValue(value)
            : field === "locale"
              ? value === "fa"
                ? "Dari (fa)"
                : value === "en"
                  ? "English (en)"
                  : humanValue(value)
              : field === "version" && value !== "__unknown__"
                ? `v${value}`
                : humanValue(value),
        ]),
    ];
  };

  return (
    <div>
      <PageHeader
        title="Users"
        description="Understand who is using kaata, find people to follow up with, and inspect their reported activity."
      />
      {users.isPending || stats.isPending ? (
        <SkeletonCard lines={10} />
      ) : users.isError ? (
        <ErrorCard message="Couldn't load users." onRetry={() => void users.refetch()} />
      ) : stats.isError && !stats.data ? (
        <ErrorCard
          message="Couldn't load the reporting calendar. Retry to show consistent install dates."
          onRetry={() => void stats.refetch()}
        />
      ) : (
        <>
          <div className="mb-6 grid grid-cols-2 gap-3 xl:grid-cols-4">
            <SummaryCard
              label="Identified people"
              value={summary.known}
              sub="Accounts and reported profiles"
              onClick={() => applyPreset("all")}
              icon="people"
            />
            <SummaryCard
              label="Signed-in accounts"
              value={users.data.signed_in_count}
              sub={`${fmtInt(users.data.total_installs)} devices in total`}
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
          <section
            className="overflow-hidden rounded-2xl border border-[#e3e7ec] bg-white shadow-[0_2px_8px_rgba(16,24,40,0.02)]"
            aria-label="User directory"
          >
            <div className="border-b border-[#edf0f3] px-4 pt-5 sm:px-6">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h2 className="text-base font-semibold text-[#101828]">People directory</h2>
                  <p className="mt-1 text-xs leading-5 text-[#667085]">
                    One row per account or signed-out device. Expand a person for details.
                  </p>
                </div>
                <span className="rounded-full bg-[#f3f5f7] px-3 py-1 text-xs font-medium tabular-nums text-[#667085]">
                  {fmtInt(allRows.length)} total rows
                </span>
              </div>
              <div className="mt-5 flex gap-1 overflow-x-auto" aria-label="Quick views">
                {PRESETS.map((preset) => (
                  <button
                    key={preset.id}
                    onClick={() => applyPreset(preset.id)}
                    aria-pressed={selectedPreset === preset.id}
                    title={preset.description}
                    className={`shrink-0 border-b-2 px-3 pb-3 pt-1 text-sm font-medium transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#0c745a] ${selectedPreset === preset.id ? "border-[#0c745a] text-[#0c745a]" : "border-transparent text-[#667085] hover:text-[#344054]"}`}
                  >
                    {preset.label}
                  </button>
                ))}
              </div>
            </div>
            <div className="space-y-4 px-4 py-5 sm:px-6">
              <div className="flex flex-col gap-3 sm:flex-row">
                <div className="relative flex-1">
                  <span className="pointer-events-none absolute left-3 top-3 text-[#98a2b3]">
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
                    placeholder="Search name, phone, email or shop…"
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
                    <span className="rounded bg-[#e7f4ee] px-1.5 text-xs text-[#0c745a]">
                      {activeFilters.length}
                    </span>
                  ) : null}
                  <Icon name="chevron" className={showFilters ? "rotate-180" : ""} />
                </button>
              </div>
              {selectedPreset && selectedPreset !== "all" ? (
                <p className="text-xs leading-5 text-[#667085]">
                  {PRESETS.find((preset) => preset.id === selectedPreset)?.description}
                </p>
              ) : null}
              {showFilters ? (
                <div
                  id="user-filters"
                  className="rounded-xl border border-[#e6eaee] bg-[#f8fafb] p-4"
                >
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
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
                  <div className="mt-4 border-t border-[#e3e7ec] pt-4">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <h3 className="text-xs font-semibold text-[#475467]">Install date range</h3>
                      <div className="flex flex-wrap gap-1" aria-label="Quick install date ranges">
                        {[
                          [1, "Today"],
                          [7, "Last 7 days"],
                          [30, "Last 30 days"],
                        ].map(([days, label]) => (
                          <button
                            key={days}
                            className="rounded-md px-2 py-1 text-xs font-medium text-[#0c745a] hover:bg-[#e7f4ee] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0c745a]"
                            onClick={() => updateFilters(quickDateRange(Number(days), Date.now()))}
                          >
                            {label}
                          </button>
                        ))}
                        <button
                          onClick={() => updateFilters({ from: "", to: "" })}
                          className="rounded-md px-2 py-1 text-xs text-[#667085] hover:bg-[#edf0f3]"
                        >
                          Any date
                        </button>
                      </div>
                    </div>
                    <div className="mt-2 grid grid-cols-1 gap-3 sm:grid-cols-2">
                      <label className="text-xs font-medium text-[#667085]">
                        From
                        <input
                          type="date"
                          aria-label="Installed from"
                          aria-invalid={invalidRange}
                          value={filters.from}
                          max={reportingDay(now)}
                          onChange={(event) => updateFilters({ from: event.target.value })}
                          className={`${FIELD} mt-1`}
                        />
                      </label>
                      <label className="text-xs font-medium text-[#667085]">
                        Through
                        <input
                          type="date"
                          aria-label="Installed through"
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
                      <p className="mt-2 text-xs leading-5 text-[#667085]">
                        Both dates are included.{" "}
                        {cutover
                          ? `Install dates before ${fmtDay(cutover)} use UTC; newer dates use Kabul time.`
                          : "Dates use Kabul time."}
                      </p>
                    )}
                  </div>
                </div>
              ) : null}
              {activeFilters.length > 0 || search ? (
                <div className="flex flex-wrap items-center gap-2" aria-label="Active filters">
                  {activeFilters.map((chip) => (
                    <button
                      key={chip.key}
                      className="inline-flex items-center gap-1.5 rounded-full border border-[#d7e8df] bg-[#f0f8f4] px-2.5 py-1 text-xs text-[#0c745a] hover:bg-[#e1f1e8] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0c745a]"
                      aria-label={`Remove ${chip.label} filter`}
                      onClick={() => updateFilters({ [chip.key]: DEFAULT_FILTERS[chip.key] })}
                    >
                      {chip.label}
                      <Icon name="close" className="h-3 w-3" />
                    </button>
                  ))}
                  {search ? (
                    <button
                      className="inline-flex items-center gap-1.5 rounded-full border border-[#e3e7ec] px-2.5 py-1 text-xs text-[#475467]"
                      onClick={() => {
                        setSearch("");
                        setPage(0);
                      }}
                      aria-label="Clear search"
                    >
                      Search: <span className="max-w-40 truncate">{search}</span>
                      <Icon name="close" className="h-3 w-3" />
                    </button>
                  ) : null}
                  <button
                    className="px-1 py-1 text-xs font-medium text-[#667085] underline decoration-[#c6cdd5] underline-offset-4 hover:text-[#101828]"
                    onClick={reset}
                  >
                    Reset all
                  </button>
                </div>
              ) : null}
            </div>
            <div className="flex flex-wrap items-center justify-between gap-3 border-y border-[#edf0f3] bg-[#fafbfc] px-4 py-3 sm:px-6">
              <p className="text-xs text-[#667085]" role="status">
                <strong className="font-semibold tabular-nums text-[#344054]">
                  {fmtInt(result.matching.length)} matching rows
                </strong>
                <span className="mx-1.5">·</span>
                {fmtInt(result.identified)} identified<span className="mx-1.5">·</span>
                {fmtInt(result.unidentified)} unidentified
                {result.hidden ? ` (${fmtInt(result.hidden)} hidden)` : ""}
              </p>
              <label className="flex cursor-pointer items-center gap-2 text-xs text-[#475467]">
                <input
                  type="checkbox"
                  checked={filters.includeUnidentified}
                  onChange={(event) => updateFilters({ includeUnidentified: event.target.checked })}
                  className="h-4 w-4 rounded accent-[#0c745a]"
                />
                Include unidentified installs
              </label>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-6">
              <span className="text-xs text-[#667085]">
                {sorted.length
                  ? `${currentPage * pageSize + 1}–${Math.min((currentPage + 1) * pageSize, sorted.length)} of ${fmtInt(sorted.length)} visible rows`
                  : "No visible rows"}
              </span>
              <div className="flex items-center gap-2">
                <label className="flex items-center gap-2 text-xs text-[#667085]">
                  Sort by
                  <select
                    value={sortKey}
                    onChange={(event) => sortBy(event.target.value as SortKey)}
                    className="rounded-md border border-[#dce1e6] bg-white py-1.5 pl-2 pr-6 text-xs text-[#344054] focus-visible:outline-[#0c745a]"
                  >
                    {SORT_OPTIONS.map(([key, label]) => (
                      <option key={key} value={key}>
                        {label}
                      </option>
                    ))}
                  </select>
                </label>
                <button
                  className="rounded-md p-1.5 text-[#667085] hover:bg-[#f2f4f7] focus-visible:outline-[#0c745a]"
                  aria-label={sortDesc ? "Sort ascending" : "Sort descending"}
                  title={sortDesc ? "Descending" : "Ascending"}
                  onClick={() => sortBy(sortKey)}
                >
                  <Icon name="sort" className={sortDesc ? "" : "rotate-180"} />
                </button>
              </div>
            </div>
            {pageRows.length ? (
              <UsersTable
                rows={pageRows}
                now={now}
                sortKey={sortKey}
                sortDesc={sortDesc}
                onSort={sortBy}
                expanded={expanded}
                onToggle={(id) => setExpanded((value) => ({ ...value, [id]: !value[id] }))}
              />
            ) : (
              <div className="flex min-h-64 flex-col items-center justify-center px-6 py-10 text-center">
                <span className="mb-4 rounded-full bg-[#f2f5f7] p-4 text-[#98a2b3]">
                  <Icon name="search" className="h-6 w-6" />
                </span>
                <h3 className="text-base font-semibold text-[#344054]">
                  {invalidRange
                    ? "Check your date range"
                    : result.hidden
                      ? "These matches have no reported identity"
                      : allRows.length
                        ? "No people match these filters"
                        : "Your user directory is ready"}
                </h3>
                <p className="mt-2 max-w-md text-sm leading-6 text-[#667085]">
                  {invalidRange
                    ? "Choose an end date on or after the start date."
                    : result.hidden
                      ? `${fmtInt(result.hidden)} matching installs are hidden. Include unidentified installs to inspect them.`
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
                ) : allRows.length && (activeFilters.length > 0 || search) ? (
                  <button className={`${BUTTON} mt-5`} onClick={reset}>
                    Reset filters
                  </button>
                ) : null}
              </div>
            )}
            {sorted.length > 0 ? (
              <div className="flex flex-wrap items-center justify-between gap-3 border-t border-[#edf0f3] px-4 py-4 sm:px-6">
                <label className="flex items-center gap-2 text-xs text-[#667085]">
                  Rows per page
                  <select
                    aria-label="Rows per page"
                    className="rounded-md border border-[#dce1e6] bg-white px-2 py-1.5 text-xs focus-visible:outline-[#0c745a]"
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
                <nav aria-label="User directory pages" className="flex items-center gap-3">
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
                  <span className="text-xs tabular-nums text-[#667085]">
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
          <p className="mt-4 text-xs leading-5 text-[#667085]">
            Accounts can include several devices. Account entries come from synced kaatas;
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
  return chips;
}
function FilterSelect(props: {
  label: string;
  value: string;
  options: [string, string][];
  onChange: (value: string) => void;
}) {
  return (
    <label className="text-xs font-medium text-[#667085]">
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
      className="group rounded-2xl border border-[#e3e7ec] bg-white p-4 text-left transition hover:border-[#9ec3b6] hover:shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0c745a] sm:p-5"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-[#667085]">{props.label}</span>
        <span className="rounded-lg bg-[#f0f6f3] p-2 text-[#0c745a]">
          <Icon name={props.icon} />
        </span>
      </div>
      <div className="mt-2 text-3xl font-semibold tracking-tight tabular-nums text-[#101828]">
        {fmtInt(props.value)}
      </div>
      <p className="mt-1 text-[11px] leading-5 text-[#667085]">{props.sub}</p>
    </button>
  );
}
function Pill(props: { children: ReactNode; tone?: "green" | "amber" | "gray" }) {
  return (
    <span
      className={`inline-flex items-center rounded-md px-2 py-0.5 text-[11px] font-medium ${props.tone === "green" ? "bg-[#e8f5ed] text-[#116b4f]" : props.tone === "amber" ? "bg-[#fff4df] text-[#8c621a]" : "bg-[#f0f2f5] text-[#667085]"}`}
    >
      {props.children}
    </span>
  );
}
const HEADERS: { label: string; key?: SortKey; className?: string }[] = [
  { label: "Person", key: "name", className: "min-w-[260px]" },
  { label: "Status" },
  { label: "Device" },
  { label: "Installed", key: "installed_at" },
  { label: "Last seen", key: "last_seen" },
  { label: "Entries", key: "entries", className: "text-right" },
  { label: "Details" },
];
function UsersTable(props: {
  rows: UserListRow[];
  now: number;
  sortKey: SortKey;
  sortDesc: boolean;
  onSort: (key: SortKey) => void;
  expanded: Record<string, boolean>;
  onToggle: (id: string) => void;
}) {
  return (
    <div className="overflow-x-auto">
      <table
        className="w-full min-w-[850px] border-collapse text-left"
        aria-label="Users and reported activity"
      >
        <thead>
          <tr className="border-y border-[#edf0f3] bg-[#fafbfc]">
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
                className={`px-4 py-3 text-xs font-medium text-[#667085] ${column.className ?? ""}`}
              >
                {column.key ? (
                  <button
                    className="inline-flex items-center gap-1 rounded focus-visible:outline-2 focus-visible:outline-[#0c745a]"
                    onClick={() => props.onSort(column.key!)}
                  >
                    {column.label}
                    <span
                      className={column.key === props.sortKey ? "text-[#0c745a]" : "text-[#c2c9d1]"}
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
                  className={`border-b border-[#edf0f3] transition ${open ? "bg-[#f2f8f5]" : "hover:bg-[#fafcfb]"}`}
                >
                  <td className="px-4 py-4">
                    <div className="flex items-start gap-3">
                      <span
                        aria-hidden="true"
                        className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${isIdentified(row) ? "bg-[#edf4f0] text-[#0c745a]" : "bg-[#f0f2f5] text-[#98a2b3]"}`}
                      >
                        {initials(row)}
                      </span>
                      <div className="min-w-0">
                        <button
                          className="max-w-[260px] truncate rounded text-left text-sm font-semibold text-[#101828] hover:text-[#0c745a] focus-visible:outline-2 focus-visible:outline-[#0c745a]"
                          aria-expanded={open}
                          aria-controls={detailsId}
                          onClick={() => props.onToggle(row.id)}
                        >
                          {displayName(row)}
                        </button>
                        {row.shop && row.shop !== displayName(row) ? (
                          <p className="max-w-[260px] truncate text-xs text-[#667085]">
                            {row.shop}
                          </p>
                        ) : null}
                        <p
                          dir="ltr"
                          className="mt-0.5 max-w-[260px] truncate text-xs text-[#667085]"
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
                        className={`text-[11px] ${row.onboarded ? "text-[#667085]" : "font-medium text-[#9a681d]"}`}
                      >
                        {row.onboarded ? "Onboarded" : "Not onboarded"}
                      </span>
                    </div>
                  </td>
                  <td className="px-4 py-4">
                    <p className="whitespace-nowrap text-xs font-medium text-[#475467]">
                      {row.platform === "ios"
                        ? "iOS"
                        : row.platform === "android"
                          ? "Android"
                          : row.platform || "Unknown"}
                      {row.version ? (
                        <span className="ml-1.5 font-normal text-[#667085]">v{row.version}</span>
                      ) : null}
                    </p>
                    <p
                      className="mt-1 max-w-36 truncate text-[11px] text-[#667085]"
                      title={`${row.locale === "fa" ? "Dari" : row.locale === "en" ? "English" : row.locale || "Unknown language"} · ${row.source || "Unknown source"}`}
                    >
                      {row.locale === "fa"
                        ? "Dari"
                        : row.locale === "en"
                          ? "English"
                          : row.locale || "Unknown"}{" "}
                      · {row.source || "Unattributed"}
                    </p>
                  </td>
                  <td className="whitespace-nowrap px-4 py-4 text-xs text-[#667085]">
                    {fmtDay(row.installed_day)}
                  </td>
                  <td className="px-4 py-4">
                    <div className="flex items-center gap-1.5 whitespace-nowrap text-xs text-[#475467]">
                      {seen.online ? (
                        <>
                          <span className="h-1.5 w-1.5 rounded-full bg-[#0c745a]" />
                          {seen.label}
                        </>
                      ) : (
                        seen.label
                      )}
                    </div>
                    {seenValid ? (
                      <p className="mt-1 whitespace-nowrap text-[11px] text-[#98a2b3]">
                        {fmtDate(row.last_seen)}
                      </p>
                    ) : null}
                  </td>
                  <td className="px-4 py-4 text-right">
                    <p className="text-sm font-semibold tabular-nums text-[#344054]">
                      {fmtInt(row.entries)}
                    </p>
                    <p className="mt-1 whitespace-nowrap text-[11px] text-[#667085]">
                      {fmtInt(row.customers)} customers
                    </p>
                  </td>
                  <td className="px-3 py-4">
                    <button
                      className="rounded-lg p-2 text-[#667085] hover:bg-[#e7f0eb] hover:text-[#0c745a] focus-visible:outline-2 focus-visible:outline-[#0c745a]"
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
                      className="border-b border-[#e2e9e5] bg-[#f7faf8] px-5 py-5"
                    >
                      <div id={detailsId} className="space-y-4">
                        <div className="flex flex-wrap items-start justify-between gap-3">
                          <div>
                            <h3 className="text-sm font-semibold text-[#344054]">
                              {displayName(row)}
                            </h3>
                            <p className="mt-1 text-xs text-[#667085]">
                              {row.kind === "account"
                                ? `Signed-in account · ${fmtInt(row.account?.install_count ?? 0)} linked devices`
                                : "Signed-out device profile"}
                            </p>
                          </div>
                          <div className="flex flex-wrap gap-2">
                            <Pill>{fmtInt(row.entries)} entries</Pill>
                            <Pill>{fmtInt(row.customers)} customers</Pill>
                            <Pill>
                              {row.shares === null
                                ? "Shares not reported per account"
                                : `${fmtInt(row.shares)} shares`}
                            </Pill>
                          </div>
                        </div>
                        <div className="grid grid-cols-1 gap-3 border-y border-[#e3ebe6] py-3 text-xs sm:grid-cols-3">
                          <Detail label="Phone" value={row.phone} />
                          <Detail label="Email" value={row.email} />
                          <Detail label="Shop" value={row.shop} />
                          <Detail label="Language" value={row.locale} />
                          <Detail label="Source" value={row.source} />
                          <Detail label="Installed" value={fmtDay(row.installed_day)} />
                        </div>
                        {row.account ? (
                          <AccountDetail u={row.account} />
                        ) : row.install ? (
                          <InstallDetail d={row.install} />
                        ) : null}
                      </div>
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
function Detail(props: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <p className="text-[11px] font-medium text-[#667085]">{props.label}</p>
      <p className="mt-1 break-words text-[#344054]" dir="auto">
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
