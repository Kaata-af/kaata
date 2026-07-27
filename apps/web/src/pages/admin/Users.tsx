// Users — every human we can identify: signed-in accounts AND anonymous
// installs (which report the shopkeeper's OWN self profile on check-in —
// migration 028 — never customer data). Real people first: the default view
// collapses no-identity anonymous installs behind a one-line toggle so ~40
// named humans aren't buried under a hundred "(no name)" rows. Fleet is
// <200 rows: no pagination, no virtualization.

import {
  Metric,
  Tab,
  TabGroup,
  TabList,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeaderCell,
  TableRow,
  Text,
} from "@tremor/react";
import { useMemo, useState } from "react";
import { useUsers, type InstallRow, type UserRow } from "./api";
import {
  Card,
  ErrorCard,
  PageHeader,
  SEEN_DOT,
  SkeletonCard,
  fmtDate,
  fmtInt,
  lastSeenInfo,
  seenStatus,
} from "./ui";

// Unified row model over signed-in accounts and anonymous installs so one
// table can sort/search across both. `shares` is null for accounts — their
// share count isn't reported per-account, and an honest "—" beats a fake 0.
type Row = {
  id: string;
  kind: "account" | "install";
  name: string;
  phone: string;
  shop: string;
  email: string;
  locale: string;
  source: string;
  platform: string;
  installed_at: string;
  last_seen: string;
  entries: number;
  customers: number;
  shares: number | null;
  account?: UserRow;
  install?: InstallRow;
};

function accountToRow(u: UserRow): Row {
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
    installed_at: u.installed_at,
    last_seen: u.last_seen,
    // Per-kaata activity counts are the account's only entry/customer signal
    // (usage counters live on installs, which the users endpoint folds away).
    entries: u.kaatas.reduce((s, k) => s + k.tally_count, 0),
    customers: u.kaatas.reduce((s, k) => s + k.customer_count, 0),
    shares: null,
    account: u,
  };
}

function installToRow(d: InstallRow): Row {
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
    installed_at: d.installed_at,
    last_seen: d.last_seen,
    entries: d.usage_entries,
    customers: d.usage_customers,
    shares: d.usage_shares,
    install: d,
  };
}

// "Named" = the device told us who its human is (self name, shop, or phone).
// Anonymous = an install with none of those — the rows that used to bury the
// real people.
function isNamed(r: Row): boolean {
  return !!(r.name || r.shop || r.phone);
}

const SEGMENTS = ["All", "Signed in", "Named", "Anonymous"] as const;

type SortKey = "name" | "installed_at" | "last_seen" | "entries" | "customers" | "shares";

const COLUMNS: { key: SortKey | null; label: string; right?: boolean }[] = [
  { key: "name", label: "Name" },
  { key: null, label: "Phone" },
  { key: null, label: "OS" },
  { key: null, label: "Lang" },
  { key: null, label: "Source" },
  { key: "installed_at", label: "Installed" },
  { key: "last_seen", label: "Last seen" },
  { key: "entries", label: "Entries", right: true },
  { key: "customers", label: "Customers", right: true },
  { key: "shares", label: "Shares", right: true },
  { key: null, label: "Kaatas" },
];

