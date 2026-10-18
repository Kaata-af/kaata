import { Ionicons } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import {
  Redirect,
  useFocusEffect as useRouteFocusEffect,
  useLocalSearchParams,
  useRouter,
} from "expo-router";
import { useSearchFocusEffect as useFocusEffect } from "../lib/use-search-focus-effect";
import { createContext, memo, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  AppState,
  Animated,
  BackHandler,
  Image,
  Keyboard,
  KeyboardAvoidingView,
  Linking,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import {
  Gesture, GestureDetector, createNativeWrapper,
} from "react-native-gesture-handler";
import Reanimated, { cancelAnimation, ReduceMotion, useAnimatedReaction, useAnimatedStyle, useEvent, useSharedValue, withTiming, type EventHandlerProcessed } from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import { BottomSheet } from "../components/BottomSheet";
import { useSheetMotionPreference } from "../components/SheetBackdrop";
import { CustomerListOptions } from "../components/CustomerListSheet";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { Button } from "../components/Button";
import { EmptyState } from "../components/EmptyState";
import { InitialAvatar } from "../components/InitialAvatar";
import { NotificationBell } from "../components/NotificationInbox";
import { PersonRow } from "../components/PersonRow";
import { SearchFieldTrigger } from "../components/SearchFieldTrigger";
import { SearchSheet } from "../components/SearchSheet";
import { afterNativeSearchClosed } from "../lib/native-search";
import { SelectionToolbar } from "../components/SelectionToolbar";
import { summarizeSelectedPeople } from "../lib/selection-summary";
import { ProfileSettingsSheet, type VaultListItem } from "../components/ProfileSettingsSheet";
import { Tabs } from "../components/Tabs";
import { useToast, useToastOffset } from "../components/Toast";
import { UpdateBanner } from "../components/UpdateBanner";
import { useAppMeta } from "../lib/app-meta-context";
import { colors } from "../lib/colors";
import { splitSearchQuery } from "../lib/contacts-merge";
import { searchCustomerMatches } from "../lib/search";
import { applyVaultCurrency, getCurrentCurrencySymbol } from "../lib/currency";
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
  listAllVaultsIncludingArchived,
  setAppMeta,
} from "../lib/db";
import {
  clearActiveVaultId,
  getAccountIdSync,
  getActiveVaultId,
  getActiveVaultIdSyncMaybe,
  onAccountIdentityChanged,
  setActiveVaultId,
} from "../lib/db-tx";
import { readCustomerGroups, type CustomerGroup } from "../lib/customer-groups";
import {
  customerSide,
  availableCustomerGroupFilter,
  DEFAULT_CUSTOMER_LIST,
  DEFAULT_CUSTOMER_SEARCH,
  isNeverTalliedCustomer,
  parseCustomerSearchPreference,
  selectCustomers,
  selectNeverTalliedCustomers,
  selectSearchCustomers,
  selectedCustomerGroupIds,
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
import { syncActiveVaultNow } from "../lib/sync/scheduler";
import { syncAllTabs } from "../lib/tabs/sync";
import { bidiIsolate, rowDir, textDir, trackingSafe, useIsRTL } from "../lib/direction";
import { fonts, sansLineHeight } from "../lib/fonts";
import { formatAmount } from "../lib/format";
import { sumAmounts } from "../lib/money";
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
import type { Direction, PersonWithBalance, Self } from "../lib/types";

// Header profile-slot diameter. One constant for ALL THREE variants (Google
// photo, initial-letter chip, signed-out icon) so the top-right chrome never
// changes size with auth state. 36 (up from 32): the old 32px slot read
// undersized against the large-title header — most visibly on iPhones, where
// Apple sign-in has no photo URL so the letter chip is the steady state.
const PROFILE_SLOT_SIZE = 36;

// Add button and search share the 52px action height used by the other docks.
const FAB_SIZE = 52;
const EMPTY_PEOPLE: PersonWithBalance[] = [];

// Mirror RNGH's native scroll/refresh wrappers, with Animated INNER children so
// their native gesture events register on UI rather than crossing to RN.
const HomeNativeScrollView = createNativeWrapper(Reanimated.ScrollView, {
  shouldCancelWhenOutside: false, disallowInterruption: false, shouldActivateOnStart: false,
}) as typeof import("react-native-gesture-handler").ScrollView;
const HomeNativeRefreshControl = createNativeWrapper(Reanimated.createAnimatedComponent(RefreshControl), {
  shouldCancelWhenOutside: false, disallowInterruption: false, shouldActivateOnStart: false,
});

// Tab labels are computed at render time so locale changes (after a hot reload
// during dev) flow through. The keys remain stable identifiers.
function buildTabs() {
  return [
    { key: "collect" as const, label: t("home.tab.collect") },
    { key: "pay" as const, label: t("home.tab.pay") },
  ];
}

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
  // Phase 5.1: ?menu=sync deep-link from the foreground-service notification
  // tap auto-opens the hamburger menu on focus. We don't currently scroll
  // to the Sync section — every section is on a single sheet, so opening
  // the sheet is enough.
  const params = useLocalSearchParams<{ menu?: string }>();
  const toastOffset = useToastOffset();
  const insets = useSafeAreaInsets();
  const { forceUpdate } = useAppMeta();
  // Subscribes to locale changes — flipping language in Settings re-renders
  // this screen (and all its children) without an app restart. Strings via
  // t() refresh on the same render.
  const isRTL = useIsRTL();
  const reducedHomeMotion = useSheetMotionPreference();

  const [self, setSelf] = useState<Self | null>(null);
  const [direction, setDirection] = useState<Direction>("collect");
  const [allPeople, setAllPeople] = useState<PersonWithBalance[]>([]);
  const [peopleForSearch, setPeopleForSearch] = useState<PersonWithBalance[]>([]);
  const [peopleScope, setPeopleScope] = useState<{
    vaultId: string | null;
    accountId: string | null;
  } | null>(null);
  const [customerQuery, setCustomerQuery] = useState("");
  const [searchVisible, setSearchVisible] = useState(false);
  const [searchAutoFocus, setSearchAutoFocus] = useState(true);
  const searchGeneration = useRef(0);
  const homeSwipeEpoch = useRef(0);
  const homeSwipePresentation = useRef({ from: direction, scope: "", blocked: true, reducedMotion: reducedHomeMotion });
  const homeSwipeUILease = useSharedValue({ epoch: 0, ...homeSwipePresentation.current });
  const homeSwipeOffset = useSharedValue(0);
  const homeSwipeBodyStyle = useAnimatedStyle(() => ({ transform: [{ translateX: homeSwipeOffset.value }] }));
  const homeScrollRestoreFrame = useRef<number | null>(null);
  const homeScrollRestoreGeneration = useRef(0);
  const resumeHomeScrollRestore = useRef<() => void>(() => {});
  const cancelHomeScrollRestore = useCallback(() => {
    if (homeScrollRestoreFrame.current !== null) {
      cancelAnimationFrame(homeScrollRestoreFrame.current);
      homeScrollRestoreFrame.current = null;
    }
  }, []);
  const invalidateHomeScrollRestore = useCallback(() => {
    homeScrollRestoreGeneration.current++;
    cancelHomeScrollRestore();
  }, [cancelHomeScrollRestore]);
  const invalidateHomeSwipe = useCallback(() => {
    homeSwipeUILease.value = { epoch: ++homeSwipeEpoch.current, ...homeSwipePresentation.current };
  }, [homeSwipeUILease]);
  const dismissSearchKeyboard = useCallback(() => {
    Keyboard.dismiss();
  }, []);
  const [customerGroups, setCustomerGroups] = useState<CustomerGroup[]>([]);
  const [groupByPerson, setGroupByPerson] = useState<Record<string, string[]>>({});
  const [listPreference, setListPreference] =
    useState<CustomerListPreference>(DEFAULT_CUSTOMER_SEARCH);
  const [creditByPerson, setCreditByPerson] = useState<Record<string, CreditStatus>>({});
  const preferenceVersion = useRef(0),
    loadGeneration = useRef(0);
  const locale = getLocale();
  const [sheetFor, setSheetFor] = useState<PersonWithBalance | null>(null);
  const [confirmDeleteFor, setConfirmDeleteFor] = useState<PersonWithBalance | null>(null);
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedPersonIds, setSelectedPersonIds] = useState<string[]>([]);
  const [confirmRemoveIds, setConfirmRemoveIds] = useState<string[] | null>(null);
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
  const [refreshing, setRefreshing] = useState(false);
  // Phase 7: unified settings sheet — replaces the hamburger AND the
  // old ProfileMenuSheet. One state flag, one entry point on the profile
  // chip top-RIGHT. sessionUser is read on focus so it stays in sync with
  // sign-in/out actions taken on the Account screen. The full user object
  // is kept (not just the email) so the header icon can render the user's
  // actual Google avatar when picture_url is set.
  const [settingsVisible, setSettingsVisible] = useState(false);
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
    searchGeneration.current++;
    setSearchVisible(false);
    setCustomerQuery("");
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
    const current = () =>
      generation === loadGeneration.current &&
      getActiveVaultIdSyncMaybe() === requestedVault &&
      getAccountIdSync() === requestedAccount;
    // The whole body is guarded: any rejection here (SQLite error,
    // SecureStore decrypt failure after a backup-restore to a new phone)
    // previously meant setLoaded(true) never ran — an infinite spinner on
    // the ROOT screen with no retry and no back.
    try {
      const [s, searchList, user, vaultId, shopRaw] = await Promise.all([
        getLocalSelf(),
        listAllPeopleForSearch(requestedVault),
        getSessionUser(),
        getActiveVaultId(),
        getAppMeta("shop_mode_enabled"),
      ]);
      const [groupState, prefRaw, creditPolicies] = await Promise.all([
        vaultId
          ? readCustomerGroups(vaultId)
          : Promise.resolve({ groups: [], groupByPerson: {}, groupsByPerson: {} }),
        vaultId
          ? getAppMeta(`customer_search:${requestedAccount ?? "local"}:${vaultId}`)
          : Promise.resolve(null),
        vaultId
          ? readCreditPoliciesForPeople(vaultId)
          : Promise.resolve<Record<string, CreditPolicy>>({}),
      ]);
      if (!current() || requestedVault !== vaultId) return;
      // Make the display currency follow the active vault before amounts paint
      // (currency is per-vault; the global symbol otherwise lags behind a
      // switch/restore). Awaited so getCurrentCurrencySymbol() is correct on
      // this render.
      await applyVaultCurrency(vaultId);
      if (!current()) return;

      setSelf(s);
      // Every saved active customer stays visible. Financial lists and the
      // neutral "No tallies yet" section split this full list at render time.
      setAllPeople(searchList);
      setPeopleForSearch(searchList);
      setPeopleScope({ vaultId: requestedVault, accountId: requestedAccount });
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
      setCreditByPerson(
        Object.fromEntries(
          searchList.map((person) => [
            person.id,
            creditStatusForBalance(creditPolicies[person.id] ?? null, person.balance),
          ]),
        ),
      );
      if (prefVersion === preferenceVersion.current) {
        const preference = parseCustomerSearchPreference(prefRaw);
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
            setPeopleForSearch([]);
            setPeopleScope(null);
            setCustomerGroups([]);
            setGroupByPerson({});
            setCreditByPerson({});
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
    }, [load]),
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
  useEffect(() => onAccountIdentityChanged(() => {
    invalidateHomeScrollRestore();
    invalidateHomeSwipe();
    void load().finally(() => resumeHomeScrollRestore.current());
  }), [load, invalidateHomeSwipe, invalidateHomeScrollRestore]);

  // Pull-to-refresh — with mesh/vault sync now core, entries can land while
  // the shopkeeper sits on this screen (the dominant shop-counter posture).
  // useFocusEffect alone never picks those up.
  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      const vaultId = getActiveVaultIdSyncMaybe();
      // Fetch what other members and linked contacts wrote, not only re-read
      // this phone: one sync cycle of the open kaata plus a shared-account
      // sweep, each bounded so a bad connection cannot hold the spinner.
      await Promise.all([
        vaultId ? refreshCreditPolicies(vaultId).catch(() => undefined) : undefined,
        syncActiveVaultNow(),
        Promise.race([
          syncAllTabs({ discover: true }),
          new Promise<void>((resolve) => setTimeout(resolve, 8_000)),
        ]),
      ]);
      await load();
    } finally {
      setRefreshing(false);
    }
  }, [load]);

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

  // Phase 7: open the unified settings sheet when arriving with ?menu=sync
  // (from the foreground-service notification tap). The URL param key
  // stays "menu" so the foreground-service deep-link contract doesn't
  // need an EAS rebuild — only the destination sheet changed.
  useEffect(() => {
    if (params.menu === "sync") {
      setSettingsVisible(true);
    }
  }, [params.menu]);

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
  useRouteFocusEffect(
    useCallback(() => {
      const sub = BackHandler.addEventListener("hardwareBackPress", () => {
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

  // Home always shows the full default overview. Query, groups and sort belong
  // only to the search sheet, including when its query is empty.
  const currentPeopleScope =
    peopleScope?.vaultId === getActiveVaultIdSyncMaybe() &&
    peopleScope?.accountId === getAccountIdSync();
  const visibleAllPeople = currentPeopleScope ? allPeople : EMPTY_PEOPLE;
  const visibleSearchPeople = currentPeopleScope ? peopleForSearch : EMPTY_PEOPLE;
  const searching = searchVisible && currentPeopleScope && currentVaultScope;
  const searchMatches = useMemo(
    () => searching
      ? searchCustomerMatches(splitSearchQuery(customerQuery), visibleSearchPeople)
      : { people: EMPTY_PEOPLE, relevanceById: new Map<string, number>() },
    [searching, visibleSearchPeople, customerQuery],
  );
  // Keep the two financial orders stable while switching tabs. Each cached
  // direction group keeps its own hero and ID-keyed rows; only its wrapper flips.
  const homePeople = useMemo(() => {
    const collect = selectCustomers(visibleAllPeople, "collect", DEFAULT_CUSTOMER_LIST, groupByPerson, locale);
    const pay = selectCustomers(visibleAllPeople, "pay", DEFAULT_CUSTOMER_LIST, groupByPerson, locale);
    return { collect, pay };
  }, [visibleAllPeople, groupByPerson, locale]);
  const activePeople = homePeople[direction];
  const neverTalliedPeople = useMemo(
    () =>
      selectNeverTalliedCustomers(visibleAllPeople, DEFAULT_CUSTOMER_LIST, groupByPerson, locale),
    [visibleAllPeople, groupByPerson, locale],
  );
  const searchPeople = useMemo(
    () => searching
      ? selectSearchCustomers(
        searchMatches.people,
        listPreference,
        groupByPerson,
        locale,
        searchMatches.relevanceById,
      )
      : EMPTY_PEOPLE,
    [searching, searchMatches, listPreference, groupByPerson, locale],
  );
  const canSelect = caps.resolved && canAmend && currentVaultScope && currentPeopleScope;
  const selecting = searching && selectionMode && canSelect;
  const canSelectRef = useRef(canSelect);
  canSelectRef.current = canSelect;
  const selectablePeople = searchPeople;
  const selectableIds = useMemo(
    () => new Set(selectablePeople.map((person) => person.id)),
    [selectablePeople],
  );
  const selectedIds = useMemo(() => {
    const available = new Set(visibleAllPeople.map((person) => person.id));
    return new Set(selectedPersonIds.filter((id) => available.has(id)));
  }, [selectedPersonIds, visibleAllPeople]);
  // The list already carries each account's totals from the same local read.
  // Selecting only adds those cached amounts; the count and figures change together.
  const financialSummary = useMemo(
    () => summarizeSelectedPeople(visibleAllPeople.filter((person) => selectedIds.has(person.id))),
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
  }, [activeVaultId, activeAccountId, canSelect]);
  useEffect(() => {
    const available = new Set(visibleAllPeople.map((person) => person.id));
    setSelectedPersonIds((ids) => {
      const next = ids.filter((id) => available.has(id));
      return next.length === ids.length ? ids : next;
    });
    setConfirmRemoveIds(null);
  }, [visibleAllPeople]);
  useEffect(() => setConfirmRemoveIds(null), [selectableIds]);
  useFocusEffect(
    useCallback(() => {
      selectionOwnerActive.current = true;
      resumeHomeScrollRestore.current();
      return () => {
        selectionOwnerActive.current = false;
        invalidateHomeScrollRestore();
        invalidateHomeSwipe();
        searchGeneration.current++;
        setSearchVisible(false);
        selectionGeneration.current++;
        setSelectionMode(false);
        setSelectedPersonIds([]);
        setConfirmRemoveIds(null);
      };
    }, [invalidateHomeSwipe, invalidateHomeScrollRestore]),
  );
  const startSelection = useCallback(
    (person?: PersonWithBalance) => {
      if (
        !mounted.current ||
        !selectionOwnerActive.current ||
        !canSelect ||
        selectionBusyRef.current ||
        activeVaultId !== getActiveVaultIdSyncMaybe() ||
        activeAccountId !== getAccountIdSync()
      )
        return;
      dismissSearchKeyboard();
      if (!searching) {
        searchGeneration.current++;
        setCustomerQuery("");
        preferenceVersion.current++;
        setListPreference({ ...DEFAULT_CUSTOMER_SEARCH });
        setSearchVisible(true);
      }
      setSearchAutoFocus(false);
      selectionGeneration.current++;
      setSelectedPersonIds(
        person && visibleAllPeople.some((row) => row.id === person.id) ? [person.id] : [],
      );
      setSelectionMode(true);
      Haptics.selectionAsync().catch(() => undefined);
    },
    [canSelect, dismissSearchKeyboard, visibleAllPeople, activeVaultId, activeAccountId, searching],
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
      getAccountIdSync() === accountId;
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
  const homeAll = useMemo(() => ({
    collect: visibleAllPeople.filter((p) => !isNeverTalliedCustomer(p) && customerSide(p) === "collect"),
    pay: visibleAllPeople.filter((p) => !isNeverTalliedCustomer(p) && customerSide(p) === "pay"),
  }), [visibleAllPeople]);
  const activeAll = homeAll[direction];
  const homePeopleById = useMemo(
    () => new Map(visibleAllPeople.map((person) => [person.id, person])),
    [visibleAllPeople],
  );
  const homeInteraction = useRef({ direction, searching, people: homePeopleById });
  homeInteraction.current = { direction, searching, people: homePeopleById };
  const effectiveGroup = useMemo(
    () => availableCustomerGroupFilter(listPreference.group, customerGroups),
    [listPreference.group, customerGroups],
  );
  useEffect(() => {
    if (JSON.stringify(listPreference.group) !== JSON.stringify(effectiveGroup))
      setListPreference((p) => ({ ...p, group: effectiveGroup }));
  }, [effectiveGroup, listPreference.group]);
  const listCustomized =
    effectiveGroup !== "all" || listPreference.sort !== DEFAULT_CUSTOMER_SEARCH.sort;
  // The active group is named only inside search; it never filters home.
  const groupFilterLabel = useMemo(() => {
    if (effectiveGroup === "all") return null;
    if (effectiveGroup === "ungrouped") return t("groups.ungrouped");
    const names = selectedCustomerGroupIds(effectiveGroup)
      .map((id) => customerGroups.find((group) => group.id === id)?.name)
      .filter((name): name is string => !!name);
    return names.length ? names.join(locale === "fa" ? "، " : ", ") : null;
  }, [effectiveGroup, customerGroups, locale]);
  const groupFilterCount =
    effectiveGroup === "all" || effectiveGroup === "ungrouped"
      ? 1
      : selectedCustomerGroupIds(effectiveGroup).length;
  // A new order starts at its top; otherwise the first rows of a re-sorted
  // long list are scrolled off-screen.
  const homeScrollRef = useRef<ScrollView>(null);
  const homeSwipePanRef = useRef<ReturnType<typeof Gesture.Pan> | undefined>(undefined);
  const homeRefreshGestureRef = useRef<React.ComponentRef<typeof HomeNativeRefreshControl>>(null);
  const homeNativeGestureEvent = useEvent(() => {
    "worklet";
    // Native relations own these events. No RN bookkeeping or state is needed.
  }, ["onGestureHandlerEvent", "onGestureHandlerStateChange"]);
  // One native page stays mounted across tabs. Only the current side takes
  // layout space; each side remembers its own scroll position without renders.
  const nativeHomeScroll = Platform.OS === "android";
  const searchRequest = searchGeneration.current;
  const homeScrollScope = JSON.stringify([activeAccountId, activeVaultId]);
  const homeScrollPositions = useRef({
    scope: homeScrollScope,
    collect: 0,
    pay: 0,
  });
  if (homeScrollPositions.current.scope !== homeScrollScope) {
    homeScrollPositions.current = { scope: homeScrollScope, collect: 0, pay: 0 };
  }
  // RN 0.86 performance.now() and Android scroll timestamps both use monotonic
  // boot time (uptimeMillis). A new drag
  // must cross this barrier before it can own the reused view's scroll events.
  const homePage = useMemo(() => ({
    initialOffset: { x: 0, y: homeScrollPositions.current[direction] },
    ignoreThrough: performance.now(),
    dragStartedAt: null as number | null,
    dragSearchRequest: null as number | null,
    lastNativeTimestamp: -1,
    restorationPending: true,
    restorationStarted: false,
  }), [direction, homeScrollScope]);
  const activeHomePage = useRef(homePage);
  activeHomePage.current = homePage;
  const homePositions = homeScrollPositions.current;
  const isCurrentHomePage = useCallback(() =>
    mounted.current && selectionOwnerActive.current && !searching &&
    searchGeneration.current === searchRequest && currentVaultScope && currentPeopleScope &&
    activeVaultId === getActiveVaultIdSyncMaybe() && activeAccountId === getAccountIdSync() &&
    activeHomePage.current === homePage && homeScrollPositions.current === homePositions,
  [searching, searchRequest, currentVaultScope, currentPeopleScope, activeVaultId, activeAccountId,
    homePage, homePositions]);
  const restoreHomeScroll = useCallback(() => {
    if (!nativeHomeScroll || !isCurrentHomePage() || !homePage.restorationPending) return;
    // The imperative RN command aborts an Android fling, unlike contentOffset.
    // It must run even when both sides restore to the same numeric offset.
    const scroll = homeScrollRef.current;
    if (!scroll) return;
    if (!homePage.restorationStarted) {
      homePage.ignoreThrough = performance.now();
      homePage.restorationStarted = true;
    }
    scroll.scrollTo({ ...homePage.initialOffset, animated: false });
  }, [nativeHomeScroll, isCurrentHomePage, homePage]);
  useLayoutEffect(restoreHomeScroll, [restoreHomeScroll, loaded]);
  useLayoutEffect(() => invalidateHomeScrollRestore, [homePage, invalidateHomeScrollRestore]);
  const queueHomeScrollRestore = useCallback(() => {
    if (!nativeHomeScroll || !isCurrentHomePage() || !homePage.restorationPending) return;
    cancelHomeScrollRestore();
    const generation = homeScrollRestoreGeneration.current;
    // Fabric emits onLayout before its native mount, and executes commands
    // before mount items. Keep the immediate fling abort, then cross the next
    // UI dispatch once so a deep restore sees the destination's native height.
    const frame = requestAnimationFrame(() => {
      if (homeScrollRestoreFrame.current !== frame) return;
      homeScrollRestoreFrame.current = null;
      if (homeScrollRestoreGeneration.current === generation) restoreHomeScroll();
    });
    homeScrollRestoreFrame.current = frame;
  }, [restoreHomeScroll, cancelHomeScrollRestore, nativeHomeScroll, isCurrentHomePage, homePage]);
  resumeHomeScrollRestore.current = queueHomeScrollRestore;
  const homeContentSizeChanged = useCallback(() => {
    restoreHomeScroll();
    queueHomeScrollRestore();
  }, [restoreHomeScroll, queueHomeScrollRestore]);
  const beginHomeScroll = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    if (!nativeHomeScroll || !isCurrentHomePage()) return;
    const timestamp = (event.nativeEvent as NativeScrollEvent & { timestamp?: number }).timestamp;
    if (typeof timestamp !== "number" || !Number.isFinite(timestamp) ||
        timestamp <= homePage.ignoreThrough || timestamp < homePage.lastNativeTimestamp) return;
    homePage.dragStartedAt = timestamp;
    homePage.dragSearchRequest = searchRequest;
    homePage.lastNativeTimestamp = timestamp;
    homePage.restorationPending = false;
    invalidateHomeScrollRestore();
    const y = event.nativeEvent.contentOffset.y;
    if (Number.isFinite(y)) homePositions[direction] = Math.max(0, y);
  }, [nativeHomeScroll, isCurrentHomePage, homePage, homePositions, direction, searchRequest,
    invalidateHomeScrollRestore]);
  const rememberHomeScroll = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    if (!isCurrentHomePage()) return;
    if (nativeHomeScroll) {
      const timestamp = (event.nativeEvent as NativeScrollEvent & { timestamp?: number }).timestamp;
      if (homePage.dragStartedAt === null || homePage.dragSearchRequest !== searchRequest ||
          typeof timestamp !== "number" || !Number.isFinite(timestamp) ||
          timestamp <= homePage.ignoreThrough || timestamp < homePage.dragStartedAt ||
          timestamp < homePage.lastNativeTimestamp) return;
      homePage.lastNativeTimestamp = timestamp;
    }
    const y = event.nativeEvent.contentOffset.y;
    if (Number.isFinite(y)) homePositions[direction] = Math.max(0, y);
  }, [nativeHomeScroll, isCurrentHomePage, direction, homePage, homePositions, searchRequest]);
  const searchScrollRef = useRef<ScrollView>(null);
  const listOrderKey = `${listPreference.sort}|${JSON.stringify(effectiveGroup)}`;
  const shownListOrderKey = useRef(listOrderKey);
  useEffect(() => {
    if (shownListOrderKey.current === listOrderKey) return;
    shownListOrderKey.current = listOrderKey;
    searchScrollRef.current?.scrollTo({ y: 0, animated: false });
  }, [listOrderKey]);
  useEffect(() => {
    searchScrollRef.current?.scrollTo({ y: 0, animated: false });
  }, [customerQuery]);
  const changeListPreference = (preference: CustomerListPreference) => {
    if (!isCurrentSearch() || selectionBusyRef.current) return;
    preferenceVersion.current++;
    setListPreference(preference);
    void setAppMeta(
      `customer_search:${activeAccountId ?? "local"}:${activeVaultId}`,
      JSON.stringify(preference),
    ).catch(() => {
      if (isCurrentSearch()) toast.push(t("entry.saveFailed"), "error");
    });
  };
  const isCurrentSearch = () =>
    mounted.current &&
    selectionOwnerActive.current &&
    searching &&
    searchGeneration.current === searchRequest &&
    activeVaultId === getActiveVaultIdSyncMaybe() &&
    activeAccountId === getAccountIdSync();
  const closeSearch = () => {
    if (!isCurrentSearch() || selectionBusyRef.current) return;
    searchGeneration.current++;
    closeSelection();
    setSearchVisible(false);
    dismissSearchKeyboard();
  };
  const openSearch = () => {
    if (
      !mounted.current ||
      !selectionOwnerActive.current ||
      !currentVaultScope ||
      !currentPeopleScope ||
      selectionBusyRef.current ||
      activeVaultId !== getActiveVaultIdSyncMaybe() ||
      activeAccountId !== getAccountIdSync()
    )
      return;
    searchGeneration.current++;
    closeSelection();
    setSearchAutoFocus(true);
    setSearchVisible(true);
  };

  const selectDirection = useCallback((next: Direction) => {
    if (
      mounted.current && selectionOwnerActive.current && !searching &&
      searchGeneration.current === searchRequest &&
      currentVaultScope && currentPeopleScope &&
      activeVaultId === getActiveVaultIdSyncMaybe() &&
      activeAccountId === getAccountIdSync()
    ) {
      // Even tapping the current tab invalidates a completed swipe queued on JS.
      invalidateHomeSwipe();
      if (next !== homeInteraction.current.direction) {
        activeHomePage.current.dragStartedAt = null;
        activeHomePage.current.dragSearchRequest = null;
      }
      setDirection(next);
    }
  }, [searching, searchRequest, currentVaultScope, currentPeopleScope,
      activeVaultId, activeAccountId, invalidateHomeSwipe]);

  const homeSwipeBlocked = !loaded || forceUpdate || !self || !currentVaultScope ||
    !currentPeopleScope || searchVisible || searching || settingsVisible || vaultPickerVisible ||
    sheetFor !== null || confirmDeleteFor !== null || batteryDialogOpen || oemDialogOpen ||
    bleSettingsDialogOpen || signOutConfirm || signingOut || selectionBusy || refreshing;
  const homeSwipeLease = useMemo(() => ({
    epoch: ++homeSwipeEpoch.current,
    direction,
    searchRequest,
    blocked: homeSwipeBlocked,
    vaultId: activeVaultId,
    accountId: activeAccountId,
  }), [direction, searchRequest, homeSwipeBlocked, activeVaultId, activeAccountId, reducedHomeMotion]);
  const liveHomeSwipeLease = useRef(homeSwipeLease);
  liveHomeSwipeLease.current = homeSwipeLease;
  homeSwipePresentation.current = {
    from: direction, scope: JSON.stringify([activeAccountId, activeVaultId, searchRequest]),
    blocked: homeSwipeBlocked || !selectionOwnerActive.current, reducedMotion: reducedHomeMotion,
  };
  useLayoutEffect(() => {
    homeSwipeUILease.value = { epoch: homeSwipeEpoch.current, ...homeSwipePresentation.current };
  }, [homeSwipeLease, homeSwipeUILease]);
  const completeHomeSwipe = useCallback((epoch: number, from: Direction, target: Direction) => {
    const lease = liveHomeSwipeLease.current;
    if (!mounted.current || !selectionOwnerActive.current || lease.blocked ||
        epoch !== homeSwipeEpoch.current || lease.direction !== from ||
        lease.searchRequest !== searchGeneration.current ||
        lease.vaultId !== getActiveVaultIdSyncMaybe() || lease.accountId !== getAccountIdSync() ||
        (target !== "collect" && target !== "pay") || target === from) return;
    selectDirection(target);
  }, [selectDirection]);
  const homeSwipeStroke = useSharedValue({
    epoch: -1, from: "collect" as Direction, startedAt: 0, x: 0, y: 0,
    activated: false, blocked: true, commitRequested: false,
  });
  // Cancel a live UI stroke as soon as its owner changes, before its end can
  // cross to RN. This supported mapper also makes native event delivery bounded
  // in Reanimated 4.5, whose event path waits for the first mapper registry.
  useAnimatedReaction(
    () => homeSwipeUILease.value,
    (lease, previous) => {
      const stroke = homeSwipeStroke.value;
      if (stroke.epoch !== lease.epoch && !stroke.blocked) {
        homeSwipeStroke.value = { ...stroke, blocked: true };
      }
      cancelAnimation(homeSwipeOffset);
      const freshStroke = stroke.epoch === lease.epoch && !stroke.blocked;
      if (previous && !freshStroke && !lease.blocked && !previous.blocked &&
          !lease.reducedMotion && !previous.reducedMotion &&
          lease.scope === previous.scope && lease.from !== previous.from) {
        // Only the committed content enters; there is no second page or rail.
        homeSwipeOffset.value = lease.from === "pay" ? 24 : -24;
        homeSwipeOffset.value = withTiming(0, { duration: 170, reduceMotion: ReduceMotion.System });
      } else {
        homeSwipeOffset.value = 0;
      }
    },
  );
  const homeSwipe = useMemo(() => Gesture.Pan()
    .withRef(homeSwipePanRef)
    .enabled(Platform.OS !== "web" && !homeSwipeBlocked)
    .maxPointers(1)
    .activeOffsetX([-24, 24])
    .failOffsetY([-12, 12])
    .hitSlop({ left: -24, right: -24 })
    .onTouchesDown((event, manager) => {
      "worklet";
      cancelAnimation(homeSwipeOffset);
      homeSwipeOffset.value = 0;
      const touch = event.allTouches[0];
      if (event.numberOfTouches !== 1 || !touch ||
          !Number.isFinite(touch.absoluteX) || !Number.isFinite(touch.absoluteY)) {
        homeSwipeStroke.value = { ...homeSwipeStroke.value, blocked: true };
        manager.fail();
        return;
      }
      const lease = homeSwipeUILease.value;
      homeSwipeStroke.value = {
        epoch: lease.epoch, from: lease.from, startedAt: performance.now(),
        x: touch.absoluteX, y: touch.absoluteY, activated: false, blocked: false, commitRequested: false,
      };
    })
    .onTouchesMove((event, manager) => {
      "worklet";
      const stroke = homeSwipeStroke.value;
      // Only a hold BEFORE horizontal activation belongs to the row long-press.
      // An already activated swipe may continue slowly for as long as needed.
      if (event.numberOfTouches !== 1 || stroke.blocked ||
          (!stroke.activated && performance.now() - stroke.startedAt >= 350)) {
        homeSwipeStroke.value = { ...stroke, blocked: true };
        cancelAnimation(homeSwipeOffset);
        homeSwipeOffset.value = 0;
        manager.fail();
      }
    })
    .onStart(() => {
      "worklet";
      const stroke = homeSwipeStroke.value;
      homeSwipeStroke.value = { ...stroke, activated: true,
        blocked: stroke.blocked || performance.now() - stroke.startedAt >= 350 };
    })
    .onUpdate((event) => {
      "worklet";
      const stroke = homeSwipeStroke.value;
      const lease = homeSwipeUILease.value;
      const dx = event.absoluteX - stroke.x;
      const dy = event.absoluteY - stroke.y;
      const outward = (dx > 0 && stroke.from === "collect") || (dx < 0 && stroke.from === "pay");
      homeSwipeOffset.value = stroke.blocked || !stroke.activated || stroke.epoch !== lease.epoch ||
        lease.blocked || lease.reducedMotion || outward || !Number.isFinite(dx) || !Number.isFinite(dy) ||
        Math.abs(dy) > 24 || Math.abs(dx) < Math.abs(dy) * 2 ? 0 : Math.max(-24, Math.min(24, dx * 0.12));
    })
    .onEnd((event, success) => {
      "worklet";
      const stroke = homeSwipeStroke.value;
      const lease = homeSwipeUILease.value;
      homeSwipeStroke.value = { ...stroke, blocked: true, commitRequested: false };
      cancelAnimation(homeSwipeOffset);
      if (homeSwipeOffset.value !== 0 && !lease.reducedMotion) {
        homeSwipeOffset.value = withTiming(0, { duration: 120, reduceMotion: ReduceMotion.System });
      } else homeSwipeOffset.value = 0;
      if (!success || stroke.blocked || !stroke.activated || stroke.epoch !== lease.epoch ||
          lease.blocked || event.numberOfPointers > 1) return;
      // Pan translation resets at activation on Android. Absolute coordinates
      // preserve the complete displacement from the original finger down.
      const dx = event.absoluteX - stroke.x;
      const dy = event.absoluteY - stroke.y;
      if (!Number.isFinite(dx) || !Number.isFinite(dy) ||
          Math.abs(dx) < 60 || Math.abs(dy) > 24 || Math.abs(dx) < Math.abs(dy) * 2) return;
      // The physical tab order stays Collect (left), Pay (right), including FA.
      const target: Direction = dx < 0 ? "pay" : "collect";
      if (target !== stroke.from) {
        homeSwipeStroke.value = { ...stroke, blocked: true, commitRequested: true };
        scheduleOnRN(completeHomeSwipe, stroke.epoch, stroke.from, target);
      }
    })
    .onFinalize(() => {
      "worklet";
      const stroke = homeSwipeStroke.value;
      if (!stroke.commitRequested) {
        cancelAnimation(homeSwipeOffset);
        if (homeSwipeOffset.value !== 0 && !homeSwipeUILease.value.reducedMotion) {
          homeSwipeOffset.value = withTiming(0, { duration: 120, reduceMotion: ReduceMotion.System });
        } else homeSwipeOffset.value = 0;
      }
      homeSwipeStroke.value = { ...stroke, blocked: true };
    }), [homeSwipeBlocked, homeSwipeUILease, homeSwipeStroke, homeSwipeOffset, completeHomeSwipe, homeSwipePanRef]);

  // Stable row handlers — PersonRow is memoized, and these two props must
  // keep their identity across renders or every row re-renders on each
  // toast push / locale flip (see PersonRow's memo rationale).
  const openPerson = useCallback(
    (p: PersonWithBalance) => {
      if (!mounted.current || !selectionOwnerActive.current ||
          activeVaultId !== getActiveVaultIdSyncMaybe() || activeAccountId !== getAccountIdSync())
        return;
      if (searching && !isCurrentSearch()) return;
      if (selecting) {
        if (selectionBusyRef.current || !selectableIds.has(p.id)) return;
        setSelectedPersonIds((ids) =>
          ids.includes(p.id) ? ids.filter((id) => id !== p.id) : [...ids, p.id],
        );
        return;
      }
      if (searching) {
        closeSearch();
        const request = searchGeneration.current;
        const open = () => {
          if (
            mounted.current &&
            request === searchGeneration.current &&
            activeVaultId === getActiveVaultIdSyncMaybe() &&
            activeAccountId === getAccountIdSync()
          )
            router.push({ pathname: "/person/[id]", params: { id: p.id } });
        };
        if (
          !afterNativeSearchClosed(`${activeAccountId ?? "local"}:${activeVaultId ?? "none"}`, open)
        )
          open();
      } else {
        const current = homeInteraction.current;
        const person = current.people.get(p.id);
        if (current.searching || !person ||
            (!isNeverTalliedCustomer(person) && customerSide(person) !== current.direction)) return;
        router.push({ pathname: "/person/[id]", params: { id: p.id } });
      }
    },
    [router, activeVaultId, activeAccountId, selecting, selectableIds, searching, searchRequest],
  );
  const openHomePersonActions = useCallback((p: PersonWithBalance) => {
    const current = homeInteraction.current;
    const person = current.people.get(p.id);
    if (!mounted.current || !selectionOwnerActive.current || !canSelectRef.current ||
        current.searching || activeVaultId !== getActiveVaultIdSyncMaybe() ||
        activeAccountId !== getAccountIdSync() || !person ||
        (!isNeverTalliedCustomer(person) && customerSide(person) !== current.direction)) return;
    setSheetFor(person);
  }, [activeVaultId, activeAccountId]);

  // Reuse the exact child elements on a tab tap. Their text, row props and
  // measured widths do not change; the two outer group wrappers own visibility.
  const cachedHomeContents = useMemo(() => nativeHomeScroll ? {
    collect: (
      <HomeDirectionContent
        direction="collect"
        people={homePeople.collect}
        allPeople={homeAll.collect}
        hasNeutral={neverTalliedPeople.length > 0}
        creditByPerson={creditByPerson}
        onPersonPress={openPerson}
        onPersonLongPress={canAmend ? openHomePersonActions : undefined}
      />
    ),
    pay: (
      <HomeDirectionContent
        direction="pay"
        people={homePeople.pay}
        allPeople={homeAll.pay}
        hasNeutral={neverTalliedPeople.length > 0}
        creditByPerson={creditByPerson}
        onPersonPress={openPerson}
        onPersonLongPress={canAmend ? openHomePersonActions : undefined}
      />
    ),
  } : null, [nativeHomeScroll, homePeople, homeAll, neverTalliedPeople, creditByPerson,
    openPerson, openHomePersonActions, canAmend, locale]);

  const confirmationVersion = selectionConfirmationVersion.current;
  const selectionToolbar = selecting ? (
    <SelectionToolbar
      count={selectedIds.size}
      total={selectablePeople.length}
      financialSummary={financialSummary}
      allSelected={selectableIds.size > 0 && [...selectableIds].every((id) => selectedIds.has(id))}
      onClose={() => {
        if (
          activeVaultId === getActiveVaultIdSyncMaybe() &&
          activeAccountId === getAccountIdSync() &&
          (!searching || isCurrentSearch())
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
        setSelectedPersonIds((ids) =>
          [...selectableIds].every((id) => selectedIds.has(id))
            ? ids.filter((id) => !selectableIds.has(id))
            : [...new Set([...ids, ...selectableIds])],
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
              !isCurrentSearch() ||
              selectedIds.size === 0
            )
              return;
            dismissSearchKeyboard();
            selectionConfirmationVersion.current++;
            setConfirmRemoveIds([...selectedIds]);
          },
        },
      ]}
    />
  ) : null;

  if (forceUpdate) return <Redirect href="/update-prompt" />;
  if (loaded && !self) return <Redirect href="/onboarding" />;

  return (
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
      <View style={[styles.header, rowDir(isRTL)]} onTouchStart={invalidateHomeSwipe}>
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
              if (settingsVisible) {
                setSettingsVisible(false);
                setTimeout(() => setVaultPickerVisible(true), 220);
              } else {
                setVaultPickerVisible(true);
              }
            }}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel={t("menu.title.vaultSwitcher")}
            style={({ pressed }) => [
              styles.headerTitleBlock,
              rowDir(isRTL),
              pressed && { opacity: 0.5 },
            ]}
          >
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
            {/* Chevron hint — subtle, sits on the title's cap-height
                optical center. The 16px glyph's geometric center is at
                row-center; the 28px title's optical center sits ~2px
                above its geometric center (Latin caps have descender
                headroom they don't use), so a small marginTop:3 nudges
                the chevron up onto the cap-height line. The chevron stays
                on the trailing edge of the title in both LTR and RTL —
                rowDir on the parent flips it. */}
            <Ionicons
              name="chevron-down"
              size={icon.trailing}
              color={colors.textSubtle}
              style={isRTL ? { marginRight: 4, marginTop: 3 } : { marginLeft: 4, marginTop: 3 }}
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

        <NotificationBell />
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
            // Mutual exclusion with VaultPickerSheet (see comment on the
            // title Pressable above). 220ms defer mirrors the sheets'
            // own EXIT_DURATION_MS — without it, both Modals stack on
            // Android during the close animation.
            if (vaultPickerVisible) {
              setVaultPickerVisible(false);
              setTimeout(() => setSettingsVisible(true), 220);
            } else {
              setSettingsVisible(true);
            }
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
                Array.from((sessionUser.name?.trim() || sessionUser.email || "?").trim())[0] ?? "?"
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

      {/* Search overlays one combined list; the overview keeps its own tabs. */}
      {activeVaultId ? (
        <View style={[styles.tabsWrap, rowDir(isRTL)]}>
          <View style={{ flex: 1 }}>
            <Tabs<Direction> tabs={buildTabs()} value={direction} onChange={selectDirection} />
          </View>
        </View>
      ) : null}

      <KeyboardAvoidingView
        style={styles.body}
        behavior={Platform.OS === "ios" ? "padding" : "height"}
      >
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
              the app uses (home's two tabs, person detail's fresh page). The
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
                        style={({ pressed }) => [styles.noKaataLink, pressed && { opacity: 0.6 }]}
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
            // Load failed with nothing cached to show. Rendering the overview here
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
            <TabPage
              key={nativeHomeScroll ? homeScrollScope : `${homeScrollScope}:${direction}`}
              direction={direction}
              people={activePeople}
              cachedContents={cachedHomeContents}
              swipeGesture={Platform.OS === "web" ? null : homeSwipe}
              swipeBodyStyle={homeSwipeBodyStyle}
              swipePanRef={homeSwipePanRef}
              refreshGestureRef={homeRefreshGestureRef}
              nativeGestureEvent={homeNativeGestureEvent}
              allPeople={activeAll}
              neverTalliedPeople={neverTalliedPeople}
              filtered={false}
              filterTotal={activeAll.length}
              scrollRef={homeScrollRef}
              scrollScope={homeScrollScope}
              scrollOffset={homePage.initialOffset}
              onScrollBeginDrag={beginHomeScroll}
              onScroll={rememberHomeScroll}
              onContentSizeChange={homeContentSizeChanged}
              groupFilterLabel={null}
              groupFilterCount={0}
              onClearGroupFilter={() => {}}
              creditByPerson={creditByPerson}
              vaultId={activeVaultId}
              paddingBottom={96 + insets.bottom}
              refreshing={refreshing}
              onRefresh={onRefresh}
              onPersonPress={openPerson}
              onPersonLongPress={canAmend ? openHomePersonActions : undefined}
            />
          ) : (
            // Pre-load: wait for real balances before showing the overview. Rendering before
            // load() resolves flashed "0" totals + the first-run empty state at
            // every cold launch — a false "my ledger is gone" signal for a
            // shopkeeper with a full book.
            <View style={styles.loadingFill}>
              <ActivityIndicator color={colors.textDefault} />
            </View>
          )}

          {/* The field opens search. Its filters never change this overview. */}
          {activeVaultId ? (
            <Animated.View
              style={[
                styles.dock,
                {
                  bottom: 20 + insets.bottom,
                  transform: [{ translateY: toastOffset }],
                },
              ]}
              pointerEvents="box-none"
            >
              <SearchFieldTrigger
                placeholder={t("customers.search")}
                onPress={openSearch}
                isRTL={isRTL}
              />
              {canCreate ? (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={t("personAdd.new")}
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
                  style={({ pressed }) => [styles.fabInner, pressed && { opacity: 0.85 }]}
                >
                  <Ionicons name="add" size={28} color={colors.textInverted} />
                </Pressable>
              ) : null}
            </Animated.View>
          ) : null}
        </View>
      </KeyboardAvoidingView>

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
      <ProfileSettingsSheet
        visible={settingsVisible}
        signedInUser={sessionUser}
        activeAccountId={activeAccountId}
        activeVaultId={activeVaultId}
        vaults={vaults}
        archivedCount={archivedVaults.length}
        onOpenArchived={() => {
          setSettingsVisible(false);
          setTimeout(() => router.push("/vault/archived"), 220);
        }}
        shopModeEnabled={shopModeEnabled}
        shopModeBusy={shopModeBusy}
        activePeers={meshActivePeers}
        onDismiss={() => setSettingsVisible(false)}
        onSignOut={() => {
          // UX critique #6: open a ConfirmDialog before wiping the
          // session. The sheet was already dismissed via chained()
          // before this callback fired, so the dialog renders cleanly
          // over the home surface. setTimeout aligns with the sheet's
          // EXIT_DURATION_MS so the dialog opens after the sheet's
          // Modal has fully unmounted (Android Modal-stacking).
          setTimeout(() => setSignOutConfirm(true), 220);
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

      <SearchSheet
        visible={searching}
        dismissDisabled={selectionBusy}
        canDismiss={() => !selectionBusyRef.current}
        contextKey={`${getAccountIdSync() ?? "local"}:${activeVaultId ?? "none"}`}
        title={t(selecting ? "selection.contacts" : "customers.search.title")}
        autoFocus={searchAutoFocus}
        resultSummary={t(
          searchPeople.length === 1 ? "customers.search.result" : "customers.search.results",
          { count: searchPeople.length },
        )}
        query={customerQuery}
        placeholder={t("customers.search")}
        isRTL={isRTL}
        onDismiss={closeSearch}
        onChangeQuery={(query) => {
          if (isCurrentSearch() && !selectionBusyRef.current) setCustomerQuery(query);
        }}
        filtersActive={listCustomized}
        onClearAll={
          customerQuery || listCustomized
            ? () => {
                if (!isCurrentSearch() || selectionBusyRef.current) return;
                setCustomerQuery("");
                changeListPreference({ ...DEFAULT_CUSTOMER_SEARCH });
              }
            : undefined
        }
        filters={
          <>
            <CustomerListOptions
              preference={listPreference}
              groups={customerGroups}
              isRTL={isRTL}
              onChange={changeListPreference}
            />
            {canAmend ? (
              <View style={{ padding: 16 }}>
                <Button
                  label={t("groups.manage")}
                  icon="add-outline"
                  variant="secondary"
                  fullWidth
                  onPress={() => {
                    if (!isCurrentSearch() || selectionBusyRef.current) return;
                    const requestedVault = activeVaultId;
                    const requestedAccount = activeAccountId;
                    closeSearch();
                    const request = searchGeneration.current;
                    const open = () => {
                      if (
                        mounted.current &&
                        request === searchGeneration.current &&
                        requestedVault &&
                        getActiveVaultIdSyncMaybe() === requestedVault &&
                        getAccountIdSync() === requestedAccount &&
                        canSelectRef.current
                      )
                        router.push({ pathname: "/groups", params: { vaultId: requestedVault } });
                    };
                    if (
                      !afterNativeSearchClosed(
                        `${requestedAccount ?? "local"}:${requestedVault ?? "none"}`,
                        open,
                      )
                    )
                      setTimeout(open, 240);
                  }}
                />
              </View>
            ) : null}
          </>
        }
        footer={searching ? selectionToolbar : undefined}
        confirmation={{
          visible: searching && selecting && confirmRemoveIds !== null,
          title: t("selection.removeContactsTitle", { count: confirmRemoveIds?.length ?? 0 }),
          description: t("selection.removeContactsDescription"),
          confirmLabel: t("selection.remove"),
          destructive: true,
          onCancel: () => {
            if (
              !isCurrentSearch() ||
              selectionBusyRef.current ||
              confirmationVersion !== selectionConfirmationVersion.current
            )
              return;
            selectionConfirmationVersion.current++;
            setConfirmRemoveIds(null);
          },
          onConfirm: () => {
            if (
              !isCurrentSearch() ||
              selectionBusyRef.current ||
              confirmRemoveIds === null ||
              confirmationVersion !== selectionConfirmationVersion.current
            )
              return;
            selectionConfirmationVersion.current++;
            void removeSelected();
          },
        }}
      >
        {(footerInset) =>
          searching ? (
            <SearchResultsPage
              people={searchPeople}
              scrollRef={searchScrollRef}
              groupFilterLabel={groupFilterLabel}
              groupFilterCount={groupFilterCount}
              onClearGroupFilter={() => changeListPreference({ ...listPreference, group: "all" })}
              creditByPerson={creditByPerson}
              paddingBottom={24 + footerInset}
              onPersonPress={openPerson}
              onPersonLongPress={
                canSelect && !selecting
                  ? (person) => {
                      if (isCurrentSearch()) startSelection(person);
                    }
                  : undefined
              }
              selecting={selecting}
              selectedIds={selectedIds}
              selectionBusy={selectionBusy}
            />
          ) : null
        }
      </SearchSheet>

      <BottomSheet
        visible={sheetFor !== null}
        title={sheetFor?.name}
        onDismiss={() => setSheetFor(null)}
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
              const id = sheetFor?.id;
              if (id) router.push({ pathname: "/person/[id]/edit", params: { id } });
            },
          },
          {
            label: t("common.remove"),
            icon: "trash-outline",
            destructive: true,
            onPress: () => setConfirmDeleteFor(sheetFor),
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
          setConfirmDeleteFor(null);
          if (!target) return;
          try {
            await archivePerson(target.id);
            await load();
            toast.push(t("common.removed", { name: target.name }), "success");
          } catch (err) {
            console.warn("[home] archivePerson failed", err);
            toast.push(t("entry.deleteFailed"), "error");
          }
        }}
        onCancel={() => setConfirmDeleteFor(null)}
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
    </SafeAreaView>
  );
}

