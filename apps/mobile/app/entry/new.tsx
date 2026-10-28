import type { ScrollViewInstance, TextInputInstance, ViewInstance } from "react-native";
import { useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Ionicons } from "@expo/vector-icons";
import {
  Keyboard,
  BackHandler,
  KeyboardAvoidingView,
  InputAccessoryView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TurboModuleRegistry,
  View,
  useWindowDimensions,
} from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { Button } from "../../components/Button";
import { EntryCalculator } from "../../components/EntryCalculator";
import { EntryDateField } from "../../components/EntryDateField";
import { CurrencySelector } from "../../components/CurrencySelector";
import { ScreenLoading } from "../../components/ScreenLoading";
import { ScreenHeader } from "../../components/SettingsScreen";
import { queuePendingToast, useToast } from "../../components/Toast";
import { colors } from "../../lib/colors";
import {
  applyForUnchangedLocalSession,
  captureCurrentSession,
  SessionChangedError,
  type SessionSnapshot,
} from "../../lib/auth";
import { getAccountIdSync, getActiveVaultIdSyncMaybe, getInstallIdSync } from "../../lib/db-tx";
import {
  DEFAULT_CURRENCY,
  currencyNeedsPrecisionHint,
  getCurrencyLabel,
  setCurrentCurrency,
} from "../../lib/currency";
import {
  createEntryDetailed,
  getActiveVaultArchivedState,
  getPerson,
  updateEntry,
  SettledChapterError,
  TabLinkedEntryError,
  EntryEditChangedError,
  EntryEditCurrencyDisabledError,
} from "../../lib/db";
import { getPersonEntryCurrency, getPersonEnabledCurrencies } from "../../lib/person-currency";
import { rowDir, textDir, trackingSafe, useIsRTL } from "../../lib/direction";
import { EventSigningUnavailableError, RoleGateRejectionError } from "../../lib/event-log";
import { EntryCurrencyBaselineRequiredError } from "../../lib/projection/errors";
import { fonts, sansLineHeight } from "../../lib/fonts";
import { t } from "../../lib/i18n";
import { withEntryDay } from "../../lib/entry-date";
import { localDayStart } from "../../lib/tally-date-filter";
import { onLedgerApplied } from "../../lib/ledger-events";
import { parseAmountInput } from "../../lib/money";
import { evaluateCalculation } from "../../lib/calculator";
import {
  calculatorDraft,
  calculatorKey,
  selectCalculation,
  rememberCalculation,
  type CalculatorDraft,
  type CalculatorRecord,
} from "../../lib/calculator-input";
import { getTabLinkForPerson, listOpenTabLinksForPerson } from "../../lib/tabs/db";
import { canWriteSharedTallies } from "../../lib/tabs/recording-mode";
import type { TabLink } from "../../lib/tabs/types";
import { creditWarning, creditWarningForEdit } from "../../lib/credit-limits";
import { noteSavedEntry } from "../../lib/recent-entry";
import { noteReviewableTally } from "../../lib/store-review";
import {
  TabAuthUnavailableError,
  TabApiError,
  TabClosedError,
  TabInputError,
  TabPermissionError,
} from "../../lib/tabs/errors";
import { radius, TOUCH_MIN, typography } from "../../lib/tokens";
import {
  ENTRY_NOTE_MAX_LENGTH,
  type Entry,
  type EntryType,
  type PersonWithBalance,
} from "../../lib/types";

// Loading branches need modal-safe edges too, so the header stays in place
// when content arrives. The loaded iOS dock owns its bottom safe padding.
const MODAL_EDGES = ["top", "bottom", "left", "right"] as const;
type ScreenScope = {
  personId: string;
  type: EntryType;
  vaultId: string | null;
  accountId: string | null;
  installId: string;
};
type UIAttempt = ScreenScope & { focus: number };