export function Users() {
  const users = useUsers();
  const [segment, setSegment] = useState(0);
  const [showAnon, setShowAnon] = useState(false);
  const [search, setSearch] = useState("");
  // Facet filters — platform is the headline (iOS just launched), the rest
  // are the founder's usual slices. All client-side; fleet is <200 rows.
  const [platform, setPlatform] = useState("all");
  const [activity, setActivity] = useState("any");
  const [lang, setLang] = useState("all");
  const [source, setSource] = useState("all");
  const [sortKey, setSortKey] = useState<SortKey>("last_seen");
  const [sortDesc, setSortDesc] = useState(true);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  const allRows = useMemo(
    () =>
      users.data
        ? [
            ...users.data.users.map(accountToRow),
            ...(users.data.anonymous_installs ?? []).map(installToRow),
          ]
        : [],
    [users.data],
  );
  const anonCount = useMemo(
    () => allRows.filter((r) => r.kind === "install" && !isNamed(r)).length,
    [allRows],
  );
  const sources = useMemo(
    () => [...new Set(allRows.map((r) => r.source).filter(Boolean))].sort(),
    [allRows],
  );

  const rows = useMemo(() => {
    let base: Row[];
    switch (segment) {
      case 1:
        base = allRows.filter((r) => r.kind === "account");
        break;
      case 2:
        base = allRows.filter(isNamed);
        break;
      case 3:
        base = allRows.filter((r) => r.kind === "install" && !isNamed(r));
        break;
      default:
        // "All" means all *people* — anonymous no-identity installs stay
        // collapsed until the quiet toggle reveals them.
        base = allRows.filter((r) => r.kind === "account" || isNamed(r) || showAnon);
    }
    // Facet filters compose with the segment + search.
    if (platform !== "all") base = base.filter((r) => r.platform === platform);
    if (lang !== "all") base = base.filter((r) => (r.locale || "unknown") === lang);
    if (source !== "all") base = base.filter((r) => r.source === source);
    if (activity !== "any") {
      base = base.filter((r) => {
        const s = seenStatus(r.last_seen);
        if (activity === "7d") return s === "green";
        if (activity === "30d") return s === "green" || s === "amber";
        return s === "gray"; // dormant: no activity in 30d (or never seen)
      });
    }
    const q = search.trim().toLowerCase();
    const filtered = q
      ? base.filter(
          (r) =>
            r.name.toLowerCase().includes(q) ||
            r.phone.toLowerCase().includes(q) ||
            r.shop.toLowerCase().includes(q) ||
            r.email.toLowerCase().includes(q),
        )
      : base;
    const dir = sortDesc ? -1 : 1;
    return [...filtered].sort((a, b) => {
      const av = a[sortKey];
      const bv = b[sortKey];
      // Empty values (never seen, no date, null shares) always sort last so
      // the interesting rows stay on top in either direction.
      const aEmpty = av === "" || av === null;
      const bEmpty = bv === "" || bv === null;
      if (aEmpty && bEmpty) return 0;
      if (aEmpty) return 1;
      if (bEmpty) return -1;
      if (typeof av === "number" && typeof bv === "number") return (av - bv) * dir;
      return String(av).localeCompare(String(bv)) * dir;
    });
  }, [allRows, segment, showAnon, search, sortKey, sortDesc, platform, activity, lang, source]);

  return (
    <div>
      <PageHeader
        title="Users"
        description="Everyone using kaata — signed-in accounts and anonymous installs alike. Ledgers never leave the phone; this is the self profile each device reports."
      />
      {users.isPending ? (
        <SkeletonCard lines={10} />
      ) : users.isError ? (
        <ErrorCard message="Couldn't load users." onRetry={() => void users.refetch()} />
      ) : (
        <>
          <SummaryStrip
            total={users.data.total_installs}
            signedIn={users.data.signed_in_count}
            named={allRows.filter(isNamed).length}
            active7d={allRows.filter((r) => seenStatus(r.last_seen) === "green").length}
          />
          <Card className="mt-4">
            <div className="mb-3 flex flex-wrap items-center gap-3">
              <TabGroup
                index={segment}
                onIndexChange={(i) => {
                  setSegment(i);
                  setExpanded({});
                }}
                className="w-auto"
              >
                <TabList variant="solid">
                  {SEGMENTS.map((s) => (
                    <Tab key={s}>{s}</Tab>
                  ))}
                </TabList>
              </TabGroup>
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search name or phone…"
                className="w-56 rounded-lg border border-[#eaecf0] px-3 py-1.5 text-sm text-[#101828] placeholder-[#98a2b3] focus:border-[#98a2b3] focus:outline-none"
              />
              <span className="ml-auto text-xs tabular-nums text-[#98a2b3]">
                {fmtInt(rows.length)} shown · {fmtInt(users.data.signed_in_count)} signed in ·{" "}
                {fmtInt(users.data.anonymous_count)} anonymous
              </span>
            </div>
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <FilterSelect
                label="Platform"
                value={platform}
                onChange={setPlatform}
                options={[
                  ["all", "All platforms"],
                  ["android", "Android"],
                  ["ios", "iOS"],
                ]}
              />
              <FilterSelect
                label="Activity"
                value={activity}
                onChange={setActivity}
                options={[
                  ["any", "Any activity"],
                  ["7d", "Active 7d"],
                  ["30d", "Active 30d"],
                  ["dormant", "Dormant 30d+"],
                ]}
              />
              <FilterSelect
                label="Language"
                value={lang}
                onChange={setLang}
                options={[
                  ["all", "All languages"],
                  ["fa", "Dari (fa)"],
                  ["en", "English (en)"],
                  ["unknown", "Unknown"],
                ]}
              />
              <FilterSelect
                label="Source"
                value={source}
                onChange={setSource}
                options={[
                  ["all", "All sources"],
                  ...sources.map((s) => [s, s] as [string, string]),
                ]}
              />
              {platform !== "all" || activity !== "any" || lang !== "all" || source !== "all" ? (
                <button
                  onClick={() => {
                    setPlatform("all");
                    setActivity("any");
                    setLang("all");
                    setSource("all");
                  }}
                  className="text-xs text-[#98a2b3] underline decoration-dotted underline-offset-2 hover:text-[#475467]"
                >
                  clear filters
                </button>
              ) : null}
            </div>
            <UsersTable
              rows={rows}
              sortKey={sortKey}
              sortDesc={sortDesc}
              onSort={(key) => {
                if (sortKey === key) setSortDesc((d) => !d);
                else {
                  setSortKey(key);
                  setSortDesc(true);
                }
              }}
              expanded={expanded}
              onToggle={(id) => setExpanded((e) => ({ ...e, [id]: !e[id] }))}
            />
            {segment === 0 && anonCount > 0 ? (
              <button
                onClick={() => setShowAnon((v) => !v)}
                className="mt-3 text-xs text-[#98a2b3] hover:text-[#475467]"
              >
                {fmtInt(anonCount)} anonymous installs ·{" "}
                <span className="underline decoration-dotted underline-offset-2">
                  {showAnon ? "hide" : "show"}
                </span>
              </button>
            ) : null}
          </Card>
        </>
      )}
    </div>
  );
}

