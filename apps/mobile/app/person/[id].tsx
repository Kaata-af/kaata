import { Ionicons } from "@expo/vector-icons";
import * as Crypto from "expo-crypto";
import {
  useFocusEffect,
  useFocusEffect as useRouteFocusEffect,
  useLocalSearchParams,
  useRouter,
} from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Animated,
  AppState,
  BackHandler,
  KeyboardAvoidingView,
  Keyboard,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  type KeyboardEvent,
  View,
} from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { TallyDateFilterSheet } from "../../components/TallyDateFilterSheet";
import { BottomSheet } from "../../components/BottomSheet";
import { Chip } from "../../components/Chip";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { EmptyState } from "../../components/EmptyState";
import { TallyHighlight } from "../../components/TallyHighlight";
import { TallyFlowSummary } from "../../components/TallyFlowSummary";
import { CreditIntentList } from "../../components/CreditIntentList";
import { CreditStatusBadge } from "../../components/CreditStatusBadge";
import { EntryRow } from "../../components/EntryRow";
import { SharedAccountBadge } from "../../components/SharedAccountBadge";
import { SearchControlSlot } from "../../components/SearchControlSlot";
import { SelectionToolbar } from "../../components/SelectionToolbar";
import { summarizeSelectionEntries } from "../../lib/selection-summary";
import { useSheetMotionPreference } from "../../components/SheetBackdrop";
import { useCustomerGroups } from "../../lib/use-customer-groups";
import { LinkAccountDialog } from "../../components/LinkAccountDialog";
import { OverflowMenu } from "../../components/OverflowMenu";
import { OptionSheet } from "../../components/OptionSheet";
import { TOAST_LIFT, useToast, useToastOffset } from "../../components/Toast";
import { loadRelationshipAttribution, type EntryAttribution } from "../../lib/attribution";
import { colors } from "../../lib/colors";
import { getCurrentCurrencySymbol } from "../../lib/currency";
import {
  getLocalSelf,
  setAppMeta,
  getPerson,
  getSettlementSummary,
  listEntries,
  listArchivedSharedPeriodsForExport,
  listSettlementBoundaries,
  SettledChapterError,
  softDeleteEntry,
} from "../../lib/db";
import { getAccountIdSync, getActiveVaultIdSyncMaybe } from "../../lib/db-tx";
import { resolveAccountIdCandidates } from "../../lib/effective-account";
import {
  appendEntrySettled,
  RoleGateRejectionError,
  SettleNotZeroError,
} from "../../lib/event-log";
import {
  exportPersonStatement,
  savedMessage,
  type ExportDestination,
  type ExportFormat,
} from "../../lib/export";
import { useLedgerRefresh } from "../../lib/ledger-events";
import {
  bidiIsolate,
  ltrIsolate,
  rowDir,
  textDir,
  trackingSafe,
  useIsRTL,
} from "../../lib/direction";
import { fonts, sansLineHeight } from "../../lib/fonts";
import { formatAmount, formatDate } from "../../lib/format";
import { sumAmounts } from "../../lib/money";
import { getLocale, getShareLangPref, resolveShareLang, t, type LocaleCode } from "../../lib/i18n";
import { formatSettlementDate } from "../../lib/jalali";
import { useCalendar } from "../../lib/calendar";
import { shareKaataViaWhatsApp, type WhatsAppShareStage } from "../../lib/share";
import { filterTallies, noteSearchTerms } from "../../lib/tally-search";
import {
  filterTalliesByDate,
  formatDateRangeLabel,
  type TallyDateRange,
} from "../../lib/tally-date-filter";
import { summarizeTallyFlows } from "../../lib/tally-summary";
import {
  getLatestTabLinkForPerson,
  listPreLinkEntries,
  listFailedTabEntries,
  listTabSettlements,
} from "../../lib/tabs/db";
import { markTabNoticesSeen } from "../../lib/tabs/inbox-reads";
import {
  acceptEntry,
  disputeEntry,
  regenerateInviteLink,
  TabAuthUnavailableError,
  TabClosedError,
  TabPermissionError,
  unlinkContact,
  voidEntry,
  settleSharedTab,
} from "../../lib/tabs/link";
import { onTabApplied, requestTabSync, watchTab } from "../../lib/tabs/sync";
import { TabApiError, TabInputError, TabReviewFinalError } from "../../lib/tabs/errors";
import { applyEventMutex } from "../../lib/projection";
import type { TabLink, TabSettlement } from "../../lib/tabs/types";
import { afterSharedSettlement, sharedHistory, visibleTally } from "../../lib/tabs/chapters";
import { icon, radius, TOUCH_MIN, typography } from "../../lib/tokens";
import { useActiveVaultWriteCaps } from "../../lib/use-vault-role";
import { useMembersCount } from "../../lib/use-vault-summary";
import { tallyScrollTarget } from "../../lib/tally-viewport";
import { compareTallyReviews, type ReviewSnapshot } from "../../lib/tally-review-feedback";
import { takeSavedEntry } from "../../lib/recent-entry";
import { reminderOwnerScope } from "../../lib/customer-reminders";
import { useReminderPing } from "../../lib/use-reminder-ping";
import type { Entry, PersonWithBalance, Self } from "../../lib/types";

// Wording for a failed tab operation (accept / void / unlink / regenerate).
// One mapper so every catch site on this screen agrees: the vault role gate
// reads exactly like the local one (a demoted editor gets the same "view
// only" sentence for a tab tally as for a local one), a closed tab names
// itself, and no credential means "go online" rather than a generic failure.
function tabErrorMessage(err: unknown): string {
  if (err instanceof TabApiError && err.code === "credit_limit_exceeded")
    return t("credit.refusedChange");
  if (err instanceof TabApiError && err.code === "credit_confirmation_pending")
    return t("credit.pendingChange");
  if (err instanceof TabPermissionError) return t("entry.roleDenied");
  if (err instanceof TabReviewFinalError) return t("tab.reviewFinal");
  if (err instanceof TabClosedError) return t("tab.closed");
  if (err instanceof TabAuthUnavailableError) return t("tab.needsConnection");
  return t("entry.saveFailed");
}

// Shared empty map so a solo kaata (and the pre-load frame of a shared one)
// never allocates, and the identity stays stable across renders.
const EMPTY_ATTRIBUTION: Map<string, EntryAttribution> = new Map();

// The bottom dock is opaque, so it carries its own background this far below
// the screen edge. When a toast lifts it, that background (not see-through,
// tappable tally rows) fills the space underneath. The margin covers the
// spring's settle.
const DOCK_SKIRT = TOAST_LIFT + 12;

