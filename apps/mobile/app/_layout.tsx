import * as Application from "expo-application";
import * as Network from "expo-network";
import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useEffect, useState } from "react";
import {
  ActivityIndicator,
  BackHandler,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { AutoSync } from "../components/AutoSync";
import { MeshController } from "../components/MeshController";
import { ProjectionConflictsListener } from "../components/ProjectionConflictsListener";
import { ToastProvider } from "../components/Toast";
import {
  ensureShopModeChannel,
  registerShopModeForegroundTask,
  SHOP_MODE_NOTIFICATION_ID,
} from "../lib/mesh/foreground";

// Phase 5.1: notifee requires the foreground-service task be registered at
// module load, before any displayNotification({asForegroundService:true})
// call. Safe to invoke on every JS bundle load — registration is idempotent
// and no-ops on non-Android platforms / Expo Go via the wrapper.
registerShopModeForegroundTask();

// D-FOREGROUND-CRASH: Kick off channel creation at module load — not inside
// the boot useEffect — so any cold-start auto-resume path that calls
// startShopMode() before the React tree mounts still finds the channel
// present. createChannel is idempotent on channelId, and
// startShopModeForegroundService also awaits ensureShopModeChannel as
// belt-and-suspenders.
ensureShopModeChannel().catch((err) => {
  if (__DEV__) console.warn("[init] ensureShopModeChannel (boot)", err);
});

// Phase 5.1: notifee also requires onBackgroundEvent to be registered at
// module top level (NOT inside a component effect) so it's subscribed even
// when the app is cold-started by a notification tap. The handler is a
// no-op today — the cold-start route picks up `?menu=sync` via expo-router's
// initialURL — but registering here suppresses notifee's "no background
// handler" runtime warning and keeps the contract correct for when we add
// actionable notifications.
if (Platform.OS === "android") {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const notifee = require("@notifee/react-native");
    notifee.default.onBackgroundEvent(async () => {
      // intentional no-op — see comment above.
    });
  } catch {
    // notifee not bundled (Expo Go / web) — fine, foreground service is
    // already gated on it elsewhere.
  }
}

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
import { AppMetaProvider, useAppMeta } from "../lib/app-meta-context";
import { colors } from "../lib/colors";
import {
  decrementPendingUsage,
  getAppMeta,
  getLocalSelf,
  initDb,
  readPendingUsage,
} from "../lib/db";
import {
  primeActiveVaultId,
  refreshAccountIdCache,
  setInstallIdCache,
  setLocalSelfUserIdCache,
} from "../lib/db-tx";
import { configureGoogleSignIn } from "../lib/auth";
import { initCurrencyFromPref } from "../lib/currency";
import { initDefaultCountryFromPref } from "../lib/phone";
import { useAppFonts } from "../lib/fonts";
import { initLocaleFromPref } from "../lib/i18n";
import { ensureInstallId, getInstalledAtUnixMs } from "../lib/install-id";

