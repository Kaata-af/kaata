// CRYPTO POLYFILL is installed by ./index.js (the registered entry point
// per package.json `main`), which runs BEFORE this layout module loads.
// We keep an idempotent re-import here so a hot-reload of _layout.tsx
// during development still gets the polyfill before any mesh code runs.
import "../lib/mesh/_ed25519-setup";

// D-FOREGROUND-HARDEN: this MUST be the second import. It registers the
// notifee foreground-service callback, creates the "shop-mode" channel,
// and registers the background-event handler at JS module load — before
// any code path can call displayNotification with asForegroundService:true.
// Doing it at module top in a dedicated leaf module guarantees the
// registration survives process resurrection by Android (e.g. when the FGS
// start intent is re-delivered after a Doze kill before the React tree
// mounts).
import "../lib/mesh/foreground-bootstrap";

import * as Application from "expo-application";
import * as Network from "expo-network";
import { Stack } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import { setStatusBarStyle, StatusBar } from "expo-status-bar";
import { useEffect, useState } from "react";
import {
  ActivityIndicator,
  AppState,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { initialWindowMetrics, SafeAreaProvider } from "react-native-safe-area-context";
import { AutoSync } from "../components/AutoSync";
import { MeshController } from "../components/MeshController";
import { ProjectionConflictsListener } from "../components/ProjectionConflictsListener";
import { ToastProvider } from "../components/Toast";
import {
  ensureShopModeChannel,
  SHOP_MODE_NOTIFICATION_ID,
  stopShopModeForegroundService,
} from "../lib/mesh/foreground";
import { IS_EXPO_GO } from "../lib/expo-go";

// ============================================================================
// I18nManager neutralization + one-shot migration. The architecture:
//
//   kaata sandboxes direction INSIDE the React tree via an internal flag in
//   lib/direction.ts. The process-global I18nManager is neutralized so it
//   doesn't second-guess our layout, and v0.2.4's bad forceRTL(true) is
//   undone for upgraders.
//
// The three module-load calls:
//
//   1. allowRTL(false) — tells RN we don't want auto-RTL behavior.
//   2. swapLeftAndRightInRTL(false) — disables auto-swap of margin/padding
//      left↔right and absolute left↔right positioning.
//   3. forceRTL(false) ONCE if the Activity came up RTL — undoes v0.2.4's
//      bad state (persists across launches).
//
// CRITICAL constraint about Yoga and Android Activities:
//
//   I18nManager.isRTL is determined at Activity creation time by Android's
//   layout-direction resolution. Calling forceRTL/allowRTL/etc. at JS
//   module-load persists the new value to shared prefs but DOES NOT relayout
//   the current Activity. So if the user is upgrading from v0.2.4 (which
//   called forceRTL(true) on Persian), their Activity for THIS launch is
//   still isRTL=true.
//
//   And when the Activity is RTL, Yoga auto-reverses `flexDirection: 'row'`
//   children — meaning the FAB row, the give-button row, and the swipe rail
//   all render physically reversed for this launch only. The "I gave"
//   button ends up on the left, the FAB ends up on the left, the swipe
//   gesture math inverts. Exactly the v0.2.4 complaint.
//
//   We can't fix this without a real Activity restart, which we cannot
//   trigger without a native module we don't want to ship. So instead:
//   detect isRTL at module load and show a blocking bilingual restart
//   prompt instead of the broken-layout app. The user closes from recents
//   and reopens; the next Activity comes up isRTL=false, the prompt
//   doesn't show, and the sandboxed direction takes over.
//
// Effect on Expo Go: same mechanism. forceRTL(false) persists to Expo Go's
// own shared prefs, so on the next Expo Go cold restart its host activity
// also comes up LTR — which is what the user explicitly wanted.
//
// Cultural invariants relying on this neutralization (all static-physical):
//   1. "I gave" / "I received" row in person/[id].tsx — give on right
//   2. + FAB on home — stays right
//   3. Swipe rail on home — collect physical left, pay physical right
import { I18nManager as _I18nManager } from "react-native";
const NEEDS_RESTART_FOR_LTR = _I18nManager.isRTL;
_I18nManager.allowRTL(false);
_I18nManager.swapLeftAndRightInRTL(false);
if (NEEDS_RESTART_FOR_LTR) {
  _I18nManager.forceRTL(false);
}
import { checkIn } from "../lib/api";
import { subscribeCheckInRequests } from "../lib/checkin-trigger";
import { AppMetaProvider, useAppMeta } from "../lib/app-meta-context";
import { colors } from "../lib/colors";
import {
  decrementPendingUsage,
  getAppMeta,
  getLocalSelf,
  healActiveVaultId,
  initDb,
  readPendingUsage,
  setAppMeta,
} from "../lib/db";
import { MESH_PARKED, SOLO_STORE_MODE } from "../constants/env";
import {
  primeActiveVaultId,
  refreshAccountIdCache,
  setInstallIdCache,
  setLocalSelfUserIdCache,
} from "../lib/db-tx";
import { configureGoogleSignIn } from "../lib/auth";
import { initCurrencyFromPref } from "../lib/currency";
import { initDefaultCountryFromPref } from "../lib/phone";
import { useAppFontsWithError } from "../lib/fonts";
import { getLocale, initLocaleFromPref, t } from "../lib/i18n";
import { ensureInstallId, getInstalledAtUnixMs } from "../lib/install-id";
import { sweepAllQuarantinedVaults } from "../lib/projection/sweep";
import { type BootError, forceRestart, toBootError } from "../lib/boot-error";

const currentVersion = Application.nativeApplicationVersion || "0.1.0";

// UX critique #5: support contact surfaced on every boot-error screen so
// a stuck user has somewhere to send a screenshot. Single constant —
// changing it (e.g. from email to a WhatsApp number) is one edit.
// Declared up here so DbInitFailedPrompt + BootFailedPrompt can reference
// it without temporal-dead-zone gymnastics.
const SUPPORT_CONTACT = "support@kaata.af";

// Decide where the Stack mounts first. Precedence:
//   1. If the user has a local_self user, they're already onboarded — home.
//      hasOnboarded is the AUTHORITATIVE source; an onboarding_step='done'
//      claim without a backing local_self row is treated as stale (the
//      user wiped their self row out-of-band, e.g. via a partial reset).
//   2. Phase 3 restore gate: if the user signed in via Google
//      (account_id present in app_meta) and they DIDN'T explicitly
//      skip-restore for this account on a prior launch AND they don't
//      already have a local self, mount onboarding/restore FIRST. The
//      restore screen does its own snapshot/backup probing; if neither
//      endpoint has data it auto-forwards to onboarding/profile.
//   3. Otherwise, if onboarding_step records they were partway through,
//      resume there.
//   4. Fresh install: language step UNLESS the device is already Persian/
//      Dari (their locale is correct, skip the gratuitous "pick your
//      language" tap), in which case start at the auth step.
function pickInitialRoute(args: {
  hasOnboarded: boolean;
  onboardingStep: "language" | "auth" | "profile" | "kaata" | "done" | null;
  deviceIsPersian: boolean;
  accountId: string | null;
  restoreSkipped: boolean;
}): string {
  if (args.hasOnboarded) return "index";
  // Phase 3 restore gate. Sits BETWEEN auth and profile in the flow: if
  // the user already signed in (we have an account_id) AND they didn't
  // tap "Start fresh" on a previous attempt, send them to the restore
  // probe screen. The probe screen handles "no data on server" by
  // forwarding to onboarding/profile, so this gate doesn't strand fresh
  // accounts on a spinner.
  if (
    args.accountId &&
    !args.restoreSkipped &&
    (args.onboardingStep === "profile" || args.onboardingStep === "auth")
  ) {
    return "onboarding/restore";
  }
  // No self exists — ignore step='done' (treat as stale).
  if (args.onboardingStep === "auth") return "onboarding/auth";
  if (args.onboardingStep === "profile") return "onboarding/profile";
  // The kaata step mints self + first vault, so hasOnboarded is still false
  // here (the early-return above never fires) and we land on it correctly.
  if (args.onboardingStep === "kaata") return "onboarding/kaata";
  if (args.onboardingStep === "language") return "onboarding/language";
  // Fresh install — skip language for Persian-locale devices.
  return args.deviceIsPersian ? "onboarding/auth" : "onboarding/language";
}

export default function RootLayout() {
  // First-launch gate: if the Activity came up RTL (v0.2.4 upgrader OR a
  // fresh install on a Persian-locale device), we cannot relayout the
  // current view tree — Yoga has already auto-flipped `flexDirection: row`
  // children. Render a blocking restart prompt instead of the broken Stack.
  // After the user cold-restarts, the new Activity reads our persisted
  // forceRTL(false) state and comes up LTR; NEEDS_RESTART_FOR_LTR is then
  // false on that launch and the normal app renders.
  if (NEEDS_RESTART_FOR_LTR) {
    return <MigrationPrompt />;
  }

  const [fontsReady, fontsError] = useAppFontsWithError();
  const [appReady, setAppReady] = useState(false);
  // D-BOOT-CRASH-DEFENSE: fatal error captured by any boot step. Any
  // non-null value short-circuits the render gates below and shows
  // BootFailedPrompt. Distinct from dbReady===false (which surfaces
  // DbInitFailedPrompt's narrower copy). The order matters in the render
  // gates: dbReady===false wins so existing UX is preserved.
  const [bootError, setBootError] = useState<BootError | null>(null);

  // Map a font-load error into bootError. expo-font's useFonts surfaces
  // the load error asynchronously; without this, a fresh install on a
  // flaky network would sit on the BootSplash forever because fontsReady
  // never flips true.
  useEffect(() => {
    if (fontsError && !bootError) {
      setBootError(toBootError("fonts", fontsError));
    }
  }, [fontsError, bootError]);
  // Hard prerequisite: initDb() MUST resolve before the Stack mounts.
  // Migration 007 creates the vaults table that vault/new.tsx INSERTs into;
  // if a migration throws (integrity guard fires, FK violation, etc.) we
  // CANNOT let the Stack render — any screen that touches db will hit
  // "no such table: X" downstream. The boot effect below sets this on
  // success; on failure it stays null and the render gate shows an error
  // card instead of the (broken) app. Separate from appReady so the boot
  // sequence can still finish its non-db side-effects (BackgroundCheckIn
  // skip, font load, etc.) even if we've decided to refuse to render.
  const [dbReady, setDbReady] = useState<boolean | null>(null);
  const [installId, setInstallId] = useState<string | null>(null);
  const [hasOnboarded, setHasOnboarded] = useState(false);
  // Resumable onboarding step: 'language' | 'auth' | 'profile' | 'kaata' |
  // 'done' | null. Read from app_meta on launch so a force-quit mid-flow
  // returns the user to the screen they were last on, not back to step 1.
  const [onboardingStep, setOnboardingStep] = useState<
    "language" | "auth" | "profile" | "kaata" | "done" | null
  >(null);
  // Device-locale-driven flag: if the device is already Persian/Dari, we
  // SKIP the language picker (their language is already correct; asking
  // them feels like the app doesn't trust their device locale).
  const [deviceIsPersian, setDeviceIsPersian] = useState(false);
  // Phase 3 restore gate inputs. Both are read once during boot and
  // passed to pickInitialRoute. accountId is non-null when the user has
  // signed in on a prior launch (postSignInHousekeeping wrote it to
  // app_meta). restoreSkipped is true when the user tapped "Start
  // fresh" on the restore screen for the current account.
  const [accountId, setAccountId] = useState<string | null>(null);
  const [restoreSkipped, setRestoreSkipped] = useState(false);
  // Cold-start FGS-notification tap intent. The old implementation pushed
  // the route after a fixed 250ms — but the Stack mounts only after fonts
  // + migrations (1-3s on target devices), so expo-router threw "navigate
  // before mounting" into an empty catch and the tap silently did nothing.
  // Stash the intent and navigate from the effect below once ready.
  const [pendingSyncNav, setPendingSyncNav] = useState(false);

  useEffect(() => {
    (async () => {
      // D-BOOT-CRASH-DEFENSE: every boot step funnels through `step()` so
      // we never need an outer catch-all that silently flips appReady=true
      // after a partial failure. On failure, bootError is set and appReady
      // stays false; the render gate below picks up BootFailedPrompt
      // instead of mounting the (partially-initialized) Stack.
      let aborted = false;
      const step = async <T,>(
        stage: Parameters<typeof toBootError>[0],
        fn: () => Promise<T>,
      ): Promise<T | undefined> => {
        if (aborted) return undefined;
        try {
          return await fn();
        } catch (err) {
          console.error(`[init] ${stage} failed`, err);
          const be = toBootError(stage, err);
          setBootError(be);
          aborted = true;
          // Mythos crash-reporter: a failed boot step is exactly the kind
          // of thing we want in the backend. Queue it (durable; flushes on
          // the next successful online launch). Best-effort, never throws.
          void import("../lib/crash-report").then((cr) =>
            cr.queueCrashReport({ kind: "boot", stage, name: be.name, message: be.message }),
          );
          return undefined;
        }
      };

      // 1. Mint / fetch install_id and prime its cache BEFORE migrations
      //    run so migration 006 (synthetic backfill) can stamp it as the
      //    hlc.did on every backfilled event.
      const id = await step("install_id", async () => {
        const v = await ensureInstallId();
        setInstallIdCache(v);
        return v;
      });
      if (aborted || !id) return;

      // 2. Run all migrations inside per-migration transactions. We KEEP
      //    the dedicated dbReady=false branch here because
      //    DbInitFailedPrompt has copy specifically tuned to "schema is
      //    in an unknown partial state". The user gets that screen on
      //    init_db failure; every OTHER stage falls through to the
      //    generic BootFailedPrompt with the captured stage tag.
      let dbOk = false;
      try {
        await initDb({ installId: id });
        dbOk = true;
      } catch (err) {
        // CRITICAL: do NOT flip dbReady=true. Migrations are append-only
        // and atomic per-migration (each runs inside withTransactionAsync),
        // so a throw here means at least one migration's schema changes
        // rolled back. The vaults table (migration 007), event_log
        // indexes (010), mesh credentials (011), etc. may all be absent.
        // Rendering the Stack would let the user hit "no such table"
        // errors anywhere — better to refuse to mount and prompt a
        // restart than to pretend the app is healthy.
        console.error("[init] initDb failed — refusing to render Stack", err);
        setDbReady(false);
        return; // skip rest of boot — every step below depends on the db.
      }
      if (!dbOk) return;
      setDbReady(true);

      // 3. Prime caches. Pulled into its own stage so a vault-cache
      //    failure doesn't look like a migration failure to support.
      await step("prime_caches", async () => {
        // Phase 2: Migration 007 writes app_meta.active_vault_id for any
        // install that had ledger state. Prime the in-memory cache NOW
        // so every subsequent query can use getActiveVaultIdSync().
        await primeActiveVaultId();
        // Self-heal a dangling active-vault pointer (left by a partially-failed
        // leave/archive) before anything reads it — switches to a valid vault
        // or clears it. No-op in the normal case. Re-prime so the cache picks
        // up any repair.
        await healActiveVaultId();
        await primeActiveVaultId();
        // Prime account_id cache so post-sign-in event appends stamp
        // actor_account_id directly.
        await refreshAccountIdCache();
      });
      if (aborted) return;

      // 4. User prefs. Previously inside Promise.all WITHOUT a try-catch
      //    — a flaky app_meta read here would crash the boot silently.
      await step("user_prefs", async () => {
        await Promise.all([
          initLocaleFromPref(),
          initCurrencyFromPref(),
          initDefaultCountryFromPref(),
        ]);
      });
      if (aborted) return;

      // 5. Google sign-in module configuration. Native-module-touching;
      //    fenced so a future SDK rev that throws on missing webClientId
      //    can't kill cold boot. configureGoogleSignIn() is idempotent
      //    and synchronous — wrap it in a no-await promise so the step
      //    helper's error capture applies.
      await step("google_signin", async () => {
        configureGoogleSignIn();
      });
      if (aborted) return;

      // 6. Self / onboarding / account lookups.
      await step("self_lookup", async () => {
        const [self, oStep, accountIdRaw] = await Promise.all([
          getLocalSelf(),
          getAppMeta("onboarding_step"),
          getAppMeta("account_id"),
        ]);
        // Prime the local-self identity cache that lib/event-log.ts
        // reads synchronously on every entry write.
        setLocalSelfUserIdCache(self?.user_id ?? null);
        setInstallId(id);
        setHasOnboarded(Boolean(self));
        // Phase 3 restore gate. Only meaningful if accountIdRaw is set —
        // restore_skipped_for_account_<id> is per-account so signing
        // into a different Google account on the same device still
        // triggers the restore prompt.
        setAccountId(accountIdRaw ?? null);
        if (accountIdRaw) {
          const skipped = await getAppMeta(`restore_skipped_for_account_${accountIdRaw}`);
          setRestoreSkipped(skipped === "1");
        }
        // Validate the step value — only the four known states pass
        // through.
        if (
          oStep === "language" ||
          oStep === "auth" ||
          oStep === "profile" ||
          oStep === "kaata" ||
          oStep === "done"
        ) {
          setOnboardingStep(oStep);
        }
      });
      if (aborted) return;

      // 7. Device locale probe (skip-language decision). Lazy-require to
      //    keep the top of the file clean.
      await step("device_locale", async () => {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { getLocales } = require("expo-localization");
        const deviceLang = (getLocales()[0]?.languageCode ?? "en").toLowerCase();
        setDeviceIsPersian(deviceLang === "fa" || deviceLang === "prs");
      });
      if (aborted) return;

      // 8. Foreground-service channel. The bootstrap module already
      //    creates it at module load (see foreground-bootstrap.ts) — this
      //    call is idempotent + belt-and-suspenders. We treat it as
      //    non-fatal so a transient miss here doesn't lock the user out
      //    of the app entirely; the worst case is Shop Mode toggle
      //    failing until the next launch.
      try {
        await ensureShopModeChannel();
      } catch (err) {
        if (__DEV__) console.warn("[init] ensureShopModeChannel", err);
      }

      // SOLO_STORE_MODE: Nearby sync isn't even toggleable in this build, but a
      // stale shop_mode_enabled="1" (from a prior non-solo build) + the START_STICKY
      // native foreground service means the OS keeps re-posting the "Nearby sync"
      // notification with no way to turn it off. Kill it EARLY on every boot — clear
      // the flag so MeshController never restarts it, and stop the native FGS so the
      // notification disappears now (not after the 10s app-meta poll). Best-effort.
      // (MESH_PARKED is false since the 2026-07 revive, so this only fires in
      // solo builds; the constant stays for a future re-park.)
      if (MESH_PARKED || SOLO_STORE_MODE) {
        try {
          await setAppMeta("shop_mode_enabled", "0");
          // With MESH_PARKED this also runs on devices upgrading from a pre-park
          // build that left the native FGS running + its revival alarm armed:
          // stopShopModeForegroundService now clears KEY_FGS_SHOULD_RUN and
          // cancels that alarm, so the stale "Nearby sync" notification dies on
          // the first launch of the parked build and can't come back.
          await stopShopModeForegroundService();
        } catch (err) {
          if (__DEV__) console.warn("[init] parked/solo FGS kill failed", err);
        }
      }

      // Everything that's supposed to run before the Stack mounts has
      // completed successfully. Flip appReady. Note: NO outer try/finally
      // wraps this body — appReady flips true ONLY on the success path.
      setAppReady(true);
    })();
  }, []);

  // HEAL-TRIGGER: re-sweep quarantined rows on launch and on every
  // background->foreground transition. Quarantine healing is otherwise purely
  // event-driven (local write / fresh mesh ingest), so a fresh joiner whose
  // owner-authored contacts+entries got stranded as unknown_actor (the genesis
  // applied + seeded the registry, but the post-ingest sweep didn't finish, and
  // the owner then stops re-sending because the joiner's frontier already counts
  // those rows as held) never heals on its own. These two lifecycle re-sweeps
  // give it the missing trigger — and "close the app then reopen" is EXACTLY the
  // user's reported workflow. Both are fire-and-forget so they never block the
  // Stack mount; sweepAllQuarantinedVaults is idempotent + no-ops when there's
  // nothing un-applied. Gated on dbReady so event_log exists.
  useEffect(() => {
    if (dbReady !== true) return;
    // Launch pass (covers relaunch / cold start).
    void sweepAllQuarantinedVaults();
    // Foreground pass: only on a real background->active transition, not every
    // focus tick, so we don't spam a DB scan.
    let last = AppState.currentState;
    const sub = AppState.addEventListener("change", (next) => {
      const cameToForeground = last.match(/inactive|background/) != null && next === "active";
      last = next;
      if (cameToForeground) void sweepAllQuarantinedVaults();
    });
    return () => sub.remove();
  }, [dbReady]);

  // #43 P2 breaker self-heal: clear the background-mesh crash-loop breaker on
  // EVERY foreground launch, UNCONDITIONALLY (NOT gated on dbReady/appReady). If
  // initDb throws, boot bails before setAppReady and the user sits on the
  // migration-error screen — but a foreground launch must still clear the breaker
  // so the background path isn't permanently disabled by failures unrelated to a
  // poisoned event. The breaker only ever gates the BACKGROUND path, never the
  // foreground app. Best-effort + Android-only (resetBgMeshFailures no-ops else).
  useEffect(() => {
    const resetBreaker = () => {
      void import("../modules/kaata-bt-classic")
        .then((bt) => bt.resetBgMeshFailures())
        .catch(() => {
          /* best-effort */
        });
    };
    resetBreaker(); // cold launch
    let last = AppState.currentState;
    const sub = AppState.addEventListener("change", (next) => {
      const cameToForeground = last.match(/inactive|background/) != null && next === "active";
      last = next;
      if (cameToForeground) resetBreaker();
    });
    return () => sub.remove();
  }, []);

  // Notification-tap routing for the "Nearby sync" foreground-service
  // notification — open `/?menu=sync` when the user taps it (both while the
  // JS engine is alive and on cold start). Restored verbatim from the
  // pre-park implementation (435cfed^) on the 2026-07 revive.
  useEffect(() => {
    if (Platform.OS !== "android" || IS_EXPO_GO) return;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let notifee: any;
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      notifee = require("@notifee/react-native");
    } catch {
      return;
    }
    // Expo Go: notifee's native module is absent. foreground-bootstrap.ts
    // already triggered the first (failed) module load at the top of this
    // file, so this SECOND require resolves to undefined WITHOUT throwing —
    // Metro hands back the errored module's empty exports. Guard .default
    // explicitly or `notifee.default.onForegroundEvent` crashes.
    if (!notifee?.default) return;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const unsub = notifee.default.onForegroundEvent(({ type, detail }: any) => {
      if (
        (type === notifee.EventType.PRESS || type === notifee.EventType.ACTION_PRESS) &&
        detail.notification?.id === SHOP_MODE_NOTIFICATION_ID &&
        detail.pressAction?.id === "open-shop-mode-settings"
      ) {
        try {
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          const { router } = require("expo-router");
          // navigate (NOT push): push stacked a duplicate home instance on
          // every notification tap while the app was open — each re-running
          // the full home load — and hardware back then stepped through the
          // stale copies before exiting.
          router.navigate("/?menu=sync");
        } catch {
          /* */
        }
      }
    });

    // Phase 6 cold-start handler: if the app was launched via the
    // notification tap (the JS engine wasn't alive when the user tapped),
    // getInitialNotification resolves with the notification + pressAction.
    void (async () => {
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const fg = await import("../lib/mesh/foreground");
        const initial = await fg.getInitialShopModeNotification();
        if (initial?.pressActionId === "open-shop-mode-settings") {
          setPendingSyncNav(true);
        }
      } catch {
        /* */
      }
    })();

    return () => {
      if (typeof unsub === "function") unsub();
    };
  }, []);

  // Deliver the stashed cold-start notification intent once the Stack is
  // actually mounted (same readiness gates as the render below).
  useEffect(() => {
    if (!pendingSyncNav || !appReady || !fontsReady || dbReady !== true) return;
    setPendingSyncNav(false);
    // One frame's grace so the Stack's first commit has happened before
    // we navigate into it.
    const timer = setTimeout(() => {
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { router } = require("expo-router");
        router.navigate("/?menu=sync");
      } catch {
        /* */
      }
    }, 50);
    return () => clearTimeout(timer);
  }, [pendingSyncNav, appReady, fontsReady, dbReady]);

  // Hide the native splash once a REAL surface is about to render — the app, or
  // an error card. (The RTL restart prompt is an early return before this hook,
  // so MigrationPrompt hides the splash itself.) We hold the splash across the
  // whole boot (index.js preventAutoHideAsync) so the Activity's white window
  // background never shows; removing it only AFTER the tree has had a frame to
  // lay out also forces the window redraw that some MIUI builds otherwise defer
  // until the first touch — the "blank white until I swipe" bug, where even the
  // status + nav bars showed the bare white window.
  useEffect(() => {
    const showsRealSurface =
      bootError !== null || dbReady === false || (appReady && fontsReady && dbReady === true);
    if (!showsRealSurface) return;
    // Double rAF: let the just-mounted tree commit + lay out a frame before we
    // pull the splash, so what's revealed underneath is already drawn.
    let raf2 = 0;
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => {
        SplashScreen.hideAsync().catch(() => {});
      });
    });
    return () => {
      cancelAnimationFrame(raf1);
      if (raf2) cancelAnimationFrame(raf2);
    };
  }, [bootError, dbReady, appReady, fontsReady]);

  // Safety net: never let the held native splash outlive a pathological boot.
  // If we somehow haven't hidden it within 15s (a step hung without throwing),
  // hide anyway so the BootSplash spinner / an error surface becomes visible
  // instead of a frozen splash. Idempotent with the effect above.
  useEffect(() => {
    const t = setTimeout(() => SplashScreen.hideAsync().catch(() => {}), 15000);
    return () => clearTimeout(t);
  }, []);

  // Render gates, in priority order:
  //   1. dbReady === false  → migrations failed. Show an error card. NEVER
  //      mount the Stack — any screen touching db will throw "no such table".
  //   2. !appReady || !fontsReady || dbReady !== true → still booting
  //      (initDb in flight, fonts loading) → spinner. Including
  //      dbReady !== true closes the rare window where appReady flips true
  //      but dbReady is still null (boot effect's finally ran while initDb
  //      had not awaited its setter — defensive).
  //   3. otherwise → render the full app.
  if (dbReady === false) {
    return <DbInitFailedPrompt />;
  }
  // D-BOOT-CRASH-DEFENSE: any captured fatal from a non-db stage. dbReady
  // wins above so the existing DbInitFailedPrompt copy isn't shadowed.
  if (bootError) {
    return <BootFailedPrompt error={bootError} />;
  }
  if (!appReady || !fontsReady || dbReady !== true) {
    return <BootSplash />;
  }

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      {/* initialMetrics is load-bearing, not an optimization: without it
          SafeAreaProvider renders NOTHING until it asynchronously measures
          window insets, and on some Android ROMs (Xiaomi/MIUI) that measure
          callback is deferred until the first touch — so the whole app area is
          blank-white until you swipe (the reported bug; the system bars render
          fine, they're just white-on-white). Seeding initialWindowMetrics makes
          insets available synchronously on the first frame. */}
      <SafeAreaProvider initialMetrics={initialWindowMetrics}>
        <ToastProvider>
          <AppMetaProvider currentVersion={currentVersion}>
            <StatusBar style="dark" />
            <ForceDarkStatusBar />
            {installId ? <BackgroundCheckIn installId={installId} /> : null}
            <AutoSync />
            {/* Phase 6: reactively starts mesh sync (BLE primary +
                opportunistic wifi upgrade) when account_id and
                shop_mode_enabled are both set. Also renders the BLE
                permission rationale + wifi-upgrade prompt dialogs.
                No-op otherwise, including in local-only mode. */}
            <MeshController />
            {/* Phase 8 D-PROJECTION-CONFLICTS-SURFACE: the role-gate writes
                projection_conflicts rows when an event (local or mesh) is
                refused for role reasons. Without a visible UI surface,
                shopkeepers whose role got demoted between launches saw
                their writes silently disappear. This listener subscribes
                to the projection-conflicts notifier and pushes a toast
                explaining what happened. Mounted at root so the surface
                works across every screen. */}
            <ProjectionConflictsListener />
            <Stack
              initialRouteName={pickInitialRoute({
                hasOnboarded,
                onboardingStep,
                deviceIsPersian,
                accountId,
                restoreSkipped,
              })}
              screenOptions={{
                headerShown: false,
                contentStyle: { backgroundColor: colors.bgDefault },
              }}
            >
              <Stack.Screen name="index" />
              {/* Resumable onboarding stack. Each screen is registered as
                  its own Stack screen so the resumed step doesn't push
                  the earlier ones into history (avoiding back-into-language
                  loops). Gestures off across the whole flow — users
                  navigate forward only, except via explicit on-screen Back
                  on the profile screen. */}
              <Stack.Screen name="onboarding/language" options={{ gestureEnabled: false }} />
              <Stack.Screen name="onboarding/auth" options={{ gestureEnabled: false }} />
              {/* Phase 3 restore probe. Sits between auth and profile —
                  the screen fetches the snapshot/v0.4-backup endpoints
                  on mount and either restores or forwards to profile.
                  Gestures off so the user can't swipe back into auth and
                  re-trigger sign-in mid-restore. */}
              <Stack.Screen name="onboarding/restore" options={{ gestureEnabled: false }} />
              <Stack.Screen name="onboarding/profile" options={{ gestureEnabled: false }} />
              {/* Kaata step — collects the shop name + currency and mints the
                  shopkeeper's first vault. Gestures off (forward-only flow);
                  it has an explicit on-screen Back to the profile step. */}
              <Stack.Screen name="onboarding/kaata" options={{ gestureEnabled: false }} />
              {/* Completion ceremony after the kaata step. Pure celebration —
                  onboarding_step is already 'done' when it mounts, so a
                  force-quit here just lands home on relaunch. */}
              <Stack.Screen name="onboarding/success" options={{ gestureEnabled: false }} />
              <Stack.Screen name="onboarding/index" />
              <Stack.Screen
                name="update-prompt"
                options={{ presentation: "fullScreenModal", gestureEnabled: false }}
              />
              <Stack.Screen name="person/[id]" />
              <Stack.Screen name="person/[id]/edit" options={{ presentation: "modal" }} />
              <Stack.Screen name="person/new" options={{ presentation: "modal" }} />
              <Stack.Screen name="entry/new" options={{ presentation: "modal" }} />
              <Stack.Screen name="entry/[id]/edit" options={{ presentation: "modal" }} />
              {/* Phase 7 D-ACCOUNT-PAGE-ROLE: the /account screen was
                  killed. Sign-in / sign-out / switch-account all run
                  inline from ProfileSettingsSheet now — the screen had
                  become a redundant extra modal hop on top of the sheet
                  that already exposed every account action. */}
              {/* Phase 7 settings-adjacent sub-pages — registered as Stack
                  cards (no presentation override) for a consistent push-pop
                  feel with a single back-arrow header per screen. (The old
                  /preferences card was folded into /vault/settings — language /
                  region / currency / diagnostics now live under "Manage this
                  Kaata".) */}
              {/* Mythos crash-diagnosis screen — card presentation like
                  the other settings sub-pages. */}
              <Stack.Screen name="account" />
              {/* "How kaata works" static guide — reachable from the settings
                  sheet's Help section. */}
              <Stack.Screen name="guide" />
              <Stack.Screen name="diagnostics" />
              {/* D-BACKUP-RESTORE-FLOW: in-app "Restore from cloud"
                  confirm. Distinct from onboarding/restore (no Start-
                  fresh path, no v0.4 bridge, lands on / on success).
                  Phase 7 coherence pass: card presentation (the
                  documented default for settings sub-pages per
                  design-tokens.ts). Modal-as-sheet was inconsistent
                  with preferences/vault-* which are all cards reached
                  from the same ProfileSettingsSheet. */}
              <Stack.Screen name="restore" />
              {/* Phase 5.2: "Add a Kaata" — creates an additional vault local-
                  first. Registered as a regular card push (no presentation
                  override) to match every other vault/* screen (settings,
                  members, invite, pair) which rely on file-based routing
                  defaults. The earlier `presentation: "modal"` rendered as
                  a partial-height sheet on Android — the screen's own
                  SafeAreaView would then push content above the visible
                  area, leaving the form half-cut at the top. The screen
                  still renders its own custom header (Cancel | title | spacer),
                  matching the vault/* convention. */}
              <Stack.Screen name="vault/new" />
              {/* Phase 7: vault/* sub-pages explicitly registered as
                  Stack cards so their presentation matches /preferences
                  and /vault/new. File-based routing would default to
                  cards anyway, but the explicit registration is the
                  contract for the post-Phase-7 navigation graph and
                  makes it obvious these are NOT modal sheets. */}
              <Stack.Screen name="vault/settings" />
              <Stack.Screen name="vault/members" />
              <Stack.Screen name="vault/invite" />
              <Stack.Screen name="vault/audit-log" />
              {/* Phase 7 D-ARCHIVED-SCREEN — dedicated list of archived
                  Kaatas reached from a small "Archived (N) >" row in
                  ProfileSettingsSheet and VaultPickerSheet. Card
                  presentation matches every other vault/* sub-page so
                  it shares the push/pop affordance of vault/settings,
                  vault/members, etc. */}
              <Stack.Screen name="vault/archived" options={{ presentation: "card" }} />
              <Stack.Screen name="vault/pair" />
              <Stack.Screen name="vault/pair-scan" />
              {/* DEV: Bluetooth Classic (RFCOMM) transport test — M-BTC-1.
                  Temporary; remove once RFCOMM is wired into Shop Mode. */}
              <Stack.Screen name="dev/btc-test" />
              {/* Phase 5.1 deep-link handler for kaata://pair/<token>?p=...
                  Reuses the same 5-step issuance as vault/pair-scan.tsx. */}
              <Stack.Screen name="pair/[token]" options={{ presentation: "modal" }} />
            </Stack>
          </AppMetaProvider>
        </ToastProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