export default function PersonDetailScreen() {
  const router = useRouter();
  const toast = useToast();
  const toastOffset = useToastOffset();
  const [actionsHeight, setActionsHeight] = useState(100);
  // A toast sits behind the keyboard, so lifting the dock above an open
  // keyboard only made it jump while typing.
  const [keyboardShown, setKeyboardShown] = useState(false);
  const keyboardShownRef = useRef(false);
  const [searchFocused, setSearchFocused] = useState(false);
  const searchInputRef = useRef<TextInput>(null);
  const reducedMotion = useSheetMotionPreference();
  const keyboardRouteFocused = useRef(false);
  useRouteFocusEffect(
    useCallback(() => {
      keyboardRouteFocused.current = true;
      return () => {
        keyboardRouteFocused.current = false;
      };
    }, []),
  );
  const dismissSearchKeyboard = useCallback(() => {
    searchInputRef.current?.blur();
    setSearchFocused(false);
    Keyboard.dismiss();
  }, []);
  useEffect(() => {
    const syncLayout = (shown: boolean, event?: KeyboardEvent) => {
      // iOS KAV starts at the will event; waiting for didShow removed the
      // action row only after the keyboard arrived, causing a second jump.
      if (Platform.OS === "ios" && event && !reducedMotion && keyboardRouteFocused.current)
        Keyboard.scheduleLayoutAnimation(event);
      keyboardShownRef.current = shown;
      setKeyboardShown(shown);
    };
    const finishHide = () => {
      searchInputRef.current?.blur();
      setSearchFocused(false);
      keyboardShownRef.current = false;
      setKeyboardShown(false);
    };
    const show = Keyboard.addListener(
      Platform.OS === "ios" ? "keyboardWillShow" : "keyboardDidShow",
      (event) => syncLayout(true, event),
    );
    const hide = Keyboard.addListener(
      Platform.OS === "ios" ? "keyboardWillHide" : "keyboardDidHide",
      (event) => {
        syncLayout(false, event);
        if (Platform.OS !== "ios") finishHide();
      },
    );
    const didShow =
      Platform.OS === "ios"
        ? Keyboard.addListener("keyboardDidShow", () => syncLayout(true))
        : null;
    // Do not blur at willHide: an interactive drag may still be cancelled.
    const didHide =
      Platform.OS === "ios" ? Keyboard.addListener("keyboardDidHide", finishHide) : null;
    return () => {
      show.remove();
      hide.remove();
      didShow?.remove();
      didHide?.remove();
    };
  }, [reducedMotion]);
  const insets = useSafeAreaInsets();
  // Clerks can add; only editors and above can amend/review/cancel.
  const {
    canCreate,
    canAmend,
    canConfigureCredit,
    resolved: roleResolved,
  } = useActiveVaultWriteCaps(getActiveVaultIdSyncMaybe());
  const canManageCredit = roleResolved && canConfigureCredit;
  const { id, entryId, notificationKey, reminderId, reminderActionKey } = useLocalSearchParams<{
    id: string;
    entryId?: string;
    notificationKey?: string;
    reminderId?: string;
    reminderActionKey?: string;
  }>();
  const flowScope = `${getAccountIdSync() ?? "local"}:${getActiveVaultIdSyncMaybe() ?? "none"}:${id}`;
  const scrollRef = useRef<ScrollView>(null);
  const entriesCardY = useRef<number | null>(null);
  const entryPositions = useRef(new Map<string, { y: number; height: number }>());
  const viewport = useRef({ offset: 0, height: 0, lift: 0 });
  useEffect(() => {
    const listener = toastOffset.addListener(({ value }) => {
      viewport.current.lift = Math.max(0, -value);
    });
    return () => toastOffset.removeListener(listener);
  }, [toastOffset]);
  const highlightedRequest = useRef("");
  const [highlight, setHighlight] = useState<{ id: string; key: string } | null>(null);
  const [reviewHighlights, setReviewHighlights] = useState<
    Map<string, { key: string; status: "accepted" | "disputed" }>
  >(new Map());
  const reviewSnapshot = useRef<ReviewSnapshot | null>(null);
  const reviewEpoch = useRef(0);
  const reviewSequence = useRef(0);
  const visibleReviewIds = useRef(new Set<string>());
  const toastRef = useRef(toast);
  toastRef.current = toast;
  useEffect(() => {
    if (reviewHighlights.size === 0) return;
    const timer = setTimeout(() => setReviewHighlights(new Map()), 1800);
    return () => clearTimeout(timer);
  }, [reviewHighlights]);
  // Subscribes to locale changes — flipping language in Settings re-renders
  // this screen and all its descendants, so strings via t() refresh too.
  const isRTL = useIsRTL();
  const locale = getLocale();
  // Repaints the settled-chapter lines when the calendar OR the language
  // changes — the latter matters even at a fixed calendar, because language
  // picks the script ("5 Aug 2026" vs "۵ اگست ۲۰۲۶").
  const calendar = useCalendar();

  const [person, setPerson] = useState<PersonWithBalance | null>(null);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [self, setSelf] = useState<Self | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [sheetFor, setSheetFor] = useState<Entry | null>(null);
  const [confirmDeleteFor, setConfirmDeleteFor] = useState<Entry | null>(null);
  // Settle-up ("rule off the account", 2026-07-27). No persistent buttons:
  // the affordance is a ruled-line row that only exists at balance zero with
  // an open chapter, and settled history collapses behind one quiet row.
  const [settlement, setSettlement] = useState<{ count: number; lastSettledAtMs: number | null }>({
    count: 0,
    lastSettledAtMs: null,
  });
  // Every boundary (oldest→newest) — the full-history view draws each
  // ruled-off line with its settlement date, like a paper khata.
  const [boundaries, setBoundaries] = useState<number[]>([]);
  const [sharedSettlements, setSharedSettlements] = useState<TabSettlement[]>([]);
  const settlementRequest = useRef<{ id: string; throughSeq: number } | null>(null);
  const [showFullHistory, setShowFullHistory] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [dateRange, setDateRange] = useState<TallyDateRange | null>(null);
  const [dateSheetVisible, setDateSheetVisible] = useState(false);
  const screenScope = useRef(flowScope);
  screenScope.current = flowScope;
  const [selectionScope, setSelectionScope] = useState<string | null>(null);
  const [selectedEntryIds, setSelectedEntryIds] = useState<Set<string>>(new Set());
  const [confirmSelectionDelete, setConfirmSelectionDelete] = useState(false);
  const selectionConfirmationVersion = useRef(0);
  const selectionDeleteCount = useRef(0);
  const [selectionBusy, setSelectionBusy] = useState(false);
  const selectionBusyRef = useRef(false);
  useEffect(() => {
    setSearchQuery("");
    setDateRange(null);
    setDateSheetVisible(false);
    setSheetFor(null);
    dismissSearchKeyboard();
  }, [flowScope, entryId, notificationKey, dismissSearchKeyboard]);
  useEffect(() => {
    if (entryId) setShowFullHistory(true);
  }, [entryId, notificationKey]);
  const revealNotificationTally = useCallback(() => {
    const key = [id, entryId, notificationKey].join(":");
    if (
      !entryId ||
      !showFullHistory ||
      !entries.some((e) => e.id === entryId) ||
      highlightedRequest.current === key
    )
      return;
    const row = entryPositions.current.get(entryId);
    if (!row || entriesCardY.current == null || !viewport.current.height) return;
    highlightedRequest.current = key;
    const target = tallyScrollTarget({
      top: entriesCardY.current + row.y,
      height: row.height,
      offset: viewport.current.offset,
      viewport: viewport.current.height,
      bottomInset: actionsHeight + (keyboardShownRef.current ? 0 : viewport.current.lift),
    });
    if (target != null) scrollRef.current?.scrollTo({ y: target, animated: true });
    setHighlight({ id: entryId, key });
  }, [
    id,
    entryId,
    notificationKey,
    showFullHistory,
    entries,
    canCreate,
    actionsHeight,
    insets.bottom,
  ]);
  useEffect(() => {
    // Wait for the expanded history's layout; onLayout/content-size handle cold loads.
    const frame = requestAnimationFrame(revealNotificationTally);
    return () => cancelAnimationFrame(frame);
  }, [revealNotificationTally, entries]);
  const [confirmSettle, setConfirmSettle] = useState(false);
  const settlingRef = useRef(false);
  // L12: synchronous re-entry guard for the WhatsApp ping — the share awaits an
  // up-to-8s snapshot upload before opening WhatsApp, and without this a user
  // tapping repeatedly minted a separate 90-day shared-ledger token per tap.
  const [pingStage, setPingStage] = useState<WhatsAppShareStage | null>(null);
  const pinging = pingStage != null;
  // Offer a ping after a new tally or an in-app reminder View. Native taps
  // start the flow directly, so don't flash the manual nudge during loading.
  const [pingNudge, setPingNudge] = useState(false);
  useEffect(() => {
    if (reminderActionKey) setPingNudge(false);
    else if (reminderId) setPingNudge(true);
  }, [reminderId, reminderActionKey]);
  const pingBusyRef = useRef(false);
  const pingAbortRef = useRef<AbortController | null>(null);
  // Message-language picker for the ping, shown when share_lang_pref = 'ask'.
  const [askLangVisible, setAskLangVisible] = useState(false);
  const pingLanguageChosen = useRef(false);
  const pingLanguageTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelPing = useCallback(() => {
    pingLanguageChosen.current = true;
    setAskLangVisible(false);
    pingAbortRef.current?.abort();
    pingAbortRef.current = null;
    pingBusyRef.current = false;
    if (pingLanguageTimer.current) clearTimeout(pingLanguageTimer.current);
    pingLanguageTimer.current = null;
    setPingStage(null);
  }, []);
  useEffect(() => () => cancelPing(), [cancelPing]);
  // Statement export. It used to live on the EDIT screen, behind the pencil —
  // which hid it twice over. Nobody looks for "give me a copy of this account"
  // inside a form for changing someone's name, and the pencil only renders
  // when canAmend, so a clerk or viewer could never export a statement they
  // were perfectly entitled to read. Exporting is a READ; it belongs here,
  // next to the ledger it describes, ungated by write permission.
  const [exportSheetVisible, setExportSheetVisible] = useState(false);
  const [exporting, setExporting] = useState(false);
  const exportingRef = useRef(false);

  // MUTUAL TAB (docs/mutual-tab-design.md §4.4). `tabHistory` is the contact's
  // tab whether it is live or closed; `link` is the same row only while it is
  // OPEN, and is what every action reads — a closed tab accepts no writes.
  // While linked, `entries` are the tab's rows and `person.balance` is the tab
  // balance (D8); `preLink` holds the frozen local rows from before linking,
  // shown behind a fold and excluded from the balance because the opening
  // entry already carries their sum. Closing does not undo any of that: the
  // rows and the fold stay, so the history and the number both survive.
  const [tabHistory, setTabHistory] = useState<TabLink | null>(null);
  const link = tabHistory != null && tabHistory.closed_at == null ? tabHistory : null;
  const [preLink, setPreLink] = useState<Entry[]>([]);
  const [preLinkOpen, setPreLinkOpen] = useState(false);
  const [failedTallies, setFailedTallies] = useState<Entry[]>([]);
  const [failedTalliesOpen, setFailedTalliesOpen] = useState(false);
  const [flowHistory, setFlowHistory] = useState<{ scope: string; entries: Entry[] } | null>(null);
  const loadGeneration = useRef(0),
    loadMounted = useRef(true);
  useEffect(() => {
    loadMounted.current = true;
    return () => {
      loadMounted.current = false;
      loadGeneration.current++;
    };
  }, []);
  // The menu opens ONE invitation dialog: explanation, creation, and (only
  // without a saved number) delivery choices all stay on the same surface.
  const [inviteVisible, setInviteVisible] = useState(false);
  const [linkedSheetVisible, setLinkedSheetVisible] = useState(false);
  const [confirmRegenerate, setConfirmRegenerate] = useState(false);
  const [confirmUnlink, setConfirmUnlink] = useState(false);

  async function onExport(format: ExportFormat, destination: ExportDestination) {
    if (!id || exportingRef.current) return;
    exportingRef.current = true;
    setExporting(true);
    try {
      const outcome = await exportPersonStatement(id, format, destination);
      // Non-null only on a completed save to the phone — a share needs no
      // confirmation and a cancelled destination picker stays silent.
      const msg = savedMessage(t, bidiIsolate, outcome);
      if (msg) toast.push(msg, "success");
    } catch (err) {
      console.warn("[person] export failed", err);
      toast.push(t("personEdit.exportFailed"), "error");
    } finally {
      exportingRef.current = false;
      setExporting(false);
    }
  }
  // Viewer read-only gate: false only when I'm a viewer on the active (shared)
  // kaata. Hides give/receive, edit-person, and entry edit/delete.

  // ATTRIBUTION — "who wrote this tally", for SHARED kaatas only.
  //
  // The gate is the whole design. In a solo kaata every answer is "you", so a
  // chip on every row would be decoration that costs the ledger its calm; the
  // screen therefore doesn't even run the query. useMembersCount floors at 1
  // and only exceeds it once the members mirror really holds someone else, so
  // the feature switches itself on the moment a kaata becomes shared and off
  // again if it stops being.
  const activeVaultId = getActiveVaultIdSyncMaybe();
  // Every role sees which groups a customer is in; only managers edit them.
  const customerGroups = useCustomerGroups(activeVaultId);
  const personGroupNames = (customerGroups.groupsByPerson[id] ?? [])
    .map((groupId) => customerGroups.groups.find((group) => group.id === groupId)?.name)
    .filter((name): name is string => !!name);
  const membersCount = useMembersCount(activeVaultId);
  const isShared = membersCount > 1;
  const [attribution, setAttribution] = useState<Map<string, EntryAttribution>>(EMPTY_ATTRIBUTION);

  useEffect(() => {
    if (!isShared || !activeVaultId || entries.length === 0) {
      // Drop any map from a kaata we've navigated away from, but don't churn
      // a fresh empty Map (and a re-render) when there was nothing anyway.
      setAttribution((prev) => (prev.size === 0 ? prev : EMPTY_ATTRIBUTION));
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        // One query per distinct relationship. v1 collapses a person to a
        // single 'peer' relationship — the settle path assumes it too — but
        // deriving the set costs nothing and can't be wrong.
        const relationshipIds = Array.from(
          new Set(entries.map((e) => e.relationship_id).filter(Boolean)),
        );
        const selfIds = await resolveAccountIdCandidates(getAccountIdSync());
        const maps = await Promise.all(
          relationshipIds.map((rid) => loadRelationshipAttribution(activeVaultId, rid, selfIds)),
        );
        if (cancelled) return;
        const merged = new Map<string, EntryAttribution>();
        for (const m of maps) for (const [entryId, value] of m) merged.set(entryId, value);
        setAttribution(merged);
      } catch (err) {
        // Never fails the screen: the rows just render the way they did
        // before attribution existed.
        console.warn("[person] attribution load failed", err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isShared, activeVaultId, entries]);

  // Chapter view: entries after the latest settlement boundary. Boundary
  // compares created_at, which the applier sets to the entry's BUSINESS date
  // (occurred_at) — so a deliberately backdated entry files into the settled
  // chapter it belongs to; the balance (always all-time) is unaffected, and
  // "view all" reveals everything.
  //
  // Shared chapters use server sequence, so backdating a new tally can never
  // tuck it behind an old settlement. Local boundaries only apply locally.
  const displayedEntries = useMemo(() => entries.filter(visibleTally), [entries]);
  const flowSummary = useMemo(
    () => summarizeTallyFlows(flowHistory?.scope === flowScope ? flowHistory.entries : []),
    [flowHistory, flowScope],
  );
  const searchTerms = useMemo(() => noteSearchTerms(searchQuery), [searchQuery]);
  const searching = searchTerms.length > 0 || dateRange != null;
  const searchingRef = useRef(searching);
  searchingRef.current = searching;
  const matchedEntries = useMemo(
    () => filterTalliesByDate(filterTallies(displayedEntries, searchTerms), dateRange),
    [displayedEntries, searchTerms, dateRange],
  );
  const matchedPreLink = useMemo(
    () => filterTalliesByDate(filterTallies(preLink, searchTerms), dateRange),
    [preLink, searchTerms, dateRange],
  );
  const matchedFailedTallies = useMemo(
    () => filterTalliesByDate(filterTallies(failedTallies, searchTerms), dateRange),
    [failedTallies, searchTerms, dateRange],
  );
  const hasTallies = entries.length > 0 || preLink.length > 0 || failedTallies.length > 0;
  const dateRangeLabel = formatDateRangeLabel(dateRange, locale, calendar);
  const searchResultCount =
    matchedEntries.length + matchedPreLink.length + matchedFailedTallies.length;
  const sharedThroughSeq = sharedSettlements.at(-1)?.through_seq ?? 0;
  const settledCount = tabHistory ? sharedSettlements.length : settlement.count;
  const chapterEntries = useMemo(
    () =>
      tabHistory
        ? displayedEntries.filter((e) => afterSharedSettlement(e, sharedThroughSeq))
        : settlement.lastSettledAtMs == null
          ? displayedEntries
          : displayedEntries.filter((e) => e.created_at > settlement.lastSettledAtMs!),
    [displayedEntries, settlement.lastSettledAtMs, tabHistory, sharedThroughSeq],
  );
  // COHERENCE RULE (review fix — the load-bearing safety property): the
  // collapse only engages while the current chapter's sum EXACTLY explains
  // the balance. Any way the boundary can lie — an offline entry syncing in
  // with a pre-boundary business date, a retro-edit/delete inside settled
  // history from another device, clock skew — makes the view fall OPEN
  // instead of hiding money. Nothing behind the fold can ever account for
  // the number in the header.
  // Rejected tallies remain visible but contribute nothing to the balance.
  const chapterSum = useMemo(
    () =>
      sumAmounts(
        chapterEntries.map((e) =>
          e.tab?.voided || e.tab?.status === "disputed"
            ? 0
            : e.type === "debt"
              ? e.amount_afn
              : -e.amount_afn,
        ),
      ),
    [chapterEntries],
  );
  const chapterCoherent = person == null || chapterSum === person.balance;
  const effectiveShowFull = showFullHistory || !chapterCoherent;
  const visibleEntries = effectiveShowFull ? displayedEntries : chapterEntries;

  // Full-history render list: entries interleaved with the ruled-off lines,
  // each marker at its chronological position with the settlement date —
  // like the visible lines in a paper khata. Adjacent markers (a concurrent
  // double-settle artifact) collapse to one; markers below the oldest entry
  // have nothing to rule off and are dropped.
  type HistoryItem =
    | { kind: "entry"; entry: Entry }
    | { kind: "marker"; ms: number; settlement?: TabSettlement };
  const withLocalMarkers = useCallback(
    (list: Entry[]): HistoryItem[] => {
      const items: HistoryItem[] = [];
      const desc = [...boundaries].sort((a, b) => b - a);
      let bi = 0;
      for (const e of list) {
        while (bi < desc.length && desc[bi] >= e.created_at) {
          if (items.length === 0 || items[items.length - 1].kind !== "marker") {
            items.push({ kind: "marker", ms: desc[bi] });
          }
          bi++;
        }
        items.push({ kind: "entry", entry: e });
      }
      return items;
    },
    [boundaries],
  );
  // Searching spans the full ledger, including settled chapters. The normal
  // page retains its chapter fold once the filters are cleared.
  const historyItems = useMemo<HistoryItem[]>(() => {
    if (searching) {
      const items = tabHistory
        ? sharedHistory(matchedEntries, sharedSettlements)
        : withLocalMarkers(matchedEntries);
      const shown = items.filter(
        (item, i) => item.kind === "entry" || items[i - 1]?.kind !== "marker",
      );
      while (shown.at(-1)?.kind === "marker") shown.pop();
      return shown;
    }
    if (tabHistory && effectiveShowFull) return sharedHistory(displayedEntries, sharedSettlements);
    if (!effectiveShowFull || tabHistory || boundaries.length === 0)
      return visibleEntries.map((entry) => ({ kind: "entry", entry }));
    return withLocalMarkers(displayedEntries);
  }, [
    searching,
    matchedEntries,
    tabHistory,
    effectiveShowFull,
    displayedEntries,
    sharedSettlements,
    boundaries.length,
    visibleEntries,
    withLocalMarkers,
  ]);
  // Shared and ruled-off tallies retain their existing individual workflows.
  // Eligibility spans this contact's full history. Search filters only decide
  // which eligible rows Select all toggles; already selected rows stay selected.
  const selecting =
    selectionScope === flowScope &&
    flowHistory?.scope === flowScope &&
    roleResolved &&
    canAmend &&
    !tabHistory;
  const selectableEntries = useMemo(
    () =>
      flowHistory?.scope === flowScope && roleResolved && canAmend && !tabHistory
        ? displayedEntries.filter(
            (entry) =>
              !entry.tab &&
              (settlement.lastSettledAtMs == null || entry.created_at > settlement.lastSettledAtMs),
          )
        : [],
    [
      flowHistory?.scope,
      flowScope,
      displayedEntries,
      roleResolved,
      canAmend,
      tabHistory,
      settlement.lastSettledAtMs,
    ],
  );
  const selectableIds = useMemo(
    () => new Set(selectableEntries.map((entry) => entry.id)),
    [selectableEntries],
  );
  const selectedEntries = selecting
    ? selectableEntries.filter((entry) => selectedEntryIds.has(entry.id))
    : [];
  const visibleSelectableEntries = historyItems.flatMap((item) =>
    item.kind === "entry" && selectableIds.has(item.entry.id) ? [item.entry] : [],
  );
  const allVisibleSelected =
    visibleSelectableEntries.length > 0 &&
    visibleSelectableEntries.every((entry) => selectedEntryIds.has(entry.id));
  const selectionSummary = summarizeSelectionEntries(
    selectedEntries.map((entry) => ({
      amount: entry.amount_afn,
      direction: entry.type === "debt" ? "collect" : "pay",
    })),
  );
  const selectionContext = useRef({ scope: flowScope, selecting, eligible: selectableIds });
  selectionContext.current = { scope: flowScope, selecting, eligible: selectableIds };
  const closeSelection = useCallback(() => {
    if (selectionBusyRef.current) return;
    selectionConfirmationVersion.current++;
    selectionContext.current.selecting = false;
    setSelectionScope(null);
    setSelectedEntryIds(new Set());
    setConfirmSelectionDelete(false);
  }, []);
  useEffect(() => {
    if (!selecting) {
      setSelectionScope(null);
      setSelectedEntryIds((before) => (before.size ? new Set() : before));
      setConfirmSelectionDelete(false);
      return;
    }
    setSelectedEntryIds((before) => {
      const next = new Set([...before].filter((entryId) => selectableIds.has(entryId)));
      return next.size === before.size ? before : next;
    });
    // A remote settlement or deletion can remove the last eligible row.
    if (!selectableIds.size && !selectionBusyRef.current) closeSelection();
  }, [selecting, selectableIds, closeSelection]);
  useEffect(() => closeSelection(), [entryId, notificationKey, closeSelection]);
  useFocusEffect(
    useCallback(() => {
      return () => {
        // Stop a pending batch before its next write if navigation changes.
        selectionContext.current.selecting = false;
        setSelectionScope(null);
        setSelectedEntryIds(new Set());
        setConfirmSelectionDelete(false);
        selectionConfirmationVersion.current++;
        setDateSheetVisible(false);
        setSheetFor(null);
        dismissSearchKeyboard();
      };
    }, [dismissSearchKeyboard]),
  );
  const screenIsCurrent = useCallback(
    () =>
      loadMounted.current &&
      keyboardRouteFocused.current &&
      screenScope.current === flowScope &&
      `${getAccountIdSync() ?? "local"}:${getActiveVaultIdSyncMaybe() ?? "none"}:${id}` ===
        flowScope,
    [flowScope, id],
  );
  const startSelection = useCallback(
    (entry?: Entry) => {
      if (
        selectionBusyRef.current ||
        !selectableIds.size ||
        !selectionContext.current.eligible.size ||
        !screenIsCurrent() ||
        selectionContext.current.scope !== flowScope ||
        (entry != null && !selectionContext.current.eligible.has(entry.id))
      )
        return;
      dismissSearchKeyboard();
      setSheetFor(null);
      setDateSheetVisible(false);
      setSelectionScope(flowScope);
      setSelectedEntryIds(new Set(entry && selectableIds.has(entry.id) ? [entry.id] : []));
    },
    [selectableIds, flowScope, screenIsCurrent, dismissSearchKeyboard],
  );
  const toggleSelection = useCallback(
    (entry: Entry) => {
      if (
        selectionBusyRef.current ||
        !screenIsCurrent() ||
        !selectionContext.current.selecting ||
        !selectionContext.current.eligible.has(entry.id)
      )
        return;
      setSelectedEntryIds((before) => {
        const next = new Set(before);
        if (next.has(entry.id)) next.delete(entry.id);
        else next.add(entry.id);
        return next;
      });
    },
    [screenIsCurrent],
  );
  useRouteFocusEffect(
    useCallback(() => {
      const back = BackHandler.addEventListener("hardwareBackPress", () => {
        if (!selectionContext.current.selecting) return false;
        closeSelection();
        return true;
      });
      return () => back.remove();
    }, [closeSelection]),
  );
  visibleReviewIds.current = new Set(
    historyItems.flatMap((item) => (item.kind === "entry" ? [item.entry.id] : [])),
  );
  const sharedReviewPending = entries.some(
    (e) =>
      e.tab &&
      (e.tab.local_pending ||
        (!e.tab.voided && e.tab.kind !== "void" && e.tab.status === "pending")),
  );
  const unsettledOriginalCount = tabHistory
    ? entries.filter((e) => e.tab?.kind !== "void" && afterSharedSettlement(e, sharedThroughSeq))
        .length
    : chapterEntries.length;
  const canSettle =
    canAmend &&
    (!tabHistory || (!!link && !sharedReviewPending)) &&
    chapterCoherent &&
    person != null &&
    person.balance === 0 &&
    unsettledOriginalCount > 0;

  async function onSettle() {
    setConfirmSettle(false);
    if (!person || settlingRef.current || !canSettle) return;
    settlingRef.current = true;
    try {
      // Both paths recheck the balance under their authoritative transaction.
      // Shared boundaries use sequence; local boundaries use the business date.
      if (tabHistory) {
        if (!link) throw new TabClosedError();
        const throughSeq = Math.max(0, ...entries.map((e) => e.tab?.seq ?? 0));
        if (!settlementRequest.current || settlementRequest.current.throughSeq !== throughSeq) {
          settlementRequest.current = { id: Crypto.randomUUID(), throughSeq };
        }
        await settleSharedTab(link, settlementRequest.current.id);
        settlementRequest.current = null;
      } else {
        const settledAtMs = Math.max(Date.now(), ...chapterEntries.map((e) => e.created_at + 1));
        await appendEntrySettled({
          relationshipId: chapterEntries[0].relationship_id,
          settledAtMs,
        });
      }
      setShowFullHistory(false);
      toast.push(t("person.settle.done"), "success");
      await load();
    } catch (err) {
      if (err instanceof TabApiError || err instanceof TabInputError) {
        const code = err.code;
        toast.push(
          t(
            code === "settlement_not_zero"
              ? "person.settle.notZero"
              : code === "settlement_pending"
                ? "tab.settle.pending"
                : code === "stale_settlement" || code === "settlement_empty"
                  ? "tab.settle.changed"
                  : "tab.settle.failed",
          ),
          "error",
        );
        if (tabHistory) requestTabSync(tabHistory.tab_id);
        await load();
      } else if (err instanceof SettleNotZeroError) {
        toast.push(t("person.settle.notZero"), "error");
        await load(); // refresh — the balance the user saw was stale
      } else if (err instanceof RoleGateRejectionError) {
        toast.push(t("entry.roleDenied"), "error");
      } else {
        console.warn("[person] settle failed", err);
        toast.push(t("person.settle.failed"), "error");
      }
    } finally {
      settlingRef.current = false;
    }
  }

  // Send the WhatsApp ping in the given message language (already resolved
  // from share_lang_pref, or picked in the ask-sheet).
  const sendPing = async (lang?: LocaleCode) => {
    if (!person || pingBusyRef.current || (lang == null && askLangVisible)) return;
    pingBusyRef.current = true;
    const controller = new AbortController();
    pingAbortRef.current = controller;
    setPingStage("preparing");
    try {
      if (lang == null) {
        const pref = await getShareLangPref();
        if (controller.signal.aborted) return;
        if (pref === "ask") {
          pingLanguageChosen.current = false;
          setAskLangVisible(true);
          return;
        }
        lang = resolveShareLang(pref);
      }
      const ok = await shareKaataViaWhatsApp(
        { id: person.id, name: person.name, phone: person.phone },
        person.balance,
        self,
        // Full history on the wire (the web view collapses settled chapters
        // itself); the boundary + count let both the message and the page
        // carry the "N accounts settled together" trust line.
        entries,
        lang,
        // D8: once the contact is linked, `entries` above ARE the tab's rows
        // and the settle-up boundaries below belong to the pre-link local
        // book, which is not on this bill at all. Sending them would print a
        // dated ruled-off line and an "N accounts settled together" trust
        // line with no rows behind either — on a document the paper rule
        // makes the recipient's permanent asset. lib/export/data.ts drops
        // the same boundaries for the same reason.
        tabHistory
          ? { settledChapters: 0, settledBoundaryMs: null, settledBoundaries: [] }
          : {
              settledChapters: settlement.count,
              settledBoundaryMs: settlement.lastSettledAtMs,
              settledBoundaries: boundaries,
            },
        (stage) => {
          if (pingAbortRef.current === controller && !controller.signal.aborted)
            setPingStage(stage);
        },
        controller.signal,
      );
      if (!ok && !controller.signal.aborted) toast.push(t("share.whatsappUnavailable"), "error");
    } catch (err) {
      if (!controller.signal.aborted) {
        console.warn("[person] WhatsApp reminder failed", err);
        toast.push(t("share.whatsappUnavailable"), "error");
      }
    } finally {
      if (pingAbortRef.current === controller) {
        pingAbortRef.current = null;
        pingBusyRef.current = false;
        setPingStage(null);
      }
    }
  };

  useReminderPing({
    actionKey: reminderActionKey,
    reminderId,
    personId: id,
    vaultId: getActiveVaultIdSyncMaybe(),
    ownerScope: reminderOwnerScope(),
    ready:
      loaded &&
      !loadFailed &&
      person?.id === id &&
      entries.length > 0 &&
      flowHistory?.scope === flowScope,
    busy: pinging || askLangVisible,
    onStart: () => {
      if (pingBusyRef.current || askLangVisible) return;
      setPingNudge(false);
      void sendPing();
    },
    onCancel: cancelPing,
  });

  // The link load() last found (open OR closed), for the marks below that
  // must not wait on state.
  const latestLink = useRef<TabLink | null>(null);

  // Returns the contact's latest tab link — open OR closed — so the focus
  // effect and the pull listener can ask for a sync and mark the tab's
  // notices seen without waiting on state; every other caller ignores it.
  const load = useCallback(async (): Promise<TabLink | null> => {
    const generation = ++loadGeneration.current;
    const account = getAccountIdSync(),
      vault = getActiveVaultIdSyncMaybe();
    const scope = `${account ?? "local"}:${vault ?? "none"}:${id}`;
    const current = () =>
      loadMounted.current &&
      generation === loadGeneration.current &&
      getAccountIdSync() === account &&
      getActiveVaultIdSyncMaybe() === vault;
    if (!id) {
      if (current()) {
        setFlowHistory(null);
        setLoaded(true);
      }
      return null;
    }
    const epoch = reviewEpoch.current;
    // Guarded — an unhandled rejection here previously left the screen on
    // a permanent blank state with setLoaded never flipping.
    try {
      // Bind the displayed entries and settlement markers to one revision.
      // Tab pulls and local writers use this same lock; otherwise a newer
      // link revision could silently authorize clearing entries never shown.
      const { p, list, s, settle, bounds, tl, before, refused, sharedMarkers, priorPeriods } =
        await applyEventMutex.runExclusive(async () => {
          const [p, list, s, settle, bounds, tl] = await Promise.all([
            getPerson(id),
            listEntries(id),
            getLocalSelf(),
            getSettlementSummary(id),
            listSettlementBoundaries(id),
            getLatestTabLinkForPerson(id),
          ]);
          const before = tl ? await listPreLinkEntries(tl) : [];
          const refused = tl
            ? await listFailedTabEntries(tl.relationship_id, {
                excludeCreditRefused: true,
              })
            : [];
          const sharedMarkers = tl ? await listTabSettlements(tl.tab_id) : [];
          const priorPeriods = tl ? await listArchivedSharedPeriodsForExport(id) : [];
          return { p, list, s, settle, bounds, tl, before, refused, sharedMarkers, priorPeriods };
        });
      if (!current()) return null;
      // Earlier closed tabs remain known handovers, even after a new opening
      // carries their net balance. Keep them out of current money and rows.
      setFlowHistory({
        scope,
        entries: [...list, ...before, ...priorPeriods.flatMap((period) => period.entries)],
      });
      setPerson(p);
      setEntries(list);
      // Reveal a newly saved tally even if the previous filter would hide it.
      if (takeSavedEntry(id)) {
        if (searchingRef.current) {
          setSearchQuery("");
          setDateRange(null);
        }
        // The moment a customer should hear about a tally is right after it
        // is written: offer the WhatsApp ping then (audit #1).
        setPingNudge(true);
      }
      if (epoch === reviewEpoch.current && focused.current && AppState.currentState === "active") {
        const { snapshot, changes } = compareTallyReviews(reviewSnapshot.current, list);
        reviewSnapshot.current = snapshot;
        // A hidden search result or folded chapter must not produce feedback
        // for a tally the user wasn't looking at. Consuming the new snapshot
        // also prevents replay when that row is revealed later.
        const visible = changes.filter((change) => visibleReviewIds.current.has(change.entry.id));
        if (visible.length > 0) {
          const sequence = ++reviewSequence.current;
          setReviewHighlights(
            new Map(
              visible.map(({ entry, status }) => [entry.id, { key: `${id}:${sequence}`, status }]),
            ),
          );
          setHighlight((current) =>
            current && visible.some(({ entry }) => entry.id === current.id) ? null : current,
          );
          const first = visible[0];
          toastRef.current.push(
            visible.length === 1
              ? t(first.status === "accepted" ? "tab.feedback.accepted" : "tab.feedback.rejected", {
                  amount: bidiIsolate(
                    `${formatAmount(first.entry.amount_afn)} ${getCurrentCurrencySymbol()}`,
                  ),
                })
              : (() => {
                  // Several at once: say how many went each way, so a
                  // rejection is not hidden inside "N reviewed" (audit #13).
                  const rejected = visible.filter((change) => change.status === "disputed").length;
                  const accepted = visible.length - rejected;
                  return rejected === 0
                    ? t("tab.feedback.manyAccepted", { count: accepted })
                    : accepted === 0
                      ? t("tab.feedback.manyRejected", { count: rejected })
                      : t("tab.feedback.mixed", { accepted, rejected });
                })(),
            "info",
          );
        }
      }
      setSelf(s);
      setSettlement(settle);
      setBoundaries(bounds);
      setSharedSettlements(sharedMarkers);
      setTabHistory(tl);
      latestLink.current = tl;
      setPreLink(before);
      setFailedTallies(refused);
      setLoadFailed(false);
      return tl;
    } catch (err) {
      if (!current()) return null;
      console.warn("[person] load failed", err);
      setLoadFailed(true);
      return null;
    } finally {
      if (current()) setLoaded(true);
    }
  }, [id]);

  // "Handled means read" (lib/tabs/inbox-reads.ts markTabNoticesSeen), this
  // screen's share of it: with a linked contact's rows on screen, its
  // notices up to the applied rev are handled. `focused` is navigation focus
  // (true between focus and blur) and is NOT visibility — the route stays
  // focused while the app sits behind the lock screen, and pulls run there
  // too — so every mark also asks AppState, and a load or a pull that lands
  // after the user left, or while the app is in the background, marks
  // nothing they never saw. `latestLink` (above) is what load() last found,
  // for the return-to-foreground mark.
  const focused = useRef(false);
  const seen = useCallback((tl: TabLink | null) => {
    // Filtered tallies are not read until the full ledger is visible again.
    if (searchingRef.current) return;
    if (tl) markTabNoticesSeen(tl, { focused: focused.current, appState: AppState.currentState });
  }, []);
  useEffect(() => {
    if (!searching) seen(latestLink.current);
  }, [searching, seen]);

  // Person-screen focus is one of the three pull triggers (D13; the others are
  // foreground and the fallback loop). Only HERE — not on every load(): a pull
  // fires onTabApplied, which calls load(), and a sync request in load()
  // would make that a loop.
  useFocusEffect(
    useCallback(() => {
      focused.current = true;
      reviewEpoch.current++;
      reviewSnapshot.current = null;
      setReviewHighlights(new Map());
      // While this screen shows a shared account, the sync loop keeps it on
      // its 5 s backstop (other links wait for the minute sweep).
      let active = true;
      let stopWatch: (() => void) | null = null;
      void load().then((tl) => {
        if (!tl) return;
        // Only an OPEN tab is worth syncing; a closed one never changes again.
        if (tl.closed_at == null) {
          requestTabSync(tl.tab_id);
          if (active) stopWatch = watchTab(tl.tab_id);
        }
        // Decision A4: the screen is up with the tab's rows on it, so its
        // notices up to the applied rev are handled — unless the user left
        // (or the app did) while the load was in flight.
        seen(tl);
      });
      // Back in the foreground with this screen still up: the rows are
      // visible again, so what the phone had applied by now is seen. A pull
      // the sync loop kicks at the same moment re-marks through its newer
      // rev via the listener below, once its rows are on screen.
      const app = AppState.addEventListener("change", (state) => {
        // Loads that finish while the app is away are not seen, so they must
        // not move the baseline; the snapshot keeps what was last on screen.
        // On return, reload and compare against it: a decision made while the
        // phone was locked is cued once, and the next live one is not eaten as
        // a fresh baseline (audit #13: both used to pass silently).
        reviewEpoch.current++;
        setReviewHighlights(new Map());
        if (state === "active") {
          seen(latestLink.current);
          void load();
        }
      });
      return () => {
        active = false;
        stopWatch?.();
        focused.current = false;
        reviewEpoch.current++;
        reviewSnapshot.current = null;
        setReviewHighlights(new Map());
        cancelPing();
        app.remove();
      };
    }, [load, seen, cancelPing]),
  );

  // Live refresh: re-load when a sync applies events for the active vault, so a
  // remote entry/payment for this person appears without navigating away/back.
  useLedgerRefresh(getActiveVaultIdSyncMaybe(), load);

  async function deleteSelectedTallies() {
    setConfirmSelectionDelete(false);
    if (selectionBusyRef.current || !selecting || !selectedEntries.length) return;
    const targets = selectedEntries.map((entry) => entry.id);
    const capturedAccountId = getAccountIdSync();
    const capturedVaultId = getActiveVaultIdSyncMaybe();
    if (!capturedVaultId) return;
    const capturedScope = flowScope;
    const stillCurrent = () =>
      selectionContext.current.selecting &&
      selectionContext.current.scope === capturedScope &&
      getAccountIdSync() === capturedAccountId &&
      getActiveVaultIdSyncMaybe() === capturedVaultId;
    selectionBusyRef.current = true;
    setSelectionBusy(true);
    const deleted = new Set<string>();
    let pendingCreditChanges = 0;
    try {
      for (const entryId of targets) {
        if (!stillCurrent()) break;
        if (!selectionContext.current.eligible.has(entryId)) continue;
        try {
          await softDeleteEntry(entryId, {
            vaultId: capturedVaultId,
            accountId: capturedAccountId,
          });
          deleted.add(entryId);
        } catch (err) {
          if (err instanceof Error && err.name === "CreditMutationAdmissionError") {
            if ((err as Error & { status: string }).status === "pending") pendingCreditChanges++;
            continue;
          }
          console.warn("[person] bulk softDeleteEntry failed", err);
          // Stop on a policy change; an authoritative write guard remains the
          // final check if permissions or settlement changed during the batch.
          if (err instanceof SettledChapterError || err instanceof RoleGateRejectionError) break;
        }
      }
      if (!stillCurrent()) return;
      setSelectedEntryIds(
        (before) => new Set([...before].filter((entryId) => !deleted.has(entryId))),
      );
      if (deleted.size === targets.length) {
        setSelectionScope(null);
        toast.push(t("selection.talliesDeleted", { count: deleted.size }), "success");
      } else if (pendingCreditChanges === targets.length - deleted.size)
        toast.push(t("credit.pendingChange"), "info");
      else
        toast.push(
          t("selection.partialFailure", { count: targets.length - deleted.size }),
          "error",
        );
      await load();
    } finally {
      selectionBusyRef.current = false;
      setSelectionBusy(false);
    }
  }

  // The tab's own refresh channel: upsertTabFromWire fires this after a pull
  // (or this device's optimistic write) committed. Matched on the relationship
  // rather than the tab id so a re-link under a new tab id keeps refreshing.
  const linkRelationshipId = tabHistory?.relationship_id ?? null;
  useEffect(() => {
    if (!linkRelationshipId) return;
    return onTabApplied((ev) => {
      if (ev.relationshipId !== linkRelationshipId) return;
      void load().then((tl) => {
        // A pull that lands while the user is LOOKING at the contact is seen
        // the moment its rows render: mark through the NEW rev (the focus +
        // foreground gate lives in `seen`). Not for a local write — its
        // notice belongs to the other party, and the review verbs mark their
        // own notice in lib/tabs/link.ts.
        if (ev.origin === "pull") seen(tl);
      });
    });
  }, [linkRelationshipId, load, seen]);

  // ---- Mutual tab flows -------------------------------------------------
  //
  // Every rule (role, currency, already-linked, closed) lives in
  // lib/tabs/link.ts. LinkAccountDialog owns the single-surface invitation flow.
  // BottomSheet waits for its exit before opening that dialog; destructive
  // management actions still have their own explicit confirmations.

  // How this kaata names itself to the other party — the shop's name when
  // there is one, otherwise the shopkeeper's. Also the sender in the invite.
  const myLabel = self?.shop_name || self?.name || "";

  // D11: rotating B's link is the only remedy for a forwarded invite. The
  // new URL is what gets shared next, using the same invitation dialog.
  async function onRegenerate() {
    setConfirmRegenerate(false);
    if (!link) return;
    try {
      const inviteUrl = await regenerateInviteLink(link);
      setTabHistory({ ...link, invite_url: inviteUrl });
      await load();
      setTimeout(() => setInviteVisible(true), 220);
    } catch (err) {
      console.warn("[person] regenerateInviteLink failed", err);
      toast.push(
        err instanceof TabPermissionError || err instanceof TabClosedError
          ? tabErrorMessage(err)
          : err instanceof TabAuthUnavailableError
            ? t("tab.needsConnection")
            : t("tab.link.failed"),
        "error",
      );
      if (err instanceof TabClosedError) await load();
    }
  }

  // Unlink = close for both sides. Closed locally first inside unlinkContact,
  // so the reload already shows the contact back on its own book.
  async function onUnlink() {
    setConfirmUnlink(false);
    if (!link) return;
    try {
      await unlinkContact(link);
      toast.push(t("tab.unlinked"), "success");
      await load();
    } catch (err) {
      console.warn("[person] unlinkContact failed", err);
      toast.push(tabErrorMessage(err), "error");
    }
  }

  // Only pending tallies can be reviewed; the first decision is final.
  async function onAccept(entry: Entry) {
    if (!link) return;
    try {
      await acceptEntry(link, entry.id);
      // This queues an optimistic review. The live comparison announces it
      // only once the server confirms the decision.
      await load();
    } catch (err) {
      console.warn("[person] acceptEntry failed", err);
      toast.push(tabErrorMessage(err), "error");
    }
  }

  async function onReject(entry: Entry) {
    if (!link) return;
    try {
      await disputeEntry(link, entry.id, "");
      await load();
    } catch (err) {
      toast.push(tabErrorMessage(err), "error");
    }
  }

  // Inline withdrawal of a pending tally; reviewed rows are immutable.
  async function onVoid(target: Entry) {
    if (!link || target.tab?.by !== "me" || target.tab.status !== "pending" || target.tab.voided)
      return;
    try {
      await voidEntry(link, target.id);
      toast.push(t("tab.voided"), "success");
      await load();
    } catch (err) {
      console.warn("[person] voidEntry failed", err);
      toast.push(tabErrorMessage(err), "error");
    }
  }

  // Only private tallies use the edit/delete sheet. Shared tally actions are inline.
  const sheetActions = (() => {
    const target = sheetFor;
    if (!target) return [];
    const meta = target.tab;
    if (!meta) {
      return [
        {
          label: t("selection.start"),
          icon: "checkmark-circle-outline" as const,
          onPress: () => startSelection(target),
        },
        {
          label: t("person.sheet.edit"),
          icon: "create-outline" as const,
          onPress: () => {
            router.push({ pathname: "/entry/[id]/edit", params: { id: target.id } });
          },
        },
        {
          label: t("person.sheet.delete"),
          icon: "trash-outline" as const,
          destructive: true,
          onPress: () => setConfirmDeleteFor(target),
        },
      ];
    }
    return [];
  })();

  if (!person) {
    // Pre-load: spinner. Post-load null (stale id, person archived remotely
    // via mesh): say so — and in both cases keep a working back button.
    // The old empty <View /> here was a dead end with no escape on iOS.
    return (
      <SafeAreaView style={styles.container} edges={["top"]}>
        <View style={[styles.headerNav, rowDir(isRTL)]}>
          <Pressable
            onPress={() => router.back()}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel={t("common.back")}
            style={({ pressed }) => [styles.iconBtn, pressed && { opacity: 0.5 }]}
          >
            <Ionicons
              name={isRTL ? "chevron-forward" : "chevron-back"}
              size={icon.header}
              color={colors.textEmphasis}
            />
          </Pressable>
        </View>
        <View style={styles.fillCenter}>
          {loaded ? (
            // Distinguish "this person doesn't exist" from "the read
            // failed" — telling a shopkeeper a real person was not found
            // on a transient storage error is a false data-loss signal.
            <Text style={styles.notFoundText}>
              {loadFailed ? t("home.loadFailed") : t("personAdd.personNotFound")}
            </Text>
          ) : (
            <ActivityIndicator color={colors.textDefault} />
          )}
        </View>
      </SafeAreaView>
    );
  }

  const searchIsCurrent = () => !selectionBusyRef.current && screenIsCurrent();
  const guardedSearchAction = (action: (entry: Entry) => Promise<void>) => async (entry: Entry) => {
    if (!searchIsCurrent()) return;
    await action(entry);
  };
  const renderTallyHistory = (items: HistoryItem[]) => (
    <View
      style={styles.entriesCard}
      onLayout={(event) => {
        entriesCardY.current = event.nativeEvent.layout.y;
        revealNotificationTally();
      }}
    >
      {items.map((item, index) => {
        if (item.kind === "marker") {
          // The ruled-off line, dated — a khata page's visible mark.
          return (
            <View key={`m-${item.ms}-${index}`} style={[styles.chapterLine, rowDir(isRTL)]}>
              <View style={styles.settleRule} />
              <Text style={styles.chapterLineText} allowFontScaling={false}>
                {t(item.settlement ? "tab.settle.history" : "person.history.settledOn", {
                  date: formatSettlementDate(item.ms, getLocale(), calendar),
                  name: item.settlement?.actor_name || t("entry.by.someone"),
                })}
              </Text>
              <View style={styles.settleRule} />
            </View>
          );
        }
        const entry = item.entry;
        // Settled history is READ-ONLY (review fix): editing or
        // deleting a ruled-off entry would un-zero a closed chapter.
        // Remote edits can still arrive — the coherence rule above
        // handles those by falling open — but this device won't offer
        // the footgun.
        const inSettledChapter =
          !entry.tab &&
          settlement.lastSettledAtMs != null &&
          entry.created_at <= settlement.lastSettledAtMs;
        const canOpenSheet = canAmend && !inSettledChapter && !entry.tab;
        return (
          <View
            key={entry.id}
            onLayout={(event) => {
              const { y, height } = event.nativeEvent.layout;
              entryPositions.current.set(entry.id, { y, height });
              revealNotificationTally();
            }}
          >
            {index > 0 && items[index - 1].kind !== "marker" ? (
              <View style={styles.divider} />
            ) : null}
            {/* Tap-and-hold opens the existing tally actions. A tap toggles
                the checkbox once selection is active. */}
            <EntryRow
              entry={entry}
              onLongPress={
                canOpenSheet
                  ? (selectedEntry) => {
                      if (searchIsCurrent()) setSheetFor(selectedEntry);
                    }
                  : undefined
              }
              selecting={selecting && canOpenSheet}
              selected={selecting && selectedEntryIds.has(entry.id)}
              selectionDisabled={selectionBusy}
              onToggleSelection={canOpenSheet ? toggleSelection : undefined}
              attribution={attribution.get(entry.id)}
              tab={entry.tab}
              selfAccountId={getAccountIdSync()}
              onAccept={canAmend && link ? guardedSearchAction(onAccept) : undefined}
              onReject={canAmend && link ? guardedSearchAction(onReject) : undefined}
              onCancel={canAmend && link ? guardedSearchAction(onVoid) : undefined}
              showFullNote={searchTerms.length > 0}
            />
            {highlight?.id === entry.id ? (
              <TallyHighlight requestKey={highlight.key} />
            ) : reviewHighlights.has(entry.id) ? (
              <TallyHighlight
                requestKey={reviewHighlights.get(entry.id)!.key}
                tone={
                  reviewHighlights.get(entry.id)!.status === "accepted" ? "accepted" : "rejected"
                }
              />
            ) : null}
          </View>
        );
      })}
    </View>
  );
  const confirmationVersion = selectionConfirmationVersion.current;
  // The modal keeps rendering during its exit animation. Preserve the last
  // visible count when deletion or closing selection clears the picked rows.
  if (selecting && confirmSelectionDelete && selectedEntries.length > 0)
    selectionDeleteCount.current = selectedEntries.length;
  const selectionToolbar = (
    <SelectionToolbar
      count={selectedEntries.length}
      total={visibleSelectableEntries.length}
      allSelected={allVisibleSelected}
      financialSummary={selectionSummary}
      busy={selectionBusy}
      onClose={closeSelection}
      onToggleAll={() => {
        if (selectionBusyRef.current || !searchIsCurrent()) return;
        setSelectedEntryIds((before) => {
          const next = new Set(before);
          for (const entry of visibleSelectableEntries) {
            if (allVisibleSelected) next.delete(entry.id);
            else next.add(entry.id);
          }
          return next;
        });
      }}
      actions={[
        {
          key: "delete",
          label: t("selection.delete"),
          icon: "trash-outline",
          destructive: true,
          disabled: selectedEntries.length === 0,
          onPress: () => {
            if (selectionBusyRef.current || !searchIsCurrent() || !selectedEntries.length) return;
            dismissSearchKeyboard();
            selectionConfirmationVersion.current++;
            setConfirmSelectionDelete(true);
          },
        },
      ]}
    />
  );
  const abs = Math.abs(person.balance);
  // Direction is derived from the running net — not from any URL param or
  // person-level property. balance > 0 → they owe me; balance < 0 → I owe them.
  const chipLabel =
    person.balance > 0
      ? t("person.balance.theyOwe")
      : person.balance < 0
        ? t("person.balance.youOwe")
        : null;
  const chipVariant: "collect" | "pay" | null =
    person.balance > 0 ? "collect" : person.balance < 0 ? "pay" : null;
  // The hero balance carries the direction cue: the collect color when they
  // owe me (to collect), the pay color when I owe them (to pay), muted gray
  // when settled.
  const balanceColor =
    person.balance > 0
      ? colors.collectStrong
      : person.balance < 0
        ? colors.payStrong
        : colors.textMuted;

  return (
    <SafeAreaView style={styles.container} edges={["top"]}>
      <View style={[styles.headerNav, rowDir(isRTL)]}>
        <Pressable
          onPress={() => (selecting ? closeSelection() : router.back())}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel={t("common.back")}
          style={({ pressed }) => [styles.iconBtn, pressed && { opacity: 0.5 }]}
        >
          <Ionicons
            name={isRTL ? "chevron-forward" : "chevron-back"}
            size={icon.header}
            color={colors.textEmphasis}
          />
        </Pressable>
        {!selecting ? (
          <View style={[styles.headerActions, rowDir(isRTL)]}>
            {entries.length > 0 ? (
              <Pressable
                testID="whatsapp-reminder"
                onPress={() => void sendPing()}
                disabled={pinging}
                accessibilityRole="button"
                accessibilityLabel={t(
                  pingStage === "preparing"
                    ? "person.ping.preparing"
                    : pingStage === "opening"
                      ? "person.ping.opening"
                      : "person.ping.button",
                )}
                accessibilityHint={t("person.ping.hint", { name: person.name })}
                accessibilityState={{ disabled: pinging, busy: pinging }}
                style={({ pressed }) => [styles.headerShare, pressed && { opacity: 0.5 }]}
              >
                {pinging ? (
                  <ActivityIndicator size="small" color={colors.actionPrimary} />
                ) : (
                  <Ionicons name="logo-whatsapp" size={icon.header} color={colors.actionPrimary} />
                )}
              </Pressable>
            ) : null}
            <OverflowMenu
              actions={[
                ...(selectableEntries.length > 0
                  ? [
                      {
                        label: t("selection.start"),
                        icon: "checkmark-circle-outline" as const,
                        onPress: () => startSelection(),
                      },
                    ]
                  : []),
                ...(canAmend
                  ? [
                      {
                        label: t("person.sheet.edit"),
                        icon: "create-outline" as const,
                        onPress: () =>
                          router.push({ pathname: "/person/[id]/edit", params: { id: person.id } }),
                      },
                      {
                        label: link ? t("tab.join.title") : t("tab.link.title"),
                        icon: "link-outline" as const,
                        onPress: () =>
                          link ? setLinkedSheetVisible(true) : setInviteVisible(true),
                      },
                      {
                        label: t("groups.personAction"),
                        icon: "pricetags-outline" as const,
                        onPress: () =>
                          router.push({
                            pathname: "/person/[id]/group",
                            params: { id: person.id, vaultId: activeVaultId ?? "" },
                          }),
                      },
                    ]
                  : []),
                ...(canManageCredit
                  ? [
                      {
                        label: t("credit.title"),
                        icon: "speedometer-outline" as const,
                        onPress: () =>
                          router.push({
                            pathname: "/person/[id]/credit-limit",
                            params: { id: person.id, vaultId: activeVaultId ?? "" },
                          }),
                      },
                    ]
                  : []),
                {
                  label: t("reminders.title"),
                  icon: "alarm-outline" as const,
                  onPress: () =>
                    router.push({
                      pathname: "/person/[id]/reminders",
                      params: { id: person.id, vaultId: activeVaultId ?? "" },
                    }),
                },
                {
                  label: t("personEdit.export"),
                  icon: "document-text-outline",
                  disabled: exporting,
                  onPress: () => setExportSheetVisible(true),
                },
              ]}
            />
          </View>
        ) : null}
      </View>
      {/* One person's tallies are bounded, so render them as ONE bordered card
          (ScrollView + map), exactly like the home people list. The old
          FlatList + per-row cardRowFirst/cardRowLast emulation caused the
          blank-row bug: adding a 2nd entry shifted the old row from index 0 to
          1, flipping its style, and Android painted it blank until a remount
          ("the old one shows blank text after the second one is added, fixed
          by going back and returning"). A single uniform card has no per-row
          style flip, so it can't happen. */}
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === "android" ? "height" : "padding"}
      >
        {/* iOS keyboard padding reduces this inner flex box. An absolute dock
            directly on the KAV would still anchor to its full outer height. */}
        <View style={{ flex: 1 }}>
          <ScrollView
            ref={scrollRef}
            onLayout={(event) => {
              viewport.current.height = event.nativeEvent.layout.height;
              revealNotificationTally();
            }}
            onScroll={(event) => {
              viewport.current.offset = event.nativeEvent.contentOffset.y;
            }}
            scrollEventThrottle={16}
            onContentSizeChange={revealNotificationTally}
            showsVerticalScrollIndicator={false}
            keyboardDismissMode={Platform.OS === "ios" ? "interactive" : "on-drag"}
            keyboardShouldPersistTaps="handled"
            automaticallyAdjustKeyboardInsets={false}
            contentContainerStyle={{
              paddingBottom: actionsHeight + 24,
            }}
          >
            <View>
              <View style={styles.info}>
                <View style={[styles.identityRow, rowDir(isRTL)]}>
                  <View style={[styles.nameRow, rowDir(isRTL)]}>
                    <Text style={[styles.name, { flexShrink: 1 }, textDir(isRTL)]}>
                      {person.name}
                    </Text>
                    {link ? (
                      <SharedAccountBadge
                        size={20}
                        name={person.name}
                        fontSize={typography.heading.fontSize}
                      />
                    ) : null}
                  </View>
                  {personGroupNames.length > 0 ? (
                    <View style={[styles.groupBadges, rowDir(isRTL)]}>
                      {personGroupNames.map((name) => (
                        <View key={name} style={styles.groupBadge}>
                          <Text style={[styles.groupBadgeText, textDir(isRTL)]}>{name}</Text>
                        </View>
                      ))}
                    </View>
                  ) : null}
                </View>
                {person.phone ? (
                  <Text
                    style={[
                      styles.phone,
                      { writingDirection: "ltr", textAlign: isRTL ? "right" : "left" },
                    ]}
                  >
                    {ltrIsolate(person.phone)}
                  </Text>
                ) : null}
                {/* A closed shared account freezes its history; tallies written
                    after it are private and carry no review state, which made
                    them look like accepted shared ones (audit #6). */}
                {tabHistory?.closed_at != null ? (
                  <Text style={[styles.groups, textDir(isRTL)]} numberOfLines={2}>
                    {t("tab.closedNote", { date: formatDate(tabHistory.closed_at) })}
                  </Text>
                ) : null}
                <View style={{ height: 16 }} />
                <View style={[styles.balanceOverview, rowDir(isRTL)]}>
                  <View style={styles.balanceSide}>
                    <View style={[styles.chipRow, rowDir(isRTL)]}>
                      {chipLabel && chipVariant ? (
                        <Chip label={chipLabel} variant={chipVariant} />
                      ) : settledCount > 0 &&
                        chapterCoherent &&
                        !sharedReviewPending &&
                        unsettledOriginalCount === 0 ? (
                        // "SETTLED" only when the user actually drew the line and it
                        // covers everything.
                        <Chip label={t("person.balance.settled")} variant="neutral" />
                      ) : displayedEntries.length > 0 ? (
                        // A tally that merely SUMS to zero (or whose chapter no longer
                        // adds up after a sync) is not a settled account — say so
                        // rather than leaving the chip slot blank while every other
                        // state labels itself. Hollow pill: true, but not an
                        // achievement. The settle-row invitation sits below.
                        // Contacts with no entries at all keep an empty slot — there
                        // is no tally yet to have a state.
                        <Chip label={t("person.balance.notSettled")} variant="outline" />
                      ) : null}
                      {link && link.other_joined_at == null ? (
                        // Keep the invitation-waiting cue until the other side joins.
                        // Once linked, the name badge is enough; no duplicate chip.
                        <Pressable
                          onPress={canAmend ? () => setLinkedSheetVisible(true) : undefined}
                          disabled={!canAmend}
                          accessibilityRole={canAmend ? "button" : "text"}
                          style={({ pressed }) => [
                            styles.readOnlyChip,
                            pressed && { opacity: 0.5 },
                          ]}
                        >
                          <Ionicons name="link-outline" size={14} color={colors.textSubtle} />
                          <Text
                            style={styles.readOnlyChipText}
                            allowFontScaling={false}
                            numberOfLines={1}
                          >
                            {t("tab.chip.waiting")}
                          </Text>
                        </Pressable>
                      ) : null}
                    </View>
                    <View style={[styles.balanceRow, rowDir(isRTL)]}>
                      <Text
                        style={[
                          styles.balance,
                          {
                            color: person.tab_unsynced === 1 ? colors.textMuted : balanceColor,
                            flexShrink: 1,
                          },
                        ]}
                        numberOfLines={1}
                        adjustsFontSizeToFit
                        minimumFontScale={0.5}
                      >
                        {person.tab_unsynced === 1 ? "…" : formatAmount(abs)}
                      </Text>
                      {person.tab_unsynced === 1 ? null : (
                        <Text style={styles.balanceAfn}>{getCurrentCurrencySymbol()}</Text>
                      )}
                    </View>
                    {/* A discovered shared account that has not been pulled yet
                        has no known balance; the pull is already queued. */}
                    {person.tab_unsynced === 1 ? (
                      <Text style={[styles.unsyncedNote, textDir(isRTL)]}>
                        {t("tab.notDownloaded")}
                      </Text>
                    ) : null}
                    <CreditStatusBadge personId={person.id} vaultId={activeVaultId} />
                  </View>
                  <TallyFlowSummary summary={flowSummary} isRTL={isRTL} />
                </View>
                {reminderId ? (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={t("reminders.title")}
                    onPress={() =>
                      router.push({
                        pathname: "/person/[id]/reminders",
                        params: { id: person.id, vaultId: activeVaultId ?? "" },
                      })
                    }
                    style={[rowDir(isRTL), { alignItems: "center", gap: 8, paddingVertical: 12 }]}
                  >
                    <Ionicons name="alarm-outline" size={18} color={colors.textMuted} />
                    <Text
                      style={[
                        textDir(isRTL),
                        { fontFamily: fonts.sansMedium, color: colors.textDefault },
                      ]}
                    >
                      {t("reminders.title")}
                    </Text>
                  </Pressable>
                ) : null}
                {pingNudge && person.phone && !link && entries.length > 0 && !pinging ? (
                  <View style={[styles.pingNudge, rowDir(isRTL)]}>
                    <Ionicons name="logo-whatsapp" size={18} color={colors.textEmphasis} />
                    <Text style={[styles.pingNudgeText, textDir(isRTL)]} numberOfLines={2}>
                      {t("person.ping.nudge", { name: person.name })}
                    </Text>
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={t("person.ping.button")}
                      onPress={() => {
                        setPingNudge(false);
                        void sendPing();
                      }}
                      hitSlop={{ top: 8, bottom: 8 }}
                      style={({ pressed }) => [styles.pingNudgeSend, pressed && { opacity: 0.7 }]}
                    >
                      <Text style={styles.pingNudgeSendText}>{t("person.ping.nudgeSend")}</Text>
                    </Pressable>
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={t("common.notNow")}
                      onPress={() => setPingNudge(false)}
                      hitSlop={12}
                      style={styles.pingNudgeClose}
                    >
                      <Ionicons name="close" size={16} color={colors.textSubtle} />
                    </Pressable>
                  </View>
                ) : null}
              </View>
            </View>

            {/* Settle-up affordance — deliberately NOT a button. A ruled line,
            the same mark a paper khata gets when an account is closed. It
            only exists in the exact moment it means something: balance is
            zero AND the current chapter has entries. Tapping it draws the
            line for real. */}
            {canSettle && !searching && !selecting ? (
              <Pressable
                onPress={() => setConfirmSettle(true)}
                accessibilityRole="button"
                accessibilityLabel={t("person.settle.row")}
                style={({ pressed }) => [
                  styles.settleRow,
                  rowDir(isRTL),
                  pressed && { opacity: 0.5 },
                ]}
              >
                <View style={styles.settleRule} />
                <Text style={styles.settleRowText} allowFontScaling={false}>
                  {t("person.settle.row")}
                </Text>
                <View style={styles.settleRule} />
              </Pressable>
            ) : null}

            {/* Waiting and refused clerk attempts stay on the complete ledger. */}
            {!searching && !selecting ? (
              <CreditIntentList personId={person.id} vaultId={activeVaultId} />
            ) : null}

            {historyItems.length === 0 ? (
              searching ? (
                searchResultCount === 0 ? (
                  <EmptyState
                    title={t("person.search.empty.title")}
                    subtitle={t("person.search.empty.subtitle")}
                    isRTL={isRTL}
                  />
                ) : null
              ) : settledCount > 0 ? (
                <EmptyState
                  title={t("person.freshChapter.title")}
                  subtitle={t("person.freshChapter.subtitle")}
                  isRTL={isRTL}
                />
              ) : (
                <EmptyState
                  title={t("person.empty.title")}
                  subtitle={t("person.empty.subtitle")}
                  isRTL={isRTL}
                />
              )
            ) : (
              renderTallyHistory(historyItems)
            )}

            {matchedFailedTallies.length > 0 ? (
              <>
                <Pressable
                  onPress={() => setFailedTalliesOpen((v) => !v)}
                  disabled={searching}
                  accessibilityRole="button"
                  accessibilityState={{
                    expanded: searching || failedTalliesOpen,
                    disabled: searching,
                  }}
                  style={[styles.foldRow, rowDir(isRTL)]}
                >
                  <Text style={styles.historyRowText}>
                    {t("tab.notSent", { count: matchedFailedTallies.length })}
                  </Text>
                  {!searching ? (
                    <Ionicons
                      name={failedTalliesOpen ? "chevron-up" : "chevron-down"}
                      size={14}
                      color={colors.textSubtle}
                    />
                  ) : null}
                </Pressable>
                {searching || failedTalliesOpen ? (
                  <View style={[styles.entriesCard, styles.preLinkCard]}>
                    <Text style={[styles.historyRowText, { padding: 14 }, textDir(isRTL)]}>
                      {t("tab.notSent.body")}
                    </Text>
                    {matchedFailedTallies.map((entry) => (
                      <EntryRow
                        key={entry.id}
                        entry={entry}
                        showFullNote={searchTerms.length > 0}
                      />
                    ))}
                  </View>
                ) : null}
              </>
            ) : null}

            {tabHistory?.closed_reason === "account_deleted" ? (
              <Text
                style={[
                  styles.historyRowText,
                  { paddingHorizontal: 14, paddingVertical: 10 },
                  textDir(isRTL),
                ]}
              >
                {t("export.record.closedDeleted")}
              </Text>
            ) : null}

            {/* Pre-link history (D8). Visible but folded, in the settled-history
            row's visual language: these rows are the book as it was before
            the account became shared, their sum is already the opening tally
            on the tab, and nothing here can be edited (TabLinkedEntryError).
            No long-press, no attribution: frozen pages. */}
            {tabHistory && matchedPreLink.length > 0 ? (
              <>
                <Pressable
                  onPress={() => setPreLinkOpen((v) => !v)}
                  disabled={searching}
                  accessibilityRole="button"
                  accessibilityState={{ expanded: searching || preLinkOpen, disabled: searching }}
                  style={({ pressed }) => [
                    styles.foldRow,
                    rowDir(isRTL),
                    pressed && { opacity: 0.5 },
                  ]}
                >
                  <Text style={styles.historyRowText} allowFontScaling={false}>
                    {t("tab.beforeLinking", { count: matchedPreLink.length })}
                  </Text>
                  {!searching ? (
                    <Ionicons
                      name={preLinkOpen ? "chevron-up" : "chevron-down"}
                      size={14}
                      color={colors.textSubtle}
                    />
                  ) : null}
                </Pressable>
                {searching || preLinkOpen ? (
                  <View style={[styles.entriesCard, styles.preLinkCard]}>
                    {matchedPreLink.map((entry, index) => (
                      <View key={entry.id}>
                        {index > 0 ? <View style={styles.divider} /> : null}
                        <EntryRow entry={entry} showFullNote={searchTerms.length > 0} />
                      </View>
                    ))}
                  </View>
                ) : null}
              </>
            ) : null}

            {/* Settled history collapse — one quiet row, only when chapters
            exist AND the collapse is coherent (when the chapter can't
            explain the balance, the view is forced open and the toggle
            hides rather than pretend). Nothing was deleted; the book just
            has pages now. */}
            {settledCount > 0 && chapterCoherent && !searching ? (
              <Pressable
                onPress={() => setShowFullHistory((v) => !v)}
                accessibilityRole="button"
                style={({ pressed }) => [styles.historyRow, pressed && { opacity: 0.5 }]}
              >
                <Text style={styles.historyRowText} allowFontScaling={false}>
                  {showFullHistory
                    ? t("person.history.hide")
                    : t("person.history.show", { count: settledCount })}
                </Text>
              </Pressable>
            ) : null}
          </ScrollView>

          {/* Opaque dock: it takes every tap on its own background. The old
          ping bar was a floating button and passed taps through ("box-none"),
          which here reached tally rows hidden behind the dock, Accept/Reject
          included. It still lifts above toasts, over its own DOCK_SKIRT, but not
          above an open keyboard. Received LEFT, gave RIGHT regardless of
          language. */}
          {selecting || canCreate || hasTallies ? (
            <Animated.View
              onLayout={(event) =>
                setActionsHeight(Math.max(0, event.nativeEvent.layout.height - DOCK_SKIRT))
              }
              style={[
                styles.actions,
                {
                  bottom: -DOCK_SKIRT,
                  // Over an open keyboard the safe-area inset is covered: its
                  // padding was an empty band that cost result rows (audit #31).
                  paddingBottom: (keyboardShown ? 8 : 20 + insets.bottom) + DOCK_SKIRT,
                  transform: [{ translateY: keyboardShown ? 0 : toastOffset }],
                },
              ]}
            >
              {/* While typing a search the entry buttons step aside so the
                  results above the keyboard get their room (0-1 rows before,
                  audit #31); they return with the keyboard's close. */}
              {selecting ? (
                selectionToolbar
              ) : canCreate && !keyboardShown ? (
                <View style={styles.actionRow}>
                  <View style={styles.actionBtnWrap}>
                    <Pressable
                      accessibilityRole="button"
                      onPress={() =>
                        router.push({
                          pathname: "/entry/new",
                          params: { personId: person.id, type: "payment" },
                        })
                      }
                      style={({ pressed }) => [
                        styles.actionBtn,
                        pressed && styles.actionBtnPressed,
                      ]}
                    >
                      {/* 16 is composed INTO the fixed 26px coin (see
                      actionIconCoin), so the icon scale does not apply here —
                      icon.trailing/row would fill or overflow the well. */}
                      <View style={styles.actionIconCoin}>
                        <Ionicons name="arrow-down-outline" size={16} color={colors.textInverted} />
                      </View>
                      <Text style={[styles.actionText, trackingSafe(isRTL)]}>
                        {t("person.action.iReceived")}
                      </Text>
                    </Pressable>
                  </View>
                  <View style={styles.actionBtnWrap}>
                    <Pressable
                      accessibilityRole="button"
                      onPress={() =>
                        router.push({
                          pathname: "/entry/new",
                          params: { personId: person.id, type: "debt" },
                        })
                      }
                      style={({ pressed }) => [
                        styles.actionBtn,
                        pressed && styles.actionBtnPressed,
                      ]}
                    >
                      {/* 16, composed into the coin — same reason as "I received". */}
                      <View style={styles.actionIconCoin}>
                        <Ionicons name="arrow-up-outline" size={16} color={colors.textInverted} />
                      </View>
                      <Text style={[styles.actionText, trackingSafe(isRTL)]}>
                        {t("person.action.iGave")}
                      </Text>
                    </Pressable>
                  </View>
                </View>
              ) : null}
              {hasTallies ? (
                <View style={styles.searchArea}>
                  <View style={[styles.searchControls, rowDir(isRTL)]}>
                    <View style={[styles.searchBox, rowDir(isRTL)]}>
                      <Ionicons
                        name="search-outline"
                        size={icon.trailing}
                        color={colors.textSubtle}
                      />
                      <TextInput
                        ref={searchInputRef}
                        value={searchQuery}
                        onChangeText={(value) => {
                          if (searchIsCurrent()) setSearchQuery(value);
                        }}
                        onFocus={() => {
                          if (searchIsCurrent()) setSearchFocused(true);
                        }}
                        onBlur={() => {
                          if (screenIsCurrent()) setSearchFocused(false);
                        }}
                        placeholder={t("person.search.placeholder")}
                        accessibilityLabel={t("person.search.placeholder")}
                        placeholderTextColor={colors.textSubtle}
                        style={[styles.searchInput, textDir(isRTL)]}
                        returnKeyType="search"
                        submitBehavior="blurAndSubmit"
                        onSubmitEditing={dismissSearchKeyboard}
                        autoCorrect={false}
                        maxLength={500}
                      />
                      <SearchControlSlot
                        visible={searchQuery.length > 0}
                        width={TOUCH_MIN}
                        height={TOUCH_MIN}
                        style={isRTL ? styles.clearSearchRTL : styles.clearSearchLTR}
                      >
                        <Pressable
                          onPress={() => {
                            if (searchIsCurrent()) setSearchQuery("");
                          }}
                          accessibilityRole="button"
                          accessibilityLabel={t("person.search.clear")}
                          style={styles.clearSearch}
                        >
                          <Ionicons name="close" size={icon.trailing} color={colors.textSubtle} />
                        </Pressable>
                      </SearchControlSlot>
                    </View>
                    <Pressable
                      onPress={() => {
                        if (!searchIsCurrent()) return;
                        dismissSearchKeyboard();
                        setDateSheetVisible(true);
                      }}
                      accessibilityRole="button"
                      accessibilityLabel={
                        dateRange
                          ? t("person.date.active", { range: dateRangeLabel })
                          : t("person.date.title")
                      }
                      accessibilityState={{ selected: dateRange != null }}
                      style={[styles.dateButton, dateRange && styles.dateButtonActive]}
                    >
                      <Ionicons
                        name="calendar-outline"
                        size={icon.row}
                        color={dateRange ? colors.textEmphasis : colors.textSubtle}
                      />
                    </Pressable>
                    <SearchControlSlot
                      visible={searchFocused}
                      width={TOUCH_MIN}
                      height={TOUCH_MIN}
                      collapse
                      gap={8}
                      isRTL={isRTL}
                    >
                      <Pressable
                        onPress={dismissSearchKeyboard}
                        accessibilityRole="button"
                        accessibilityLabel={t("common.hideKeyboard")}
                        style={styles.dateButton}
                      >
                        <Ionicons name="chevron-down" size={icon.row} color={colors.textEmphasis} />
                      </Pressable>
                    </SearchControlSlot>
                  </View>
                  {dateRange ? (
                    <View style={[styles.dateSummary, rowDir(isRTL)]}>
                      <Pressable
                        style={styles.dateSummaryLabel}
                        onPress={() => {
                          if (!searchIsCurrent()) return;
                          dismissSearchKeyboard();
                          setDateSheetVisible(true);
                        }}
                        accessibilityRole="button"
                        accessibilityLabel={t("person.date.active", { range: dateRangeLabel })}
                      >
                        <Text numberOfLines={2} style={[styles.searchSummary, textDir(isRTL)]}>
                          {dateRangeLabel}
                        </Text>
                      </Pressable>
                      <Pressable
                        style={styles.clearDate}
                        onPress={() => {
                          if (searchIsCurrent()) setDateRange(null);
                        }}
                        accessibilityRole="button"
                        accessibilityLabel={t("person.date.clear")}
                      >
                        <Ionicons name="close" size={16} color={colors.textSubtle} />
                      </Pressable>
                    </View>
                  ) : null}
                  {searching ? (
                    <Text
                      style={[styles.searchSummary, textDir(isRTL)]}
                      accessibilityLiveRegion="polite"
                    >
                      {t(
                        searchResultCount === 1 ? "person.search.result" : "person.search.results",
                        {
                          count: searchResultCount,
                        },
                      )}
                    </Text>
                  ) : null}
                </View>
              ) : null}
            </Animated.View>
          ) : null}
        </View>
      </KeyboardAvoidingView>
      <TallyDateFilterSheet
        visible={dateSheetVisible}
        contextKey={flowScope}
        range={dateRange}
        calendar={calendar}
        isRTL={isRTL}
        onChange={(range) => {
          if (searchIsCurrent()) setDateRange(range);
        }}
        onDismiss={() => {
          if (screenIsCurrent()) setDateSheetVisible(false);
        }}
      />

      <ConfirmDialog
        visible={selecting && confirmSelectionDelete && selectedEntries.length > 0}
        title={t("selection.deleteTalliesTitle", { count: selectionDeleteCount.current })}
        description={t("selection.deleteTalliesDescription", {
          count: selectionDeleteCount.current,
        })}
        confirmLabel={t("selection.delete")}
        destructive
        onCancel={() => {
          if (!searchIsCurrent() || confirmationVersion !== selectionConfirmationVersion.current)
            return;
          selectionConfirmationVersion.current++;
          setConfirmSelectionDelete(false);
        }}
        onConfirm={() => {
          if (
            !searchIsCurrent() ||
            !selectionContext.current.selecting ||
            !confirmSelectionDelete ||
            confirmationVersion !== selectionConfirmationVersion.current
          )
            return;
          selectionConfirmationVersion.current++;
          void deleteSelectedTallies();
        }}
      />

      {/* Statement export chooser. BottomSheet's 220ms action defer doubles as
          clearance for the OS share sheet that follows generation. */}
      <BottomSheet
        visible={exportSheetVisible}
        title={t("personEdit.export")}
        onDismiss={() => setExportSheetVisible(false)}
        actions={[
          {
            label: t("export.action.sharePdf"),
            icon: "share-outline",
            onPress: () => void onExport("pdf", "share"),
          },
          {
            label: t("export.action.shareCsv"),
            icon: "share-outline",
            onPress: () => void onExport("csv", "share"),
          },
          {
            label: t("export.action.savePdf"),
            icon: "download-outline",
            onPress: () => void onExport("pdf", "save"),
          },
          {
            label: t("export.action.saveCsv"),
            icon: "download-outline",
            onPress: () => void onExport("csv", "save"),
          },
        ]}
      />

      <BottomSheet
        visible={sheetFor !== null}
        title={
          sheetFor
            ? `${formatAmount(sheetFor.amount_afn)} ${getCurrentCurrencySymbol()}`
            : undefined
        }
        onDismiss={() => setSheetFor(null)}
        // Edit/Delete for private tallies only.
        actions={sheetActions}
      />

      {/* ---- Mutual tab sheets & dialogs ---- */}

      <LinkAccountDialog
        visible={inviteVisible}
        person={person}
        myLabel={myLabel}
        link={link}
        onLinked={(created) => {
          setTabHistory(created);
          void load();
        }}
        onDismiss={() => setInviteVisible(false)}
        onAuthRequired={() => {
          void (async () => {
            await setAppMeta("pending_tab_person", person.id);
            router.push("/sign-in");
          })().catch(() => toast.push(t("tab.link.failed"), "error"));
        }}
      />

      {/* Manage sheet behind the linked chip. Re-share and regenerate exist
          only for party a (the link is B's credential, D11); unlink is
          either side's right and closes the tab for both. */}
      <BottomSheet
        visible={linkedSheetVisible}
        title={person.name}
        onDismiss={() => setLinkedSheetVisible(false)}
        actions={[
          ...(link?.role === "a" && link.invite_url
            ? [
                {
                  label: t("tab.share.again"),
                  icon: "share-outline" as const,
                  onPress: () => setInviteVisible(true),
                },
              ]
            : []),
          ...(link?.role === "a"
            ? [
                {
                  label: t("tab.regenerate"),
                  icon: "refresh-outline" as const,
                  onPress: () => setConfirmRegenerate(true),
                },
              ]
            : []),
          {
            label: t("tab.unlink"),
            icon: "unlink-outline",
            destructive: true,
            onPress: () => setConfirmUnlink(true),
          },
        ]}
      />
      <ConfirmDialog
        visible={confirmRegenerate}
        title={t("tab.regenerate.title")}
        description={t("tab.regenerate.body", { name: person.name })}
        confirmLabel={t("tab.regenerate.ok")}
        onConfirm={() => void onRegenerate()}
        onCancel={() => setConfirmRegenerate(false)}
      />
      <ConfirmDialog
        visible={confirmUnlink}
        title={t("tab.unlink.title", { name: person.name })}
        description={t("tab.unlink.body")}
        confirmLabel={t("tab.unlink")}
        destructive
        onConfirm={() => void onUnlink()}
        onCancel={() => setConfirmUnlink(false)}
      />

      {/* Per-send message-language picker (share_lang_pref = 'ask'). Dari
          first — the common pick. No persisted selection: it's per-send. */}
      <OptionSheet
        visible={askLangVisible}
        title={t("share.askLang.title")}
        options={[
          { key: "fa", label: t("settings.language.option.fa") },
          { key: "ps", label: t("settings.language.option.ps") },
          { key: "en", label: t("settings.language.option.en") },
        ]}
        selected=""
        onSelect={(k) => {
          // OptionSheet's Modal stays mounted throughout its 220 ms exit.
          // Claim the choice now; a fast offline share must not permit a
          // second tap there or open WhatsApp over the native sheet.
          if (pingLanguageChosen.current || pingBusyRef.current) return;
          pingLanguageChosen.current = true;
          setAskLangVisible(false);
          pingBusyRef.current = true;
          setPingStage("preparing");
          pingLanguageTimer.current = setTimeout(() => {
            pingLanguageTimer.current = null;
            pingBusyRef.current = false;
            void sendPing(k as LocaleCode);
          }, 220);
        }}
        onDismiss={() => {
          pingLanguageChosen.current = true;
          setAskLangVisible(false);
        }}
        isRTL={isRTL}
      />

      <ConfirmDialog
        visible={confirmSettle}
        title={t("person.settle.confirm.title")}
        description={t(tabHistory ? "tab.settle.confirm" : "person.settle.confirm.body", {
          name: person.name,
        })}
        confirmLabel={t("person.settle.confirm.cta")}
        onConfirm={onSettle}
        onCancel={() => setConfirmSettle(false)}
      />
      <ConfirmDialog
        visible={confirmDeleteFor !== null}
        title={t("person.delete.title")}
        description={t("person.delete.description")}
        confirmLabel={t("person.delete.confirm")}
        destructive
        onConfirm={async () => {
          // Close the dialog FIRST — ConfirmDialog doesn't self-dismiss, and
          // the success toast renders beneath the dialog's Modal, so leaving
          // it open reads as "the tap did nothing" and invites a second
          // Confirm tap (re-running the delete).
          const target = confirmDeleteFor;
          setConfirmDeleteFor(null);
          if (!target) return;
          try {
            await softDeleteEntry(target.id);
            await load();
            toast.push(t("entry.deleted"), "success");
          } catch (err) {
            if (err instanceof Error && err.name === "CreditMutationAdmissionError") {
              const pending = (err as Error & { status: string }).status === "pending";
              toast.push(
                t(pending ? "credit.pendingChange" : "credit.refusedChange"),
                pending ? "info" : "error",
              );
              await load();
              return;
            }
            if (err instanceof SettledChapterError) {
              toast.push(t("entry.settledLocked"), "error");
              return;
            }
            console.warn("[person] softDeleteEntry failed", err);
            toast.push(t("entry.deleteFailed"), "error");
          }
        }}
        onCancel={() => setConfirmDeleteFor(null)}
      />
    </SafeAreaView>
  );
}

// Fixed-size "coin" behind the give/receive arrow. Named so the radius can be
// size/2 (a true circle) instead of a literal that silently stops being one
// when the diameter changes.
const ACTION_COIN_SIZE = 26;

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bgDefault },
  fillCenter: { flex: 1, alignItems: "center", justifyContent: "center" },
  notFoundText: { fontSize: 14, fontFamily: fonts.sansRegular, color: colors.textSubtle },
  // One compact action group with separate 44pt targets, mirrored in Dari.
  // The 10pt between WhatsApp and the menu lives in the row's gap: a margin on
  // one side of the button landed on the outer edge in Dari's reversed row,
  // leaving 2pt between the icons (audit #11).
  headerActions: { flexDirection: "row", alignItems: "center", gap: 10 },
  headerShare: {
    minWidth: TOUCH_MIN,
    minHeight: TOUCH_MIN,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radius.sm,
  },
  headerNav: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  iconBtn: {
    // 40 + the hitSlop={8} on every consumer = a 56px target, so the visible
    // box stays 40 (growing it would push the header chrome down 4px).
    width: 40,
    height: 40,
    borderRadius: radius.sm,
    alignItems: "center",
    justifyContent: "center",
  },
  // Read-only chip shown in place of the edit button for a viewer.
  readOnlyChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 3,
    paddingHorizontal: 8,
    paddingVertical: 5,
    borderRadius: radius.pill,
    backgroundColor: colors.bgMuted,
  },
  readOnlyChipText: {
    fontSize: 11,
    fontFamily: fonts.sansMedium,
    color: colors.textSubtle,
  },
  info: { paddingHorizontal: 16, paddingTop: 4, paddingBottom: 20 },
  balanceOverview: { alignItems: "center", gap: 18 },
  balanceSide: { flex: 1, minWidth: 0 },
  // Direction chip + linked chip on one line. Chip's own alignSelf handles
  // the script edge; this row just puts the two side by side. flexWrap so
  // a long counterparty label drops the linked chip to a second line rather
  // than squeezing the direction word.
  chipRow: { flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" },
  // 22 → typography.heading (20): 22 was one of the scale's two orphan display
  // sizes and sat 2px from `heading`, which every other screen headline already
  // uses. The BOLD weight is kept (heading ships sansSemi) — this is a person's
  // name, the anchor of the screen, and dropping a weight step here would read
  // as a demotion rather than a scale fix. Same fontFamily-override idiom as
  // Button's `textPill`.
  identityRow: { alignItems: "center", justifyContent: "space-between", gap: 12 },
  nameRow: { flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center", gap: 7 },
  groupBadges: { maxWidth: "45%", flexWrap: "wrap", justifyContent: "flex-end", gap: 6 },
  groupBadge: {
    maxWidth: "100%",
    paddingHorizontal: 9,
    paddingVertical: 4,
    borderRadius: radius.sm,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderSubtle,
    backgroundColor: colors.bgMuted,
  },
  groupBadgeText: { ...typography.bodySm, fontFamily: fonts.sansMedium, color: colors.textMuted },
  name: { ...typography.heading, fontFamily: fonts.sansBold, color: colors.textEmphasis },
  phone: {
    fontSize: 13,
    fontFamily: fonts.monoRegular,
    color: colors.textSubtle,
    marginTop: 4,
  },
  groups: {
    fontSize: 13,
    fontFamily: fonts.sansRegular,
    color: colors.textSubtle,
    marginTop: 4,
  },
  pingNudge: {
    alignItems: "center",
    gap: 10,
    marginTop: 12,
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.borderDefault,
    backgroundColor: colors.bgDefault,
  },
  pingNudgeText: {
    flex: 1,
    fontFamily: fonts.sansRegular,
    fontSize: 13,
    color: colors.textDefault,
  },
  pingNudgeSend: {
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderRadius: radius.sm,
    backgroundColor: colors.actionPrimary,
  },
  pingNudgeSendText: { fontFamily: fonts.sansSemi, fontSize: 13, color: colors.textInverted },
  pingNudgeClose: { padding: 4 },
  unsyncedNote: {
    fontSize: 12,
    fontFamily: fonts.sansRegular,
    color: colors.textSubtle,
    marginTop: 6,
  },
  balanceRow: { flexDirection: "row", alignItems: "baseline", marginTop: 10, gap: 6 },
  // 40 → typography.numHero (36). This was the app's ONLY 40px value, and the
  // home screen's total — the other hero balance — was already 36. The 4px gap
  // was never the hierarchy signal between the two screens; the COLOUR is (both
  // tint inline from the running net, and this one falls back to a muted grey
  // when settled while home never renders a settled state). So the size
  // collapses and the colour is left exactly as it was.
  //
  // letterSpacing STAYS: formatAmount() goes through lib/format.ts, which
  // hardcodes toLocaleString("en-US"), so this string is Latin digits in both
  // languages and tracking can't sever any Arabic-script joining. Deliberately
  // NOT trackingSafe(isRTL) for the same reason.
  balance: {
    ...typography.numHero,
    color: colors.textEmphasis,
    letterSpacing: -0.5,
  },
  balanceAfn: { fontSize: 15, fontFamily: fonts.sansMedium, color: colors.textMuted },
  searchArea: { gap: 4 },
  searchControls: { alignItems: "center", gap: 8 },
  dateButton: {
    minWidth: TOUCH_MIN,
    minHeight: TOUCH_MIN,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: colors.borderDefault,
    borderRadius: radius.sm,
  },
  dateButtonActive: { backgroundColor: colors.bgMuted, borderColor: colors.borderEmphasis },
  dateSummary: { alignItems: "center", gap: 4 },
  dateSummaryLabel: { flex: 1, justifyContent: "center", minHeight: TOUCH_MIN },
  clearDate: {
    minWidth: TOUCH_MIN,
    minHeight: TOUCH_MIN,
    alignItems: "center",
    justifyContent: "center",
  },
  searchBox: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    borderWidth: 1,
    borderColor: colors.borderDefault,
    borderRadius: radius.sm,
    paddingHorizontal: 12,
    minHeight: TOUCH_MIN,
  },
  searchInput: { ...typography.body, flex: 1, color: colors.textEmphasis, paddingVertical: 10 },
  clearSearch: {
    width: TOUCH_MIN,
    height: TOUCH_MIN,
    flexShrink: 0,
    justifyContent: "center",
    alignItems: "center",
  },
  // The Activity stays LTR, so choose the outer physical edge explicitly.
  clearSearchLTR: { marginRight: -12 },
  clearSearchRTL: { marginLeft: -12 },
  searchSummary: { ...typography.bodySm, color: colors.textSubtle },
  actions: {
    // INVARIANT: "I received" stays physical LEFT, "I gave" stays physical
    // RIGHT. Right-hand-is-giving cultural rule. Yoga WOULD auto-reverse
    // `flexDirection: 'row'` children if the Activity were RTL — that's
    // exactly the bug v0.2.4 shipped, with "I gave" landing on the left
    // for Persian users. We avoid it by ensuring the Activity is LTR via
    // _layout.tsx's I18nManager neutralization + one-shot migration
    // prompt. Internal direction (lib/direction.ts) does NOT touch this
    // row.
    flexDirection: "column",
    paddingHorizontal: 16,
    gap: 10,
    paddingTop: 12,
    backgroundColor: colors.bgDefault,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.borderSubtle,
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
  },
  actionRow: { flexDirection: "row", gap: 10 },
  // flex:1 keeps both action wrappers equal in width.
  actionBtnWrap: { flex: 1, minWidth: 0 },
  actionBtn: {
    // No vertical flex:1 inside the auto-height wrapper: it collapses in Yoga.
    minHeight: 54,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingHorizontal: 10,
    paddingVertical: 13,
    borderRadius: radius.md,
    // Everyday actions share the home's neutral black fill. Direction stays
    // in the arrow, label and physical position (received LEFT, gave RIGHT).
    backgroundColor: colors.actionPrimary,
    ...Platform.select({
      ios: {
        shadowColor: "#000",
        shadowOpacity: 0.16,
        shadowRadius: 14,
        shadowOffset: { width: 0, height: 5 },
      },
      android: { elevation: 4 },
    }),
  },
  // Subtle scale + dim on press — a tactile, considered feel for a button
  // tapped all day, instead of a flat opacity blink.
  actionBtnPressed: { opacity: 0.9, transform: [{ scale: 0.985 }] },
  // Soft translucent circle that gives the arrow a deliberate home on the dark
  // fill — the key "refined" detail vs a bare floating arrow.
  actionIconCoin: {
    width: ACTION_COIN_SIZE,
    height: ACTION_COIN_SIZE,
    borderRadius: ACTION_COIN_SIZE / 2,
    backgroundColor: "rgba(255,255,255,0.13)",
    alignItems: "center",
    justifyContent: "center",
  },
  actionText: {
    flexShrink: 1,
    textAlign: "center",
    lineHeight: sansLineHeight(15, 20),
    fontSize: 15,
    fontFamily: fonts.sansSemi,
    color: colors.textInverted,
    letterSpacing: 0.2,
  },
  // One bordered card around all tallies (same as the home people list). No
  // per-row corner emulation, so no blank-row-on-reorder bug.
  entriesCard: {
    marginHorizontal: 16,
    marginTop: 8,
    borderWidth: 1,
    borderColor: colors.borderDefault,
    borderRadius: radius.md,
    overflow: "hidden",
    backgroundColor: colors.bgDefault,
  },
  divider: { height: 1, backgroundColor: colors.borderDefault },
  // Settle-up ruled line — ledger furniture, not a button. Sits between the
  // action row and the entries card only when settlement is possible.
  settleRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    marginHorizontal: 24,
    marginTop: 16,
    marginBottom: 4,
    // Was 32 — the one control that rules off an account was under the HIG
    // floor with no hitSlop. Grown rather than hitSlop'd because this row
    // stands alone between the action buttons and the entries card (nothing
    // tappable within 20px), and alignItems:"center" keeps the ruled line
    // optically where it was; only the surrounding air changes.
    minHeight: TOUCH_MIN,
  },
  settleRule: {
    flex: 1,
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.textSubtle,
    opacity: 0.5,
  },
  settleRowText: {
    fontSize: 12,
    fontFamily: fonts.sansMedium,
    color: colors.textSubtle,
  },
  // Dated ruled-off line between chapters in the full-history view.
  chapterLine: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    backgroundColor: colors.bgMuted,
  },
  chapterLineText: {
    fontSize: 11,
    fontFamily: fonts.sansMedium,
    color: colors.textSubtle,
  },
  // Settled-history collapse row — one quiet line under the entries card.
  historyRow: {
    alignItems: "center",
    paddingVertical: 14,
  },
  historyRowText: {
    fontSize: 12,
    fontFamily: fonts.sansMedium,
    color: colors.textSubtle,
  },
  // "Before linking · N" fold — the historyRow with a chevron, since unlike
  // the settled toggle its label does not change wording between states.
  foldRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 4,
    paddingVertical: 14,
    minHeight: TOUCH_MIN,
  },
  // Frozen pages sit on the muted ground the chapter lines use, so the eye
  // reads them as history the moment the fold opens.
  preLinkCard: { marginTop: 0, backgroundColor: colors.bgMuted },
});