export default function EntryFormScreen({
  editingEntry,
  editPersonId,
}: { editingEntry?: Entry; editPersonId?: string } = {}) {
  const router = useRouter();
  const isRTL = useIsRTL();
  const safeArea = useSafeAreaInsets();
  const { height: windowHeight, fontScale } = useWindowDimensions();
  // Non-edge-to-edge Android hosts already resize the window for the IME.
  // A second height owner races that native resize. Edge-to-edge hosts still
  // need explicit avoidance; retain it when the host capability is unknown.
  const avoidAndroidKeyboard =
    Platform.OS === "android" &&
    TurboModuleRegistry.get<{
      getConstants(): { isEdgeToEdge?: boolean };
    }>("DeviceInfo")?.getConstants().isEdgeToEdge !== false;
  // iOS keeps one stable three-line viewport so UIKit can reveal the caret
  // without racing a growing field. Android grows to six lines, then scrolls.
  const noteLineHeight = sansLineHeight(15, 22) * Math.max(1, fontScale);
  const noteMinHeight = Math.ceil(noteLineHeight * 3 + 26);
  const noteMaxHeight = Math.max(
    noteMinHeight,
    Math.min(Math.ceil(noteLineHeight * 6 + 26), Math.floor(windowHeight * 0.24)),
  );
  const toast = useToast();
  const params = useLocalSearchParams<{ personId?: string; type?: string }>();
  const personId = editPersonId ?? params.personId ?? "";
  const type: EntryType = editingEntry?.type ?? (params.type === "payment" ? "payment" : "debt");

  const [person, setPerson] = useState<PersonWithBalance | null>(null);
  const [loading, setLoading] = useState(true);
  const [calculation, setCalculation] = useState(() =>
    calculatorDraft(editingEntry ? String(editingEntry.amount_afn) : ""),
  );
  const calculationRef = useRef(calculation);
  const calculationResult = evaluateCalculation(calculation.expression);
  const hasCalculationPreview =
    calculationResult.status === "valid" ||
    (calculationResult.status === "incomplete" && calculationResult.normalizedExpression === "");
  const amount = calculationResult.canApply ? calculationResult.amount : "";
  const [note, setNote] = useState(editingEntry?.note ?? "");
  const [currency, setCurrency] = useState<string>(editingEntry?.currency ?? DEFAULT_CURRENCY);
  const [enabledCurrencies, setEnabledCurrencies] = useState<readonly string[]>([]);
  const enabledCurrencyRef = useRef<readonly string[]>([]);
  const enabledCurrencyRead = useRef(0);
  const [currencyLinks, setCurrencyLinks] = useState<Record<string, TabLink | null>>({});
  const currencyLinksRef = useRef<Record<string, TabLink | null>>({});
  const [currencyLinksReady, setCurrencyLinksReady] = useState(false);
  const currentCurrencyLink = currencyLinks[currency];
  const editSourceLink = editingEntry?.currency ? currencyLinks[editingEntry.currency] : null;
  const blockedCurrencyLink = !canWriteSharedTallies(currentCurrencyLink)
    ? currentCurrencyLink
    : !canWriteSharedTallies(editSourceLink)
      ? editSourceLink
      : null;
  const currencyWritable =
    currencyLinksReady &&
    Object.hasOwn(currencyLinks, currency) &&
    canWriteSharedTallies(currentCurrencyLink) &&
    canWriteSharedTallies(editSourceLink);
  const currencyScope = useRef<string | null>(null);
  // Null keeps the usual save-time timestamp, even if this form stays open overnight.
  const [entryDay, setEntryDay] = useState<number | null>(editingEntry?.created_at ?? null);
  const [moreOptionsOpen, setMoreOptionsOpen] = useState(false);
  const moreOptionsRef = useRef(false);
  const [datePickerOpen, setDatePickerOpen] = useState(false);
  const datePickerRef = useRef(false);
  const [calculatorAttempt, setCalculatorAttempt] = useState<UIAttempt | null>(null);
  const calculatorRef = useRef<UIAttempt | null>(null);
  const [calculatorHistory, setCalculatorHistory] = useState<CalculatorRecord[]>([]);
  const activeField = useRef<"amount" | "note" | null>(null);
  const amountSelectionIntent = useRef(false);
  const [nativeKeyboardOpen, setNativeKeyboardOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  // Inline errors — this screen is presentation:"modal", and toasts cannot
  // render above native stack modals (see components/Toast.tsx), so
  // validation and save failures MUST surface inline or they're invisible.
  const [amountError, setAmountError] = useState<string | null>(null);
  // Said while typing, not only after the save (audit #24): the same check
  // the save makes, on the amount as it stands.
  const [overLimit, setOverLimit] = useState(false);
  useEffect(() => {
    const parsed = parseAmountInput(amount);
    if (parsed === null || parsed <= 0 || !personId) {
      setOverLimit(false);
      return;
    }
    let alive = true;
    const timer = setTimeout(() => {
      (editingEntry
        ? creditWarningForEdit(
            editingEntry.id,
            parsed,
            getActiveVaultIdSyncMaybe() ?? undefined,
            currency,
          )
        : creditWarning(personId, type, parsed, getActiveVaultIdSyncMaybe() ?? undefined, currency)
      )
        .then((over) => {
          if (alive) setOverLimit(over);
        })
        .catch(() => undefined);
    }, 250);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [amount, personId, type, currency, editingEntry?.id]);
  const [saveError, setSaveError] = useState<string | null>(null);
  const saveErrorRef = useRef(saveError);
  saveErrorRef.current = saveError;
  const amountRef = useRef<TextInputInstance>(null);
  const noteRef = useRef<TextInputInstance>(null);
  const initialFocusTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const noteAccessoryId = useId();
  const scrollRef = useRef<ScrollViewInstance>(null);
  const noteScrollRequest = useRef<UIAttempt | null>(null);
  const noteScrollFrame = useRef<number | null>(null);
  const nativeKeyboardReady = useRef(false);
  const keyboardFrameRef = useRef<ViewInstance>(null);
  const keyboardMeasurement = useRef(0);
  const [keyboardOffset, setKeyboardOffset] = useState(0);
  const [availableHeight, setAvailableHeight] = useState<number | undefined>();
  const [saveBarHeight, setSaveBarHeight] = useState<number | undefined>();
  const [dockHeight, setDockHeight] = useState(0);
  const dockHeightRef = useRef(0);
  const amountField = useRef({ y: 0, height: 0 });
  const saveErrorField = useRef<{ y: number; height: number } | null>(null);
  const formViewport = useRef(0);
  const formScrollY = useRef(0);
  const formInsets = useRef({ top: 0, bottom: 0 });
  // Synchronous re-entry guard. `busy` state alone can't stop a double-tap:
  // setState doesn't apply within the same frame, so two rapid taps both
  // observe busy === false and each write an entry. The ref flips
  // synchronously before any await.
  const savingRef = useRef(false);
  const mounted = useRef(true);
  const focused = useRef(false);
  const focusGeneration = useRef(0);
  const [focusVersion, setFocusVersion] = useState(0);
  const scope: ScreenScope = {
    personId,
    type,
    vaultId: getActiveVaultIdSyncMaybe(),
    accountId: getAccountIdSync(),
    installId: getInstallIdSync(),
  };
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  const isCurrent = (attempt: UIAttempt) =>
    mounted.current &&
    focused.current &&
    attempt.focus === focusGeneration.current &&
    scopeRef.current.personId === attempt.personId &&
    scopeRef.current.type === attempt.type &&
    getActiveVaultIdSyncMaybe() === attempt.vaultId &&
    getAccountIdSync() === attempt.accountId &&
    getInstallIdSync() === attempt.installId;
  async function refreshEnabledCurrencies(attempt: UIAttempt) {
    if (!attempt.vaultId) return;
    const read = ++enabledCurrencyRead.current;
    const codes = await getPersonEnabledCurrencies(attempt.vaultId, attempt.personId);
    if (!isCurrent(attempt) || read !== enabledCurrencyRead.current) return;
    const linkCodes = [
      ...new Set([...codes, ...(editingEntry?.currency ? [editingEntry.currency] : [])]),
    ];
    const openLinks = await listOpenTabLinksForPerson(attempt.personId);
    const byCurrency = new Map<string, TabLink>();
    for (const link of openLinks)
      if (!byCurrency.has(link.currency)) byCurrency.set(link.currency, link);
    const groupContract = openLinks.find((link) => link.group_id);
    // Missing currencies inherit only the account's write permission. Saving
    // still resolves or creates their own currency-specific shared link.
    const links = Object.fromEntries(
      linkCodes.map((code) => [code, byCurrency.get(code) ?? groupContract ?? null]),
    );
    if (!isCurrent(attempt) || read !== enabledCurrencyRead.current) return;
    enabledCurrencyRef.current = codes;
    setEnabledCurrencies(codes);
    currencyLinksRef.current = links;
    setCurrencyLinks(links);
    setCurrencyLinksReady(true);
  }
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      amountSelectionIntent.current = false;
      cancelNoteReveal();
    };
  }, []);

  // Android keeps its form/footer inside the resized window or avoider. iOS
  // uses a stable viewport, native scroll insets and a UIKit accessory for
  // Save. Its dock measurement only reserves room for our custom calculator.
  function measureKeyboardFrame() {
    if (!avoidAndroidKeyboard) return;
    const attempt = { ...scopeRef.current, focus: focusGeneration.current };
    const measurement = ++keyboardMeasurement.current;
    keyboardFrameRef.current?.measureInWindow((_x, y) => {
      if (measurement !== keyboardMeasurement.current || !isCurrent(attempt)) return;
      setKeyboardOffset(y);
    });
  }

  function revealField({ y, height }: { y: number; height: number }) {
    const viewport = formViewport.current;
    const { top } = formInsets.current;
    const bottom = Math.max(formInsets.current.bottom, dockHeightRef.current);
    if (!viewport || viewport <= top + bottom || !height) return;
    const clippedAbove = y < formScrollY.current + top;
    if (clippedAbove || y + height > formScrollY.current + viewport - bottom)
      scrollRef.current?.scrollTo({
        y: Math.max(0, clippedAbove ? y - top : Math.min(y - top, y + height - viewport + bottom)),
        animated: true,
      });
  }

  function revealAmount() {
    revealField(amountField.current);
  }

  function cancelNoteScrollFrame() {
    if (noteScrollFrame.current !== null) {
      cancelAnimationFrame(noteScrollFrame.current);
      noteScrollFrame.current = null;
    }
  }

  function cancelNoteReveal() {
    noteScrollRequest.current = null;
    cancelNoteScrollFrame();
  }

  function queueNoteReveal() {
    const request = noteScrollRequest.current;
    const current = () =>
      noteScrollRequest.current === request &&
      request !== null &&
      nativeKeyboardReady.current &&
      activeField.current === "note" &&
      isCurrent(request);
    if (!current() || noteScrollFrame.current !== null) return;
    // UIKit owns the keyboard/caret animation. Once it finishes, allow the
    // React commit and native viewport layout to finish before one final move.
    const commitFrame = requestAnimationFrame(() => {
      if (noteScrollFrame.current !== commitFrame) return;
      noteScrollFrame.current = null;
      if (!current()) return;
      const layoutFrame = requestAnimationFrame(() => {
        if (noteScrollFrame.current !== layoutFrame) return;
        noteScrollFrame.current = null;
        if (!current()) return;
        // Consume before dispatch: late keyboard/layout events cannot restart it.
        noteScrollRequest.current = null;
        scrollRef.current?.scrollToEnd({ animated: true });
      });
      noteScrollFrame.current = layoutFrame;
    });
    noteScrollFrame.current = commitFrame;
  }

  function revealSaveError() {
    if (activeField.current === "note" && saveErrorRef.current && saveErrorField.current)
      revealField(saveErrorField.current);
  }

  useEffect(() => {
    const show = Keyboard.addListener("keyboardDidShow", () => {
      if (!mounted.current || !focused.current) return;
      nativeKeyboardReady.current = true;
      setNativeKeyboardOpen(true);
      queueNoteReveal();
      revealSaveError();
    });
    const hide = Keyboard.addListener("keyboardDidHide", () => {
      nativeKeyboardReady.current = false;
      cancelNoteReveal();
      formInsets.current.bottom = 0;
      if (mounted.current) setNativeKeyboardOpen(false);
    });
    const willShow = Keyboard.addListener("keyboardWillShow", () => {
      if (Platform.OS !== "ios" || !mounted.current || !focused.current) return;
      nativeKeyboardReady.current = false;
      cancelNoteScrollFrame();
      setNativeKeyboardOpen(true);
    });
    const willHide = Keyboard.addListener("keyboardWillHide", () => {
      if (Platform.OS !== "ios") return;
      nativeKeyboardReady.current = false;
      cancelNoteReveal();
    });
    const back = BackHandler.addEventListener("hardwareBackPress", () => {
      if (focused.current && datePickerRef.current) {
        datePickerRef.current = false;
        setDatePickerOpen(false);
        return true;
      }
      if (!focused.current || !calculatorRef.current) return false;
      calculatorRef.current = null;
      activeField.current = null;
      amountSelectionIntent.current = false;
      setCalculatorAttempt(null);
      amountRef.current?.blur();
      return true;
    });
    return () => {
      show.remove();
      hide.remove();
      willShow.remove();
      willHide.remove();
      back.remove();
    };
  }, []);

  // D-DEFENSIVE-ARCHIVED-GUARD: D-POST-ARCHIVE-SWITCH should already
  // have moved the user off any archived vault before they can land here,
  // but a remote vault_setting_set arriving via mesh between the home
  // screen's load() and this screen's mount can still drop us into an
  // archived state. Bail to the right place instead of silently writing
  // entries into a tombstone vault (which would be discarded the moment
  // the user sync'd, and is incoherent meanwhile).
  useFocusEffect(
    useCallback(() => {
      focused.current = true;
      cancelNoteReveal();
      const focus = ++focusGeneration.current;
      const attempt = { ...scopeRef.current, focus };
      setFocusVersion(focus);
      setBusy(savingRef.current);
      setLoading(true);
      setPerson(null);
      setCurrencyLinksReady(false);
      saveErrorField.current = null;
      setSaveError(null);
      calculatorRef.current = null;
      activeField.current = null;
      amountSelectionIntent.current = false;
      setCalculatorAttempt(null);
      setCalculatorHistory([]);
      moreOptionsRef.current = false;
      setMoreOptionsOpen(false);
      datePickerRef.current = false;
      setDatePickerOpen(false);
      const unsubscribe = onLedgerApplied((vaultId) => {
        if (vaultId === attempt.vaultId && isCurrent(attempt))
          void refreshEnabledCurrencies(attempt).catch(() => {});
      });
      void (async () => {
        try {
          const guard = await getActiveVaultArchivedState();
          if (!isCurrent(attempt)) return;
          if (guard.state === "none") {
            toast.push(t("entry.noActiveVault"), "error");
            router.replace("/");
            return;
          }
          if (guard.state === "archived") {
            toast.push(t("entry.vaultArchived"), "error");
            router.replace("/vault/archived");
            return;
          }
          if (!attempt.personId) {
            setLoading(false);
            return;
          }
          const currencyKey = JSON.stringify([
            attempt.vaultId,
            attempt.accountId,
            attempt.installId,
            attempt.personId,
            attempt.type,
          ]);
          if (attempt.vaultId && currencyScope.current !== currencyKey) {
            setEntryDay(editingEntry?.created_at ?? null);
            const [defaultCurrency] = await Promise.all([
              editingEntry
                ? Promise.resolve(editingEntry.currency ?? DEFAULT_CURRENCY)
                : getPersonEntryCurrency(attempt.vaultId, attempt.personId),
              refreshEnabledCurrencies(attempt),
            ]);
            if (!isCurrent(attempt)) return;
            const suggestedCurrency =
              !editingEntry && !canWriteSharedTallies(currencyLinksRef.current[defaultCurrency])
                ? enabledCurrencyRef.current.find((code) =>
                    canWriteSharedTallies(currencyLinksRef.current[code]),
                  )
                : undefined;
            setCurrency(suggestedCurrency ?? defaultCurrency);
            currencyScope.current = currencyKey;
          } else await refreshEnabledCurrencies(attempt);
          const p = await getPerson(attempt.personId);
          if (!isCurrent(attempt)) return;
          setPerson(p);
          setLoading(false);
        } catch (err) {
          // A rejected SQLite read must not leave a permanent spinner with no
          // back affordance on this modal — clear loading so the screen renders.
          if (!isCurrent(attempt)) return;
          console.warn("[entry/new] load failed", err);
          setLoading(false);
        }
      })();
      return () => {
        unsubscribe();
        focused.current = false;
        cancelNoteReveal();
        focusGeneration.current++;
        moreOptionsRef.current = false;
        if (mounted.current) setMoreOptionsOpen(false);
        datePickerRef.current = false;
        if (mounted.current) setDatePickerOpen(false);
        calculatorRef.current = null;
        activeField.current = null;
        amountSelectionIntent.current = false;
        if (mounted.current) setCalculatorAttempt(null);
      };
      // A changed route or local identity needs a new scoped read; a completed
      // read from a previous focus must never redirect the newly visible screen.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [personId, type, scope.vaultId, scope.accountId, scope.installId]),
  );

  // Reliable keyboard pop-up on Android — autoFocus on a modally-presented
  // screen fires before the slide-in finishes and the soft keyboard never
  // opens. Defer past the animation; see entry/[id]/edit for the pattern.
  useEffect(() => {
    if (loading || !person || !currencyWritable) return;
    const attempt = { ...scopeRef.current, focus: focusGeneration.current };
    const focusTimer = setTimeout(() => {
      if (initialFocusTimer.current === focusTimer) initialFocusTimer.current = null;
      if (isCurrent(attempt)) measureKeyboardFrame();
      if (isCurrent(attempt) && activeField.current === null && !datePickerRef.current)
        amountRef.current?.focus();
    }, 280);
    initialFocusTimer.current = focusTimer;
    return () => {
      clearTimeout(focusTimer);
      if (initialFocusTimer.current === focusTimer) initialFocusTimer.current = null;
    };
  }, [loading, person, focusVersion, currencyWritable]);

  async function onSave() {
    const attempt = { ...scope, focus: focusGeneration.current };
    if (savingRef.current || !attempt.personId || !isCurrent(attempt) || !isCurrent(renderAttempt))
      return;
    // Evaluate the latest key synchronously. A pending operator or bad result
    // must never save the previous valid preview, even before React repaints.
    const result = evaluateCalculation(calculationRef.current.expression);
    const parsedAmount = result.canApply ? parseAmountInput(result.amount) : null;
    if (parsedAmount === null) {
      setAmountError(t("entry.invalidAmount"));
      return;
    }
    const savedNote = note.trim().slice(0, ENTRY_NOTE_MAX_LENGTH) || null;
    const occurredAtMs =
      entryDay === null
        ? undefined
        : withEntryDay(editingEntry?.created_at ?? Date.now(), entryDay);
    savingRef.current = true;
    setBusy(true);
    saveErrorField.current = null;
    setSaveError(null);
    let session: SessionSnapshot | null = null;
    const present = async (work: () => void) => {
      if (!isCurrent(attempt)) return;
      if (session) {
        await applyForUnchangedLocalSession(session, async () => {
          if (isCurrent(attempt)) work();
        });
      } else work();
    };
    try {
      session = await captureCurrentSession();
      const vaultId = attempt.vaultId;
      if (!vaultId || !isCurrent(attempt) || session.accountId !== attempt.accountId) return;
      // Re-check at save time: the user may have sat on this screen long
      // enough for a mesh-sourced archive event to land. Cheaper than
      // hand-rolling a subscription and good enough for a defensive guard.
      const guard = await getActiveVaultArchivedState();
      if (!isCurrent(attempt)) return;
      if (guard.state === "none") {
        await present(() => {
          toast.push(t("entry.noActiveVault"), "error");
          router.replace("/");
        });
        return;
      }
      if (guard.state === "archived") {
        await present(() => {
          toast.push(t("entry.vaultArchived"), "error");
          router.replace("/vault/archived");
        });
        return;
      }
      const enabled = await getPersonEnabledCurrencies(vaultId, attempt.personId);
      if (!isCurrent(attempt)) return;
      enabledCurrencyRef.current = enabled;
      setEnabledCurrencies(enabled);
      if (!enabled.includes(currency) && currency !== editingEntry?.currency) {
        setSaveError(t("entry.currency.disabled"));
        return;
      }
      const link = await getTabLinkForPerson(attempt.personId, currency);
      if (!isCurrent(attempt)) return;
      const sourceLink =
        editingEntry?.currency && editingEntry.currency !== currency
          ? await getTabLinkForPerson(attempt.personId, editingEntry.currency)
          : link;
      if (!isCurrent(attempt)) return;
      const groupContract =
        !link || !sourceLink
          ? (await listOpenTabLinksForPerson(attempt.personId)).find(
              (candidate) => candidate.group_id,
            )
          : null;
      if (!isCurrent(attempt)) return;
      const currencyPermission = link ?? groupContract;
      const sourcePermission = sourceLink ?? groupContract;
      const blockedLink = !canWriteSharedTallies(currencyPermission)
        ? currencyPermission
        : !canWriteSharedTallies(sourcePermission)
          ? sourcePermission
          : null;
      if (blockedLink) {
        setSaveError(
          t(
            blockedLink.recording_mode === "notify_one_way" && blockedLink.role === "b"
              ? "tab.recordingMode.oneWayReadOnly"
              : "tab.recordingMode.unknown",
          ),
        );
        return;
      }
      if (editingEntry) {
        await updateEntry(editingEntry.id, parsedAmount, savedNote, occurredAtMs, currency, {
          session,
          vaultId,
          original: editingEntry,
          shouldContinue: () => isCurrent(attempt),
        });
        await present(() => {
          noteSavedEntry(attempt.personId, editingEntry.id);
          toast.push(t("entry.updated"), "success");
          router.back();
        });
        return;
      }
      // createEntryDetailed routes a LINKED contact's tally to the mutual tab
      // (docs/mutual-tab-design.md §4.3) with no branching here; the only
      // extra it hands back is the D17 duplicate hint.
      const saved = await createEntryDetailed(
        attempt.personId,
        attempt.type,
        parsedAmount,
        savedNote,
        { session, vaultId, occurredAtMs, currency },
      );
      // A refused clerk tally is not in the ledger; anything else should be
      // visible when the customer's page comes back, filters or not.
      if (saved.admission_status !== "refused") noteSavedEntry(attempt.personId, saved.entry_id);
      // Signed out, a shared tally waits on this phone until sign-in; "Saved"
      // alone hid that it has not reached the other side (audit #24).
      const waitingLink =
        !session.jwt && saved.admission_status == null
          ? await getTabLinkForPerson(attempt.personId, currency).catch(() => null)
          : null;
      let duplicateName: string | null = null;
      if (saved.duplicate_hint && isCurrent(attempt)) {
        // The other party recorded the same transfer within a day. Queued,
        // not pushed: this modal is about to close, and a toast pushed from
        // under it would never be seen (Toast.tsx). It surfaces on the person
        // screen right after the save toast.
        const link = await getTabLinkForPerson(attempt.personId, currency).catch(() => null);
        duplicateName = link?.other_label || t("tab.them");
      }
      await present(() => {
        if (
          saved.admission_status !== "refused" &&
          saved.admission_status !== "pending" &&
          !waitingLink &&
          !saved.duplicate_hint &&
          !saved.credit_warning
        )
          noteReviewableTally(
            {
              installId: attempt.installId,
              accountId: attempt.accountId,
              vaultId: attempt.vaultId,
            },
            saved.entry_id,
          );
        if (saved.admission_status !== "refused") setCurrentCurrency(currency);
        if (waitingLink)
          toast.push(
            t("tab.savedSignIn", { name: waitingLink.other_label || t("tab.them") }),
            "info",
          );
        else
          toast.push(
            t(
              saved.admission_status === "refused"
                ? "credit.blocked"
                : saved.admission_status === "pending"
                  ? // Goods handed over now cannot be taken back if the
                    // server refuses (audit #24).
                    attempt.type === "debt"
                    ? "credit.pendingHold"
                    : "credit.pending"
                  : "entry.saved",
            ),
            saved.admission_status === "refused"
              ? "error"
              : saved.admission_status === "pending"
                ? "info"
                : "success",
          );
        if (saved.credit_warning && !saved.admission_status)
          queuePendingToast(t("credit.warning"), "info");
        if (duplicateName)
          queuePendingToast(t("tab.duplicateHint", { name: duplicateName }), "info");
        router.back();
      });
    } catch (err) {
      // Distinguish "you don't have permission to edit this Kaata"
      // (role-gate refusal — caused by a demotion that landed via
      // mesh/sync between the screen load and the save tap) from a
      // generic storage error. Without this branch the user sees the
      // same generic "couldn't save" copy in both cases and assumes the
      // app is broken, when the real story is "you're now a viewer".
      if (err instanceof SessionChangedError || !isCurrent(attempt)) return;
      let errorKey: Parameters<typeof t>[0];
      if (err instanceof Error && err.name === "CreditMutationAdmissionError") {
        errorKey =
          (err as Error & { status: string }).status === "pending"
            ? "credit.pendingChange"
            : "credit.refusedChange";
      } else if (err instanceof EntryCurrencyBaselineRequiredError) {
        errorKey = "entry.currency.needsSync";
      } else if (err instanceof EntryEditChangedError) {
        errorKey = "entry.edit.changed";
      } else if (err instanceof EntryEditCurrencyDisabledError) {
        errorKey = "entry.currency.disabled";
      } else if (err instanceof SettledChapterError) {
        errorKey = "entry.settledLocked";
      } else if (err instanceof TabLinkedEntryError) {
        errorKey = "tab.editLocked";
      } else if (err instanceof RoleGateRejectionError) {
        errorKey = "entry.roleDenied";
      } else if (err instanceof EventSigningUnavailableError) {
        // Mythos Fix Set C: signing-unavailable gets an actionable message.
        errorKey = "entry.signingUnavailable";
      } else if (err instanceof TabAuthUnavailableError) {
        // Linked contact, signed out, and the party token is gone (reinstall
        // without an account — D10): the phone cannot reach the tab at all.
        errorKey = "tab.needsConnection";
      } else if (err instanceof TabClosedError) {
        // The other side closed the shared account since this screen loaded.
        errorKey = "tab.closed";
      } else if (err instanceof TabPermissionError) {
        errorKey = "entry.roleDenied";
      } else if (err instanceof TabApiError && err.code === "one_way_read_only") {
        errorKey = "tab.recordingMode.oneWayReadOnly";
      } else if (err instanceof TabApiError && err.code === "shared_account_currency_history") {
        errorKey = "tab.group.currencyHistory";
      } else if (err instanceof TabApiError && err.code === "shared_account_pending") {
        errorKey = "tab.group.pending";
      } else if (err instanceof TabApiError && err.code === "shared_account_source_unsynced") {
        errorKey = "tab.group.syncFirst";
      } else if (err instanceof TabApiError && err.code === "shared_history_pending") {
        errorKey = "tab.history.pending";
      } else if (
        err instanceof TabApiError &&
        ["shared_account_unsupported", "multi_currency_tabs_unsupported"].includes(err.code)
      ) {
        errorKey = "tab.link.serverUpdate";
      } else if (err instanceof TabApiError && err.code === "shared_account_upgrade_required") {
        errorKey = "tab.link.clientUpdate";
      } else if (err instanceof TabApiError && err.code === "shared_account_closed") {
        errorKey = "tab.closed";
      } else if (err instanceof TabApiError && err.code === "shared_account_conflict") {
        errorKey = "tab.group.conflict";
      } else if (err instanceof TabApiError && err.code === "shared_account_changed") {
        errorKey = "tab.history.changed";
      } else if (err instanceof TabApiError && err.status === 0) {
        errorKey = "tab.needsConnection";
      } else if (err instanceof TabApiError && err.code === "credit_limit_exceeded") {
        errorKey = "credit.blocked";
      } else if (err instanceof TabInputError) {
        errorKey = "entry.saveFailed";
      } else {
        errorKey = "entry.saveFailed";
      }
      // A failed admission can finish after a same-account sign-in replaced
      // the session, too. Only the original session may paint its error.
      try {
        await present(() => setSaveError(t(errorKey)));
      } catch {
        /* stale session */
      }
    } finally {
      savingRef.current = false;
      // Returning while a durable save is still running keeps double-taps
      // blocked. Its completion releases that busy flag without reviving any
      // expired feedback; a later focus also reads the synchronous flag.
      if (mounted.current && focused.current) setBusy(false);
    }
  }

  function openCalculator() {
    const attempt = { ...scopeRef.current, focus: focusGeneration.current };
    if (
      savingRef.current ||
      !currencyWritable ||
      calculatorRef.current ||
      !isCurrent(attempt) ||
      !isCurrent(renderAttempt)
    )
      return;
    cancelNoteReveal();
    calculatorRef.current = attempt;
    datePickerRef.current = false;
    setDatePickerOpen(false);
    activeField.current = "amount";
    noteRef.current?.blur();
    setCalculatorAttempt(attempt);
    revealAmount();
  }

  function focusNote() {
    const attempt = { ...scopeRef.current, focus: focusGeneration.current };
    if (savingRef.current || !currencyWritable || !isCurrent(attempt) || !isCurrent(renderAttempt))
      return;
    // Keypad Next also triggers onFocus. One focus creates only one request,
    // including after that request has already completed or been cancelled.
    if (activeField.current === "note") return;
    cancelNoteReveal();
    if (initialFocusTimer.current !== null) {
      clearTimeout(initialFocusTimer.current);
      initialFocusTimer.current = null;
    }
    noteScrollRequest.current = attempt;
    activeField.current = "note";
    datePickerRef.current = false;
    setDatePickerOpen(false);
    amountSelectionIntent.current = false;
    calculatorRef.current = null;
    setCalculatorAttempt(null);
    measureKeyboardFrame();
    noteRef.current?.focus();
    // A still-visible keyboard needs no new did-show event on genuine refocus.
    queueNoteReveal();
  }

  function dismissCalculator() {
    const attempt = calculatorRef.current;
    if (
      !attempt ||
      attempt !== calculatorAttempt ||
      !isCurrent(attempt) ||
      !isCurrent(renderAttempt)
    )
      return;
    cancelNoteReveal();
    if (initialFocusTimer.current !== null) {
      clearTimeout(initialFocusTimer.current);
      initialFocusTimer.current = null;
    }
    calculatorRef.current = null;
    activeField.current = null;
    amountSelectionIntent.current = false;
    setCalculatorAttempt(null);
    amountRef.current?.blur();
  }

  const renderAttempt = { ...scope, focus: focusGeneration.current };
  function toggleMoreOptions() {
    if (savingRef.current || !isCurrent(renderAttempt)) return;
    cancelNoteReveal();
    if (initialFocusTimer.current !== null) {
      clearTimeout(initialFocusTimer.current);
      initialFocusTimer.current = null;
    }
    calculatorRef.current = null;
    setCalculatorAttempt(null);
    activeField.current = null;
    amountSelectionIntent.current = false;
    amountRef.current?.blur();
    noteRef.current?.blur();
    Keyboard.dismiss();
    datePickerRef.current = false;
    setDatePickerOpen(false);
    moreOptionsRef.current = !moreOptionsRef.current;
    setMoreOptionsOpen(moreOptionsRef.current);
  }

  function toggleDatePicker() {
    if (!isCurrent(renderAttempt) || !moreOptionsRef.current) return;
    cancelNoteReveal();
    if (datePickerRef.current) {
      datePickerRef.current = false;
      setDatePickerOpen(false);
      return;
    }
    if (savingRef.current) return;
    if (initialFocusTimer.current !== null) {
      clearTimeout(initialFocusTimer.current);
      initialFocusTimer.current = null;
    }
    calculatorRef.current = null;
    setCalculatorAttempt(null);
    activeField.current = null;
    amountSelectionIntent.current = false;
    amountRef.current?.blur();
    noteRef.current?.blur();
    Keyboard.dismiss();
    datePickerRef.current = !datePickerRef.current;
    setDatePickerOpen(datePickerRef.current);
  }

  function armAmountSelection() {
    if (savingRef.current || !isCurrent(renderAttempt)) return;
    amountSelectionIntent.current = true;
  }

  function changeCalculation(
    next: CalculatorDraft,
    source: "programmatic" | "native" | "selection" = "programmatic",
  ) {
    if (!isCurrent(renderAttempt) || savingRef.current) return;
    // Android can echo an old controlled cursor after newer keypad edits.
    // Only direct input interaction may take cursor ownership back. Keep that
    // intent across native selection dragging and paste/cut follow-up events.
    if (source !== "selection") amountSelectionIntent.current = source === "native";
    calculationRef.current = next;
    setCalculation(next);
    setAmountError(null);
    saveErrorField.current = null;
    setSaveError(null);
  }

  let calculationHint: string | null = null;
  if (calculationResult.status === "error")
    calculationHint = t(
      calculationResult.code === "division_by_zero"
        ? "calculator.divisionByZero"
        : calculationResult.code === "too_complex"
          ? "calculator.tooComplex"
          : calculationResult.code === "overflow"
            ? "calculator.tooLarge"
            : "calculator.invalid",
    );
  else if (calculationResult.status === "valid" && !calculationResult.canApply)
    calculationHint = t(
      calculationResult.applyError === "non_positive"
        ? "calculator.positiveAmount"
        : "calculator.tooLarge",
    );
  else if (calculationResult.status === "incomplete" && calculation.expression)
    calculationHint = t("calculator.incomplete");
  else if (calculationResult.status === "valid" && calculationResult.rounded)
    calculationHint = t("calculator.rounded");

  // Derived above the load branches on purpose: the verb comes from the route
  // param, not from the person, so the loading header can already show the
  // final title and nothing moves when the read resolves.
  const action = type === "debt" ? t("person.action.iGave") : t("person.action.iReceived");
  const verb = editingEntry ? t("entry.edit.title", { verb: action }) : action;

  if (loading) {
    return (
      <ScreenLoading title={verb} onBack={() => router.back()} isRTL={isRTL} edges={MODAL_EDGES} />
    );
  }

  if (!person) {
    // Not-found still needs a way OUT — this is a modal screen, and without
    // a header the only escape is hardware back (which iOS doesn't have).
    return (
      <ScreenLoading
        title={verb}
        onBack={() => router.back()}
        isRTL={isRTL}
        message={t("personAdd.personNotFound")}
        edges={MODAL_EDGES}
      />
    );
  }

  const noteKeyboardShown =
    Platform.OS === "ios" && nativeKeyboardOpen && activeField.current === "note";
  const saveBar = (
    <View
      style={styles.saveBar}
      onLayout={(event) => {
        const { height } = event.nativeEvent.layout;
        if (height > 0) setSaveBarHeight(height);
      }}
    >
      <Button
        label={t(editingEntry ? "entry.saveChanges" : "entry.save")}
        onPress={onSave}
        loading={busy}
        disabled={!calculationResult.canApply || !currencyWritable}
        fullWidth
      />
    </View>
  );

  return (
    <SafeAreaView
      style={styles.container}
      edges={Platform.OS === "ios" || nativeKeyboardOpen ? ["top", "left", "right"] : MODAL_EDGES}
    >
      {/* The "Cancel" word becomes the shared chevron; it survives as the a11y
          label so TalkBack still announces "Cancel", not "Back". */}
      <ScreenHeader
        title={verb}
        onBack={() => router.back()}
        isRTL={isRTL}
        backLabel={t("common.cancel")}
      />

      <View
        ref={keyboardFrameRef}
        collapsable={false}
        style={styles.keyboardAvoider}
        onLayout={(event) => {
          measureKeyboardFrame();
          setAvailableHeight(event.nativeEvent.layout.height);
        }}
      >
        <KeyboardAvoidingView
          style={styles.keyboardAvoider}
          behavior="height"
          enabled={avoidAndroidKeyboard}
          keyboardVerticalOffset={keyboardOffset}
        >
          <Pressable
            style={styles.form}
            accessible={false}
            focusable={false}
            disabled={!calculatorAttempt}
            onPress={dismissCalculator}
          >
            <ScrollView
              ref={scrollRef}
              style={styles.form}
              contentContainerStyle={[
                styles.body,
                { paddingBottom: 16 + (noteKeyboardShown ? 0 : dockHeight) },
              ]}
              // Native keyboard dismissal only knows about Note. Let blank
              // amount-keyboard taps reach the surrounding dismiss target.
              keyboardShouldPersistTaps={calculatorAttempt ? "always" : "handled"}
              bounces={false}
              alwaysBounceVertical={false}
              overScrollMode="never"
              automaticallyAdjustKeyboardInsets={Platform.OS === "ios"}
              onContentSizeChange={() => {
                revealSaveError();
              }}
              onScrollBeginDrag={cancelNoteReveal}
              onScroll={(event) => {
                formScrollY.current = event.nativeEvent.contentOffset.y;
                formInsets.current = {
                  top: event.nativeEvent.contentInset?.top ?? 0,
                  bottom: event.nativeEvent.contentInset?.bottom ?? 0,
                };
              }}
              scrollEventThrottle={16}
              onLayout={(event) => {
                formViewport.current = event.nativeEvent.layout.height;
                if (activeField.current === "amount") revealAmount();
                revealSaveError();
              }}
            >
              <View style={styles.context}>
                <Text style={[styles.contextLabel, textDir(isRTL), trackingSafe(isRTL)]}>
                  {type === "debt" ? t("entry.context.to") : t("entry.context.from")}
                </Text>
                <Text style={[styles.contextName, textDir(isRTL)]}>{person.name}</Text>
                {!currencyWritable ? (
                  <Text accessibilityRole="alert" style={[styles.calculationHint, textDir(isRTL)]}>
                    {t(
                      blockedCurrencyLink?.recording_mode === "notify_one_way" &&
                        blockedCurrencyLink.role === "b"
                        ? "tab.recordingMode.oneWayReadOnly"
                        : "tab.recordingMode.unknown",
                    )}
                  </Text>
                ) : null}
              </View>

              <View
                onLayout={(event) => {
                  amountField.current = event.nativeEvent.layout;
                  if (activeField.current === "amount") revealAmount();
                }}
              >
                <View style={[styles.amountHeader, rowDir(isRTL)]}>
                  <Text style={[styles.label, { flex: 1, marginBottom: 0 }, textDir(isRTL)]}>
                    {t("entry.amount.labelTemplate", { code: getCurrencyLabel(currency) })}{" "}
                    <Text style={styles.required}>*</Text>
                  </Text>
                </View>
                <View style={[styles.amountCard, amountError ? styles.inputError : null]}>
                  <View style={styles.expressionRow}>
                    <TextInput
                      ref={amountRef}
                      style={styles.amountInput}
                      value={calculation.expression}
                      selection={calculation.selection}
                      onChangeText={(raw) => changeCalculation(calculatorDraft(raw), "native")}
                      onSelectionChange={(event) => {
                        if (!amountSelectionIntent.current || activeField.current !== "amount")
                          return;
                        const { start, end } = event.nativeEvent.selection;
                        const next = selectCalculation(calculationRef.current, start, end);
                        if (
                          next.selection.start !== calculationRef.current.selection.start ||
                          next.selection.end !== calculationRef.current.selection.end
                        )
                          changeCalculation(next, "selection");
                      }}
                      onFocus={() => {
                        armAmountSelection();
                        openCalculator();
                      }}
                      onBlur={() => {
                        amountSelectionIntent.current = false;
                      }}
                      onKeyPress={armAmountSelection}
                      onPressIn={() => {
                        armAmountSelection();
                        if (activeField.current === "note") {
                          noteRef.current?.blur();
                          Keyboard.dismiss();
                        }
                        openCalculator();
                      }}
                      showSoftInputOnFocus={false}
                      autoCorrect={false}
                      spellCheck={false}
                      autoCapitalize="none"
                      editable={!busy && currencyWritable}
                      placeholder="0"
                      placeholderTextColor={colors.textMuted}
                      inputMode="none"
                      // Validate the amount instead of truncating pasted extra digits
                      // with maxLength, which could silently change a financial value.
                      accessibilityLabel={t("entry.amount.labelTemplate", {
                        code: getCurrencyLabel(currency),
                      })}
                      returnKeyType="next"
                      onSubmitEditing={focusNote}
                      submitBehavior="submit"
                    />
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={t("calculator.delete")}
                      disabled={busy}
                      onPress={() =>
                        changeCalculation(calculatorKey(calculationRef.current, "delete"))
                      }
                      onLongPress={() =>
                        changeCalculation(calculatorKey(calculationRef.current, "AC"))
                      }
                      style={styles.amountDelete}
                    >
                      <Ionicons name="backspace-outline" size={22} color={colors.textMuted} />
                    </Pressable>
                  </View>
                  <View style={styles.calculatedRow}>
                    <CurrencySelector
                      key={JSON.stringify(renderAttempt)}
                      compact
                      symbolOnly
                      value={currency}
                      allowedCurrencies={
                        editingEntry?.currency && !enabledCurrencies.includes(editingEntry.currency)
                          ? [...enabledCurrencies, editingEntry.currency]
                          : enabledCurrencies
                      }
                      disabled={busy || !isCurrent(renderAttempt) || enabledCurrencies.length === 0}
                      onOpen={() => {
                        if (savingRef.current || !isCurrent(renderAttempt)) return false;
                        if (initialFocusTimer.current !== null) {
                          clearTimeout(initialFocusTimer.current);
                          initialFocusTimer.current = null;
                        }
                        calculatorRef.current = null;
                        cancelNoteReveal();
                        setCalculatorAttempt(null);
                        datePickerRef.current = false;
                        setDatePickerOpen(false);
                        activeField.current = null;
                        amountSelectionIntent.current = false;
                        amountRef.current?.blur();
                        noteRef.current?.blur();
                        Keyboard.dismiss();
                      }}
                      onChange={(code) => {
                        if (
                          savingRef.current ||
                          !isCurrent(renderAttempt) ||
                          (!enabledCurrencyRef.current.includes(code) &&
                            code !== editingEntry?.currency)
                        )
                          return;
                        setSaveError(null);
                        setCurrency(code);
                      }}
                    />
                    <Text
                      testID="entry-calculation-result"
                      accessible={hasCalculationPreview}
                      accessibilityLabel={
                        hasCalculationPreview ? t("calculator.result") : undefined
                      }
                      style={styles.calculatedValue}
                      numberOfLines={1}
                      adjustsFontSizeToFit
                    >
                      {hasCalculationPreview ? `= ${calculationResult.display ?? "0"}` : ""}
                    </Text>
                  </View>
                </View>
                {editingEntry && currency !== editingEntry.currency ? (
                  <Text style={[styles.calculationHint, textDir(isRTL)]}>
                    {t("entry.currency.editHint")}
                  </Text>
                ) : null}
                {currencyNeedsPrecisionHint(currency) ? (
                  <Text style={[styles.calculationHint, textDir(isRTL)]}>
                    {t("currency.precisionHint")}
                  </Text>
                ) : null}
                {calculationHint && !amountError ? (
                  <Text
                    style={[
                      styles.calculationHint,
                      calculationResult.status === "error" && styles.errorText,
                      textDir(isRTL),
                    ]}
                    accessibilityLiveRegion="polite"
                  >
                    {calculationHint}
                  </Text>
                ) : null}
                {amountError ? (
                  <Text
                    style={[styles.fieldError, textDir(isRTL)]}
                    accessibilityLiveRegion="polite"
                  >
                    {amountError}
                  </Text>
                ) : overLimit ? (
                  <Text
                    style={[styles.creditHint, textDir(isRTL)]}
                    accessibilityLiveRegion="polite"
                  >
                    {t("credit.warning")}
                  </Text>
                ) : null}
              </View>

              <View>
                <Text style={[styles.label, textDir(isRTL)]}>{t("entry.note.label")}</Text>
                <TextInput
                  ref={noteRef}
                  editable={!busy && currencyWritable}
                  style={[
                    styles.noteInput,
                    { minHeight: noteMinHeight, maxHeight: noteMaxHeight },
                    Platform.OS === "ios" && { height: noteMinHeight },
                    textDir(isRTL),
                  ]}
                  value={note}
                  onFocus={focusNote}
                  onBlur={() => {
                    cancelNoteReveal();
                    if (activeField.current === "note") activeField.current = null;
                  }}
                  onChangeText={(text) => {
                    cancelNoteReveal();
                    setNote(text);
                  }}
                  placeholder={t("entry.note.placeholder")}
                  placeholderTextColor={colors.textMuted}
                  maxLength={ENTRY_NOTE_MAX_LENGTH}
                  accessibilityLabel={t("entry.note.label")}
                  inputAccessoryViewID={Platform.OS === "ios" ? noteAccessoryId : undefined}
                  multiline
                  keyboardType="default"
                  inputMode="text"
                  submitBehavior="newline"
                  scrollEnabled
                />
              </View>
              <Pressable
                testID="entry-more-options"
                accessibilityRole="button"
                accessibilityLabel={t(moreOptionsOpen ? "entry.more.hide" : "entry.more.show")}
                accessibilityState={{ expanded: moreOptionsOpen, disabled: busy }}
                disabled={busy}
                onPress={toggleMoreOptions}
                style={({ pressed }) => [
                  styles.moreOptions,
                  rowDir(isRTL),
                  pressed && { opacity: 0.6 },
                  busy && { opacity: 0.4 },
                ]}
              >
                <Text style={[styles.moreOptionsText, textDir(isRTL)]}>
                  {t(moreOptionsOpen ? "entry.more.hide" : "entry.more.show")}
                </Text>
                <Ionicons
                  name={moreOptionsOpen ? "chevron-up" : "chevron-down"}
                  size={16}
                  color={colors.textSubtle}
                />
              </Pressable>
              {moreOptionsOpen ? (
                <EntryDateField
                  value={entryDay ?? localDayStart(Date.now())}
                  expanded={datePickerOpen}
                  disabled={busy}
                  onToggle={toggleDatePicker}
                  onChange={(day) => {
                    if (
                      savingRef.current ||
                      !isCurrent(renderAttempt) ||
                      !moreOptionsRef.current ||
                      !datePickerRef.current
                    )
                      return;
                    setEntryDay(day);
                  }}
                />
              ) : null}
              {saveError ? (
                <Text
                  style={[styles.fieldError, textDir(isRTL)]}
                  accessibilityLiveRegion="polite"
                  onLayout={(event) => {
                    if (!saveErrorRef.current || !isCurrent(renderAttempt)) return;
                    saveErrorField.current = event.nativeEvent.layout;
                    revealSaveError();
                  }}
                >
                  {saveError}
                </Text>
              ) : null}
            </ScrollView>
          </Pressable>
          {/* Keep the calculator out of the viewport's layout. Native caret
              scrolling and iOS keyboard insets must see the full frame when
              Note receives focus, before React closes the calculator. */}
          <View
            style={[
              styles.dock,
              styles.dockOverlay,
              Platform.OS === "ios" && {
                paddingBottom: noteKeyboardShown ? 0 : safeArea.bottom,
              },
            ]}
            pointerEvents={noteKeyboardShown ? "none" : "auto"}
            onLayout={(event) => {
              const { height } = event.nativeEvent.layout;
              dockHeightRef.current = height;
              setDockHeight(height);
              if (activeField.current === "amount") revealAmount();
            }}
          >
            {noteKeyboardShown ? null : saveBar}
            <EntryCalculator
              key={focusVersion}
              draft={calculation}
              getDraft={() => calculationRef.current}
              onChange={(next) => {
                if (calculatorAttempt && calculatorRef.current === calculatorAttempt)
                  changeCalculation(next);
              }}
              disabled={busy}
              availableHeight={
                Platform.OS === "ios" && availableHeight !== undefined
                  ? Math.max(0, availableHeight - safeArea.bottom)
                  : availableHeight
              }
              footerHeight={saveBarHeight}
              visible={Boolean(calculatorAttempt)}
              history={calculatorHistory}
              onRecord={(record) => {
                if (
                  !savingRef.current &&
                  calculatorAttempt &&
                  calculatorRef.current === calculatorAttempt &&
                  isCurrent(calculatorAttempt)
                )
                  setCalculatorHistory((history) => rememberCalculation(history, record));
              }}
              onClearHistory={() => {
                if (
                  !savingRef.current &&
                  calculatorAttempt &&
                  calculatorRef.current === calculatorAttempt &&
                  isCurrent(calculatorAttempt)
                )
                  setCalculatorHistory([]);
              }}
              onNext={() => {
                if (calculatorAttempt && calculatorRef.current === calculatorAttempt) focusNote();
              }}
            />
          </View>
        </KeyboardAvoidingView>
      </View>
      {/* Mount before Note is focused so UIKit can attach it to that input.
          Only Save is in the accessory; the multiline Note stays in the form.
          UIKit keeps this toolbar above every native keyboard frame. */}
      {Platform.OS === "ios" ? (
        <InputAccessoryView nativeID={noteAccessoryId} backgroundColor={colors.bgDefault}>
          {saveBar}
        </InputAccessoryView>
      ) : null}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  amountHeader: { alignItems: "center", gap: 12, marginBottom: 8 },
  container: { flex: 1, backgroundColor: colors.bgDefault },
  keyboardAvoider: { flex: 1 },
  form: { flex: 1 },
  dock: { flexShrink: 0, backgroundColor: colors.bgDefault },
  dockOverlay: { position: "absolute", bottom: 0, left: 0, right: 0 },
  saveBar: {
    width: "100%",
    maxWidth: 640,
    alignSelf: "center",
    paddingHorizontal: 16,
    paddingTop: 10,
    paddingBottom: 10,
    borderTopWidth: 1,
    borderColor: colors.borderSubtle,
    gap: 8,
  },
  // Intrinsic height is essential: stretching this to the viewport would
  // turn iOS's native keyboard inset into a long, empty scrollable tail.
  body: { width: "100%", maxWidth: 640, alignSelf: "center", padding: 16, gap: 16 },
  context: { gap: 4 },
  contextLabel: {
    fontSize: 11,
    lineHeight: sansLineHeight(11, 16),
    fontFamily: fonts.sansSemi,
    color: colors.textSubtle,
    textTransform: "uppercase",
    letterSpacing: 0.6,
  },
  // 18 → typography.heading (20). 18 was an orphan sitting 2px under `heading`;
  // this line names the person the tally is being written against, which is the
  // same rank of statement as person detail's name — so both now land on the
  // same step. Bold is preserved over heading's sansSemi (same override idiom as
  // Button's `textPill`) because the whole context block is label-then-name and
  // the weight is what separates them.
  contextName: {
    ...typography.heading,
    fontFamily: fonts.sansBold,
    color: colors.textEmphasis,
  },
  label: {
    fontSize: 13,
    lineHeight: sansLineHeight(13, 20),
    fontFamily: fonts.sansMedium,
    color: colors.textDefault,
    marginBottom: 8,
  },
  moreOptions: {
    minHeight: TOUCH_MIN,
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    paddingVertical: 8,
  },
  moreOptionsText: {
    ...typography.bodySm,
    fontFamily: fonts.sansMedium,
    color: colors.textSubtle,
    flexShrink: 1,
  },
  required: { color: colors.danger },
  amountCard: {
    borderWidth: 1,
    borderColor: colors.borderDefault,
    borderRadius: radius.md,
    backgroundColor: colors.bgDefault,
    overflow: "hidden",
    direction: "ltr",
  },
  expressionRow: { flexDirection: "row", direction: "ltr", alignItems: "center" },
  amountDelete: {
    minHeight: TOUCH_MIN,
    minWidth: TOUCH_MIN,
    alignItems: "center",
    justifyContent: "center",
    marginRight: 4,
  },
  calculatedRow: {
    flexDirection: "row",
    direction: "ltr",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
    borderTopWidth: 1,
    borderColor: colors.borderSubtle,
    marginHorizontal: 14,
    paddingVertical: 8,
  },
  calculatedValue: {
    flex: 1,
    minWidth: 0,
    flexShrink: 1,
    fontFamily: fonts.monoMedium,
    fontSize: 17,
    lineHeight: sansLineHeight(17, 25),
    minHeight: sansLineHeight(17, 25),
    color: colors.textEmphasis,
    textAlign: "right",
    writingDirection: "ltr",
  },
  calculationHint: {
    fontFamily: fonts.sansRegular,
    fontSize: 12,
    lineHeight: sansLineHeight(12, 18),
    marginTop: 6,
    color: colors.textSubtle,
  },
  errorText: { color: colors.danger },
  noteInput: {
    borderWidth: 1,
    borderColor: colors.borderDefault,
    borderRadius: radius.md,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 15,
    lineHeight: sansLineHeight(15, 22),
    textAlignVertical: "top",
    overflow: "hidden",
    fontFamily: fonts.sansRegular,
    color: colors.textEmphasis,
    backgroundColor: colors.bgDefault,
  },
  amountInput: {
    flex: 1,
    minWidth: 0,
    minHeight: 64,
    paddingHorizontal: 14,
    paddingVertical: 10,
    fontSize: 28,
    fontFamily: fonts.monoBold,
    color: colors.textEmphasis,
    backgroundColor: colors.bgDefault,
    textAlign: "left",
    writingDirection: "ltr",
  },
  // Mirrors FormField's error treatment so inline errors look the same
  // whether a screen uses the shared component or a custom input.
  inputError: {
    borderColor: colors.danger,
    backgroundColor: "rgba(220, 38, 38, 0.04)",
  },
  fieldError: {
    fontSize: 12,
    fontFamily: fonts.sansMedium,
    color: colors.danger,
    marginTop: 6,
  },
  creditHint: {
    fontSize: 12,
    fontFamily: fonts.sansMedium,
    color: colors.reviewPending,
    marginTop: 6,
  },
});
