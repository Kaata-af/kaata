import { Ionicons } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import { Redirect, useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Animated,
  BackHandler,
  Image,
  Linking,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { BottomSheet } from "../components/BottomSheet";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { Button } from "../components/Button";
import { EmptyState } from "../components/EmptyState";
import { PersonRow } from "../components/PersonRow";
import { ProfileSettingsSheet, type VaultListItem } from "../components/ProfileSettingsSheet";
import { RestoreProgress, restoreProgressLabel } from "../components/RestoreProgress";
import { Tabs } from "../components/Tabs";
import { useToast, useToastOffset } from "../components/Toast";
import { UpdateBanner } from "../components/UpdateBanner";
import { useAppMeta } from "../lib/app-meta-context";
import { colors } from "../lib/colors";
import { getCurrentCurrencySymbol } from "../lib/currency";
// Type-only — the recovery module itself stays a lazy dynamic import below.
import type { RecoveryProgress } from "../lib/recovery";
import { VaultPickerSheet } from "../components/VaultPickerSheet";
import {
  type DifferentAccountChoice,
  type DifferentAccountPromptArgs,
  getSessionUser,
  isCancellation,
  type SessionUser,
  SignInCancelledByUserError,
  signInWithGoogle,
  signOut,
} from "../lib/auth";
import {
  archivePerson,
  getActiveVaultArchivedAt,
  getActiveVaultArchivedState,
  getAppMeta,
  getLocalSelf,
  listActiveVaults,
  listAllPeople,
  listAllVaultsIncludingArchived,
  setAppMeta,
} from "../lib/db";
import { getAccountIdSync, getActiveVaultId, setActiveVaultId } from "../lib/db-tx";
import { useLedgerRefresh } from "../lib/ledger-events";
import { rowDir, textDir, useIsRTL } from "../lib/direction";
import { fonts } from "../lib/fonts";
import { formatAmount } from "../lib/format";
import { t } from "../lib/i18n";
import { useActiveVaultCanWrite } from "../lib/use-vault-role";
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

// Tab labels are computed at render time so locale changes (after a hot reload
// during dev) flow through. The keys remain stable identifiers.
function buildTabs() {
  return [
    { key: "collect" as const, label: t("home.tab.collect") },
    { key: "pay" as const, label: t("home.tab.pay") },
  ];
}

// Velocity (px/s) at or above which a "flick" commits the tab switch even with
// a small drag distance. Standard mobile UX values land around 400-600 px/s.
const FLICK_VELOCITY = 500;
// Drag distance (as a fraction of screen width) at or above which a slow drag
// commits even without a flick. 30% is the common iOS/Material convention.
const DRAG_COMMIT_FRACTION = 0.3;
// Spring config for both the gesture-end animation and the tab-tap animation.
// Mid-stiffness: fast settle without overshoot.
const RAIL_SPRING = { friction: 14, tension: 110 } as const;

// Home list ordering: most-recently-modified (last entry) first, name as
// tie-break. Module-level pure comparator (stable identity, safe outside memo deps).
const sortByModified = (a: PersonWithBalance, b: PersonWithBalance): number =>
  (b.last_entry_at ?? 0) - (a.last_entry_at ?? 0) || a.name.localeCompare(b.name);

// Which tab a person belongs to. Direction is DERIVED from the ledger, never
// stored (CLAUDE.md "direction-free" model).
//   balance > 0 → they owe me → collect
//   balance < 0 → I owe them  → pay
//   balance === 0 (SETTLED) → STAY on the side they were on before being
//     settled, instead of always falling into collect. With the balance exactly
//     0 the most-recent entry is necessarily the one that zeroed it, so the
//     prior side is the OPPOSITE of that entry's effect: a 'payment' (I
//     received) cleared a debt they owed me → collect; a 'debt' (I gave) cleared
//     what I owed them → pay. Adding a new tally makes the balance non-zero
//     again and re-files them by sign on the next load. Fallback when the entry
//     type is unknown (e.g. a person with no entries) is collect, the prior
//     default — those rows are filtered off the home list anyway.
const personSide = (p: PersonWithBalance): Direction =>
  p.balance > 0
    ? "collect"
    : p.balance < 0
      ? "pay"
      : p.last_entry_type === "debt"
        ? "pay"
        : "collect";

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
  const { width: screenWidth } = useWindowDimensions();
  const { forceUpdate } = useAppMeta();
  // Subscribes to locale changes — flipping language in Settings re-renders
  // this screen (and all its children) without an app restart. Strings via
  // t() refresh on the same render.
  const isRTL = useIsRTL();

  const [self, setSelf] = useState<Self | null>(null);
  const [direction, setDirection] = useState<Direction>("collect");
  const [allPeople, setAllPeople] = useState<PersonWithBalance[]>([]);
  const [sheetFor, setSheetFor] = useState<PersonWithBalance | null>(null);
  const [confirmDeleteFor, setConfirmDeleteFor] = useState<PersonWithBalance | null>(null);
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
  // vault. Hides write affordances (FAB, long-press edit/delete). Defaults true
  // for local-only / owner / editor.
  const canWrite = useActiveVaultCanWrite(activeVaultId);
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
  // Phase 7 (D-ACCOUNT-PAGE-ROLE): account.tsx was killed and folded
  // into ProfileSettingsSheet. The sign-in flow + "different Google
  // account on this phone?" prompt now live here so the sheet can fire
  // them inline (same approach as sign-out, which was already inlined).
  // While the dialog is up, signInWithGoogle is awaiting
  // `pendingAccountDecision.resolve`; until the user taps a button the
  // sign-in is suspended.
  const [pendingAccountDecision, setPendingAccountDecision] = useState<{
    args: DifferentAccountPromptArgs;
    resolve: (choice: DifferentAccountChoice) => void;
  } | null>(null);
  const [authBusy, setAuthBusy] = useState(false);
  // Loading overlay for the in-app sign-in chain (handshake → register → restore →
  // reload). Without it the user taps "Sign in", the sheet closes, and nothing
  // visibly changes for several seconds (auth chip/avatar + restored kaatas only
  // appear at the very end). "signingIn" covers the Google handshake + backend +
  // registration; "restoring" covers recoverAllVaults (which can take a while).
  const [authPhase, setAuthPhase] = useState<null | "signingIn" | "restoring" | "signingOut">(null);
  // Live recovery progress for the determinate bar shown during the "restoring"
  // leg of the sign-in chain (the other legs have no measurable progress).
  const [authProgress, setAuthProgress] = useState<RecoveryProgress | null>(null);
  // UX critique #6 — sign-out is destructive enough to warrant a ConfirmDialog
  // per the documented contract in design-tokens.ts. The sheet's danger-styled
  // NavRow opens this dialog; only on confirmation do we actually wipe the
  // local session.
  const [signOutConfirm, setSignOutConfirm] = useState(false);

  // Rail position: 0 = collect tab visible, -screenWidth = pay tab visible.
  //
  // JS-DRIVEN ON PURPOSE (useNativeDriver:false everywhere translateX is
  // animated). The Xiaomi/MIUI "blank page until you swipe" bug is the
  // native-driver initial-frame problem: with useNativeDriver:true an
  // Animated.View's starting transform isn't pushed to the native layer until
  // the first animation/interaction, so on some OEMs the rail paints blank
  // until a swipe kicks it. The 0ms-timing commit hack we tried did NOT fix it
  // on the Mi 10T. JS-driven Animated resolves the current value into a plain
  // style on every React render, so the very first paint already has
  // transform: translateX(0) (collect visible) — no native commit required.
  // Cost is ~nil here: the pan gesture is runOnJS(true) and already calls
  // .setValue() on the JS thread, so we weren't getting the UI-thread win
  // anyway; only the short tab-switch/spring-back springs move to JS, which is
  // imperceptible for a single transform.
  const translateX = useRef(new Animated.Value(0)).current;

  // Timestamp of the last hardware back press while home is focused. Lives
  // OUTSIDE the useFocusEffect callback so it persists across re-subscriptions —
  // pushing a toast re-renders the ToastProvider, which produces a new context
  // value object, which invalidates the [toast] dep of the focus effect's
  // useCallback. Without this ref pinned at the component level the timestamp
  // would reset to 0 on every back press and the second press would still see
  // "no recent press" and re-trigger the toast forever.
  const lastBackPressRef = useRef(0);

  const load = useCallback(async () => {
    // The whole body is guarded: any rejection here (SQLite error,
    // SecureStore decrypt failure after a backup-restore to a new phone)
    // previously meant setLoaded(true) never ran — an infinite spinner on
    // the ROOT screen with no retry and no back.
    try {
      const [s, list, user, vaultId, accId, shopRaw] = await Promise.all([
        getLocalSelf(),
        listAllPeople(),
        getSessionUser(),
        getActiveVaultId(),
        getAppMeta("account_id"),
        getAppMeta("shop_mode_enabled"),
      ]);
      setSelf(s);
      setAllPeople(list);
      setSessionUser(user);
      setActiveVaultIdState(vaultId);
      setActiveAccountId(accId);
      setShopModeEnabled(shopRaw === "1");

      // D-ARCHIVED-VAULT-FILTER: helpers in lib/db.ts return the two slices
      // separately. Loading them in parallel keeps the first paint snappy.
      try {
        const [active, all] = await Promise.all([
          listActiveVaults(),
          listAllVaultsIncludingArchived(),
        ]);
        setVaults(active.map((r) => ({ id: r.id, name: r.name, archived: false })));
        setArchivedVaults(
          all.filter((r) => r.archived).map((r) => ({ id: r.id, name: r.name, archived: true })),
        );

        // Edge case: if the active vault was just archived (e.g. by a remote
        // event applier between the previous load() and this one), move the
        // active vault to the first surviving non-archived vault, or null
        // it out so the UI prompts "Create a Kaata first".
        if (vaultId && !active.some((v) => v.id === vaultId)) {
          const fallback = active[0]?.id ?? null;
          if (fallback) {
            await setActiveVaultId(fallback);
            setActiveVaultIdState(fallback);
          } else {
            setActiveVaultIdState(null);
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

      setLoadError(false);
    } catch (err) {
      console.warn("[home] load failed", err);
      setLoadError(true);
    } finally {
      setLoaded(true);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  // Live refresh: a mesh/cloud sync that applies events for the visible vault
  // re-runs load() immediately, so a synced tally appears without pull-refresh.
  useLedgerRefresh(activeVaultId, load);

  // Pull-to-refresh — with mesh/vault sync now core, entries can land while
  // the shopkeeper sits on this screen (the dominant shop-counter posture).
  // useFocusEffect alone never picks those up.
  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
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
  // subtitle reflects live peer count without a 10s polling lag.
  useEffect(() => {
    let unsub: (() => void) | null = null;
    let cancelled = false;
    void (async () => {
      try {
        const mesh = await import("../lib/mesh");
        if (cancelled) return;
        unsub =
          mesh.onShopModeStatusChange?.((s) => {
            setMeshActivePeers(s.activePeers);
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
  }, []);

  // Intercept the Android hardware back button on the home screen so a single
  // tap doesn't immediately close the app. Requires two presses within 2s —
  // a familiar "press back again to exit" pattern. Only active while home is
  // focused; other screens get normal back behavior (pop the stack).
  useFocusEffect(
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

  // Split by direction, then sort by MODIFIED DATE (most-recent entry first),
  // name as tie-breaker. (Matee: "the contacts should be listed and sorted by
  // modified date.") allPeople is already tallied-only (listAllPeople), so every
  // row has a last_entry_at. sortByModified is a module-level pure comparator.
  const collectPeople = useMemo(
    () => allPeople.filter((p) => personSide(p) === "collect").sort(sortByModified),
    [allPeople],
  );
  const payPeople = useMemo(
    () => allPeople.filter((p) => personSide(p) === "pay").sort(sortByModified),
    [allPeople],
  );

  // Animate the rail to the resting position for the current direction.
  // Fires on both tab taps (direction changes via Tabs) and post-commit
  // direction changes from swipe. Cleanup stops any in-flight spring so
  // a rapid tap-then-swipe (or vice-versa) doesn't stall mid-screen.
  useEffect(() => {
    const target = direction === "collect" ? 0 : -screenWidth;
    const animation = Animated.spring(translateX, {
      toValue: target,
      useNativeDriver: false, // see translateX decl — JS-driven to fix MIUI blank-on-mount
      ...RAIL_SPRING,
    });
    animation.start();
    return () => animation.stop();
  }, [direction, screenWidth, translateX]);

  // (The old 0ms native-driver "commit the initial transform" effect was
  // removed — it didn't fix the Mi 10T blank-on-mount. The rail is now
  // JS-driven so the first paint already carries the correct transform; see the
  // translateX declaration above.)

  // The swipe gesture. activeOffsetX requires ~24px of horizontal movement
  // before the pan claims the touch — keeps small vertical drags falling
  // through to the inner ScrollView. failOffsetY abandons the gesture entirely
  // if the user starts a clearly-vertical drag.
  const swipeGesture = useMemo(() => {
    const baseAt = (d: Direction) => (d === "collect" ? 0 : -screenWidth);
    return Gesture.Pan()
      .activeOffsetX([-24, 24])
      .failOffsetY([-16, 16])
      .runOnJS(true)
      .onUpdate((e) => {
        // Follow finger. Clamp to the rail's bounds so users can't drag
        // past the first/last tab into empty space.
        const next = baseAt(direction) + e.translationX;
        const clamped = Math.max(-screenWidth, Math.min(0, next));
        translateX.setValue(clamped);
      })
      .onEnd((e) => {
        const distance = e.translationX;
        const velocity = e.velocityX;
        // Velocity-aware commit: a flick beats a slow drag. Without a flick,
        // the user must have dragged at least DRAG_COMMIT_FRACTION of the
        // screen width in the right direction.
        const flickLeft = velocity <= -FLICK_VELOCITY;
        const flickRight = velocity >= FLICK_VELOCITY;
        const dragLeft = distance <= -screenWidth * DRAG_COMMIT_FRACTION;
        const dragRight = distance >= screenWidth * DRAG_COMMIT_FRACTION;

        const commitToPay = direction === "collect" && (dragLeft || flickLeft);
        const commitToCollect = direction === "pay" && (dragRight || flickRight);

        if (commitToPay) {
          Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Soft).catch(() => undefined);
          setDirection("pay");
        } else if (commitToCollect) {
          Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Soft).catch(() => undefined);
          setDirection("collect");
        } else {
          // Released below the threshold — spring back to the current tab's
          // resting position. The post-commit useEffect handles the other
          // case, so we only need this branch here.
          Animated.spring(translateX, {
            toValue: baseAt(direction),
            useNativeDriver: false, // see translateX decl — JS-driven to fix MIUI blank-on-mount
            ...RAIL_SPRING,
          }).start();
        }
      });
  }, [direction, screenWidth, translateX]);

  // Stable row handlers — PersonRow is memoized, and these two props must
  // keep their identity across renders or every row re-renders on each
  // toast push / locale flip (see PersonRow's memo rationale).
  const openPerson = useCallback(
    (p: PersonWithBalance) => {
      router.push({ pathname: "/person/[id]", params: { id: p.id } });
    },
    [router],
  );

  // Phase 7 D-ACCOUNT-PAGE-ROLE: shared sign-in driver. Used by both
  // "Sign in with Google" (signed-out state) and "Switch Google account"
  // (signed-in state). GoogleSignin.configure({offlineAccess:false})
  // forces the account picker on every call, so a signed-in user who
  // taps Switch will land in the picker and can choose a different
  // account — the rest of the flow (different-account prompt, backend
  // call, housekeeping) is identical.
  async function runGoogleSignIn() {
    if (authBusy) return;
    setAuthBusy(true);
    setAuthPhase("signingIn");
    try {
      await signInWithGoogle(async (args) => {
        return new Promise<DifferentAccountChoice>((resolve) => {
          setPendingAccountDecision({ args, resolve });
        });
      });
      // Register-on-sign-in: durably POST every owned-but-unregistered LOCAL
      // vault to the server NOW, while the user is guaranteed online and engaged
      // — instead of relying on vault/new's fire-and-forget POST or the delayed
      // background sweep. This is what makes an EXISTING user's kaata actually
      // back up (and therefore restorable on reinstall): without the server
      // owner-membership row, every push 403s and GET /v1/vaults omits the vault.
      // Idempotent (409 = already registered = success); best-effort.
      try {
        const { reconcileVaultRegistrations } = await import("../lib/sync/reconcile");
        await reconcileVaultRegistrations();
      } catch (err) {
        if (__DEV__) console.warn("[home] post-sign-in registration failed (non-fatal)", err);
      }
      // Restore-on-sign-in: automatically load the account's vaults/kaatas from
      // the server (Matee: "if it's on, it should load your vaults/kaatas once you
      // sign in"). Idempotent + safe — a first-time account lists ZERO server
      // vaults (no-op, local data untouched); a fresh phone loads its backed-up
      // vaults; an already-synced phone re-applies idempotently. Recovery failure
      // must not break the sign-in, so it's caught.
      setAuthProgress(null);
      setAuthPhase("restoring");
      try {
        const { recoverAllVaults } = await import("../lib/recovery");
        await recoverAllVaults({ onProgress: setAuthProgress });
      } catch (err) {
        if (__DEV__) console.warn("[home] post-sign-in recovery failed (non-fatal)", err);
      }
      await load();
      setTimeout(() => toast.push(t("menu.account.signIn.toast"), "success"), 240);
    } catch (err) {
      if (err instanceof SignInCancelledByUserError) return;
      if (isCancellation(err)) return;
      console.warn("[home] sign-in failed", err);
      setTimeout(() => toast.push(t("menu.account.signIn.failed"), "error"), 240);
    } finally {
      setAuthBusy(false);
      setAuthPhase(null);
      setAuthProgress(null);
    }
  }

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
              size={16}
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
        {activeVaultId && !canWrite ? (
          <View style={[styles.readOnlyBadge, isRTL ? { marginRight: 8 } : { marginLeft: 8 }]}>
            <Ionicons name="eye-outline" size={12} color={colors.textSubtle} />
            <Text style={styles.readOnlyBadgeText} allowFontScaling={false}>
              {t("readonly.badge")}
            </Text>
          </View>
        ) : null}

        <View style={{ flex: 1 }} pointerEvents="none" />

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
            // Signed-in but no Google avatar URL — initial-letter chip.
            <View style={styles.profileInitialChip}>
              <Text style={styles.profileInitialText}>
                {(sessionUser.name ?? sessionUser.email ?? "?").trim().charAt(0).toUpperCase()}
              </Text>
            </View>
          ) : (
            <Ionicons name="person-circle-outline" size={32} color={colors.textSubtle} />
          )}
        </Pressable>
      </View>

      <UpdateBanner />

      {/* Tabs only when there's an active kaata; the no-kaatas empty state
          below stands in for the whole ledger area otherwise. */}
      {activeVaultId ? (
        <View style={styles.tabsWrap}>
          <Tabs<Direction> tabs={buildTabs()} value={direction} onChange={setDirection} />
        </View>
      ) : null}

      {loaded && !activeVaultId ? (
        // No kaatas yet — a fresh account that hasn't created one, or one where
        // the last kaata was just left/archived. A DELIBERATE "create your
        // first kaata" screen; the app never silently auto-creates a kaata.
        // (Matee: "don't auto-create ... make a default screen for when there
        // are no kaatas, like onboarding the user to make a kaata".)
        <View style={styles.noKaataWrap}>
          <Ionicons name="albums-outline" size={44} color={colors.textMuted} />
          <View style={{ height: 16 }} />
          <Text style={styles.noKaataTitle}>{t("home.noKaata.title")}</Text>
          <View style={{ height: 6 }} />
          <Text style={styles.noKaataSub}>{t("home.noKaata.subtitle")}</Text>
          <View style={{ height: 24 }} />
          <View style={styles.noKaataBtnWrap}>
            <Button label={t("home.noKaata.create")} onPress={() => router.push("/vault/new")} />
          </View>
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
        </View>
      ) : loaded && loadError && allPeople.length === 0 ? (
        // Load failed with nothing cached to show. Rendering the rail here
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
      ) : loaded && screenWidth > 0 ? (
        // screenWidth>0 gate: on some devices (Xiaomi/MIUI) useWindowDimensions
        // returns 0 for the first frame(s); rendering the rail at width 0 paints
        // blank-white until a swipe forces a re-layout (the reported bug). Showing
        // the spinner until width resolves makes the main page appear on its own.
        <GestureDetector gesture={swipeGesture}>
          <Animated.View
            style={[styles.rail, { width: screenWidth * 2, transform: [{ translateX }] }]}
          >
            <TabPage
              direction="collect"
              people={collectPeople}
              width={screenWidth}
              paddingBottom={96 + insets.bottom}
              refreshing={refreshing}
              onRefresh={onRefresh}
              onPersonPress={openPerson}
              onPersonLongPress={canWrite ? setSheetFor : undefined}
            />
            <TabPage
              direction="pay"
              people={payPeople}
              width={screenWidth}
              paddingBottom={96 + insets.bottom}
              refreshing={refreshing}
              onRefresh={onRefresh}
              onPersonPress={openPerson}
              onPersonLongPress={canWrite ? setSheetFor : undefined}
            />
          </Animated.View>
        </GestureDetector>
      ) : (
        // Pre-load: spinner instead of the rail. Rendering the rail before
        // load() resolves flashed "0" totals + the first-run empty state at
        // every cold launch — a false "my ledger is gone" signal for a
        // shopkeeper with a full book.
        <View style={styles.loadingFill}>
          <ActivityIndicator color={colors.textDefault} />
        </View>
      )}

      {/*
       * INVARIANT: + FAB on the RIGHT side. Same right-hand-is-giving
       * cultural rule as the give/receive row in person/[id]. The
       * absolute `right: 20` works only because _layout.tsx neutralizes
       * I18nManager (allowRTL(false) + swapLeftAndRightInRTL(false))
       * and ensures the Activity is LTR via the one-shot migration
       * prompt. If the Activity were RTL, RN would silently reinterpret
       * `right` as `left` (the v0.2.4 bug).
       */}
      {/* FAB only when there's an active kaata AND I can write to it (hidden for
          a viewer on a shared kaata — their writes are refused anyway). */}
      {activeVaultId && canWrite ? (
        <Animated.View
          style={[
            styles.fab,
            { bottom: 20 + insets.bottom, transform: [{ translateY: toastOffset }] },
          ]}
          pointerEvents="box-none"
        >
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t("personAdd.title")}
            // D-DEFENSIVE-ARCHIVED-GUARD: D-POST-ARCHIVE-SWITCH should
            // normally keep the active vault writable, but a mesh-sourced
            // archive event can race the FAB tap; refuse here and tell the
            // user where to go instead. Cheap 1-row DB read; we don't
            // memoize because the answer can change between renders and
            // the UX cost of a stale "yes, write" is higher than a 1ms
            // SELECT.
            onPress={async () => {
              const guard = await getActiveVaultArchivedState();
              if (guard.state === "archived") {
                toast.push(t("home.fab.blockedArchived"), "error");
                return;
              }
              if (guard.state === "none") {
                toast.push(t("entry.noActiveVault"), "error");
                return;
              }
              Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => undefined);
              router.push("/person/new");
            }}
            style={({ pressed }) => [styles.fabInner, pressed && { opacity: 0.85 }]}
          >
            {/* "+" (add): this FAB is the primary "create anything" action — it
              opens the search-or-add screen (person/new) where you find an
              existing contact OR add a new one to start a tally. Matee: it's the
              everything button, not just search, so a plus reads truer than a
              magnifying glass. */}
            <Ionicons name="add" size={30} color={colors.textInverted} />
          </Pressable>
        </Animated.View>
      ) : null}

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
        onSignIn={runGoogleSignIn}
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

      <BottomSheet
        visible={sheetFor !== null}
        title={sheetFor?.name}
        onDismiss={() => setSheetFor(null)}
        actions={[
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

      {/* Phase 7 D-ACCOUNT-PAGE-ROLE: "different Google account on this
          phone?" prompt — fires when the user picks a Google account
          whose sub differs from the cached one AND the install was
          active within the last 30 days. Three outcomes;
          signInWithGoogle is awaiting our resolve() and proceeds (or
          throws SignInCancelledByUserError) based on which button gets
          tapped. Previously this dialog lived on the deleted /account
          screen; folded in here so the sign-in flow can run inline from
          ProfileSettingsSheet. */}
      <ConfirmDialog
        visible={pendingAccountDecision !== null}
        title={t("account.differentAccount.title")}
        description={
          pendingAccountDecision
            ? t("account.differentAccount.body", {
                oldEmail: pendingAccountDecision.args.cachedEmail ?? "—",
                newEmail: pendingAccountDecision.args.newEmail ?? "—",
              })
            : ""
        }
        confirmLabel={t("account.differentAccount.keep")}
        tertiaryLabel={t("account.differentAccount.wipe")}
        tertiaryDestructive
        cancelLabel={t("account.differentAccount.cancel")}
        onConfirm={() => {
          const p = pendingAccountDecision;
          setPendingAccountDecision(null);
          p?.resolve("keep");
        }}
        onTertiary={() => {
          const p = pendingAccountDecision;
          setPendingAccountDecision(null);
          p?.resolve("wipe");
        }}
        onCancel={() => {
          const p = pendingAccountDecision;
          setPendingAccountDecision(null);
          p?.resolve("cancel");
        }}
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
          // same overlay as sign-in so the screen doesn't look frozen.
          setAuthPhase("signingOut");
          try {
            await signOut();
            await load();
            setTimeout(() => toast.push(t("menu.account.signOut.toast"), "success"), 240);
          } catch (err) {
            console.warn("[home] signOut failed", err);
            setTimeout(() => toast.push(t("menu.account.signOut.failed"), "error"), 240);
          } finally {
            setAuthPhase(null);
          }
        }}
        onCancel={() => setSignOutConfirm(false)}
      />

      {/* Sign-in / restore loading overlay. Plain absolute-fill View (no Modal —
          the settings sheet has already closed, so there's no Modal-stacking risk)
          covering the screen while the multi-step sign-in chain runs, so the user
          gets clear feedback instead of a frozen-looking screen. */}
      {authPhase ? (
        <View style={styles.authOverlay} pointerEvents="auto">
          {authPhase === "restoring" ? (
            // Determinate bar — recovery reports real per-vault progress.
            <RestoreProgress
              fraction={authProgress?.fraction ?? 0}
              label={
                authProgress
                  ? restoreProgressLabel(authProgress)
                  : t("menu.account.signIn.restoring")
              }
              tone="light"
              isRTL={isRTL}
            />
          ) : (
            // Handshake / sign-out have no measurable progress → spinner.
            <>
              <ActivityIndicator size="large" color={colors.textInverted} />
              <Text style={[styles.authOverlayText, textDir(isRTL)]}>
                {authPhase === "signingOut"
                  ? t("menu.account.signOut.pending")
                  : t("menu.account.signIn.signingIn")}
              </Text>
            </>
          )}
        </View>
      ) : null}
    </SafeAreaView>
  );
}

function TabPage(props: {
  direction: Direction;
  people: PersonWithBalance[];
  width: number;
  paddingBottom: number;
  refreshing: boolean;
  onRefresh: () => void;
  onPersonPress: (person: PersonWithBalance) => void;
  // Omitted for a viewer (read-only) — long-press opens the edit/delete sheet.
  onPersonLongPress?: (person: PersonWithBalance) => void;
}) {
  const isRTL = useIsRTL();
  const total = props.people.reduce((sum, p) => sum + Math.abs(p.balance), 0);
  const active = props.people.filter((p) => p.balance !== 0).length;
  const totalLabel =
    props.direction === "collect" ? t("home.total.label.collect") : t("home.total.label.pay");
  // The hero total is the main page's direction cue: the collect color when
  // it's money to collect, the pay color when it's money to pay. (Matches the
  // person balance number and the web ledger.)
  const totalColor = props.direction === "collect" ? colors.collectStrong : colors.payStrong;

  // The home list is TALLIES-ONLY (listAllPeople filters to people with entries),
  // so it's short — rendered as ONE real bordered CARD (ScrollView + map), not the
  // old per-row border emulation. That emulation drew the card edges as ASYMMETRIC
  // per-row borders (first row top-only, last row bottom-only), which Android RN
  // renders wrong together with borderRadius — the first/last edges + corners
  // vanished (the "edges of the whole div are missing" report, twice). A single
  // View with uniform borderWidth + overflow:hidden has no asymmetry and clips the
  // rounded corners cleanly. overflow:hidden is safe here (it wraps a normal View,
  // not an intrinsic-height FlatList cell — that was the unrelated blank-row bug).
  const { people, onPersonPress, onPersonLongPress } = props;

  return (
    <View style={{ width: props.width }}>
      <ScrollView
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ paddingBottom: props.paddingBottom }}
        refreshControl={
          <RefreshControl
            refreshing={props.refreshing}
            onRefresh={props.onRefresh}
            colors={[colors.textEmphasis]}
            tintColor={colors.textSubtle}
          />
        }
      >
        <View style={styles.totalBlock}>
          <Text style={[styles.totalLabel, textDir(isRTL)]}>{totalLabel}</Text>
          <View style={[styles.totalRow, rowDir(isRTL)]}>
            <Text style={[styles.totalAmount, { color: totalColor }]}>{formatAmount(total)}</Text>
            <Text style={styles.totalAfn}>{getCurrentCurrencySymbol()}</Text>
          </View>
          <Text style={[styles.totalSub, textDir(isRTL)]}>
            {active === 0
              ? props.people.length === 0
                ? t("home.empty.noOneYet")
                : t("home.empty.allSettled")
              : t(active === 1 ? "home.from.someone" : "home.from.many", { count: active })}
          </Text>
        </View>

        {people.length === 0 ? (
          <EmptyState
            title={
              props.direction === "collect"
                ? t("home.empty.collect.title")
                : t("home.empty.pay.title")
            }
            subtitle={
              props.direction === "collect"
                ? t("home.empty.collect.subtitle")
                : t("home.empty.pay.subtitle")
            }
          />
        ) : (
          <View style={styles.peopleCard}>
            {people.map((item, index) => (
              <View key={item.id}>
                {index > 0 ? <View style={styles.divider} /> : null}
                <PersonRow person={item} onPress={onPersonPress} onLongPress={onPersonLongPress} />
              </View>
            ))}
          </View>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bgDefault },
  authOverlay: {
    ...StyleSheet.absoluteFillObject,
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
    minHeight: 40,
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
    fontSize: 28,
    lineHeight: 32,
    fontFamily: fonts.sansBold,
    color: colors.textEmphasis,
    letterSpacing: -0.5,
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
  // Phase 7: initial-letter chip rendered when signedIn user has no
  // Google avatar URL. Same visual weight as the avatar slot (32x32
  // bgMuted circle) so signed-in users always see a circular chip
  // top-right, with the letter or the photo inside.
  profileInitialChip: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: colors.bgMuted,
    alignItems: "center",
    justifyContent: "center",
  },
  profileInitialText: {
    fontSize: 14,
    fontFamily: fonts.sansBold,
    color: colors.textEmphasis,
  },
  // Google avatar Image — 32px circle. RN's Image disk-caches the
  // Google CDN URL automatically. bgMuted fills the circle while the
  // image is loading so the slot doesn't flash empty on cold launch.
  // The Image content always fills its bounds, so no centering math
  // is needed (unlike the abandoned initial-letter approach).
  profileAvatar: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: colors.bgMuted,
  },
  // tabsWrap — gap above the swipe rail. marginTop:2 closes the gap a
  // hair after the header's paddingBottom shrunk to 14 (was 16);
  // marginBottom:16 keeps the rail from feeling glued to the tab strip.
  tabsWrap: { paddingHorizontal: 16, marginTop: 2, marginBottom: 16 },
  loadingFill: { flex: 1, alignItems: "center", justifyContent: "center" },
  // No-kaatas empty state (fresh account / after leaving the last kaata).
  noKaataWrap: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 32,
  },
  noKaataTitle: {
    fontSize: 18,
    fontFamily: fonts.sansSemi,
    color: colors.textEmphasis,
    textAlign: "center",
  },
  noKaataSub: {
    fontSize: 14,
    fontFamily: fonts.sansRegular,
    color: colors.textSubtle,
    textAlign: "center",
  },
  noKaataBtnWrap: { alignSelf: "stretch" },
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
    backgroundColor: colors.bgInverted,
  },
  loadErrorRetryText: {
    fontSize: 14,
    fontFamily: fonts.sansSemi,
    color: colors.textInverted,
  },
  rail: {
    flex: 1,
    // Keep collect-tab on the physical left, pay-tab on the physical right.
    // The swipe gesture's translateX math assumes this layout (translateX 0
    // = collect visible, translateX -screenWidth = pay visible). Yoga
    // WOULD auto-reverse `flexDirection: 'row'` children if the Activity
    // were RTL, breaking the gesture. We avoid that by ensuring the
    // Activity is LTR via _layout.tsx's I18nManager neutralization + the
    // one-shot migration prompt — see that file for the full architecture.
    flexDirection: "row",
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
  fab: {
    position: "absolute",
    // INVARIANT: + FAB stays on the physical RIGHT regardless of script.
    // Relies on the Activity being LTR — _layout.tsx neutralizes
    // I18nManager (allowRTL(false) + swapLeftAndRightInRTL(false) + a
    // one-shot forceRTL(false) migration). Once that's persisted, every
    // future Activity comes up LTR and `right: 20` means physical right.
    // (If the Activity is RTL, RN's auto-swap would silently reinterpret
    // `right` as `left`. The migration prompt in _layout.tsx prevents that
    // case from ever rendering this view.)
    right: 20,
    width: 52,
    height: 52,
  },
  fabInner: {
    width: 52,
    height: 52,
    borderRadius: 26,
    backgroundColor: colors.bgInverted,
    alignItems: "center",
    justifyContent: "center",
  },
});
