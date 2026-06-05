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
import { ToastProvider } from "../components/Toast";

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
import { initCurrencyFromPref } from "../lib/currency";
import { useAppFonts } from "../lib/fonts";
import { initLocaleFromPref } from "../lib/i18n";
import { ensureInstallId, getInstalledAtUnixMs } from "../lib/install-id";

const currentVersion = Application.nativeApplicationVersion || "0.1.0";

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
  const [installId, setInstallId] = useState<string | null>(null);
  const [hasOnboarded, setHasOnboarded] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        await initDb();
        // Apply user prefs (language override, currency choice) before the
        // first render so labels and amount currency codes are correct from
        // frame zero. Both read app_meta; safe to await right after initDb()
        // since the table is guaranteed.
        await Promise.all([initLocaleFromPref(), initCurrencyFromPref()]);
        // No I18nManager reconciliation here — direction is sandboxed via
        // lib/direction.ts. The init load above sets currentLocale, which
        // derives the internal direction flag synchronously.
        const id = await ensureInstallId();
        const self = await getLocalSelf();
        setInstallId(id);
        setHasOnboarded(Boolean(self));
      } catch (err) {
        console.warn("[init] failed", err);
      } finally {
        setAppReady(true);
      }
    })();
  }, []);

  if (!appReady || !fontsReady) {
    return (
      <View
        style={{
          flex: 1,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: colors.bgDefault,
        }}
      >
        <ActivityIndicator color={colors.textDefault} />
      </View>
    );
  }

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <ToastProvider>
          <AppMetaProvider currentVersion={currentVersion}>
            <StatusBar style="dark" />
            {installId ? <BackgroundCheckIn installId={installId} /> : null}
            <Stack
              initialRouteName={hasOnboarded ? "index" : "onboarding"}
              screenOptions={{
                headerShown: false,
                contentStyle: { backgroundColor: colors.bgDefault },
              }}
            >
              <Stack.Screen name="index" />
              <Stack.Screen name="onboarding" options={{ gestureEnabled: false }} />
              <Stack.Screen
                name="update-prompt"
                options={{ presentation: "fullScreenModal", gestureEnabled: false }}
              />
              <Stack.Screen name="person/[id]" />
              <Stack.Screen name="person/[id]/edit" options={{ presentation: "modal" }} />
              <Stack.Screen name="person/new" options={{ presentation: "modal" }} />
              <Stack.Screen name="entry/new" options={{ presentation: "modal" }} />
              <Stack.Screen name="entry/[id]/edit" options={{ presentation: "modal" }} />
            </Stack>
          </AppMetaProvider>
        </ToastProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

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