type CustomerRowsProps = {
  people: PersonWithBalance[];
  creditByPerson: Record<string, CreditStatus>;
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
  scrollRef: React.RefObject<ScrollView | null>;
  paddingBottom: number;
};

type RefreshableCustomerScrollProps = CustomerScrollProps & {
  refreshing: boolean;
  onRefresh: () => void;
};

/** One bordered card keeps the existing row behavior in idle and search. */
function CustomerRows(props: CustomerRowsProps) {
  return (
    <View style={styles.peopleCard}>
      {props.people.map((item, index) => (
        <View key={item.id}>
          {index > 0 ? <View style={styles.divider} /> : null}
          <PersonRow
            person={item}
            creditStatus={props.creditByPerson[item.id] ?? "none"}
            onPress={props.onPersonPress}
            onLongPress={props.onPersonLongPress}
            selecting={props.selecting}
            selected={props.selecting && props.selectedIds?.has(item.id)}
            disabled={props.selectionBusy}
            showDirection={props.showDirection}
          />
        </View>
      ))}
    </View>
  );
}

/** A customer has no money direction until there is a tally. Kept visible on
 * both idle pages without contributing to either total. */
function NoTalliesSection(props: CustomerRowsProps) {
  const isRTL = useIsRTL();
  if (!props.people.length) return null;
  return (
    <View style={styles.noTalliesSection}>
      <Text style={[styles.searchSectionTitle, textDir(isRTL)]} accessibilityRole="header">
        {t("customers.noTallies")}
      </Text>
      <CustomerRows {...props} />
    </View>
  );
}

