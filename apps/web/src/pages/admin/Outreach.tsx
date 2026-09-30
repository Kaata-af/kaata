// Outreach — the operator's WhatsApp desk (2026-09-29; outcomes, the prospect
// queue and source exclusions 2026-09-30). One row per phone number the server
// knows: shopkeepers (installs.self_phone, accounts.phone_e164) and the people
// inside synced kaatas (person events folded per vault by the backend, see
// internal/admin/outreach.go). Everything is client-side over one GET
// /v1/admin/outreach payload, the same pipeline as Users: presets → filters →
// search → sort → page. Summary cards count the rows their click opens
// (presetCounts).
//
// Writes come in three shapes. Bulk `mark` and `setting` patch the cached
// result optimistically (outreach-model.applyMarkLocally), roll back on error,
// take the server's answer on success and refetch once the last write in
// flight settles, so a slow network never leaves a stale checkbox. An
// `outcome` (opened, sent, no_whatsapp, invalid, skip, retry) is one contact,
// version-checked, and NEVER optimistic: the server's answer replaces the row
// (applyStateLocally); a 409 means another tab already recorded something or
// the row's status refuses it (contact stopped, not retryable), and the page
// refetches instead of retrying. Every chat opens the same way (openChat,
// 2026-09-30): the tab is created in the click, "opened" is recorded with the
// row's version, and only then is the tab pointed at wa.me — the page has no
// wa.me link, so a middle-click cannot open a chat around the record. Opening
// records "opened" only — "sent" is the operator's own confirmation — so a
// closed tab or a crashed browser cannot mark a message that never went out,
// and the Queue card lists every opened-but-unconfirmed chat until it gets an
// outcome. Copy message records "opened" the same way once the clipboard
// write has landed (copyMessage), since a pasted message is an opened chat.
// `exclude` marks a book, account or install as verified test data; the list
// is refetched because rows disappear.
//
// Batch 3 (2026-09-30). The message language lives on the server, never in
// this page's memory: a session-wide choice (the setting pref.message_lang,
// Dari when unset) in the Queue card, and a per-number choice in a row's
// details (a mark with `lang`, which bumps the version like any write) that
// wins over it; Auto falls back to the shop's app language. An open chat keeps
// the language it was opened in: Sent records the template of its newest
// "opened" touch (openedTemplateKey), since that text is what went out. Each
// preset opens in its own order (presetSort: the ledger-people views on the
// newest tally), and Prospects is mobile numbers only. The Excluded sources
// card lists every book whose people feed the directory, with Exclude book
// and Exclude owner; excluding an account takes its own number and every book
// it owns, and every write control waits until the refreshed list is in.
//
// Idioms are copied from Users.tsx on purpose (FIELD/BUTTON, Pill,
// FilterSelect, SummaryCard, the card/table split, sessionStorage prefs that
// hold only enums and numbers); its file-local helpers are duplicated
// minimally rather than lifted so Users.tsx stays untouched.

