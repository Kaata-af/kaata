// Outreach — the operator's WhatsApp desk (2026-09-29). One row per phone
// number the server knows: shopkeepers (installs.self_phone,
// accounts.phone_e164) and the people inside synced kaatas (person events
// folded per vault by the backend, see internal/admin/outreach.go). The
// operator ticks "sent" by hand, tracks replies/status/notes, sees follow-ups
// due and opens WhatsApp with a filled template. Everything is client-side
// over one GET /v1/admin/outreach payload, the same pipeline as Users:
// presets → filters → search → sort → page. Writes go through two POSTs (mark,
// setting); each tick patches the cached result optimistically
// (outreach-model.applyMarkLocally), rolls back on error, takes the server's
// answer on success (applyMarkResponse) and refetches once the last write in
// flight settles, so a slow network never leaves a stale checkbox. Summary
// cards count the rows their click opens (presetCounts). Idioms are copied
// from Users.tsx on purpose (FIELD/BUTTON, Pill, FilterSelect, SummaryCard,
// the card/table split, sessionStorage prefs that hold only enums and
// numbers); its file-local helpers are duplicated minimally rather than
// lifted so Users.tsx stays untouched.

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Fragment, useEffect, useMemo, useState, type ReactNode } from "react";
import { useToast } from "../../components/Toast";
import {
  markOutreach,
  saveOutreachSetting,
  useAdminToken,
  useOutreach,
  type OutreachContact,
  type OutreachCustomer,
  type OutreachMarkBody,
  type OutreachResult,
  type OutreachShopkeeper,
  type OutreachState,
  type OutreachStatus,
} from "./api";
import { reportingDay } from "./dates";
import {
  AFGHAN_CARRIERS,
  AUTO_MARK_KEY,
  CONVERTED_FILTERS,
  DEFAULT_OUTREACH_FILTERS,
  DEFAULT_SLUGS,
  OUTREACH_PRESETS,
  OUTREACH_SORT_OPTIONS,
  OUTREACH_STATUSES,
  STATUS_LABELS,
  activePreset,
  afghanCarrier,
  applyMarkLocally,
  applyMarkResponse,
  applySettingLocally,
  balanceSummary,
  buildMessage,
  chunk,
  contactDisplayName,
  contactInitials,
  contactPills,
  dialCode,
  facetValue,
  filterOutreach,
  formatMoney,
  isOutreachStatus,
  languageLabel,
  lastTallyAt,
  nextToContact,
  outreachCsv,
  ownerNames,
  parseMoney,
  parseOutreachPreferences,
  platformLabel,
  presetCounts,
  presetFilters,
  sanitizeSlug,
  slugKey,
  sortOutreach,
  templateFor,
  templateKey,
  waLink,
  type Audience,
  type LanguageOverride,
  type OutreachFilters,
  type OutreachPreferences,
  type OutreachPreset,
  type OutreachSortKey,
  type PillTone,
} from "./outreach-model";
import { Card, ErrorCard, PageHeader, SkeletonCard, fmtDate, fmtInt, lastSeenInfo } from "./ui";

const STORAGE_KEY = "kaata_admin_outreach_filters_v1";
const FIELD =
  "min-h-11 min-w-0 w-full max-w-full rounded-lg border border-[#e5e5e5] bg-white px-3 py-2 text-base text-[#404040] outline-none transition focus:border-[#171717] focus:ring-2 focus:ring-[#171717]/10 md:text-sm";
const BUTTON =
  "inline-flex min-h-11 min-w-11 max-w-full items-center justify-center gap-2 rounded-lg border border-[#e5e5e5] bg-white px-3 py-2 text-sm font-medium text-[#404040] transition hover:border-[#d4d4d4] hover:bg-[#fafafa] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#171717] focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-40";
const PRIMARY =
  "inline-flex min-h-11 max-w-full items-center justify-center gap-2 rounded-lg bg-[#171717] px-4 py-2 text-sm font-medium text-white transition hover:bg-[#404040] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#171717] focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-40";
const SMALL_BUTTON =
  "inline-flex min-h-11 items-center justify-center gap-1.5 rounded-md border border-[#e5e5e5] bg-white px-2.5 py-1 text-xs font-medium text-[#404040] transition hover:bg-[#fafafa] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#171717] disabled:cursor-not-allowed disabled:opacity-40 md:min-h-8";
const CHECKBOX = "h-4 w-4 shrink-0 rounded accent-[#171717]";
const SMALL_SELECT =
  "min-h-11 min-w-0 max-w-full rounded-md border border-[#e5e5e5] bg-white py-1.5 pl-2 pr-6 text-base text-[#404040] focus-visible:outline-[#171717] md:min-h-8 md:text-xs";
const PAGE_SIZES = [25, 50, 100];
const WA_BUTTON =
  "inline-flex min-h-11 items-center justify-center gap-1.5 rounded-md bg-[#e8f5ed] px-2.5 py-1 text-xs font-semibold text-[#116b4f] transition hover:bg-[#d7eede] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#171717] md:min-h-8";

type SelectKey =
  | "kind"
  | "status"
  | "carrier"
  | "signedIn"
  | "onboarded"
  | "alreadyUser"
  | "direction"
  | "archived"
  | "lastSeen"
  | "replied"
  | "followUp"
  | "converted"
  | "wholesaler";
const SELECTS: { key: SelectKey; label: string; options: [string, string][] }[] = [
  {
    key: "kind",
    label: "Kind",
    options: [
      ["all", "Every number"],
      ["shopkeeper", "Shopkeepers only"],
      ["customer", "Customers only"],
      ["both", "Both (customer who installed)"],
    ],
  },
  {
    key: "status",
    label: "Status",
    options: [
      ["all", "Any status"],
      ...OUTREACH_STATUSES.map((status): [string, string] => [status, STATUS_LABELS[status]]),
      ["declined_any", "Declined or do not contact"],
    ],
  },
  {
    key: "carrier",
    label: "Afghan carrier",
    options: [["", "Any carrier"], ...AFGHAN_CARRIERS.map((c): [string, string] => [c, c])],
  },
  {
    key: "signedIn",
    label: "Signed in",
    options: [
      ["all", "Any"],
      ["yes", "Signed in"],
      ["no", "Installed, not signed in"],
    ],
  },
  {
    key: "onboarded",
    label: "Onboarded",
    options: [
      ["all", "Any"],
      ["yes", "Completed"],
      ["no", "Installed, not completed"],
    ],
  },
  {
    key: "alreadyUser",
    label: "Already a user",
    options: [
      ["all", "Any"],
      ["yes", "Customer who already installed"],
      ["no", "Customer not yet a user"],
    ],
  },
  {
    key: "direction",
    label: "Direction",
    options: [
      ["all", "Any"],
      ["customer", "Owes a shop (customer side)"],
      ["supplier", "Shop owes them (supplier side)"],
    ],
  },
  {
    key: "archived",
    label: "Archived customers",
    options: [
      ["hide", "Hide archived everywhere"],
      ["show", "Show all"],
      ["only", "Only archived everywhere"],
    ],
  },
  {
    key: "lastSeen",
    label: "Last seen (install)",
    options: [
      ["all", "Any time"],
      ["7d", "Within 7 days"],
      ["30d", "Within 30 days"],
      ["older", "30+ days ago"],
      ["never", "Never / no install"],
    ],
  },
  {
    key: "replied",
    label: "Replied",
    options: [
      ["all", "Any"],
      ["yes", "Replied"],
      ["no", "No reply"],
    ],
  },
  {
    key: "followUp",
    label: "Follow-up",
    options: [
      ["all", "Any"],
      ["due", "Due (sent 48 h+, no reply)"],
    ],
  },
  {
    key: "converted",
    label: "Installed after contact",
    options: [
      ["all", "Any"],
      ["yes", "Converted"],
    ],
  },
  {
    key: "wholesaler",
    label: "Wholesaler",
    options: [
      ["all", "Any"],
      ["yes", "Wholesalers only"],
    ],
  },
];