function GroupFilterChip(props: GroupFilterChipProps) {
  const isRTL = useIsRTL();
  if (!props.groupFilterLabel) return null;
  return (
    <Pressable
      onPress={props.onClearGroupFilter}
      accessibilityRole="button"
      accessibilityHint={t("groups.clearFilter")}
      hitSlop={{ top: 6, bottom: 6 }}
      style={({ pressed }) => [
        styles.groupChip,
        rowDir(isRTL),
        pressed && { backgroundColor: colors.bgMuted },
      ]}
    >
      <Text style={[styles.groupChipText, textDir(isRTL)]} numberOfLines={1}>
        {t(props.groupFilterCount > 1 ? "groups.viewMany" : "groups.view", {
          name: props.groupFilterLabel,
        })}
      </Text>
      <Ionicons name="close" size={14} color={colors.textSubtle} />
    </Pressable>
  );
}

/** Search is one ordered list; each nonzero amount carries its own direction. */
function SearchResultsPage(props: CustomerRowsProps & GroupFilterChipProps & CustomerScrollProps) {
  const isRTL = useIsRTL();
  const count = props.people.length;
  return (
    <ScrollView
      ref={props.scrollRef}
      style={styles.body}
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="on-drag"
      contentContainerStyle={{ paddingBottom: props.paddingBottom }}
    >
      <GroupFilterChip
        groupFilterLabel={props.groupFilterLabel}
        groupFilterCount={props.groupFilterCount}
        onClearGroupFilter={props.onClearGroupFilter}
      />
      {count === 0 ? (
        <EmptyState title={t("customers.noResults")} isRTL={isRTL} />
      ) : (
        <CustomerRows {...props} showDirection />
      )}
    </ScrollView>
  );
}