// BootSplash — rendered while the boot effect is in flight (fonts loading,
// initDb running, app_meta primes). The native splash (configured in app.json
// with backgroundColor #000000) dismisses as soon as the JS bundle loads, so
// without this view we'd flash from black-with-logo to white-with-spinner.
// We mirror the splash bg (#000) and show the wordmark so the visual identity
// is continuous from cold-start through to first frame. A bilingual "Setting
// up your kaata…" line fades in after 300ms so a fast boot (sub-300ms) doesn't
// flash text the user can't read; a slow boot (migration 006 synthetic-event
// backfill on an upgrader with hundreds of entries, ~1-3s) gets actionable
// feedback instead of looking frozen. Inverted color tokens (textInverted on
// bgInverted) because the bg is dark — colors.bgInverted is black, matching
// app.json's splash backgroundColor literally.
function BootSplash() {
  const [showCopy, setShowCopy] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setShowCopy(true), 300);
    return () => clearTimeout(t);
  }, []);
  return (
    <View style={bootSplashStyles.container}>
      {/* The root StatusBar (style="dark") only mounts with the Stack —
          during this black splash the default dark icons were invisible
          (dark-on-black) for the full 1-3s migration-heavy boot. */}
      <StatusBar style="light" />
      <Text style={bootSplashStyles.wordmark}>{t("brand.wordmark")}</Text>
      <View style={bootSplashStyles.spacer} />
      <ActivityIndicator color={colors.textInverted} />
      {showCopy ? (
        <>
          <View style={bootSplashStyles.spacer} />
          <Text style={bootSplashStyles.copy}>Setting up your kaata…</Text>
          <Text style={bootSplashStyles.copyFa}>در حال آماده‌سازی کاتای شما…</Text>
        </>
      ) : null}
    </View>
  );
}

