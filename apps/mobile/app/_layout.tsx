// CRYPTO POLYFILL is installed by ./index.js (the registered entry point
// per package.json `main`), which runs BEFORE this layout module loads.
// We keep an idempotent re-import here so a hot-reload of _layout.tsx
// during development still gets the polyfill before any mesh code runs.
import "../lib/mesh/_ed25519-setup";

// D-FOREGROUND-HARDEN: this MUST be the second import.
//
// It is currently a NO-OP — the module's body is parked along with the rest of
// the mesh, and the notifee dependency it used has been removed outright. The
// import is kept only so the revive path keeps its load-order guarantee: the
// registration it performed had to happen at JS module load, before any code
// path could post a foreground-service notification, so that it survived
// process resurrection by Android (e.g. an FGS start intent re-delivered after
// a Doze kill, before the React tree mounts).
import "../lib/mesh/foreground-bootstrap";

import * as Application from "expo-application";
import * as Network from "expo-network";
import { Stack } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import { setStatusBarStyle, StatusBar } from "expo-status-bar";
import { useCallback, useEffect, useState } from "react";
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
import { stopShopModeForegroundService } from "../lib/mesh/foreground";

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
import { fonts, monoLineHeight, useAppFontsWithError } from "../lib/fonts";
import { getLocale, initLocaleFromPref, isPlaceholderSelfName, t } from "../lib/i18n";
import { ensureInstallId, getInstalledAtUnixMs } from "../lib/install-id";
import { sweepAllQuarantinedVaults } from "../lib/projection/sweep";
import { type BootError, type BootErrorStage, forceRestart, toBootError } from "../lib/boot-error";
import { asCorruptionError, DatabaseCorruptError } from "../lib/db-health";

const currentVersion = Application.nativeApplicationVersion || "0.1.0";

// UX critique #5: support contact surfaced on every boot-error screen so
// a stuck user has somewhere to send a screenshot. Single constant —
// changing it (e.g. from email to a WhatsApp number) is one edit.
// Declared up here so DbInitFailedPrompt + BootFailedPrompt can reference
// it without temporal-dead-zone gymnastics.
const SUPPORT_CONTACT = "support@kaata.af";