type HomeDirectionContentProps = CustomerRowsProps & {
  direction: Direction;
  allPeople: PersonWithBalance[];
  hasNeutral: boolean;
};

/** Cached per direction: ordinary row/card structure and a full-width hero. */
function HomeDirectionContent(props: HomeDirectionContentProps) {
  const isRTL = useIsRTL();
  const total = sumAmounts(props.allPeople.map((p) => Math.abs(p.balance)));
  const active = props.allPeople.filter((p) => p.balance !== 0).length;
  const totalLabel =
    props.direction === "collect" ? t("home.total.label.collect") : t("home.total.label.pay");
  // The hero total is the main page's direction cue: the collect color when
  // it's money to collect, the pay color when it's money to pay. (Matches the
  // person balance number and the web ledger.)
  const totalColor = props.direction === "collect" ? colors.collectStrong : colors.payStrong;

  return (
    <>
    <View style={styles.totalBlock}>
      <Text style={[styles.totalLabel, textDir(isRTL), trackingSafe(isRTL)]}>{totalLabel}</Text>
      <View style={[styles.totalRow, rowDir(isRTL)]}>
        <Text
          style={[styles.totalAmount, { color: totalColor, flexShrink: 1 }]}
          numberOfLines={1}
          adjustsFontSizeToFit
          minimumFontScale={0.5}
        >
          {formatAmount(total)}
        </Text>
        <Text style={styles.totalAfn}>{getCurrentCurrencySymbol()}</Text>
      </View>
      {/* Descriptor for a REAL total ("from 3 people"). At zero it used to
          switch into empty-state vocabulary that the EmptyState two lines
          below already says, louder and bigger: an empty tab read "no one
          here yet" (13px grey) and then "Nothing to collect yet" (15px
          semibold) — the same sentence twice, at two sizes. One grammar per
          concept: the zero states belong to EmptyState (nobody on this
          side) and to PersonRow's settled mark (everyone square), not under
          the hero number. */}
      {active > 0 ? (
        <Text style={[styles.totalSub, textDir(isRTL)]}>
          {t(active === 1 ? "home.from.someone" : "home.from.many", { count: active })}
        </Text>
      ) : null}
    </View>
      {props.people.length === 0 && !props.hasNeutral ? (
        <EmptyState
          title={props.direction === "collect" ? t("home.empty.collect.title") : t("home.empty.pay.title")}
          subtitle={props.direction === "collect" ? t("home.empty.collect.subtitle") : t("home.empty.pay.subtitle")}
          isRTL={isRTL}
        />
      ) : null}
      <View
        collapsable={false}
        style={props.people.length ? undefined : styles.emptyFinancialCard}
        pointerEvents={props.people.length ? "auto" : "none"}
        accessibilityElementsHidden={props.people.length === 0}
        importantForAccessibility={props.people.length ? "auto" : "no-hide-descendants"}
      >
        <CustomerRows
          people={props.people}
          creditByPerson={props.creditByPerson}
          onPersonPress={props.onPersonPress}
          onPersonLongPress={props.onPersonLongPress}
        />
      </View>
    </>
  );
}