// Native <select> styled like the search input — dependable, keyboardable,
// and spared Tremor's popper machinery for four tiny dropdowns.
function FilterSelect(props: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: [string, string][];
}) {
  return (
    <select
      aria-label={props.label}
      value={props.value}
      onChange={(e) => props.onChange(e.target.value)}
      className={`rounded-lg border px-2.5 py-1.5 text-xs focus:outline-none ${
        props.value === props.options[0][0]
          ? "border-[#eaecf0] text-[#475467]"
          : "border-[#98a2b3] font-medium text-[#101828]"
      } bg-white`}
    >
      {props.options.map(([v, label]) => (
        <option key={v} value={v}>
          {label}
        </option>
      ))}
    </select>
  );
}

function SummaryStrip(props: { total: number; signedIn: number; named: number; active7d: number }) {
  const items = [
    { label: "Total installs", value: props.total },
    { label: "Signed in", value: props.signedIn },
    { label: "Named", value: props.named },
    { label: "Active 7d", value: props.active7d },
  ];
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      {items.map((it) => (
        <Card key={it.label} className="p-4">
          <Text className="text-xs font-medium uppercase tracking-wide text-tremor-content-subtle">
            {it.label}
          </Text>
          <Metric className="mt-1 text-2xl tabular-nums">{fmtInt(it.value)}</Metric>
        </Card>
      ))}
    </div>
  );
}