const bootSplashStyles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    // Match app.json splash backgroundColor literally — hex value, not a
    // colors token — so we don't drift if the design system token names
    // ever shift. Native splash dismiss → this view should be invisible
    // to the user.
    backgroundColor: "#000000",
    padding: 24,
  },
  wordmark: {
    fontSize: 32,
    fontWeight: "700",
    color: "#FFFFFF",
    letterSpacing: -0.6,
  },
  spacer: { height: 20 },
  copy: {
    fontSize: 13,
    color: "#FFFFFF",
    opacity: 0.7,
    textAlign: "center",
  },
  copyFa: {
    fontSize: 13,
    color: "#FFFFFF",
    opacity: 0.7,
    textAlign: "center",
    marginTop: 4,
  },
});

// One-time blocking prompt rendered when the JS bundle starts up inside an
// RTL-sealed Activity. The user closes kaata from recents and reopens; the
// next Activity reads our persisted forceRTL(false) and comes up LTR.
//
// Bilingual copy hardcoded (not via t()) because at this stage the locale
// pref hasn't been loaded from app_meta — we don't know which language the
// user actually wants. Showing both makes the call to action unambiguous
// for either audience. Centered alignment renders identically in LTR and
// RTL containers, so the broken-flexDirection problem doesn't affect this
// screen visually.
function MigrationPrompt() {
  // This is rendered via an early return BEFORE RootLayout's splash-hide
  // effect, so hide the held native splash here or it would cover this prompt
  // forever (index.js holds it up until we explicitly hide).
  useEffect(() => {
    SplashScreen.hideAsync().catch(() => {});
  }, []);
  return (
    <View style={migrationStyles.container}>
      <View style={migrationStyles.card}>
        <Text style={migrationStyles.wordmark}>{t("brand.wordmark")}</Text>
        <View style={migrationStyles.spacer} />
        <Text style={migrationStyles.heading}>Almost ready</Text>
        <Text style={migrationStyles.headingFa}>تقریباً آماده</Text>
        <View style={migrationStyles.spacer} />
        <Text style={migrationStyles.body}>
          Please close kaata from your recent apps, then open it again. This is a one-time step for
          the new language settings to take effect.
        </Text>
        <View style={migrationStyles.spacerSmall} />
        <Text style={migrationStyles.bodyFa}>
          لطفاً کاتا را از برنامه‌های اخیر ببندید و دوباره باز کنید. این یک‌بار برای اعمال تنظیمات
          زبان جدید لازم است.
        </Text>
        {Platform.OS === "android" ? (
          <>
            <View style={migrationStyles.spacer} />
            <Pressable
              onPress={() => forceRestart()}
              style={({ pressed }) => [migrationStyles.button, pressed && { opacity: 0.85 }]}
            >
              <Text style={migrationStyles.buttonText}>Close kaata · بستن کاتا</Text>
            </Pressable>
          </>
        ) : null}
      </View>
    </View>
  );
}