type HomeListProps = CustomerRowsProps &
    GroupFilterChipProps &
    RefreshableCustomerScrollProps & {
      direction: Direction;
      cachedContents: { collect: React.ReactNode; pay: React.ReactNode } | null;
      swipeGesture: ReturnType<typeof Gesture.Pan> | null;
      swipeBodyStyle: ReturnType<typeof useAnimatedStyle>;
      swipePanRef: React.RefObject<ReturnType<typeof Gesture.Pan> | undefined>;
      refreshGestureRef: React.RefObject<React.ComponentRef<typeof HomeNativeRefreshControl> | null>;
      nativeGestureEvent: EventHandlerProcessed<object>;
      allPeople: PersonWithBalance[];
      neverTalliedPeople: PersonWithBalance[];
      filtered: boolean;
      filterTotal: number;
      vaultId: string | null;
      scrollOffset: { x: number; y: number };
      scrollScope: string;
      onScrollBeginDrag: (event: NativeSyntheticEvent<NativeScrollEvent>) => void;
      onScroll: (event: NativeSyntheticEvent<NativeScrollEvent>) => void;
      onContentSizeChange: () => void;
    };

const HomeListContext = createContext<HomeListProps | null>(null);

function ContextHomeList() {
  const props = useContext(HomeListContext);
  if (!props) throw new Error("Home list requires its current page context");
  return renderHomeList(props);
}

