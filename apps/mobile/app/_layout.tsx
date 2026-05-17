import * as Application from "expo-application";
import * as Network from "expo-network";
import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useEffect, useState } from "react";
import { ActivityIndicator, Platform, View } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { checkIn } from "../lib/api";
import { AppMetaProvider, useAppMeta } from "../lib/app-meta-context";
import { colors } from "../lib/colors";
import { getAppMeta, getLocalSelf, initDb } from "../lib/db";
import { ensureInstallId } from "../lib/install-id";

const currentVersion = Application.nativeApplicationVersion || "0.1.0";

export default function RootLayout() {
  const [ready, setReady] = useState(false);
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
        setReady(true);
      }
    })();
  }, []);

  if (!ready) {
    return (
      <View
        style={{
          flex: 1,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: colors.background,
        }}
      >
        <ActivityIndicator />
      </View>
    );
  }

  return (
    <SafeAreaProvider>
      <AppMetaProvider currentVersion={currentVersion}>
        <StatusBar style="dark" />
        {installId ? <BackgroundCheckIn installId={installId} /> : null}
        <Stack
          initialRouteName={hasOnboarded ? "index" : "onboarding"}
          screenOptions={{
            headerShown: false,
            contentStyle: { backgroundColor: colors.background },
          }}
        >
          <Stack.Screen name="index" />
          <Stack.Screen name="onboarding" options={{ gestureEnabled: false }} />
          <Stack.Screen
            name="update-prompt"
            options={{ presentation: "fullScreenModal", gestureEnabled: false }}
          />
          <Stack.Screen name="customer/[id]" />
          <Stack.Screen name="customer/[id]/edit" options={{ presentation: "modal" }} />
          <Stack.Screen name="entry/new" options={{ presentation: "modal" }} />
          <Stack.Screen name="entry/[id]/edit" options={{ presentation: "modal" }} />
        </Stack>
      </AppMetaProvider>
    </SafeAreaProvider>
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
        const [invalidStr, conflictStr] = await Promise.all([
          getAppMeta("migration_001_phones_invalid_count"),
          getAppMeta("migration_001_phones_conflict_count"),
        ]);
        const resp = await checkIn({
          install_id: installId,
          app_version: currentVersion,
          platform: Platform.OS === "android" ? "android" : Platform.OS === "ios" ? "ios" : "web",
          device_locale: "en-US",
          phones_invalid_count: invalidStr ? Number(invalidStr) : undefined,
          phones_conflict_count: conflictStr ? Number(conflictStr) : undefined,
        });
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