// Rendered when initDb() throws — i.e. one or more migrations failed to
// apply. We refuse to mount the Stack because the schema is in an unknown
// partial state (the failed migration's transaction rolled back, but
// earlier migrations in this boot may have committed). The user's only
// safe options are: close + reopen the app (transient SQLite errors can
// resolve), or reinstall (data loss; recoverable only if they were
// signed in and had cloud backup). We deliberately do NOT offer an
// in-app "reset" button — that would let a confused user nuke their
// ledger over a transient busy-timeout error. Reuses migrationStyles so
// no new StyleSheet is needed. Bilingual copy hardcoded (same rationale
// as MigrationPrompt: locale pref hasn't loaded because initDb failed).
//
// UX critique #5:
//   - "Database" was jargon for an Afghan kiranchi — they have no mental
//     model for it. Replaced with "your Kaata data" / "داده‌های کاتای شما"
//     across both heading and body so the failure mode reads as
//     "something with my data went wrong" rather than "the implementation
//     thing failed".
//   - Added a support contact line so a user staring at this screen has
//     somewhere to actually share a screenshot of the issue.
function DbInitFailedPrompt() {
  return (
    <View style={migrationStyles.container}>
      <View style={migrationStyles.card}>
        <Text style={migrationStyles.wordmark}>{t("brand.wordmark")}</Text>
        <View style={migrationStyles.spacer} />
        <Text style={migrationStyles.heading}>Couldn&apos;t open your Kaata data</Text>
        <Text style={migrationStyles.headingFa}>داده‌های کاتای شما باز نشد</Text>
        <View style={migrationStyles.spacer} />
        <Text style={migrationStyles.body}>
          {Platform.OS === "android"
            ? "Please close kaata from your recent apps and open it again."
            : "Please force-quit kaata (swipe up from the bottom and flick it away) and open it again."}
        </Text>
        <View style={migrationStyles.spacerSmall} />
        <Text style={migrationStyles.bodyFa}>
          {Platform.OS === "android"
            ? "لطفاً کاتا را از برنامه‌های اخیر ببندید و دوباره باز کنید."
            : "لطفاً کاتا را به‌طور کامل ببندید (از پایین صفحه به بالا بکشید و آن را کنار بزنید) و دوباره باز کنید."}
        </Text>
        <View style={migrationStyles.spacer} />
        <Text style={bootErrorStyles.support}>
          If it keeps happening, contact {SUPPORT_CONTACT}
        </Text>
        <Text style={bootErrorStyles.supportFa}>
          اگر تکرار شد، با {SUPPORT_CONTACT} تماس بگیرید
        </Text>
        {Platform.OS === "android" ? (
          <>
            <View style={migrationStyles.spacer} />
            <Pressable
              onPress={() => forceRestart()}
              style={({ pressed }) => [migrationStyles.button, pressed && { opacity: 0.85 }]}
            >
              <Text style={migrationStyles.buttonText}>Close kaata · بستن کاتا</Text>
            </Pressable>
          </>
        ) : null}
      </View>
    </View>
  );
}