const currentVersion = Application.nativeApplicationVersion || "0.1.0";

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
  onboardingStep: "language" | "auth" | "profile" | "done" | null;
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

  const fontsReady = useAppFonts();
  const [appReady, setAppReady] = useState(false);
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
  // Resumable onboarding step: 'language' | 'auth' | 'profile' | 'done' | null.
  // Read from app_meta on launch so a force-quit mid-flow returns the
  // user to the screen they were last on, not back to step 1.
  const [onboardingStep, setOnboardingStep] = useState<
    "language" | "auth" | "profile" | "done" | null
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

  useEffect(() => {
    (async () => {
      try {
        // Mint / fetch install_id and prime its cache BEFORE migrations run
        // so migration 006 (synthetic backfill) can stamp it as the hlc.did
        // on every backfilled event. Without this ordering, migration 006
        // would have to fall back to an all-zero UUID for any upgrader whose
        // install_id was somehow missing — permanently poisoning HLC
        // tiebreaks. initDb is split: it always creates app_meta /
        // schema_migrations first, then accepts the freshly-minted id, then
        // runs migrations 001-006. ensureInstallId itself only reads/writes
        // app_meta, so it can run between the bootstrap and the migrations.
        const id = await ensureInstallId();
        setInstallIdCache(id);
        try {
          await initDb({ installId: id });
          setDbReady(true);
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
        // Phase 2: Migration 007 (which initDb just ran) writes
        // app_meta.active_vault_id for any install that had ledger state.
        // Prime the in-memory cache NOW so every subsequent query in this
        // boot block (getLocalSelf, BackgroundCheckIn, home listAllPeople)
        // can use the synchronous getActiveVaultIdSync() inside transactions
        // without paying for a per-query app_meta lookup. Brand-new
        // installs return null and reads gracefully no-op until onboarding
        // mints a vault.
        await primeActiveVaultId();
        // Prime the account_id cache so post-sign-in event appends stamp
        // actor_account_id directly instead of relying on the account_bound
        // retroactive re-stamping for events authored after sign-in. Reads
        // app_meta.account_id, which postSignInHousekeeping writes after
        // a successful Google sign-in. Returns null on a not-yet-signed-in
        // install, which is the correct value to stamp on those events.
        await refreshAccountIdCache();
        // Apply user prefs (language override, currency choice) before the
        // first render so labels and amount currency codes are correct from
        // frame zero. Both read app_meta; safe to await right after initDb()
        // since the table is guaranteed.
        await Promise.all([
          initLocaleFromPref(),
          initCurrencyFromPref(),
          initDefaultCountryFromPref(),
        ]);
        // Google sign-in configuration is module-level state on the native
        // module. Calling configure() once at app start sets the webClientId
        // that will be used by every subsequent GoogleSignin.signIn() call.
        // Safe to call repeatedly — it's idempotent.
        configureGoogleSignIn();
        // No I18nManager reconciliation here — direction is sandboxed via
        // lib/direction.ts. The init load above sets currentLocale, which
        // derives the internal direction flag synchronously.
        const [self, step, accountIdRaw] = await Promise.all([
          getLocalSelf(),
          getAppMeta("onboarding_step"),
          getAppMeta("account_id"),
        ]);
        // Prime the local-self identity cache that lib/event-log.ts reads
        // synchronously on every entry write. install_id was already primed
        // above before initDb so migration 006 had access to it.
        setLocalSelfUserIdCache(self?.user_id ?? null);
        setInstallId(id);
        setHasOnboarded(Boolean(self));
        // Phase 3 restore gate. Only meaningful if accountIdRaw is set —
        // restore_skipped_for_account_<id> is per-account so signing into
        // a different Google account on the same device still triggers
        // the restore prompt.
        setAccountId(accountIdRaw ?? null);
        if (accountIdRaw) {
          const skipped = await getAppMeta(`restore_skipped_for_account_${accountIdRaw}`);
          setRestoreSkipped(skipped === "1");
        }
        // Validate the step value — only the four known states pass through.
        if (step === "language" || step === "auth" || step === "profile" || step === "done") {
          setOnboardingStep(step);
        }
        // Detect device locale for skip-language decision. Fresh installs
        // get locale_pref=null at this point; this read is just the raw
        // device value.
        const deviceLang = await (async () => {
          // expo-localization is already imported into lib/i18n via
          // getLocales(); reuse that via a side-effect-free helper. We
          // can read the same source from here without re-importing.
          // Lazy require to keep the top of this file clean.
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          const { getLocales } = require("expo-localization");
          return (getLocales()[0]?.languageCode ?? "en").toLowerCase();
        })();
        setDeviceIsPersian(deviceLang === "fa" || deviceLang === "prs");
        // Phase 5.1: ensure the persistent notification channel for Shop
        // Mode foreground service exists. Idempotent — channelId is the
        // key; no-ops on non-Android.
        try {
          await ensureShopModeChannel();
        } catch (err) {
          if (__DEV__) console.warn("[init] ensureShopModeChannel", err);
        }
      } catch (err) {
        console.warn("[init] failed", err);
      } finally {
        setAppReady(true);
      }
    })();
  }, []);

  // Phase 5.1: route notification taps on the Shop Mode foreground-service
  // notification into the hamburger menu's Sync section. We open the home
  // route with ?menu=sync; the home screen reads that param on mount and
  // auto-opens the sheet. The handler is registered separately from the
  // init effect so it stays subscribed even after the splash animation.
  //
  // Phase 6: ALSO handle the cold-start case via getInitialNotification —
  // notifee's onForegroundEvent only fires while the JS engine is alive,
  // so a tap that cold-starts the app from "killed" needs the separate
  // getInitialNotification check (UX critique L-cold-start).
  useEffect(() => {
    if (Platform.OS !== "android") return;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let notifee: any;
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      notifee = require("@notifee/react-native");
    } catch {
      return;
    }
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
          router.push("/?menu=sync");
        } catch {
          /* */
        }
      }
    });

    // Phase 6 cold-start handler: if the app was launched via the
    // notification tap (the JS engine wasn't alive when the user tapped),
    // getInitialNotification resolves with the notification + pressAction.
    // We defer the router.push so the Stack has had a chance to mount.
    void (async () => {
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const fg = await import("../lib/mesh/foreground");
        const initial = await fg.getInitialShopModeNotification();
        if (initial?.pressActionId === "open-shop-mode-settings") {
          setTimeout(() => {
            try {
              // eslint-disable-next-line @typescript-eslint/no-require-imports
              const { router } = require("expo-router");
              router.push("/?menu=sync");
            } catch {
              /* */
            }
          }, 250);
        }
      } catch {
        /* */
      }
    })();

    return () => {
      if (typeof unsub === "function") unsub();
    };
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
  if (!appReady || !fontsReady || dbReady !== true) {
    return <BootSplash />;
  }

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <ToastProvider>
          <AppMetaProvider currentVersion={currentVersion}>
            <StatusBar style="dark" />
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
              {/* Phase 7 settings-adjacent sub-pages — all registered as
                  Stack cards (no presentation override) to give a
                  consistent push-pop feel with a single back-arrow
                  header per screen. We earlier tried
                  `presentation: "modal"` for preferences and hit the
                  same Android partial-height-sheet bug that bit
                  vault/new — SafeAreaView pushed content above the
                  visible area and the top of the form was clipped.
                  Cards are clean, positioning is correct, and
                  router.back() returns to the home host (the parent
                  ProfileSettingsSheet is already dismissed by the
                  chained() 220ms defer before the push lands). */}
              <Stack.Screen name="preferences" />
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
      <Text style={bootSplashStyles.wordmark}>kaata.</Text>
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
  return (
    <View style={migrationStyles.container}>
      <View style={migrationStyles.card}>
        <Text style={migrationStyles.wordmark}>kaata.</Text>
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
              onPress={() => BackHandler.exitApp()}
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
function DbInitFailedPrompt() {
  return (
    <View style={migrationStyles.container}>
      <View style={migrationStyles.card}>
        <Text style={migrationStyles.wordmark}>kaata.</Text>
        <View style={migrationStyles.spacer} />
        <Text style={migrationStyles.heading}>Couldn&apos;t open the database</Text>
        <Text style={migrationStyles.headingFa}>پایگاه داده باز نشد</Text>
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
        {Platform.OS === "android" ? (
          <>
            <View style={migrationStyles.spacer} />
            <Pressable
              onPress={() => BackHandler.exitApp()}
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

function BackgroundCheckIn({ installId }: { installId: string }) {
  const { applyCheckIn } = useAppMeta();
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const netState = await Network.getNetworkStateAsync();
        if (!netState.isConnected) return;
        // Phase 5: only read mesh-side renewal hints when the install has
        // actually completed Google sign-in. A brand-new local-only install
        // has no account_id, no vault_credentials, and no revocation
        // cursors — paying the @noble SHA-512 wiring cost during cold boot
        // for nothing is wasteful. Once account_id is present we dynamic-
        // import the mesh entrypoint (which wires up sha512Sync at module
        // load) and ask it for its check-in deltas.
        const accountIdRaw = await getAppMeta("account_id");
        let vmcRenewalsNeeded: string[] = [];
        let lastRevocationSeenAtMs: Record<string, number> = {};
        if (accountIdRaw) {
          const mesh = await import("../lib/mesh");
          vmcRenewalsNeeded = await mesh.collectRenewalsForCheckIn();
          lastRevocationSeenAtMs = await mesh.getLastRevocationSeenAtMs();
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
          device_locale: "en-US",
          installed_at_unix_ms: installedAtMs ?? undefined,
          has_onboarded: Boolean(self),
          phones_invalid_count: invalidStr ? Number(invalidStr) : undefined,
          phones_conflict_count: conflictStr ? Number(conflictStr) : undefined,
          usage_entries_created: usage.entries_created,
          usage_customers_added: usage.customers_added,
          usage_shares_sent: usage.shares_sent,
          // Only send the array when non-empty. Backend treats an absent
          // field as "no renewal requested" and skips the (somewhat
          // expensive) signing path entirely.
          vmc_renewals_needed: vmcRenewalsNeeded.length > 0 ? vmcRenewalsNeeded : undefined,
          // Always send the per-vault cursor map (may be empty). Empty map
          // signals "first check-in" and pulls the full current set.
          last_revocation_seen_at_ms:
            Object.keys(lastRevocationSeenAtMs).length > 0 ? lastRevocationSeenAtMs : undefined,
        });
        // Subtract only what we successfully sent. Concurrent bumps that
        // happened between readPendingUsage() and now ride the next check-in.
        await decrementPendingUsage(usage);
        if (!cancelled) await applyCheckIn(resp);
      } catch {
        // Backend unreachable or slow — ignore, the app must work offline.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [installId, applyCheckIn]);
  return null;
}
