import type { ScrollViewInstance, TextInputInstance, ViewInstance } from "react-native";
import { BlurTargetView } from "expo-blur";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
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
  Keyboard,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
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
import { CustomerBalanceCarousel } from "../../components/CustomerBalanceCarousel";
import { BalanceCardGlass } from "../../components/BalanceCardGlass";
import { HomeBalanceFilterSwipe } from "../../components/HomeBalanceFilterSwipe";
import { CustomerTallyFilterPopover } from "../../components/CustomerTallyFilterPopover";
import type { FilterAnchor } from "../../components/HomeFilterPopover";
import { CreditIntentList } from "../../components/CreditIntentList";
import { CreditStatusBadge } from "../../components/CreditStatusBadge";
import { EntryRow } from "../../components/EntryRow";
import { CustomerNoteCard } from "../../components/CustomerNoteCard";
import { SharedAccountBadge } from "../../components/SharedAccountBadge";
import { SearchControlSlot } from "../../components/SearchControlSlot";
import { SearchKeyboardFooter, SearchKeyboardFrame } from "../../components/SearchKeyboardMotion";
import { SelectionToolbar } from "../../components/SelectionToolbar";
import { SettledHistoryToggle } from "../../components/SettledHistoryToggle";
import { personCurrencyRows, selectedEntriesByCurrency } from "../../lib/multi-currency-view";
import { getPersonEnabledCurrencies } from "../../lib/person-currency";
import { sharedAccountLinkStatus } from "../../lib/tabs/link-status";
import { canWriteSharedTallies, isNotificationOnlyMode } from "../../lib/tabs/recording-mode";
import { useCustomerGroups } from "../../lib/use-customer-groups";
import { LinkAccountDialog } from "../../components/LinkAccountDialog";
import { OverflowMenu } from "../../components/OverflowMenu";
import { OptionSheet } from "../../components/OptionSheet";
import { TOAST_LIFT, useToast, useToastOffset } from "../../components/Toast";
import { loadRelationshipAttribution, type EntryAttribution } from "../../lib/attribution";
import { colors } from "../../lib/colors";
import {
  getCurrentCurrencyCode,
  getCurrencyLabel,
  getCurrencySymbol,
  setCurrentCurrency,
  useCurrency,
} from "../../lib/currency";
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
  getPersonNoteDetails,
  getPersonNoteHistory,
  type PersonNoteDetails,
} from "../../lib/person-note";
import { balanceContribution } from "../../lib/export/shared-record";
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
import { entryRecordedAt } from "../../lib/entry-date";
import { getReducedMotion } from "../../lib/reduced-motion";
import { getLocale, getShareLangPref, resolveShareLang, t, type LocaleCode } from "../../lib/i18n";
import { formatSettlementDate } from "../../lib/jalali";
import { useCalendar } from "../../lib/calendar";
import { shareKaataCurrenciesViaWhatsApp, type WhatsAppShareStage } from "../../lib/share";
import { getBillLinksEnabled } from "../../lib/bill-link-settings";
import { filterTallies, noteSearchTerms } from "../../lib/tally-search";
import {
  filterTalliesByDate,
  formatDateRangeLabel,
  type TallyDateRange,
} from "../../lib/tally-date-filter";
import { summarizeTallyFlows } from "../../lib/tally-summary";
import {
  DEFAULT_TALLY_LIST_FILTER,
  filterTallyEntries,
  normalizeTallyCurrencies,
  normalizeTallyListFilter,
  sortTallyEntries,
  swipeTallyDirection,
  toggleTallyCardFilter,
  type TallyDirectionFilter,
  type TallyListFilter,
} from "../../lib/tally-list-filter";
import {
  getTabLink,
  getFinancialTabLinkForPerson,
  getLatestTabLinkForPerson,
  listOpenTabLinksForPerson,
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
  if (
    err instanceof TabApiError &&
    (err.code === "notification_only_unsupported" || err.code === "one_way_tallies_unsupported")
  )
    return t("tab.link.serverUpdate");
  if (err instanceof TabApiError && err.code === "one_way_read_only")
    return t("tab.recordingMode.oneWayReadOnly");
  if (err instanceof TabApiError && err.code === "recording_upgrade_required")
    return t("tab.link.clientUpdate");
  if (err instanceof TabApiError && err.code === "shared_history_opening_required")
    return t("tab.history.openingRequired");
  if (err instanceof TabApiError && err.code === "shared_history_pending")
    return t("tab.history.pending");
  if (err instanceof TabApiError && err.code === "shared_history_changed")
    return t("tab.history.changed");
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

type CurrencyPeriod = {
  currency: string;
  person: PersonWithBalance;
  entries: Entry[];
  settlement: { count: number; lastSettledAtMs: number | null };
  boundaries: number[];
  tab: TabLink | null;
  financialTab: TabLink | null;
  sharedSettlements: TabSettlement[];
  before: Entry[];
  priorPeriods: Array<{ link: TabLink; entries: Entry[]; settlements: TabSettlement[] }>;
};

function currencyChapter(period: CurrencyPeriod): Entry[] {
  const through = period.sharedSettlements.at(-1)?.through_seq ?? 0;
  return period.entries
    .filter(visibleTally)
    .filter((entry) =>
      period.financialTab
        ? afterSharedSettlement(entry, through, period.financialTab.tab_id)
        : period.settlement.lastSettledAtMs == null ||
          entryRecordedAt(entry) > period.settlement.lastSettledAtMs,
    );
}

function canSettlePeriod(period: CurrencyPeriod): boolean {
  const chapter = currencyChapter(period);
  return (
    canWriteSharedTallies(period.financialTab) &&
    period.person.tab_unsynced !== 1 &&
    period.person.tab_close_pending !== 1 &&
    period.person.balance === 0 &&
    chapter.length > 0 &&
    // Older private boundaries could split a balanced pair by business date.
    // An explicit new marker can close that known, zero ledger atomically;
    // the command rechecks its full balance and covers all recorded rows.
    // Shared history must still prove its exact sequence chapter is zero.
    (!period.financialTab || sumAmounts(chapter.map(balanceContribution)) === 0) &&
    (period.person.tab_pending ?? 0) === 0 &&
    (period.person.tab_pending_count ?? 0) === 0 &&
    (period.person.tab_pending_balance ?? 0) === 0 &&
    !period.entries.some(
      (entry) =>
        entry.tab &&
        (entry.tab.local_pending ||
          (!entry.tab.voided && entry.tab.kind !== "void" && entry.tab.status === "pending")),
    ) &&
    (!period.financialTab || period.financialTab.closed_at == null) &&
    !period.entries.some(
      (entry) =>
        entry.tab?.tab_id &&
        entry.tab.tab_id !== period.financialTab?.tab_id &&
        balanceContribution(entry) !== 0,
    )
  );
}

function signedSharedAmount(amount: number): string {
  return ltrIsolate(`${amount > 0 ? "+" : amount < 0 ? "−" : ""}${formatAmount(amount)}`);
}

export default function PersonDetailScreen() {
  const router = useRouter();
  const toast = useToast();
  const toastOffset = useToastOffset();
  const [actionsHeight, setActionsHeight] = useState(100);
  const measuredActionsHeight = useRef(100);
  const keyboardMoving = useRef(false);
  const actionsHeightFrame = useRef<number | null>(null);
  // A toast sits behind the keyboard, so lifting the dock above an open
  // keyboard only made it jump while typing.
  const [keyboardShown, setKeyboardShown] = useState(false);
  const keyboardShownRef = useRef(false);
  const [searchFocused, setSearchFocused] = useState(false);
  // Android reports keyboard visibility after adjustResize has already moved
  // the dock. Prepare its compact layout on focus instead of jumping again
  // at didShow, and retain it through blur until the native keyboard hides.
  const compactDock = keyboardShown || (Platform.OS === "android" && searchFocused);
  // On iOS an explicit blur precedes willHide. Keep this control in place
  // until that event can collapse it with the native keyboard movement.
  const dismissControlVisible = searchFocused || (Platform.OS === "ios" && keyboardShown);
  keyboardShownRef.current = compactDock;
  const searchInputRef = useRef<TextInputInstance>(null);
  const keyboardRouteFocused = useRef(false);
  function cancelActionsHeightFrame() {
    if (actionsHeightFrame.current !== null) {
      cancelAnimationFrame(actionsHeightFrame.current);
      actionsHeightFrame.current = null;
    }
  }
  function publishActionsHeight() {
    if (keyboardRouteFocused.current) setActionsHeight(measuredActionsHeight.current);
  }
  function settleActionsHeight() {
    cancelActionsHeightFrame();
    if (Platform.OS !== "ios") {
      publishActionsHeight();
      return;
    }
    if (!keyboardRouteFocused.current) return;
    // Native keyboard padding changes the dock every frame. Publish its final
    // list reservation after those layouts, without rerendering the ledger
    // for each intermediate height.
    keyboardMoving.current = true;
    const commitFrame = requestAnimationFrame(() => {
      if (actionsHeightFrame.current !== commitFrame) return;
      const layoutFrame = requestAnimationFrame(() => {
        if (actionsHeightFrame.current !== layoutFrame) return;
        actionsHeightFrame.current = null;
        keyboardMoving.current = false;
        publishActionsHeight();
      });
      actionsHeightFrame.current = layoutFrame;
    });
    actionsHeightFrame.current = commitFrame;
  }
  useRouteFocusEffect(
    useCallback(() => {
      keyboardRouteFocused.current = true;
      keyboardMoving.current = false;
      return () => {
        keyboardRouteFocused.current = false;
        cancelActionsHeightFrame();
        keyboardMoving.current = false;
      };
    }, []),
  );
  const dismissSearchKeyboard = useCallback(() => {
    searchInputRef.current?.blur();
    setSearchFocused(false);
    Keyboard.dismiss();
  }, []);
  useEffect(() => {
    const syncLayout = (shown: boolean) => {
      keyboardShownRef.current = shown;
      setKeyboardShown(shown);
    };
    const finishHide = () => {
      // A previous hide can finish after native focus has already reopened
      // this input, before its new JS onFocus event has arrived.
      if (Platform.OS === "ios" && searchInputRef.current?.isFocused()) return;
      searchInputRef.current?.blur();
      setSearchFocused(false);
      keyboardShownRef.current = false;
      setKeyboardShown(false);
      settleActionsHeight();
    };
    const show = Keyboard.addListener(
      Platform.OS === "ios" ? "keyboardWillShow" : "keyboardDidShow",
      () => {
        if (Platform.OS === "ios") {
          keyboardMoving.current = true;
          cancelActionsHeightFrame();
        }
        syncLayout(true);
        if (Platform.OS !== "ios") settleActionsHeight();
      },
    );
    const hide = Keyboard.addListener(
      Platform.OS === "ios" ? "keyboardWillHide" : "keyboardDidHide",
      () => {
        if (Platform.OS === "ios") {
          keyboardMoving.current = true;
          cancelActionsHeightFrame();
        }
        syncLayout(false);
        if (Platform.OS !== "ios") finishHide();
      },
    );
    const didShow =
      Platform.OS === "ios"
        ? Keyboard.addListener("keyboardDidShow", () => {
            syncLayout(true);
            settleActionsHeight();
          })
        : null;
    // Do not blur at willHide: an interactive drag may still be cancelled.
    const didHide =
      Platform.OS === "ios" ? Keyboard.addListener("keyboardDidHide", finishHide) : null;
    return () => {
      show.remove();
      hide.remove();
      didShow?.remove();
      didHide?.remove();
      cancelActionsHeightFrame();
    };
  }, []);
  const insets = useSafeAreaInsets();
  // Clerks can add; only editors and above can amend/review/cancel.
  const {
    canCreate,
    canAmend,
    canConfigureCredit,
    resolved: roleResolved,
  } = useActiveVaultWriteCaps(getActiveVaultIdSyncMaybe());
  const canManageCredit = roleResolved && canConfigureCredit;
  const {
    id,
    entryId,
    notificationKey,
    reminderId,
    reminderActionKey,
    currency: routeCurrency,
  } = useLocalSearchParams<{
    id: string;
    entryId?: string;
    notificationKey?: string;
    reminderId?: string;
    reminderActionKey?: string;
    currency?: string;
  }>();
  const selectedCurrency = useCurrency();
  useEffect(() => {
    if (typeof routeCurrency === "string") setCurrentCurrency(routeCurrency);
  }, [routeCurrency]);
  const flowScope = `${getAccountIdSync() ?? "local"}:${getActiveVaultIdSyncMaybe() ?? "none"}:${id}:${selectedCurrency}`;
  const nativeTallyScroll = useMemo(
    () => Gesture.Native().shouldActivateOnStart(false).disallowInterruption(false),
    [],
  );
  const filterSurfaceRef = useRef<ViewInstance | null>(null);
  const filterBlurTarget = useRef<ViewInstance | null>(null);
  const tallyFilterTrigger = useRef<ViewInstance | null>(null);
  const [filterSurface, setFilterSurface] = useState({ width: 0, height: 0 });
  const [tallyFilterAnchor, setTallyFilterAnchor] = useState<FilterAnchor | null>(null);
  const [tallyFiltersVisible, setTallyFiltersVisible] = useState(false);
  const tallyFiltersVisibleRef = useRef(false);
  tallyFiltersVisibleRef.current = tallyFiltersVisible;
  const filterMeasureVersion = useRef(0);
  const filterIntent = JSON.stringify([flowScope, entryId, notificationKey]);
  const filterOwnership = useRef({ scope: filterIntent, epoch: 0 });
  if (filterOwnership.current.scope !== filterIntent)
    filterOwnership.current = { scope: filterIntent, epoch: filterOwnership.current.epoch + 1 };
  const filterEpoch = filterOwnership.current.epoch;
  const [tallyView, setTallyView] = useState({
    scope: flowScope,
    filter: DEFAULT_TALLY_LIST_FILTER,
  });
  const scrollRef = useRef<ScrollViewInstance>(null);
  const tallyContentY = useRef(0);
  const entriesCardY = useRef(new Map<string, number>());
  const entryPositions = useRef(new Map<string, { y: number; height: number; card: string }>());
  const layoutScope = useRef(flowScope);
  const layoutKey = `${filterIntent}:${filterEpoch}`;
  const layoutPresentation = useRef(layoutKey);
  if (layoutScope.current !== flowScope || layoutPresentation.current !== layoutKey) {
    layoutScope.current = flowScope;
    layoutPresentation.current = layoutKey;
    tallyContentY.current = 0;
    entriesCardY.current.clear();
    entryPositions.current.clear();
  }
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
  const [customerNote, setCustomerNote] = useState<{
    scope: string;
    value: PersonNoteDetails | null;
  }>({
    scope: "",
    value: null,
  });
  const visibleCustomerNote = customerNote.scope === flowScope ? customerNote.value : null;
  const customerNoteKey = JSON.stringify([
    flowScope,
    visibleCustomerNote?.note,
    visibleCustomerNote?.updated?.eventId,
  ]);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [self, setSelf] = useState<Self | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [sheetFor, setSheetFor] = useState<Entry | null>(null);
  const [confirmDeleteFor, setConfirmDeleteFor] = useState<Entry | null>(null);
  // Settle-up ("rule off the account", 2026-07-27). No persistent buttons:
  // the affordance is a ruled-line row that only exists at balance zero with
  // an open chapter. Earlier tallies stay behind the full-history toggle.
  const [settlement, setSettlement] = useState<{ count: number; lastSettledAtMs: number | null }>({
    count: 0,
    lastSettledAtMs: null,
  });
  // Every boundary (oldest→newest) — the full-history view draws each
  // ruled-off line with its settlement date, like a paper khata.
  const [boundaries, setBoundaries] = useState<number[]>([]);
  const [sharedSettlements, setSharedSettlements] = useState<TabSettlement[]>([]);
  const [currencyPeriods, setCurrencyPeriods] = useState<CurrencyPeriod[]>([]);
  const [entryCurrencies, setEntryCurrencies] = useState<{ scope: string; codes: string[] }>({
    scope: "",
    codes: [],
  });
  const [settleCurrency, setSettleCurrency] = useState<string | null>(null);
  const settlementRequest = useRef<{ id: string; throughSeq: number; tabId: string } | null>(null);
  const [historyDisclosure, setHistoryDisclosure] = useState({ key: "", expanded: false });
  const showFullHistory = historyDisclosure.key === layoutKey && historyDisclosure.expanded;
  const [searchQuery, setSearchQuery] = useState("");
  const [dateRange, setDateRange] = useState<TallyDateRange | null>(null);
  const [dateSheetVisible, setDateSheetVisible] = useState(false);
  const screenScope = useRef(flowScope);
  screenScope.current = flowScope;
  const [selectionScope, setSelectionScope] = useState<string | null>(null);
  const [selectionMeasurement, setSelectionMeasurement] = useState<{
    scope: string | null;
    height: number;
  }>({ scope: null, height: 0 });
  const selectionMeasurementRef = useRef(selectionMeasurement);
  const [selectedEntryIds, setSelectedEntryIds] = useState<Set<string>>(new Set());
  const [confirmSelectionDelete, setConfirmSelectionDelete] = useState(false);
  const selectionConfirmationVersion = useRef(0);
  const selectionDeleteCount = useRef(0);
  const [selectionBusy, setSelectionBusy] = useState(false);
  const selectionBusyRef = useRef(false);
  useEffect(() => {
    setSearchQuery("");
    setDateRange(null);
    setTallyView({ scope: flowScope, filter: DEFAULT_TALLY_LIST_FILTER });
    setTallyFiltersVisible(false);
    setTallyFilterAnchor(null);
    filterMeasureVersion.current++;
    setDateSheetVisible(false);
    setSheetFor(null);
    setLinkCurrencyVisible(false);
    setManagementCurrency(null);
    dismissSearchKeyboard();
  }, [flowScope, entryId, notificationKey, dismissSearchKeyboard]);
  useEffect(() => {
    // A notification may target an old chapter. Prepare its full timeline once;
    // ordinary filters and re-renders must not reopen a manually closed history.
    setHistoryDisclosure({ key: layoutKey, expanded: !!entryId });
  }, [layoutKey]);
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
    if (!row || row.card !== `${flowScope}:current` || !viewport.current.height) return;
    const cardY = entriesCardY.current.get(row.card);
    if (cardY == null) return;
    highlightedRequest.current = key;
    const target = tallyScrollTarget({
      top: tallyContentY.current + cardY + row.y,
      height: row.height,
      offset: viewport.current.offset,
      viewport: viewport.current.height,
      bottomInset: actionsHeight + (keyboardShownRef.current ? 0 : viewport.current.lift),
    });
    if (target != null)
      scrollRef.current?.scrollTo({
        y: target,
        animated: !getReducedMotion(),
      });
    setHighlight({ id: entryId, key });
  }, [
    id,
    entryId,
    notificationKey,
    flowScope,
    showFullHistory,
    entries,
    canCreate,
    actionsHeight,
    insets.bottom,
  ]);
  useEffect(() => {
    // Wait for history layout; onLayout/content-size handle cold loads.
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
  useEffect(() => () => cancelPing(), [cancelPing, selectedCurrency]);
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
  // OPEN for new sharing. Existing pending tallies can still be reviewed after
  // unlinking; they resolve against their own retained tab, never a newer link.
  // Once shared, `entries` are the tab's rows and `person.balance` is the tab
  // balance (D8); `preLink` holds the frozen local rows from before linking,
  // shown behind a fold and excluded from the balance because the opening
  // entry already carries their sum. Closing does not undo any of that: the
  // rows and the fold stay, so the history and the number both survive.
  const [tabHistory, setTabHistory] = useState<TabLink | null>(null);
  const link = tabHistory != null && tabHistory.closed_at == null ? tabHistory : null;
  // An untouched invitation has no ledger chapter of its own. Keep its
  // management link above, but retain the private or earlier shared book.
  const financialTabHistory =
    (currencyPeriods.find((period) => period.currency === selectedCurrency) ?? currencyPeriods[0])
      ?.financialTab ?? null;
  const writableEntryCurrency =
    entryCurrencies.scope === flowScope
      ? (entryCurrencies.codes.find((code) => code === (person?.currency ?? selectedCurrency)) ??
        entryCurrencies.codes[0])
      : undefined;
  const sharedAccountStatus = currencyPeriods.some(
    (period) => sharedAccountLinkStatus(period.tab) === "joined",
  )
    ? "joined"
    : currencyPeriods.some((period) => sharedAccountLinkStatus(period.tab) === "waiting")
      ? "waiting"
      : "none";
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
  const [managementCurrency, setManagementCurrency] = useState<string | null>(null);
  const [linkCurrencyVisible, setLinkCurrencyVisible] = useState(false);
  const linkCurrencyBusy = useRef(false);
  const openGroupLink = currencyPeriods
    .map((period) => period.tab)
    .find((candidate) => candidate?.group_id && candidate.closed_at == null);
  const legacyLinkedPeriods = currencyPeriods.filter(
    (period) => period.tab && !period.tab.group_id && period.tab.closed_at == null,
  );
  const managementLink =
    managementCurrency == null
      ? (openGroupLink ?? link)
      : (currencyPeriods.find((period) => period.currency === managementCurrency)?.tab ?? null);
  const managementCurrencies = managementLink?.group_id
    ? currencyPeriods
        .filter((period) => period.tab?.group_id === managementLink.group_id)
        .map((period) => period.currency)
    : [managementCurrency ?? person?.currency ?? selectedCurrency];
  const managementCurrencyLabel = managementCurrencies.map(getCurrencyLabel).join(" · ");
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

  // Private chapter membership follows immutable recording time. An editable
  // business date changes the row's date, never which settlement closed it.
  // The settled section changes visibility, never stored money.
  //
  // Shared chapters use server sequence, so backdating a new tally can never
  // tuck it behind an old settlement. Local boundaries only apply locally.
  const displayedEntries = useMemo(() => entries.filter(visibleTally), [entries]);
  const flowSummaries = useMemo(() => {
    const groups = new Map<string, Entry[]>();
    for (const entry of flowHistory?.scope === flowScope ? flowHistory.entries : []) {
      const code = entry.currency ?? person?.currency ?? selectedCurrency;
      const group = groups.get(code) ?? [];
      group.push(entry);
      groups.set(code, group);
    }
    return new Map([...groups].map(([code, entries]) => [code, summarizeTallyFlows(entries)]));
  }, [flowHistory, flowScope]);
  const tallyCurrencyCodes = useMemo(
    () =>
      normalizeTallyCurrencies([
        ...(person ? personCurrencyRows(person) : []).map(
          (row) => row.currency ?? selectedCurrency,
        ),
        ...[...entries, ...preLink, ...failedTallies].map(
          (entry) => entry.currency ?? selectedCurrency,
        ),
      ]),
    [person, entries, preLink, failedTallies, selectedCurrency],
  );
  const tallyFilter = normalizeTallyListFilter(
    tallyView.scope === flowScope ? tallyView.filter : DEFAULT_TALLY_LIST_FILTER,
    tallyCurrencyCodes,
  );
  const tallyFilterKey = JSON.stringify(tallyFilter);
  const tallyFilterRef = useRef(tallyFilter);
  tallyFilterRef.current = tallyFilter;
  const searchTerms = useMemo(() => noteSearchTerms(searchQuery), [searchQuery]);
  const directionalFiltering = tallyFilter.direction !== "all" || tallyFilter.currencies.length > 0;
  const tallyFiltersApplied = directionalFiltering || dateRange != null;
  const tallyFiltersActive = tallyFiltersApplied || tallyFilter.sort !== "recent";
  const searching = searchTerms.length > 0 || dateRange != null || directionalFiltering;
  const searchingRef = useRef(searching);
  searchingRef.current = searching;
  const matchedEntries = useMemo(
    () =>
      filterTallyEntries(
        filterTalliesByDate(filterTallies(displayedEntries, searchTerms), dateRange),
        tallyFilter,
        selectedCurrency,
      ),
    [displayedEntries, searchTerms, dateRange, tallyFilterKey, selectedCurrency],
  );
  const matchedPreLink = useMemo(() => {
    const matched = filterTallyEntries(
      filterTalliesByDate(filterTallies(preLink, searchTerms), dateRange),
      tallyFilter,
      selectedCurrency,
    );
    return tallyFilter.sort === "recent"
      ? matched
      : sortTallyEntries(matched, tallyFilter.sort, selectedCurrency);
  }, [preLink, searchTerms, dateRange, tallyFilterKey, selectedCurrency]);
  const matchedFailedTallies = useMemo(() => {
    const matched = filterTallyEntries(
      filterTalliesByDate(filterTallies(failedTallies, searchTerms), dateRange),
      tallyFilter,
      selectedCurrency,
    );
    return tallyFilter.sort === "recent"
      ? matched
      : sortTallyEntries(matched, tallyFilter.sort, selectedCurrency);
  }, [failedTallies, searchTerms, dateRange, tallyFilterKey, selectedCurrency]);
  const hasTallies = entries.length > 0 || preLink.length > 0 || failedTallies.length > 0;
  const dateRangeLabel = formatDateRangeLabel(dateRange, locale, calendar);
  const searchResultCount =
    matchedEntries.length + matchedPreLink.length + matchedFailedTallies.length;
  const chapterEntries = useMemo(
    () =>
      displayedEntries.filter((entry) => {
        const period = currencyPeriods.find(
          (period) => period.currency === (entry.currency ?? person?.currency ?? selectedCurrency),
        );
        if (!period) return true;
        return period.financialTab
          ? afterSharedSettlement(
              entry,
              period.sharedSettlements.at(-1)?.through_seq ?? 0,
              period.financialTab.tab_id,
            )
          : period.settlement.lastSettledAtMs == null ||
              entryRecordedAt(entry) > period.settlement.lastSettledAtMs;
      }),
    [displayedEntries, currencyPeriods, person?.currency, selectedCurrency],
  );
  // The current chapter must explain the complete balance in every currency.
  // Retroactive edits, backdated amounts and unknown/pending shared changes
  // keep the full history visible rather than hiding records behind a boundary.
  const chapterCoherent = currencyPeriods.every(
    (period) =>
      period.person.tab_unsynced !== 1 &&
      period.person.tab_close_pending !== 1 &&
      (period.person.tab_pending ?? 0) === 0 &&
      (period.person.tab_pending_count ?? 0) === 0 &&
      (period.person.tab_pending_balance ?? 0) === 0 &&
      !period.entries.some(
        (entry) =>
          entry.tab &&
          (entry.tab.local_pending ||
            (!entry.tab.voided && entry.tab.kind !== "void" && entry.tab.status === "pending")),
      ) &&
      sumAmounts(currencyChapter(period).map(balanceContribution)) === period.person.balance,
  );
  const settledTallyCount = displayedEntries.length - chapterEntries.length;
  const effectiveShowFull = showFullHistory || !chapterCoherent;
  const visibleEntries = effectiveShowFull ? displayedEntries : chapterEntries;
  // Full history keeps each row in its recorded chapter and uses business
  // dates only to order rows within that chapter. Adjacent empty settlement
  // markers collapse; a later backdated row cannot move beneath an old line.
  type HistoryItem =
    | { kind: "entry"; entry: Entry }
    | { kind: "marker"; ms: number; settlement?: TabSettlement; currency?: string };
  const withLocalMarkers = useCallback(
    (list: Entry[], localBoundaries = boundaries): HistoryItem[] => {
      const items: HistoryItem[] = [];
      const desc = [...new Set(localBoundaries)].sort((a, b) => b - a);
      const chapter = (recordedAt: number) => {
        let first = 0;
        let end = desc.length;
        while (first < end) {
          const middle = (first + end) >>> 1;
          if (desc[middle] >= recordedAt) first = middle + 1;
          else end = middle;
        }
        return first;
      };
      const ordered = list
        .map((entry) => ({ entry, chapter: chapter(entryRecordedAt(entry)) }))
        .sort(
          (a, b) =>
            a.chapter - b.chapter ||
            b.entry.created_at - a.entry.created_at ||
            b.entry.id.localeCompare(a.entry.id),
        );
      let bi = 0;
      for (const { entry: e } of ordered) {
        while (bi < desc.length && desc[bi] >= entryRecordedAt(e)) {
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
  // Expanding history uses this same timeline. Search and view filters always
  // span settled chapters without changing balances or stored records.
  const allHistoryItems = useMemo<HistoryItem[]>(() => {
    if (currencyPeriods.length > 1) {
      const list = searching ? matchedEntries : visibleEntries;
      const streams: HistoryItem[][] = currencyPeriods.map((period) => {
        const rows = list.filter(
          (entry) => (entry.currency ?? person?.currency ?? selectedCurrency) === period.currency,
        );
        if (period.financialTab)
          return sharedHistory(
            rows,
            searching || effectiveShowFull ? period.sharedSettlements : [],
            period.financialTab.tab_id,
          ).map((item) => (item.kind === "marker" ? { ...item, currency: period.currency } : item));
        if (!(searching || effectiveShowFull))
          return rows.map((entry) => ({ kind: "entry" as const, entry }));
        return withLocalMarkers(rows, period.boundaries).map((item) =>
          item.kind === "marker" ? { ...item, currency: period.currency } : item,
        );
      });
      // Merge the currency timelines without reordering either one's chapter
      // markers (or a shared period's authoritative server sequences).
      const positions = streams.map(() => 0);
      const merged: HistoryItem[] = [];
      const stamp = (item: HistoryItem) =>
        item.kind === "marker" ? item.ms : item.entry.created_at;
      for (;;) {
        let next = -1;
        for (let i = 0; i < streams.length; i++) {
          const head = streams[i][positions[i]];
          if (head && (next < 0 || stamp(head) > stamp(streams[next][positions[next]]))) next = i;
        }
        if (next < 0) break;
        merged.push(streams[next][positions[next]++]);
      }
      return merged;
    }
    if (searching) {
      const items = financialTabHistory
        ? sharedHistory(matchedEntries, sharedSettlements, financialTabHistory.tab_id)
        : withLocalMarkers(matchedEntries);
      const shown = items.filter(
        (item, i) => item.kind === "entry" || items[i - 1]?.kind !== "marker",
      );
      while (shown.at(-1)?.kind === "marker") shown.pop();
      return shown;
    }
    if (financialTabHistory)
      return sharedHistory(
        visibleEntries,
        effectiveShowFull ? sharedSettlements : [],
        financialTabHistory.tab_id,
      );
    if (!effectiveShowFull || boundaries.length === 0)
      return visibleEntries.map((entry) => ({ kind: "entry", entry }));
    return withLocalMarkers(displayedEntries);
  }, [
    searching,
    matchedEntries,
    financialTabHistory,
    effectiveShowFull,
    displayedEntries,
    visibleEntries,
    sharedSettlements,
    boundaries.length,
    withLocalMarkers,
    currencyPeriods,
    person?.currency,
    selectedCurrency,
  ]);
  // Settlement lines describe chronological chapters. Alternate view ordering
  // must never place those lines beside an unrelated amount or reversed date.
  const historyItems: HistoryItem[] =
    tallyFilter.sort === "recent"
      ? allHistoryItems
      : sortTallyEntries(
          allHistoryItems.flatMap((item) => (item.kind === "entry" ? [item.entry] : [])),
          tallyFilter.sort,
          selectedCurrency,
        ).map((entry) => ({ kind: "entry" as const, entry }));
  // Retain only Android rows already shown in this screen's active chapter.
  // Repeated filtering can reuse native text views; settled/deleted/moved rows
  // leave the authoritative chapter immediately and are never cached snapshots.
  const reuseTallyRows = Platform.OS === "android";
  const tallyRowsOwner = useRef({ scope: layoutKey, ids: [] as string[], alive: true });
  if (tallyRowsOwner.current.scope !== layoutKey)
    tallyRowsOwner.current = { scope: layoutKey, ids: [], alive: true };
  const tallyRowsLease = tallyRowsOwner.current;
  useEffect(() => {
    tallyRowsLease.alive = true;
    return () => {
      tallyRowsLease.alive = false;
    };
  }, [tallyRowsLease]);
  const renderedHistory = useMemo(() => {
    const shown = historyItems.map((item, index) => ({ item, index, hidden: false }));
    if (!reuseTallyRows) return shown;
    const universe = new Map(
      chapterEntries.filter((entry) => entry.deleted_at == null).map((entry) => [entry.id, entry]),
    );
    const visible = new Set(
      historyItems.flatMap((item) => (item.kind === "entry" ? [item.entry.id] : [])),
    );
    const hiddenIds = tallyRowsLease.ids.filter((id) => !visible.has(id) && universe.has(id));
    tallyRowsLease.ids = [...visible].filter((id) => universe.has(id)).concat(hiddenIds);
    return [
      ...shown,
      ...hiddenIds.map((id) => ({
        item: { kind: "entry" as const, entry: universe.get(id)! },
        index: -1,
        hidden: true,
      })),
    ];
  }, [historyItems, chapterEntries, reuseTallyRows, tallyRowsLease]);
  type TallyRowAction = "open" | "select" | "accept" | "reject" | "cancel";
  const tallyRowActions = useRef({
    lease: tallyRowsLease,
    visible: new Map<string, Entry>(),
    allowed: new Map<string, ReadonlySet<TallyRowAction>>(),
    actions: {} as Partial<Record<TallyRowAction, (entry: Entry) => void | Promise<void>>>,
  });
  tallyRowActions.current = {
    lease: tallyRowsLease,
    visible: new Map(
      historyItems.flatMap((item) =>
        item.kind === "entry" ? [[item.entry.id, item.entry] as const] : [],
      ),
    ),
    allowed: new Map(),
    actions: {},
  };
  const runTallyRowAction = useCallback(
    (action: TallyRowAction, entry: Entry) => {
      const current = tallyRowActions.current;
      if (!tallyRowsLease.alive || current.lease !== tallyRowsLease) return;
      const fresh = current.visible.get(entry.id);
      if (!fresh || !current.allowed.get(entry.id)?.has(action)) return;
      return current.actions[action]?.(fresh);
    },
    [tallyRowsLease],
  );
  const openTallyRow = useCallback(
    (entry: Entry) => runTallyRowAction("open", entry),
    [runTallyRowAction],
  );
  const selectTallyRow = useCallback(
    (entry: Entry) => runTallyRowAction("select", entry),
    [runTallyRowAction],
  );
  const acceptTallyRow = useCallback(
    (entry: Entry) => runTallyRowAction("accept", entry),
    [runTallyRowAction],
  );
  const rejectTallyRow = useCallback(
    (entry: Entry) => runTallyRowAction("reject", entry),
    [runTallyRowAction],
  );
  const cancelTallyRow = useCallback(
    (entry: Entry) => runTallyRowAction("cancel", entry),
    [runTallyRowAction],
  );
  // Shared and ruled-off tallies retain their existing individual workflows.
  // Eligibility spans this contact's full history. Search filters only decide
  // which eligible rows Select all toggles; already selected rows stay selected.
  const selecting =
    selectionScope === flowScope && flowHistory?.scope === flowScope && roleResolved && canAmend;
  const selectableEntries = useMemo(
    () =>
      flowHistory?.scope === flowScope && roleResolved && canAmend
        ? displayedEntries.filter((entry) => {
            const period = currencyPeriods.find(
              (period) =>
                period.currency === (entry.currency ?? person?.currency ?? selectedCurrency),
            );
            return (
              !entry.tab &&
              !period?.financialTab &&
              (!period?.tab || period.tab.closed_at != null) &&
              period?.person.tab_close_pending !== 1 &&
              (period?.settlement.lastSettledAtMs == null ||
                entryRecordedAt(entry) > period.settlement.lastSettledAtMs)
            );
          })
        : [],
    [
      flowHistory?.scope,
      flowScope,
      displayedEntries,
      roleResolved,
      canAmend,
      financialTabHistory,
      settlement.lastSettledAtMs,
      currencyPeriods,
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
  const selectionSummaries = selectedEntriesByCurrency(
    selectedEntries,
    person?.currency ?? selectedCurrency,
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
      `${getAccountIdSync() ?? "local"}:${getActiveVaultIdSyncMaybe() ?? "none"}:${id}:${getCurrentCurrencyCode()}` ===
        flowScope,
    [flowScope, id],
  );
  const loadMoreCustomerNoteHistory = useCallback(
    async (cursor: string) => {
      const vault = getActiveVaultIdSyncMaybe();
      if (!vault || !screenIsCurrent()) return null;
      const selfIds = await resolveAccountIdCandidates(getAccountIdSync());
      if (!screenIsCurrent()) return null;
      return applyEventMutex.runExclusive(async () => {
        if (!screenIsCurrent()) return null;
        const page = await getPersonNoteHistory(vault, id, selfIds, cursor);
        return screenIsCurrent() ? page : null;
      });
    },
    [id, screenIsCurrent],
  );
  const tallyPopupEnabled =
    loaded &&
    person?.id === id &&
    flowHistory?.scope === flowScope &&
    !selectionBusy &&
    !sheetFor &&
    !confirmDeleteFor &&
    !dateSheetVisible &&
    !askLangVisible &&
    !exportSheetVisible &&
    !inviteVisible &&
    !linkedSheetVisible &&
    !linkCurrencyVisible &&
    !confirmRegenerate &&
    !confirmUnlink &&
    !confirmSettle &&
    !confirmSelectionDelete;
  const tallyDirectionEnabled = tallyPopupEnabled && !selecting && !tallyFiltersVisible;
  const tallyInteraction = useRef({
    filter: tallyFilter,
    hasFilters: tallyFiltersApplied,
    codes: tallyCurrencyCodes,
    enabled: tallyPopupEnabled,
    directionEnabled: tallyDirectionEnabled,
  });
  tallyInteraction.current = {
    filter: tallyFilter,
    hasFilters: tallyFiltersApplied,
    codes: tallyCurrencyCodes,
    enabled: tallyPopupEnabled,
    directionEnabled: tallyDirectionEnabled,
  };
  const filterIsCurrent = () => screenIsCurrent() && filterOwnership.current.epoch === filterEpoch;
  const changeTallyFilter = (next: TallyListFilter) => {
    if (!filterIsCurrent() || !tallyInteraction.current.enabled || selectionBusyRef.current) return;
    setTallyView({
      scope: flowScope,
      filter: normalizeTallyListFilter(next, tallyInteraction.current.codes),
    });
  };
  const clearTallyFilters = () => {
    if (!filterIsCurrent() || !tallyInteraction.current.enabled || selectionBusyRef.current) return;
    if (!tallyInteraction.current.hasFilters) return;
    setTallyView({ scope: flowScope, filter: DEFAULT_TALLY_LIST_FILTER });
    setDateRange(null);
  };
  const changeTallyCardDirection = (
    direction: Exclude<TallyDirectionFilter, "all">,
    currency: string,
    onInteract: () => void,
  ) => {
    const current = tallyInteraction.current;
    if (!filterIsCurrent() || !current.directionEnabled) return;
    onInteract();
    changeTallyFilter(toggleTallyCardFilter(current.filter, direction, currency, current.codes));
    dismissSearchKeyboard();
  };
  const changeTallySwipeDirection = (side: "all" | "collect" | "pay") => {
    const current = tallyInteraction.current;
    if (!filterIsCurrent() || !current.directionEnabled || compactDock) return;
    changeTallyFilter(
      side === "all"
        ? { ...current.filter, direction: "all", currencies: [] }
        : swipeTallyDirection(
            current.filter,
            side === "collect" ? "received" : "gave",
            current.codes,
          ),
    );
  };
  const updateTallyFilterAnchor = useCallback(() => {
    const surface = filterSurfaceRef.current;
    const trigger = tallyFilterTrigger.current;
    if (
      !tallyFiltersVisibleRef.current ||
      !screenIsCurrent() ||
      !surface?.measureInWindow ||
      !trigger?.measureInWindow
    )
      return;
    const request = ++filterMeasureVersion.current;
    surface.measureInWindow((sx, sy, width, height) => {
      trigger.measureInWindow((x, y, triggerWidth, triggerHeight) => {
        if (
          request !== filterMeasureVersion.current ||
          !tallyFiltersVisibleRef.current ||
          !screenIsCurrent() ||
          filterOwnership.current.epoch !== filterEpoch
        )
          return;
        if (
          ![sx, sy, width, height, x, y, triggerWidth, triggerHeight].every(Number.isFinite) ||
          width <= 0 ||
          height <= 0 ||
          triggerWidth <= 0 ||
          triggerHeight <= 0
        )
          return;
        setFilterSurface({ width, height });
        setTallyFilterAnchor({ x: x - sx, y: y - sy, width: triggerWidth, height: triggerHeight });
      });
    });
  }, [flowScope, filterEpoch, screenIsCurrent]);
  useEffect(() => {
    if (!tallyFiltersVisible) return;
    const frame = requestAnimationFrame(updateTallyFilterAnchor);
    return () => cancelAnimationFrame(frame);
  }, [
    tallyFiltersVisible,
    updateTallyFilterAnchor,
    compactDock,
    filterSurface.width,
    filterSurface.height,
    insets.top,
  ]);
  useEffect(() => {
    if (!tallyPopupEnabled) {
      tallyFiltersVisibleRef.current = false;
      setTallyFiltersVisible(false);
      setTallyFilterAnchor(null);
      filterMeasureVersion.current++;
    }
  }, [tallyPopupEnabled]);
  useRouteFocusEffect(
    useCallback(
      () => () => {
        filterOwnership.current.epoch++;
        tallyFiltersVisibleRef.current = false;
        filterMeasureVersion.current++;
        setTallyFiltersVisible(false);
        setTallyFilterAnchor(null);
      },
      [],
    ),
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
      setTallyFiltersVisible(false);
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
  const settleablePeriods = canAmend ? currencyPeriods.filter(canSettlePeriod) : [];
  const canSettle = settleablePeriods.length > 0;
  const settlementTarget = currencyPeriods.find(
    (period) => period.currency === (settleCurrency ?? person?.currency ?? selectedCurrency),
  );

  async function onSettle() {
    setConfirmSettle(false);
    if (
      !person ||
      settlingRef.current ||
      !screenIsCurrent() ||
      !canAmend ||
      !settlementTarget ||
      !canSettlePeriod(settlementTarget)
    )
      return;
    const target = settlementTarget;
    settlingRef.current = true;
    try {
      // Both paths recheck the balance under their authoritative transaction.
      // Shared boundaries use sequence; private boundaries use recording time.
      if (target.financialTab) {
        if (target.financialTab.closed_at != null) throw new TabClosedError();
        const throughSeq = Math.max(
          0,
          ...target.entries
            .filter((entry) => entry.tab?.tab_id === target.financialTab!.tab_id)
            .map((e) => e.tab?.seq ?? 0),
        );
        if (
          !settlementRequest.current ||
          settlementRequest.current.throughSeq !== throughSeq ||
          settlementRequest.current.tabId !== target.financialTab.tab_id
        ) {
          settlementRequest.current = {
            id: Crypto.randomUUID(),
            throughSeq,
            tabId: target.financialTab.tab_id,
          };
        }
        await settleSharedTab(target.financialTab, settlementRequest.current.id);
        settlementRequest.current = null;
      } else {
        const chapter = currencyChapter(target);
        const settledAtMs = Math.max(Date.now(), ...chapter.map((e) => entryRecordedAt(e) + 1));
        await appendEntrySettled({
          relationshipId: chapter[0].relationship_id,
          currency: target.currency,
          settledAtMs,
        });
      }
      if (!screenIsCurrent()) return;
      setHistoryDisclosure({ key: layoutKey, expanded: false });
      toast.push(
        currencyPeriods.length > 1
          ? `${t("person.settle.done")} · ${getCurrencyLabel(target.currency)}`
          : t("person.settle.done"),
        "success",
      );
      await load();
    } catch (err) {
      if (err instanceof TabApiError || err instanceof TabInputError) {
        const code = err.code;
        toast.push(
          t(
            code === "credit_confirmation_pending"
              ? "tab.settle.pending"
              : code === "settlement_not_zero"
                ? "person.settle.notZero"
                : code === "settlement_pending"
                  ? "tab.settle.pending"
                  : code === "stale_settlement" || code === "settlement_empty"
                    ? "tab.settle.changed"
                    : "tab.settle.failed",
          ),
          "error",
        );
        if (target.financialTab) requestTabSync(target.financialTab.tab_id);
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
    if (!person || !screenIsCurrent() || pingBusyRef.current || (lang == null && askLangVisible))
      return;
    if (currencyPeriods.length === 0) return;
    const vault = getActiveVaultIdSyncMaybe();
    if (!vault) return;
    const account = getAccountIdSync();
    const recipient = { id: person.id, name: person.name, phone: person.phone };
    const sender = self;
    const periods = currencyPeriods;
    pingBusyRef.current = true;
    const controller = new AbortController();
    pingAbortRef.current = controller;
    const current = () => {
      const valid =
        pingAbortRef.current === controller &&
        !controller.signal.aborted &&
        getActiveVaultIdSyncMaybe() === vault &&
        getAccountIdSync() === account &&
        screenIsCurrent();
      if (!valid) controller.abort();
      return valid;
    };
    setPingStage("preparing");
    try {
      // Read this Kaata's current preference for each send, including a send
      // resumed after the message-language picker closes.
      const includeBillLink = await getBillLinksEnabled(vault);
      if (!current()) return;
      if (
        periods.some(
          (period) =>
            period.person.tab_unsynced === 1 ||
            (includeBillLink &&
              period.priorPeriods.some((prior) => prior.link.last_synced_at == null)),
        )
      ) {
        toast.push(t("tab.notDownloaded"), "info");
        return;
      }
      if (lang == null) {
        const pref = await getShareLangPref();
        if (!current()) return;
        if (pref === "ask") {
          pingLanguageChosen.current = false;
          setAskLangVisible(true);
          return;
        }
        lang = resolveShareLang(pref);
      }
      // A plain balance reminder never builds a bill or traverses earlier
      // books. Both modes use the same coherent, unfiltered current balances.
      const statements = includeBillLink
        ? periods.map((period) => ({
            currency: period.currency,
            balance: period.person.balance,
            entries: period.entries,
            history: [
              {
                kind: "pre_link" as const,
                entries: period.before,
                settledBoundaries: period.boundaries,
              },
              ...period.priorPeriods.map((prior) => ({
                kind: "closed_shared" as const,
                entries: prior.entries,
                settlements: prior.settlements,
              })),
            ],
            // A shared opening already carries the earlier private balance.
            settled: period.financialTab
              ? { settledChapters: 0, settledBoundaryMs: null, settledBoundaries: [] }
              : {
                  settledChapters: period.settlement.count,
                  settledBoundaryMs: period.settlement.lastSettledAtMs,
                  settledBoundaries: period.boundaries,
                },
          }))
        : periods.map((period) => ({
            currency: period.currency,
            balance: period.person.balance,
            entries: [],
          }));
      const ok = await shareKaataCurrenciesViaWhatsApp(
        recipient,
        sender,
        statements,
        lang,
        (stage) => {
          if (current()) setPingStage(stage);
        },
        controller.signal,
        { includeBillLink },
      );
      if (!ok && current()) toast.push(t("share.whatsappUnavailable"), "error");
    } catch (err) {
      if (current()) {
        console.warn("[person] WhatsApp reminder failed", err);
        toast.push(t("share.whatsappUnavailable"), "error");
      }
    } finally {
      if (pingAbortRef.current === controller) {
        pingAbortRef.current = null;
        pingBusyRef.current = false;
        if (loadMounted.current) setPingStage(null);
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
  const latestLinks = useRef<{ scope: string; links: TabLink[] }>({ scope: "", links: [] });

  // Returns the contact's latest tab link — open OR closed — so the focus
  // effect and the pull listener can ask for a sync and mark the tab's
  // notices seen without waiting on state; every other caller ignores it.
  const load = useCallback(async (): Promise<TabLink | null> => {
    const generation = ++loadGeneration.current;
    const account = getAccountIdSync(),
      vault = getActiveVaultIdSyncMaybe();
    const currency = getCurrentCurrencyCode();
    const scope = `${account ?? "local"}:${vault ?? "none"}:${id}:${currency}`;
    const current = () =>
      loadMounted.current &&
      generation === loadGeneration.current &&
      getCurrentCurrencyCode() === currency &&
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
      const {
        p,
        list,
        s,
        settle,
        bounds,
        tl,
        before,
        refused,
        sharedMarkers,
        priorPeriods,
        periods,
        writableCurrencies,
        note,
      } = await applyEventMutex.runExclusive(async () => {
        const [allPerson, list, s, enabledCurrencies, openLinks, note] = await Promise.all([
          getPerson(id, currency, { allCurrencies: true }),
          listEntries(id, currency, { allCurrencies: true }),
          getLocalSelf(),
          vault ? getPersonEnabledCurrencies(vault, id) : Promise.resolve([]),
          listOpenTabLinksForPerson(id),
          vault
            ? resolveAccountIdCandidates(account).then((selfIds) =>
                getPersonNoteDetails(vault, id, selfIds),
              )
            : Promise.resolve(null),
        ]);
        const rows = allPerson ? personCurrencyRows(allPerson) : [];
        const details = await Promise.all(
          rows.map(async (row) => {
            const code = row.currency ?? currency;
            const [settlement, boundaries, tab, financialTab] = await Promise.all([
              getSettlementSummary(id, code),
              listSettlementBoundaries(id, code),
              getLatestTabLinkForPerson(id, code),
              getFinancialTabLinkForPerson(id, code),
            ]);
            const ledgerTab = financialTab === undefined ? tab : financialTab;
            const [before, refused, sharedSettlements, priorPeriods] = tab
              ? await Promise.all([
                  listPreLinkEntries(tab),
                  listFailedTabEntries(tab.relationship_id, {
                    excludeCreditRefused: true,
                    currency: code,
                  }),
                  ledgerTab ? listTabSettlements(ledgerTab.tab_id) : Promise.resolve([]),
                  listArchivedSharedPeriodsForExport(id, code),
                ])
              : [[], [], [], []];
            return {
              currency: code,
              person: row,
              entries: list.filter((entry) => (entry.currency ?? currency) === code),
              settlement,
              boundaries,
              tab,
              financialTab: ledgerTab,
              before,
              refused,
              sharedSettlements,
              priorPeriods: await Promise.all(
                priorPeriods.map(async (prior) => ({
                  ...prior,
                  settlements: await listTabSettlements(prior.link.tab_id),
                })),
              ),
            };
          }),
        );
        const primary = details.find((detail) => detail.currency === currency) ?? details[0];
        const p = primary ? { ...primary.person, currency_balances: [...rows] } : allPerson;
        return {
          p,
          list,
          s,
          settle: primary?.settlement ?? { count: 0, lastSettledAtMs: null },
          bounds: primary?.boundaries ?? [],
          tl: primary?.tab ?? null,
          before: details.flatMap((detail) => detail.before),
          refused: details.flatMap((detail) => detail.refused),
          sharedMarkers: primary?.sharedSettlements ?? [],
          priorPeriods: details.flatMap((detail) => detail.priorPeriods),
          periods: details,
          writableCurrencies: enabledCurrencies.filter((code) => {
            const tab =
              details.find((period) => period.currency === code)?.tab ??
              openLinks.find((candidate) => candidate.group_id && candidate.closed_at == null);
            return canWriteSharedTallies(tab?.closed_at == null ? tab : null);
          }),
          note,
        };
      });
      if (!current()) return null;
      // Earlier closed tabs remain known handovers, even after a new opening
      // carries their net balance. Keep them out of current money and rows.
      setFlowHistory({
        scope,
        entries: [...list, ...before, ...priorPeriods.flatMap((period) => period.entries)],
      });
      setPerson(p);
      setCustomerNote({ scope, value: note });
      setCurrencyPeriods(periods);
      setEntryCurrencies({ scope, codes: writableCurrencies });
      setEntries(list);
      // Reveal a newly saved tally even if the previous filter would hide it.
      if (takeSavedEntry(id)) {
        if (searchingRef.current) {
          setSearchQuery("");
          setDateRange(null);
          setTallyView({ scope, filter: DEFAULT_TALLY_LIST_FILTER });
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
                    `${formatAmount(first.entry.amount_afn)} ${getCurrencyLabel(first.entry.currency ?? currency)}`,
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
      latestLinks.current = {
        scope,
        links: [
          ...new Map(
            periods.flatMap((period) =>
              [period.tab, period.financialTab].flatMap((tab) =>
                tab ? [[tab.tab_id, tab] as const] : [],
              ),
            ),
          ).values(),
        ],
      };
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
  }, [id, selectedCurrency]);

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
    const appState = AppState.currentState;
    if (appState && latestLinks.current.scope === screenScope.current)
      for (const tab of latestLinks.current.links)
        markTabNoticesSeen(tab, { focused: focused.current, appState });
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
      let stopWatch: (() => void)[] = [];
      void load().then((tl) => {
        if (!tl && latestLinks.current.links.length === 0) return;
        if (latestLinks.current.scope !== screenScope.current) return;
        // A closed period may still receive final decisions on pending rows.
        for (const tab of latestLinks.current.links) {
          requestTabSync(tab.tab_id);
          if (active) stopWatch.push(watchTab(tab.tab_id));
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
        stopWatch.forEach((stop) => stop());
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
  const linkRelationshipId = [
    ...new Set(
      currencyPeriods.flatMap((period) =>
        [period.tab, period.financialTab].flatMap((tab) => (tab ? [tab.relationship_id] : [])),
      ),
    ),
  ].join("|");
  useEffect(() => {
    if (!linkRelationshipId) return;
    return onTabApplied((ev) => {
      if (!linkRelationshipId.split("|").includes(ev.relationshipId)) return;
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
    if (!managementLink || !screenIsCurrent()) return;
    try {
      await regenerateInviteLink(managementLink);
      if (!screenIsCurrent()) return;
      await load();
      setTimeout(() => {
        if (screenIsCurrent()) setInviteVisible(true);
      }, 220);
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
    if (!managementLink || !screenIsCurrent()) return;
    try {
      await unlinkContact(managementLink);
      if (!screenIsCurrent()) return;
      toast.push(t("tab.unlinked"), "success");
      await load();
    } catch (err) {
      console.warn("[person] unlinkContact failed", err);
      toast.push(tabErrorMessage(err), "error");
    }
  }

  // Only pending tallies can be reviewed; the first decision is final.
  async function reviewLinkFor(entry: Entry): Promise<TabLink | null> {
    if (!entry.tab || !screenIsCurrent()) return null;
    const period = currencyPeriods.find(
      (period) => period.currency === (entry.currency ?? person?.currency ?? selectedCurrency),
    );
    const target = entry.tab.tab_id
      ? await getTabLink(entry.tab.tab_id)
      : (period?.financialTab ?? null);
    if (!screenIsCurrent()) return null;
    if (
      !target ||
      target.vault_id !== activeVaultId ||
      target.relationship_id !== entry.relationship_id ||
      target.currency !== (entry.currency ?? person?.currency ?? selectedCurrency)
    )
      throw new TabPermissionError();
    return target;
  }

  async function onAccept(entry: Entry) {
    try {
      const target = await reviewLinkFor(entry);
      if (!target) return;
      await acceptEntry(target, entry.id);
      if (!screenIsCurrent()) return;
      // This queues an optimistic review. The live comparison announces it
      // only once the server confirms the decision.
      await load();
    } catch (err) {
      console.warn("[person] acceptEntry failed", err);
      toast.push(tabErrorMessage(err), "error");
    }
  }

  async function onReject(entry: Entry) {
    try {
      const target = await reviewLinkFor(entry);
      if (!target) return;
      await disputeEntry(target, entry.id, "");
      if (!screenIsCurrent()) return;
      await load();
    } catch (err) {
      toast.push(tabErrorMessage(err), "error");
    }
  }

  // Inline withdrawal of a pending tally; reviewed rows are immutable.
  async function onVoid(target: Entry) {
    if (
      target.tab?.by !== "me" ||
      (target.tab.status !== "pending" &&
        !(target.tab.status === "recorded" && target.tab.kind === "entry")) ||
      target.tab.voided
    )
      return;
    try {
      const reviewLink = await reviewLinkFor(target);
      if (!reviewLink) return;
      if (
        target.tab.status === "recorded" &&
        (await listTabSettlements(reviewLink.tab_id)).some(
          (s) => s.through_seq >= (target.tab?.seq ?? 0),
        )
      )
        return;
      if (!screenIsCurrent()) return;
      await voidEntry(reviewLink, target.id);
      if (!screenIsCurrent()) return;
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

  const changingCurrency = flowHistory != null && flowHistory.scope !== flowScope;
  if (!person || changingCurrency) {
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
          {loaded && !changingCurrency ? (
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
  tallyRowActions.current.actions = {
    open: (entry) => {
      if (searchIsCurrent() && canAmend) setSheetFor(entry);
    },
    select: toggleSelection,
    accept: guardedSearchAction(onAccept),
    reject: guardedSearchAction(onReject),
    cancel: guardedSearchAction(onVoid),
  };
  const renderTallyHistory = () => (
    <View
      testID="customer-current-tallies"
      style={[styles.entriesCard, historyItems.length === 0 && { display: "none" }]}
      pointerEvents={historyItems.length === 0 ? "none" : "auto"}
      accessibilityElementsHidden={historyItems.length === 0}
      importantForAccessibility={historyItems.length === 0 ? "no-hide-descendants" : "auto"}
      onLayout={(event) => {
        if (
          tallyRowActions.current.lease !== tallyRowsLease ||
          tallyRowActions.current.visible.size === 0 ||
          !filterIsCurrent() ||
          layoutScope.current !== flowScope
        )
          return;
        entriesCardY.current.set(`${flowScope}:current`, event.nativeEvent.layout.y);
        revealNotificationTally();
      }}
    >
      {renderedHistory.map(({ item, index, hidden }) => {
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
                {item.currency ? ` · ${getCurrencyLabel(item.currency)}` : ""}
              </Text>
              <View style={styles.settleRule} />
            </View>
          );
        }
        const entry = item.entry;
        // Settled history is READ-ONLY (review fix): editing or
        // deleting a ruled-off entry would un-zero a closed chapter.
        // Remote edits can still arrive, but this device won't offer
        // changes that would un-zero a completed chapter.
        const period = currencyPeriods.find(
          (period) => period.currency === (entry.currency ?? person.currency ?? selectedCurrency),
        );
        const boundary = period?.settlement.lastSettledAtMs;
        const inSettledChapter =
          !entry.tab && boundary != null && entryRecordedAt(entry) <= boundary;
        const tabSettlements =
          entry.tab?.tab_id === period?.financialTab?.tab_id
            ? (period?.sharedSettlements ?? [])
            : (period?.priorPeriods.find((prior) => prior.link.tab_id === entry.tab?.tab_id)
                ?.settlements ?? []);
        const recordedInSettledChapter =
          entry.tab?.status === "recorded" &&
          tabSettlements.some((s) => s.through_seq >= (entry.tab?.seq ?? 0));
        const entryLink = entry.tab
          ? [
              period?.tab,
              period?.financialTab,
              ...(period?.priorPeriods.map((p) => p.link) ?? []),
            ].find((link) => link?.tab_id === entry.tab?.tab_id)
          : null;
        const canWriteEntry = entryLink
          ? canWriteSharedTallies(entryLink)
          : entry.tab?.recording_mode !== "notify_one_way";
        const canOpenSheet =
          canAmend &&
          !inSettledChapter &&
          !entry.tab &&
          (!period?.tab || period.tab.closed_at != null) &&
          period?.person.tab_close_pending !== 1;
        if (!hidden) {
          const allowed = new Set<TallyRowAction>();
          if (canOpenSheet) {
            if (!selecting) allowed.add("open");
            allowed.add("select");
          }
          if (canAmend && entry.tab && canWriteEntry) {
            allowed.add("accept");
            allowed.add("reject");
            if (!recordedInSettledChapter) allowed.add("cancel");
          }
          tallyRowActions.current.allowed.set(entry.id, allowed);
        }
        return (
          <View
            key={entry.id}
            testID={`customer-tally-row-${entry.id}`}
            style={hidden ? { display: "none" } : undefined}
            pointerEvents={hidden ? "none" : "auto"}
            accessibilityElementsHidden={hidden}
            importantForAccessibility={hidden ? "no-hide-descendants" : "auto"}
            onLayout={(event) => {
              if (
                hidden ||
                tallyRowActions.current.lease !== tallyRowsLease ||
                !tallyRowActions.current.visible.has(entry.id) ||
                !filterIsCurrent() ||
                layoutScope.current !== flowScope
              )
                return;
              const { y, height } = event.nativeEvent.layout;
              entryPositions.current.set(entry.id, { y, height, card: `${flowScope}:current` });
              revealNotificationTally();
            }}
          >
            {index > 0 && historyItems[index - 1].kind !== "marker" ? (
              <View style={styles.divider} />
            ) : null}
            {/* Tap-and-hold opens the existing tally actions. A tap toggles
                the checkbox once selection is active. */}
            <EntryRow
              entry={entry}
              onLongPress={
                !hidden && canOpenSheet
                  ? reuseTallyRows
                    ? openTallyRow
                    : (selectedEntry) => {
                        if (searchIsCurrent()) setSheetFor(selectedEntry);
                      }
                  : undefined
              }
              selecting={hidden || (selecting && canOpenSheet)}
              selected={!hidden && selecting && selectedEntryIds.has(entry.id)}
              selectionDisabled={selectionBusy || hidden}
              onToggleSelection={
                !hidden && canOpenSheet
                  ? reuseTallyRows
                    ? selectTallyRow
                    : toggleSelection
                  : undefined
              }
              attribution={attribution.get(entry.id)}
              tab={entry.tab}
              selfAccountId={getAccountIdSync()}
              onAccept={
                !hidden && canAmend && entry.tab && canWriteEntry
                  ? reuseTallyRows
                    ? acceptTallyRow
                    : guardedSearchAction(onAccept)
                  : undefined
              }
              onReject={
                !hidden && canAmend && entry.tab && canWriteEntry
                  ? reuseTallyRows
                    ? rejectTallyRow
                    : guardedSearchAction(onReject)
                  : undefined
              }
              onCancel={
                !hidden && canAmend && entry.tab && canWriteEntry && !recordedInSettledChapter
                  ? reuseTallyRows
                    ? cancelTallyRow
                    : guardedSearchAction(onVoid)
                  : undefined
              }
              showFullNote={searchTerms.length > 0}
            />
            {!hidden && highlight?.id === entry.id ? (
              <TallyHighlight requestKey={highlight.key} />
            ) : !hidden && reviewHighlights.has(entry.id) ? (
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
      financialSummaries={selectionSummaries}
      financialSummary={selectionSummaries.length === 1 ? selectionSummaries[0].summary : undefined}
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
  const balanceRows = personCurrencyRows(person);
  const singleBalanceCurrency = balanceRows.length === 1;
  const hasCustomerPhone = !!person.phone?.trim();
  const showHeaderWhatsApp = entries.length > 0 && hasCustomerPhone;
  const whatsAppLabel = t(
    pingStage === "preparing"
      ? "person.ping.preparing"
      : pingStage === "opening"
        ? "person.ping.opening"
        : "person.ping.button",
  );
  const openWhatsAppReminder = () => {
    if (selectionBusyRef.current || selectionContext.current.selecting) return;
    void sendPing();
  };
  // Equal side slots keep the name centered even when WhatsApp adds a second
  // action. Selection keeps only Back, with an equally sized empty end slot.
  const headerSideWidth = selecting ? 40 : showHeaderWhatsApp ? TOUCH_MIN * 2 + 10 : TOUCH_MIN;
  return (
    <SafeAreaView
      ref={filterSurfaceRef}
      style={styles.container}
      edges={["top"]}
      onLayout={(event) => {
        if (!filterIsCurrent()) return;
        const { width, height } = event.nativeEvent.layout;
        if (![width, height].every(Number.isFinite) || width <= 0 || height <= 0) return;
        setFilterSurface((before) =>
          before.width === width && before.height === height ? before : { width, height },
        );
        updateTallyFilterAnchor();
      }}
    >
      <BlurTargetView
        ref={filterBlurTarget}
        style={{ flex: 1 }}
        accessibilityElementsHidden={tallyFiltersVisible}
        importantForAccessibility={tallyFiltersVisible ? "no-hide-descendants" : "auto"}
      >
        <View testID="customer-header" style={[styles.headerNav, rowDir(isRTL)]}>
          <View
            testID="customer-header-back"
            style={[styles.headerSide, rowDir(isRTL), { width: headerSideWidth }]}
          >
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
          </View>
          <View testID="customer-header-identity" style={styles.headerIdentity}>
            <View style={[styles.headerTitleRow, rowDir(isRTL)]}>
              <Text
                testID="customer-header-name"
                accessibilityRole="header"
                style={styles.headerName}
                numberOfLines={1}
                ellipsizeMode="tail"
              >
                {person.name}
              </Text>
              {sharedAccountStatus === "joined" ? (
                <SharedAccountBadge
                  size={16}
                  name={person.name}
                  fontSize={typography.title.fontSize}
                />
              ) : null}
            </View>
          </View>
          <View
            testID="customer-header-actions"
            style={[
              styles.headerSide,
              styles.headerActions,
              rowDir(isRTL),
              { width: headerSideWidth },
            ]}
          >
            {!selecting && showHeaderWhatsApp ? (
              <Pressable
                testID="whatsapp-reminder"
                onPress={openWhatsAppReminder}
                disabled={pinging}
                accessibilityRole="button"
                accessibilityLabel={whatsAppLabel}
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
            {!selecting ? (
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
                            router.push({
                              pathname: "/person/[id]/edit",
                              params: { id: person.id },
                            }),
                        },
                        {
                          label:
                            openGroupLink || legacyLinkedPeriods.length > 0
                              ? t("tab.join.title")
                              : t("tab.link.title"),
                          icon: "link-outline" as const,
                          onPress: () => {
                            if (!screenIsCurrent() || !canAmend || selectionBusyRef.current) return;
                            if (openGroupLink) {
                              setManagementCurrency(openGroupLink.currency);
                              setLinkedSheetVisible(true);
                            } else if (legacyLinkedPeriods.length > 1) {
                              linkCurrencyBusy.current = false;
                              setLinkCurrencyVisible(true);
                            } else if (legacyLinkedPeriods.length === 1) {
                              setManagementCurrency(legacyLinkedPeriods[0].currency);
                              setLinkedSheetVisible(true);
                            } else {
                              setManagementCurrency(null);
                              setInviteVisible(true);
                            }
                          },
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
                    label: t("notificationSettings.contact.title"),
                    icon: "notifications-outline",
                    onPress: () => {
                      if (!screenIsCurrent()) return;
                      dismissSearchKeyboard();
                      router.push({
                        pathname: "/notification-settings",
                        params: { personId: person.id, vaultId: activeVaultId ?? "" },
                      });
                    },
                  },
                  {
                    label: t("reminders.title"),
                    icon: "alarm-outline",
                    onPress: () => {
                      if (
                        !screenIsCurrent() ||
                        selectionBusyRef.current ||
                        selectionContext.current.selecting
                      )
                        return;
                      dismissSearchKeyboard();
                      router.push({
                        pathname: "/person/[id]/reminders",
                        params: { id: person.id, vaultId: activeVaultId ?? "" },
                      });
                    },
                  },
                  ...(!hasCustomerPhone && entries.length > 0
                    ? [
                        {
                          label: whatsAppLabel,
                          icon: "logo-whatsapp" as const,
                          disabled: pinging || askLangVisible,
                          onPress: openWhatsAppReminder,
                        },
                      ]
                    : []),
                  {
                    label: t("personEdit.export"),
                    icon: "document-text-outline",
                    disabled: exporting,
                    onPress: () => setExportSheetVisible(true),
                  },
                ]}
              />
            ) : null}
          </View>
        </View>
        {/* One person's tallies are bounded, so render them as ONE bordered card
          (ScrollView + map), exactly like the home people list. The old
          FlatList + per-row cardRowFirst/cardRowLast emulation caused the
          blank-row bug: adding a 2nd entry shifted the old row from index 0 to
          1, flipping its style, and Android painted it blank until a remount
          ("the old one shows blank text after the second one is added, fixed
          by going back and returning"). A single uniform card has no per-row
          style flip, so it can't happen. */}
        <SearchKeyboardFrame style={{ flex: 1 }} avoidAndroidKeyboard>
          {/* The shared frame also handles Android hosts that overlay the IME
            instead of resizing the viewport. */}
          <View style={{ flex: 1 }}>
            {selecting ? (
              <View
                testID="customer-selection-controls"
                style={styles.selectionTop}
                pointerEvents="box-none"
                onLayout={(event) => {
                  if (
                    !screenIsCurrent() ||
                    !selectionContext.current.selecting ||
                    selectionContext.current.scope !== flowScope ||
                    confirmationVersion !== selectionConfirmationVersion.current
                  )
                    return;
                  const { height } = event.nativeEvent.layout;
                  if (!Number.isFinite(height) || height <= 0) return;
                  const previous = selectionMeasurementRef.current;
                  if (previous.scope === flowScope && previous.height === height) return;
                  const measured = { scope: flowScope, height };
                  selectionMeasurementRef.current = measured;
                  setSelectionMeasurement(measured);
                }}
              >
                {selectionToolbar}
              </View>
            ) : null}
            <GestureDetector gesture={nativeTallyScroll}>
              <ScrollView
                directionalLockEnabled
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
                  flexGrow: 1,
                  paddingTop: selecting
                    ? (selectionMeasurement.scope === flowScope ? selectionMeasurement.height : 0) +
                      12
                    : 0,
                }}
              >
                <View>
                  <View style={styles.info}>
                    {visibleCustomerNote &&
                    (visibleCustomerNote.note !== null || visibleCustomerNote.history.length > 0) &&
                    !selecting ? (
                      <CustomerNoteCard
                        key={customerNoteKey}
                        scopeKey={flowScope}
                        details={visibleCustomerNote}
                        isCurrent={screenIsCurrent}
                        loadMoreHistory={loadMoreCustomerNoteHistory}
                        onEdit={
                          canAmend
                            ? () => {
                                if (screenIsCurrent())
                                  router.push({ pathname: "/person/[id]/edit", params: { id } });
                              }
                            : undefined
                        }
                      />
                    ) : null}
                    {sharedAccountStatus === "waiting" || personGroupNames.length > 0 ? (
                      <View testID="customer-metadata" style={[styles.metadataRow, rowDir(isRTL)]}>
                        {sharedAccountStatus === "waiting" ? (
                          <Text
                            testID="customer-link-waiting"
                            style={[styles.linkWaiting, textDir(isRTL)]}
                            numberOfLines={1}
                          >
                            {t("tab.chip.waiting")}
                          </Text>
                        ) : null}
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
                    ) : null}
                    {entryCurrencies.scope === flowScope &&
                    entryCurrencies.codes.length === 0 &&
                    currencyPeriods.some(
                      (period) =>
                        period.tab?.closed_at == null &&
                        period.tab?.recording_mode === "notify_one_way" &&
                        period.tab.role === "b",
                    ) ? (
                      <Text
                        testID="customer-one-way-read-only"
                        style={[styles.groups, textDir(isRTL)]}
                      >
                        {t("tab.recordingMode.oneWayReadOnly")}
                      </Text>
                    ) : null}
                    {/* Unlinking preserves shared history and pending reviews; tallies written
                    after it are private and carry no review state, which made
                    them look like accepted shared ones (audit #6). */}
                    {tabHistory?.closed_at != null || person.tab_close_pending === 1 ? (
                      <Text style={[styles.groups, textDir(isRTL)]}>
                        {person.tab_close_pending === 1
                          ? t("tab.unlink.pending")
                          : t("tab.closedNote", { date: formatDate(tabHistory!.closed_at!) })}
                      </Text>
                    ) : null}
                    <View
                      testID="customer-balances"
                      accessible={false}
                      style={selecting ? styles.hiddenBalances : undefined}
                      pointerEvents={selecting ? "none" : "auto"}
                      accessibilityElementsHidden={selecting}
                      importantForAccessibility={selecting ? "no-hide-descendants" : "auto"}
                    >
                      <View style={{ height: 16 }} />
                      <CustomerBalanceCarousel
                        key={JSON.stringify([getAccountIdSync(), activeVaultId, person.id])}
                        currencies={balanceRows.map((row) => row.currency ?? selectedCurrency)}
                        active={
                          !compactDock &&
                          !selecting &&
                          !tallyFiltersVisible &&
                          !dateSheetVisible &&
                          !sheetFor &&
                          !askLangVisible &&
                          !exportSheetVisible &&
                          !inviteVisible &&
                          !linkedSheetVisible &&
                          !linkCurrencyVisible &&
                          !confirmRegenerate &&
                          !confirmUnlink &&
                          !confirmSettle &&
                          !confirmDeleteFor
                        }
                      >
                        {(onInteract) =>
                          balanceRows.map((balancePerson) => {
                            const code = balancePerson.currency ?? selectedCurrency;
                            const person = balancePerson;
                            const period = currencyPeriods.find(
                              (period) => period.currency === code,
                            );
                            const tabHistory = period?.tab;
                            const financialTabHistory = period?.financialTab;
                            const link = tabHistory?.closed_at == null ? tabHistory : null;
                            const abs = Math.abs(person.balance);
                            const chipLabel =
                              person.balance > 0
                                ? t("person.balance.theyOwe")
                                : person.balance < 0
                                  ? t("person.balance.youOwe")
                                  : null;
                            const chipVariant =
                              person.balance > 0
                                ? ("collect" as const)
                                : person.balance < 0
                                  ? ("pay" as const)
                                  : null;
                            const balanceColor =
                              person.balance > 0
                                ? colors.collectStrong
                                : person.balance < 0
                                  ? colors.payStrong
                                  : colors.textEmphasis;
                            const settledCount = period
                              ? period.financialTab
                                ? period.sharedSettlements.length
                                : period.settlement.count
                              : 0;
                            const chapterCoherent =
                              !period ||
                              sumAmounts(currencyChapter(period).map(balanceContribution)) ===
                                person.balance;
                            const sharedReviewPending =
                              (person.tab_pending_count ?? 0) > 0 ||
                              (period?.entries ?? []).some(
                                (entry) =>
                                  entry.tab &&
                                  (entry.tab.local_pending ||
                                    (!entry.tab.voided &&
                                      entry.tab.kind !== "void" &&
                                      entry.tab.status === "pending")),
                              );
                            const unsettledOriginalCount = period
                              ? currencyChapter(period).length
                              : 0;
                            const hasBalanceStatus =
                              (person.tab_unsynced !== 1 &&
                                (chipLabel ||
                                  (settledCount > 0 &&
                                    chapterCoherent &&
                                    !sharedReviewPending &&
                                    unsettledOriginalCount === 0) ||
                                  displayedEntries.length > 0)) ||
                              sharedAccountLinkStatus(link) === "waiting";
                            return (
                              <View key={code} style={styles.balanceOverview}>
                                <BalanceCardGlass />
                                <View style={styles.balanceSide}>
                                  <View style={styles.balanceHeadline}>
                                    <View
                                      testID={`customer-balance-amount-${code}`}
                                      style={styles.balanceAmountRow}
                                      accessible
                                      accessibilityLabel={`${getCurrencyLabel(code)} ${person.tab_unsynced === 1 ? t("tab.notDownloaded") : formatAmount(abs)}`}
                                    >
                                      <Text
                                        testID={`customer-balance-value-${code}`}
                                        style={[
                                          styles.balance,
                                          styles.balanceWithCurrency,
                                          {
                                            color:
                                              person.tab_unsynced === 1
                                                ? colors.textMuted
                                                : balanceColor,
                                          },
                                        ]}
                                        numberOfLines={1}
                                        adjustsFontSizeToFit
                                        minimumFontScale={0.1}
                                        maxFontSizeMultiplier={1.4}
                                      >
                                        {person.tab_unsynced === 1 ? "…" : formatAmount(abs)}
                                      </Text>
                                      <Text
                                        testID={`customer-balance-${singleBalanceCurrency ? "symbol" : "currency"}-${code}`}
                                        style={
                                          singleBalanceCurrency
                                            ? styles.balanceSymbol
                                            : styles.balanceCurrency
                                        }
                                        numberOfLines={1}
                                        maxFontSizeMultiplier={1.4}
                                      >
                                        {ltrIsolate(
                                          singleBalanceCurrency
                                            ? getCurrencySymbol(code)
                                            : getCurrencyLabel(code),
                                        )}
                                      </Text>
                                    </View>
                                    {hasBalanceStatus ? (
                                      <View
                                        testID={`customer-balance-status-${code}`}
                                        style={[
                                          styles.chipRow,
                                          styles.balanceStatus,
                                          rowDir(isRTL),
                                          { justifyContent: isRTL ? "flex-start" : "flex-end" },
                                        ]}
                                      >
                                        {person.tab_unsynced === 1 ? null : chipLabel &&
                                          chipVariant ? (
                                          <Chip label={chipLabel} variant={chipVariant} />
                                        ) : settledCount > 0 &&
                                          chapterCoherent &&
                                          !sharedReviewPending &&
                                          unsettledOriginalCount === 0 ? (
                                          // "SETTLED" only when the user actually drew the line and it
                                          // covers everything.
                                          <Chip
                                            label={t("person.balance.settled")}
                                            variant="neutral"
                                          />
                                        ) : displayedEntries.length > 0 ? (
                                          // A tally that merely SUMS to zero (or whose chapter no longer
                                          // adds up after a sync) is not a settled account — say so
                                          // rather than leaving the chip slot blank while every other
                                          // state labels itself. Hollow pill: true, but not an
                                          // achievement. The settle-row invitation sits below.
                                          // Contacts with no entries at all keep an empty slot — there
                                          // is no tally yet to have a state.
                                          <Chip
                                            label={t("person.balance.notSettled")}
                                            variant="outline"
                                          />
                                        ) : null}
                                        {sharedAccountLinkStatus(link) === "waiting" ? (
                                          // Keep the invitation-waiting cue until the other side joins.
                                          // Once linked, the name badge is enough; no duplicate chip.
                                          <Pressable
                                            onPress={
                                              canAmend
                                                ? () => {
                                                    setManagementCurrency(code);
                                                    setLinkedSheetVisible(true);
                                                  }
                                                : undefined
                                            }
                                            disabled={!canAmend}
                                            accessibilityRole={canAmend ? "button" : "text"}
                                            style={({ pressed }) => [
                                              styles.readOnlyChip,
                                              pressed && { opacity: 0.5 },
                                            ]}
                                          >
                                            <Ionicons
                                              name="link-outline"
                                              size={14}
                                              color={colors.textSubtle}
                                            />
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
                                    ) : null}
                                  </View>
                                  {/* A discovered shared account that has not been pulled yet
                        has no known balance; the pull is already queued. */}
                                  {person.tab_unsynced === 1 ? (
                                    <Text style={[styles.unsyncedNote, textDir(isRTL)]}>
                                      {t("tab.notDownloaded")}
                                    </Text>
                                  ) : null}
                                  {financialTabHistory && person.tab_unsynced !== 1 ? (
                                    <Text style={[styles.unsyncedNote, textDir(isRTL)]}>
                                      {financialTabHistory.recording_mode_known === 0
                                        ? t("tab.recordingMode.unknown")
                                        : t(
                                            isNotificationOnlyMode(
                                              financialTabHistory.recording_mode,
                                            )
                                              ? "tab.balance.recorded"
                                              : "tab.balance.confirmed",
                                            {
                                              amount: signedSharedAmount(
                                                isNotificationOnlyMode(
                                                  financialTabHistory.recording_mode,
                                                )
                                                  ? person.balance
                                                  : (person.tab_confirmed_balance ?? 0),
                                              ),
                                              currency: getCurrencyLabel(code),
                                            },
                                          )}
                                    </Text>
                                  ) : null}
                                  {(person.tab_pending_count ?? 0) > 0 &&
                                  person.tab_unsynced !== 1 ? (
                                    <Text style={[styles.unsyncedNote, textDir(isRTL)]}>
                                      {t("tab.balance.pending", {
                                        count: person.tab_pending_count ?? 0,
                                        amount: signedSharedAmount(person.tab_pending_balance ?? 0),
                                        currency: getCurrencyLabel(code),
                                      })}
                                    </Text>
                                  ) : null}
                                  <CreditStatusBadge
                                    personId={person.id}
                                    vaultId={activeVaultId}
                                    currency={code}
                                  />
                                </View>
                                <TallyFlowSummary
                                  summary={flowSummaries.get(code) ?? summarizeTallyFlows([])}
                                  currency={code}
                                  isRTL={isRTL}
                                  variant="footer"
                                  filter={
                                    tallyFilter.currencies.length &&
                                    !tallyFilter.currencies.includes(code)
                                      ? "all"
                                      : tallyFilter.direction
                                  }
                                  onDirectionChange={(direction) => {
                                    changeTallyCardDirection(direction, code, onInteract);
                                  }}
                                  interactionEnabled={tallyDirectionEnabled}
                                />
                              </View>
                            );
                          })
                        }
                      </CustomerBalanceCarousel>
                    </View>
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
                          style={({ pressed }) => [
                            styles.pingNudgeSend,
                            pressed && { opacity: 0.7 },
                          ]}
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

                <HomeBalanceFilterSwipe
                  key={layoutKey}
                  testID="customer-tally-content"
                  enabled={tallyDirectionEnabled && !compactDock}
                  contextKey={JSON.stringify([
                    filterIntent,
                    filterEpoch,
                    searchQuery,
                    dateRange,
                    tallyCurrencyCodes,
                  ])}
                  currencyKey={JSON.stringify(tallyFilter.currencies)}
                  direction={
                    tallyFilter.direction === "received"
                      ? "collect"
                      : tallyFilter.direction === "gave"
                        ? "pay"
                        : "all"
                  }
                  onDirectionChange={changeTallySwipeDirection}
                  nativeGesture={nativeTallyScroll}
                  style={{ paddingBottom: actionsHeight + 24 }}
                  onLayout={(event) => {
                    if (!filterIsCurrent()) return;
                    const y = event.nativeEvent.layout.y;
                    if (!Number.isFinite(y) || y < 0) return;
                    tallyContentY.current = y;
                    revealNotificationTally();
                  }}
                >
                  {searching || tallyFiltersActive ? (
                    <View testID="customer-tally-filter-chips" style={styles.tallyFilterChips}>
                      {searching || tallyFiltersApplied ? (
                        <View
                          testID="customer-tally-filter-heading"
                          style={[styles.tallyFilterHeading, rowDir(isRTL)]}
                        >
                          {tallyFiltersApplied ? (
                            <Pressable
                              accessibilityRole="button"
                              onPress={clearTallyFilters}
                              style={styles.tallyFilterClearButton}
                            >
                              <Text style={[styles.tallyFilterClear, textDir(isRTL)]}>
                                {t("search.clearAll")}
                              </Text>
                            </Pressable>
                          ) : null}
                          {searching ? (
                            <Text
                              style={[
                                styles.searchSummary,
                                styles.tallyFilterCount,
                                textDir(isRTL),
                                { textAlign: isRTL ? "left" : "right" },
                              ]}
                              accessibilityLiveRegion="polite"
                              accessibilityHint={t("person.search.balanceHint")}
                            >
                              {t(
                                searchResultCount === 1
                                  ? "person.search.result"
                                  : "person.search.results",
                                { count: searchResultCount },
                              )}
                            </Text>
                          ) : null}
                        </View>
                      ) : null}
                      {tallyFiltersActive ? (
                        <View style={[styles.tallyFilterChipRow, rowDir(isRTL)]}>
                          {tallyFilter.direction !== "all" ? (
                            <Pressable
                              accessibilityRole="button"
                              onPress={() =>
                                changeTallyFilter({ ...tallyFilterRef.current, direction: "all" })
                              }
                              style={[styles.tallyFilterChip, rowDir(isRTL)]}
                            >
                              <Text
                                style={[
                                  styles.searchSummary,
                                  styles.tallyFilterChipLabel,
                                  textDir(isRTL),
                                ]}
                              >
                                {t(
                                  tallyFilter.direction === "received"
                                    ? "person.filters.received"
                                    : "person.filters.gave",
                                )}
                              </Text>
                              <Ionicons name="close" size={14} color={colors.textSubtle} />
                            </Pressable>
                          ) : null}
                          {tallyFilter.currencies.map((code) => (
                            <Pressable
                              key={code}
                              accessibilityRole="button"
                              accessibilityLabel={`${getCurrencyLabel(code)}, ${t("customers.currencyFilter.clear")}`}
                              onPress={() =>
                                changeTallyFilter({
                                  ...tallyFilterRef.current,
                                  currencies: tallyFilterRef.current.currencies.filter(
                                    (value) => value !== code,
                                  ),
                                })
                              }
                              style={styles.tallyFilterChip}
                            >
                              <Text style={[styles.searchSummary, styles.tallyFilterChipLabel]}>
                                {getCurrencyLabel(code)}
                              </Text>
                              <Ionicons name="close" size={14} color={colors.textSubtle} />
                            </Pressable>
                          ))}
                          {dateRange ? (
                            <Pressable
                              testID="customer-tally-date-chip"
                              accessibilityRole="button"
                              accessibilityLabel={t("person.date.active", {
                                range: dateRangeLabel,
                              })}
                              accessibilityHint={t("person.date.clear")}
                              onPress={() => {
                                if (searchIsCurrent()) setDateRange(null);
                              }}
                              style={[styles.tallyFilterChip, rowDir(isRTL)]}
                            >
                              <Text
                                numberOfLines={2}
                                style={[
                                  styles.searchSummary,
                                  styles.tallyFilterChipLabel,
                                  textDir(isRTL),
                                ]}
                              >
                                {dateRangeLabel}
                              </Text>
                              <Ionicons name="close" size={14} color={colors.textSubtle} />
                            </Pressable>
                          ) : null}
                          {tallyFilter.sort !== "recent" ? (
                            <Pressable
                              accessibilityRole="button"
                              onPress={() =>
                                changeTallyFilter({ ...tallyFilterRef.current, sort: "recent" })
                              }
                              style={[styles.tallyFilterChip, rowDir(isRTL)]}
                            >
                              <Text
                                style={[
                                  styles.searchSummary,
                                  styles.tallyFilterChipLabel,
                                  textDir(isRTL),
                                ]}
                              >
                                {t(
                                  tallyFilter.sort === "date_asc"
                                    ? "person.filters.oldest"
                                    : tallyFilter.sort === "amount_asc"
                                      ? "customers.sort.amount_asc"
                                      : "customers.sort.amount_desc",
                                )}
                              </Text>
                              <Ionicons name="close" size={14} color={colors.textSubtle} />
                            </Pressable>
                          ) : null}
                        </View>
                      ) : null}
                    </View>
                  ) : null}
                  {/* Settle-up affordance — deliberately NOT a button. A ruled line,
            the same mark a paper khata gets when an account is closed. It
            only exists in the exact moment it means something: balance is
            zero AND the current chapter has entries. Tapping it draws the
            line for real. */}
                  {canSettle && !searching && !selecting
                    ? settleablePeriods.map((period) => (
                        <Pressable
                          key={period.currency}
                          onPress={() => {
                            setSettleCurrency(period.currency);
                            setConfirmSettle(true);
                          }}
                          accessibilityRole="button"
                          accessibilityLabel={
                            currencyPeriods.length > 1
                              ? `${t("person.settle.row")} · ${getCurrencyLabel(period.currency)}`
                              : t("person.settle.row")
                          }
                          style={({ pressed }) => [
                            styles.settleRow,
                            rowDir(isRTL),
                            pressed && { opacity: 0.5 },
                          ]}
                        >
                          <View style={styles.settleRule} />
                          <Text style={styles.settleRowText} allowFontScaling={false}>
                            {t("person.settle.row")} · {getCurrencyLabel(period.currency)}
                          </Text>
                          <View style={styles.settleRule} />
                        </Pressable>
                      ))
                    : null}

                  {/* Waiting and refused clerk attempts stay on the complete ledger. */}
                  {!searching && !selecting ? (
                    <CreditIntentList personId={person.id} vaultId={activeVaultId} allCurrencies />
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
                    ) : settledTallyCount > 0 && !effectiveShowFull ? null : (
                      <EmptyState
                        title={t("person.empty.title")}
                        subtitle={t("person.empty.subtitle")}
                        isRTL={isRTL}
                      />
                    )
                  ) : null}
                  {reuseTallyRows || historyItems.length > 0 ? renderTallyHistory() : null}

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
                  {currencyPeriods.some((period) => period.financialTab) &&
                  matchedPreLink.length > 0 ? (
                    <>
                      <Pressable
                        onPress={() => setPreLinkOpen((v) => !v)}
                        disabled={searching}
                        accessibilityRole="button"
                        accessibilityState={{
                          expanded: searching || preLinkOpen,
                          disabled: searching,
                        }}
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
                  {chapterCoherent && !searching ? (
                    <SettledHistoryToggle
                      kind="tallies"
                      horizontalInset={16}
                      count={settledTallyCount}
                      expanded={showFullHistory}
                      disabled={selecting || selectionBusy}
                      onToggle={() => {
                        if (
                          !filterIsCurrent() ||
                          searchingRef.current ||
                          selectionContext.current.selecting ||
                          selectionBusyRef.current
                        )
                          return;
                        setHistoryDisclosure((previous) => ({
                          key: layoutKey,
                          expanded: !(previous.key === layoutKey && previous.expanded),
                        }));
                      }}
                    />
                  ) : null}
                </HomeBalanceFilterSwipe>
              </ScrollView>
            </GestureDetector>

            {/* Opaque dock: it takes every tap on its own background. The old
          ping bar was a floating button and passed taps through ("box-none"),
          which here reached tally rows hidden behind the dock, Accept/Reject
          included. It still lifts above toasts, over its own DOCK_SKIRT, but not
          above an open keyboard. Received LEFT, gave RIGHT regardless of
          language. */}
            {canCreate || hasTallies ? (
              <Animated.View
                onLayout={(event) => {
                  measuredActionsHeight.current = Math.max(
                    0,
                    event.nativeEvent.layout.height - DOCK_SKIRT,
                  );
                  if (Platform.OS !== "ios" || !keyboardMoving.current) publishActionsHeight();
                }}
                style={[
                  styles.actions,
                  {
                    bottom: -DOCK_SKIRT,
                    transform: [{ translateY: compactDock ? 0 : toastOffset }],
                  },
                ]}
              >
                <SearchKeyboardFooter
                  onLayout={updateTallyFilterAnchor}
                  closedPadding={20 + insets.bottom + DOCK_SKIRT}
                  openPadding={8 + DOCK_SKIRT}
                  keyboardShown={compactDock}
                  style={styles.actionsContent}
                >
                  {/* While typing a search the entry buttons step aside so the
                  results above the keyboard get their room (0-1 rows before,
                  audit #31); they return with the keyboard's close. */}
                  {!selecting && canCreate && writableEntryCurrency && !compactDock ? (
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
                            styles.actionReceived,
                            pressed && styles.actionBtnPressed,
                          ]}
                        >
                          {/* 16 is composed INTO the fixed 26px coin (see
                      actionIconCoin), so the icon scale does not apply here —
                      icon.trailing/row would fill or overflow the well. */}
                          <View style={[styles.actionIconCoin, styles.actionReceivedCoin]}>
                            <Ionicons
                              name="arrow-down-outline"
                              size={16}
                              color={colors.entryActionReceivedText}
                            />
                          </View>
                          <Text
                            style={[
                              styles.actionText,
                              styles.actionReceivedText,
                              trackingSafe(isRTL),
                            ]}
                          >
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
                            styles.actionGave,
                            pressed && styles.actionBtnPressed,
                          ]}
                        >
                          {/* 16, composed into the coin — same reason as "I received". */}
                          <View style={[styles.actionIconCoin, styles.actionGaveCoin]}>
                            <Ionicons
                              name="arrow-up-outline"
                              size={16}
                              color={colors.entryActionGaveText}
                            />
                          </View>
                          <Text
                            style={[styles.actionText, styles.actionGaveText, trackingSafe(isRTL)]}
                          >
                            {t("person.action.iGave")}
                          </Text>
                        </Pressable>
                      </View>
                    </View>
                  ) : null}
                  {hasTallies ? (
                    <View style={styles.searchArea}>
                      <View style={styles.searchControls}>
                        <View style={styles.searchBox}>
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
                            onPress={
                              Platform.OS === "android"
                                ? () => {
                                    if (searchIsCurrent()) setSearchFocused(true);
                                  }
                                : undefined
                            }
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
                            style={styles.clearSearchLTR}
                          >
                            <Pressable
                              onPress={() => {
                                if (searchIsCurrent()) setSearchQuery("");
                              }}
                              accessibilityRole="button"
                              accessibilityLabel={t("person.search.clear")}
                              style={styles.clearSearch}
                            >
                              <Ionicons
                                name="close"
                                size={icon.trailing}
                                color={colors.textSubtle}
                              />
                            </Pressable>
                          </SearchControlSlot>
                        </View>
                        {searchFocused || compactDock || tallyFiltersVisible ? (
                          <Pressable
                            ref={tallyFilterTrigger}
                            testID="customer-tally-filter-trigger"
                            accessibilityRole="button"
                            accessibilityLabel={t("person.filters.title")}
                            accessibilityState={{
                              expanded: tallyFiltersVisible,
                              selected: directionalFiltering || tallyFilter.sort !== "recent",
                            }}
                            disabled={!tallyPopupEnabled}
                            onPress={() => {
                              if (!filterIsCurrent() || !tallyInteraction.current.enabled) return;
                              const next = !tallyFiltersVisibleRef.current;
                              tallyFiltersVisibleRef.current = next;
                              setTallyFiltersVisible(next);
                              if (next) {
                                dismissSearchKeyboard();
                                requestAnimationFrame(updateTallyFilterAnchor);
                              }
                            }}
                            onLayout={updateTallyFilterAnchor}
                            style={[
                              styles.dateButton,
                              (directionalFiltering || tallyFilter.sort !== "recent") &&
                                styles.dateButtonActive,
                            ]}
                          >
                            <Ionicons
                              name="options-outline"
                              size={icon.row}
                              color={colors.textEmphasis}
                            />
                          </Pressable>
                        ) : null}
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
                          visible={dismissControlVisible}
                          width={TOUCH_MIN}
                          height={TOUCH_MIN}
                          collapse
                          // Opening keeps its existing motion. Closing commits a
                          // numeric width with willHide, without a second JS tween.
                          animate={Platform.OS === "ios" && dismissControlVisible}
                          gap={8}
                          isRTL={false}
                        >
                          <Pressable
                            onPress={dismissSearchKeyboard}
                            accessibilityRole="button"
                            accessibilityLabel={t("common.hideKeyboard")}
                            style={styles.dateButton}
                          >
                            <Ionicons
                              name="chevron-down"
                              size={icon.row}
                              color={colors.textEmphasis}
                            />
                          </Pressable>
                        </SearchControlSlot>
                      </View>
                    </View>
                  ) : null}
                </SearchKeyboardFooter>
              </Animated.View>
            ) : null}
          </View>
        </SearchKeyboardFrame>
      </BlurTargetView>
      <CustomerTallyFilterPopover
        visible={tallyFiltersVisible && tallyPopupEnabled}
        contextKey={`${filterIntent}:${filterEpoch}`}
        anchor={tallyFilterAnchor}
        viewport={{ ...filterSurface, topInset: insets.top }}
        blurTarget={filterBlurTarget}
        filter={tallyFilter}
        hasDateFilter={dateRange != null}
        availableCodes={tallyCurrencyCodes}
        onChange={changeTallyFilter}
        onClear={clearTallyFilters}
        isRTL={isRTL}
        keyboardVisible={compactDock}
        onDismissKeyboard={dismissSearchKeyboard}
        onDismiss={() => {
          if (filterIsCurrent()) setTallyFiltersVisible(false);
        }}
        renderToggle={({ onPress, disabled }) => (
          <Pressable
            testID="customer-tally-filter-close-toggle"
            accessibilityRole="button"
            accessibilityLabel={t("person.filters.title")}
            accessibilityState={{
              expanded: true,
              selected: directionalFiltering || tallyFilter.sort !== "recent",
              disabled,
            }}
            disabled={disabled}
            onPress={onPress}
            style={[
              styles.dateButton,
              styles.filterCloseToggle,
              (directionalFiltering || tallyFilter.sort !== "recent") && styles.dateButtonActive,
            ]}
          >
            <Ionicons name="options-outline" size={icon.row} color={colors.textEmphasis} />
          </Pressable>
        )}
      />
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
            ? `${formatAmount(sheetFor.amount_afn)} ${getCurrencyLabel(sheetFor.currency ?? person.currency ?? selectedCurrency)}`
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
        link={managementLink?.closed_at == null ? managementLink : null}
        currency={managementCurrency ?? person.currency ?? selectedCurrency}
        currencies={managementLink?.group_id ? managementCurrencies : undefined}
        onLinked={(created) => {
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
        title={`${person.name} · ${managementCurrencyLabel}`}
        description={
          managementLink?.recording_mode_known === 0
            ? t("tab.recordingMode.unknown")
            : t("tab.recordingMode.fixed", {
                mode: t(
                  managementLink?.recording_mode === "notify_one_way"
                    ? "tab.recordingMode.oneWayFixed"
                    : managementLink?.recording_mode === "notify"
                      ? "tab.recordingMode.notify"
                      : "tab.recordingMode.review",
                ),
              })
        }
        onDismiss={() => setLinkedSheetVisible(false)}
        actions={[
          ...(managementLink?.role === "a" && managementLink.invite_url
            ? [
                {
                  label: t("tab.share.again"),
                  icon: "share-outline" as const,
                  onPress: () => setInviteVisible(true),
                },
              ]
            : []),
          ...(managementLink?.role === "a"
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
        description={`${managementCurrencyLabel} · ${t("tab.regenerate.body", { name: person.name })}`}
        confirmLabel={t("tab.regenerate.ok")}
        onConfirm={() => void onRegenerate()}
        onCancel={() => setConfirmRegenerate(false)}
      />
      <ConfirmDialog
        visible={confirmUnlink}
        title={t("tab.unlink.title", { name: person.name })}
        description={`${managementCurrencyLabel} · ${t(managementLink?.group_id ? "tab.group.unlinkBody" : "tab.unlink.body")}`}
        confirmLabel={t("tab.unlink")}
        destructive
        onConfirm={() => void onUnlink()}
        onCancel={() => setConfirmUnlink(false)}
      />

      {/* Per-send message-language picker (share_lang_pref = 'ask'). Dari
          first — the common pick. No persisted selection: it's per-send. */}
      {linkCurrencyVisible ? (
        <OptionSheet
          visible={linkCurrencyVisible}
          title={t("entry.currency.label")}
          options={legacyLinkedPeriods.map((period) => ({
            key: period.currency,
            label: getCurrencyLabel(period.currency),
          }))}
          selected={managementCurrency ?? person.currency ?? selectedCurrency}
          onSelect={(code) => {
            if (!screenIsCurrent() || !canAmend || linkCurrencyBusy.current) return;
            const target = legacyLinkedPeriods.find((period) => period.currency === code);
            if (!target) return;
            linkCurrencyBusy.current = true;
            setLinkCurrencyVisible(false);
            setManagementCurrency(code);
            setTimeout(() => {
              if (!screenIsCurrent()) return;
              target.tab?.closed_at == null && target.tab
                ? setLinkedSheetVisible(true)
                : setInviteVisible(true);
            }, 220);
          }}
          onDismiss={() => setLinkCurrencyVisible(false)}
          isRTL={isRTL}
        />
      ) : null}
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
        description={`${getCurrencyLabel(settlementTarget?.currency ?? person.currency ?? selectedCurrency)} · ${t(
          settlementTarget?.financialTab ? "tab.settle.confirm" : "person.settle.confirm.body",
          {
            name: person.name,
          },
        )}`}
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
  tallyFilterChips: { paddingHorizontal: 16, paddingBottom: 12, gap: 8 },
  tallyFilterHeading: { alignItems: "center", gap: 12 },
  tallyFilterClearButton: { maxWidth: "50%" },
  tallyFilterClear: { ...typography.bodySm, color: colors.textEmphasis },
  tallyFilterCount: { flex: 1, minWidth: 0 },
  tallyFilterChipRow: { flexWrap: "wrap", alignItems: "center", gap: 8, width: "100%" },
  tallyFilterChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    maxWidth: "100%",
    minWidth: 0,
    flexShrink: 1,
    minHeight: 32,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderWidth: 1,
    borderColor: colors.borderDefault,
    borderRadius: 20,
  },
  tallyFilterChipLabel: { flexShrink: 1 },
  container: { flex: 1, backgroundColor: colors.bgDefault },
  fillCenter: { flex: 1, alignItems: "center", justifyContent: "center" },
  notFoundText: { fontSize: 14, fontFamily: fonts.sansRegular, color: colors.textSubtle },
  // One compact action group with separate 44pt targets, mirrored in Dari.
  // The 10pt between header actions lives in the row's gap: a margin on
  // one side of the button landed on the outer edge in Dari's reversed row,
  // leaving 2pt between the icons (audit #11).
  headerSide: { flexShrink: 0, alignItems: "center" },
  headerActions: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "flex-end",
    gap: 10,
  },
  headerIdentity: { flex: 1, minWidth: 0, alignItems: "center", paddingHorizontal: 4 },
  headerTitleRow: { maxWidth: "100%", alignItems: "center", justifyContent: "center", gap: 6 },
  headerName: {
    ...typography.title,
    fontFamily: fonts.sansBold,
    color: colors.textEmphasis,
    textAlign: "center",
    flexShrink: 1,
    minWidth: 0,
  },
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
  selectionTop: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    paddingHorizontal: 16,
    paddingTop: 8,
    zIndex: 5,
    overflow: "visible",
  },
  hiddenBalances: { display: "none" },
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
  balanceOverview: {
    borderWidth: 1,
    borderColor: colors.borderBalanceGlass,
    borderRadius: radius.lg,
    backgroundColor: colors.bgBalanceGlass,
    overflow: "hidden",
  },
  balanceHeadline: {
    direction: "ltr",
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    minWidth: 0,
  },
  balanceStatus: { maxWidth: "48%", flexShrink: 0 },
  balanceAmountRow: {
    flex: 1,
    direction: "ltr",
    flexDirection: "row",
    alignItems: "baseline",
    gap: 8,
    minWidth: 0,
  },
  balanceWithCurrency: { width: undefined, flexShrink: 1, minWidth: 0 },
  balanceSymbol: {
    fontFamily: fonts.sansSemi,
    fontSize: 22,
    color: colors.textSubtle,
    writingDirection: "ltr",
    flexShrink: 0,
  },
  balanceCurrency: {
    ...typography.bodySm,
    fontFamily: fonts.sansSemi,
    color: colors.textSubtle,
    writingDirection: "ltr",
    flexShrink: 0,
  },
  balanceSide: { minWidth: 0, paddingHorizontal: 14, paddingVertical: 10 },
  // Statuses share the amount row; extra invitation labels wrap within their side.
  chipRow: {
    minWidth: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    flexWrap: "wrap",
  },
  metadataRow: {
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
    marginBottom: 12,
  },
  linkWaiting: { ...typography.caption, color: colors.textSubtle, maxWidth: "50%" },
  groupBadges: {
    maxWidth: "100%",
    flexShrink: 1,
    flexWrap: "wrap",
    justifyContent: "flex-end",
    gap: 6,
  },
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
  // Amounts use Latin digits in every language and have the full card width.
  balance: {
    ...typography.numHero,
    color: colors.textEmphasis,
    letterSpacing: -0.5,
    width: "100%",
    writingDirection: "ltr",
    textAlign: "left",
  },
  searchArea: { gap: 4 },
  searchControls: { flexDirection: "row", direction: "ltr", alignItems: "center", gap: 8 },
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
  filterCloseToggle: { width: "100%", height: "100%", backgroundColor: colors.bgDefault },
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
    paddingTop: 12,
    backgroundColor: colors.bgDefault,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.borderSubtle,
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
  },
  actionsContent: { gap: 10 },
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
    // Muted action colors distinguish verbs without treating giving as loss.
    // Arrows, labels and physical position still identify each action.
    ...Platform.select({
      ios: {
        shadowColor: "#000",
        shadowOpacity: 0.1,
        shadowRadius: 8,
        shadowOffset: { width: 0, height: 3 },
      },
      android: { elevation: 2 },
    }),
  },
  actionReceived: { backgroundColor: colors.entryActionReceived },
  actionGave: { backgroundColor: colors.entryActionGave },
  actionReceivedText: { color: colors.entryActionReceivedText },
  actionGaveText: { color: colors.entryActionGaveText },
  actionReceivedCoin: { backgroundColor: colors.entryActionReceivedCoin },
  actionGaveCoin: { backgroundColor: colors.entryActionGaveCoin },
  // Subtle scale + dim on press — a tactile, considered feel for a button
  // tapped all day, instead of a flat opacity blink.
  actionBtnPressed: { opacity: 0.9, transform: [{ scale: 0.985 }] },
  // A deeper tint gives the arrow its own small circular background.
  actionIconCoin: {
    width: ACTION_COIN_SIZE,
    height: ACTION_COIN_SIZE,
    borderRadius: ACTION_COIN_SIZE / 2,
    alignItems: "center",
    justifyContent: "center",
  },
  actionText: {
    flexShrink: 1,
    textAlign: "center",
    lineHeight: sansLineHeight(15, 20),
    fontSize: 15,
    fontFamily: fonts.sansSemi,
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
  // Secondary labels for retained history and failed sends.
  historyRowText: {
    fontSize: 12,
    fontFamily: fonts.sansMedium,
    color: colors.textSubtle,
  },
  // "Before linking · N" fold for the original private pages.
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