function presetFromHash(): OutreachPreset | undefined {
  if (window.location.hash.split("?")[0].replace(/^#\/?/, "") !== "outreach") return undefined;
  const value = new URLSearchParams(window.location.hash.split("?")[1] ?? "").get("view");
  return OUTREACH_PRESETS.find((p) => p.id === value)?.id;
}
function initialPreferences(): OutreachPreferences {
  let saved: unknown;
  try {
    saved = JSON.parse(sessionStorage.getItem(STORAGE_KEY) ?? "null");
  } catch {
    /* Storage may be unavailable. */
  }
  const preferences = parseOutreachPreferences(saved);
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
function fmtDateTime(iso: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "—";
  return d.toLocaleString(undefined, {
    timeZone: "Asia/Kabul",
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
function humanValue(value: string): string {
  return value === "__unknown__" ? "Unknown" : value;
}
function downloadBlob(blob: Blob, filename: string) {
  const objectUrl = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = objectUrl;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Deferred revoke — revoking synchronously races the download in Safari.
  setTimeout(() => URL.revokeObjectURL(objectUrl), 1_000);
}

// Both writes patch the cached GET first so the UI answers at once, put the
// snapshot back on failure, patch again from the server's answer on success,
// and refetch on settle only when no sibling mutation is still in flight —
// two quick ticks otherwise race: the first's refetch would paint the server
// state from before the second's optimistic patch until the second settled.
// The mutation is still counted as pending inside onSettled, so 1 means
// "this was the last one". A 401 on a write is not caught by the QueryCache;
// the settle refetch hits the same 401 and the shell's sign-out fires from there.
const MARK_MUTATION_KEY = ["admin", "outreach", "mark"];
const SETTING_MUTATION_KEY = ["admin", "outreach", "setting"];
function useOutreachMutations() {
  const token = useAdminToken();
  const client = useQueryClient();
  const toast = useToast();
  const key = ["admin", "outreach", token];
  const settleUnlessMoreInFlight = (mutationKey: string[]) => {
    if (client.isMutating({ mutationKey }) === 1)
      void client.invalidateQueries({ queryKey: ["admin", "outreach"] });
  };
  const mark = useMutation({
    mutationKey: MARK_MUTATION_KEY,
    mutationFn: async (body: OutreachMarkBody): Promise<OutreachState[]> => {
      const updated: OutreachState[] = [];
      for (const phones of chunk(body.phones, 500)) {
        const response = await markOutreach(token, { ...body, phones });
        if (Array.isArray(response.updated)) updated.push(...response.updated);
      }
      return updated;
    },
    onMutate: async (body) => {
      await client.cancelQueries({ queryKey: key });
      const snapshot = client.getQueryData<OutreachResult | null>(key);
      if (snapshot)
        client.setQueryData(key, applyMarkLocally(snapshot, body, new Date().toISOString()));
      return { snapshot };
    },
    onSuccess: (updated, body) => {
      const current = client.getQueryData<OutreachResult | null>(key);
      if (current) client.setQueryData(key, applyMarkResponse(current, updated, body));
    },
    onError: (error, _body, context) => {
      if (context && context.snapshot !== undefined) client.setQueryData(key, context.snapshot);
      toast.push(error.message || "Couldn't save.", "error");
    },
    onSettled: () => settleUnlessMoreInFlight(MARK_MUTATION_KEY),
  });
  const setting = useMutation({
    mutationKey: SETTING_MUTATION_KEY,
    mutationFn: (input: { key: string; value: string }) =>
      saveOutreachSetting(token, input.key, input.value),
    onMutate: async (input) => {
      await client.cancelQueries({ queryKey: key });
      const snapshot = client.getQueryData<OutreachResult | null>(key);
      if (snapshot) client.setQueryData(key, applySettingLocally(snapshot, input.key, input.value));
      return { snapshot };
    },
    onSuccess: (saved, input) => {
      const current = client.getQueryData<OutreachResult | null>(key);
      if (current)
        client.setQueryData(key, applySettingLocally(current, saved.key || input.key, saved.value));
    },
    onError: (error, _input, context) => {
      if (context && context.snapshot !== undefined) client.setQueryData(key, context.snapshot);
      toast.push(error.message || "Couldn't save the setting.", "error");
    },
    onSettled: () => settleUnlessMoreInFlight(SETTING_MUTATION_KEY),
  });
  return { mark, setting };
}

export function Outreach() {
  const outreach = useOutreach();
  const toast = useToast();
  const { mark, setting } = useOutreachMutations();
  const [preferences, setPreferences] = useState(initialPreferences);
  const { filters, sortKey, sortDesc, pageSize } = preferences;
  const [search, setSearch] = useState("");
  const [showFilters, setShowFilters] = useState(false);
  const [page, setPage] = useState(0);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [overrides, setOverrides] = useState<Record<string, LanguageOverride>>({});
  const [clockTick, setNow] = useState(Date.now);
  const now = Math.max(clockTick, outreach.dataUpdatedAt);
  const data = outreach.data ?? null;
  const contacts = useMemo(() => data?.contacts ?? [], [data]);
  const settings = useMemo(() => data?.settings ?? {}, [data]);
  const autoMark = settings[AUTO_MARK_KEY] !== "off";
  const selectedPreset = activePreset(filters);
  // Card values come from the same predicates the cards apply (see
  // outreach-model.presetCounts); only "Today" is the server's touch count.
  const cards = useMemo(() => presetCounts(contacts, now), [contacts, now]);
  const filtered = useMemo(
    () => filterOutreach(contacts, filters, search, now),
    [contacts, filters, search, now],
  );
  const sorted = useMemo(
    () => sortOutreach(filtered, sortKey, sortDesc),
    [filtered, sortKey, sortDesc],
  );
  const pageCount = Math.max(1, Math.ceil(sorted.length / pageSize));
  const currentPage = Math.min(page, pageCount - 1);
  const pageRows = sorted.slice(currentPage * pageSize, (currentPage + 1) * pageSize);
  const invalidRange = !!(
    filters.contactedFrom &&
    filters.contactedTo &&
    filters.contactedFrom > filters.contactedTo
  );
  // Chips describe what the operator changed on top of the current view, so a
  // preset's own baseline (e.g. the tracking tabs showing archived customers)
  // is not reported as an extra filter.
  const activeFilters = filterChips(
    filters,
    selectedPreset ? presetFilters(selectedPreset) : DEFAULT_OUTREACH_FILTERS,
  );
  const selectedPhones = useMemo(
    () => Object.keys(selected).filter((phone) => selected[phone]),
    [selected],
  );
  const next = nextToContact(sorted);

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
        `${window.location.pathname}${window.location.search}#outreach`,
      );
    };
    onHash();
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  function updateFilters(patch: Partial<OutreachFilters>) {
    setPreferences((p) => ({ ...p, filters: { ...p.filters, ...patch } }));
    setPage(0);
    setExpanded({});
  }
  function applyView(next: OutreachFilters) {
    setPreferences((p) => ({ ...p, filters: next }));
    setSearch("");
    setPage(0);
    setExpanded({});
  }
  function applyPreset(preset: OutreachPreset) {
    applyView(presetFilters(preset));
  }
  function reset() {
    applyPreset("all");
  }
  function sortBy(key: OutreachSortKey) {
    setPreferences((p) => ({
      ...p,
      sortKey: key,
      sortDesc: p.sortKey === key ? !p.sortDesc : key !== "name" && key !== "phone",
    }));
    setPage(0);
  }
  const facetOptions = (
    field: "platform" | "language" | "source",
    selectedValue: string,
  ): [string, string][] => {
    const values = [...new Set(contacts.map((contact) => facetValue(contact, field)))];
    if (selectedValue && !values.includes(selectedValue)) values.push(selectedValue);
    return [
      ["", "All"],
      ...values
        .sort()
        .map((value): [string, string] => [
          value,
          field === "platform"
            ? platformLabel(value)
            : field === "language"
              ? languageLabel(value)
              : humanValue(value),
        ]),
    ];
  };
  const countryOptions = useMemo((): [string, string][] => {
    const counts = new Map<string, { country: string; count: number }>();
    for (const contact of contacts) {
      const { code, country } = dialCode(contact.phone);
      if (!code) continue;
      const entry = counts.get(code) ?? { country, count: 0 };
      entry.count += 1;
      counts.set(code, entry);
    }
    if (filters.country && !counts.has(filters.country))
      counts.set(filters.country, { country: filters.country, count: 0 });
    return [
      ["", "All countries"],
      ...[...counts.entries()]
        .sort((a, b) => b[1].count - a[1].count || a[0].localeCompare(b[0]))
        .map(([code, { country, count }]): [string, string] => [
          code,
          `${country === code ? code : `${country} ${code}`} · ${count}`,
        ]),
    ];
  }, [contacts, filters.country]);

  async function copyText(text: string, message: string) {
    try {
      await navigator.clipboard.writeText(text);
      toast.push(message, "success");
    } catch {
      toast.push("Couldn't copy — the browser blocked clipboard access.", "error");
    }
  }
  function markPhones(body: OutreachMarkBody, message: string) {
    mark.mutate(body, { onSuccess: () => toast.push(message, "success") });
  }
  function messageFor(contact: OutreachContact) {
    return buildMessage(contact, settings, overrides[contact.phone] ?? "auto");
  }
  function onWhatsApp(contact: OutreachContact) {
    if (!autoMark) return;
    const message = messageFor(contact);
    markPhones(
      { phones: [contact.phone], contacted: true, template_key: message.templateKey },
      `${contact.phone} marked sent`,
    );
  }
  function sendNext() {
    if (!next) {
      toast.push("No new numbers in this view.", "info");
      return;
    }
    const message = messageFor(next);
    window.open(waLink(next.phone, message.text), "_blank", "noopener,noreferrer");
    markPhones(
      { phones: [next.phone], contacted: true, template_key: message.templateKey },
      `Sent to ${next.phone} marked`,
    );
  }
  function exportCsv() {
    downloadBlob(
      new Blob([outreachCsv(sorted)], { type: "text/csv;charset=utf-8" }),
      `kaata-outreach-${reportingDay(Date.now())}.csv`,
    );
    toast.push(`Exported ${fmtInt(sorted.length)} rows`, "success");
  }
  // The selection survives a failed bulk mark so a retry needs no re-ticking;
  // it clears once the server has answered.
  function bulk(body: Omit<OutreachMarkBody, "phones">, label: string) {
    if (!selectedPhones.length) return;
    const message = `${label} · ${fmtInt(selectedPhones.length)} numbers`;
    mark.mutate(
      { ...body, phones: selectedPhones },
      {
        onSuccess: () => {
          toast.push(message, "success");
          setSelected({});
        },
      },
    );
  }
  const rowProps = {
    now,
    settings,
    expanded,
    selected,
    overrides,
    saving: mark.isPending,
    onToggle: (phone: string) => setExpanded((value) => ({ ...value, [phone]: !value[phone] })),
    onSelect: (phone: string, on: boolean) => setSelected((value) => ({ ...value, [phone]: on })),
    onOverride: (phone: string, value: LanguageOverride) =>
      setOverrides((current) => ({ ...current, [phone]: value })),
    onStatus: (contact: OutreachContact, status: OutreachStatus) =>
      markPhones({ phones: [contact.phone], status }, `${contact.phone}: ${STATUS_LABELS[status]}`),
    onSent: (contact: OutreachContact, on: boolean) => {
      if (on) {
        const message = messageFor(contact);
        markPhones(
          { phones: [contact.phone], contacted: true, template_key: message.templateKey },
          `${contact.phone} marked sent`,
        );
      } else
        markPhones({ phones: [contact.phone], status: "new" }, `${contact.phone} reset to New`);
    },
    onReplied: (contact: OutreachContact) =>
      markPhones({ phones: [contact.phone], replied: true }, `${contact.phone} marked replied`),
    onNote: (contact: OutreachContact, note: string) =>
      markPhones({ phones: [contact.phone], note }, "Note saved"),
    onWhatsApp,
    onCopyMessage: (contact: OutreachContact) =>
      void copyText(messageFor(contact).text, "Message copied"),
    onCopyPhone: (contact: OutreachContact) => void copyText(contact.phone, "Copied"),
    messageFor,
  };

  return (
    <div className="min-w-0 w-full max-w-full">
      <PageHeader
        title="Outreach"
        description="Every number the server knows, what it knows about it, and where the conversation stands."
      />
      {outreach.isPending ? (
        <SkeletonCard lines={10} />
      ) : outreach.isError ? (
        <ErrorCard message="Couldn't load outreach." onRetry={() => void outreach.refetch()} />
      ) : data === null ? (
        <Card>
          <p className="text-sm text-[#525252]">
            Backend update pending — the Outreach endpoints are not deployed yet.
          </p>
        </Card>
      ) : (
        <>
          <div className="mb-3 grid min-w-0 grid-cols-2 gap-2 sm:gap-3 md:grid-cols-4">
            <SummaryCard
              label="All numbers"
              value={cards.all}
              sub={`${fmtInt(data.counts.both)} are both`}
              onClick={() => applyPreset("all")}
              icon="people"
            />
            <SummaryCard
              label="Shopkeepers"
              value={cards.shopkeepers}
              sub="From installs and accounts"
              onClick={() => applyPreset("shopkeepers")}
              icon="shop"
            />
            <SummaryCard
              label="Customers"
              value={cards.customers}
              sub="From synced books"
              onClick={() => applyPreset("customers")}
              icon="book"
            />
            <SummaryCard
              label="Wholesalers"
              value={cards.wholesalers}
              sub="In 2+ books or a supplier"
              onClick={() => applyPreset("wholesalers")}
              icon="truck"
            />
            <SummaryCard
              label="To contact"
              value={cards.to_contact}
              sub="Status New"
              onClick={() => applyPreset("to_contact")}
              icon="send"
            />
            <SummaryCard
              label="Follow-ups due"
              value={cards.follow_ups}
              sub="Sent 48 h+ ago, no reply"
              onClick={() => applyPreset("follow_ups")}
              icon="clock"
            />
            <SummaryCard
              label="Replied"
              value={cards.replied}
              sub="Status Replied"
              onClick={() => applyPreset("replied")}
              icon="reply"
            />
            <SummaryCard
              label="Installed after contact"
              value={cards.converted}
              sub="Install seen after a send"
              onClick={() => applyView(CONVERTED_FILTERS)}
              icon="check"
            />
          </div>
          <div
            className="mb-5 flex min-w-0 flex-wrap items-center justify-between gap-x-4 gap-y-1 px-1 text-xs text-[#737373]"
            aria-label="Pipeline"
          >
            <p className="min-w-0 tabular-nums [overflow-wrap:anywhere]">
              {[
                ["New", cards.to_contact],
                ["Sent", cards.sent],
                ["Replied", cards.replied],
                ["Interested", cards.interested],
                ["Installed", cards.installed],
              ].map(([label, value], index) => (
                <Fragment key={label}>
                  {index > 0 ? <span className="mx-1.5 text-[#d4d4d4]">→</span> : null}
                  <span className="font-medium text-[#404040]">{label}</span>{" "}
                  {fmtInt(Number(value))}
                </Fragment>
              ))}
              <span className="mx-1.5 text-[#d4d4d4]">·</span>
              Declined {fmtInt(cards.declined)}
            </p>
            <p className="tabular-nums" role="status">
              Today: {fmtInt(data.counts.sent_today)} sent · {fmtInt(data.counts.replied_today)}{" "}
              replied
            </p>
          </div>
          <section
            className="min-w-0 w-full max-w-full rounded-xl border border-[#e5e5e5] bg-white shadow-sm"
            aria-label="Outreach directory"
          >
            <div className="border-b border-[#f5f5f5] px-4 pt-5 sm:px-6">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <h2 className="text-base font-semibold text-[#171717]">Numbers</h2>
                  <p className="mt-1 text-xs leading-5 text-[#737373]">
                    One row per phone number. Expand a row for everything the database knows.
                  </p>
                </div>
                <span className="rounded-full bg-[#f5f5f5] px-3 py-1 text-xs font-medium tabular-nums text-[#737373]">
                  {fmtInt(contacts.length)} total rows
                </span>
              </div>
              <div
                className="mt-4 grid min-w-0 grid-cols-2 gap-1 sm:flex sm:flex-wrap"
                aria-label="Quick views"
              >
                {OUTREACH_PRESETS.map((preset) => (
                  <button
                    key={preset.id}
                    onClick={() => applyPreset(preset.id)}
                    aria-pressed={selectedPreset === preset.id}
                    title={preset.description}
                    className={`min-h-11 min-w-0 border-b-2 px-2 py-2 text-sm font-medium transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#171717] sm:px-3 ${selectedPreset === preset.id ? "border-[#171717] text-[#171717]" : "border-transparent text-[#737373] hover:text-[#404040]"}`}
                  >
                    {preset.label}
                  </button>
                ))}
              </div>
            </div>
            <div className="min-w-0 space-y-3 px-3 py-4 sm:space-y-4 sm:px-6 sm:py-5">
              <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] gap-2 sm:gap-3">
                <div className="relative min-w-0">
                  <span className="pointer-events-none absolute left-3 top-3 text-[#a3a3a3]">
                    <Icon name="search" />
                  </span>
                  <input
                    aria-label="Search by name, shop, owner, person, email or phone"
                    type="search"
                    value={search}
                    onChange={(event) => {
                      setSearch(event.target.value);
                      setPage(0);
                    }}
                    placeholder="Search numbers…"
                    className={`${FIELD} pl-10`}
                  />
                </div>
                <button
                  className={BUTTON}
                  aria-expanded={showFilters}
                  aria-controls="outreach-filters"
                  onClick={() => setShowFilters((show) => !show)}
                >
                  <Icon name="filter" />
                  Filters
                  {activeFilters.length > 0 ? (
                    <span className="rounded bg-[#f5f5f5] px-1.5 text-xs text-[#171717]">
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
                <p className="text-xs leading-5 text-[#737373]">
                  {OUTREACH_PRESETS.find((preset) => preset.id === selectedPreset)?.description}
                </p>
              ) : null}
              {showFilters ? (
                <div
                  id="outreach-filters"
                  className="min-w-0 max-w-full rounded-xl border border-[#e5e5e5] bg-[#fafafa] p-3 sm:p-4"
                >
                  <div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                    {SELECTS.slice(0, 2).map((field) => (
                      <FilterSelect
                        key={field.key}
                        label={field.label}
                        value={filters[field.key]}
                        options={field.options}
                        onChange={(value) => updateFilters({ [field.key]: value })}
                      />
                    ))}
                    <FilterSelect
                      label="Country"
                      value={filters.country}
                      options={countryOptions}
                      onChange={(country) => updateFilters({ country })}
                    />
                    <FilterSelect
                      label={SELECTS[2].label}
                      value={filters.carrier}
                      options={SELECTS[2].options}
                      onChange={(value) =>
                        updateFilters({ carrier: value as OutreachFilters["carrier"] })
                      }
                    />
                    <FilterSelect
                      label="Platform"
                      value={filters.platform}
                      options={facetOptions("platform", filters.platform)}
                      onChange={(platform) => updateFilters({ platform })}
                    />
                    <FilterSelect
                      label="Language"
                      value={filters.language}
                      options={facetOptions("language", filters.language)}
                      onChange={(language) => updateFilters({ language })}
                    />
                    <FilterSelect
                      label="Acquisition source"
                      value={filters.source}
                      options={facetOptions("source", filters.source)}
                      onChange={(source) => updateFilters({ source })}
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
                    <NumberFilter
                      label="Min mentions (books)"
                      value={filters.minMentions}
                      onChange={(minMentions) => updateFilters({ minMentions })}
                    />
                    <NumberFilter
                      label="Min tallies"
                      value={filters.minTallies}
                      onChange={(minTallies) => updateFilters({ minTallies })}
                    />
                    <NumberFilter
                      label="Min receivable (shopkeeper)"
                      value={filters.minReceivable}
                      onChange={(minReceivable) => updateFilters({ minReceivable })}
                    />
                  </div>
                  <div className="mt-4 border-t border-[#e5e5e5] pt-4">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <h3 className="text-xs font-semibold text-[#525252]">Contacted date range</h3>
                      <button
                        onClick={() => updateFilters({ contactedFrom: "", contactedTo: "" })}
                        className="min-h-11 rounded-md px-2 py-1 text-xs text-[#737373] hover:bg-[#f5f5f5]"
                      >
                        Any date
                      </button>
                    </div>
                    <div className="mt-2 grid grid-cols-1 gap-3 sm:grid-cols-2">
                      <label className="min-w-0 text-xs font-medium text-[#737373]">
                        From
                        <input
                          type="date"
                          aria-label="Contacted from"
                          aria-invalid={invalidRange}
                          value={filters.contactedFrom}
                          max={reportingDay(now)}
                          onChange={(event) => updateFilters({ contactedFrom: event.target.value })}
                          className={`${FIELD} mt-1`}
                        />
                      </label>
                      <label className="min-w-0 text-xs font-medium text-[#737373]">
                        Through
                        <input
                          type="date"
                          aria-label="Contacted through"
                          aria-invalid={invalidRange}
                          value={filters.contactedTo}
                          max={reportingDay(now)}
                          onChange={(event) => updateFilters({ contactedTo: event.target.value })}
                          className={`${FIELD} mt-1`}
                        />
                      </label>
                    </div>
                    {invalidRange ? (
                      <p role="alert" className="mt-2 text-xs text-red-700">
                        The end date must be on or after the start date.
                      </p>
                    ) : (
                      <p className="mt-2 text-xs leading-5 text-[#737373]">
                        Both dates are included. Dates use Kabul time.
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
                      className="inline-flex min-h-11 min-w-0 max-w-full items-center gap-1.5 rounded-xl border border-[#e5e5e5] bg-[#f5f5f5] px-2.5 py-1 text-left text-xs text-[#171717] hover:bg-[#f5f5f5] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#171717] md:min-h-8"
                      aria-label={`Remove ${chip.label} filter`}
                      onClick={() =>
                        updateFilters({ [chip.key]: DEFAULT_OUTREACH_FILTERS[chip.key] })
                      }
                    >
                      <span className="min-w-0 [overflow-wrap:anywhere]">{chip.label}</span>
                      <Icon name="close" className="h-3 w-3" />
                    </button>
                  ))}
                  {search ? (
                    <button
                      className="inline-flex min-h-11 min-w-0 max-w-full items-center gap-1.5 rounded-xl border border-[#e5e5e5] px-2.5 py-1 text-xs text-[#525252] md:min-h-8"
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
                    className="min-h-11 px-1 py-1 text-xs font-medium text-[#737373] underline decoration-[#d4d4d4] underline-offset-4 hover:text-[#171717]"
                    onClick={reset}
                  >
                    Reset all
                  </button>
                </div>
              ) : null}
            </div>
            <div className="flex flex-wrap items-center justify-between gap-3 border-y border-[#f5f5f5] bg-[#fafafa] px-4 py-3 sm:px-6">
              <p className="min-w-0 text-xs leading-5 text-[#737373]" role="status">
                <strong className="font-semibold tabular-nums text-[#404040]">
                  {fmtInt(sorted.length)} matching numbers
                </strong>
                <span className="mx-1.5">·</span>
                {fmtInt(sorted.filter((c) => c.outreach.status === "new").length)} new
                <span className="mx-1.5">·</span>
                {fmtInt(sorted.filter((c) => c.follow_up_due).length)} follow-ups due
              </p>
              <label className="flex min-h-11 min-w-0 cursor-pointer items-center gap-2 text-xs text-[#525252]">
                <input
                  type="checkbox"
                  checked={autoMark}
                  disabled={setting.isPending}
                  onChange={(event) =>
                    setting.mutate({ key: AUTO_MARK_KEY, value: event.target.checked ? "" : "off" })
                  }
                  className={CHECKBOX}
                />
                Auto-mark sent when opening WhatsApp
              </label>
            </div>
            <div className="flex flex-wrap items-center gap-2 px-4 py-3 sm:px-6">
              <button
                className={PRIMARY}
                onClick={sendNext}
                disabled={!next || mark.isPending}
                title={
                  next
                    ? `Opens WhatsApp for ${next.phone} and marks it sent`
                    : "No New numbers in this view"
                }
              >
                <Icon name="send" className="text-white" />
                Send next{next ? ` · ${next.phone}` : ""}
              </button>
              <button className={BUTTON} onClick={exportCsv} disabled={!sorted.length}>
                Export CSV
              </button>
              <button
                className={BUTTON}
                disabled={!sorted.length}
                onClick={() =>
                  void copyText(
                    sorted.map((c) => c.phone).join("\n"),
                    `${fmtInt(sorted.length)} numbers copied`,
                  )
                }
              >
                Copy all visible numbers
              </button>
            </div>
            {selectedPhones.length > 0 ? (
              <div
                className="flex flex-wrap items-center gap-2 border-t border-[#f5f5f5] bg-[#fafafa] px-4 py-3 sm:px-6"
                role="region"
                aria-label="Bulk actions"
              >
                <span className="mr-1 text-xs font-medium tabular-nums text-[#404040]">
                  {fmtInt(selectedPhones.length)} selected
                </span>
                <button
                  className={SMALL_BUTTON}
                  disabled={mark.isPending}
                  onClick={() => bulk({ contacted: true }, "Marked sent")}
                >
                  Mark sent
                </button>
                <button
                  className={SMALL_BUTTON}
                  disabled={mark.isPending}
                  onClick={() => bulk({ replied: true }, "Marked replied")}
                >
                  Mark replied
                </button>
                {(
                  [
                    ["interested", "Interested"],
                    ["installed", "Installed"],
                    ["declined", "Declined"],
                    ["do_not_contact", "Do not contact"],
                    ["new", "Reset to new"],
                  ] as [OutreachStatus, string][]
                ).map(([status, label]) => (
                  <button
                    key={status}
                    className={SMALL_BUTTON}
                    disabled={mark.isPending}
                    onClick={() => bulk({ status }, label)}
                  >
                    {label}
                  </button>
                ))}
                <button className={SMALL_BUTTON} onClick={() => setSelected({})}>
                  Clear selection
                </button>
              </div>
            ) : null}
            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-[#f5f5f5] px-4 py-3 sm:px-6">
              <span className="text-xs text-[#737373]">
                {sorted.length
                  ? `${currentPage * pageSize + 1}–${Math.min((currentPage + 1) * pageSize, sorted.length)} of ${fmtInt(sorted.length)} visible rows`
                  : "No visible rows"}
              </span>
              <div className="flex min-w-0 max-w-full items-center gap-2">
                <label className="flex min-w-0 items-center gap-2 text-xs text-[#737373]">
                  Sort by
                  <select
                    value={sortKey}
                    onChange={(event) => sortBy(event.target.value as OutreachSortKey)}
                    className={SMALL_SELECT}
                  >
                    {OUTREACH_SORT_OPTIONS.map(([key, label]) => (
                      <option key={key} value={key}>
                        {label}
                      </option>
                    ))}
                  </select>
                </label>
                <button
                  className="flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-md p-1.5 text-[#737373] hover:bg-[#f5f5f5] focus-visible:outline-[#171717]"
                  aria-label={sortDesc ? "Sort ascending" : "Sort descending"}
                  title={sortDesc ? "Descending" : "Ascending"}
                  onClick={() => sortBy(sortKey)}
                >
                  <Icon name="sort" className={sortDesc ? "" : "rotate-180"} />
                </button>
              </div>
            </div>
            {pageRows.length ? (
              <>
                <ContactCards rows={pageRows} {...rowProps} />
                <ContactsTable
                  rows={pageRows}
                  sortKey={sortKey}
                  sortDesc={sortDesc}
                  onSort={sortBy}
                  onSelectAll={(on) =>
                    setSelected((value) => {
                      const next = { ...value };
                      for (const row of pageRows) next[row.phone] = on;
                      return next;
                    })
                  }
                  {...rowProps}
                />
              </>
            ) : (
              <div className="flex min-h-64 flex-col items-center justify-center px-6 py-10 text-center">
                <span className="mb-4 rounded-full bg-[#f2f5f7] p-4 text-[#a3a3a3]">
                  <Icon name="search" className="h-6 w-6" />
                </span>
                <h3 className="text-base font-semibold text-[#404040]">
                  {invalidRange
                    ? "Check your date range"
                    : contacts.length
                      ? "No numbers match these filters"
                      : "No numbers yet"}
                </h3>
                <p className="mt-2 max-w-md text-sm leading-6 text-[#737373]">
                  {invalidRange
                    ? "Choose an end date on or after the start date."
                    : contacts.length
                      ? "Try another quick view, remove a filter, or search with fewer words."
                      : "Numbers appear after devices check in with a phone or a signed-in kaata syncs."}
                </p>
                {contacts.length && (activeFilters.length > 0 || search) ? (
                  <button className={`${BUTTON} mt-5`} onClick={reset}>
                    Reset filters
                  </button>
                ) : null}
              </div>
            )}
            {sorted.length > 0 ? (
              <div className="flex flex-wrap items-center justify-between gap-3 border-t border-[#f5f5f5] px-4 py-4 sm:px-6">
                <label className="flex items-center gap-2 text-xs text-[#737373]">
                  Rows per page
                  <select
                    aria-label="Rows per page"
                    className="min-h-11 rounded-md border border-[#e5e5e5] bg-white px-2 py-1.5 text-base focus-visible:outline-[#171717] md:text-xs"
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
                  aria-label="Outreach directory pages"
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
                  <span className="text-xs tabular-nums text-[#737373]">
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
          <p className="mt-4 text-xs leading-5 text-[#737373]">
            Customer numbers exist only for kaatas synced while signed in. Follow-up due = sent 48 h
            ago with no reply. Last seen is a device check-in, not a ledger edit.
          </p>
          <div className="mt-6">
            <TemplatesCard
              settings={settings}
              preview={sorted[0]}
              previewOverride={sorted[0] ? (overrides[sorted[0].phone] ?? "auto") : "auto"}
              saving={setting.isPending}
              onSave={(key, value, message) =>
                setting.mutate({ key, value }, { onSuccess: () => toast.push(message, "success") })
              }
            />
          </div>
        </>
      )}
    </div>
  );
}

function filterChips(
  filters: OutreachFilters,
  baseline: OutreachFilters,
): { key: keyof OutreachFilters; label: string }[] {
  const chips: { key: keyof OutreachFilters; label: string }[] = [];
  for (const select of SELECTS) {
    if (filters[select.key] !== baseline[select.key])
      chips.push({
        key: select.key,
        label: `${select.label}: ${select.options.find(([value]) => value === filters[select.key])?.[1]}`,
      });
  }
  if (filters.country) {
    const country = dialCode(`${filters.country}0`).country;
    chips.push({ key: "country", label: `Country: ${country || filters.country}` });
  }
  for (const [key, label] of [
    ["platform", "Platform"],
    ["language", "Language"],
    ["source", "Source"],
  ] as const) {
    if (filters[key]) chips.push({ key, label: `${label}: ${humanValue(filters[key])}` });
  }
  if (filters.minMentions)
    chips.push({ key: "minMentions", label: `Mentions ≥ ${filters.minMentions}` });
  if (filters.minTallies)
    chips.push({ key: "minTallies", label: `Tallies ≥ ${filters.minTallies}` });
  if (filters.minReceivable)
    chips.push({ key: "minReceivable", label: `Receivable ≥ ${filters.minReceivable}` });
  if (filters.contactedFrom)
    chips.push({ key: "contactedFrom", label: `Contacted from ${fmtDay(filters.contactedFrom)}` });
  if (filters.contactedTo)
    chips.push({ key: "contactedTo", label: `Contacted through ${fmtDay(filters.contactedTo)}` });
  return chips;
}
function FilterSelect(props: {
  label: string;
  value: string;
  options: [string, string][];
  onChange: (value: string) => void;
}) {
  return (
    <label className="min-w-0 max-w-full text-xs font-medium text-[#737373]">
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
function NumberFilter(props: { label: string; value: number; onChange: (value: number) => void }) {
  return (
    <label className="min-w-0 max-w-full text-xs font-medium text-[#737373]">
      {props.label}
      <input
        type="number"
        min={0}
        step={1}
        inputMode="numeric"
        className={`${FIELD} mt-1`}
        value={props.value || ""}
        placeholder="Any"
        onChange={(event) => {
          const n = Math.floor(Number(event.target.value));
          props.onChange(Number.isFinite(n) && n > 0 ? n : 0);
        }}
      />
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
      className="group min-w-0 rounded-xl border border-[#e5e5e5] bg-white p-3 text-left transition hover:border-[#e5e5e5] hover:shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#171717] sm:p-5"
    >
      <div className="flex min-w-0 items-start justify-between gap-2">
        <span className="min-w-0 text-xs font-medium leading-5 text-[#737373]">{props.label}</span>
        <span className="hidden shrink-0 rounded-lg bg-[#f5f5f5] p-2 text-[#171717] sm:block">
          <Icon name={props.icon} />
        </span>
      </div>
      <div className="mt-2 text-2xl font-semibold tracking-tight tabular-nums text-[#171717] [overflow-wrap:anywhere] sm:text-3xl">
        {fmtInt(props.value)}
      </div>
      <p className="mt-1 text-[11px] leading-5 text-[#737373]">{props.sub}</p>
    </button>
  );
}
const PILL_TONE: Record<PillTone, string> = {
  green: "bg-[#e8f5ed] text-[#116b4f]",
  amber: "bg-[#fff4df] text-[#8c621a]",
  gray: "bg-[#f5f5f5] text-[#737373]",
  red: "bg-[#fdecec] text-[#a32d2d]",
  blue: "bg-[#e8f0fb] text-[#1f4f8f]",
};
function Pill(props: { children: ReactNode; tone?: PillTone }) {
  return (
    <span
      className={`inline-flex min-w-0 max-w-full items-center rounded-md px-2 py-0.5 text-[11px] font-medium [overflow-wrap:anywhere] ${PILL_TONE[props.tone ?? "gray"]}`}
    >
      {props.children}
    </span>
  );
}

type RowProps = {
  rows: OutreachContact[];
  now: number;
  settings: Record<string, string>;
  expanded: Record<string, boolean>;
  selected: Record<string, boolean>;
  overrides: Record<string, LanguageOverride>;
  saving: boolean;
  onToggle: (phone: string) => void;
  onSelect: (phone: string, on: boolean) => void;
  onOverride: (phone: string, value: LanguageOverride) => void;
  onStatus: (contact: OutreachContact, status: OutreachStatus) => void;
  onSent: (contact: OutreachContact, on: boolean) => void;
  onReplied: (contact: OutreachContact) => void;
  onNote: (contact: OutreachContact, note: string) => void;
  onWhatsApp: (contact: OutreachContact) => void;
  onCopyMessage: (contact: OutreachContact) => void;
  onCopyPhone: (contact: OutreachContact) => void;
  messageFor: (contact: OutreachContact) => ReturnType<typeof buildMessage>;
};

function secondLine(contact: OutreachContact): string {
  if (contact.kind === "customer") {
    const owners = ownerNames(contact.customer);
    const books = contact.customer?.mention_count ?? 0;
    return `in ${books} book${books === 1 ? "" : "s"}${owners.length ? ` · ${owners.join(", ")}` : ""}`;
  }
  return contact.shop_name && contact.shop_name !== contactDisplayName(contact)
    ? contact.shop_name
    : contact.kind === "both"
      ? `also in ${contact.customer?.mention_count ?? 0} book${contact.customer?.mention_count === 1 ? "" : "s"}`
      : "";
}
function PhoneButton(props: { contact: OutreachContact; onCopy: () => void; className?: string }) {
  const { code, country } = dialCode(props.contact.phone);
  const carrier = afghanCarrier(props.contact.phone);
  return (
    <div className={`min-w-0 ${props.className ?? ""}`}>
      <button
        dir="ltr"
        className="max-w-full truncate rounded font-mono text-sm tabular-nums text-[#171717] hover:underline focus-visible:outline-2 focus-visible:outline-[#171717]"
        title="Copy number"
        onClick={props.onCopy}
      >
        {props.contact.phone}
      </button>
      <p className="mt-0.5 truncate text-[11px] text-[#a3a3a3]">
        {country && country !== code ? country : code}
        {carrier ? ` · ${carrier}` : ""}
      </p>
    </div>
  );
}
function StatusSelect(props: {
  contact: OutreachContact;
  disabled: boolean;
  onChange: (status: OutreachStatus) => void;
}) {
  return (
    <select
      aria-label={`Status of ${props.contact.phone}`}
      value={props.contact.outreach.status}
      disabled={props.disabled}
      onChange={(event) => {
        if (isOutreachStatus(event.target.value)) props.onChange(event.target.value);
      }}
      className={SMALL_SELECT}
    >
      {OUTREACH_STATUSES.map((status) => (
        <option key={status} value={status}>
          {STATUS_LABELS[status]}
        </option>
      ))}
    </select>
  );
}
function SentControl(props: {
  contact: OutreachContact;
  disabled: boolean;
  onChange: (on: boolean) => void;
}) {
  const o = props.contact.outreach;
  return (
    <label
      className="flex min-h-11 min-w-0 cursor-pointer items-center gap-2 text-xs text-[#525252] md:min-h-8"
      title="Ticked = a message was sent. Unticking resets the status to New; the send count is kept."
    >
      <input
        type="checkbox"
        className={CHECKBOX}
        checked={o.contact_count > 0 && o.status !== "new"}
        disabled={props.disabled}
        onChange={(event) => props.onChange(event.target.checked)}
      />
      <span className="min-w-0 whitespace-nowrap tabular-nums">
        {o.contact_count > 0 ? `×${o.contact_count} · ${fmtDate(o.contacted_at)}` : "Sent"}
      </span>
    </label>
  );
}
function RepliedControl(props: {
  contact: OutreachContact;
  disabled: boolean;
  onChange: () => void;
}) {
  const o = props.contact.outreach;
  const replied = !!o.replied_at;
  return (
    <label
      className="flex min-h-11 min-w-0 cursor-pointer items-center gap-2 text-xs text-[#525252] md:min-h-8"
      title={replied ? `Replied ${fmtDateTime(o.replied_at)}` : "Tick when they answer"}
    >
      <input
        type="checkbox"
        className={CHECKBOX}
        checked={replied}
        disabled={props.disabled || replied}
        onChange={() => props.onChange()}
      />
      <span className="min-w-0 whitespace-nowrap tabular-nums">
        {replied ? fmtDate(o.replied_at) : "Replied"}
      </span>
    </label>
  );
}
function RowActions(props: {
  contact: OutreachContact;
  message: string;
  onWhatsApp: () => void;
  onCopy: () => void;
}) {
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2">
      <a
        className={WA_BUTTON}
        href={waLink(props.contact.phone, props.message)}
        target="_blank"
        rel="noopener noreferrer"
        onClick={props.onWhatsApp}
      >
        <Icon name="whatsapp" className="h-4 w-4" />
        WhatsApp
      </a>
      <button className={SMALL_BUTTON} onClick={props.onCopy}>
        Copy message
      </button>
    </div>
  );
}
function Signal(props: { contact: OutreachContact; now: number }) {
  const { contact } = props;
  const lines: ReactNode[] = [];
  if (contact.shopkeeper) {
    const seenValid =
      Number.isFinite(Date.parse(contact.shopkeeper.last_seen)) &&
      Date.parse(contact.shopkeeper.last_seen) <= props.now;
    const seen = seenValid
      ? lastSeenInfo(contact.shopkeeper.last_seen)
      : { label: "Not seen", online: false };
    lines.push(
      <span key="seen" className="flex items-center gap-1.5 whitespace-nowrap">
        {seen.online ? <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" /> : null}
        Seen {seen.label}
      </span>,
      <span key="tallies" className="whitespace-nowrap tabular-nums text-[#737373]">
        {fmtInt(contact.shopkeeper.tallies)} tallies · {fmtInt(contact.shopkeeper.people)} people
      </span>,
    );
  }
  if (contact.customer) {
    for (const b of balanceSummary(contact.customer)) {
      const parts: string[] = [];
      if (b.owes) parts.push(`owes ${formatMoney(b.owes, true)} ${b.currency}`);
      if (b.owed) parts.push(`owed ${formatMoney(b.owed, true)} ${b.currency}`);
      if (!parts.length) parts.push(`settled · ${b.currency}`);
      lines.push(
        <span key={`bal-${b.currency}`} className="whitespace-nowrap tabular-nums">
          {parts.join(" · ")}
        </span>,
      );
    }
    lines.push(
      <span key="ctallies" className="whitespace-nowrap tabular-nums text-[#737373]">
        {fmtInt(contact.customer.tallies_total)} tallies · {fmtInt(contact.customer.mention_count)}{" "}
        book{contact.customer.mention_count === 1 ? "" : "s"}
      </span>,
    );
  }
  const lastTally = lastTallyAt(contact);
  if (lastTally)
    lines.push(
      <span key="last-tally" className="whitespace-nowrap text-[#a3a3a3]">
        Last tally {fmtDate(lastTally)}
      </span>,
    );
  return <div className="flex min-w-0 flex-col gap-0.5 text-xs text-[#525252]">{lines}</div>;
}

// Phones get their own reading layout; the wide table appears from md up.
function ContactCards(props: RowProps) {
  return (
    <div className="grid min-w-0 w-full max-w-full gap-3 border-t border-[#f5f5f5] bg-[#fafafa] p-3 md:hidden">
      {props.rows.map((contact) => {
        const open = !!props.expanded[contact.phone];
        const detailsId = `outreach-card-${contact.phone.replace(/\D/g, "")}`;
        const message = props.messageFor(contact);
        const line2 = secondLine(contact);
        return (
          <article
            key={contact.phone}
            className="min-w-0 max-w-full rounded-xl border border-[#e5e5e5] bg-white p-4"
            aria-label={contactDisplayName(contact)}
          >
            <div className="flex min-w-0 items-start gap-3">
              <input
                type="checkbox"
                aria-label={`Select ${contact.phone}`}
                className={`${CHECKBOX} mt-3`}
                checked={!!props.selected[contact.phone]}
                onChange={(event) => props.onSelect(contact.phone, event.target.checked)}
              />
              <span
                aria-hidden="true"
                className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[#f5f5f5] text-xs font-semibold text-[#171717]"
              >
                {contactInitials(contact)}
              </span>
              <div className="min-w-0 flex-1">
                <button
                  className="max-w-full text-left text-sm font-semibold leading-6 text-[#171717] [overflow-wrap:anywhere] focus-visible:outline-2 focus-visible:outline-[#171717]"
                  dir="auto"
                  aria-expanded={open}
                  aria-controls={detailsId}
                  onClick={() => props.onToggle(contact.phone)}
                >
                  {contactDisplayName(contact)}
                </button>
                {line2 ? (
                  <p
                    className="mt-0.5 text-xs leading-5 text-[#737373] [overflow-wrap:anywhere]"
                    dir="auto"
                  >
                    {line2}
                  </p>
                ) : null}
                <PhoneButton
                  contact={contact}
                  onCopy={() => props.onCopyPhone(contact)}
                  className="mt-1"
                />
              </div>
            </div>
            <div className="mt-3 flex min-w-0 flex-wrap items-center gap-2">
              {contactPills(contact).map((pill) => (
                <Pill key={pill.label} tone={pill.tone}>
                  {pill.label}
                </Pill>
              ))}
            </div>
            <div className="mt-3 border-y border-[#f5f5f5] py-3">
              <Signal contact={contact} now={props.now} />
            </div>
            <div className="mt-3 grid min-w-0 grid-cols-2 gap-x-3 gap-y-2">
              <div className="col-span-2 min-w-0">
                <StatusSelect
                  contact={contact}
                  disabled={props.saving}
                  onChange={(status) => props.onStatus(contact, status)}
                />
              </div>
              <SentControl
                contact={contact}
                disabled={props.saving}
                onChange={(on) => props.onSent(contact, on)}
              />
              <RepliedControl
                contact={contact}
                disabled={props.saving}
                onChange={() => props.onReplied(contact)}
              />
            </div>
            <div className="mt-3">
              <RowActions
                contact={contact}
                message={message.text}
                onWhatsApp={() => props.onWhatsApp(contact)}
                onCopy={() => props.onCopyMessage(contact)}
              />
            </div>
            <button
              className="mt-2 flex min-h-11 min-w-0 w-full items-center justify-between gap-3 rounded-lg px-1 text-sm font-medium text-[#171717] focus-visible:outline-2 focus-visible:outline-[#171717]"
              aria-expanded={open}
              aria-controls={detailsId}
              aria-label={`${open ? "Hide" : "Show"} details for ${contactDisplayName(contact)}`}
              onClick={() => props.onToggle(contact.phone)}
            >
              {open ? "Hide details" : "View details"}
              <Icon name="chevron" className={open ? "rotate-180" : ""} />
            </button>
            {open ? (
              <div className="mt-2 min-w-0 border-t border-[#e5e5e5] pt-4">
                <ContactDetails contact={contact} id={detailsId} {...props} />
              </div>
            ) : null}
          </article>
        );
      })}
    </div>
  );
}

const HEADERS: { label: string; key?: OutreachSortKey; className?: string }[] = [
  { label: "Select" },
  { label: "Person", key: "name", className: "min-w-[240px]" },
  { label: "Phone", key: "phone" },
  { label: "Signal", key: "last_seen" },
  { label: "Status" },
  { label: "Sent", key: "contacted" },
  { label: "Replied", key: "replied" },
  { label: "Actions" },
  { label: "Details" },
];
function ContactsTable(
  props: RowProps & {
    sortKey: OutreachSortKey;
    sortDesc: boolean;
    onSort: (key: OutreachSortKey) => void;
    onSelectAll: (on: boolean) => void;
  },
) {
  const allSelected = props.rows.every((row) => props.selected[row.phone]);
  // Contain absolutely positioned sr-only labels inside the local scroll area.
  return (
    <div
      className="relative hidden min-w-0 w-full max-w-full overflow-x-auto overscroll-x-contain focus-visible:outline-2 focus-visible:outline-[#171717] md:block"
      role="region"
      aria-label="Scrollable outreach table"
      tabIndex={0}
    >
      <table className="w-full min-w-[1180px] border-collapse text-left" aria-label="Numbers">
        <thead>
          <tr className="border-y border-[#f5f5f5] bg-[#fafafa]">
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
                className={`px-3 py-3 text-xs font-medium text-[#737373] ${column.className ?? ""}`}
              >
                {column.label === "Select" ? (
                  <input
                    type="checkbox"
                    aria-label="Select all rows on this page"
                    className={CHECKBOX}
                    checked={allSelected}
                    onChange={(event) => props.onSelectAll(event.target.checked)}
                  />
                ) : column.key ? (
                  <button
                    className="inline-flex items-center gap-1 rounded focus-visible:outline-2 focus-visible:outline-[#171717]"
                    onClick={() => props.onSort(column.key!)}
                  >
                    {column.label}
                    <span
                      className={column.key === props.sortKey ? "text-[#171717]" : "text-[#d4d4d4]"}
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
          {props.rows.map((contact) => {
            const open = !!props.expanded[contact.phone];
            const detailsId = `outreach-details-${contact.phone.replace(/\D/g, "")}`;
            const message = props.messageFor(contact);
            const line2 = secondLine(contact);
            return (
              <Fragment key={contact.phone}>
                <tr
                  className={`border-b border-[#f5f5f5] transition ${open ? "bg-[#fafafa]" : "hover:bg-[#fafafa]"}`}
                >
                  <td className="px-3 py-4 align-top">
                    <input
                      type="checkbox"
                      aria-label={`Select ${contact.phone}`}
                      className={`${CHECKBOX} mt-3`}
                      checked={!!props.selected[contact.phone]}
                      onChange={(event) => props.onSelect(contact.phone, event.target.checked)}
                    />
                  </td>
                  <td className="px-3 py-4 align-top">
                    <div className="flex items-start gap-3">
                      <span
                        aria-hidden="true"
                        className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[#f5f5f5] text-xs font-semibold text-[#171717]"
                      >
                        {contactInitials(contact)}
                      </span>
                      <div className="min-w-0">
                        <button
                          className="max-w-[240px] truncate rounded text-left text-sm font-semibold text-[#171717] focus-visible:outline-2 focus-visible:outline-[#171717]"
                          dir="auto"
                          aria-expanded={open}
                          aria-controls={detailsId}
                          onClick={() => props.onToggle(contact.phone)}
                        >
                          {contactDisplayName(contact)}
                        </button>
                        {line2 ? (
                          <p className="max-w-[240px] truncate text-xs text-[#737373]" dir="auto">
                            {line2}
                          </p>
                        ) : null}
                        <div className="mt-1.5 flex max-w-[260px] flex-wrap gap-1">
                          {contactPills(contact).map((pill) => (
                            <Pill key={pill.label} tone={pill.tone}>
                              {pill.label}
                            </Pill>
                          ))}
                        </div>
                      </div>
                    </div>
                  </td>
                  <td className="px-3 py-4 align-top">
                    <PhoneButton contact={contact} onCopy={() => props.onCopyPhone(contact)} />
                  </td>
                  <td className="px-3 py-4 align-top">
                    <Signal contact={contact} now={props.now} />
                  </td>
                  <td className="px-3 py-4 align-top">
                    <StatusSelect
                      contact={contact}
                      disabled={props.saving}
                      onChange={(status) => props.onStatus(contact, status)}
                    />
                  </td>
                  <td className="px-3 py-4 align-top">
                    <SentControl
                      contact={contact}
                      disabled={props.saving}
                      onChange={(on) => props.onSent(contact, on)}
                    />
                  </td>
                  <td className="px-3 py-4 align-top">
                    <RepliedControl
                      contact={contact}
                      disabled={props.saving}
                      onChange={() => props.onReplied(contact)}
                    />
                  </td>
                  <td className="px-3 py-4 align-top">
                    <RowActions
                      contact={contact}
                      message={message.text}
                      onWhatsApp={() => props.onWhatsApp(contact)}
                      onCopy={() => props.onCopyMessage(contact)}
                    />
                  </td>
                  <td className="px-3 py-4 align-top">
                    <button
                      className="rounded-lg p-2 text-[#737373] hover:bg-[#f5f5f5] hover:text-[#171717] focus-visible:outline-2 focus-visible:outline-[#171717]"
                      aria-label={`${open ? "Hide" : "Show"} details for ${contactDisplayName(contact)}`}
                      aria-expanded={open}
                      aria-controls={detailsId}
                      onClick={() => props.onToggle(contact.phone)}
                    >
                      <Icon name="chevron" className={open ? "rotate-180" : ""} />
                    </button>
                  </td>
                </tr>
                {open ? (
                  <tr>
                    <td
                      colSpan={HEADERS.length}
                      className="border-b border-[#e5e5e5] bg-[#fafafa] px-5 py-5"
                    >
                      <ContactDetails contact={contact} id={detailsId} {...props} />
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

function ContactDetails(props: RowProps & { contact: OutreachContact; id: string }) {
  const { contact } = props;
  const [noteDraft, setNoteDraft] = useState<string | null>(null);
  const note = noteDraft ?? contact.outreach.note;
  const override = props.overrides[contact.phone] ?? "auto";
  const message = props.messageFor(contact);
  const o = contact.outreach;
  return (
    <div id={props.id} className="min-w-0 max-w-full space-y-5">
      <div className="flex min-w-0 flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 max-w-full">
          <h3 className="text-sm font-semibold text-[#404040] [overflow-wrap:anywhere]" dir="auto">
            {contactDisplayName(contact)}
          </h3>
          <p className="mt-1 text-xs leading-5 text-[#737373]" dir="ltr">
            {contact.phone} · {dialCode(contact.phone).country || "Unknown country"}
            {afghanCarrier(contact.phone) ? ` · ${afghanCarrier(contact.phone)}` : ""} ·{" "}
            {languageLabel(contact.locale)}
          </p>
        </div>
        <div className="flex min-w-0 max-w-full flex-wrap gap-2">
          {contactPills(contact).map((pill) => (
            <Pill key={pill.label} tone={pill.tone}>
              {pill.label}
            </Pill>
          ))}
        </div>
      </div>
      <div className="grid min-w-0 grid-cols-1 gap-5 lg:grid-cols-2">
        <ShopkeeperBlock contact={contact} shopkeeper={contact.shopkeeper} />
        <CustomerBlock customer={contact.customer} />
      </div>
      <div className="min-w-0 rounded-xl border border-[#e5e5e5] bg-white p-4">
        <h4 className="text-xs font-semibold text-[#525252]">Outreach</h4>
        <div className="mt-3 grid min-w-0 grid-cols-1 gap-3 text-xs sm:grid-cols-2 lg:grid-cols-4">
          <Detail label="Status" value={STATUS_LABELS[o.status]} />
          <Detail
            label="Sent"
            value={
              o.contact_count
                ? `×${o.contact_count} · first ${fmtDateTime(o.first_contacted_at)} · last ${fmtDateTime(o.contacted_at)}`
                : "Not yet"
            }
          />
          <Detail label="Replied" value={o.replied_at ? fmtDateTime(o.replied_at) : "No reply"} />
          <Detail
            label="Flags"
            value={
              [
                contact.converted ? "Installed after contact" : "",
                contact.follow_up_due ? "Follow-up due" : "",
              ]
                .filter(Boolean)
                .join(" · ") || "—"
            }
          />
        </div>
        <div className="mt-4 grid min-w-0 grid-cols-1 gap-4 lg:grid-cols-2">
          <div className="min-w-0">
            <label className="text-[11px] font-medium text-[#737373]" htmlFor={`${props.id}-note`}>
              Note
            </label>
            <textarea
              id={`${props.id}-note`}
              dir="auto"
              rows={4}
              maxLength={2000}
              value={note}
              onChange={(event) => setNoteDraft(event.target.value)}
              placeholder="What they said, what to do next…"
              className={`${FIELD} mt-1 resize-y`}
            />
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <button
                className={SMALL_BUTTON}
                disabled={props.saving || noteDraft === null || noteDraft === contact.outreach.note}
                onClick={() => {
                  props.onNote(contact, note);
                  setNoteDraft(null);
                }}
              >
                Save note
              </button>
              {noteDraft !== null && noteDraft !== contact.outreach.note ? (
                <button className={SMALL_BUTTON} onClick={() => setNoteDraft(null)}>
                  Discard
                </button>
              ) : null}
            </div>
            <label className="mt-4 flex min-w-0 flex-col text-[11px] font-medium text-[#737373]">
              Message language
              <select
                className={`${SMALL_SELECT} mt-1 w-full`}
                value={override}
                onChange={(event) =>
                  props.onOverride(contact.phone, event.target.value as LanguageOverride)
                }
              >
                <option value="auto">
                  Auto ({message.language === "fa" ? "Dari" : "English"})
                </option>
                <option value="en">English</option>
                <option value="fa">Dari</option>
              </select>
            </label>
          </div>
          <div className="min-w-0">
            <p className="text-[11px] font-medium text-[#737373]">
              Message preview · {message.templateKey}
            </p>
            <pre
              dir="auto"
              className="mt-1 max-h-64 min-w-0 overflow-auto whitespace-pre-wrap rounded-lg border border-[#e5e5e5] bg-[#fafafa] p-3 font-sans text-xs leading-5 text-[#404040] [overflow-wrap:anywhere]"
            >
              {message.text}
            </pre>
            <div className="mt-2">
              <RowActions
                contact={contact}
                message={message.text}
                onWhatsApp={() => props.onWhatsApp(contact)}
                onCopy={() => props.onCopyMessage(contact)}
              />
            </div>
          </div>
        </div>
        <div className="mt-4 border-t border-[#f5f5f5] pt-3">
          <h5 className="text-[11px] font-medium text-[#737373]">Timeline</h5>
          {o.touches.length === 0 ? (
            <p className="mt-1 text-xs text-[#737373]">Nothing yet.</p>
          ) : (
            <ol className="mt-1 space-y-1">
              {o.touches.map((touch, index) => (
                <li
                  key={`${touch.at}-${index}`}
                  className="flex min-w-0 flex-wrap gap-x-2 text-xs text-[#525252]"
                >
                  <span className="whitespace-nowrap tabular-nums text-[#a3a3a3]">
                    {fmtDateTime(touch.at)}
                  </span>
                  <span className="font-medium text-[#404040]">
                    {touch.kind === "sent"
                      ? "Sent"
                      : touch.kind === "replied"
                        ? "Replied"
                        : touch.kind === "status"
                          ? "Status"
                          : "Note"}
                  </span>
                  {touch.detail ? (
                    <span className="min-w-0 [overflow-wrap:anywhere]" dir="auto">
                      {touch.kind === "status" && isOutreachStatus(touch.detail)
                        ? STATUS_LABELS[touch.detail]
                        : touch.detail}
                    </span>
                  ) : null}
                </li>
              ))}
            </ol>
          )}
        </div>
      </div>
    </div>
  );
}
function ShopkeeperBlock(props: {
  contact: OutreachContact;
  shopkeeper: OutreachShopkeeper | null;
}) {
  const s = props.shopkeeper;
  return (
    <div className="min-w-0 rounded-xl border border-[#e5e5e5] bg-white p-4">
      <h4 className="text-xs font-semibold text-[#525252]">Shopkeeper</h4>
      {!s ? (
        <p className="mt-2 text-xs leading-5 text-[#737373]">
          No install or account with this number.
        </p>
      ) : (
        <>
          <dl className="mt-3 grid min-w-0 grid-cols-1 gap-x-4 gap-y-3 sm:grid-cols-2">
            <DetailItem label="Shop" value={props.contact.shop_name} />
            <DetailItem label="Email" value={s.email} />
            <DetailItem label="Signed in" value={s.signed_in ? "Yes" : "No"} />
            <DetailItem label="Account ID" value={s.account_id} mono />
            <DetailItem label="Installs" value={fmtInt(s.install_count)} />
            <DetailItem
              label="Device"
              value={`${platformLabel(s.platform)}${s.app_version ? ` · v${s.app_version}` : ""}`}
            />
            <DetailItem label="Language" value={languageLabel(s.locale)} />
            <DetailItem label="Source" value={s.source} />
            <DetailItem label="Attribution" value={s.attribution} />
            <DetailItem label="Installed" value={fmtDate(s.installed_at)} />
            <DetailItem label="First seen" value={fmtDate(s.first_seen)} />
            <DetailItem label="Last seen" value={fmtDateTime(s.last_seen)} />
            <DetailItem label="Last activity" value={fmtDateTime(s.last_activity_at)} />
            <DetailItem label="Onboarded" value={s.has_onboarded ? "Completed" : "Not completed"} />
            <DetailItem label="Check-ins" value={fmtInt(s.check_in_count)} />
            <DetailItem
              label="Device-reported usage"
              value={`${fmtInt(s.usage_entries)} entries · ${fmtInt(s.usage_customers)} customers · ${fmtInt(s.usage_shares)} shares`}
            />
            <DetailItem label="People (synced)" value={fmtInt(s.people)} />
            <DetailItem label="Tallies (synced)" value={fmtInt(s.tallies)} />
            <DetailItem
              label="Receivable"
              value={`${formatMoney(parseMoney(s.receivable_total), true)} ${s.currency}`}
            />
            <DetailItem
              label="Payable"
              value={`${formatMoney(parseMoney(s.payable_total), true)} ${s.currency}`}
            />
            <DetailItem label="Last tally" value={fmtDateTime(s.last_tally_at)} />
          </dl>
          <div className="mt-4">
            <h5 className="text-xs font-semibold text-[#525252]">
              Kaatas{" "}
              <span className="ml-1 font-normal tabular-nums text-[#737373]">
                {s.kaatas.length}
              </span>
            </h5>
            {s.kaatas.length === 0 ? (
              <p className="mt-2 text-xs leading-5 text-[#737373]">No synced kaatas.</p>
            ) : (
              <div className="mt-2 grid min-w-0 grid-cols-1 gap-2">
                {s.kaatas.map((kaata) => (
                  <div
                    key={kaata.vault_id}
                    className="min-w-0 max-w-full rounded-lg border border-[#e5e5e5] bg-[#fafafa] p-3"
                  >
                    <div className="flex min-w-0 flex-wrap items-center gap-2">
                      <span
                        className="min-w-0 max-w-full text-sm font-medium text-[#404040] [overflow-wrap:anywhere]"
                        dir="auto"
                      >
                        {kaata.name}
                      </span>
                      <span className="rounded bg-white px-1.5 py-0.5 text-[10px] font-semibold uppercase text-[#171717]">
                        {kaata.role}
                      </span>
                      <span className="rounded bg-white px-1.5 py-0.5 text-[10px] font-medium text-[#525252]">
                        {kaata.currency}
                      </span>
                      {kaata.archived ? <Pill tone="amber">Archived</Pill> : null}
                    </div>
                    <p className="mt-2 text-xs leading-5 tabular-nums text-[#737373]">
                      {fmtInt(kaata.people)} people · {fmtInt(kaata.tallies)} tallies ·{" "}
                      {kaata.member_count} member{kaata.member_count === 1 ? "" : "s"}
                    </p>
                    <p className="text-xs leading-5 tabular-nums text-[#737373]">
                      Receivable {formatMoney(parseMoney(kaata.receivable), true)} · Payable{" "}
                      {formatMoney(parseMoney(kaata.payable), true)} · Last tally{" "}
                      {fmtDate(kaata.last_tally_at)}
                    </p>
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
function CustomerBlock(props: { customer: OutreachCustomer | null }) {
  const c = props.customer;
  return (
    <div className="min-w-0 rounded-xl border border-[#e5e5e5] bg-white p-4">
      <h4 className="text-xs font-semibold text-[#525252]">Customer</h4>
      {!c ? (
        <p className="mt-2 text-xs leading-5 text-[#737373]">Not listed in any synced book.</p>
      ) : (
        <>
          <dl className="mt-3 grid min-w-0 grid-cols-1 gap-x-4 gap-y-3 sm:grid-cols-2">
            <DetailItem label="Books" value={fmtInt(c.mention_count)} />
            <DetailItem label="Tallies" value={fmtInt(c.tallies_total)} />
            <DetailItem label="First added" value={fmtDate(c.first_added_at)} />
            <DetailItem label="Last tally" value={fmtDateTime(c.last_tally_at)} />
            <DetailItem
              label="Side"
              value={
                [c.is_customer_anywhere ? "Customer" : "", c.is_supplier_anywhere ? "Supplier" : ""]
                  .filter(Boolean)
                  .join(" and ") || "Settled"
              }
            />
            <DetailItem
              label="Flags"
              value={
                [
                  c.is_wholesaler ? "Wholesaler" : "",
                  c.archived_everywhere ? "Archived everywhere" : "",
                ]
                  .filter(Boolean)
                  .join(" · ") || "—"
              }
            />
          </dl>
          <div className="mt-4">
            <h5 className="text-xs font-semibold text-[#525252]">
              Listings{" "}
              <span className="ml-1 font-normal tabular-nums text-[#737373]">
                {c.listings.length}
              </span>
            </h5>
            <div className="mt-2 grid min-w-0 grid-cols-1 gap-2">
              {c.listings.map((listing) => {
                const balance = parseMoney(listing.balance);
                return (
                  <div
                    key={`${listing.vault_id}-${listing.person_name}`}
                    className="min-w-0 max-w-full rounded-lg border border-[#e5e5e5] bg-[#fafafa] p-3"
                  >
                    <div className="flex min-w-0 flex-wrap items-center gap-2">
                      <span
                        className="min-w-0 max-w-full text-sm font-medium text-[#404040] [overflow-wrap:anywhere]"
                        dir="auto"
                      >
                        {listing.vault_name}
                      </span>
                      <Pill
                        tone={
                          listing.role === "customer"
                            ? "green"
                            : listing.role === "supplier"
                              ? "amber"
                              : "gray"
                        }
                      >
                        {listing.role === "customer"
                          ? "Owes the shop"
                          : listing.role === "supplier"
                            ? "Shop owes them"
                            : "Settled"}
                      </Pill>
                      {listing.archived ? <Pill tone="amber">Archived</Pill> : null}
                      {listing.linked ? <Pill tone="blue">Shared account</Pill> : null}
                    </div>
                    {listing.linked ? (
                      <p className="mt-1 text-[11px] leading-4 text-[#737373]">
                        balance shows local tallies only
                      </p>
                    ) : null}
                    <p className="mt-1 text-xs leading-5 text-[#525252] [overflow-wrap:anywhere]">
                      <span dir="auto">Owner {listing.owner_name || "—"}</span>
                      {listing.owner_phone ? (
                        <>
                          {" · "}
                          <span dir="ltr" className="font-mono tabular-nums">
                            {listing.owner_phone}
                          </span>
                        </>
                      ) : null}
                    </p>
                    <p className="text-xs leading-5 text-[#525252] [overflow-wrap:anywhere]">
                      Saved as <span dir="auto">{listing.person_name || "—"}</span> ·{" "}
                      {listing.context}
                    </p>
                    <p className="text-xs leading-5 tabular-nums text-[#737373]">
                      Balance{" "}
                      <span
                        className={
                          balance > 0 ? "text-[#116b4f]" : balance < 0 ? "text-[#8c621a]" : ""
                        }
                      >
                        {formatMoney(balance, true)} {listing.currency}
                      </span>{" "}
                      · {fmtInt(listing.tallies)} tallies · added {fmtDate(listing.first_added_at)}{" "}
                      · last tally {fmtDate(listing.last_tally_at)}
                    </p>
                  </div>
                );
              })}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
function Detail(props: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <p className="text-[11px] font-medium text-[#737373]">{props.label}</p>
      <p className="mt-1 leading-5 text-[#404040] [overflow-wrap:anywhere]" dir="auto">
        {props.value || "—"}
      </p>
    </div>
  );
}
function DetailItem(props: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] font-medium text-[#737373]">{props.label}</dt>
      <dd
        className={`mt-1 text-xs leading-5 text-[#404040] [overflow-wrap:anywhere] ${props.mono ? "font-mono" : ""}`}
        dir={props.mono ? "ltr" : "auto"}
      >
        {props.value || "Not provided"}
      </dd>
    </div>
  );
}

// Four templates + two link slugs. Drafts live here until Save; the preview
// merges unsaved drafts so the operator sees what the next send would say.
function TemplatesCard(props: {
  settings: Record<string, string>;
  preview: OutreachContact | undefined;
  previewOverride: LanguageOverride;
  saving: boolean;
  onSave: (key: string, value: string, message: string) => void;
}) {
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const merged = { ...props.settings, ...drafts };
  const preview = props.preview ? buildMessage(props.preview, merged, props.previewOverride) : null;
  const audiences: [Audience, string][] = [
    ["shopkeeper", "Shopkeeper"],
    ["customer", "Customer"],
  ];
  return (
    <Card
      title="Message templates"
      sub="Placeholders: {name}, {shop}, {link}. The link always sits alone on its own line."
    >
      <div className="grid min-w-0 grid-cols-1 gap-5 lg:grid-cols-2">
        {audiences.map(([audience, label]) => {
          const sKey = slugKey(audience);
          const slug = drafts[sKey] ?? props.settings[sKey] ?? "";
          const effectiveSlug = sanitizeSlug(slug) || DEFAULT_SLUGS[audience];
          return (
            <div key={audience} className="min-w-0 space-y-4">
              <div className="min-w-0">
                <label className="text-xs font-medium text-[#525252]" htmlFor={`slug-${audience}`}>
                  {label} link slug
                </label>
                <div className="mt-1 flex min-w-0 flex-wrap gap-2">
                  <input
                    id={`slug-${audience}`}
                    value={slug}
                    placeholder={DEFAULT_SLUGS[audience]}
                    onChange={(event) =>
                      setDrafts((d) => ({ ...d, [sKey]: sanitizeSlug(event.target.value) }))
                    }
                    className={`${FIELD} sm:w-48 sm:flex-none`}
                    dir="ltr"
                  />
                  <button
                    className={BUTTON}
                    disabled={props.saving || drafts[sKey] === undefined}
                    onClick={() => {
                      props.onSave(sKey, drafts[sKey] ?? "", "Slug saved");
                      setDrafts(({ [sKey]: _drop, ...rest }) => rest);
                    }}
                  >
                    Save
                  </button>
                </div>
                <p className="mt-1 font-mono text-[11px] text-[#737373]" dir="ltr">
                  https://kaata.af/download?s={effectiveSlug}
                </p>
              </div>
              {(["en", "fa"] as const).map((language) => {
                const key = templateKey(audience, language);
                const value = drafts[key] ?? templateFor(props.settings, audience, language);
                const dirty = drafts[key] !== undefined;
                const customised = !!props.settings[key]?.trim();
                return (
                  <div key={key} className="min-w-0">
                    <label className="text-xs font-medium text-[#525252]" htmlFor={key}>
                      {label} · {language === "fa" ? "Dari" : "English"}
                      {customised ? (
                        <span className="ml-2 font-normal text-[#737373]">customised</span>
                      ) : (
                        <span className="ml-2 font-normal text-[#a3a3a3]">default</span>
                      )}
                    </label>
                    <textarea
                      id={key}
                      dir="auto"
                      rows={5}
                      maxLength={8000}
                      value={value}
                      onChange={(event) => setDrafts((d) => ({ ...d, [key]: event.target.value }))}
                      className={`${FIELD} mt-1 resize-y`}
                    />
                    <div className="mt-2 flex flex-wrap gap-2">
                      <button
                        className={BUTTON}
                        disabled={props.saving || !dirty}
                        onClick={() => {
                          props.onSave(key, drafts[key] ?? "", "Template saved");
                          setDrafts(({ [key]: _drop, ...rest }) => rest);
                        }}
                      >
                        Save
                      </button>
                      <button
                        className={BUTTON}
                        disabled={props.saving || (!customised && !dirty)}
                        onClick={() => {
                          props.onSave(key, "", "Template reset to default");
                          setDrafts(({ [key]: _drop, ...rest }) => rest);
                        }}
                      >
                        Reset to default
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
      <div className="mt-5 border-t border-[#f5f5f5] pt-4">
        <h3 className="text-xs font-semibold text-[#525252]">
          Live preview
          {preview && props.preview ? (
            <span className="ml-2 font-normal text-[#737373]" dir="ltr">
              {props.preview.phone} · {preview.templateKey}
            </span>
          ) : null}
        </h3>
        {preview ? (
          <pre
            dir="auto"
            className="mt-2 max-h-64 min-w-0 overflow-auto whitespace-pre-wrap rounded-lg border border-[#e5e5e5] bg-[#fafafa] p-3 font-sans text-xs leading-5 text-[#404040] [overflow-wrap:anywhere]"
          >
            {preview.text}
          </pre>
        ) : (
          <p className="mt-2 text-xs text-[#737373]">
            No visible rows to preview — widen the directory filters.
          </p>
        )}
      </div>
    </Card>
  );
}

type IconName =
  | "search"
  | "filter"
  | "chevron"
  | "close"
  | "sort"
  | "people"
  | "shop"
  | "book"
  | "truck"
  | "send"
  | "clock"
  | "reply"
  | "check"
  | "whatsapp";
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
    shop: <path d="M4 10 5 4h14l1 6M4 10v10h16V10M4 10h16M10 20v-6h4v6" />,
    book: (
      <path d="M4 5h6a2 2 0 0 1 2 2v13a2 2 0 0 0-2-2H4zM20 5h-6a2 2 0 0 0-2 2v13a2 2 0 0 1 2-2h6z" />
    ),
    truck: (
      <path d="M3 7h11v9H3zM14 10h4l3 3v3h-7zM7 19a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Zm11 0a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Z" />
    ),
    send: <path d="M21 3 3 10.5l8 2.5 2.5 8L21 3Zm0 0L11 13" />,
    clock: <path d="M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Zm0-13v5l3 2" />,
    reply: <path d="m9 7-5 5 5 5M4 12h10a6 6 0 0 1 6 6v1" />,
    check: <path d="m5 12 4 4L19 6" />,
    whatsapp: (
      <path d="M12 3a9 9 0 0 0-7.8 13.5L3 21l4.7-1.2A9 9 0 1 0 12 3Zm-3 5.5c.2-.4.5-.4.8-.4h.5c.2 0 .4 0 .6.4l.8 1.9c.1.2 0 .4-.1.5l-.6.7c-.1.2-.1.3 0 .5a7 7 0 0 0 3.2 2.9c.2.1.4.1.5-.1l.7-.8c.2-.2.3-.2.6-.1l1.9.9c.3.1.4.2.4.4a2.4 2.4 0 0 1-1.7 2c-.5.1-1 .2-3-.6a9.5 9.5 0 0 1-4.1-3.6c-.7-1-1-1.9-.9-2.5a2.7 2.7 0 0 1 .4-2.1Z" />
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