// Context refreshes the list directly; the gesture owner changes only when its
// recognizer changes, rather than processing every direction/layout update.
const HomeGestureSurface = memo(function HomeGestureSurface({ gesture, bodyStyle }: {
  gesture: ReturnType<typeof Gesture.Pan>;
  bodyStyle: ReturnType<typeof useAnimatedStyle>;
}) {
  return <GestureDetector gesture={gesture}>
    <Reanimated.View style={[styles.body, bodyStyle]} collapsable={false}>
      <ContextHomeList />
    </Reanimated.View>
  </GestureDetector>;
});

function TabPage(props: HomeListProps) {
  return props.swipeGesture ? (
    <HomeListContext.Provider value={props}>
      <HomeGestureSurface gesture={props.swipeGesture} bodyStyle={props.swipeBodyStyle} />
    </HomeListContext.Provider>
  ) : <View style={styles.body} collapsable={false}>{renderHomeList(props)}</View>;
}

function renderHomeList(props: HomeListProps) {
  const HomeScrollView = props.swipeGesture ? HomeNativeScrollView : ScrollView;
  const HomeRefreshControl = props.swipeGesture ? HomeNativeRefreshControl : RefreshControl;
  const nativeCoordination = props.swipeGesture ? {
    simultaneousHandlers: props.swipePanRef,
    disallowInterruption: false,
    shouldActivateOnStart: false,
    onGestureEvent: props.nativeGestureEvent,
  } : {};
  const content = (
      <HomeScrollView
        key={Platform.OS === "android" ? props.scrollScope : `${props.scrollScope}:${props.direction}`}
        ref={props.scrollRef}
        {...nativeCoordination}
        {...(props.swipeGesture ? { waitFor: props.refreshGestureRef } : {})}
        {...(Platform.OS !== "android" ? { contentOffset: props.scrollOffset } : {})}
        onScrollBeginDrag={props.onScrollBeginDrag}
        onScroll={props.onScroll}
        onScrollEndDrag={props.onScroll}
        onMomentumScrollEnd={props.onScroll}
        onContentSizeChange={props.onContentSizeChange}
        scrollEventThrottle={100}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode={Platform.OS === "ios" ? "interactive" : "on-drag"}
        contentContainerStyle={{ paddingBottom: props.paddingBottom }}
        refreshControl={
          <HomeRefreshControl
            {...nativeCoordination}
            {...(props.swipeGesture ? { ref: props.refreshGestureRef } : {})}
            refreshing={props.refreshing}
            onRefresh={props.onRefresh}
            colors={[colors.textEmphasis]}
            tintColor={colors.textSubtle}
          />
        }
      >
        {props.cachedContents ? (
          <>
            {(["collect", "pay"] as const).map((side) => {
              const visible = props.direction === side;
              return (
                <View
                  key={side}
                  collapsable={false}
                  style={[styles.homeDirectionGroup, !visible && styles.homeDirectionGroupHidden]}
                  pointerEvents={visible ? "auto" : "none"}
                  accessibilityElementsHidden={!visible}
                  importantForAccessibility={visible ? "auto" : "no-hide-descendants"}
                >
                  {props.cachedContents![side]}
                </View>
              );
            })}
          </>
        ) : (
          <HomeDirectionContent
            direction={props.direction}
            people={props.people}
            allPeople={props.allPeople}
            hasNeutral={props.neverTalliedPeople.length > 0}
            creditByPerson={props.creditByPerson}
            onPersonPress={props.onPersonPress}
            onPersonLongPress={props.onPersonLongPress}
          />
        )}
        <NoTalliesSection
          selecting={props.selecting}
          selectedIds={props.selectedIds}
          selectionBusy={props.selectionBusy}
          people={props.neverTalliedPeople}
          creditByPerson={props.creditByPerson}
          onPersonPress={props.onPersonPress}
          onPersonLongPress={props.onPersonLongPress}
        />
      </HomeScrollView>
  );
  // The native wrappers coordinate the scroll and refresh handlers.
  // Their simultaneous Pan ref preserves the next stroke even when the native
  // ScrollView intercepts its DOWN to stop an existing fling.
  return content;
}