// D-BOOT-CRASH-DEFENSE: rendered when any non-initDb boot stage throws.
// Shows the stage + error name + first 240 chars of message so a user can
// screenshot it for support. Does NOT include stack frames — those can
// surface bundler-mangled paths or query strings. The primary action is
// forceRestart() (true process restart via react-native-restart with a
// BackHandler.exitApp() fallback); both outcomes get the user to the only
// recovery path (cold reopen).
//
// Reuses migrationStyles to avoid a new StyleSheet.create call. The
// "diagnostic" block uses JetBrainsMono for support to read the values
// cleanly.
//
// UX critique #5 updates:
//   - Diagnostic intro line is bilingual now (the EN-only label
//     "If you contact support, share this:" was opaque to Persian users).
//   - CTA label softened: "Force quit & restart" became "Close & restart"
//     in EN; the FA "بستن و راه‌اندازی" already reads that way. If
//     react-native-restart is missing in prod the fallback only closes
//     the process — the user still has to re-open — so the label is at
//     worst slightly aspirational, not a lie.
//   - Added support contact line so a user with a screenshot has
//     somewhere to send it.
function BootFailedPrompt({ error }: { error: BootError }) {
  return (
    <View style={migrationStyles.container}>
      <View style={migrationStyles.card}>
        <Text style={migrationStyles.wordmark}>{t("brand.wordmark")}</Text>
        <View style={migrationStyles.spacer} />
        <Text style={migrationStyles.heading}>Couldn&apos;t start</Text>
        <Text style={migrationStyles.headingFa}>کاتا شروع نشد</Text>
        <View style={migrationStyles.spacer} />
        <Text style={migrationStyles.body}>
          {Platform.OS === "android"
            ? "Tap the button to restart kaata. If that doesn't work, close it from your recent apps and open it again."
            : "Please force-quit kaata (swipe up from the bottom and flick it away) and open it again."}
        </Text>
        <View style={migrationStyles.spacerSmall} />
        <Text style={migrationStyles.bodyFa}>
          {Platform.OS === "android"
            ? "روی دکمه بزنید تا کاتا دوباره راه‌اندازی شود. اگر کار نکرد، آن را از برنامه‌های اخیر ببندید و دوباره باز کنید."
            : "لطفاً کاتا را به‌طور کامل ببندید و دوباره باز کنید."}
        </Text>
        <View style={migrationStyles.spacer} />
        {/* Diagnostic block — stage + name + first 240 chars of message.
            Surfaces enough info for support without leaking a stack.
            Bilingual intro so Persian-only users know to screenshot it. */}
        <Text style={bootErrorStyles.diagLabel}>If you contact support, share this:</Text>
        <Text style={bootErrorStyles.diagLabelFa}>
          اگر با پشتیبانی تماس می‌گیرید، این را بفرستید:
        </Text>
        <View style={bootErrorStyles.diagBox}>
          <Text style={bootErrorStyles.diagLine}>stage: {error.stage}</Text>
          <Text style={bootErrorStyles.diagLine}>error: {error.name}</Text>
          {error.message ? (
            <Text style={bootErrorStyles.diagLine} numberOfLines={6}>
              {error.message}
            </Text>
          ) : null}
        </View>
        <View style={migrationStyles.spacerSmall} />
        <Text style={bootErrorStyles.support}>Send to {SUPPORT_CONTACT}</Text>
        <Text style={bootErrorStyles.supportFa}>به {SUPPORT_CONTACT} ارسال کنید</Text>
        <View style={migrationStyles.spacer} />
        <Pressable
          onPress={() => forceRestart()}
          style={({ pressed }) => [migrationStyles.button, pressed && { opacity: 0.85 }]}
        >
          <Text style={migrationStyles.buttonText}>
            {Platform.OS === "android"
              ? "Close & restart · بستن و راه‌اندازی"
              : "Force quit · بستن کاتا"}
          </Text>
        </Pressable>
      </View>
    </View>
  );
}

