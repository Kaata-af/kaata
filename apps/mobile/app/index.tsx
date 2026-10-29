import type { ScrollViewInstance, TextInputInstance, ViewInstance } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import { BlurTargetView } from "expo-blur";
import { Redirect, useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Animated,
  AppState,
  BackHandler,
  Image,
  Keyboard,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import { BottomSheet } from "../components/BottomSheet";
import { CustomerListOptions } from "../components/CustomerListSheet";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { Button } from "../components/Button";
import { EmptyState } from "../components/EmptyState";
import { InitialAvatar } from "../components/InitialAvatar";
import { NotificationBell } from "../components/NotificationInbox";
import { PersonRow } from "../components/PersonRow";
import { HomeBalanceSummary } from "../components/HomeBalanceSummary";
import { HomeBalanceFilterSwipe } from "../components/HomeBalanceFilterSwipe";
import { SettledAccountsSection } from "../components/SettledAccountsSection";
import {
  HomeFilterPopover,
  type FilterAnchor,
  type FilterViewport,
} from "../components/HomeFilterPopover";
import { SelectionToolbar } from "../components/SelectionToolbar";
import { SearchKeyboardFrame, SearchKeyboardFooter } from "../components/SearchKeyboardMotion";
import {
  currencyBalances,
  personCurrencyRows,
  selectedPeopleByCurrency,
} from "../lib/multi-currency-view";
import type { VaultListItem } from "../components/ProfileSettingsSheet";
import { ProfileSettingsSource } from "../lib/profile-settings-context";
import { TOAST_LIFT, useToast, useToastOffset } from "../components/Toast";
import { UpdateBanner } from "../components/UpdateBanner";
import { useAppMeta } from "../lib/app-meta-context";
import { colors } from "../lib/colors";
import { splitSearchQuery } from "../lib/contacts-merge";
import { searchCustomerMatches } from "../lib/search";
import {
  applyVaultCurrency,
  getCurrentCurrencyCode,
  getCurrencyLabel,
  getEnabledCurrencies,
  useCurrency,
} from "../lib/currency";
import { VaultPickerSheet } from "../components/VaultPickerSheet";
import { getSessionUser, type SessionUser, signOut } from "../lib/auth";
import {
  archivePerson,
  getActiveVaultArchivedAt,
  getActiveVaultArchivedState,
  getAppMeta,
  getLocalSelf,
  listActiveVaults,
  listAllPeopleForSearch,
  type CurrencyBalanceSummary,
  listAllVaultsIncludingArchived,
  setAppMeta,
} from "../lib/db";
import {
  clearActiveVaultId,
  getAccountIdSync,
  getActiveVaultId,
  getActiveVaultIdSyncMaybe,
  getInstallIdSync,
  onAccountIdentityChanged,
  setActiveVaultId,
} from "../lib/db-tx";
import { readCustomerGroups, type CustomerGroup } from "../lib/customer-groups";
import {
  availableCustomerGroupFilter,
  availableCustomerCurrencyFilter,
  DEFAULT_CUSTOMER_LIST,
  parseHomeCustomerListPreference,
  selectSearchCustomers,
  selectedCustomerGroupIds,
  selectedCustomerCurrencyCodes,
  type CustomerBalanceFilter,
  type CustomerListPreference,
} from "../lib/customer-list";
import {
  creditStatusForBalance,
  readCreditPoliciesForPeople,
  refreshCreditPolicies,
  type CreditPolicy,
} from "../lib/credit-limits";
import { onCreditPoliciesChanged } from "../lib/credit-policy-events";
import type { CreditStatus } from "../components/CreditStatusBadge";
import { useLedgerRefresh } from "../lib/ledger-events";
import { rowDir, textDir, useIsRTL } from "../lib/direction";
import { fonts, sansLineHeight } from "../lib/fonts";
import { getLocale, t } from "../lib/i18n";
import { icon, typography } from "../lib/tokens";
import { useActiveVaultWriteCaps } from "../lib/use-vault-role";
import {
  shouldPromptBatteryExemption,
  markBatteryExemptionPrompted,
  requestBatteryExemption,
  isIgnoringBatteryOptimizations,
  shouldPromptOemAutostart,
  markOemAutostartPrompted,
  openOemAutostartSettings,
} from "../lib/battery-exemption";
import type { PersonWithBalance, Self } from "../lib/types";
import { personSharedAccountStatus } from "../lib/tabs/link-status";
import { useStoreReviewPrompt } from "../lib/use-store-review-prompt";
import { isSettledCustomer } from "../lib/settled-customers";

// Header profile-slot diameter. One constant for ALL THREE variants (Google
// photo, initial-letter chip, signed-out icon) so the top-right chrome never
// changes size with auth state. 36 (up from 32): the old 32px slot read
// undersized against the large-title header — most visibly on iPhones, where
// Apple sign-in has no photo URL so the letter chip is the steady state.
const PROFILE_SLOT_SIZE = 36;

// Keep the add button at the 52px action height used by the other docks.
const FAB_SIZE = 52;
// Keep an opaque surface below the raised controls so taps cannot reach
// customers through the space where the footer normally sits.
const HOME_DOCK_SKIRT = TOAST_LIFT + 12;
const EMPTY_PEOPLE: PersonWithBalance[] = [];
const EMPTY_CURRENCIES: string[] = [];
const EMPTY_SEARCH_RELEVANCE = new Map<string, number>();

/**
 * ONE sync toggle: enabling Nearby sync also turns on the native background
 * engine (there is no foreground-only sync — sync IS background sync). Sets the
 * bg-mesh + native-engine flags (JS app_meta + native SharedPrefs, both persist)
 * and injects the device seed so the resident native engine can sign post-kill.
 * Idempotent + best-effort; never throws into the toggle path.
 */
async function applyFullSync(enabled: boolean): Promise<void> {
  try {
    await setAppMeta("bg_mesh_enabled", enabled ? "1" : "0");
    await setAppMeta("native_engine_enabled", enabled ? "1" : "0");
    const bt = await import("../modules/kaata-bt-classic");
    await bt.setBgMeshEnabled(enabled);
    await bt.setNativeEngineEnabled(enabled);
    if (enabled) {
      const { ensureDeviceKey, getDeviceSeedB64 } = await import("../lib/mesh/device-key");
      await ensureDeviceKey();
      const seed = await getDeviceSeedB64();
      if (seed) await bt.setMeshDeviceSeed(seed);
    }
    const { reconcileBgCatchup } = await import("../lib/mesh/bg-task");
    await reconcileBgCatchup();
  } catch (err) {
    if (__DEV__) console.warn("[home] applyFullSync failed", err);
  }
}

export default function HomeScreen() {
  const router = useRouter();
  const toast = useToast();
  const toastOffset = useToastOffset(12);
  // Phase 5.1: ?menu=sync deep-link from the foreground-service notification
  // tap auto-opens the hamburger menu on focus. We don't currently scroll
  // to the Sync section — every section is on a single sheet, so opening
  // the sheet is enough.
  const params = useLocalSearchParams<{ menu?: string }>();
  const insets = useSafeAreaInsets();
  const { forceUpdate } = useAppMeta();
  // Subscribes to locale changes — flipping language in Settings re-renders
  // this screen (and all its children) without an app restart. Strings via
  // t() refresh on the same render.
  const isRTL = useIsRTL();

  const selectedCurrency = useCurrency();
  const [self, setSelf] = useState<Self | null>(null);
  const [summarySnapshot, setSummarySnapshot] = useState<{
    vaultId: string | null;
    accountId: string | null;
    balances: CurrencyBalanceSummary[];
  } | null>(null);
  const [keyboardShown, setKeyboardShown] = useState(false);
  const [searchFocused, setSearchFocused] = useState(false);
  // Android's native resize precedes did-show; prepare its controls on focus.
  // iOS movement is driven by native keyboard progress, not these UI flags.
  const keyboardLayoutShown = keyboardShown || (Platform.OS === "android" && searchFocused);
  const searchInputRef = useRef<TextInputInstance>(null);
  const overlaySurfaceRef = useRef<ViewInstance>(null);
  const filterBlurTargetRef = useRef<ViewInstance>(null);
  const filterTriggerRef = useRef<ViewInstance>(null);
  const filterMeasureVersion = useRef(0);
  const [filterAnchor, setFilterAnchor] = useState<FilterAnchor | null>(null);
  const [filterViewport, setFilterViewport] = useState<FilterViewport>({ width: 0, height: 0 });
  const [allPeople, setAllPeople] = useState<PersonWithBalance[]>([]);
  const [peopleScope, setPeopleScope] = useState<{
    vaultId: string | null;
    accountId: string | null;
    currency: string;
    currencies: string[];
  } | null>(null);
  const [customerQuery, setCustomerQuery] = useState("");
  const [filtersExpanded, setFiltersExpanded] = useState(false);
  const filtersExpandedRef = useRef(filtersExpanded);
  filtersExpandedRef.current = filtersExpanded;
  const homeGeneration = useRef(0);
  const homeRequest = homeGeneration.current;
  useEffect(() => {
    homeGeneration.current++;
    setFiltersExpanded(false);
    filterMeasureVersion.current++;
    setFilterAnchor(null);
  }, [selectedCurrency]);
  const dismissKeyboard = useCallback(() => {
    searchInputRef.current?.blur();
    setSearchFocused(false);
    Keyboard.dismiss();
  }, []);
  const [customerGroups, setCustomerGroups] = useState<CustomerGroup[]>([]);
  const [groupByPerson, setGroupByPerson] = useState<Record<string, string[]>>({});
  const [savedListPreference, setListPreference] =
    useState<CustomerListPreference>(DEFAULT_CUSTOMER_LIST);
  const [creditByCurrency, setCreditByCurrency] = useState<
    Record<string, Record<string, CreditStatus>>
  >({});
  const preferenceVersion = useRef(0),
    loadGeneration = useRef(0);
  const locale = getLocale();
  const [sheetFor, setSheetFor] = useState<PersonWithBalance | null>(null);
  const [confirmDeleteFor, setConfirmDeleteFor] = useState<PersonWithBalance | null>(null);
  const singleDeleteRef = useRef(confirmDeleteFor);
  singleDeleteRef.current = confirmDeleteFor;
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedPersonIds, setSelectedPersonIds] = useState<string[]>([]);
  const [confirmRemoveIds, setConfirmRemoveIds] = useState<string[] | null>(null);
  const confirmingIdsRef = useRef(confirmRemoveIds);
  confirmingIdsRef.current = confirmRemoveIds;
  const selectionConfirmationVersion = useRef(0);
  const [selectionBusy, setSelectionBusy] = useState(false);
  const selectionBusyRef = useRef(false);
  const selectionGeneration = useRef(0);
  const selectionOwnerActive = useRef(false);
  const closeSelection = useCallback(() => {
    if (selectionBusyRef.current) return;
    selectionConfirmationVersion.current++;
    selectionGeneration.current++;
    setSelectionMode(false);
    setSelectedPersonIds([]);
    setConfirmRemoveIds(null);
  }, []);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState(false);
  // Phase 7: unified settings sheet — replaces the hamburger AND the
  // old ProfileMenuSheet. One state flag, one entry point on the profile
  // chip top-RIGHT. sessionUser is read on focus so it stays in sync with
  // sign-in/out actions taken on the Account screen. The full user object
  // is kept (not just the email) so the header icon can render the user's
  // actual Google avatar when picture_url is set.
  const [settingsVisible, setSettingsVisible] = useState(false);
  const [notificationInboxVisible, setNotificationInboxVisible] = useState(false);
  const profileOpening = useRef(false);
  const [sessionUser, setSessionUser] = useState<SessionUser | null>(null);
  // Phase 7 D-TOP-LEFT-SWITCHER — VaultPickerSheet opens on shop-name tap
  // in the header. Mutually exclusive with menuVisible + profileMenuVisible
  // (the same Android Modal-stacking trap that BottomSheet's 220ms defer
  // guards against, but here we prevent it by ensuring only one sheet is
  // ever asked to render at a time).
  const [vaultPickerVisible, setVaultPickerVisible] = useState(false);
  const [activeVaultId, setActiveVaultIdState] = useState<string | null>(null);
  const [activeAccountId, setActiveAccountId] = useState<string | null>(null);
  // Viewer read-only gate: false only when I'm a viewer on the active (shared)
  // vault. Hides write affordances (long-press edit/delete). Defaults true
  // for local-only / owner / editor.
  // Search is available to every role; only resolved writers get the add button.
  const caps = useActiveVaultWriteCaps(activeVaultId);
  const currentVaultScope =
    activeVaultId != null &&
    activeVaultId === getActiveVaultIdSyncMaybe() &&
    activeAccountId === getAccountIdSync();
  const canCreate = caps.resolved && caps.canCreate && currentVaultScope;
  // Refocusing Home refreshes permissions. Preserve the last confirmed
  // button footprint for this scope so search does not widen and shrink;
  // permission and press handling remain disabled throughout that refresh.
  const createButtonPresentation = useRef<{
    vaultId: string | null;
    accountId: string | null;
    visible: boolean;
  } | null>(null);
  if (caps.resolved && currentVaultScope) {
    createButtonPresentation.current = {
      vaultId: activeVaultId,
      accountId: activeAccountId,
      visible: caps.canCreate,
    };
  }
  const showCreateButton =
    currentVaultScope &&
    (caps.resolved
      ? caps.canCreate
      : createButtonPresentation.current?.vaultId === activeVaultId &&
        createButtonPresentation.current?.accountId === activeAccountId &&
        createButtonPresentation.current.visible);
  const { canAmend } = caps;
  const canCreateRef = useRef(canCreate);
  canCreateRef.current = canCreate;
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    homeGeneration.current++;
    setFiltersExpanded(false);
    filterMeasureVersion.current++;
    setFilterAnchor(null);
    setCustomerQuery("");
    setSheetFor(null);
    setConfirmDeleteFor(null);
  }, [activeVaultId, activeAccountId]);
  // D-ARCHIVED-VAULT-FILTER: the picker and settings sheet consume only
  // non-archived vaults; the archived sub-section (toggle-revealed) reads
  // `archivedVaults`. Two arrays > one array + per-render filter — the
  // picker no longer needs to know what archive means.
  const [vaults, setVaults] = useState<VaultListItem[]>([]);
  const [archivedVaults, setArchivedVaults] = useState<VaultListItem[]>([]);
  const [shopModeEnabled, setShopModeEnabled] = useState(false);
  const [shopModeBusy, setShopModeBusy] = useState(false);
  // Cloud backup channel — default ON when the key is unset (existing signed-in
  // installs synced unconditionally before the toggle). See AutoSync gate.
  // Phase 6: live peer count for the Sync toggle subtitle. Subscribed
  // via mesh.onShopModeStatusChange() in the mount effect below so the
  // UI updates without a 10s app_meta poll lag.
  const [meshActivePeers, setMeshActivePeers] = useState(0);
  // Phase 5.1 battery-optimization exemption prompt — fires the FIRST
  // time the user toggles Shop Mode on. After resolution we record the
  // prompt in app_meta so it never re-prompts.
  const [batteryDialogOpen, setBatteryDialogOpen] = useState(false);
  // OEM autostart / protected-apps prompt (MIUI/EMUI etc.) — the killer the Doze
  // whitelist doesn't cover. Shown once, after the battery step, only on a device
  // that actually has such a screen.
  const [oemDialogOpen, setOemDialogOpen] = useState(false);
  // BLE "Don't ask again" recovery — the OS suppresses the permission
  // dialog, so the only path forward is system settings.
  const [bleSettingsDialogOpen, setBleSettingsDialogOpen] = useState(false);
  // Sign-in, recovery and the different-account guard live on /sign-in.
  // Sign-out still runs here and blocks interactions until the local session
  // and the home view have both refreshed.
  const [signingOut, setSigningOut] = useState(false);
  // UX critique #6 — sign-out is destructive enough to warrant a ConfirmDialog
  // per the documented contract in design-tokens.ts. The sheet's danger-styled
  // NavRow opens this dialog; only on confirmation do we actually wipe the
  // local session.
  const [signOutConfirm, setSignOutConfirm] = useState(false);

  // Timestamp of the last hardware back press while home is focused. Lives
  // OUTSIDE the useFocusEffect callback so it persists across re-subscriptions —
  // pushing a toast re-renders the ToastProvider, which produces a new context
  // value object, which invalidates the [toast] dep of the focus effect's
  // useCallback. Without this ref pinned at the component level the timestamp
  // would reset to 0 on every back press and the second press would still see
  // "no recent press" and re-trigger the toast forever.
  const lastBackPressRef = useRef(0);

  const load = useCallback(async () => {
    const generation = ++loadGeneration.current;
    const prefVersion = preferenceVersion.current;
    const requestedVault = getActiveVaultIdSyncMaybe();
    const requestedAccount = getAccountIdSync();
    let requestedCurrency = getCurrentCurrencyCode();
    const current = () =>
      mounted.current &&
      generation === loadGeneration.current &&
      getActiveVaultIdSyncMaybe() === requestedVault &&
      getAccountIdSync() === requestedAccount &&
      getCurrentCurrencyCode() === requestedCurrency;
    // The whole body is guarded: any rejection here (SQLite error,
    // SecureStore decrypt failure after a backup-restore to a new phone)
    // previously meant setLoaded(true) never ran — an infinite spinner on
    // the ROOT screen with no retry and no back.
    try {
      await applyVaultCurrency(requestedVault);
      if (
        generation !== loadGeneration.current ||
        getActiveVaultIdSyncMaybe() !== requestedVault ||
        getAccountIdSync() !== requestedAccount
      )
        return;
      requestedCurrency = getCurrentCurrencyCode();
      const peopleRead = listAllPeopleForSearch(requestedVault, requestedCurrency, {
        allCurrencies: true,
      });
      const [s, searchList, balances, user, vaultId, shopRaw, enabledCurrencies] =
        await Promise.all([
          getLocalSelf(),
          peopleRead,
          peopleRead.then((people) => currencyBalances(people, requestedCurrency)),
          getSessionUser(),
          getActiveVaultId(),
          getAppMeta("shop_mode_enabled"),
          requestedVault ? getEnabledCurrencies(requestedVault) : Promise.resolve([]),
        ]);
      const [groupState, prefRaw, legacySearchRaw, creditPolicies] = await Promise.all([
        vaultId
          ? readCustomerGroups(vaultId)
          : Promise.resolve({ groups: [], groupByPerson: {}, groupsByPerson: {} }),
        vaultId
          ? getAppMeta(`customer_home:${requestedAccount ?? "local"}:${vaultId}`)
          : Promise.resolve(null),
        vaultId
          ? getAppMeta(`customer_search:${requestedAccount ?? "local"}:${vaultId}`)
          : Promise.resolve(null),
        vaultId
          ? Promise.all(
              [
                ...new Set(
                  searchList.flatMap((person) =>
                    personCurrencyRows(person).map((row) => row.currency ?? requestedCurrency),
                  ),
                ),
              ].map(
                async (code) => [code, await readCreditPoliciesForPeople(vaultId, code)] as const,
              ),
            ).then((rows) => Object.fromEntries(rows))
          : Promise.resolve<Record<string, Record<string, CreditPolicy>>>({}),
      ]);
      if (!current() || requestedVault !== vaultId) return;
      setSelf(s);
      // Every saved active customer stays visible. Financial lists and the
      // neutral "No tallies yet" section split this full list at render time.
      setAllPeople(searchList);
      setPeopleScope({
        vaultId: requestedVault,
        accountId: requestedAccount,
        currency: requestedCurrency,
        currencies: [
          ...new Set([
            ...enabledCurrencies,
            ...searchList.flatMap((person) =>
              personCurrencyRows(person).map((row) => row.currency ?? requestedCurrency),
            ),
          ]),
        ].filter((code) => /^[A-Z]{3}$/.test(code)),
      });
      setSummarySnapshot({ vaultId: requestedVault, accountId: requestedAccount, balances });
      setCustomerGroups(groupState.groups);
      setGroupByPerson(
        groupState.groupsByPerson ??
          Object.fromEntries(
            Object.entries(groupState.groupByPerson).map(([id, group]) => [
              id,
              group ? [group] : [],
            ]),
          ),
      );
      setCreditByCurrency(
        Object.fromEntries(
          Object.entries(creditPolicies).map(([code, policies]) => [
            code,
            Object.fromEntries(
              searchList.flatMap((person) => {
                const row = personCurrencyRows(person).find(
                  (balance) => (balance.currency ?? requestedCurrency) === code,
                );
                return row
                  ? [
                      [
                        person.id,
                        row.tab_unsynced === 1
                          ? "none"
                          : creditStatusForBalance(policies[person.id] ?? null, row.balance),
                      ],
                    ]
                  : [];
              }),
            ),
          ]),
        ),
      );
      if (prefVersion === preferenceVersion.current) {
        const preference = parseHomeCustomerListPreference(prefRaw, legacySearchRaw);
        preference.group = availableCustomerGroupFilter(preference.group, groupState.groups);
        setListPreference(preference);
      }
      setSessionUser(user);
      setActiveVaultIdState(vaultId);
      // The scope checks below compare against the in-memory account cache, so
      // record that same value. app_meta.account_id outlives sign-out (it is
      // only overwritten by the next sign-in), and comparing it with the
      // cleared cache hid the add button and blocked opening rows until a
      // relaunch.
      setActiveAccountId(requestedAccount);
      setShopModeEnabled(shopRaw === "1");

      // D-ARCHIVED-VAULT-FILTER: helpers in lib/db.ts return the two slices
      // separately. Loading them in parallel keeps the first paint snappy.
      try {
        const [active, all] = await Promise.all([
          listActiveVaults(),
          listAllVaultsIncludingArchived(),
        ]);
        if (!current()) return;
        setVaults(
          active.map((r) => ({ id: r.id, name: r.name, currency: r.currency, archived: false })),
        );
        setArchivedVaults(
          all
            .filter((r) => r.archived)
            .map((r) => ({ id: r.id, name: r.name, currency: r.currency, archived: true })),
        );

        // Edge case: if the active vault was just archived (e.g. by a remote
        // event applier between the previous load() and this one), move the
        // active vault to the first surviving non-archived vault, or null
        // it out so the UI prompts "Create a Kaata first".
        if (vaultId && !active.some((v) => v.id === vaultId)) {
          const fallback = active[0]?.id ?? null;
          if (fallback) {
            await setActiveVaultId(fallback);
            if (generation !== loadGeneration.current || getAccountIdSync() !== requestedAccount)
              return;
            setActiveVaultIdState(fallback);
            // This load belongs to the archived kaata. Read every slice for
            // the replacement instead of leaving old customers/groups under
            // its new header or waiting indefinitely on current().
            void load();
            return;
          } else {
            await clearActiveVaultId();
            if (generation !== loadGeneration.current || getAccountIdSync() !== requestedAccount)
              return;
            setActiveVaultIdState(null);
            setAllPeople([]);
            setPeopleScope(null);
            setCustomerGroups([]);
            setGroupByPerson({});
            setCreditByCurrency({});
            setSelf(s ? { ...s, shop_name: null } : s);
            setLoadError(false);
            setLoaded(true);
            return;
          }
        }
      } catch (err) {
        console.warn("[home] vault list load failed", err);
        setVaults([]);
        setArchivedVaults([]);
      }

      // M2 membership chain: one-shot chain-genesis backfill (+ pending
      // witness emission retry) for the active vault. This call site
      // covers local-only installs that never start the sync scheduler
      // (the other kickoff lives in startSyncScheduler). Fire-and-forget;
      // ensureChainBackfill self-guards with an in-session Set keyed by
      // vault, so the useFocusEffect-driven re-loads of this screen are
      // synchronous no-ops after the first call per vault.
      if (vaultId) {
        void import("../lib/trust/backfill")
          .then(({ ensureChainBackfill }) => ensureChainBackfill(vaultId))
          .catch((err) => console.warn("[home] chain backfill kickoff failed", err));
      }

      // Heal any join whose full materialization failed at accept time —
      // IN-SESSION, not just at the next cold start (the scheduler's sweep
      // runs once per session at startup, which is too late for a failure
      // that happens mid-session right after an invite accept). No-op when
      // the pending set is empty (one app_meta read); the minimal seed keeps
      // the kaata visible meanwhile, this completes its history/anchor.
      void import("../lib/vault-api")
        .then(({ retryPendingVaultMaterialize }) => retryPendingVaultMaterialize())
        .catch((err) => console.warn("[home] materialize retry kickoff failed", err));

      setLoadError(false);
    } catch (err) {
      if (!current()) return;
      console.warn("[home] load failed", err);
      setLoadError(true);
    } finally {
      if (current()) setLoaded(true);
    }
  }, []);
  useEffect(
    () => () => {
      loadGeneration.current++;
    },
    [],
  );

  useFocusEffect(
    useCallback(() => {
      void load();
      const refresh = () => {
        const vaultId = getActiveVaultIdSyncMaybe();
        if (vaultId) void refreshCreditPolicies(vaultId).catch(() => undefined);
      };
      refresh();
      const policies = onCreditPoliciesChanged((vaultId) => {
        if (getActiveVaultIdSyncMaybe() === vaultId) void load();
      });
      const app = AppState.addEventListener("change", (state) => {
        if (state === "active") {
          void load();
          refresh();
        }
      });
      return () => {
        policies();
        app.remove();
      };
    }, [load, selectedCurrency]),
  );

  // Live refresh: a mesh/cloud sync that applies events re-runs load(), so a
  // synced tally appears without pull-refresh.
  //
  // Subscribed to EVERY vault, not just the active one. This screen owns the
  // `vaults` array that the switcher renders, which spans all of them — so a
  // kaata renamed on another phone while a DIFFERENT kaata is active changed
  // nothing here under the old active-only filter, and the switcher kept
  // showing the stale name until the screen happened to reload on focus. The
  // data was correct in SQLite the whole time; only this in-memory copy was
  // behind. useLedgerRefresh coalesces a burst into one reload, so widening
  // the filter does not multiply work during a sync.
  useLedgerRefresh(null, load);
  // Sign-in, sign-out and a 401-cleared session change which account this
  // screen is scoped to. Reload so the add button and row taps follow it
  // without waiting for the next focus.
  useEffect(() => onAccountIdentityChanged(() => void load()), [load]);

  // D-ACTIVE-VAULT-REACTIVE safety net.
  //
  // The header binds to `self.shop_name`, which is derived (inside
  // getLocalSelf) from the row matching `activeVaultId`. The PRIMARY fix
  // for "archive doesn't update the header" is D-POST-ARCHIVE-SWITCH:
  // settings.tsx calls setActiveVaultId(next) immediately after emitting
  // the vault_setting_set archive event, so activeVaultId actually
  // changes, useEffects refire, header re-renders.
  //
  // This effect is the SAFETY NET for the case the primary fix can't
  // reach: a *remote* peer (mesh applier) flips vaults.archived_at on
  // the currently-active vault while this screen is unfocused. When
  // home regains focus, we re-read just that one row's archived_at; if
  // the vault we *think* is active has been archived from under us, we
  // run the same switch-or-redirect path used by D-POST-ARCHIVE-SWITCH.
  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      if (!activeVaultId) return;
      void (async () => {
        try {
          const archivedAt = await getActiveVaultArchivedAt(activeVaultId);
          if (cancelled) return;
          if (archivedAt == null) return; // still active, common path
          const active = await listActiveVaults();
          if (cancelled) return;
          const fallback = active[0]?.id ?? null;
          if (fallback) {
            await setActiveVaultId(fallback);
            setActiveVaultIdState(fallback);
            // Re-run the full load so people/self/etc reflect the new
            // vault. Without this the lists below the header stay
            // pinned to the just-archived vault's data until the next
            // user-initiated refresh.
            void load();
          } else {
            // No surviving non-archived vault → push to /vault/new so
            // the user can't keep adding entries to a dead vault.
            setActiveVaultIdState(null);
            router.replace("/vault/new");
          }
        } catch (err) {
          if (__DEV__) {
            console.warn("[home] active-vault archived-at check failed", err);
          }
        }
      })();
      return () => {
        cancelled = true;
      };
    }, [activeVaultId, load, router]),
  );

  // The existing notification intent also bootstraps a cold /profile link.
  // Consume it only after Home has published its real current-scope actions.
  useEffect(() => {
    if (
      (params.menu !== "sync" && params.menu !== "profile") ||
      !loaded ||
      activeAccountId !== getAccountIdSync() ||
      activeVaultId !== getActiveVaultIdSyncMaybe() ||
      profileOpening.current
    )
      return;
    profileOpening.current = true;
    router.setParams({ menu: undefined });
    setSettingsVisible(true);
    router.push("/profile");
  }, [params.menu, loaded, activeAccountId, activeVaultId, router]);

  // Phase 6: subscribe to mesh status changes so the Sync toggle's
  // subtitle reflects live peer count only while its settings sheet is open.
  useEffect(() => {
    if (!settingsVisible) {
      setMeshActivePeers(0);
      return;
    }
    let unsub: (() => void) | null = null;
    let cancelled = false;
    void (async () => {
      try {
        const mesh = await import("../lib/mesh");
        if (cancelled) return;
        unsub =
          mesh.onShopModeStatusChange?.((s) => {
            if (!cancelled) setMeshActivePeers(s.activePeers);
          }) ?? null;
        // Seed initial value from the synchronous snapshot.
        const snap = mesh.getShopModeStatus?.();
        if (snap) setMeshActivePeers(snap.activePeers);
      } catch (err) {
        if (__DEV__) console.warn("[home] mesh status subscribe failed", err);
      }
    })();
    return () => {
      cancelled = true;
      if (unsub) unsub();
    };
  }, [settingsVisible]);

  // Intercept the Android hardware back button on the home screen so a single
  // tap doesn't immediately close the app. Requires two presses within 2s —
  // a familiar "press back again to exit" pattern. Only active while home is
  // focused; other screens get normal back behavior (pop the stack).
  useFocusEffect(
    useCallback(() => {
      const sub = BackHandler.addEventListener("hardwareBackPress", () => {
        // The popup's own listener consumes Back; never exit behind it.
        if (homeInteraction.current.filtersExpanded) return false;
        const now = Date.now();
        if (now - lastBackPressRef.current < 2000) {
          // Second press inside the window → let RN handle (exits the app).
          return false;
        }
        lastBackPressRef.current = now;
        toast.push(t("home.exit.hint"), "info");
        return true; // intercept
      });
      return () => sub.remove();
    }, [toast]),
  );

  // Search, balance direction, groups and sort share the list; totals keep the full book snapshot.
  const currentPeopleScope =
    peopleScope?.vaultId === getActiveVaultIdSyncMaybe() &&
    peopleScope?.accountId === getAccountIdSync() &&
    peopleScope?.currency === selectedCurrency &&
    selectedCurrency === getCurrentCurrencyCode();
  const visibleAllPeople = currentPeopleScope ? allPeople : EMPTY_PEOPLE;
  const filterCurrencies = currentPeopleScope
    ? (peopleScope?.currencies ?? EMPTY_CURRENCIES)
    : EMPTY_CURRENCIES;
  const currencyFilter = useMemo(
    () => availableCustomerCurrencyFilter(savedListPreference.currency, filterCurrencies),
    [savedListPreference.currency, filterCurrencies],
  );
  const selectedFilterCurrencies = useMemo(
    () => selectedCustomerCurrencyCodes(currencyFilter),
    [currencyFilter],
  );
  const allCurrencyAmountSortAvailable = useMemo(
    () =>
      new Set(
        visibleAllPeople.flatMap((person) =>
          personCurrencyRows(person).map((row) => row.currency ?? selectedCurrency),
        ),
      ).size <= 1,
    [visibleAllPeople, selectedCurrency],
  );
  const amountSortAvailable =
    selectedFilterCurrencies.length === 1 ||
    (selectedFilterCurrencies.length === 0 && allCurrencyAmountSortAvailable);
  // A saved amount sort can outlive a book's first additional currency. Use a
  // valid order immediately, without comparing unlike amounts or saving on load.
  const listPreference = useMemo<CustomerListPreference>(() => {
    const { currency: _savedCurrency, ...allCurrenciesPreference } = savedListPreference;
    const preference = currencyFilter
      ? { ...savedListPreference, currency: currencyFilter }
      : savedListPreference.currency === undefined
        ? savedListPreference
        : allCurrenciesPreference;
    return !amountSortAvailable &&
      (preference.sort === "amount_desc" || preference.sort === "amount_asc")
      ? { ...preference, sort: DEFAULT_CUSTOMER_LIST.sort }
      : preference;
  }, [savedListPreference, currencyFilter, amountSortAvailable]);
  const sharedStatusByPerson = useMemo(
    () =>
      Object.fromEntries(
        visibleAllPeople.map((person) => [person.id, personSharedAccountStatus(person)]),
      ),
    [visibleAllPeople],
  );
  const creditByPerson = useMemo<Record<string, CreditStatus>>(
    () =>
      Object.fromEntries(
        visibleAllPeople.map((person) => {
          const statuses = selectedFilterCurrencies.length
            ? selectedFilterCurrencies.map((code) => creditByCurrency[code]?.[person.id] ?? "none")
            : Object.values(creditByCurrency).map((statuses) => statuses[person.id] ?? "none");
          return [
            person.id,
            statuses.includes("over") ? "over" : statuses.includes("near") ? "near" : "none",
          ];
        }),
      ),
    [visibleAllPeople, creditByCurrency, selectedFilterCurrencies],
  );
  const searchMatches = useMemo(
    () =>
      customerQuery.trim()
        ? searchCustomerMatches(splitSearchQuery(customerQuery), visibleAllPeople)
        : { people: visibleAllPeople, relevanceById: EMPTY_SEARCH_RELEVANCE },
    [visibleAllPeople, customerQuery],
  );
  const homePeople = useMemo(
    () =>
      selectSearchCustomers(
        searchMatches.people,
        listPreference,
        groupByPerson,
        locale,
        searchMatches.relevanceById,
      ),
    [searchMatches, listPreference, groupByPerson, locale],
  );
  const canSelect = caps.resolved && canAmend && currentVaultScope && currentPeopleScope;
  const selecting = selectionMode && canSelect;
  const canSelectRef = useRef(canSelect);
  canSelectRef.current = canSelect;
  const selectedIds = useMemo(() => {
    const available = new Set(visibleAllPeople.map((person) => person.id));
    return new Set(selectedPersonIds.filter((id) => available.has(id)));
  }, [selectedPersonIds, visibleAllPeople]);
  const settledCustomerIds = useMemo(
    () => new Set(visibleAllPeople.filter(isSettledCustomer).map((person) => person.id)),
    [visibleAllPeople],
  );
  const activeHomePeople = useMemo(
    () => homePeople.filter((person) => !settledCustomerIds.has(person.id)),
    [homePeople, settledCustomerIds],
  );
  const settledHomePeople = useMemo(
    () => homePeople.filter((person) => settledCustomerIds.has(person.id)),
    [homePeople, settledCustomerIds],
  );
  const settledViewScope = JSON.stringify([
    activeAccountId,
    activeVaultId,
    selectedCurrency,
    customerQuery.trim(),
  ]);
  const settledViewOwner = useRef({ scope: settledViewScope, epoch: 0 });
  if (settledViewOwner.current.scope !== settledViewScope)
    settledViewOwner.current = {
      scope: settledViewScope,
      epoch: settledViewOwner.current.epoch + 1,
    };
  const settledViewEpoch = settledViewOwner.current.epoch;
  const [settledDisclosure, setSettledDisclosure] = useState({ epoch: -1, expanded: false });
  const settledExpanded =
    (settledDisclosure.epoch === settledViewEpoch
      ? settledDisclosure.expanded
      : customerQuery.trim().length > 0) ||
    (selecting && settledHomePeople.some((person) => selectedIds.has(person.id)));
  const visibleHomePeople = useMemo(
    () => (settledExpanded ? [...activeHomePeople, ...settledHomePeople] : activeHomePeople),
    [activeHomePeople, settledHomePeople, settledExpanded],
  );
  const selectablePeople = visibleHomePeople;
  const selectableIds = useMemo(
    () => new Set(selectablePeople.map((person) => person.id)),
    [selectablePeople],
  );
  // The list already carries each account's totals from the same local read.
  // Selecting only adds those cached amounts; the count and figures change together.
  const financialSummary = useMemo(
    () =>
      selectedPeopleByCurrency(
        visibleAllPeople.filter((person) => selectedIds.has(person.id)),
        selectedCurrency,
      ),
    [visibleAllPeople, selectedIds],
  );
  const selectedIdsRef = useRef(selectedIds);
  selectedIdsRef.current = selectedIds;
  useEffect(() => {
    // Selection belongs to one account and kaata, including a restored session.
    selectionGeneration.current++;
    setSelectionMode(false);
    setSelectedPersonIds([]);
    setConfirmRemoveIds(null);
  }, [activeVaultId, activeAccountId, canSelect, selectedCurrency]);
  useEffect(() => {
    setSearchFocused(false);
    setKeyboardShown(false);
    searchInputRef.current?.blur();
  }, [activeVaultId, activeAccountId, selectedCurrency]);
  useEffect(() => {
    const available = new Set(visibleAllPeople.map((person) => person.id));
    setSelectedPersonIds((ids) => {
      const next = ids.filter((id) => available.has(id));
      return next.length === ids.length ? ids : next;
    });
    selectionConfirmationVersion.current++;
    setConfirmRemoveIds(null);
  }, [visibleAllPeople]);
  useEffect(() => {
    selectionConfirmationVersion.current++;
    setConfirmRemoveIds(null);
  }, [selectableIds]);
  useFocusEffect(
    useCallback(() => {
      selectionOwnerActive.current = true;
      return () => {
        setKeyboardShown(false);
        setSearchFocused(false);
        searchInputRef.current?.blur();
        selectionOwnerActive.current = false;
        homeGeneration.current++;
        setFiltersExpanded(false);
        filterMeasureVersion.current++;
        selectionGeneration.current++;
        setSelectionMode(false);
        setSelectedPersonIds([]);
        setConfirmRemoveIds(null);
      };
    }, []),
  );
  const startSelection = useCallback(
    (person?: PersonWithBalance) => {
      if (
        !mounted.current ||
        !selectionOwnerActive.current ||
        !canSelectRef.current ||
        selectionBusyRef.current ||
        activeVaultId !== getActiveVaultIdSyncMaybe() ||
        activeAccountId !== getAccountIdSync()
      )
        return;
      if (!isCurrentHome() || homeInteraction.current.confirming) return;
      if (person && !homeInteraction.current.people.has(person.id)) return;
      dismissKeyboard();
      selectionGeneration.current++;
      setSelectedPersonIds(
        person && visibleAllPeople.some((row) => row.id === person.id) ? [person.id] : [],
      );
      setSelectionMode(true);
      Haptics.selectionAsync().catch(() => undefined);
    },
    [
      dismissKeyboard,
      visibleAllPeople,
      activeVaultId,
      activeAccountId,
      homeRequest,
      selectedCurrency,
    ],
  );
  const removeSelected = async () => {
    if (selectionBusyRef.current || !canSelectRef.current) return;
    const ids = (confirmRemoveIds ?? []).filter((id) => selectedIdsRef.current.has(id));
    setConfirmRemoveIds(null);
    if (!ids.length) return;
    const vaultId = activeVaultId;
    const accountId = activeAccountId;
    if (!vaultId) return;
    const generation = selectionGeneration.current;
    const current = () =>
      mounted.current &&
      canSelectRef.current &&
      generation === selectionGeneration.current &&
      getActiveVaultIdSyncMaybe() === vaultId &&
      getAccountIdSync() === accountId &&
      getCurrentCurrencyCode() === selectedCurrency;
    if (!current()) return;
    selectionBusyRef.current = true;
    setSelectionBusy(true);
    const removed = new Set<string>();
    try {
      for (const id of ids) {
        if (!current()) break;
        try {
          await archivePerson(id, { vaultId, accountId });
          removed.add(id);
        } catch (err) {
          console.warn("[home] selected contact removal failed", err);
        }
      }
      if (!current()) return;
      const remaining = ids.filter((id) => !removed.has(id));
      setSelectedPersonIds(remaining);
      if (!remaining.length) setSelectionMode(false);
      if (removed.size)
        toast.push(t("selection.contactsRemoved", { count: removed.size }), "success");
      if (remaining.length)
        toast.push(t("selection.partialFailure", { count: remaining.length }), "error");
      await load();
    } finally {
      selectionBusyRef.current = false;
      if (mounted.current) setSelectionBusy(false);
    }
  };
  // Read the live scope when a retained row callback eventually runs.
  const homePeopleById = useMemo(
    () => new Map(visibleHomePeople.map((person) => [person.id, person])),
    [visibleHomePeople],
  );
  const effectiveGroup = useMemo(
    () => availableCustomerGroupFilter(listPreference.group, customerGroups),
    [listPreference.group, customerGroups],
  );
  useEffect(() => {
    if (JSON.stringify(listPreference.group) !== JSON.stringify(effectiveGroup))
      setListPreference((p) => ({ ...p, group: effectiveGroup }));
  }, [effectiveGroup, listPreference.group]);
  const balanceFilter = listPreference.direction ?? "all";
  const listFiltered = !!currencyFilter || balanceFilter !== "all" || effectiveGroup !== "all";
  const listCustomized = listFiltered || listPreference.sort !== DEFAULT_CUSTOMER_LIST.sort;
  // Keep selected group names beside the list they filter.
  const groupFilterLabel = useMemo(() => {
    if (effectiveGroup === "all") return null;
    if (effectiveGroup === "ungrouped") return t("groups.ungrouped");
    const names = selectedCustomerGroupIds(effectiveGroup)
      .map((id) => customerGroups.find((group) => group.id === id)?.name)
      .filter((name): name is string => !!name);
    return names.length ? names.join(locale !== "en" ? "، " : ", ") : null;
  }, [effectiveGroup, customerGroups, locale]);
  const groupFilterCount =
    effectiveGroup === "all" || effectiveGroup === "ungrouped"
      ? 1
      : selectedCustomerGroupIds(effectiveGroup).length;
  // A new order starts at its top; otherwise the first rows of a re-sorted
  // long list are scrolled off-screen.
  const homeScrollRef = useRef<ScrollViewInstance>(null);
  const summaryScopeKey = JSON.stringify([activeAccountId, activeVaultId]);
  const homeScrollScope = JSON.stringify([activeAccountId, activeVaultId, selectedCurrency]);
  const homeScrollPositions = useRef({ scope: homeScrollScope, offset: 0 });
  if (homeScrollPositions.current.scope !== homeScrollScope)
    homeScrollPositions.current = { scope: homeScrollScope, offset: 0 };
  // Retained callbacks write their own scope's record, including account ABA.
  const homeScrollPosition = homeScrollPositions.current;
  const listOrderKey = `${listPreference.sort}|${balanceFilter}|${JSON.stringify(currencyFilter ?? "all")}|${JSON.stringify(effectiveGroup)}`;
  const shownListOrderKey = useRef(listOrderKey);
  useEffect(() => {
    if (shownListOrderKey.current === listOrderKey) return;
    shownListOrderKey.current = listOrderKey;
    homeScrollRef.current?.scrollTo({ y: 0, animated: false });
  }, [listOrderKey]);
  useEffect(() => {
    homeScrollRef.current?.scrollTo({ y: 0, animated: false });
  }, [customerQuery]);
  const isCurrentHome = () =>
    mounted.current &&
    selectionOwnerActive.current &&
    homeInteraction.current.scoped &&
    homeGeneration.current === homeRequest &&
    activeVaultId === getActiveVaultIdSyncMaybe() &&
    activeAccountId === getAccountIdSync() &&
    selectedCurrency === getCurrentCurrencyCode();
  const changeListPreference = (preference: CustomerListPreference) => {
    if (!isCurrentHome() || selectionBusyRef.current || homeInteraction.current.confirming) return;
    const currency = availableCustomerCurrencyFilter(preference.currency, filterCurrencies);
    const currencyCount = selectedCustomerCurrencyCodes(currency).length;
    const { currency: _requestedCurrency, ...allCurrenciesPreference } = preference;
    preference = currency ? { ...preference, currency } : allCurrenciesPreference;
    if (
      (currencyCount > 1 || (currencyCount === 0 && !allCurrencyAmountSortAvailable)) &&
      (preference.sort === "amount_desc" || preference.sort === "amount_asc")
    )
      preference = { ...preference, sort: DEFAULT_CUSTOMER_LIST.sort };
    preferenceVersion.current++;
    setListPreference(preference);
    void setAppMeta(
      `customer_home:${activeAccountId ?? "local"}:${activeVaultId}`,
      JSON.stringify(preference),
    ).catch(() => {
      if (isCurrentHome()) toast.push(t("entry.saveFailed"), "error");
    });
    return preference;
  };
  const homeInteraction = useRef({
    people: homePeopleById,
    selecting,
    selectableIds,
    scoped: currentPeopleScope && currentVaultScope,
    confirming: confirmRemoveIds !== null,
    searchOpen: keyboardLayoutShown,
    filtersExpanded,
    canClearFilters: customerQuery.trim().length > 0 || listFiltered,
  });
  homeInteraction.current = {
    people: homePeopleById,
    selecting,
    selectableIds,
    scoped: currentPeopleScope && currentVaultScope,
    confirming: confirmRemoveIds !== null,
    searchOpen: keyboardLayoutShown,
    filtersExpanded,
    canClearFilters: customerQuery.trim().length > 0 || listFiltered,
  };

  const directionContextKey = JSON.stringify([
    activeAccountId,
    activeVaultId,
    selectedCurrency,
    homeRequest,
  ]);
  const directionControlsEnabled =
    currentPeopleScope &&
    currentVaultScope &&
    !selecting &&
    !selectionBusy &&
    !filtersExpanded &&
    !settingsVisible &&
    !vaultPickerVisible &&
    !sheetFor &&
    !confirmDeleteFor &&
    !confirmRemoveIds &&
    !batteryDialogOpen &&
    !oemDialogOpen &&
    !bleSettingsDialogOpen;
  const reviewContext = useMemo(() => {
    if (!loaded || !self || !currentPeopleScope || !currentVaultScope) return null;
    try {
      return {
        installId: getInstallIdSync(),
        accountId: activeAccountId,
        vaultId: activeVaultId,
      };
    } catch {
      return null;
    }
  }, [loaded, self, currentPeopleScope, currentVaultScope, activeAccountId, activeVaultId]);
  const cancelStoreReview = useStoreReviewPrompt({
    context: reviewContext,
    ready:
      directionControlsEnabled &&
      !forceUpdate &&
      !loadError &&
      !notificationInboxVisible &&
      !keyboardLayoutShown &&
      !searchFocused &&
      customerQuery.trim().length === 0,
  });
  const directionInteraction = useRef({
    contextKey: directionContextKey,
    enabled: directionControlsEnabled,
    preference: listPreference,
    currencies: filterCurrencies,
    changePreference: changeListPreference,
  });
  directionInteraction.current = {
    contextKey: directionContextKey,
    enabled: directionControlsEnabled,
    preference: listPreference,
    currencies: filterCurrencies,
    changePreference: changeListPreference,
  };
  const changeBalanceDirection = (direction: CustomerBalanceFilter, currency?: string) => {
    const current = directionInteraction.current;
    if (
      !isCurrentHome() ||
      current.contextKey !== directionContextKey ||
      !current.enabled ||
      selectionBusyRef.current ||
      filtersExpandedRef.current ||
      (currency !== undefined && !current.currencies.includes(currency))
    )
      return;
    const selected = selectedCustomerCurrencyCodes(current.preference.currency);
    const currencyScoped = currency !== undefined && current.currencies.length > 1;
    const sameCard =
      currency !== undefined &&
      (current.preference.direction ?? "all") === direction &&
      (!currencyScoped || (selected.length === 1 && selected[0] === currency));
    const nextDirection = sameCard ? "all" : direction;
    const nextCurrency = currencyScoped && !sameCard ? currency : undefined;
    if (
      (current.preference.direction ?? "all") === nextDirection &&
      selected.length === (nextCurrency ? 1 : 0) &&
      (!nextCurrency || selected[0] === nextCurrency)
    )
      return;
    cancelStoreReview();
    // Card taps select one denomination; list swipes select the side across
    // currencies. Keep the latest query, group and compatible sort choices.
    const { currency: _previousCurrency, ...rest } = current.preference;
    const preference = {
      ...rest,
      direction: nextDirection,
      ...(nextCurrency ? { currency: nextCurrency } : {}),
    };
    const applied = current.changePreference(preference);
    if (!applied) return;
    current.preference = applied;
    if (homeInteraction.current.searchOpen) dismissKeyboard();
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Soft).catch(() => undefined);
  };
  const changeSwipedDirection = (direction: CustomerBalanceFilter) => {
    if (homeInteraction.current.searchOpen) return;
    changeBalanceDirection(direction);
  };

  const updateFilterAnchor = useCallback(() => {
    const surface = overlaySurfaceRef.current;
    const trigger = filterTriggerRef.current;
    if (
      !filtersExpandedRef.current ||
      !isCurrentHome() ||
      !surface?.measureInWindow ||
      !trigger?.measureInWindow
    )
      return;
    const request = ++filterMeasureVersion.current;
    surface.measureInWindow((surfaceX, surfaceY, width, height) => {
      trigger.measureInWindow((x, y, triggerWidth, triggerHeight) => {
        if (
          !filtersExpandedRef.current ||
          !isCurrentHome() ||
          request !== filterMeasureVersion.current ||
          overlaySurfaceRef.current !== surface ||
          filterTriggerRef.current !== trigger
        )
          return;
        setFilterViewport((previous) =>
          previous.width === width &&
          previous.height === height &&
          previous.topInset === (insets.top ?? 0)
            ? previous
            : { width, height, topInset: insets.top ?? 0 },
        );
        const anchor = {
          x: x - surfaceX,
          y: y - surfaceY,
          width: triggerWidth,
          height: triggerHeight,
        };
        setFilterAnchor((previous) =>
          previous?.x === anchor.x &&
          previous.y === anchor.y &&
          previous.width === anchor.width &&
          previous.height === anchor.height
            ? previous
            : anchor,
        );
      });
    });
  }, [activeAccountId, activeVaultId, homeRequest, selectedCurrency, insets.top]);
  useLayoutEffect(() => {
    // Opening measures after the expanded state commits. Closing invalidates
    // in-flight native measurements so hidden filters cannot repaint Home.
    filterMeasureVersion.current++;
    if (!filtersExpanded) {
      setFilterAnchor(null);
      return;
    }
    updateFilterAnchor();
  }, [keyboardLayoutShown, filtersExpanded, updateFilterAnchor]);
  useEffect(() => {
    let alive = true;
    const current = () => alive && isCurrentHome();
    const syncLayout = (shown: boolean) => {
      if (!current()) return;
      setKeyboardShown(shown);
      // A delayed native show event must not restore search underneath filters.
      if (shown && filtersExpandedRef.current) dismissKeyboard();
    };
    const finishHide = () => {
      if (!current()) return;
      // A completed old dismissal may arrive after native focus has restarted,
      // before its onFocus or will-show events reach JavaScript.
      if (Platform.OS === "ios" && searchInputRef.current?.isFocused()) return;
      searchInputRef.current?.blur();
      setSearchFocused(false);
      setKeyboardShown(false);
      if (filtersExpandedRef.current) updateFilterAnchor();
    };
    const show = Keyboard.addListener(
      Platform.OS === "ios" ? "keyboardWillShow" : "keyboardDidShow",
      () => syncLayout(true),
    );
    const hide = Keyboard.addListener(
      Platform.OS === "ios" ? "keyboardWillHide" : "keyboardDidHide",
      () => {
        if (Platform.OS === "ios") syncLayout(false);
        else finishHide();
      },
    );
    // An interactive iOS dismissal may be cancelled after its will-hide event.
    const finishShow =
      Platform.OS === "ios"
        ? Keyboard.addListener("keyboardDidShow", () => syncLayout(true))
        : null;
    const didHide =
      Platform.OS === "ios" ? Keyboard.addListener("keyboardDidHide", finishHide) : null;
    return () => {
      alive = false;
      show.remove();
      hide.remove();
      finishShow?.remove();
      didHide?.remove();
    };
  }, [
    activeAccountId,
    activeVaultId,
    homeRequest,
    selectedCurrency,
    dismissKeyboard,
    updateFilterAnchor,
  ]);
  const visibleBalances =
    summarySnapshot?.vaultId === getActiveVaultIdSyncMaybe() &&
    summarySnapshot?.accountId === getAccountIdSync()
      ? summarySnapshot.balances
      : undefined;

  // Stable row handlers — PersonRow is memoized, and these two props must
  // keep their identity across renders or every row re-renders on each
  // toast push / locale flip (see PersonRow's memo rationale).
  const openPerson = useCallback(
    (p: PersonWithBalance) => {
      if (
        !mounted.current ||
        !selectionOwnerActive.current ||
        activeVaultId !== getActiveVaultIdSyncMaybe() ||
        activeAccountId !== getAccountIdSync()
      )
        return;
      if (selectionBusyRef.current || !isCurrentHome()) return;
      const current = homeInteraction.current;
      const person = current.people.get(p.id);
      if (!person || current.confirming) return;
      if (current.selecting) {
        if (!canSelectRef.current) return;
        setSelectedPersonIds((ids) =>
          ids.includes(person.id) ? ids.filter((id) => id !== person.id) : [...ids, person.id],
        );
        return;
      }
      Keyboard.dismiss();
      router.push({ pathname: "/person/[id]", params: { id: person.id } });
    },
    [router, activeVaultId, activeAccountId, homeRequest, selectedCurrency],
  );
  const openHomePersonActions = useCallback(
    (p: PersonWithBalance) => {
      const current = homeInteraction.current;
      const person = current.people.get(p.id);
      if (
        !mounted.current ||
        !selectionOwnerActive.current ||
        !canSelectRef.current ||
        selectionBusyRef.current ||
        current.confirming ||
        activeVaultId !== getActiveVaultIdSyncMaybe() ||
        activeAccountId !== getAccountIdSync() ||
        !person ||
        !isCurrentHome()
      )
        return;
      setSheetFor(person);
    },
    [activeVaultId, activeAccountId, homeRequest, selectedCurrency],
  );

  const confirmationVersion = selectionConfirmationVersion.current;
  const selectionToolbar = selecting ? (
    <SelectionToolbar
      count={selectedIds.size}
      total={selectablePeople.length}
      financialSummaries={financialSummary}
      allSelected={selectableIds.size > 0 && [...selectableIds].every((id) => selectedIds.has(id))}
      onClose={() => {
        if (
          activeVaultId === getActiveVaultIdSyncMaybe() &&
          activeAccountId === getAccountIdSync() &&
          isCurrentHome()
        )
          closeSelection();
      }}
      onToggleAll={() => {
        if (
          selectionBusyRef.current ||
          !canSelectRef.current ||
          activeVaultId !== getActiveVaultIdSyncMaybe() ||
          activeAccountId !== getAccountIdSync()
        )
          return;
        if (!isCurrentHome() || homeInteraction.current.confirming) return;
        const currentIds = homeInteraction.current.selectableIds;
        setSelectedPersonIds((ids) =>
          [...currentIds].every((id) => selectedIdsRef.current.has(id))
            ? ids.filter((id) => !currentIds.has(id))
            : [...new Set([...ids, ...currentIds])],
        );
      }}
      busy={selectionBusy}
      actions={[
        {
          key: "remove",
          label: t("selection.remove"),
          icon: "trash-outline",
          destructive: true,
          onPress: () => {
            if (
              selectionBusyRef.current ||
              !canSelectRef.current ||
              !isCurrentHome() ||
              selectedIdsRef.current.size === 0
            )
              return;
            dismissKeyboard();
            selectionConfirmationVersion.current++;
            setConfirmRemoveIds([...selectedIdsRef.current]);
          },
        },
      ]}
    />
  ) : null;

  const controlsDisabled =
    selectionBusy || confirmRemoveIds !== null || !currentVaultScope || !currentPeopleScope;
  const createButtonDisabled = !canCreate || controlsDisabled;
  const prepareSearchKeyboard = () => {
    if (isCurrentHome() && filtersExpandedRef.current) {
      dismissKeyboard();
      return;
    }
    if (
      Platform.OS === "android" &&
      isCurrentHome() &&
      !selectionBusyRef.current &&
      !homeInteraction.current.confirming
    ) {
      setSearchFocused(true);
    }
  };
  const searchDock = (
    <View style={styles.searchRow}>
      <View style={styles.searchField}>
        <Ionicons name="search-outline" size={icon.row} color={colors.textSubtle} />
        <TextInput
          ref={searchInputRef}
          accessibilityLabel={t("customers.search")}
          placeholder={t("customers.search")}
          placeholderTextColor={colors.textMuted}
          value={customerQuery}
          editable={!controlsDisabled}
          onPress={prepareSearchKeyboard}
          onFocus={prepareSearchKeyboard}
          onBlur={() => {
            if (isCurrentHome()) {
              setSearchFocused(false);
            }
          }}
          onChangeText={(query) => {
            if (isCurrentHome() && !selectionBusyRef.current && !homeInteraction.current.confirming)
              setCustomerQuery(query);
          }}
          style={[styles.searchInput, textDir(isRTL)]}
          autoCorrect={false}
          returnKeyType="search"
          submitBehavior="blurAndSubmit"
          onSubmitEditing={dismissKeyboard}
          maxLength={500}
        />
        {customerQuery ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t("search.clearQuery")}
            disabled={controlsDisabled}
            hitSlop={8}
            onPress={() => {
              if (
                isCurrentHome() &&
                !selectionBusyRef.current &&
                !homeInteraction.current.confirming
              )
                setCustomerQuery("");
            }}
          >
            <Ionicons name="close-circle" size={icon.trailing} color={colors.textMuted} />
          </Pressable>
        ) : null}
      </View>
      {keyboardLayoutShown || filtersExpanded ? (
        <Pressable
          ref={filterTriggerRef}
          onLayout={updateFilterAnchor}
          accessibilityRole="button"
          accessibilityLabel={t("customers.listOptions")}
          accessibilityState={{
            expanded: filtersExpanded,
            selected: listCustomized,
            disabled: controlsDisabled,
          }}
          disabled={controlsDisabled}
          onPress={() => {
            if (
              !isCurrentHome() ||
              (!homeInteraction.current.searchOpen && !filtersExpandedRef.current) ||
              selectionBusyRef.current ||
              homeInteraction.current.confirming
            )
              return;
            const expanded = !filtersExpandedRef.current;
            filtersExpandedRef.current = expanded;
            filterMeasureVersion.current++;
            setFiltersExpanded(expanded);
            setFilterAnchor(null);
            if (expanded) dismissKeyboard();
          }}
          style={[
            styles.filterButton,
            (filtersExpanded || listCustomized) && styles.filterButtonActive,
          ]}
        >
          <Ionicons
            name="options-outline"
            size={icon.row}
            color={filtersExpanded || listCustomized ? colors.textInverted : colors.textDefault}
          />
        </Pressable>
      ) : null}
      {keyboardLayoutShown ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("common.hideKeyboard")}
          onPress={dismissKeyboard}
          style={styles.keyboardDismiss}
        >
          <Ionicons name="chevron-down" size={icon.row} color={colors.textEmphasis} />
        </Pressable>
      ) : showCreateButton && !selecting ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("personAdd.new")}
          disabled={createButtonDisabled}
          accessibilityState={{ disabled: createButtonDisabled }}
          // D-DEFENSIVE-ARCHIVED-GUARD: D-POST-ARCHIVE-SWITCH should
          // normally keep the active vault writable, but a mesh-sourced
          // archive event can race the FAB tap; refuse here and tell the
          // user where to go instead. Cheap 1-row DB read; we don't
          // memoize because the answer can change between renders and
          // the UX cost of a stale "yes, write" is higher than a 1ms
          // SELECT.
          onPress={async () => {
            const requestedVault = activeVaultId;
            const requestedAccount = activeAccountId;
            const current = () =>
              mounted.current &&
              canCreateRef.current &&
              getActiveVaultIdSyncMaybe() === requestedVault &&
              getAccountIdSync() === requestedAccount;
            if (!current()) return;
            const guard = await getActiveVaultArchivedState();
            if (!current()) return;
            if (guard.state === "archived") {
              toast.push(t("home.fab.blockedArchived"), "error");
              return;
            }
            if (guard.state === "none") {
              toast.push(t("entry.noActiveVault"), "error");
              return;
            }
            Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => undefined);
            Keyboard.dismiss();
            router.push({ pathname: "/person/new", params: { mode: "add" } });
          }}
          style={({ pressed }) => [
            styles.fabInner,
            pressed && !createButtonDisabled && { opacity: 0.85 },
            createButtonDisabled && { opacity: 0.5 },
          ]}
        >
          <Ionicons name="add" size={28} color={colors.textInverted} />
        </Pressable>
      ) : null}
    </View>
  );
  const inlineControls =
    customerQuery.trim() || listFiltered ? (
      <View style={styles.inlineControls}>
        {customerQuery.trim().length > 0 || listFiltered ? (
          <View style={[styles.resultsHeading, { alignItems: isRTL ? "flex-end" : "flex-start" }]}>
            {customerQuery.trim().length > 0 ? (
              <Text style={[styles.resultCount, textDir(isRTL)]} accessibilityLiveRegion="polite">
                {t(
                  homePeople.length === 1 ? "customers.search.result" : "customers.search.results",
                  {
                    count: homePeople.length,
                  },
                )}
              </Text>
            ) : null}
            {customerQuery.trim() || listFiltered ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={t("search.clearAll")}
                disabled={controlsDisabled}
                onPress={() => {
                  if (
                    !isCurrentHome() ||
                    !homeInteraction.current.canClearFilters ||
                    selectionBusyRef.current ||
                    homeInteraction.current.confirming
                  )
                    return;
                  setCustomerQuery("");
                  changeListPreference({ ...DEFAULT_CUSTOMER_LIST });
                }}
              >
                <Text style={[styles.clearLabel, textDir(isRTL)]}>{t("search.clearAll")}</Text>
              </Pressable>
            ) : null}
          </View>
        ) : null}
        <View style={[styles.filterChipRow, rowDir(isRTL)]}>
          {balanceFilter !== "all" ? (
            <CustomerFilterChip
              label={t(`customers.balanceFilter.${balanceFilter}`)}
              clearHint={t("customers.balanceFilter.clear")}
              onClear={() => changeListPreference({ ...listPreference, direction: "all" })}
            />
          ) : null}
          {currencyFilter ? (
            <CustomerFilterChip
              label={`${t("customers.currencyFilter")}: ${selectedFilterCurrencies.map(getCurrencyLabel).join(locale === "en" ? ", " : "، ")}`}
              clearHint={t("customers.currencyFilter.clear")}
              onClear={() => changeListPreference({ ...listPreference, currency: undefined })}
            />
          ) : null}
          <GroupFilterChip
            groupFilterLabel={groupFilterLabel}
            groupFilterCount={groupFilterCount}
            onClearGroupFilter={() => changeListPreference({ ...listPreference, group: "all" })}
          />
        </View>
      </View>
    ) : null;

  const filtersVisible = filtersExpanded && currentPeopleScope && currentVaultScope;
  const filterContent = (
    <>
      <CustomerListOptions
        compact
        embedded
        amountSortAvailable={amountSortAvailable}
        currencies={filterCurrencies}
        preference={listPreference}
        groups={customerGroups}
        isRTL={isRTL}
        onChange={changeListPreference}
      />
      {canAmend ? (
        <Button
          label={t("groups.manage")}
          icon="add-outline"
          variant="secondary"
          fullWidth
          onPress={() => {
            if (
              !isCurrentHome() ||
              selectionBusyRef.current ||
              !canSelectRef.current ||
              !activeVaultId ||
              homeInteraction.current.confirming
            )
              return;
            Keyboard.dismiss();
            router.push({ pathname: "/groups", params: { vaultId: activeVaultId } });
          }}
        />
      ) : null}
    </>
  );

  if (forceUpdate) return <Redirect href="/update-prompt" />;
  if (loaded && !self) return <Redirect href="/onboarding" />;

  return (
    <View
      ref={overlaySurfaceRef}
      style={styles.container}
      onLayout={updateFilterAnchor}
      onTouchStart={cancelStoreReview}
    >
      <BlurTargetView
        ref={filterBlurTargetRef}
        collapsable={false}
        style={styles.body}
        accessibilityElementsHidden={filtersVisible}
        importantForAccessibility={filtersVisible ? "no-hide-descendants" : "auto"}
      >
        <SafeAreaView style={styles.container} edges={["top"]}>
          {/* Header — Phase 7 layout:
            * top-LEFT: kaata name (vault switcher → VaultPickerSheet)
            * top-RIGHT: profile chip (unified settings → ProfileSettingsSheet)
          The hamburger menu is gone (Phase 7 founder feedback #1). The
          identity text block carries a chevron-down hint so the
          tappable affordance is discoverable.

          D-HEADER-CLEANUP (Phase 7 polish): the user-name subtitle was
          removed, so the title block's minHeight no longer needs to
          reserve a second line. Both clusters now center on a single
          row (alignItems:"center" on header AND headerTitleBlock) so
          the title text and the avatar share the same vertical axis.
          Result: no phantom space below the title, no marginTop hacks
          on the avatar. */}
          <View style={[styles.header, rowDir(isRTL)]}>
            {/* Identity text block — top-LEFT. Phase 7 D-TOP-LEFT-SWITCHER:
            tapping opens VaultPickerSheet. The chevron-down hint next
            to the title tells first-time users this is tappable;
            without it the text reads as pure header chrome.

            flex:1 takes the row's remaining width so a very long shop
            name truncates at numberOfLines:1 instead of pushing the
            profile button off-screen. hitSlop:8 widens the tap target
            without enlarging the visual box. */}
            {vaults.length > 0 ? (
              <Pressable
                onPress={() => {
                  // Mutual exclusion: close the settings sheet first so the
                  // Android Modal stack stays at depth 1. The 220ms defer
                  // matches ProfileSettingsSheet's EXIT_DURATION_MS so the
                  // closing sheet's <Modal> unmounts BEFORE the picker's mounts.
                  // Without this defer, both Modals are mounted for ~180ms
                  // during the close animation and Android renders the second
                  // one blank-but-tappable (UX critique #5, same shape as the
                  // BottomSheet chained() defer).
                  // Re-read before showing the list. The live-refresh
                  // subscription above should already have kept `vaults` current,
                  // but this list is the one surface where a stale entry is
                  // actually confusing rather than merely late — it is how you
                  // recognise a kaata — and a rename that arrived from another
                  // phone has no other cue that it happened. One query on a user
                  // gesture makes the switcher correct independently of whether
                  // the event plumbing fired.
                  void load();
                  setVaultPickerVisible(true);
                }}
                hitSlop={8}
                accessibilityRole="button"
                accessibilityLabel={t("menu.title.vaultSwitcher")}
                accessibilityValue={{ text: self?.shop_name ?? self?.name ?? "" }}
                accessibilityState={{ expanded: vaultPickerVisible }}
                style={({ pressed }) => [
                  styles.headerTitleBlock,
                  styles.kaataButton,
                  rowDir(isRTL),
                  pressed && styles.kaataButtonPressed,
                ]}
              >
                <View style={styles.headerTitleTextCol}>
                  {self ? (
                    <Text
                      style={[styles.headerTitle, styles.kaataButtonTitle, textDir(isRTL)]}
                      numberOfLines={1}
                      allowFontScaling={false}
                    >
                      {self.shop_name ?? self.name}
                    </Text>
                  ) : null}
                </View>
                {/* The chevron makes the kaata list action visible. */}
                <Ionicons
                  name="chevron-down"
                  size={icon.trailing}
                  color={colors.textSubtle}
                  style={isRTL ? { marginRight: 4 } : { marginLeft: 4 }}
                />
              </Pressable>
            ) : (
              // No kaatas yet — there's nothing to switch between, so the title is
              // plain text: no chevron, not a button (Matee). The user's own name
              // shows here (shop_name is null until a kaata exists).
              <View style={[styles.headerTitleBlock, rowDir(isRTL)]}>
                <View style={styles.headerTitleTextCol}>
                  {self ? (
                    <Text
                      style={[styles.headerTitle, textDir(isRTL)]}
                      numberOfLines={1}
                      allowFontScaling={false}
                    >
                      {self.shop_name ?? self.name}
                    </Text>
                  ) : null}
                </View>
              </View>
            )}

            {/* Non-tappable spacer fills the gap between the switcher and the
            profile, pushing the avatar to the edge. The switcher Pressable
            hugs its content (name + chevron) instead of flex:1-ing across the
            whole row, so tapping the empty middle no longer opens the kaata
            picker (it used to: the switcher's tap target spanned to the avatar). */}
            {/* Read-only badge — shown when I'm a viewer on this (shared) kaata, so
            the absent FAB / write actions are explained rather than mysterious. */}
            {caps.resolved && !caps.canCreate && currentVaultScope ? (
              <View style={[styles.readOnlyBadge, isRTL ? { marginRight: 8 } : { marginLeft: 8 }]}>
                {/* Stays 12, NOT icon.trailing (16): this glyph is optically paired
                to the 11px caption inside a 3px-padded micro-pill — a composed
                graphic, per the tokens icon-scale exception. 16 would out-weigh
                the label it annotates. */}
                <Ionicons name="eye-outline" size={12} color={colors.textSubtle} />
                <Text style={styles.readOnlyBadgeText} allowFontScaling={false}>
                  {t("readonly.badge")}
                </Text>
              </View>
            ) : null}

            <View style={{ flex: 1 }} pointerEvents="none" />

            <NotificationBell
              onOpen={cancelStoreReview}
              onVisibilityChange={setNotificationInboxVisible}
            />
            {/* Profile chip — top-RIGHT. Phase 7: opens the unified
            ProfileSettingsSheet (replaces the deprecated hamburger +
            ProfileMenuSheet). The icon is either the user's Google
            avatar image, an initial-letter chip if signed in without
            an avatar URL, or a generic person-outline for local-only.
            D-HEADER-CLEANUP: marginTop hack removed — the parent
            row's alignItems:"center" now handles vertical centering
            against the title. hitSlop:10 brings the tap area to ~52px. */}
            <Pressable
              onPress={() => {
                if (profileOpening.current) return;
                profileOpening.current = true;
                Keyboard.dismiss();
                setVaultPickerVisible(false);
                setSettingsVisible(true);
                router.push("/profile");
              }}
              hitSlop={10}
              accessibilityRole="button"
              accessibilityLabel={t("menu.title.profile")}
              style={({ pressed }) => [
                styles.profileBtn,
                isRTL ? { marginRight: 12 } : { marginLeft: 12 },
                pressed && { opacity: 0.5 },
              ]}
            >
              {sessionUser?.picture_url ? (
                <Image source={{ uri: sessionUser.picture_url }} style={styles.profileAvatar} />
              ) : sessionUser ? (
                // Signed-in but no photo URL (the steady state for Sign in with
                // Apple) — metric-corrected initial-letter chip. Array.from takes
                // the first GRAPHEME so a surrogate-pair/emoji name never renders
                // half a codepoint (same rule as the settings sheet's initialFor).
                // `||`: an email account's name starts EMPTY, and falls through to
                // the address.
                <InitialAvatar
                  size={PROFILE_SLOT_SIZE}
                  label={(
                    Array.from((sessionUser.name?.trim() || sessionUser.email || "?").trim())[0] ??
                    "?"
                  ).toUpperCase()}
                />
              ) : (
                // Ionicons draws the person-circle glyph inset ~12% inside its
                // box, so the box gets +4 over the slot to optically match the
                // edge-to-edge photo/chip circles; margin -2 keeps the LAYOUT
                // footprint at exactly PROFILE_SLOT_SIZE so the header row
                // height is identical across all three auth states.
                <Ionicons
                  name="person-circle-outline"
                  size={PROFILE_SLOT_SIZE + 4}
                  style={{ margin: -2 }}
                  color={colors.textSubtle}
                />
              )}
            </Pressable>
          </View>

          <UpdateBanner />

          {/* Each host avoids only the keyboard overlap its native window leaves. */}
          <SearchKeyboardFrame style={styles.body} avoidAndroidKeyboard>
            <View style={styles.body}>
              {loaded && !activeVaultId ? (
                // No kaatas yet — a fresh account that hasn't created one, or one where
                // the last kaata was just left/archived. A DELIBERATE "create your
                // first kaata" screen; the app never silently auto-creates a kaata.
                // (Matee: "don't auto-create ... make a default screen for when there
                // are no kaatas, like onboarding the user to make a kaata".)
                <View style={styles.noKaataWrap}>
                  {/* Was a THIRD "there is nothing here" vocabulary: an 18/14 headline
              pair, a full step louder than the 15/13 every other empty moment in
              the app uses (home and person detail's fresh page). The
              shared atom now owns the glyph, the copy rhythm and the CTA slot.
              size="inline" (24px own air) rather than "page" (56): the wrapper's
              flex:1 centering already supplies the page air, and "page" would
              open a 56px hole between the icon and the title. */}
                  <EmptyState
                    size="inline"
                    icon="albums-outline"
                    title={t("home.noKaata.title")}
                    subtitle={t("home.noKaata.subtitle")}
                    action={
                      <>
                        <Button
                          label={t("home.noKaata.create")}
                          onPress={() => router.push("/vault/new")}
                        />
                        {/* PARKED (mesh): "Join an existing kaata" opened the offline QR scan
                    (vault/pair-scan), parked with the rest of mesh. Joining online
                    happens by opening an invite link (kaata://invite/<token>). Re-add
                    when mesh ships again.
                <Pressable
                  onPress={() => router.push("/vault/pair-scan")}
                  accessibilityRole="button"
                  style={({ pressed }) => [styles.noKaataLink, pressed && { opacity: 0.6 }]}
                >
                  <Text style={styles.noKaataLinkText}>{t("home.noKaata.join")}</Text>
                </Pressable>
                */}
                        {/* The archived link rides in `action` WITH the button rather than
                    after the atom, so the two stay one cluster — outside, the
                    atom's bottom padding would drop 24px between them. */}
                        {archivedVaults.length > 0 ? (
                          <Pressable
                            onPress={() => router.push("/vault/archived")}
                            accessibilityRole="button"
                            style={({ pressed }) => [
                              styles.noKaataLink,
                              pressed && { opacity: 0.6 },
                            ]}
                          >
                            <Text style={styles.noKaataLinkText}>
                              {t("home.noKaata.archived", { count: archivedVaults.length })}
                            </Text>
                          </Pressable>
                        ) : null}
                      </>
                    }
                    isRTL={isRTL}
                  />
                </View>
              ) : loaded && loadError && allPeople.length === 0 ? (
                // Load failed with nothing cached to show. Rendering the page here
                // would show "0" totals — the false data-loss signal this audience
                // is most sensitive to. A later successful retry clears this.
                <View style={styles.loadingFill}>
                  <Text style={styles.loadErrorText}>{t("home.loadFailed")}</Text>
                  <View style={{ height: 16 }} />
                  <Pressable
                    onPress={() => void load()}
                    accessibilityRole="button"
                    style={({ pressed }) => [styles.loadErrorRetry, pressed && { opacity: 0.85 }]}
                  >
                    <Text style={styles.loadErrorRetryText}>{t("common.tryAgain")}</Text>
                  </Pressable>
                </View>
              ) : loaded ? (
                <HomePage
                  key={summaryScopeKey}
                  active={currentPeopleScope && currentVaultScope}
                  direction={balanceFilter}
                  directionSwipeEnabled={directionControlsEnabled && !keyboardLayoutShown}
                  directionContextKey={JSON.stringify([
                    directionContextKey,
                    customerQuery,
                    effectiveGroup,
                    filterCurrencies,
                  ])}
                  directionCurrencyKey={JSON.stringify(selectedFilterCurrencies)}
                  onDirectionChange={changeSwipedDirection}
                  people={activeHomePeople}
                  settledPeople={settledHomePeople}
                  settledExpanded={settledExpanded}
                  onToggleSettled={() => {
                    if (
                      !isCurrentHome() ||
                      settledViewOwner.current.epoch !== settledViewEpoch ||
                      homeInteraction.current.selecting ||
                      homeInteraction.current.confirming ||
                      selectionBusyRef.current
                    )
                      return;
                    setSettledDisclosure((previous) => ({
                      epoch: settledViewEpoch,
                      expanded: !(previous.epoch === settledViewEpoch
                        ? previous.expanded
                        : customerQuery.trim().length > 0),
                    }));
                  }}
                  allPeople={visibleAllPeople}
                  summary={
                    <HomeBalanceSummary
                      people={visibleAllPeople}
                      balances={visibleBalances}
                      currency={selectedCurrency}
                      searchOpen={keyboardLayoutShown}
                      direction={balanceFilter}
                      currencyFilter={currencyFilter}
                      onDirectionChange={changeBalanceDirection}
                      interactionEnabled={directionControlsEnabled}
                      active={
                        currentPeopleScope && currentVaultScope && !filtersExpanded && !selecting
                      }
                    />
                  }
                  filtered={
                    customerQuery.trim().length > 0 ||
                    effectiveGroup !== "all" ||
                    balanceFilter !== "all" ||
                    !!currencyFilter
                  }
                  controls={inlineControls}
                  selectionControls={selectionToolbar}
                  selecting={selecting}
                  selectedIds={selectedIds}
                  selectionBusy={selectionBusy}
                  scrollRef={homeScrollRef}
                  scrollScope={homeScrollScope}
                  initialScrollY={homeScrollPosition.offset}
                  onScrollOffset={(offset) => {
                    homeScrollPosition.offset = offset;
                  }}
                  creditByPerson={creditByPerson}
                  sharedStatusByPerson={sharedStatusByPerson}
                  paddingBottom={24}
                  onPersonPress={openPerson}
                  onPersonLongPress={canAmend ? openHomePersonActions : undefined}
                />
              ) : (
                // Pre-load: spinner instead of the page. Rendering the page before
                // load() resolves flashed "0" totals + the first-run empty state at
                // every cold launch — a false "my ledger is gone" signal for a
                // shopkeeper with a full book.
                <View style={styles.loadingFill}>
                  <ActivityIndicator color={colors.textDefault} />
                </View>
              )}
            </View>
            {activeVaultId ? (
              <Animated.View
                testID="home-toast-dock"
                style={[
                  styles.homeToastDock,
                  {
                    transform: [
                      { translateY: keyboardLayoutShown || filtersExpanded ? 0 : toastOffset },
                    ],
                  },
                ]}
              >
                <SearchKeyboardFooter
                  style={styles.homeFooter}
                  closedPadding={12 + insets.bottom}
                  openPadding={8}
                  keyboardShown={keyboardLayoutShown}
                  onLayout={updateFilterAnchor}
                >
                  {searchDock}
                </SearchKeyboardFooter>
              </Animated.View>
            ) : null}
          </SearchKeyboardFrame>
        </SafeAreaView>
      </BlurTargetView>
      <HomeFilterPopover
        visible={filtersVisible}
        contextKey={homeScrollScope}
        anchor={filterAnchor}
        viewport={filterViewport}
        blurTarget={filterBlurTargetRef}
        disabled={controlsDisabled}
        keyboardVisible={keyboardShown}
        onDismissKeyboard={dismissKeyboard}
        onDismiss={() => {
          if (isCurrentHome() && !selectionBusyRef.current) setFiltersExpanded(false);
        }}
      >
        {filterContent}
      </HomeFilterPopover>

      {/* Phase 7 — unified settings sheet replaces HamburgerMenuSheet +
          ProfileMenuSheet. Opens from the profile chip top-RIGHT. All
          former hamburger entries migrated here per D-PROFILE-SLIDER /
          D-KILL-HAMBURGER:
            * Profile (sign-in/out, switch account)
            * Kaatas (vault list, add, "Manage this Kaata" → /vault/settings,
              which now also holds the former Preferences: language / region /
              currency / diagnostics)
            * Sync (Nearby toggle — Phase 7 NO sign-in gate, plus
              sync-to-cloud / restore-from-cloud)
            * About (version + build)
          Shop Mode toggle no longer pre-checks account_id — gating
          lives inside startShopMode() (throws ShopModeNotAvailableError
          when the device has no vault with a trust anchor; caught
          below and surfaced as a toast). */}
      <ProfileSettingsSource
        onPresent={() => {
          profileOpening.current = true;
          setSettingsVisible(true);
        }}
        ready={
          loaded &&
          activeAccountId === getAccountIdSync() &&
          activeVaultId === getActiveVaultIdSyncMaybe()
        }
        visible={settingsVisible}
        signedInUser={sessionUser}
        activeAccountId={activeAccountId}
        activeVaultId={activeVaultId}
        vaults={vaults}
        archivedCount={archivedVaults.length}
        onOpenArchived={() => router.push("/vault/archived")}
        shopModeEnabled={shopModeEnabled}
        shopModeBusy={shopModeBusy}
        activePeers={meshActivePeers}
        onDismiss={() => {
          profileOpening.current = false;
          setSettingsVisible(false);
        }}
        onSignOut={() => {
          setSignOutConfirm(true);
        }}
        onSelectVault={async (vaultId) => {
          try {
            await setActiveVaultId(vaultId);
            await load();
            void refreshCreditPolicies(vaultId).catch(() => undefined);
            toast.push(t("menu.allKaatas.switched"), "success");
          } catch (err) {
            console.warn("[home] setActiveVaultId failed", err);
            toast.push(t("menu.allKaatas.switchFailed"), "error");
          }
        }}
        onAddVault={() => router.push("/vault/new")}
        onManageCurrentKaata={() => router.push("/vault/settings")}
        onOpenAccount={() => router.push("/account")}
        onToggleShopMode={async (next) => {
          if (shopModeBusy) return;
          // Phase 7 D-SHOP-MODE-UNGATING: account_id is NOT required.
          // The pre-condition becomes "has at least one vault with a
          // trust anchor", which startShopMode() enforces by throwing
          // ShopModeNotAvailableError on failure. We catch that below
          // and surface a toast.
          // Phase 5.1 battery dialog still applies on first toggle-on.
          if (next && Platform.OS === "android") {
            const shouldPrompt = await shouldPromptBatteryExemption();
            if (shouldPrompt) {
              setBatteryDialogOpen(true);
              return;
            }
            // Already saw the one-time explainer — but may still NOT be on the
            // Doze whitelist (an older build only opened settings; or they
            // declined). The exemption is the load-bearing swipe-survival
            // permission, so re-assert the REAL intent on every enable until
            // granted. No-ops (resolves true) when already exempt.
            try {
              const exempt = await isIgnoringBatteryOptimizations();
              if (!exempt) await requestBatteryExemption();
            } catch {
              /* best-effort */
            }
            // One-time OEM autostart prompt (MIUI/EMUI etc.) on devices that have
            // such a screen — fires after this toggle-on completes (below).
            if (await shouldPromptOemAutostart()) setOemDialogOpen(true);
          }
          setShopModeBusy(true);
          // Optimistic flip — revert on failure.
          setShopModeEnabled(next);
          try {
            const mesh = await import("../lib/mesh");
            if (next) {
              // BLE runtime perms must be granted BEFORE calling
              // startShopMode — otherwise startBLEPeripheralMode hits a
              // SecurityException for BLUETOOTH_ADVERTISE and the OS
              // kills the process. The MeshController owns the rationale
              // dialog flow, but for the home-screen-direct toggle we
              // skip the rationale and request immediately. If the user
              // denies, we throw and the catch below reverts the toggle
              // with an honest toast.
              if (Platform.OS === "android") {
                const perms = await import("../lib/mesh/ble-permissions");
                const has = await perms.hasBlePermissions();
                if (!has) {
                  const res = await perms.requestBlePermissions();
                  if (res.kind === "never_ask_again") {
                    // The OS will never show the dialog again — a generic
                    // "could not toggle" toast here was a dead end users
                    // retried in vain. Route to system settings instead.
                    setShopModeEnabled(false);
                    setBleSettingsDialogOpen(true);
                    return;
                  }
                  if (res.kind !== "ok") {
                    throw new Error("BLE permission required for Nearby sync");
                  }
                }
              }
              await mesh.startShopMode();
              // ONE toggle: also turn on the native background engine + inject
              // the signing seed (sync IS background sync).
              await applyFullSync(true);
              toast.push(t("menu.sync.shopMode.startedToast"), "success");
            } else {
              // userInitiated: this is the ONE path that clears the persisted
              // intent. startShopMode (on) writes "1"; stopShopMode (off, here)
              // writes "0". Every other stop preserves intent so the mesh
              // auto-resumes on the next launch.
              await mesh.stopShopMode({ userInitiated: true });
              await applyFullSync(false);
            }
          } catch (err) {
            const terminal = err instanceof Error && err.name === "ShopModeNotAvailableError";
            if (terminal) {
              // No mesh-eligible vault — honestly revert AND clear the intent
              // (there is nothing to auto-resume to).
              setShopModeEnabled(false);
              await setAppMeta("shop_mode_enabled", "0");
              toast.push(err.message, "error");
            } else {
              // Transient (Bluetooth momentarily off, radio busy, FGS race).
              // Keep the intent ON — startShopMode already persisted "1", and
              // MeshController retries with backoff and again on next launch.
              // Flipping the toggle back OFF here is exactly the behaviour the
              // user complained about, so we leave it ON and stay quiet.
              if (__DEV__) console.warn("[home] shop mode start retrying", err);
            }
          } finally {
            setShopModeBusy(false);
          }
        }}
      />

      <ConfirmDialog
        visible={selecting && confirmRemoveIds !== null}
        title={t("selection.removeContactsTitle", { count: confirmRemoveIds?.length ?? 0 })}
        description={t("selection.removeContactsDescription")}
        confirmLabel={t("selection.remove")}
        destructive
        onCancel={() => {
          if (
            !isCurrentHome() ||
            selectionBusyRef.current ||
            confirmingIdsRef.current !== confirmRemoveIds ||
            confirmationVersion !== selectionConfirmationVersion.current
          )
            return;
          selectionConfirmationVersion.current++;
          setConfirmRemoveIds(null);
        }}
        onConfirm={() => {
          if (
            !isCurrentHome() ||
            selectionBusyRef.current ||
            confirmRemoveIds === null ||
            confirmingIdsRef.current !== confirmRemoveIds ||
            confirmationVersion !== selectionConfirmationVersion.current
          )
            return;
          selectionConfirmationVersion.current++;
          void removeSelected();
        }}
      />

      <BottomSheet
        visible={sheetFor !== null}
        title={sheetFor?.name}
        onDismiss={() => {
          if (isCurrentHome()) setSheetFor(null);
        }}
        actions={[
          ...(canSelect
            ? [
                {
                  label: t("selection.start"),
                  icon: "checkmark-circle-outline" as const,
                  onPress: () => startSelection(sheetFor ?? undefined),
                },
              ]
            : []),
          {
            label: t("person.sheet.edit"),
            icon: "create-outline",
            onPress: () => {
              if (!isCurrentHome() || !canSelectRef.current || selectionBusyRef.current) return;
              const person = sheetFor && homeInteraction.current.people.get(sheetFor.id);
              if (person) router.push({ pathname: "/person/[id]/edit", params: { id: person.id } });
            },
          },
          {
            label: t("common.remove"),
            icon: "trash-outline",
            destructive: true,
            onPress: () => {
              if (!isCurrentHome() || !canSelectRef.current || selectionBusyRef.current) return;
              const person = sheetFor && homeInteraction.current.people.get(sheetFor.id);
              if (person) setConfirmDeleteFor(person);
            },
          },
        ]}
      />

      <ConfirmDialog
        visible={confirmDeleteFor !== null}
        title={t("common.remove.title", { name: confirmDeleteFor?.name ?? "" })}
        description={t("common.remove.description")}
        confirmLabel={t("common.remove")}
        destructive
        onConfirm={async () => {
          // Close the dialog FIRST — ConfirmDialog doesn't self-dismiss, and
          // the success toast renders beneath the dialog's Modal, so leaving
          // it open reads as "the tap did nothing" and invites a second
          // Confirm tap (re-running archivePerson).
          const target = confirmDeleteFor;
          if (
            !isCurrentHome() ||
            !canSelectRef.current ||
            !target ||
            singleDeleteRef.current !== target ||
            !homeInteraction.current.people.has(target.id) ||
            !activeVaultId
          )
            return;
          singleDeleteRef.current = null;
          setConfirmDeleteFor(null);
          try {
            await archivePerson(target.id, { vaultId: activeVaultId, accountId: activeAccountId });
            if (!isCurrentHome()) return;
            await load();
            if (isCurrentHome()) toast.push(t("common.removed", { name: target.name }), "success");
          } catch (err) {
            console.warn("[home] archivePerson failed", err);
            if (isCurrentHome()) toast.push(t("entry.deleteFailed"), "error");
          }
        }}
        onCancel={() => {
          if (!isCurrentHome() || singleDeleteRef.current !== confirmDeleteFor) return;
          singleDeleteRef.current = null;
          setConfirmDeleteFor(null);
        }}
      />

      {/* Phase 7 D-TOP-LEFT-SWITCHER — vault switcher sheet, opened by
          tapping the kaata name in the header. Sole source of truth for
          the vault list is `vaults` loaded in load(); ProfileSettingsSheet
          consumes the same array. */}
      <VaultPickerSheet
        visible={vaultPickerVisible}
        activeVaultId={activeVaultId}
        vaults={vaults}
        archivedCount={archivedVaults.length}
        onViewArchived={() => {
          setVaultPickerVisible(false);
          setTimeout(() => router.push("/vault/archived"), 220);
        }}
        onSelectVault={async (vaultId) => {
          try {
            await setActiveVaultId(vaultId);
            await load();
            void refreshCreditPolicies(vaultId).catch(() => undefined);
            toast.push(t("menu.allKaatas.switched"), "success");
          } catch (err) {
            console.warn("[home] setActiveVaultId failed", err);
            toast.push(t("menu.allKaatas.switchFailed"), "error");
          }
        }}
        onAddVault={() => router.push("/vault/new")}
        onDismiss={() => setVaultPickerVisible(false)}
      />

      {/* Phase 5.1 — first-time-only battery optimization exemption
          prompt. Shown when the user toggles Nearby sync on for the first
          time on Android. We can't programmatically request the exemption
          (Play Store policy), so we deep-link to system Settings on Confirm.
          On Skip we DO NOT enable Nearby sync — the dialog title is phrased
          as an additive permission ask, so the user's expectation when
          tapping Skip is "don't do it" not "do it without the permission".
          The user can re-toggle later and the prompt won't re-appear
          (markBatteryExemptionPrompted is called on both paths). */}
      <ConfirmDialog
        visible={batteryDialogOpen}
        title={t("menu.battery.title")}
        description={t("menu.battery.description")}
        confirmLabel={t("menu.battery.confirm")}
        cancelLabel={t("menu.battery.skip")}
        onConfirm={async () => {
          setBatteryDialogOpen(false);
          await markBatteryExemptionPrompted();
          setShopModeBusy(true);
          try {
            await setAppMeta("shop_mode_enabled", "1");
            setShopModeEnabled(true);
            // ONE toggle: enable the native background engine + seed too.
            await applyFullSync(true);
            // Fire the REAL Doze-exemption dialog (Briar parity). Without the OS
            // whitelist, hostile OEMs kill the process on swipe before the FGS can
            // revive — the load-bearing fix for "the notification doesn't persist".
            // Falls back to the settings deep-link if the intent can't be fired.
            const ok = await requestBatteryExemption().catch(() => false);
            if (!ok) {
              await Linking.openSettings().catch(() => {
                /* user can navigate manually */
              });
            }
          } finally {
            setShopModeBusy(false);
          }
          // After the battery step, the OEM autostart screen (MIUI/EMUI) is the
          // remaining real-world killer — prompt once on devices that have it.
          if (await shouldPromptOemAutostart()) setOemDialogOpen(true);
        }}
        onCancel={async () => {
          setBatteryDialogOpen(false);
          await markBatteryExemptionPrompted();
          // Skip path: leave Nearby sync OFF. The toggle in the
          // hamburger sheet stays in its original (off) position because
          // shopModeEnabled was never mutated.
        }}
      />

      {/* OEM autostart / protected-apps (MIUI/EMUI/ColorOS…) — the killer the Doze
          whitelist doesn't stop. Shown once after the battery step on devices that
          have such a screen. We can't detect whether the user granted it (unlike
          battery), so we just open the screen and mark prompted either way. */}
      <ConfirmDialog
        visible={oemDialogOpen}
        title={t("menu.oemAutostart.title")}
        description={t("menu.oemAutostart.description")}
        confirmLabel={t("menu.oemAutostart.confirm")}
        cancelLabel={t("menu.battery.skip")}
        onConfirm={async () => {
          setOemDialogOpen(false);
          await markOemAutostartPrompted();
          await openOemAutostartSettings().catch(() => false);
        }}
        onCancel={async () => {
          setOemDialogOpen(false);
          await markOemAutostartPrompted();
        }}
      />

      {/* BLE permission permanently denied ("Don't ask again") — the OS
          suppresses further permission dialogs, so the only recovery is
          system settings. Reuses the same copy MeshController's rationale
          flow shows for this state. */}
      <ConfirmDialog
        visible={bleSettingsDialogOpen}
        title={t("menu.ble.permDenied.title")}
        description={t("menu.ble.permDenied.body")}
        confirmLabel={t("menu.ble.permDenied.openSettings")}
        cancelLabel={t("menu.ble.permDenied.cancel")}
        onConfirm={() => {
          setBleSettingsDialogOpen(false);
          void Linking.openSettings().catch(() => {
            /* user can navigate manually */
          });
        }}
        onCancel={() => setBleSettingsDialogOpen(false)}
      />

      {/* UX critique #6 — sign-out confirmation. The body interpolates
          the current email when known so the user knows which account
          they're exiting; falls back to a generic phrasing when only
          a local session exists (shouldn't happen in practice — the
          row only renders when signedInUser is set — but the fallback
          keeps the t() call total). */}
      <ConfirmDialog
        visible={signOutConfirm}
        title={t("menu.account.signOut.confirm.title")}
        description={
          sessionUser?.email
            ? t("menu.account.signOut.confirm.body", {
                email: sessionUser.email,
              })
            : t("menu.account.signOut.confirm.bodyGeneric")
        }
        confirmLabel={t("menu.account.signOut.confirm.cta")}
        destructive
        onConfirm={async () => {
          setSignOutConfirm(false);
          // Sign-out hits the backend + clears the session + reloads; show the
          // overlay so the screen doesn't look frozen.
          setSigningOut(true);
          try {
            await signOut();
            await load();
            setTimeout(() => toast.push(t("menu.account.signOut.toast"), "success"), 240);
          } catch (err) {
            console.warn("[home] signOut failed", err);
            setTimeout(() => toast.push(t("menu.account.signOut.failed"), "error"), 240);
          } finally {
            setSigningOut(false);
          }
        }}
        onCancel={() => setSignOutConfirm(false)}
      />

      {/* Sign-out runs after the settings sheet has closed, so a plain
          overlay can block interaction without another native Modal. */}
      {signingOut ? (
        <View style={styles.authOverlay} pointerEvents="auto">
          <ActivityIndicator size="large" color={colors.textInverted} />
          <Text style={[styles.authOverlayText, textDir(isRTL)]}>
            {t("menu.account.signOut.pending")}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

type CustomerRowsProps = {
  people: PersonWithBalance[];
  creditByPerson: Record<string, CreditStatus>;
  sharedStatusByPerson: Record<string, ReturnType<typeof personSharedAccountStatus>>;
  onPersonPress: (person: PersonWithBalance) => void;
  // Omitted for a viewer (read-only) — long-press opens the edit/delete sheet.
  onPersonLongPress?: (person: PersonWithBalance) => void;
  selecting?: boolean;
  selectedIds?: ReadonlySet<string>;
  selectionBusy?: boolean;
  showDirection?: boolean;
};

type GroupFilterChipProps = {
  groupFilterLabel: string | null;
  groupFilterCount: number;
  onClearGroupFilter: () => void;
};

type CustomerScrollProps = {
  scrollRef: React.RefObject<ScrollViewInstance | null>;
  paddingBottom: number;
};

/** One bordered card keeps the existing row behavior in idle and search. */
function CustomerRows(props: CustomerRowsProps) {
  const {
    people,
    creditByPerson,
    sharedStatusByPerson,
    onPersonPress,
    onPersonLongPress,
    selecting,
    selectedIds,
    selectionBusy,
    showDirection,
  } = props;
  // Reuse the visible page's rows during unrelated Home updates. Rebuild only
  // when displayed data, selection or actions change.
  const rows = useMemo(
    () =>
      people.map((item, index) => (
        <View key={item.id}>
          {index > 0 ? <View style={styles.divider} /> : null}
          <PersonRow
            person={item}
            creditStatus={creditByPerson[item.id] ?? "none"}
            sharedStatus={sharedStatusByPerson[item.id]}
            onPress={onPersonPress}
            onLongPress={onPersonLongPress}
            selecting={selecting}
            selected={selecting && selectedIds?.has(item.id)}
            disabled={selectionBusy}
            showDirection={showDirection}
          />
        </View>
      )),
    [
      people,
      creditByPerson,
      sharedStatusByPerson,
      onPersonPress,
      onPersonLongPress,
      selecting,
      selectedIds,
      selectionBusy,
      showDirection,
    ],
  );
  return <View style={styles.peopleCard}>{rows}</View>;
}

function GroupFilterChip(props: GroupFilterChipProps) {
  if (!props.groupFilterLabel) return null;
  return (
    <CustomerFilterChip
      label={t(props.groupFilterCount > 1 ? "groups.viewMany" : "groups.view", {
        name: props.groupFilterLabel,
      })}
      clearHint={t("groups.clearFilter")}
      onClear={props.onClearGroupFilter}
    />
  );
}

function CustomerFilterChip(props: { label: string; clearHint: string; onClear: () => void }) {
  const isRTL = useIsRTL();
  return (
    <Pressable
      onPress={props.onClear}
      accessibilityRole="button"
      accessibilityLabel={props.label}
      accessibilityHint={props.clearHint}
      hitSlop={{ top: 6, bottom: 6 }}
      style={({ pressed }) => [
        styles.groupChip,
        rowDir(isRTL),
        pressed && { backgroundColor: colors.bgMuted },
      ]}
    >
      <Text style={[styles.groupChipText, textDir(isRTL)]} numberOfLines={1}>
        {props.label}
      </Text>
      <Ionicons name="close" size={14} color={colors.textSubtle} />
    </Pressable>
  );
}

function HomePage(
  props: CustomerRowsProps &
    CustomerScrollProps & {
      active: boolean;
      allPeople: PersonWithBalance[];
      settledPeople: PersonWithBalance[];
      settledExpanded: boolean;
      onToggleSettled: () => void;
      filtered: boolean;
      controls: React.ReactNode;
      selectionControls: React.ReactNode;
      summary: React.ReactNode;
      scrollScope: string;
      initialScrollY: number;
      onScrollOffset: (offset: number) => void;
      direction: CustomerBalanceFilter;
      directionSwipeEnabled: boolean;
      directionContextKey: string;
      directionCurrencyKey: string;
      onDirectionChange: (direction: CustomerBalanceFilter) => void;
    },
) {
  const isRTL = useIsRTL();
  const nativeScrollGesture = useMemo(
    () => Gesture.Native().shouldActivateOnStart(false).disallowInterruption(false),
    [],
  );
  const [selectionSize, setSelectionSize] = useState({ scope: props.scrollScope, height: 0 });
  const selectionLayout = useRef({
    scope: props.scrollScope,
    active: Boolean(props.selecting),
    version: 0,
  });
  if (
    selectionLayout.current.scope !== props.scrollScope ||
    selectionLayout.current.active !== Boolean(props.selecting)
  ) {
    selectionLayout.current = {
      scope: props.scrollScope,
      active: Boolean(props.selecting),
      version: selectionLayout.current.version + 1,
    };
  }
  const selectionVersion = selectionLayout.current.version;
  const selectionHeight = selectionSize.scope === props.scrollScope ? selectionSize.height : 0;
  useLayoutEffect(() => {
    props.scrollRef.current?.scrollTo({ y: props.initialScrollY, animated: false });
    // Keep the customer scroll position scoped to the current book and account.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.scrollRef, props.scrollScope]);
  return (
    <View
      style={styles.body}
      pointerEvents={props.active ? "auto" : "none"}
      accessibilityElementsHidden={!props.active}
      importantForAccessibility={props.active ? "auto" : "no-hide-descendants"}
    >
      {props.selecting && props.selectionControls ? (
        <View
          testID="home-selection-toolbar"
          style={styles.selectionTop}
          pointerEvents="box-none"
          onLayout={(event) => {
            const { height } = event.nativeEvent.layout;
            if (
              !selectionLayout.current.active ||
              selectionLayout.current.scope !== props.scrollScope ||
              selectionLayout.current.version !== selectionVersion ||
              !Number.isFinite(height) ||
              height <= 0
            )
              return;
            setSelectionSize((previous) =>
              previous.scope === props.scrollScope && previous.height === height
                ? previous
                : { scope: props.scrollScope, height },
            );
          }}
        >
          {props.selectionControls}
        </View>
      ) : null}
      <GestureDetector gesture={nativeScrollGesture}>
        <ScrollView
          key={props.scrollScope}
          ref={props.scrollRef}
          style={styles.body}
          scrollEnabled={props.active}
          bounces
          alwaysBounceVertical
          overScrollMode="always"
          stickyHeaderIndices={[1]}
          onScroll={(event) => {
            if (props.active) props.onScrollOffset(Math.max(0, event.nativeEvent.contentOffset.y));
          }}
          scrollEventThrottle={64}
          keyboardShouldPersistTaps="always"
          keyboardDismissMode={Platform.OS === "ios" ? "interactive" : "on-drag"}
          contentContainerStyle={{
            flexGrow: 1,
          }}
        >
          <View
            testID="home-balance-section"
            style={[styles.topSection, props.selecting && styles.hiddenBalanceSection]}
            pointerEvents={props.selecting ? "none" : "auto"}
            accessibilityElementsHidden={Boolean(props.selecting)}
            importantForAccessibility={props.selecting ? "no-hide-descendants" : "auto"}
          >
            {props.summary}
          </View>
          {/* Only the divider pins beneath navigation after the cards scroll away. */}
          <View
            testID="home-nav-divider"
            style={[styles.navDivider, props.selecting && styles.hiddenBalanceSection]}
            pointerEvents="none"
            accessible={false}
          />
          <HomeBalanceFilterSwipe
            testID="home-customer-content"
            enabled={props.active && props.directionSwipeEnabled}
            contextKey={props.directionContextKey}
            currencyKey={props.directionCurrencyKey}
            direction={props.direction}
            nativeGesture={nativeScrollGesture}
            onDirectionChange={props.onDirectionChange}
            style={[
              styles.customerContent,
              {
                paddingTop: props.selecting ? selectionHeight + 12 : 12,
                paddingBottom: props.paddingBottom,
              },
            ]}
          >
            {props.controls}
            {props.people.length === 0 && props.settledPeople.length === 0 ? (
              <EmptyState
                title={t(props.filtered ? "customers.noResults" : "home.empty.title")}
                subtitle={props.filtered ? undefined : t("home.empty.subtitle")}
                isRTL={isRTL}
              />
            ) : props.people.length > 0 ? (
              <CustomerRows {...props} showDirection />
            ) : null}
            <SettledAccountsSection
              count={props.settledPeople.length}
              expanded={props.settledExpanded}
              onToggle={props.onToggleSettled}
              disabled={props.selecting || props.selectionBusy || !props.active}
            >
              <CustomerRows {...props} people={props.settledPeople} showDirection />
            </SettledAccountsSection>
          </HomeBalanceFilterSwipe>
        </ScrollView>
      </GestureDetector>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bgDefault },
  body: { flex: 1, minHeight: 0 },
  topSection: {
    flexShrink: 0,
    backgroundColor: colors.bgDefault,
  },
  navDivider: { height: StyleSheet.hairlineWidth, backgroundColor: colors.borderDefault },
  customerContent: { flexGrow: 1, minHeight: 0 },
  authOverlay: {
    ...StyleSheet.absoluteFill,
    backgroundColor: "rgba(0,0,0,0.55)",
    alignItems: "center",
    justifyContent: "center",
    gap: 16,
    zIndex: 100,
  },
  authOverlayText: {
    fontSize: 15,
    fontFamily: fonts.sansMedium,
    color: colors.textInverted,
    textAlign: "center",
    paddingHorizontal: 32,
  },
  // The kaata button and profile actions share a compact header. The parent
  // SafeAreaView owns the status-bar inset.
  header: {
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 10,
    alignItems: "center",
  },
  // Title row — kaata name + chevron. flex:1 ensures very long shop
  // names truncate at numberOfLines:1 instead of pushing the avatar
  // off-screen. alignItems:"center" centers the chevron against the
  // title text's row box (line-height 32). minHeight:40 matches the
  // avatar's tap-target row so the header's total height is stable
  // whether the title is rendered or self is still loading. The
  // earlier 52px reserved a slot for a subname; Phase 7 removed the
  // subname, so 40 is the right target (32px title row + 8px breathing
  // room).
  //
  // Phase 7 D-TOP-LEFT-SWITCHER: this is a Pressable that opens
  // VaultPickerSheet. rowDir(isRTL) applied inline flips the order
  // of the title column + chevron in RTL.
  headerTitleBlock: {
    // flexShrink (NOT flex:1) so the tappable switcher hugs the name + chevron
    // — its tap target must NOT span the whole header (that made a tap left of
    // the avatar open the kaata picker). A sibling flex:1 spacer fills the gap.
    // flexShrink:1 + the inner textCol's flexShrink + numberOfLines:1 still let
    // a long shop name truncate instead of pushing the avatar off-screen.
    flexShrink: 1,
    // The reserve must cover the TITLE's platform-resolved line box (44 on
    // iOS via the sansLineHeight floor, 32 on Android — see headerTitle), or
    // the whole home content jumps down when `self` loads and the title
    // mounts. 40 = the avatar tap-target row, the Android-era minimum.
    minHeight: Math.max(40, sansLineHeight(28, 32)),
    alignItems: "center",
  },
  kaataButton: {
    minHeight: Math.max(44, sansLineHeight(20, 26) + 14),
    minWidth: 0,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderWidth: 1,
    borderColor: colors.borderDefault,
    borderRadius: 14,
    backgroundColor: colors.bgDefault,
  },
  kaataButtonPressed: {
    backgroundColor: colors.bgMuted,
    borderColor: colors.borderEmphasis,
  },
  kaataButtonTitle: {
    fontFamily: fonts.sansSemi,
    fontSize: 18,
    lineHeight: sansLineHeight(18, 24),
    letterSpacing: 0,
  },
  // Inner column for title + subname. flexShrink:1 (NOT flex:1) so the
  // column takes its natural content width and the chevron sits IMMEDIATELY
  // next to the title text — not pushed to the far edge of the header row.
  // flexShrink lets long names truncate (numberOfLines:1) instead of
  // pushing the chevron off-screen.
  headerTitleTextCol: {
    flexShrink: 1,
  },
  // Display title — 28px bold with -0.5 letter-spacing. Deliberately
  // NOT -0.7 (the SF Pro Display target) because Vazirmatn's Latin
  // metrics collapse on letter pairs like "mn"/"rn" at that tightness;
  // -0.5 still reads as a deliberate display setting without the
  // kerning artifacts. lineHeight 32 hugs the cap height plus a hair
  // of breathing room. includeFontPadding:false strips Android's
  // invisible glyph padding so the title aligns pixel-perfect with
  // the avatar's cap-height rather than drifting a few px low.
  headerTitle: {
    // typography.display IS this style's old triple verbatim — 28 / sansBold /
    // sansLineHeight(28, 32) — so spreading the token is pixel-identical and
    // just stops the app's largest text from re-typing the scale. The 32 hugs
    // the cap height on Android (includeFontPadding:false trims the font's
    // padding); iOS is floored at Vazirmatn's natural height by the helper —
    // see the lineHeight invariant in lib/fonts.ts. This was the first reported
    // clip site (iPhone: shop name sliced at the top). headerTitleBlock's
    // minHeight above still spells sansLineHeight(28, 32) out longhand because
    // it needs the NUMBER for a layout reserve, not a text style.
    ...typography.display,
    color: colors.textEmphasis,
    // NO letterSpacing, and deliberately NOT trackingSafe(isRTL) either: this
    // renders the shopkeeper's OWN shop name, typed by them. An Afghan
    // shopkeeper running the app in English very often names their shop in
    // Persian script, so gating tracking on the app's locale would still
    // shred it. It is also the largest text in the app and on screen at every
    // single launch — the most expensive possible place to get this wrong.
    includeFontPadding: false,
  },
  // Profile button — wraps either the Google avatar Image, an
  // initial-letter chip, or an Ionicons person-circle fallback.
  // D-HEADER-CLEANUP: no marginTop — the parent header row's
  // alignItems:"center" centers this against the title row natively.
  // Empty rule kept (rather than deleted) so the inline marginLeft /
  // marginRight composes onto a defined base; without an entry here,
  // the inline overrides would still work, but keeping the slot makes
  // future tweaks easy. The headerSubname style was removed alongside
  // its JSX (Phase 7 founder feedback — the user-name subtitle is gone).
  profileBtn: {},
  // Read-only badge in the header (viewer on a shared kaata).
  readOnlyBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 3,
    paddingHorizontal: 7,
    paddingVertical: 3,
    borderRadius: 999,
    backgroundColor: colors.bgMuted,
  },
  readOnlyBadgeText: {
    fontSize: 11,
    fontFamily: fonts.sansMedium,
    color: colors.textSubtle,
  },
  // Google avatar Image — PROFILE_SLOT_SIZE circle. RN's Image disk-caches
  // the Google CDN URL automatically. bgMuted fills the circle while the
  // image is loading so the slot doesn't flash empty on cold launch. The
  // initial-letter variant lives in components/InitialAvatar (shared with
  // the settings sheet) — its centering math is deliberately NOT inlined
  // here.
  profileAvatar: {
    width: PROFILE_SLOT_SIZE,
    height: PROFILE_SLOT_SIZE,
    borderRadius: PROFILE_SLOT_SIZE / 2,
    backgroundColor: colors.bgMuted,
  },
  groupChip: {
    alignItems: "center",
    gap: 6,
    maxWidth: "100%",
    minWidth: 0,
    flexShrink: 1,
    minHeight: 32,
    paddingHorizontal: 12,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: colors.borderDefault,
    backgroundColor: colors.bgDefault,
  },
  groupChipText: {
    flexShrink: 1,
    fontFamily: fonts.sansMedium,
    fontSize: 13,
    color: colors.textDefault,
  },
  loadingFill: { flex: 1, alignItems: "center", justifyContent: "center" },
  // No-kaatas empty state (fresh account / after leaving the last kaata).
  noKaataWrap: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 32,
  },
  // noKaataTitle / noKaataSub / noKaataBtnWrap are GONE — the title + subtitle
  // are EmptyState's now (15/13 instead of this screen's private 18/14), and the
  // CTA sits in its `action` slot, so the stretch wrapper has nothing to stretch.
  noKaataLink: { paddingVertical: 12 },
  noKaataLinkText: {
    fontSize: 14,
    fontFamily: fonts.sansMedium,
    color: colors.textSubtle,
    textAlign: "center",
  },
  loadErrorText: {
    fontSize: 14,
    fontFamily: fonts.sansRegular,
    color: colors.textSubtle,
    textAlign: "center",
    paddingHorizontal: 32,
  },
  loadErrorRetry: {
    paddingHorizontal: 22,
    paddingVertical: 12,
    borderRadius: 8,
    backgroundColor: colors.actionPrimary,
  },
  loadErrorRetryText: {
    fontSize: 14,
    fontFamily: fonts.sansSemi,
    color: colors.textInverted,
  },
  // The people list is ONE bordered card (uniform border on all 4 sides +
  // overflow:hidden to clip the rounded corners). overflow:hidden is safe on this
  // plain wrapper View (the old blank-row bug was overflow:hidden on intrinsic-
  // height FlatList CELLS — this is not a cell). Replaces the per-row border
  // emulation, whose asymmetric first/last borders Android rendered wrong.
  peopleCard: {
    marginHorizontal: 16,
    borderWidth: 1,
    borderColor: colors.borderDefault,
    borderRadius: 12,
    overflow: "hidden",
    backgroundColor: colors.bgDefault,
  },
  divider: { height: 1, backgroundColor: colors.borderDefault },
  homeToastDock: {
    backgroundColor: colors.bgDefault,
    paddingBottom: HOME_DOCK_SKIRT,
    marginBottom: -HOME_DOCK_SKIRT,
  },
  homeFooter: {
    paddingHorizontal: 16,
    paddingTop: 8,
    backgroundColor: colors.bgDefault,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.borderDefault,
  },
  inlineControls: { marginHorizontal: 16, marginBottom: 12 },
  filterChipRow: { flexWrap: "wrap", alignItems: "center", gap: 8, width: "100%" },
  searchRow: { flexDirection: "row", direction: "ltr", gap: 8, alignItems: "center" },
  searchField: {
    flexDirection: "row",
    direction: "ltr",
    flex: 1,
    minWidth: 0,
    minHeight: 52,
    paddingHorizontal: 12,
    gap: 8,
    borderWidth: 1,
    borderColor: colors.borderDefault,
    borderRadius: 12,
    alignItems: "center",
    backgroundColor: colors.bgDefault,
  },
  searchInput: {
    flex: 1,
    minWidth: 0,
    minHeight: 50,
    paddingVertical: 10,
    fontSize: 15,
    fontFamily: fonts.sansRegular,
    color: colors.textDefault,
  },
  filterButton: {
    width: 52,
    height: 52,
    borderWidth: 1,
    borderColor: colors.borderDefault,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.bgDefault,
  },
  filterButtonActive: { backgroundColor: colors.actionPrimary, borderColor: colors.actionPrimary },
  resultsHeading: { marginTop: 4 },
  resultCount: { fontSize: 13, fontFamily: fonts.sansRegular, color: colors.textSubtle },
  clearLabel: {
    fontSize: 13,
    fontFamily: fonts.sansSemi,
    color: colors.textDefault,
    paddingVertical: 8,
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
  hiddenBalanceSection: { display: "none" },
  keyboardDismiss: {
    width: FAB_SIZE,
    height: FAB_SIZE,
    borderRadius: FAB_SIZE / 2,
    borderWidth: 1,
    borderColor: colors.borderDefault,
    backgroundColor: colors.bgDefault,
    alignItems: "center",
    justifyContent: "center",
  },
  fabInner: {
    width: FAB_SIZE,
    height: FAB_SIZE,
    // Circle = its size / 2, matching the rest of the action family.
    borderRadius: FAB_SIZE / 2,
    backgroundColor: colors.actionPrimary,
    alignItems: "center",
    justifyContent: "center",
  },
});