function UsersTable(props: {
  rows: Row[];
  sortKey: SortKey;
  sortDesc: boolean;
  onSort: (key: SortKey) => void;
  expanded: Record<string, boolean>;
  onToggle: (id: string) => void;
}) {
  return (
    // Bounded height makes the sticky header actually stick — the Table root
    // is the scroll container (Tremor's wrapper div carries overflow-auto).
    <Table className="max-h-[65vh]">
      <TableHead>
        <TableRow className="border-b border-[#eaecf0]">
          {COLUMNS.map((col) => (
            <TableHeaderCell
              key={col.label}
              className={`sticky top-0 z-10 bg-white px-0 py-2 pr-3 text-xs font-medium text-[#98a2b3] ${
                col.right ? "text-right" : ""
              }`}
            >
              {col.key ? (
                <button
                  className="inline-flex items-center gap-1 hover:text-[#475467]"
                  onClick={() => props.onSort(col.key as SortKey)}
                >
                  {col.label}
                  {props.sortKey === col.key ? <span>{props.sortDesc ? "↓" : "↑"}</span> : null}
                </button>
              ) : (
                col.label
              )}
            </TableHeaderCell>
          ))}
        </TableRow>
      </TableHead>
      <TableBody>
        {props.rows.map((r) => (
          <UserTableRow
            key={r.id}
            row={r}
            open={!!props.expanded[r.id]}
            onToggle={() => props.onToggle(r.id)}
          />
        ))}
        {props.rows.length === 0 ? (
          <TableRow>
            <TableCell colSpan={COLUMNS.length} className="py-6 text-center text-xs text-[#98a2b3]">
              No matching users.
            </TableCell>
          </TableRow>
        ) : null}
      </TableBody>
    </Table>
  );
}

const cell = "px-0 py-2 pr-3";