// Boot stages that actually run SQL. Only these are allowed to be reclassified
// as database corruption — see the note in step()'s catch.
const DB_BOOT_STAGES = new Set<BootErrorStage>([
  "install_id",
  "prime_caches",
  "user_prefs",
  "self_lookup",
]);

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
  // Non-null when quick_check found structural damage at boot: the file is
  // broken, not the schema, so restarting can never help. Drives the
  // recovery-capable prompt instead of the "close and reopen" one.
  const [dbCorrupt, setDbCorrupt] = useState<string | null>(null);
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

  // Bumped to re-run the whole boot sequence in-process. Two callers: the
  // recovery screen, once it has repaired the database, and the "try again"
  // button on the boot-failure screens.
  //
  // The alternative was forceRestart(), and it does not work on iOS: it is a
  // NO-OP there (react-native-restart is gone, and BackHandler.exitApp is
  // Android-only). So the recovery button would have replaced the database and
  // then left the user staring at the same error screen with no way forward,
  // and the boot-failure screens offered iPhone users no action at all.
  // Re-running boot is also simply better on Android — nothing survives a cold
  // start that isn't re-derived here, and the user doesn't have to go find the
  // app and reopen it.
  const [bootNonce, setBootNonce] = useState(0);
  const retryBoot = useCallback(() => {
    setBootError(null);
    setDbCorrupt(null);
    setDbReady(null);
    setAppReady(false);
    setBootNonce((n) => n + 1);
  }, []);

  useEffect(() => {
    // D-BOOT-CRASH-DEFENSE: every boot step funnels through `step()` so
    // we never need an outer catch-all that silently flips appReady=true
    // after a partial failure. On failure, bootError is set and appReady
    // stays false; the render gate below picks up BootFailedPrompt
    // instead of mounting the (partially-initialized) Stack.
    //
    // Hoisted out of the IIFE so the cleanup below can abort a run that is
    // still in flight when bootNonce changes. Without that, a retry would
    // start a SECOND boot sequence alongside the first, and two concurrent
    // initDb() calls share one connection — hasRunMigration is checked outside
    // the transaction, so both can decide the same migration is unapplied and
    // run it twice.
    let aborted = false;
    (async () => {
      const step = async <T,>(
        stage: Parameters<typeof toBootError>[0],
        fn: () => Promise<T>,
      ): Promise<T | undefined> => {
        if (aborted) return undefined;
        try {
          return await fn();
        } catch (err) {
          console.error(`[init] ${stage} failed`, err);
          // A damaged file doesn't wait for the integrity check to ask about
          // it — the first casualty is whichever query touches a bad page,
          // and ensureInstallId's app_meta read runs before initDb even
          // starts. Route a DB-touching stage whose failure SQLite describes
          // as corruption to the recovery screen, so the user gets the one
          // prompt that can actually help instead of "close and reopen".
          //
          // Restricted to the DB stages ON PURPOSE. The classifier matches the
          // bare substring "corrupt" (to catch SQLITE_CORRUPT however
          // expo-sqlite words it), which is broad enough that a font, locale
          // or Google-Sign-In error mentioning the word would otherwise send
          // a user with a perfectly healthy ledger to a screen offering to
          // replace their database.
          const corrupt = DB_BOOT_STAGES.has(stage) ? asCorruptionError(err) : null;
          if (corrupt) {
            setDbCorrupt(corrupt.details);
            setDbReady(false);
            aborted = true;
            void import("../lib/crash-report").then((cr) =>
              cr.queueCrashReport({
                kind: "boot",
                stage: "db_corrupt",
                name: "DatabaseCorruptError",
                message: `${stage}: ${corrupt.details}`.slice(0, 500),
              }),
            );
            return undefined;
          }
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

      // 0. Finish a restore that was interrupted between its two renames.
      //    This MUST come before any other step: every one of them reaches the
      //    database, and getDb() on a missing file creates an empty one — at
      //    which point the half-finished restore is indistinguishable from a
      //    fresh install and the user's recovered ledger is stranded under a
      //    temp name. Pure file operations, no SQL, so it cannot itself fail
      //    the way the steps below can.
      try {
        const { finishInterruptedRestore } = await import("../lib/db-backup");
        finishInterruptedRestore();
      } catch (err) {
        console.warn("[init] interrupted-restore check failed", err);
      }

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
        // Corruption is a DIFFERENT failure from "a migration threw": the
        // schema isn't partially applied, the file itself is damaged, and
        // restarting can never fix it. Flag it so the prompt below can offer
        // recovery, and report it home — this is exactly the event that was
        // previously invisible to us.
        // asCorruptionError, not `instanceof`: the integrity gate is not the
        // only statement in initDb that can hit a damaged page — a CREATE
        // TABLE or a migration's own SELECT can be the first to fail, and that
        // error arrives as a plain SQLite error. Classifying by SQLite's own
        // wording routes all of them to the recovery screen.
        const corrupt = asCorruptionError(err);
        if (corrupt) {
          setDbCorrupt(corrupt.details);
          void import("../lib/crash-report").then((cr) =>
            cr.queueCrashReport({
              kind: "boot",
              stage: "db_corrupt",
              name: "DatabaseCorruptError",
              message: corrupt.details.slice(0, 500),
            }),
          );
        }
        // CRITICAL: do NOT flip dbReady=true. Migrations are append-only
        // and atomic per-migration (each runs inside withTransactionAsync),
        // so a throw here means at least one migration's schema changes
        // rolled back. The vaults table (migration 007), event_log
        // indexes (010), mesh credentials (011), etc. may all be absent.
        // Rendering the Stack would let the user hit "no such table"
        // errors anywhere — better to refuse to mount and prompt a
        // restart than to pretend the app is healthy.
        console.error("[init] initDb failed — refusing to render Stack", err);
        if (!aborted) setDbReady(false);
        return; // skip rest of boot — every step below depends on the db.
      }
      if (!dbOk || aborted) return;
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

      // SOLO_STORE_MODE: Nearby sync isn't even toggleable in this build, but a
      // stale shop_mode_enabled="1" (from a prior non-solo build) + the START_STICKY
      // native foreground service means the OS keeps re-posting the "Nearby sync"
      // notification with no way to turn it off. Kill it EARLY on every boot — clear
      // the flag so MeshController never restarts it, and stop the native FGS so the
      // notification disappears now (not after the 10s app-meta poll). Best-effort.
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
      if (aborted) return;
      setAppReady(true);
    })();
    return () => {
      aborted = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bootNonce]);

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
    // Rolling local backup — the only protection for the ~half of users who
    // never sign in, and the only thing that survives a corruption predating
    // the last sync. Both triggers are rate-limited to 6h inside backupIfDue
    // and fully best-effort.
    //
    // The delayed launch pass exists because backgrounding is NOT a reliable
    // trigger: a user who leaves the app by swiping it out of recents may give
    // the async copy no time to finish, and some do that every single time. 20
    // seconds in, the boot burst is over and the shopkeeper is reading, not
    // typing.
    const launchBackup = setTimeout(() => {
      void import("../lib/db-backup").then((b) => b.backupIfDue());
    }, 20_000);

    let last = AppState.currentState;
    const sub = AppState.addEventListener("change", (next) => {
      const cameToForeground = last.match(/inactive|background/) != null && next === "active";
      const wentToBackground = last === "active" && next.match(/inactive|background/) != null;
      last = next;
      if (cameToForeground) void sweepAllQuarantinedVaults();
      // Taken on the way OUT so it can't delay a cold start.
      if (wentToBackground) {
        void import("../lib/db-backup").then((b) => b.backupIfDue());
      }
    });
    return () => {
      clearTimeout(launchBackup);
      sub.remove();
    };
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

  // PARKED: notification-tap routing for the "Nearby sync" foreground-service
  // notification lived here — open `/?menu=sync` when the user tapped it
  // (both while running and on cold start). The notification is parked
  // (lib/mesh/foreground.ts), so it never posts and never gets tapped; the
  // handlers + the pendingSyncNav state they drove were removed. Restore from
  // git history when reviving Nearby sync.

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
    return dbCorrupt ? (
      <DbCorruptPrompt details={dbCorrupt} onRecovered={retryBoot} />
    ) : (
      <DbInitFailedPrompt onRetry={retryBoot} />
    );
  }
  // D-BOOT-CRASH-DEFENSE: any captured fatal from a non-db stage. dbReady
  // wins above so the existing DbInitFailedPrompt copy isn't shadowed.
  if (bootError) {
    // canRetryInProcess keys off fontsError itself, NOT the reported stage. The
    // fonts effect above overwrites bootError the moment retryBoot clears it,
    // so a screen showing some other stage could flip to "fonts" mid-press —
    // taking its own button away and leaving the retry unrun.
    return (
      <BootFailedPrompt error={bootError} onRetry={retryBoot} canRetryInProcess={!fontsError} />
    );
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
              {/* Removed people — archived contacts with their kept entries,
                  restorable. Reached from a "Removed people" row in vault
                  settings (rendered only when the active vault has any). */}
              <Stack.Screen name="vault/removed-people" options={{ presentation: "card" }} />
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
    // 32 → 28, the `display` step in lib/tokens typography — the same size the
    // home header's wordmark carries, so cold start and first frame don't
    // change size under the user.
    //
    // The SIZE is all we take. These boot/recovery screens are deliberately
    // system-font (no fontFamily): this is the surface that renders while
    // Vazirmatn is still loading, and the one that renders when loading it
    // FAILED (bootError stage "fonts"). Spreading typography.display would name
    // a family that may not exist yet and floor the line box at Vazirmatn's
    // 1.5625em metrics for a face that isn't there. System metrics are ~1.2em,
    // which is exactly the exemption lib/fonts.ts documents.
    fontSize: 28,
    fontWeight: "700",
    color: "#FFFFFF",
    // No letterSpacing: these boot/recovery screens render the English and
    // Dari wordmark SIMULTANEOUSLY (the locale pref lives in a database we may
    // not have read yet, or cannot read at all), so there is no isRTL to gate
    // on and tracking would sever the Persian one.
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
function DbInitFailedPrompt({ onRetry }: { onRetry: () => void }) {
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
        <View style={migrationStyles.spacer} />
        {/* Android closes the app so the user reopens into a clean process.
            iOS can't: forceRestart() is a no-op there, and this screen used to
            render NO button at all on iPhone — half our users, given an error
            and nothing to press. Migrations are per-migration transactional
            and idempotent, so re-running boot in place resumes exactly where
            the failed one stopped. */}
        <Pressable
          onPress={() => (Platform.OS === "android" ? forceRestart() : onRetry())}
          style={({ pressed }) => [migrationStyles.button, pressed && { opacity: 0.85 }]}
        >
          <Text style={migrationStyles.buttonText}>
            {Platform.OS === "android" ? "Close kaata · بستن کاتا" : "Try again · دوباره کوشش کنید"}
          </Text>
        </Pressable>
      </View>
    </View>
  );
}

// Rendered when quick_check finds the database is structurally damaged.
//
// Distinct from DbInitFailedPrompt on purpose: that screen's advice ("close
// and reopen") is right for a partially-applied schema and USELESS here — the
// file is broken, so every restart lands back on the same screen. That loop,
// with no way out but reinstalling (which destroys the ledger of anyone not
// signed in), was the actual failure mode.
//
// Two recovery paths, offered in the order that preserves the most data:
//
//  1. The rolling local backup (lib/db-backup.ts). Offered to EVERYONE — about
//     half of Kaata's users never sign in, so they are exactly the people a
//     recovery screen exists for, and they were the ones the previous version
//     of this screen had nothing to offer. It also beats the server copy for
//     signed-in users whose damage predates their last sync.
//  2. The server snapshot, for signed-in users. The session JWT lives in
//     SecureStore, untouched by database damage, so wiping the file and
//     re-running the restore flow gets their ledger back.
//
// Both are probed before either is offered — a button for a recovery that
// cannot work is worse than no button.
function DbCorruptPrompt({ details, onRecovered }: { details: string; onRecovered: () => void }) {
  // The probe asks db-backup which generation a restore would ACTUALLY use,
  // rather than just whether a backup file exists. That distinction is the
  // difference between offering a button that works and one that fails on
  // press, and between quoting the age of the file we will really restore and
  // the age of whichever happens to be newest.
  //
  // hasBackup is tracked separately from backupAt: a usable backup whose
  // modificationTime the platform won't report is still a restorable backup,
  // and keying the button off the timestamp would hide it.
  const [probe, setProbe] = useState<{
    hasBackup: boolean;
    backupAt: number | null;
    signedIn: boolean;
  } | null>(null);
  const [working, setWorking] = useState<null | "local" | "account">(null);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      let hasBackup = false;
      let backupAt: number | null = null;
      let signedIn = false;
      try {
        const { findRestoreCandidate } = await import("../lib/db-backup");
        const candidate = await findRestoreCandidate();
        hasBackup = candidate != null;
        backupAt = candidate?.modifiedAt ?? null;
      } catch {
        /* no usable backup */
      }
      try {
        const { isSignedIn } = await import("../lib/auth");
        signedIn = await isSignedIn();
      } catch {
        /* treat as signed out */
      }
      if (alive) setProbe({ hasBackup, backupAt, signedIn });
    })();
    return () => {
      alive = false;
    };
  }, []);

  // Swap the damaged file for the newest verified backup and re-run boot. The
  // damaged original is kept (as kaata.corrupt.db) rather than deleted — it is
  // the only copy of anything written since the backup.
  async function onRestoreLocal() {
    if (working) return;
    setWorking("local");
    setFailure(null);
    try {
      const { restoreFromLocalBackup } = await import("../lib/db-backup");
      const result = await restoreFromLocalBackup();
      if (result === "restored") {
        onRecovered();
        return;
      }
      setFailure(
        result === "backup_damaged"
          ? "The backup on this phone is damaged too."
          : result === "no_backup"
            ? "No backup was found on this phone."
            : "Restoring from the backup failed.",
      );
    } catch (err) {
      console.error("[db-corrupt] local restore failed", err);
      setFailure("Restoring from the backup failed.");
    } finally {
      setWorking(null);
    }
  }

  // Wipe the damaged database and hand the user back to the sign-in step,
  // which routes into the server restore probe. Deliberately NOT automatic:
  // it destroys whatever is left locally, so it stays a button the user
  // presses after reading what it does.
  async function onRestoreFromAccount() {
    if (working) return;
    setWorking("account");
    setFailure(null);
    try {
      try {
        const { resetAllLocalData } = await import("../lib/db");
        // Keep the local backup: the server restore hasn't happened yet, and
        // if it comes back empty that backup is the only ledger left.
        await resetAllLocalData({ keepLocalBackups: true });
      } catch (err) {
        // resetAllLocalData works by DROPping tables, which needs a readable
        // database — exactly what we don't have. Delete the files instead.
        // Note this closes the handle FIRST: expo-sqlite's
        // deleteDatabaseAsync throws while a connection is open, so the old
        // code's fallback failed in every case it was written for.
        console.error("[db-corrupt] reset failed, deleting the database files", err);
        const {
          getDb,
          _resetAccountIdCacheForReset,
          _resetActiveVaultIdCacheForReset,
          _resetDbHandleForReset,
        } = await import("../lib/db-tx");
        try {
          const db = await getDb();
          await db.closeAsync();
        } catch {
          /* already unusable */
        }
        // Same set resetAllLocalData clears on its success path. The active
        // vault cache especially: getActiveVaultId() short-circuits on it, so
        // leaving it set would carry a deleted vault's id into the fresh
        // database.
        _resetDbHandleForReset();
        _resetActiveVaultIdCacheForReset();
        _resetAccountIdCacheForReset();
        const { deleteLiveDatabaseFiles } = await import("../lib/db-backup");
        deleteLiveDatabaseFiles();
      }

      // Rebuild an empty database and mark the onboarding step as 'auth'.
      // Without this the next launch sees no app_meta at all and starts at the
      // language picker — a signed-in user looking for their ledger back would
      // have been walked through a fresh install instead. Signing in again
      // repopulates account_id and lands them on the restore probe.
      const { ensureInstallId } = await import("../lib/install-id");
      const { initDb, setAppMeta } = await import("../lib/db");
      const freshId = await ensureInstallId();
      await initDb({ installId: freshId });
      await setAppMeta("onboarding_step", "auth");
      onRecovered();
    } catch (err) {
      console.error("[db-corrupt] account recovery failed", err);
      setFailure("Recovery failed. Please contact support before reinstalling.");
      setWorking(null);
    }
  }

  const busy = working !== null;
  const hasBackup = probe?.hasBackup === true;

  return (
    <View style={migrationStyles.container}>
      <View style={migrationStyles.card}>
        <Text style={migrationStyles.wordmark}>{t("brand.wordmark")}</Text>
        <View style={migrationStyles.spacer} />
        <Text style={migrationStyles.heading}>Your Kaata data is damaged</Text>
        <Text style={migrationStyles.headingFa}>داده‌های کاتای شما آسیب دیده</Text>
        <View style={migrationStyles.spacer} />

        {probe === null ? (
          <ActivityIndicator color={colors.textMuted} />
        ) : (
          <>
            {hasBackup && (
              <>
                <Text style={migrationStyles.body}>
                  There is a backup on this phone{formatBackupAge(probe.backupAt)}. Restoring it
                  brings your kaata back to that point.
                </Text>
                <View style={migrationStyles.spacerSmall} />
                <Text style={migrationStyles.bodyFa}>
                  در این تلفون یک پشتیبان وجود دارد. با بازیابی آن، کاتای شما تا همان زمان
                  برمی‌گردد.
                </Text>
                <View style={migrationStyles.spacer} />
                <Pressable
                  onPress={() => void onRestoreLocal()}
                  disabled={busy}
                  style={({ pressed }) => [
                    migrationStyles.button,
                    (pressed || busy) && { opacity: 0.85 },
                  ]}
                >
                  {working === "local" ? (
                    <ActivityIndicator color={colors.textInverted} />
                  ) : (
                    <Text style={migrationStyles.buttonText}>
                      Restore this phone&apos;s backup · بازیابی پشتیبان
                    </Text>
                  )}
                </Pressable>
              </>
            )}

            {probe.signedIn && (
              <>
                <View style={migrationStyles.spacer} />
                <Text style={migrationStyles.body}>
                  You&apos;re signed in, so your kaata can also be restored from your account.
                </Text>
                <View style={migrationStyles.spacerSmall} />
                <Text style={migrationStyles.bodyFa}>
                  شما وارد شده‌اید، پس کاتای شما از حساب‌تان هم بازیابی شده می‌تواند.
                </Text>
                <View style={migrationStyles.spacer} />
                <Pressable
                  onPress={() => void onRestoreFromAccount()}
                  disabled={busy}
                  style={({ pressed }) => [
                    hasBackup ? migrationStyles.buttonSecondary : migrationStyles.button,
                    (pressed || busy) && { opacity: 0.85 },
                  ]}
                >
                  {working === "account" ? (
                    <ActivityIndicator
                      color={hasBackup ? colors.textDefault : colors.textInverted}
                    />
                  ) : (
                    <Text
                      style={
                        hasBackup ? migrationStyles.buttonSecondaryText : migrationStyles.buttonText
                      }
                    >
                      Restore from my account · بازیابی از حساب
                    </Text>
                  )}
                </Pressable>
              </>
            )}

            {/* No backup and no account. This is a real state — every install
                is in it until the first backup runs, and a database that has
                been degrading for a while may never have produced one. It used
                to render text and NOTHING else: a terminal screen with no
                button, for the half of our users who never sign in. "Try
                again" is not a fix, but the underlying failure is not always
                permanent (a locked or momentarily unreadable file recovers),
                and a dead end is the worst possible answer. */}
            {!hasBackup && !probe.signedIn && (
              <>
                <Text style={migrationStyles.body}>
                  Please contact us before reinstalling — reinstalling erases the ledger on this
                  phone.
                </Text>
                <View style={migrationStyles.spacerSmall} />
                <Text style={migrationStyles.bodyFa}>
                  پیش از نصب دوباره با ما تماس بگیرید — نصب دوباره کتاب این تلفون را پاک می‌کند.
                </Text>
                <View style={migrationStyles.spacer} />
                <Pressable
                  onPress={onRecovered}
                  style={({ pressed }) => [
                    migrationStyles.buttonSecondary,
                    pressed && { opacity: 0.85 },
                  ]}
                >
                  <Text style={migrationStyles.buttonSecondaryText}>
                    Try again · دوباره کوشش کنید
                  </Text>
                </Pressable>
              </>
            )}
          </>
        )}

        {failure && (
          <>
            <View style={migrationStyles.spacerSmall} />
            <Text style={bootErrorStyles.failure}>{failure}</Text>
          </>
        )}

        <View style={migrationStyles.spacer} />
        <Text style={bootErrorStyles.support}>
          If it keeps happening, contact {SUPPORT_CONTACT}
        </Text>
        <Text style={bootErrorStyles.supportFa}>
          اگر تکرار شد، با {SUPPORT_CONTACT} تماس بگیرید
        </Text>
        <View style={migrationStyles.spacerSmall} />
        <Text style={bootErrorStyles.detail} numberOfLines={3}>
          {details}
        </Text>
      </View>
    </View>
  );
}