const bootErrorStyles = StyleSheet.create({
  diagLabel: {
    fontSize: 12,
    color: colors.textDefault,
    opacity: 0.7,
    textAlign: "center",
    marginBottom: 2,
  },
  diagLabelFa: {
    fontSize: 12,
    color: colors.textDefault,
    opacity: 0.7,
    textAlign: "center",
    marginBottom: 6,
  },
  diagBox: {
    width: "100%",
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: 8,
    backgroundColor: colors.bgSubtle,
  },
  diagLine: {
    fontFamily: "JetBrainsMono_400Regular",
    fontSize: 11,
    color: colors.textDefault,
    lineHeight: 16,
  },
  support: {
    fontSize: 12,
    color: colors.textDefault,
    opacity: 0.8,
    textAlign: "center",
  },
  supportFa: {
    fontSize: 12,
    color: colors.textDefault,
    opacity: 0.8,
    textAlign: "center",
    marginTop: 2,
  },
});

const migrationStyles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bgDefault,
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
  },
  card: {
    width: "100%",
    maxWidth: 360,
    alignItems: "center",
  },
  wordmark: {
    fontSize: 32,
    fontWeight: "700",
    color: colors.textEmphasis,
    letterSpacing: -0.6,
  },
  spacer: { height: 24 },
  spacerSmall: { height: 12 },
  heading: {
    fontSize: 17,
    fontWeight: "600",
    color: colors.textEmphasis,
    textAlign: "center",
  },
  headingFa: {
    fontSize: 17,
    fontWeight: "600",
    color: colors.textEmphasis,
    textAlign: "center",
    marginTop: 4,
  },
  body: {
    fontSize: 14,
    color: colors.textDefault,
    textAlign: "center",
    lineHeight: 20,
  },
  bodyFa: {
    fontSize: 14,
    color: colors.textDefault,
    textAlign: "center",
    lineHeight: 22,
  },
  button: {
    paddingHorizontal: 22,
    paddingVertical: 14,
    borderRadius: 10,
    backgroundColor: colors.bgInverted,
  },
  buttonText: {
    fontSize: 14,
    fontWeight: "600",
    color: colors.textInverted,
  },
});