import { useIsMutating, useMutation, useQueryClient } from "@tanstack/react-query";
import { Fragment, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { useToast } from "../../components/Toast";
import {
  ConflictError,
  StaleError,
  markOutreach,
  postExclusion,
  postOutcome,
  saveOutreachSetting,
  useAdminToken,
  useOutreach,
  type OutreachBook,
  type OutreachContact,
  type OutreachCustomer,
  type OutreachExclusion,
  type OutreachExclusionBody,
  type OutreachExclusionKind,
  type OutreachLang,
  type OutreachMarkBody,
  type OutreachMarkResult,
  type OutreachOutcomeBody,
  type OutreachResult,
  type OutreachShopkeeper,
  type OutreachState,
  type OutreachStatus,
  type OutreachTouch,
} from "./api";
import { reportingDay } from "./dates";
import {
  AFGHAN_CARRIERS,
  BOOK_SORT_OPTIONS,
  CONVERTED_FILTERS,
  DEFAULT_OUTREACH_FILTERS,
  DEFAULT_OUTREACH_SORT,
  DEFAULT_SLUGS,
  LANGUAGE_NAMES,
  OUTREACH_PRESETS,
  OUTREACH_SORT_OPTIONS,
  OUTREACH_STATUSES,
  SESSION_LANGUAGE_KEY,
  SESSION_LANGUAGE_OPTIONS,
  STATUS_LABELS,
  activePreset,
  afghanCarrier,
  applyExclusionsLocally,
  applyMarkLocally,
  applyMarkResponse,
  applySettingLocally,
  applyStateLocally,
  balanceSummary,
  bookOwnerLabel,
  buildMessage,
  chunk,
  contactDisplayName,
  contactInitials,
  contactPills,
  dialCode,
  facetValue,
  filterOutreach,
  formatMoney,
  isNeverMessaged,
  isOutreachLang,
  isOutreachStatus,
  isProspect,
  isSkippedToday,
  isStoppedStatus,
  isUnreachableStatus,
  languageLabel,
  lastTallyAt,
  matchesBookSearch,
  messageLanguage,
  nextToOpen,
  numberCaption,
  numberTypeLabel,
  numbersInBooks,
  offersChat,
  openableCount,
  openedTemplateKey,
  outreachCsv,
  ownerNames,
  parseMoney,
  parseOutreachPreferences,
  pendingRows,
  platformLabel,
  presetCounts,
  presetDescription,
  presetFilters,
  presetSort,
  sanitizeSlug,
  sessionChoiceLabel,
  sessionLanguage,
  slugKey,
  sortBooks,
  sortOutreach,
  templateFor,
  templateKey,
  templateLanguage,
  waLink,
  withPreset,
  type Audience,
  type BookSortKey,
  type MessageLanguage,
  type OutreachFilters,
  type OutreachPreferences,
  type OutreachPreset,
  type OutreachSort,
  type OutreachSortKey,
  type PillTone,
  type SessionLanguage,
} from "./outreach-model";
import { Card, ErrorCard, PageHeader, SkeletonCard, fmtDate, fmtInt, lastSeenInfo } from "./ui";

// v2 (2026-09-30): "Messaged before" now follows never_messaged, so a v1
// value is ignored and a tab that held one opens on Prospects like a fresh one.
// v3 (2026-09-30, batch 3): a preset now brings its own sort — Prospects
// opens on the newest tally — so a stored v2 view, whose sort meant nothing
// for Prospects, is dropped rather than left to linger.
const STORAGE_KEY = "kaata_admin_outreach_filters_v3";
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
  "inline-flex min-h-11 items-center justify-center gap-1.5 rounded-md bg-[#e8f5ed] px-2.5 py-1 text-xs font-semibold text-[#116b4f] transition hover:bg-[#d7eede] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#171717] disabled:cursor-not-allowed disabled:opacity-40 md:min-h-8";
const SMALL_PRIMARY =
  "inline-flex min-h-11 items-center justify-center gap-1.5 rounded-md bg-[#171717] px-2.5 py-1 text-xs font-semibold text-white transition hover:bg-[#404040] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#171717] focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-40 md:min-h-8";

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
  | "contacted"
  | "replied"
  | "followUp"
  | "converted"
  | "wholesaler"
  | "validity"
  | "numberType"
  | "pending"
  | "skipped";
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
      ["unreachable", "Not on WhatsApp or invalid"],
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
    key: "contacted",
    label: "Messaged before",
    options: [
      ["all", "All"],
      ["never", "Never messaged"],
      ["ever", "Messaged or opened"],
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
  {
    key: "validity",
    label: "Number validity (numbering plan)",
    options: [
      ["all", "Any"],
      ["valid", "Valid"],
      ["invalid", "Invalid"],
    ],
  },
  {
    key: "numberType",
    label: "Number type",
    options: [
      ["all", "Any"],
      ["mobile", "Mobile"],
      ["fixed", "Fixed line"],
    ],
  },
  {
    key: "pending",
    label: "Awaiting outcome",
    options: [
      ["all", "Any"],
      ["yes", "Opened, no outcome yet"],
      ["no", "Not awaiting"],
    ],
  },
  {
    key: "skipped",
    label: "Skipped today",
    options: [
      ["all", "Any"],
      ["hide", "Hide skipped today"],
      ["only", "Only skipped today"],
    ],
  },
];
const TOUCH_LABELS: Record<OutreachTouch["kind"], string> = {
  sent: "Sent",
  replied: "Replied",
  status: "Status",
  note: "Note",
  opened: "Opened",
  skipped: "Skipped",
  retry: "Retry",
};
const EXCLUSION_KIND_LABELS: Record<OutreachExclusionKind, string> = {
  vault: "Book",
  account: "Account",
  install: "Install",
};
type Verdict = "sent" | "no_whatsapp" | "invalid" | "skip";
// The strip's exit for a pending row (2026-09-30). Only a first contact —
// status New, no recorded send — gets "Skip for now" (back tomorrow). Any
// other pending row is a reopened conversation: its exit reads "Close —
// nothing sent" and records that reason, because "skip until tomorrow" would
// misdescribe it (the queue never offers it again anyway).
function closesFollowUp(contact: OutreachContact): boolean {
  return contact.outreach.status !== "new" || contact.outreach.contact_count > 0;
}

function presetFromHash(): OutreachPreset | undefined {
  if (window.location.hash.split("?")[0].replace(/^#\/?/, "") !== "outreach") return undefined;
  const value = new URLSearchParams(window.location.hash.split("?")[1] ?? "").get("view");
  return OUTREACH_PRESETS.find((p) => p.id === value)?.id;
}
// A first visit (nothing saved this session, no preset in the hash) opens on
// Prospects, so "Open next" has the resumable queue under it without a click;
// a saved view is restored as before. A preset, from the hash or the fresh
// default, brings its own sort too (withPreset, 2026-09-30).
function initialPreferences(): OutreachPreferences {
  let saved: unknown = null;
  try {
    saved = JSON.parse(sessionStorage.getItem(STORAGE_KEY) ?? "null");
  } catch {
    /* Storage may be unavailable. */
  }
  const preferences = parseOutreachPreferences(saved);
  const preset = presetFromHash() ?? (saved === null ? "prospects" : undefined);
  return preset ? withPreset(preferences, preset) : preferences;
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
// Starts a clipboard write and reports whether it landed. Browsers only
// allow the write during the click that asked for it, so callers invoke this
// before their first await; a missing clipboard API (insecure context) reads
// as a refusal.
function writeClipboard(text: string): Promise<boolean> {
  try {
    return navigator.clipboard.writeText(text).then(
      () => true,
      () => false,
    );
  } catch {
    return Promise.resolve(false);
  }
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
const OUTCOME_MUTATION_KEY = ["admin", "outreach", "outcome"];
const EXCLUSION_MUTATION_KEY = ["admin", "outreach", "exclude"];
// An outcome request; `quiet` leaves the failure toast to the caller, which
// has a better sentence for it (Sent & next's second half).
type OutcomeRequest = { body: OutreachOutcomeBody; quiet?: boolean };
// What a refused or failed outcome tells the operator (2026-09-30). The three
// 409 reasons all mean the cached row is behind the server, so they refetch;
// nothing is ever retried, because a retry is how a second message goes out.
// A stale version says only that the row changed, never that this outcome was
// "already recorded": any write bumps the version (a note, a language, a
// status from another tab), so the operator checks the row before acting again.
function describeOutcomeError(error: Error): {
  text: string;
  tone: "info" | "error";
  refresh: boolean;
} {
  if (error instanceof StaleError)
    return {
      text: "Changed elsewhere — refreshed. Check the row and try again.",
      tone: "info",
      refresh: true,
    };
  if (error instanceof ConflictError && error.message === "contact stopped")
    return {
      text: "This number is marked Declined or Do not contact. Change its status first.",
      tone: "error",
      refresh: true,
    };
  if (error instanceof ConflictError && error.message === "not retryable")
    return { text: "Can't retry: the status changed — refreshed", tone: "error", refresh: true };
  return { text: error.message || "Couldn't record the outcome.", tone: "error", refresh: false };
}
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
    mutationFn: async (body: OutreachMarkBody): Promise<Required<OutreachMarkResult>> => {
      const updated: OutreachState[] = [];
      const skipped: string[] = [];
      for (const phones of chunk(body.phones, 500)) {
        const response = await markOutreach(token, { ...body, phones });
        if (Array.isArray(response.updated)) updated.push(...response.updated);
        if (Array.isArray(response.skipped)) skipped.push(...response.skipped);
      }
      return { updated, skipped };
    },
    onMutate: async (body) => {
      await client.cancelQueries({ queryKey: key });
      const snapshot = client.getQueryData<OutreachResult | null>(key);
      if (snapshot)
        client.setQueryData(key, applyMarkLocally(snapshot, body, new Date().toISOString()));
      return { snapshot };
    },
    onSuccess: (response, body) => {
      const current = client.getQueryData<OutreachResult | null>(key);
      if (current)
        client.setQueryData(
          key,
          applyMarkResponse(current, response.updated, body, response.skipped),
        );
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
  // Outcomes are NOT patched optimistically: the server checks
  // `expected_version` and answers with the row's state, which replaces the
  // cached block as-is. A 409 means another tab, or an earlier click that
  // already landed, wrote this row first (StaleError), or its status refuses
  // the outcome (ConflictError); nothing was applied, and the answer is a
  // refetch, never a retry — a retry is how a second message gets sent. Every
  // other failure just says why.
  const outcome = useMutation({
    mutationKey: OUTCOME_MUTATION_KEY,
    mutationFn: (request: OutcomeRequest) => postOutcome(token, request.body),
    onSuccess: (response) => {
      const current = client.getQueryData<OutreachResult | null>(key);
      if (current && response.state)
        client.setQueryData(key, applyStateLocally(current, response.state));
    },
    onError: (error, request) => {
      const failure = describeOutcomeError(error);
      if (failure.refresh) void client.invalidateQueries({ queryKey: ["admin", "outreach"] });
      if (!request.quiet) toast.push(failure.text, failure.tone);
    },
    onSettled: () => settleUnlessMoreInFlight(OUTCOME_MUTATION_KEY),
  });
  // Excluding a source changes which rows exist, so the contact list is
  // always refetched; the exclusions card takes the server's list at once.
  // onSettled RETURNS the refetch (2026-09-30): the mutation stays pending
  // until the refreshed list has arrived, and the page's `busy` counts it, so
  // a number whose only source was just excluded can't be opened, sent or
  // relabelled from the stale list in the gap. The hold is capped at 20 s,
  // the same bound as every write, so a GET that never answers cannot leave
  // the whole page disabled until a reload.
  const exclude = useMutation({
    mutationKey: EXCLUSION_MUTATION_KEY,
    mutationFn: (body: OutreachExclusionBody) => postExclusion(token, body),
    onSuccess: (response) => {
      const current = client.getQueryData<OutreachResult | null>(key);
      if (current && Array.isArray(response.exclusions))
        client.setQueryData(key, applyExclusionsLocally(current, response.exclusions));
    },
    onError: (error) => toast.push(error.message || "Couldn't update the exclusion.", "error"),
    onSettled: () =>
      Promise.race([
        client.invalidateQueries({ queryKey: ["admin", "outreach"] }),
        new Promise<void>((resolve) => setTimeout(resolve, 20_000)),
      ]),
  });
  return { mark, setting, outcome, exclude };
}

export function Outreach() {
  const outreach = useOutreach();
  const toast = useToast();
  const { mark, setting, outcome, exclude } = useOutreachMutations();
  const [preferences, setPreferences] = useState(initialPreferences);
  const { filters, sortKey, sortDesc, pageSize } = preferences;
  const [search, setSearch] = useState("");
  const [showFilters, setShowFilters] = useState(false);
  const [page, setPage] = useState(0);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [clockTick, setNow] = useState(Date.now);
  // One flag for every write in flight (2026-09-30): an outcome flow (row
  // open, Open next, Sent & next, the strip's buttons, the row tick, Retry),
  // plus every outcome and mark request counted by key — `isPending` would
  // only track each hook's latest call. The ref answers in the same tick a
  // double click lands in; the state re-renders the buttons disabled. A
  // pending mark counts, so no outcome goes out with a version a mark is
  // about to bump. So does an exclusion, from its POST until the refetched
  // list is in (2026-09-30; its onSettled returns the refetch): until then
  // the rows on screen may include numbers that are no longer listed.
  const [outcomeFlow, setOutcomeFlow] = useState(false);
  const outcomeFlowRef = useRef(false);
  const outcomesInFlight = useIsMutating({ mutationKey: OUTCOME_MUTATION_KEY });
  const marksInFlight = useIsMutating({ mutationKey: MARK_MUTATION_KEY });
  const exclusionsInFlight = useIsMutating({ mutationKey: EXCLUSION_MUTATION_KEY });
  const busy = outcomeFlow || outcomesInFlight > 0 || marksInFlight > 0 || exclusionsInFlight > 0;
  // The session language is a setting write of its own (2026-09-30); its
  // select waits for every save of that key in flight, so two quick changes
  // can never land on the server in the wrong order.
  const languageSaves = useIsMutating({
    mutationKey: SETTING_MUTATION_KEY,
    predicate: (mutation) =>
      (mutation.state.variables as { key?: unknown } | undefined)?.key === SESSION_LANGUAGE_KEY,
  });
  const now = Math.max(clockTick, outreach.dataUpdatedAt);
  const data = outreach.data ?? null;
  const contacts = useMemo(() => data?.contacts ?? [], [data]);
  const settings = useMemo(() => data?.settings ?? {}, [data]);
  const session = sessionLanguage(settings);
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
  // Chips compare against the active preset's filters while the view still
  // matches a preset exactly, so a preset's own values (the tracking tabs
  // showing archived customers, Prospects' +93) are not reported as extra
  // filters; once the view matches no preset they compare against the
  // defaults. Removing a chip puts that field back to the same baseline.
  const chipBaseline = selectedPreset ? presetFilters(selectedPreset) : DEFAULT_OUTREACH_FILTERS;
  const activeFilters = filterChips(filters, chipBaseline);
  const selectedPhones = useMemo(
    () => Object.keys(selected).filter((phone) => selected[phone]),
    [selected],
  );
  const next = nextToOpen(sorted, now);
  const openable = openableCount(sorted, now);
  // The strip spans ALL contacts, not the current view: an opened chat waits
  // for its outcome whatever tab the operator moved to since.
  const pending = useMemo(() => pendingRows(contacts), [contacts]);
  const prospectsRemaining = useMemo(
    () => contacts.filter((contact) => isProspect(contact, now, "+93")).length,
    [contacts, now],
  );
  const viewLabel = selectedPreset
    ? (OUTREACH_PRESETS.find((preset) => preset.id === selectedPreset)?.label ?? "this view")
    : "a custom view";

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
      setPreferences((p) => withPreset(p, preset));
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
  // A view is applied with its sort (2026-09-30): a preset with its own
  // (presetSort), the converted card with the default view's. A sort changed
  // afterwards (sortBy) holds until the next view is applied.
  function applyView(next: OutreachFilters, sort: OutreachSort) {
    setPreferences((p) => ({ ...p, filters: next, ...sort }));
    setSearch("");
    setPage(0);
    setExpanded({});
  }
  function applyPreset(preset: OutreachPreset) {
    applyView(presetFilters(preset), presetSort(preset));
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
    if (await writeClipboard(text)) toast.push(message, "success");
    else toast.push("Couldn't copy — the browser blocked clipboard access.", "error");
  }
  function markPhones(body: OutreachMarkBody, message: string) {
    mark.mutate(body, { onSuccess: () => toast.push(message, "success") });
  }
  // The message in the contact's resolved language: its own choice, else the
  // session's, else (Auto) its locale — all read from the server's answer.
  function messageFor(contact: OutreachContact) {
    return buildMessage(contact, settings);
  }
  // The template a "sent" records (2026-09-30). An open chat keeps the
  // language it was opened in — the prefilled text in its tab is what went
  // out — so a pending row records its opened template, and only a row with
  // no open chat on record takes today's resolution. Every path that marks a
  // pending row sent comes through here: the strip's Sent, the row's Sent
  // box, and the first half of Sent & next.
  function sentTemplateKey(contact: OutreachContact): string {
    return openedTemplateKey(contact) ?? messageFor(contact).templateKey;
  }
  function saveSessionLanguage(value: SessionLanguage) {
    const label = SESSION_LANGUAGE_OPTIONS.find(([option]) => option === value)?.[1] ?? value;
    setting.mutate(
      { key: SESSION_LANGUAGE_KEY, value },
      { onSuccess: () => toast.push(`Message language: ${label}`, "success") },
    );
  }
  function beginOutcome(): boolean {
    if (outcomeFlowRef.current) return false;
    outcomeFlowRef.current = true;
    setOutcomeFlow(true);
    return true;
  }
  function endOutcome() {
    outcomeFlowRef.current = false;
    setOutcomeFlow(false);
  }
  // Every outcome POST goes through here, always inside beginOutcome /
  // endOutcome. The hook toasts a failure unless `quiet` (the caller then
  // words it); either way the caller gets the row's state or the error and
  // decides whether to go on — never whether to retry.
  async function recordOutcome(
    body: OutreachOutcomeBody,
    quiet = false,
  ): Promise<OutreachState | Error> {
    try {
      return (await outcome.mutateAsync({ body, quiet })).state;
    } catch (error) {
      return error instanceof Error ? error : new Error("Couldn't record the outcome.");
    }
  }
  function verdictMessage(contact: OutreachContact, verdict: Verdict | "retry"): string {
    switch (verdict) {
      case "sent":
        return `${contact.phone} marked sent`;
      case "no_whatsapp":
        return `${contact.phone}: not on WhatsApp`;
      case "invalid":
        return `${contact.phone}: invalid number`;
      case "skip":
        return closesFollowUp(contact)
          ? `${contact.phone}: closed, nothing sent`
          : `${contact.phone} skipped until tomorrow`;
      case "retry":
        return `${contact.phone} back to New`;
    }
  }
  // One verdict for one row, version-checked, from the strip or the row.
  function recordVerdict(contact: OutreachContact, verdict: Verdict | "retry") {
    if (!beginOutcome()) return;
    const body: OutreachOutcomeBody = {
      phone: contact.phone,
      outcome: verdict,
      expected_version: contact.outreach.version,
    };
    if (verdict === "sent") body.template_key = sentTemplateKey(contact);
    if (verdict === "skip" && closesFollowUp(contact)) body.reason = "nothing sent";
    void recordOutcome(body)
      .then((state) => {
        if (!(state instanceof Error)) toast.push(verdictMessage(contact, verdict), "success");
      })
      .finally(endOutcome);
  }
  // Pop-up rule: a tab opened after an await is a blocked pop-up, so the tab
  // is created synchronously in the click handler, pointed at about:blank,
  // and only navigated to wa.me once the server accepted the record. Cutting
  // `opener` leaves the new tab no handle on the dashboard.
  function openBlankTab(): Window | null {
    const tab = window.open("about:blank");
    if (tab) tab.opener = null;
    return tab;
  }
  // Every chat opens through here — a row's WhatsApp button, "Open next",
  // the strip's "Open chat again" (2026-09-30: always record-then-navigate).
  // The tab is created synchronously in the click, "opened" is recorded with
  // the row's version, and only on success is the tab pointed at wa.me; a
  // refused or failed record closes it, so a row another tab already opened
  // or sent is never opened twice, and no chat opens unrecorded.
  async function openChat(contact: OutreachContact) {
    if (outcomeFlowRef.current) return;
    const tab = openBlankTab();
    if (!tab) {
      toast.push("Allow pop-ups for this site to open chats.", "error");
      return;
    }
    beginOutcome();
    try {
      const message = messageFor(contact);
      const opened = await recordOutcome({
        phone: contact.phone,
        outcome: "opened",
        template_key: message.templateKey,
        expected_version: contact.outreach.version,
      });
      if (opened instanceof Error) {
        tab.close();
        return;
      }
      tab.location.href = waLink(contact.phone, message.text);
    } finally {
      endOutcome();
    }
  }
  // Copy message is an open too (2026-09-30): the operator pastes the text
  // into a chat by hand, so the row must land in "Awaiting outcome" like an
  // opened chat. The clipboard write starts first, synchronously in the
  // click (it needs the user activation an await would spend); then "opened"
  // is recorded through the same guarded path as every open, with the row's
  // version. A copy the browser refused records nothing — there is nothing in
  // hand to send. Only rows that offer a chat have the button (RowActions).
  async function copyMessage(contact: OutreachContact) {
    if (outcomeFlowRef.current) return;
    const message = messageFor(contact);
    const copied = writeClipboard(message.text);
    beginOutcome();
    try {
      if (!(await copied)) {
        toast.push("Couldn't copy — the browser blocked clipboard access.", "error");
        return;
      }
      const opened = await recordOutcome(
        {
          phone: contact.phone,
          outcome: "opened",
          template_key: message.templateKey,
          expected_version: contact.outreach.version,
        },
        true,
      );
      if (opened instanceof Error)
        toast.push(
          "Copied, but couldn't record it as opened — record the outcome by hand.",
          "error",
        );
      else toast.push(`Message copied · ${contact.phone} awaiting outcome`, "success");
    } finally {
      endOutcome();
    }
  }
  // "Open next": the first openable row of the CURRENT view (first contact
  // only, see canOpen), opened like any other chat.
  function openNext() {
    if (outcomeFlowRef.current) return;
    const target = nextToOpen(sorted, now);
    if (!target) {
      toast.push("Nothing to open in this view.", "info");
      return;
    }
    void openChat(target);
  }
  // "Sent & next" on a pending row. The next target comes from the current
  // view BEFORE anything opens, so an empty queue opens no tab at all; then
  // sent is recorded (version-checked, with the template the chat was opened
  // in: sentTemplateKey), then opened for the target, and only
  // then is the tab navigated. Any failure closes the tab and never advances;
  // a sent record that already landed stays — that is the outcome that must
  // not be lost — and one toast says both halves.
  async function sentAndNext(contact: OutreachContact) {
    if (outcomeFlowRef.current) return;
    const target = nextToOpen(
      sorted.filter((row) => row.phone !== contact.phone),
      now,
    );
    const tab = target ? openBlankTab() : null;
    beginOutcome();
    try {
      const sent = await recordOutcome({
        phone: contact.phone,
        outcome: "sent",
        template_key: sentTemplateKey(contact),
        expected_version: contact.outreach.version,
      });
      if (sent instanceof Error) {
        tab?.close();
        return;
      }
      if (!target) {
        toast.push("Marked sent — queue empty in this view.", "info");
        return;
      }
      if (!tab) {
        toast.push("Marked sent — allow pop-ups for this site to open the next chat.", "info");
        return;
      }
      const message = messageFor(target);
      const opened = await recordOutcome(
        {
          phone: target.phone,
          outcome: "opened",
          template_key: message.templateKey,
          expected_version: target.outreach.version,
        },
        true,
      );
      if (opened instanceof Error) {
        tab.close();
        toast.push(
          `Marked sent · couldn't open the next chat (${describeOutcomeError(opened).text})`,
          "error",
        );
        return;
      }
      tab.location.href = waLink(target.phone, message.text);
      toast.push(`Marked sent · opened ${target.phone}`, "success");
    } finally {
      endOutcome();
    }
  }
  function onExclude(body: OutreachExclusionBody, message: string) {
    exclude.mutate(body, { onSuccess: () => toast.push(message, "success") });
  }
  function exportCsv() {
    downloadBlob(
      new Blob([outreachCsv(sorted)], { type: "text/csv;charset=utf-8" }),
      `kaata-outreach-${reportingDay(Date.now())}.csv`,
    );
    toast.push(`Exported ${fmtInt(sorted.length)} rows`, "success");
  }
  // The selection survives a failed bulk mark so a retry needs no re-ticking;
  // it clears once the server has answered. The server leaves some rows out
  // and reports them as skipped (2026-09-30): "Mark sent" records only a
  // FIRST message (New, Not on WhatsApp or Invalid, never recorded as sent),
  // and a status action never lifts a stop — the body type has no lift_stop,
  // so no bulk action can send it. Nor a lang: a message language is set one
  // row at a time. The toast says how many and why.
  function bulk(body: Omit<OutreachMarkBody, "phones" | "lift_stop" | "lang">, label: string) {
    if (!selectedPhones.length) return;
    const phones = selectedPhones;
    mark.mutate(
      { ...body, phones },
      {
        onSuccess: ({ skipped }) => {
          const counted = fmtInt(phones.length - skipped.length);
          const n = fmtInt(skipped.length);
          const unchanged = !skipped.length
            ? ""
            : body.contacted
              ? ` · ${n} not counted (already messaged or stopped)`
              : body.status !== undefined
                ? ` · ${n} stopped numbers left unchanged — change them one at a time`
                : ` · ${n} left unchanged`;
          toast.push(`${label} · ${counted} numbers${unchanged}`, "success");
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
    saving: busy,
    busy,
    excluding: exclude.isPending,
    onToggle: (phone: string) => setExpanded((value) => ({ ...value, [phone]: !value[phone] })),
    onSelect: (phone: string, on: boolean) => setSelected((value) => ({ ...value, [phone]: on })),
    // The per-number language is saved on the server (2026-09-30) through
    // the mark mutation: it bumps the row's version, so it counts as a write
    // in flight (busy) like a status or a note, and records no touch. Success
    // is claimed only when the server's answer carries the language asked
    // for: a backend from before migration 046 ignores `lang` and answers
    // without it, the row falls back to the session choice
    // (applyMarkResponse), and a success toast would say the opposite.
    onLanguage: (contact: OutreachContact, lang: OutreachLang) =>
      mark.mutate(
        { phones: [contact.phone], lang },
        {
          onSuccess: ({ updated }) => {
            if (updated.find((state) => state.phone === contact.phone)?.lang === lang)
              toast.push(
                lang
                  ? `${contact.phone}: messages in ${LANGUAGE_NAMES[lang]}`
                  : `${contact.phone}: follows the session language`,
                "success",
              );
            else
              toast.push(
                "Language not saved — the server is on an older version; reload after the deploy.",
                "error",
              );
          },
        },
      ),
    // A stop is lifted only here, one row at a time (2026-09-30): moving a
    // Declined or Do-not-contact row to another status sends lift_stop, which
    // no bulk action can, so a bulk status change leaves every stop alone.
    onStatus: (contact: OutreachContact, status: OutreachStatus) =>
      markPhones(
        isStoppedStatus(contact.outreach.status)
          ? { phones: [contact.phone], status, lift_stop: true }
          : { phones: [contact.phone], status },
        `${contact.phone}: ${STATUS_LABELS[status]}`,
      ),
    // The tick is the outcome "sent" (version-checked) and one-way
    // (2026-09-30): there is no untick; resetting to New is the status menu's.
    onSent: (contact: OutreachContact) => recordVerdict(contact, "sent"),
    onReplied: (contact: OutreachContact) =>
      markPhones({ phones: [contact.phone], replied: true }, `${contact.phone} marked replied`),
    onNote: (contact: OutreachContact, note: string) =>
      markPhones({ phones: [contact.phone], note }, "Note saved"),
    onRetry: (contact: OutreachContact) => recordVerdict(contact, "retry"),
    onExclude,
    onOpenChat: (contact: OutreachContact) => void openChat(contact),
    onCopyMessage: (contact: OutreachContact) => void copyMessage(contact),
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
          <div className="mb-3 grid min-w-0 grid-cols-2 gap-2 sm:gap-3 md:grid-cols-4 lg:grid-cols-5">
            <SummaryCard
              label="All numbers"
              value={cards.all}
              sub={`${fmtInt(data.counts.both)} are both`}
              onClick={() => applyPreset("all")}
              icon="people"
            />
            <SummaryCard
              label="Prospects"
              value={cards.prospects}
              sub="Customer-only · never messaged · valid mobile · AF"
              onClick={() => applyPreset("prospects")}
              icon="list"
            />
            <SummaryCard
              label="Awaiting outcome"
              value={cards.pending}
              sub="Chat opened, nothing recorded yet"
              onClick={() => applyPreset("pending")}
              icon="hourglass"
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
              onClick={() => applyView(CONVERTED_FILTERS, DEFAULT_OUTREACH_SORT)}
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
              <span className="mx-1.5 text-[#d4d4d4]">·</span>
              Unreachable {fmtInt(cards.unreachable)}
            </p>
            <p className="tabular-nums" role="status">
              Today: {fmtInt(data.counts.opened_today)} opened · {fmtInt(data.counts.sent_today)}{" "}
              sent · {fmtInt(data.counts.replied_today)} replied
            </p>
          </div>
          <QueueCard
            next={next}
            openable={openable}
            viewLabel={viewLabel}
            prospectsRemaining={prospectsRemaining}
            pending={pending}
            busy={busy}
            sessionLanguage={session}
            languageSaving={languageSaves > 0}
            messageFor={messageFor}
            onLanguage={saveSessionLanguage}
            onOpenNext={openNext}
            onSentAndNext={(contact) => void sentAndNext(contact)}
            onVerdict={recordVerdict}
            onOpenAgain={(contact) => void openChat(contact)}
            onCopyPhone={(contact) => void copyText(contact.phone, "Copied")}
          />
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
                    title={presetDescription(preset.id, presetSort(preset.id))}
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
              {/* The order sentence ("Newest tally first.") only while the
                  preset's own order is on screen (2026-09-30). */}
              {selectedPreset && selectedPreset !== "all" ? (
                <p className="text-xs leading-5 text-[#737373]">
                  {presetDescription(selectedPreset, { sortKey, sortDesc })}
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
                      label="Min books listing it"
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
                      aria-label={`${chip.label} — remove filter`}
                      onClick={() => updateFilters({ [chip.key]: chipBaseline[chip.key] })}
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
                      aria-label={`Search: ${search} — clear search`}
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
                {fmtInt(openable)} openable
                <span className="mx-1.5">·</span>
                {fmtInt(sorted.filter((c) => c.follow_up_due).length)} follow-ups due
              </p>
              <span className="min-w-0 text-xs leading-5 text-[#737373]">
                WhatsApp and Copy message record "opened" only — record Sent once the message is
                out.
              </span>
            </div>
            <div className="flex flex-wrap items-center gap-2 px-4 py-3 sm:px-6">
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
                  disabled={busy}
                  onClick={() => bulk({ contacted: true }, "Marked sent")}
                >
                  Mark sent
                </button>
                <button
                  className={SMALL_BUTTON}
                  disabled={busy}
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
                    disabled={busy}
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
            ago with no reply. Last seen is a device check-in, not a ledger edit. Validity comes
            from the numbering plan (libphonenumber); it says nothing about whether the number uses
            WhatsApp. Prospects = customer-only mobile numbers (the plan's mobile or
            fixed-or-mobile), status New, never messaged (no send recorded and every opened chat
            closed as nothing sent), valid, not awaiting an outcome, not skipped today; Afghanistan
            by default (change the country filter). Open next and Prospects are first contact only.
            Prospects, Customers and Wholesalers open on the newest tally; a tie goes to the number
            more books list. A sort you pick holds until you open another view.
          </p>
          <div className="mt-6">
            <TemplatesCard
              settings={settings}
              preview={sorted[0]}
              saving={setting.isPending}
              onSave={(key, value, message) =>
                setting.mutate({ key, value }, { onSuccess: () => toast.push(message, "success") })
              }
            />
          </div>
          <div className="mt-6">
            <ExclusionsCard
              exclusions={data.exclusions}
              books={data.books}
              contacts={contacts}
              busy={exclude.isPending}
              onExclude={onExclude}
              onUndo={(exclusion) =>
                onExclude(
                  { kind: exclusion.kind, id: exclusion.id, excluded: false },
                  `Included again: ${exclusion.label || exclusion.id}`,
                )
              }
            />
          </div>
        </>
      )}
    </div>
  );
}

// The strip's outcome buttons for one pending row. Each accessible name is
// the visible label first, then the phone (WCAG 2.5.3), e.g. "Skip for now:
// +93…". A pending row that is not a first contact closes with "nothing
// sent" instead of a skip-until-tomorrow (see closesFollowUp).
type VerdictButton = { verdict: Verdict; label: string; title?: string };
function queueVerdicts(contact: OutreachContact): VerdictButton[] {
  return [
    { verdict: "sent", label: "Sent" },
    { verdict: "no_whatsapp", label: "Not on WhatsApp" },
    { verdict: "invalid", label: "Invalid number" },
    closesFollowUp(contact)
      ? {
          verdict: "skip",
          label: "Close — nothing sent",
          title: "Nothing was sent; ends the wait without counting a message.",
        }
      : {
          verdict: "skip",
          label: "Skip for now",
          title: "Nothing was sent; the number comes back tomorrow.",
        },
  ];
}
// The Queue card: "Open next" over the current directory view, and the strip
// of chats opened without an outcome — across ALL contacts, longest wait
// first, so nothing opened in another tab or before a reload is forgotten.
// Every button sends the row's version and is disabled while any write is in
// flight; "Open chat again" is a button like every other open (2026-09-30):
// it records another "opened" before the tab is pointed at wa.me. The
// session-wide message language sits in the card's header (2026-09-30): a
// server setting, so every tab and device writes the same message. A strip
// row names the language its chat was opened in, which Sent records, and
// the one a reopen would use when that has changed since.
function QueueCard(props: {
  next: OutreachContact | undefined;
  openable: number;
  viewLabel: string;
  prospectsRemaining: number;
  pending: OutreachContact[];
  busy: boolean;
  sessionLanguage: SessionLanguage;
  languageSaving: boolean;
  messageFor: (contact: OutreachContact) => ReturnType<typeof buildMessage>;
  onLanguage: (value: SessionLanguage) => void;
  onOpenNext: () => void;
  onSentAndNext: (contact: OutreachContact) => void;
  onVerdict: (contact: OutreachContact, verdict: Verdict) => void;
  onOpenAgain: (contact: OutreachContact) => void;
  onCopyPhone: (contact: OutreachContact) => void;
}) {
  const nextMessage = props.next ? props.messageFor(props.next) : null;
  return (
    <Card
      title="Queue"
      sub="Open next takes the first openable row of the current directory view — first contact only, never a number messaged before. A chat you opened waits below until you record what happened."
      className="mb-5"
      action={
        <div className="flex min-w-0 max-w-full flex-col gap-1">
          <label
            className="flex min-w-0 max-w-full flex-wrap items-center gap-2 text-xs font-medium text-[#525252]"
            htmlFor="outreach-session-language"
          >
            Message language
            <select
              id="outreach-session-language"
              className={SMALL_SELECT}
              value={props.sessionLanguage}
              disabled={props.languageSaving}
              aria-busy={props.languageSaving}
              onChange={(event) => {
                const value = SESSION_LANGUAGE_OPTIONS.find(
                  ([option]) => option === event.target.value,
                )?.[0];
                if (value && value !== props.sessionLanguage) props.onLanguage(value);
              }}
            >
              {SESSION_LANGUAGE_OPTIONS.map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <p className="text-[11px] leading-4 text-[#737373]">
            {props.languageSaving
              ? "Saving…"
              : "For every number without its own language (set in its details)."}
          </p>
        </div>
      }
    >
      <div className="flex min-w-0 flex-wrap items-center gap-3">
        <button
          className={PRIMARY}
          onClick={props.onOpenNext}
          disabled={props.busy}
          title={
            props.next
              ? `Records opened for ${props.next.phone}, then opens the chat`
              : "Nothing to open in this view"
          }
        >
          <Icon name="send" className="text-white" />
          Open next{props.next ? ` · ${props.next.phone}` : ""}
        </button>
        <p
          className="min-w-0 text-xs leading-5 text-[#737373] [overflow-wrap:anywhere]"
          role="status"
        >
          {props.next && nextMessage ? (
            <>
              Next:{" "}
              <span className="font-medium text-[#404040]" dir="auto">
                {contactDisplayName(props.next)}
              </span>
              {" · "}
              <span dir="ltr" className="font-mono tabular-nums">
                {props.next.phone}
              </span>
              {" · "}
              {LANGUAGE_NAMES[nextMessage.language]}
            </>
          ) : (
            "Nothing to open in this view."
          )}
          <span className="mx-1.5">·</span>
          <span className="tabular-nums">
            {fmtInt(props.openable)} openable in this view ({props.viewLabel})
          </span>
          <span className="mx-1.5">·</span>
          <span className="tabular-nums">
            {fmtInt(props.prospectsRemaining)} prospects left in Afghanistan
          </span>
        </p>
      </div>
      <div className="mt-4 border-t border-[#f5f5f5] pt-4">
        <h3 className="text-xs font-semibold text-[#525252]">
          Awaiting outcome
          <span className="ml-1 font-normal tabular-nums text-[#737373]">
            {fmtInt(props.pending.length)}
          </span>
        </h3>
        {props.pending.length === 0 ? (
          <p className="mt-2 text-xs text-[#737373]">No chats awaiting an outcome.</p>
        ) : (
          <ul
            className="mt-2 grid min-w-0 grid-cols-1 gap-2"
            aria-label="Chats awaiting an outcome"
          >
            {props.pending.map((contact) => {
              const message = props.messageFor(contact);
              const o = contact.outreach;
              // The language the open chat went out in, which Sent records
              // (2026-09-30), and the one "Open chat again" would use now,
              // named only when they differ. An open with no readable
              // template falls back to today's resolution, as Sent does.
              const openedKey = openedTemplateKey(contact);
              const openedIn = openedKey ? templateLanguage(openedKey) : undefined;
              const language = openedIn
                ? `opened in ${LANGUAGE_NAMES[openedIn]}${openedIn === message.language ? "" : ` · reopens in ${LANGUAGE_NAMES[message.language]}`}`
                : LANGUAGE_NAMES[message.language];
              return (
                <li
                  key={contact.phone}
                  className="min-w-0 max-w-full rounded-lg border border-[#e5e5e5] bg-[#fafafa] p-3"
                >
                  <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
                    <span
                      className="min-w-0 text-sm font-semibold text-[#171717] [overflow-wrap:anywhere]"
                      dir="auto"
                    >
                      {contactDisplayName(contact)}
                    </span>
                    <button
                      dir="ltr"
                      className="min-h-11 rounded font-mono text-sm tabular-nums text-[#171717] hover:underline focus-visible:outline-2 focus-visible:outline-[#171717]"
                      title="Copy number"
                      onClick={() => props.onCopyPhone(contact)}
                    >
                      {contact.phone}
                    </button>
                    <span className="text-xs text-[#737373]">
                      waiting since {fmtDateTime(o.pending_since)}
                      {o.open_count > 1 ? ` · opened ${o.open_count}×` : ""} · {language}
                    </span>
                  </div>
                  <div className="mt-2 flex min-w-0 flex-wrap items-center gap-2">
                    <button
                      className={SMALL_PRIMARY}
                      disabled={props.busy}
                      onClick={() => props.onSentAndNext(contact)}
                      aria-label={`Sent & next: mark ${contact.phone} sent, then open the next chat`}
                      title="Records sent, then opens the next chat in the current view"
                    >
                      Sent &amp; next
                    </button>
                    {queueVerdicts(contact).map((button) => (
                      <button
                        key={button.verdict}
                        className={SMALL_BUTTON}
                        disabled={props.busy}
                        aria-label={`${button.label}: ${contact.phone}`}
                        title={button.title}
                        onClick={() => props.onVerdict(contact, button.verdict)}
                      >
                        {button.label}
                      </button>
                    ))}
                    {offersChat(contact) ? (
                      <button
                        type="button"
                        className={WA_BUTTON}
                        disabled={props.busy}
                        aria-label={`Open chat again with ${contact.phone}`}
                        title="Records another 'opened', then opens the chat"
                        onClick={() => props.onOpenAgain(contact)}
                      >
                        <Icon name="whatsapp" className="h-4 w-4" />
                        Open chat again
                      </button>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
      <p className="mt-4 text-xs leading-5 text-[#737373]">
        Opening a chat or copying its message records 'opened' only. Skipped numbers return
        tomorrow. Not-on-WhatsApp and invalid numbers stay out until you press Retry, and return to
        the queue only if they were never messaged.
      </p>
    </Card>
  );
}

const BOOKS_PAGE_SIZE = 25;
// What excluding an owner does (2026-09-30), on every button that excludes
// an account: the server drops the account's own number and every book it
// owns, like OPERATOR_ACCOUNT_IDS.
const OWNER_EXCLUDE_TITLE = "Removes the owner's own number and every book they own.";
// The Books list (2026-09-30): every book whose people feed the directory, in
// one place, so test data is found and excluded without hunting through
// rows — the book, or its owner (the owner's own number and every book they
// own). Search, order and paging are client-side over the GET's `books`, whose
// own order is the Numbers sort (sortBooks); an exclusion moves the book to
// the list below at once (applyExclusionsLocally) and refetches.
function BooksSection(props: {
  books: OutreachBook[];
  contacts: OutreachContact[];
  busy: boolean;
  onExclude: (body: OutreachExclusionBody, message: string) => void;
}) {
  const [search, setSearch] = useState("");
  const [sortKey, setSortKey] = useState<BookSortKey>("numbers");
  const [page, setPage] = useState(0);
  const shown = useMemo(
    () =>
      sortBooks(
        props.books.filter((book) => matchesBookSearch(book, search)),
        sortKey,
      ),
    [props.books, search, sortKey],
  );
  // Each number once, however many of the shown books list it.
  const numbers = useMemo(() => numbersInBooks(props.contacts, shown), [props.contacts, shown]);
  const pageCount = Math.max(1, Math.ceil(shown.length / BOOKS_PAGE_SIZE));
  const currentPage = Math.min(page, pageCount - 1);
  const rows = shown.slice(currentPage * BOOKS_PAGE_SIZE, (currentPage + 1) * BOOKS_PAGE_SIZE);
  useEffect(() => {
    setPage((current) => Math.min(current, pageCount - 1));
  }, [pageCount]);
  const actions = (book: OutreachBook, stacked = false) => (
    <BookActions book={book} busy={props.busy} stacked={stacked} onExclude={props.onExclude} />
  );
  return (
    <section className="min-w-0" aria-labelledby="outreach-books-heading">
      <h3 id="outreach-books-heading" className="text-sm font-semibold text-[#171717]">
        Books
      </h3>
      <p className="mt-1 text-xs leading-5 text-[#737373]">
        Every book whose people feed this list. Exclude a book, or its owner, if it is test data.
      </p>
      <div className="mt-3 grid min-w-0 grid-cols-1 gap-2 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center sm:gap-3">
        <div className="relative min-w-0">
          <span className="pointer-events-none absolute left-3 top-3 text-[#a3a3a3]">
            <Icon name="search" />
          </span>
          <input
            aria-label="Search books by name, owner, email or phone"
            type="search"
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
              setPage(0);
            }}
            placeholder="Search books…"
            className={`${FIELD} pl-10`}
          />
        </div>
        {/* Its own name (2026-09-30), apart from the directory's "Sort by". */}
        <label className="flex min-w-0 items-center gap-2 text-xs text-[#737373]">
          Sort books by
          <select
            value={sortKey}
            onChange={(event) => {
              const key = BOOK_SORT_OPTIONS.find(([option]) => option === event.target.value)?.[0];
              if (key) setSortKey(key);
              setPage(0);
            }}
            className={SMALL_SELECT}
          >
            {BOOK_SORT_OPTIONS.map(([key, label]) => (
              <option key={key} value={key}>
                {label}
              </option>
            ))}
          </select>
        </label>
      </div>
      <p className="mt-3 text-xs tabular-nums text-[#737373]" role="status">
        {fmtInt(shown.length)} {shown.length === 1 ? "book" : "books"} · {fmtInt(numbers)}{" "}
        {numbers === 1 ? "number" : "numbers"}
      </p>
      {rows.length === 0 ? (
        <p className="mt-3 text-sm text-[#737373]">
          {props.books.length ? "No books match this search." : "No books."}
        </p>
      ) : (
        <>
          <ul className="mt-3 grid min-w-0 grid-cols-1 gap-2 md:hidden" aria-label="Books">
            {rows.map((book) => (
              <li
                key={book.vault_id}
                className="min-w-0 max-w-full rounded-lg border border-[#e5e5e5] bg-[#fafafa] p-3"
              >
                <BookName book={book} />
                <div className="mt-1">
                  <BookOwner book={book} />
                </div>
                <dl className="mt-3 grid min-w-0 grid-cols-2 gap-x-3 gap-y-2 sm:grid-cols-3">
                  <DetailItem label="Created" value={fmtDate(book.created_at)} />
                  <DetailItem label="Numbers" value={fmtInt(book.numbers)} />
                  <DetailItem label="People" value={fmtInt(book.people)} />
                  <DetailItem label="Tallies" value={fmtInt(book.tallies)} />
                  <DetailItem label="Last activity" value={fmtDate(book.last_tally_at)} />
                </dl>
                <div className="mt-3">{actions(book)}</div>
              </li>
            ))}
          </ul>
          <div
            className="relative mt-3 hidden min-w-0 w-full max-w-full overflow-x-auto overscroll-x-contain rounded-lg border border-[#e5e5e5] focus-visible:outline-2 focus-visible:outline-[#171717] md:block"
            role="region"
            aria-label="Scrollable books table"
            tabIndex={0}
          >
            <table className="w-full min-w-[860px] border-collapse text-left" aria-label="Books">
              <thead>
                <tr className="border-b border-[#f5f5f5] bg-[#fafafa]">
                  <th scope="col" className="px-3 py-3 text-xs font-medium text-[#737373]">
                    Book
                  </th>
                  <th scope="col" className="px-3 py-3 text-xs font-medium text-[#737373]">
                    Owner
                  </th>
                  <th scope="col" className="px-3 py-3 text-xs font-medium text-[#737373]">
                    Created
                  </th>
                  <th
                    scope="col"
                    className="px-3 py-3 text-right text-xs font-medium text-[#737373]"
                  >
                    Numbers
                  </th>
                  <th
                    scope="col"
                    className="px-3 py-3 text-right text-xs font-medium text-[#737373]"
                  >
                    People
                  </th>
                  <th
                    scope="col"
                    className="px-3 py-3 text-right text-xs font-medium text-[#737373]"
                  >
                    Tallies
                  </th>
                  <th scope="col" className="px-3 py-3 text-xs font-medium text-[#737373]">
                    Last activity
                  </th>
                  <th scope="col" className="px-3 py-3 text-xs font-medium text-[#737373]">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((book) => (
                  <tr key={book.vault_id} className="border-b border-[#f5f5f5] last:border-b-0">
                    <td className="px-3 py-3 align-top">
                      <BookName book={book} />
                    </td>
                    <td className="px-3 py-3 align-top">
                      <BookOwner book={book} />
                    </td>
                    <td className="whitespace-nowrap px-3 py-3 align-top text-xs text-[#525252]">
                      {fmtDate(book.created_at)}
                    </td>
                    <td className="px-3 py-3 text-right align-top text-xs tabular-nums text-[#404040]">
                      {fmtInt(book.numbers)}
                    </td>
                    <td className="px-3 py-3 text-right align-top text-xs tabular-nums text-[#404040]">
                      {fmtInt(book.people)}
                    </td>
                    <td className="px-3 py-3 text-right align-top text-xs tabular-nums text-[#404040]">
                      {fmtInt(book.tallies)}
                    </td>
                    <td className="whitespace-nowrap px-3 py-3 align-top text-xs text-[#525252]">
                      {fmtDate(book.last_tally_at)}
                    </td>
                    <td className="px-3 py-3 align-top">{actions(book, true)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
      {pageCount > 1 ? (
        <nav
          aria-label="Books pages"
          className="mt-3 flex max-w-full flex-wrap items-center justify-end gap-2 sm:gap-3"
        >
          <button
            className={BUTTON}
            disabled={currentPage === 0}
            onClick={() => setPage(currentPage - 1)}
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
            onClick={() => setPage(currentPage + 1)}
          >
            <span className="hidden sm:inline">Next</span>
            <span className="sr-only sm:hidden">Next page</span>
            <Icon name="chevron" className="-rotate-90" />
          </button>
        </nav>
      ) : null}
    </section>
  );
}
// Book and owner text wraps between words only (break-words, not anywhere):
// in the table's auto layout, "anywhere" lets a column shrink until an email
// breaks mid-word; a whole-word minimum keeps it readable, and the table
// scrolls sideways instead when it must.
function BookName(props: { book: OutreachBook }) {
  const b = props.book;
  return (
    <div className="flex min-w-0 max-w-full flex-wrap items-center gap-2">
      <span
        className="min-w-0 max-w-full break-words text-sm font-medium text-[#404040]"
        dir="auto"
      >
        {b.name || "Unnamed book"}
      </span>
      {b.currency ? (
        <span className="rounded bg-[#f5f5f5] px-1.5 py-0.5 text-[10px] font-medium text-[#525252]">
          {b.currency}
        </span>
      ) : null}
      {b.archived ? <Pill tone="amber">Archived</Pill> : null}
    </div>
  );
}
function BookOwner(props: { book: OutreachBook }) {
  const b = props.book;
  // A long address may wrap after its @ first, so it never widens the table.
  const at = b.owner_email.indexOf("@");
  if (!b.owner_name && !b.owner_email && !b.owner_phone)
    return <p className="text-xs text-[#737373]">No owner details</p>;
  return (
    <div className="min-w-0 max-w-full text-xs leading-5 text-[#525252]">
      {b.owner_name ? (
        <p className="break-words font-medium text-[#404040]" dir="auto">
          {b.owner_name}
        </p>
      ) : null}
      {b.owner_email ? (
        <p className="break-words font-mono" dir="ltr">
          {at > 0 ? (
            <>
              {b.owner_email.slice(0, at + 1)}
              <wbr />
              {b.owner_email.slice(at + 1)}
            </>
          ) : (
            b.owner_email
          )}
        </p>
      ) : null}
      {b.owner_phone ? (
        <p className="font-mono tabular-nums" dir="ltr">
          {b.owner_phone}
        </p>
      ) : null}
    </div>
  );
}
// Exclude book / Exclude owner, with the inline reason form (ExcludeButton).
// A book without an owner account offers only the first. Stacked in the
// table, so the actions column stays one button wide and the owner column
// keeps an address on one line.
function BookActions(props: {
  book: OutreachBook;
  busy: boolean;
  stacked?: boolean;
  onExclude: (body: OutreachExclusionBody, message: string) => void;
}) {
  const b = props.book;
  const owner = bookOwnerLabel(b);
  return (
    <div
      className={
        props.stacked
          ? "flex min-w-0 max-w-full flex-col items-start gap-2"
          : "flex min-w-0 max-w-full flex-wrap items-center gap-2"
      }
    >
      <ExcludeButton
        label="Exclude book"
        ariaLabel={`Exclude book: ${b.name || b.vault_id}`}
        compact
        kind="vault"
        id={b.vault_id}
        busy={props.busy}
        onExclude={(body) => props.onExclude(body, `${b.name || "Book"} excluded`)}
      />
      {b.owner_account_id ? (
        <ExcludeButton
          label="Exclude owner"
          ariaLabel={`Exclude owner: ${owner}`}
          title={OWNER_EXCLUDE_TITLE}
          compact
          kind="account"
          id={b.owner_account_id}
          busy={props.busy}
          onExclude={(body) => props.onExclude(body, `${owner} excluded, with every book they own`)}
        />
      ) : null}
    </div>
  );
}

// Verified test sources, with the way back, under the Books list that feeds
// them. Excluding drops only that source's own contribution — an account's
// being its own number and every book it owns (2026-09-30) — and the card
// says so because a number that a real book also lists stays in the
// directory on purpose.
function ExclusionsCard(props: {
  exclusions: OutreachExclusion[];
  books: OutreachBook[];
  contacts: OutreachContact[];
  busy: boolean;
  onExclude: (body: OutreachExclusionBody, message: string) => void;
  onUndo: (exclusion: OutreachExclusion) => void;
}) {
  return (
    <Card
      title="Excluded sources"
      sub="Books, accounts and installs you verified as test data. A book drops its own listings; an account drops its own number and every book it owns; an install drops what it reported. A number that also appears in a real book stays listed. Undo puts a source back."
    >
      <BooksSection
        books={props.books}
        contacts={props.contacts}
        busy={props.busy}
        onExclude={props.onExclude}
      />
      <h3 className="mt-6 border-t border-[#f5f5f5] pt-5 text-sm font-semibold text-[#171717]">
        Excluded
        <span className="ml-1 font-normal tabular-nums text-[#737373]">
          {fmtInt(props.exclusions.length)}
        </span>
      </h3>
      {props.exclusions.length === 0 ? (
        <p className="mt-2 text-sm text-[#737373]">Nothing excluded.</p>
      ) : (
        <ul className="mt-2 grid min-w-0 grid-cols-1 gap-2" aria-label="Excluded sources">
          {props.exclusions.map((exclusion) => (
            <li
              key={`${exclusion.kind}:${exclusion.id}`}
              className="flex min-w-0 max-w-full flex-wrap items-center justify-between gap-3 rounded-lg border border-[#e5e5e5] bg-[#fafafa] p-3"
            >
              <div className="min-w-0 flex-1">
                <p className="flex min-w-0 flex-wrap items-center gap-2 text-sm font-medium text-[#404040]">
                  <Pill tone="gray">{EXCLUSION_KIND_LABELS[exclusion.kind] ?? exclusion.kind}</Pill>
                  <span className="min-w-0 [overflow-wrap:anywhere]" dir="auto">
                    {exclusion.label || exclusion.id}
                  </span>
                </p>
                <p className="mt-1 text-xs leading-5 text-[#737373] [overflow-wrap:anywhere]">
                  <span dir="auto">{exclusion.reason || "No reason given"}</span> ·{" "}
                  {fmtDateTime(exclusion.created_at)} ·{" "}
                  <span dir="ltr" className="font-mono">
                    {exclusion.id}
                  </span>
                </p>
              </div>
              <button
                className={SMALL_BUTTON}
                disabled={props.busy}
                aria-label={`Undo: ${exclusion.label || exclusion.id}`}
                onClick={() => props.onUndo(exclusion)}
              >
                Undo
              </button>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

// "Exclude this …" asks for a one-line reason right where it was clicked. No
// dialog and no inference: these buttons are the only way a source is excluded.
function ExcludeButton(props: {
  label: string;
  // The visible label first, then the source (WCAG 2.5.3), e.g. "Exclude
  // this book: Sabz Grocery"; the visible label alone is the same on every
  // row. The form's "Exclude" button shares it.
  ariaLabel: string;
  // What the exclusion takes with it, on both buttons (an account's books),
  // and as one line above the reason while the form is open (2026-09-30), so
  // the consequence is read before Exclude is pressed, not only on hover.
  title?: string;
  // A narrower reason field, for the Books table's actions column.
  compact?: boolean;
  kind: OutreachExclusionKind;
  id: string;
  busy: boolean;
  onExclude: (body: OutreachExclusionBody) => void;
}) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("test data");
  // useId (2026-09-30): the same book can be open in the Books list and in a
  // row's details at once, and an id built from the source would repeat.
  const inputId = useId();
  if (!open)
    return (
      <button
        className={SMALL_BUTTON}
        disabled={props.busy}
        aria-label={props.ariaLabel}
        title={props.title}
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
        props.onExclude({
          kind: props.kind,
          id: props.id,
          excluded: true,
          reason: reason.trim() || "test data",
        });
        setOpen(false);
      }}
    >
      {/* w-0 + min-w-full: the line takes the form's width without adding
          its own, so a sentence never widens the Books table's narrow
          actions column. */}
      {props.title ? (
        <p id={`${inputId}-effect`} className="w-0 min-w-full text-[11px] leading-4 text-[#737373]">
          {props.title}
        </p>
      ) : null}
      <label className="sr-only" htmlFor={inputId}>
        Reason for excluding
      </label>
      <input
        id={inputId}
        aria-describedby={props.title ? `${inputId}-effect` : undefined}
        autoFocus
        className={`${FIELD} ${props.compact ? "sm:w-40" : "sm:w-56"} sm:flex-none`}
        value={reason}
        maxLength={200}
        dir="auto"
        placeholder="Reason"
        onChange={(event) => setReason(event.target.value)}
      />
      <button
        type="submit"
        className={SMALL_BUTTON}
        disabled={props.busy}
        aria-label={props.ariaLabel}
        title={props.title}
      >
        Exclude
      </button>
      <button type="button" className={SMALL_BUTTON} onClick={() => setOpen(false)}>
        Cancel
      </button>
    </form>
  );
}

// A chip is a field that differs from the baseline it is given: the ACTIVE
// preset's filters while the view still matches a preset exactly, so a
// preset's own values — Prospects' +93 among them — never show as chips or
// as a reason for "Reset all" (2026-09-30); the defaults once the view
// matches no preset, so after one change on top of a preset every field that
// differs from the defaults, the preset's own included, is a chip.
function filterChips(
  filters: OutreachFilters,
  baseline: OutreachFilters,
): { key: keyof OutreachFilters; label: string }[] {
  const chips: { key: keyof OutreachFilters; label: string }[] = [];
  const changed = (key: keyof OutreachFilters) => filters[key] !== baseline[key];
  for (const select of SELECTS) {
    if (changed(select.key))
      chips.push({
        key: select.key,
        label: `${select.label}: ${select.options.find(([value]) => value === filters[select.key])?.[1]}`,
      });
  }
  if (changed("country")) {
    const country = filters.country ? dialCode(`${filters.country}0`).country : "";
    chips.push({
      key: "country",
      label: `Country: ${country || filters.country || "All countries"}`,
    });
  }
  for (const [key, label] of [
    ["platform", "Platform"],
    ["language", "Language"],
    ["source", "Source"],
  ] as const) {
    if (changed(key))
      chips.push({ key, label: `${label}: ${filters[key] ? humanValue(filters[key]) : "All"}` });
  }
  // mention_count counts distinct books (2026-09-30), so the chip says books.
  if (changed("minMentions"))
    chips.push({ key: "minMentions", label: `Books ≥ ${filters.minMentions}` });
  if (changed("minTallies"))
    chips.push({ key: "minTallies", label: `Tallies ≥ ${filters.minTallies}` });
  if (changed("minReceivable"))
    chips.push({ key: "minReceivable", label: `Receivable ≥ ${filters.minReceivable}` });
  if (changed("contactedFrom"))
    chips.push({ key: "contactedFrom", label: `Contacted from ${fmtDay(filters.contactedFrom)}` });
  if (changed("contactedTo"))
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
// The caption ("AF · mobile" on an invalid-number pill) is the numbering
// plan's own description; it rides inside the pill so the verdict and its
// reason never separate when the row wraps.
function Pill(props: { children: ReactNode; tone?: PillTone; caption?: string }) {
  return (
    <span
      className={`inline-flex min-w-0 max-w-full items-center rounded-md px-2 py-0.5 text-[11px] font-medium [overflow-wrap:anywhere] ${PILL_TONE[props.tone ?? "gray"]}`}
    >
      {props.children}
      {props.caption ? (
        <span className="ml-1 font-normal opacity-80">· {props.caption}</span>
      ) : null}
    </span>
  );
}

type RowProps = {
  rows: OutreachContact[];
  now: number;
  settings: Record<string, string>;
  expanded: Record<string, boolean>;
  selected: Record<string, boolean>;
  saving: boolean;
  busy: boolean;
  excluding: boolean;
  onToggle: (phone: string) => void;
  onSelect: (phone: string, on: boolean) => void;
  onLanguage: (contact: OutreachContact, lang: OutreachLang) => void;
  onStatus: (contact: OutreachContact, status: OutreachStatus) => void;
  onSent: (contact: OutreachContact) => void;
  onReplied: (contact: OutreachContact) => void;
  onNote: (contact: OutreachContact, note: string) => void;
  onRetry: (contact: OutreachContact) => void;
  onExclude: (body: OutreachExclusionBody, message: string) => void;
  onOpenChat: (contact: OutreachContact) => void;
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
  const lineType = numberTypeLabel(props.contact.number.type);
  return (
    <div className={`min-w-0 ${props.className ?? ""}`}>
      <button
        dir="ltr"
        className="min-h-11 max-w-full truncate rounded font-mono text-sm tabular-nums text-[#171717] hover:underline focus-visible:outline-2 focus-visible:outline-[#171717]"
        title="Copy number"
        onClick={props.onCopy}
      >
        {props.contact.phone}
      </button>
      <p className="mt-0.5 truncate text-[11px] text-[#a3a3a3]">
        {country && country !== code ? country : code}
        {carrier ? ` · ${carrier}` : ""}
        {lineType ? ` · ${lineType}` : ""}
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
// The row's Sent box records the FIRST message (2026-09-30): a tick records
// the outcome "sent" (version-checked); the box is ticked whenever a send is
// on record and has no untick, so it can neither un-count a message nor
// reset a row — resetting to New is the status menu, which never counts
// anything. A further message goes the way of every follow-up: open the
// chat, then Sent in "Awaiting outcome". Stopped rows wait for a status
// change, unreachable ones for Retry.
function SentControl(props: { contact: OutreachContact; disabled: boolean; onSent: () => void }) {
  const o = props.contact.outreach;
  const checked = o.contact_count > 0;
  const stopped = isStoppedStatus(o.status);
  const unreachable = isUnreachableStatus(o.status);
  return (
    <label
      className="flex min-h-11 min-w-0 cursor-pointer items-center gap-2 text-xs text-[#525252] md:min-h-8"
      title={
        checked
          ? `Recorded as sent ×${o.contact_count}. To record a further message, open the chat and use Sent in 'Awaiting outcome'.`
          : stopped
            ? "Change the status first."
            : unreachable
              ? "Press Retry first."
              : "Tick once the message is out (records the outcome 'sent')."
      }
    >
      <input
        type="checkbox"
        className={CHECKBOX}
        checked={checked}
        disabled={checked || stopped || unreachable || props.disabled}
        onChange={(event) => {
          if (event.target.checked) props.onSent();
        }}
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
// What a row offers for reaching the number (2026-09-30): the WhatsApp
// button (record-then-navigate, see openChat) and Copy message, which records
// "opened" too (see copyMessage); only Retry for Not on WhatsApp / Invalid;
// a muted "Stopped" for Declined / Do not contact, which the server refuses
// until the status changes. An invalid-per-plan number keeps the button as a
// manual override (Open next still skips it). The language both buttons would
// write in (messageLanguage) sits right before them (2026-09-30), so a
// collapsed row says which message a click sends; each button's accessible
// name keeps its visible text first and ends with that language. The small
// label itself is hidden from assistive tech, which hears it in both names.
function RowActions(props: {
  contact: OutreachContact;
  language: MessageLanguage;
  busy: boolean;
  onOpenChat: () => void;
  onCopy: () => void;
  onRetry: () => void;
}) {
  const { contact } = props;
  const status = contact.outreach.status;
  const language = LANGUAGE_NAMES[props.language];
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2">
      {isStoppedStatus(status) ? (
        <span
          className="inline-flex min-h-11 items-center rounded-md bg-[#f5f5f5] px-2.5 py-1 text-xs font-medium text-[#737373] md:min-h-8"
          title="Change the status first to contact this number."
        >
          Stopped
          <span className="sr-only">: change the status first to contact this number.</span>
        </span>
      ) : isUnreachableStatus(status) ? (
        <button
          className={SMALL_BUTTON}
          disabled={props.busy}
          onClick={props.onRetry}
          aria-label={`Retry: ${contact.phone}`}
          title={
            isNeverMessaged(contact)
              ? "Back to New; the queue can offer this number again."
              : "Back to New. It was messaged before, so the queue won't offer it; open it by hand."
          }
        >
          Retry
        </button>
      ) : (
        <>
          <span
            aria-hidden="true"
            className="text-[11px] font-medium text-[#737373]"
            title="The language WhatsApp and Copy message use for this number"
          >
            {language}
          </span>
          <button
            type="button"
            className={WA_BUTTON}
            disabled={props.busy}
            aria-label={`WhatsApp: open a chat with ${contact.phone} in ${language}`}
            title={
              !contact.number.valid
                ? "The numbering plan says this number is invalid"
                : contact.outreach.contact_count > 0
                  ? "Records 'opened', then opens the chat; use Sent in 'Awaiting outcome' once the message is out"
                  : "Records 'opened', then opens the chat; tick Sent once the message is out"
            }
            onClick={props.onOpenChat}
          >
            <Icon name="whatsapp" className="h-4 w-4" />
            WhatsApp
          </button>
          <button
            type="button"
            className={SMALL_BUTTON}
            disabled={props.busy}
            aria-label={`Copy message: ${contact.phone} in ${language}`}
            title="Copies the message and records 'opened'; record the outcome once it is sent"
            onClick={props.onCopy}
          >
            Copy message
          </button>
        </>
      )}
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
              {contactPills(contact, props.now).map((pill) => (
                <Pill key={pill.label} tone={pill.tone} caption={pill.caption}>
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
                onSent={() => props.onSent(contact)}
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
                language={messageLanguage(contact, props.settings)}
                busy={props.busy}
                onOpenChat={() => props.onOpenChat(contact)}
                onCopy={() => props.onCopyMessage(contact)}
                onRetry={() => props.onRetry(contact)}
              />
            </div>
            <button
              className="mt-2 flex min-h-11 min-w-0 w-full items-center justify-between gap-3 rounded-lg px-1 text-sm font-medium text-[#171717] focus-visible:outline-2 focus-visible:outline-[#171717]"
              aria-expanded={open}
              aria-controls={detailsId}
              aria-label={`${open ? "Hide details" : "View details"}: ${contactDisplayName(contact)}`}
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
                          {contactPills(contact, props.now).map((pill) => (
                            <Pill key={pill.label} tone={pill.tone} caption={pill.caption}>
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
                      onSent={() => props.onSent(contact)}
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
                      language={messageLanguage(contact, props.settings)}
                      busy={props.busy}
                      onOpenChat={() => props.onOpenChat(contact)}
                      onCopy={() => props.onCopyMessage(contact)}
                      onRetry={() => props.onRetry(contact)}
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
  const message = props.messageFor(contact);
  const o = contact.outreach;
  const openedKey = openedTemplateKey(contact);
  const openedIn = openedKey ? templateLanguage(openedKey) : undefined;
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
          <p className="mt-1 text-xs leading-5 text-[#737373]" dir="ltr">
            Numbering plan: {contact.number.valid ? "valid" : "invalid"}
            {contact.number.possible && !contact.number.valid ? " (possible)" : ""}
            {numberCaption(contact.number) ? ` · ${numberCaption(contact.number)}` : ""}
            {contact.number.national ? ` · ${contact.number.national}` : ""}
          </p>
        </div>
        <div className="flex min-w-0 max-w-full flex-wrap gap-2">
          {contactPills(contact, props.now).map((pill) => (
            <Pill key={pill.label} tone={pill.tone} caption={pill.caption}>
              {pill.label}
            </Pill>
          ))}
        </div>
      </div>
      <div className="grid min-w-0 grid-cols-1 gap-5 lg:grid-cols-2">
        <ShopkeeperBlock
          contact={contact}
          shopkeeper={contact.shopkeeper}
          excluding={props.excluding}
          onExclude={props.onExclude}
        />
        <CustomerBlock
          customer={contact.customer}
          excluding={props.excluding}
          onExclude={props.onExclude}
        />
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
            label="Opened"
            value={
              o.open_count
                ? `×${o.open_count} · last ${fmtDateTime(o.opened_at)}${o.pending_since ? ` · awaiting outcome since ${fmtDateTime(o.pending_since)}` : ""}`
                : "Not yet"
            }
          />
          <Detail
            label="Skipped"
            value={
              o.skipped_at
                ? `${fmtDateTime(o.skipped_at)}${isSkippedToday(contact, props.now) ? " · hidden from the queue today" : ""}`
                : "—"
            }
          />
          <Detail
            label="Flags"
            value={
              [
                contact.converted ? "Installed after contact" : "",
                contact.follow_up_due ? "Follow-up due" : "",
                o.pending_since ? "Awaiting outcome" : "",
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
            {/* Saved on the server for this number (2026-09-30), through the
                mark mutation: a write like any other, so it waits while
                anything is in flight. Its name carries the phone, since
                several rows can be open at once. On a pending row the chat
                is already open in the language it was opened in, which Sent
                records (openedTemplateKey), so a change here only reaches
                the next message; the hint says so. */}
            <label className="mt-4 flex min-w-0 flex-col text-[11px] font-medium text-[#737373]">
              Message language
              <select
                aria-label={`Message language for ${contact.phone}`}
                aria-describedby={openedIn ? `${props.id}-lang-opened` : undefined}
                className={`${SMALL_SELECT} mt-1 w-full`}
                value={o.lang}
                disabled={props.busy}
                onChange={(event) => {
                  const lang = event.target.value;
                  if (isOutreachLang(lang) && lang !== o.lang) props.onLanguage(contact, lang);
                }}
              >
                <option value="">
                  {`Use session choice (${sessionChoiceLabel(sessionLanguage(props.settings), contact.locale)})`}
                </option>
                <option value="fa">Dari</option>
                <option value="en">English</option>
              </select>
            </label>
            {openedIn ? (
              <p
                id={`${props.id}-lang-opened`}
                className="mt-1 text-[11px] leading-4 text-[#8c621a]"
              >
                This chat was opened in {LANGUAGE_NAMES[openedIn]}; a change applies to the next
                message.
              </p>
            ) : null}
            <p className="mt-1 text-[11px] leading-4 text-[#a3a3a3]">
              Dari or English here wins over the session choice in the Queue card.
            </p>
          </div>
          <div className="min-w-0">
            <p className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 text-[11px] font-medium text-[#737373]">
              Message preview
              <Pill tone="blue">{LANGUAGE_NAMES[message.language]}</Pill>
              <span dir="ltr" className="font-normal [overflow-wrap:anywhere]">
                {message.templateKey}
              </span>
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
                language={message.language}
                busy={props.busy}
                onOpenChat={() => props.onOpenChat(contact)}
                onCopy={() => props.onCopyMessage(contact)}
                onRetry={() => props.onRetry(contact)}
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
                    {TOUCH_LABELS[touch.kind] ?? touch.kind}
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
  excluding: boolean;
  onExclude: (body: OutreachExclusionBody, message: string) => void;
}) {
  const s = props.shopkeeper;
  const hasAccount = !!s && s.signed_in && !!s.account_id;
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
            <h5 className="text-xs font-semibold text-[#525252]">Sources</h5>
            <p className="mt-1 text-[11px] leading-4 text-[#737373]">
              Excluding a source drops only what it contributed — for an account, its own number and
              every book it owns; the number stays listed if a real book has it.
            </p>
            <div className="mt-2 grid min-w-0 grid-cols-1 gap-2">
              {hasAccount ? (
                <div className="flex min-w-0 max-w-full flex-wrap items-center justify-between gap-2 rounded-lg border border-[#e5e5e5] bg-[#fafafa] p-2">
                  <span className="min-w-0 text-xs text-[#525252] [overflow-wrap:anywhere]">
                    Account{" "}
                    <span dir="ltr" className="font-mono">
                      {s.account_id}
                    </span>
                  </span>
                  <ExcludeButton
                    label="Exclude this account"
                    ariaLabel={`Exclude this account: ${s.email || s.account_id}`}
                    title={OWNER_EXCLUDE_TITLE}
                    kind="account"
                    id={s.account_id}
                    busy={props.excluding}
                    onExclude={(body) => props.onExclude(body, "Account excluded")}
                  />
                </div>
              ) : null}
              {s.install_ids.map((installId) => (
                <div
                  key={installId}
                  className="flex min-w-0 max-w-full flex-wrap items-center justify-between gap-2 rounded-lg border border-[#e5e5e5] bg-[#fafafa] p-2"
                >
                  <span className="min-w-0 text-xs text-[#525252] [overflow-wrap:anywhere]">
                    Install{" "}
                    <span dir="ltr" className="font-mono">
                      {installId}
                    </span>
                  </span>
                  <ExcludeButton
                    label="Exclude this install"
                    ariaLabel={`Exclude this install: ${installId}`}
                    kind="install"
                    id={installId}
                    busy={props.excluding}
                    onExclude={(body) => props.onExclude(body, "Install excluded")}
                  />
                </div>
              ))}
              {!hasAccount && s.install_ids.length === 0 ? (
                <p className="text-xs text-[#737373]">No install ids reported.</p>
              ) : null}
            </div>
            {hasAccount ? (
              <p className="mt-2 text-[11px] leading-4 text-[#737373]">
                If this number is also the account's own phone, the account keeps this row listed;
                exclude the account to remove it.
              </p>
            ) : null}
          </div>
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
function CustomerBlock(props: {
  customer: OutreachCustomer | null;
  excluding: boolean;
  onExclude: (body: OutreachExclusionBody, message: string) => void;
}) {
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
              {/* Keyed by position too (2026-09-30): one book can list a
                  number twice, even under the same name. */}
              {c.listings.map((listing, index) => {
                const balance = parseMoney(listing.balance);
                return (
                  <div
                    key={`${listing.vault_id}-${index}`}
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
                    <div className="mt-2">
                      <ExcludeButton
                        label="Exclude this book"
                        ariaLabel={`Exclude this book: ${listing.vault_name || listing.vault_id}`}
                        kind="vault"
                        id={listing.vault_id}
                        busy={props.excluding}
                        onExclude={(body) =>
                          props.onExclude(body, `${listing.vault_name || "Book"} excluded`)
                        }
                      />
                    </div>
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
  saving: boolean;
  onSave: (key: string, value: string, message: string) => void;
}) {
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const merged = { ...props.settings, ...drafts };
  // The preview row's own language resolution: its per-number choice, else
  // the session's (the drafts never hold pref.message_lang), else its locale.
  const preview = props.preview ? buildMessage(props.preview, merged) : null;
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
              {props.preview.phone} · {LANGUAGE_NAMES[preview.language]} · {preview.templateKey}
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
  | "whatsapp"
  | "list"
  | "hourglass";
function Icon(props: { name: IconName; className?: string }) {
  const paths: Record<IconName, ReactNode> = {
    list: <path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" />,
    hourglass: <path d="M6 3h12M6 21h12M8 3v4l4 5-4 5v4M16 3v4l-4 5 4 5v4" />,
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