function UserTableRow(props: { row: Row; open: boolean; onToggle: () => void }) {
  const r = props.row;
  const seen = lastSeenInfo(r.last_seen);
  const status = seenStatus(r.last_seen);
  const kaatas = r.account?.kaatas ?? [];
  return (
    <>
      <TableRow
        className="cursor-pointer border-b border-[#f2f4f7] last:border-0 hover:bg-[#f9fafb]"
        onClick={props.onToggle}
      >
        <TableCell className={`${cell} max-w-[220px]`}>
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-medium text-[#101828]">
              {r.name || <span className="font-normal text-[#98a2b3]">(no name)</span>}
            </span>
            {r.kind === "account" ? (
              <span className="shrink-0 rounded bg-[#f2f4f7] px-1.5 py-0.5 text-[10px] font-semibold uppercase text-[#475467]">
                signed in
              </span>
            ) : null}
          </div>
          {r.shop || r.email ? (
            <div className="truncate text-xs text-[#98a2b3]">{r.shop || r.email}</div>
          ) : null}
        </TableCell>
        <TableCell className={`${cell} whitespace-nowrap text-xs tabular-nums text-[#475467]`}>
          <span dir="ltr">{r.phone || "—"}</span>
        </TableCell>
        <TableCell className={`${cell} text-xs text-[#98a2b3]`}>
          {r.platform === "ios" ? "iOS" : r.platform === "android" ? "Android" : "—"}
        </TableCell>
        <TableCell className={`${cell} text-xs uppercase text-[#98a2b3]`}>
          {r.locale || "—"}
        </TableCell>
        <TableCell className={`${cell} text-xs text-[#98a2b3]`}>{r.source || "—"}</TableCell>
        <TableCell className={`${cell} whitespace-nowrap text-xs text-[#475467]`}>
          {fmtDate(r.installed_at)}
        </TableCell>
        <TableCell className={`${cell} whitespace-nowrap text-xs`}>
          <span className="flex items-center gap-1.5">
            {/* Recency dot: green <7d, amber <30d, gray colder/never. */}
            <span className={`h-2 w-2 rounded-full ${SEEN_DOT[status]}`} />
            <span className={seen.online ? "font-medium text-emerald-600" : "text-[#475467]"}>
              {seen.online ? "online" : seen.label}
            </span>
          </span>
        </TableCell>
        <TableCell className={`${cell} text-right text-sm tabular-nums text-[#101828]`}>
          {fmtInt(r.entries)}
        </TableCell>
        <TableCell className={`${cell} text-right text-sm tabular-nums text-[#101828]`}>
          {fmtInt(r.customers)}
        </TableCell>
        <TableCell className={`${cell} text-right text-sm tabular-nums text-[#101828]`}>
          {r.shares === null ? "—" : fmtInt(r.shares)}
        </TableCell>
        <TableCell className="px-0 py-2">
          {kaatas.length > 0 ? (
            <span className="flex flex-wrap items-center gap-1">
              <span className="text-xs tabular-nums text-[#475467]">{kaatas.length}</span>
              {kaatas.slice(0, 3).map((k) => (
                <span
                  key={k.vault_id}
                  className="rounded bg-[#f2f4f7] px-1.5 py-0.5 text-[10px] font-semibold uppercase text-[#475467]"
                >
                  {k.role}
                </span>
              ))}
            </span>
          ) : (
            <span className="text-xs text-[#98a2b3]">—</span>
          )}
        </TableCell>
      </TableRow>
      {props.open ? (
        <TableRow className="border-b border-[#f2f4f7]">
          <TableCell colSpan={COLUMNS.length} className="bg-[#f9fafb] px-4 py-3">
            {r.kind === "account" && r.account ? (
              <AccountDetail u={r.account} />
            ) : r.install ? (
              <InstallDetail d={r.install} />
            ) : null}
          </TableCell>
        </TableRow>
      ) : null}
    </>
  );
}

function DetailItem(props: { label: string; value: string }) {
  return (
    <span className="text-xs text-[#475467]">
      <span className="text-[#98a2b3]">{props.label} </span>
      {props.value || "—"}
    </span>
  );
}

function AccountDetail(props: { u: UserRow }) {
  const u = props.u;
  return (
    <div>
      <div className="flex flex-wrap gap-x-5 gap-y-1">
        <DetailItem label="email" value={u.email} />
        <DetailItem label="google name" value={u.name} />
        <DetailItem label="created" value={fmtDate(u.created_at)} />
        <DetailItem label="last login" value={fmtDate(u.last_login_at)} />
        <DetailItem label="last activity" value={fmtDate(u.last_activity_at)} />
        <DetailItem
          label="device"
          value={`${u.platform || "—"}${u.app_version ? ` · v${u.app_version}` : ""}`}
        />
        <DetailItem label="devices" value={String(u.install_count)} />
        {!u.has_onboarded ? <span className="text-xs text-amber-600">not onboarded</span> : null}
      </div>
      {u.kaatas.length === 0 ? (
        <p className="mt-2 text-xs text-[#98a2b3]">No kaatas backed up yet.</p>
      ) : (
        <div className="mt-2 flex flex-col gap-1.5">
          {u.kaatas.map((k) => (
            <div key={k.vault_id} className="flex flex-wrap items-center gap-2 text-xs">
              <span className="font-medium text-[#101828]">{k.name}</span>
              <span className="rounded bg-[#eaecf0] px-1.5 py-0.5 text-[10px] font-semibold uppercase text-[#475467]">
                {k.role}
              </span>
              {k.archived ? (
                <span className="text-[10px] font-semibold uppercase text-amber-600">archived</span>
              ) : null}
              <span className="tabular-nums text-[#98a2b3]">
                {fmtInt(k.tally_count)} tallies · {fmtInt(k.customer_count)} customers ·{" "}
                {k.member_count} member{k.member_count === 1 ? "" : "s"}
              </span>
              {k.members.length > 0 ? (
                <span className="text-[#98a2b3]">
                  {k.members.map((m) => `${m.name || m.email} (${m.role})`).join(", ")}
                </span>
              ) : null}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function InstallDetail(props: { d: InstallRow }) {
  const d = props.d;
  return (
    <div className="flex flex-wrap gap-x-5 gap-y-1">
      <DetailItem label="install" value={d.install_id.slice(0, 8)} />
      <DetailItem
        label="device"
        value={`${d.platform || "—"}${d.app_version ? ` · v${d.app_version}` : ""}`}
      />
      <DetailItem label="first seen" value={fmtDate(d.first_seen)} />
      <DetailItem label="last activity" value={fmtDate(d.last_activity_at)} />
      <DetailItem label="attribution" value={d.attribution_method} />
      <DetailItem label="check-ins" value={String(d.check_in_count)} />
      {!d.has_onboarded ? <span className="text-xs text-amber-600">not onboarded</span> : null}
    </div>
  );
}