// Belt-and-suspenders over <StatusBar style="dark"/>: the boot splash sets light
// (white) status-bar icons on its black background, and on some Android ROMs the
// declarative re-apply when the main tree mounts loses the race — leaving white
// icons invisible on kaata's white UI (Matee). Forcing the style imperatively in
// an effect, a tick after the splash has fully unmounted, guarantees dark
// (visible) icons. The app is always light-themed (userInterfaceStyle: light),
// so dark icons are unconditionally correct.
function ForceDarkStatusBar() {
  useEffect(() => {
    setStatusBarStyle("dark", true);
  }, []);
  return null;
}

function BackgroundCheckIn({ installId }: { installId: string }) {
  const { applyCheckIn } = useAppMeta();
  useEffect(() => {
    let cancelled = false;
    let lastRunMs = 0;
    const FOREGROUND_THROTTLE_MS = 5 * 60_000;
    const run = async () => {
      if (cancelled) return;
      lastRunMs = Date.now();
      try {
        const netState = await Network.getNetworkStateAsync();
        if (!netState.isConnected) return;

        // Mythos crash-reporter: on this online pass, (1) queue the OS's
        // verdict for the previous process death + the trailing memory
        // slope, then (2) flush the outbox to the backend. Both are
        // best-effort and never throw. This is what makes crash diagnosis
        // adb-free — the verdict (LOW_MEMORY / NATIVE_CRASH / ...) and the
        // PSS slope land in Postgres on the next connected launch.
        try {
          const cr = await import("../lib/crash-report");
          await cr.queueExitInfoAndSamples();
          await cr.flushCrashReports(installId);
        } catch {
          /* best-effort */
        }

        // Only read the mesh-side revocation cursor when the install has
        // actually completed Google sign-in. A brand-new local-only install
        // has no account_id and no revocation cursors, so paying the read
        // cost during cold boot for nothing is wasteful. (M4: VMC renewals
        // are retired — the membership chain carries trust, so there's
        // nothing to renew via check-in.)
        const accountIdRaw = await getAppMeta("account_id");
        let lastRevocationSeenAtMs: Record<string, number> = {};
        if (accountIdRaw) {
          const revocation = await import("../lib/trust/revocation");
          lastRevocationSeenAtMs = await revocation.getLastRevocationSeenAtMs();
        }
        const [invalidStr, conflictStr, usage, installedAtMs, self] = await Promise.all([
          getAppMeta("migration_001_phones_invalid_count"),
          getAppMeta("migration_001_phones_conflict_count"),
          readPendingUsage(),
          getInstalledAtUnixMs(),
          getLocalSelf(),
        ]);
        const resp = await checkIn({
          install_id: installId,
          app_version: currentVersion,
          platform: Platform.OS === "android" ? "android" : Platform.OS === "ios" ? "ios" : "web",
          // Real device (OS) locale, e.g. "fa-AF"/"en-US" — was hardcoded
          // "en-US" before (a dead signal). app_locale below is the in-app
          // language the user actually chose, which is what the dashboard splits on.
          device_locale: (() => {
            try {
              return require("expo-localization").getLocales()[0]?.languageTag ?? "unknown";
            } catch {
              return "unknown";
            }
          })(),
          app_locale: getLocale(),
          installed_at_unix_ms: installedAtMs ?? undefined,
          has_onboarded: Boolean(self),
          // B5: report the shopkeeper's OWN profile ONLY when signed in
          // (account_id present). An anonymous / "stay fully offline" install
          // was promised "your kaata never leaves this phone", so sending their
          // name/phone/shop with no account and no consent contradicted that.
          // Signing in is the consent boundary; offline installs send neither.
          // (Never customer data in any case.)
          self_name: accountIdRaw ? self?.name || undefined : undefined,
          self_phone: accountIdRaw ? self?.phone || undefined : undefined,
          shop_name: accountIdRaw ? self?.shop_name || undefined : undefined,
          phones_invalid_count: invalidStr ? Number(invalidStr) : undefined,
          phones_conflict_count: conflictStr ? Number(conflictStr) : undefined,
          usage_entries_created: usage.entries_created,
          usage_customers_added: usage.customers_added,
          usage_shares_sent: usage.shares_sent,
          // Always send the per-vault revocation cursor map (may be empty).
          // Empty map signals "first check-in" and pulls the full current
          // set. The server re-sources revocations from membership events
          // (M4) — the cursor is still how we page the delta.
          last_revocation_seen_at_ms:
            Object.keys(lastRevocationSeenAtMs).length > 0 ? lastRevocationSeenAtMs : undefined,
        });
        // Subtract only what we successfully sent. Concurrent bumps that
        // happened between readPendingUsage() and now ride the next check-in.
        await decrementPendingUsage(usage);
        if (!cancelled) await applyCheckIn(resp);
      } catch (err) {
        // Backend unreachable or slow — ignore, the app must work offline.
        // Engineering critique: in production we genuinely don't care
        // (the check-in is best-effort telemetry), but in development a
        // silently-swallowed error here can mask a real bug — e.g. a
        // bad EXPO_PUBLIC_BACKEND_URL or a deserialization mismatch on
        // the response. Log only when __DEV__ so production stays quiet.
        if (__DEV__) {
          // eslint-disable-next-line no-console
          console.warn("[BackgroundCheckIn] check-in failed", err);
        }
      }
    };

    void run(); // cold launch / mount

    // Imperative trigger: an identity-creating flow (onboarding completion via
    // createSelfProfile) can ask for an immediate check-in the moment the
    // local-self is committed. This closes the gap where the launch check-in
    // fired BEFORE the self existed (so has_onboarded=false, no name/phone) and
    // nothing re-fired in-session — leaving an offline-onboarded user invisible
    // on the admin dashboard until their next cold launch. Deliberately NOT
    // throttled (unlike the foreground path): it's a one-shot response to a
    // real state change, not a chatty liveness ping.
    const unsubImmediate = subscribeCheckInRequests(() => {
      void run();
    });

    // Re-run on background→active so "last seen" on the dashboard reflects the
    // user simply opening / returning to the app — no task (entry, etc.) needed.
    // Throttled so rapid app-switching doesn't spam the backend; the check-in is
    // idempotent + best-effort.
    let lastState = AppState.currentState;
    const sub = AppState.addEventListener("change", (next) => {
      const cameToForeground = lastState.match(/inactive|background/) != null && next === "active";
      lastState = next;
      if (cameToForeground && Date.now() - lastRunMs > FOREGROUND_THROTTLE_MS) {
        void run();
      }
    });

    return () => {
      cancelled = true;
      sub.remove();
      unsubImmediate();
    };
  }, [installId, applyCheckIn]);
  return null;
}
