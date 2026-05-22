import * as Application from "expo-application";
import * as Network from "expo-network";
import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useEffect, useState } from "react";
import { ActivityIndicator, I18nManager, Platform, View } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { ToastProvider } from "../components/Toast";

// Lock the app to LTR. The whole UI was designed for an LTR reading flow
// (kaata. wordmark on the left, chevrons pointing right, ping bar pinned
// to the bottom, swipe-tabs "left = next" semantic). Auto-RTL — triggered
// when the device locale is Persian/Dari/Arabic/Urdu — flips margins,
// icons, flex directions, and gesture conventions in ways the current
// design doesn't survive. Full RTL is a separate effort scoped to ship
// alongside Persian translations (see docs/backlog.md).
//
// Effect by platform:
//   - iOS: applies immediately on this launch.
//   - Android: forceRTL records the preference at the native level; the
//     *current* launch on an already-RTL device stays RTL (broken), but
//     the next launch reads the preference and starts in LTR.
// Acceptable for v0; if shopkeepers complain about a one-time broken
// first launch on Persian phones, we'd add an "please reopen" prompt or
// trigger expo-updates reload here. Not worth the complexity yet.
I18nManager.allowRTL(false);
I18nManager.forceRTL(false);
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
import { useAppFonts } from "../lib/fonts";
import { ensureInstallId, getInstalledAtUnixMs } from "../lib/install-id";

const currentVersion = Application.nativeApplicationVersion || "0.1.0";

export default function RootLayout() {
  const fontsReady = useAppFonts();
  const [appReady, setAppReady] = useState(false);
  const [installId, setInstallId] = useState<string | null>(null);
  const [hasOnboarded, setHasOnboarded] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        await initDb();
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