const styles = StyleSheet.create({
  // Absolute positioning removes the inactive group from flow without a zero
  // height constraint: Yoga measures its full-width hero/card at intrinsic height.
  homeDirectionGroup: { overflow: "hidden" },
  homeDirectionGroupHidden: { position: "absolute", left: 0, right: 0, top: 0, opacity: 0 },
  emptyFinancialCard: { height: 0, opacity: 0, overflow: "hidden" },
  container: { flex: 1, backgroundColor: colors.bgDefault },
  body: { flex: 1 },
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
  // Header — D-HEADER-CLEANUP. iOS 17 "large title" pattern, borderless,
  // typography-driven. Shop name is the visual anchor (28px display).
  // After the user-name subtitle was removed, both clusters now center
  // on a single row (alignItems:"center"), so title text optical center
  // and avatar center share the same line — no marginTop hacks needed.
  // paddingTop:18 / paddingBottom:14 give the row enough breathing room
  // under the status bar without wasting space (the old 20/16 anticipated
  // a two-line title block). paddingHorizontal:16 is matched on both
  // sides; safe-area top is handled by SafeAreaView edges={["top"]} on
  // the parent.
  header: {
    paddingHorizontal: 16,
    paddingTop: 18,
    paddingBottom: 14,
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
  // tabsWrap — gap above the customer list. marginTop:2 closes the gap a
  // hair after the header's paddingBottom shrunk to 14 (was 16);
  // marginBottom:16 keeps the list from feeling glued to the tab strip.
  tabsWrap: { paddingHorizontal: 16, marginTop: 2, marginBottom: 16, gap: 8, alignItems: "center" },
  groupChip: {
    alignSelf: "flex-start",
    alignItems: "center",
    gap: 6,
    maxWidth: "90%",
    minHeight: 32,
    paddingHorizontal: 12,
    marginHorizontal: 16,
    marginBottom: 8,
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
  searchTitle: {
    fontFamily: fonts.sansSemi,
    fontSize: 18,
    color: colors.textEmphasis,
  },
  searchSectionTitle: {
    fontFamily: fonts.sansSemi,
    fontSize: 13,
    color: colors.textEmphasis,
    marginHorizontal: 16,
    marginTop: 4,
    marginBottom: 8,
  },
  noTalliesSection: { marginTop: 16 },
  filterHint: {
    fontFamily: fonts.sansRegular,
    fontSize: 12,
    color: colors.textSubtle,
    marginHorizontal: 16,
    marginBottom: 12,
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
  totalBlock: { marginHorizontal: 16, marginBottom: 20 },
  totalLabel: {
    fontSize: 11,
    fontFamily: fonts.sansSemi,
    color: colors.textSubtle,
    textTransform: "uppercase",
    letterSpacing: 0.6,
  },
  totalRow: { flexDirection: "row", alignItems: "baseline", marginTop: 6, gap: 6 },
  totalAmount: {
    fontSize: 36,
    fontFamily: fonts.monoBold,
    color: colors.textEmphasis,
    letterSpacing: -0.5,
  },
  totalAfn: { fontSize: 14, fontFamily: fonts.sansMedium, color: colors.textMuted },
  totalSub: {
    fontSize: 13,
    fontFamily: fonts.sansRegular,
    color: colors.textSubtle,
    marginTop: 4,
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
  dock: {
    position: "absolute",
    flexDirection: "row",
    left: 16,
    right: 16,
    alignItems: "center",
    gap: 8,
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
