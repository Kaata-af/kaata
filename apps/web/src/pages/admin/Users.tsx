// Users — every human we can identify: signed-in accounts AND anonymous
// installs (which report the shopkeeper's OWN self profile on check-in —
// migration 028 — never customer data) in one searchable, sortable table.
// Row click expands an inline detail panel. Fleet is <200 rows: no
// pagination, no virtualization.

import { useMemo, useState } from "react";
import { useUsers, type InstallRow, type UserRow } from "./api";
import { Card, ErrorCard, PageHeader, SkeletonCard, fmtDate, fmtInt, lastSeenInfo } from "./ui";

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
    installed_at: d.installed_at,
    last_seen: d.last_seen,
    entries: d.usage_entries,
    customers: d.usage_customers,
    shares: d.usage_shares,
    install: d,
  };
}

type SortKey = "name" | "installed_at" | "last_seen" | "entries" | "customers" | "shares";

const COLUMNS: { key: SortKey | null; label: string; right?: boolean }[] = [
  { key: "name", label: "Name" },
  { key: null, label: "Phone" },
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
  const [search, setSearch] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("last_seen");
  const [sortDesc, setSortDesc] = useState(true);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  const rows = useMemo(() => {
    if (!users.data) return [];
    const all = [
      ...users.data.users.map(accountToRow),
      ...(users.data.anonymous_installs ?? []).map(installToRow),
    ];
    const q = search.trim().toLowerCase();
    const filtered = q
      ? all.filter(
          (r) =>
            r.name.toLowerCase().includes(q) ||
            r.phone.toLowerCase().includes(q) ||
            r.shop.toLowerCase().includes(q) ||
            r.email.toLowerCase().includes(q),
        )
      : all;
    const dir = sortDesc ? -1 : 1;
    return filtered.sort((a, b) => {
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
  }, [users.data, search, sortKey, sortDesc]);

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
        <Card>
          <div className="mb-3 flex flex-wrap items-center gap-3">
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search name or phone…"
              className="w-64 rounded-lg border border-[#eaecf0] px-3 py-1.5 text-sm text-[#101828] placeholder-[#98a2b3] focus:border-[#98a2b3] focus:outline-none"
            />
            <span className="text-xs tabular-nums text-[#98a2b3]">
              {fmtInt(rows.length)} shown · {fmtInt(users.data.signed_in_count)} signed in ·{" "}
              {fmtInt(users.data.anonymous_count)} anonymous
            </span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[#eaecf0] text-left text-xs text-[#98a2b3]">
                  {COLUMNS.map((col) => (
                    <th
                      key={col.label}
                      className={`py-2 pr-3 font-medium ${col.right ? "text-right" : ""}`}
                    >
                      {col.key ? (
                        <button
                          className="inline-flex items-center gap-1 hover:text-[#475467]"
                          onClick={() => {
                            if (sortKey === col.key) setSortDesc((d) => !d);
                            else {
                              setSortKey(col.key as SortKey);
                              setSortDesc(true);
                            }
                          }}
                        >
                          {col.label}
                          {sortKey === col.key ? <span>{sortDesc ? "↓" : "↑"}</span> : null}
                        </button>
                      ) : (
                        col.label
                      )}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <UserTableRow
                    key={r.id}
                    row={r}
                    open={!!expanded[r.id]}
                    onToggle={() => setExpanded((e) => ({ ...e, [r.id]: !e[r.id] }))}
                  />
                ))}
                {rows.length === 0 ? (
                  <tr>
                    <td
                      colSpan={COLUMNS.length}
                      className="py-6 text-center text-xs text-[#98a2b3]"
                    >
                      No matching users.
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  );
}

function UserTableRow(props: { row: Row; open: boolean; onToggle: () => void }) {
  const r = props.row;
  const seen = lastSeenInfo(r.last_seen);
  const kaatas = r.account?.kaatas ?? [];
  return (
    <>
      <tr
        className="cursor-pointer border-b border-[#f2f4f7] last:border-0 hover:bg-[#f9fafb]"
        onClick={props.onToggle}
      >
        <td className="max-w-[220px] py-2 pr-3">
          <div className="flex items-center gap-2">
            <span className="truncate font-medium text-[#101828]">
              {r.name || <span className="text-[#98a2b3]">(no name)</span>}
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
        </td>
        <td className="whitespace-nowrap py-2 pr-3 text-xs tabular-nums text-[#475467]" dir="ltr">
          {r.phone || "—"}
        </td>
        <td className="py-2 pr-3 text-xs uppercase text-[#98a2b3]">{r.locale || "—"}</td>
        <td className="py-2 pr-3 text-xs text-[#98a2b3]">{r.source || "—"}</td>
        <td className="whitespace-nowrap py-2 pr-3 text-xs text-[#475467]">
          {fmtDate(r.installed_at)}
        </td>
        <td className="whitespace-nowrap py-2 pr-3 text-xs">
          <span className="flex items-center gap-1.5">
            <span
              className={`h-2 w-2 rounded-full ${seen.online ? "bg-green-500" : "bg-[#d0d5dd]"}`}
            />
            <span className={seen.online ? "font-medium text-green-600" : "text-[#475467]"}>
              {seen.online ? "online" : seen.label}
            </span>
          </span>
        </td>
        <td className="py-2 pr-3 text-right tabular-nums text-[#101828]">{fmtInt(r.entries)}</td>
        <td className="py-2 pr-3 text-right tabular-nums text-[#101828]">{fmtInt(r.customers)}</td>
        <td className="py-2 pr-3 text-right tabular-nums text-[#101828]">
          {r.shares === null ? "—" : fmtInt(r.shares)}
        </td>
        <td className="py-2">
          {kaatas.length > 0 ? (
            <span className="flex flex-wrap items-center gap-1">
              <span className="tabular-nums text-xs text-[#475467]">{kaatas.length}</span>
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
        </td>
      </tr>
      {props.open ? (
        <tr className="border-b border-[#f2f4f7]">
          <td colSpan={COLUMNS.length} className="bg-[#f9fafb] px-4 py-3">
            {r.kind === "account" && r.account ? (
              <AccountDetail u={r.account} />
            ) : r.install ? (
              <InstallDetail d={r.install} />
            ) : null}
          </td>
        </tr>
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