// Coarse age of the local backup, as a sentence fragment (" from 2 days ago")
// or "" when the platform gave us no timestamp. English only: this is a
// boot-time failure surface reached before the locale is loaded, and the age is
// the one fact the user needs to judge whether restoring is worth it.
function formatBackupAge(at: number | null): string {
  if (at == null) return "";
  // Epoch MILLISECONDS — the new expo-file-system File API's unit. (The legacy
  // getInfoAsync returned seconds; don't reintroduce a ×1000.)
  const hours = Math.floor((Date.now() - at) / 3_600_000);
  if (!Number.isFinite(hours) || hours < 0) return "";
  if (hours < 1) return " from less than an hour ago";
  if (hours < 24) return ` from ${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.floor(hours / 24);
  return ` from ${days} day${days === 1 ? "" : "s"} ago`;
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
// canRetryInProcess is false once the fonts have failed to load. That is the
// one condition an in-process retry CANNOT clear: useFonts is a hook that has
// already settled, re-running the boot sequence never re-invokes it, and the
// render gate needs fontsReady before it will mount anything. Offering "Try
// again" there would flash the splash and land straight back on this screen.
// Only a real process restart reloads the fonts, which iOS can't do from here
// — so iOS keeps the force-quit instructions above and no button, which is at
// least honest.
function BootFailedPrompt({
  error,
  onRetry,
  canRetryInProcess,
}: {
  error: BootError;
  onRetry: () => void;
  canRetryInProcess: boolean;
}) {
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
        {/* On iOS this used to read "Force quit" and do NOTHING — forceRestart
            is Android-only — so the single action on the screen was dead. Most
            of what fails up there is transient (a flaky locale probe, a
            database that wasn't ready yet), which re-running boot does fix. */}
        {Platform.OS === "android" || canRetryInProcess ? (
          <Pressable
            onPress={() => (Platform.OS === "android" ? forceRestart() : onRetry())}
            style={({ pressed }) => [migrationStyles.button, pressed && { opacity: 0.85 }]}
          >
            <Text style={migrationStyles.buttonText}>
              {Platform.OS === "android"
                ? "Close & restart · بستن و راه‌اندازی"
                : "Try again · دوباره کوشش کنید"}
            </Text>
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

const bootErrorStyles = StyleSheet.create({
  // Raw quick_check output on the corruption screen — small and muted: it is
  // for a support screenshot, not for the shopkeeper to read.
  detail: {
    fontSize: 11,
    color: colors.textMuted,
    textAlign: "center",
  },
  // A recovery attempt that didn't work. Red, because the user just pressed a
  // button expecting their ledger back and needs to know it didn't happen —
  // the other options on the screen are still there to try.
  failure: {
    fontSize: 13,
    color: colors.danger,
    textAlign: "center",
    lineHeight: 19,
  },
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
    // Was the raw string "JetBrainsMono_400Regular" + lineHeight 16. JetBrains
    // Mono's natural height at 11px is 15, so 16 cleared the iOS clip by
    // exactly 1px — by luck, not by design. Bump the size to 12 and it clips.
    fontFamily: fonts.monoRegular,
    fontSize: 11,
    color: colors.textDefault,
    lineHeight: monoLineHeight(11, 16),
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
    // 32 → 28 (`display`), size only — see bootSplashStyles.wordmark for why
    // these screens stay on the system font and can't take the token object.
    fontSize: 28,
    fontWeight: "700",
    color: colors.textEmphasis,
    // No letterSpacing — same bilingual boot surface as the splash wordmark.
  },
  spacer: { height: 24 },
  spacerSmall: { height: 12 },
  // 17 → 16, the `title` step. Both language variants shrink together so the
  // EN/FA pair stays a matched set. Downsizing on a card capped at 360px wide,
  // so a heading that fits on one line today still does.
  heading: {
    fontSize: 16,
    fontWeight: "600",
    color: colors.textEmphasis,
    textAlign: "center",
  },
  headingFa: {
    fontSize: 16,
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
  // Used for the server restore when a local backup is also on offer, so the
  // two buttons read as first choice and second choice rather than as a pair
  // of equal options — the local backup is usually the newer of the two.
  buttonSecondary: {
    paddingHorizontal: 22,
    paddingVertical: 14,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.borderDefault,
    backgroundColor: colors.bgDefault,
  },
  buttonSecondaryText: {
    fontSize: 14,
    fontWeight: "600",
    color: colors.textDefault,
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
          // The shopkeeper's OWN profile (name / phone / shop) — sent regardless
          // of sign-in state. Operator decision 2026-07-10 (reversing the
          // short-lived B5 signed-in-only gate of 2026-07-08): the admin
          // dashboard needs offline-mode users' identity for churn outreach,
          // and the published privacy policy + Play Data Safety answers
          // already disclose exactly this ("own profile on check-in, no
          // sign-in required" — docs/play-data-safety.md). Scope is
          // getLocalSelf() only — never customers/suppliers.
          // Placeholder-guarded: a restore-minted "You"/"شما" self must not
          // reach installs.self_name — the vaults listing's name fallback
          // would echo "You" onto every member's Members tab as this person.
          self_name: self?.name && !isPlaceholderSelfName(self.name) ? self.name : undefined,
          self_phone: self?.phone || undefined,
          shop_name: self?.shop_name || undefined,
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
