import { Ionicons } from "@expo/vector-icons";
import { useEffect, useRef, useState, type PropsWithChildren } from "react";
import {
  ActivityIndicator,
  BackHandler,
  Keyboard,
  Linking,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import {
  initialWindowMetrics,
  SafeAreaProvider,
  useSafeAreaInsets,
} from "react-native-safe-area-context";
import { FullWindowOverlay } from "react-native-screens";
import {
  getAppLockSnapshot,
  initializeAppLock,
  supportsAppLockDeviceFallback,
  unlockApp,
  useAppLock,
  type AppLockSnapshot,
} from "../lib/app-lock";
import { useAppLockPrivacy } from "../lib/app-lock-privacy";
import { useAppLockScreenPrivacy } from "../lib/app-lock-screen-privacy";
import { colors } from "../lib/colors";
import { textDir, useIsRTL } from "../lib/direction";
import { fonts } from "../lib/fonts";
import { t } from "../lib/i18n";
import { Button } from "./Button";

/** Keep navigation and drafts alive while covering every app entry point. */
export function AppLockGate({ children }: PropsWithChildren) {
  const state = useAppLock();
  const blocked = useAppLockPrivacy();
  const [laidOut, setLaidOut] = useState(false);
  const [setupFailed, setSetupFailed] = useState(false);
  const automaticAttempt = useRef<number | null>(null);
  const mounted = useRef(true);
  useAppLockScreenPrivacy(state.initialized && state.enabled, state.appState);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (blocked) Keyboard.dismiss();
  }, [blocked]);
  useEffect(() => {
    if (!blocked) setLaidOut(false);
    if (!blocked || Platform.OS !== "android") return;
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => true);
    return () => subscription.remove();
  }, [blocked]);
  useEffect(() => {
    setSetupFailed(false);
  }, [state.appState, state.locked]);
  useEffect(() => {
    if (!state.locked) automaticAttempt.current = null;
    if (
      !mounted.current ||
      !laidOut ||
      !state.initialized ||
      !state.enabled ||
      !state.locked ||
      state.busy ||
      state.appState !== "active" ||
      automaticAttempt.current === state.foregroundVersion
    )
      return;
    automaticAttempt.current = state.foregroundVersion;
    void unlockApp();
  }, [
    laidOut,
    state.initialized,
    state.enabled,
    state.locked,
    state.busy,
    state.appState,
    state.foregroundVersion,
  ]);

  const requestUnlock = () => {
    const current = getAppLockSnapshot();
    if (!mounted.current || !laidOut || current.busy || current.appState !== "active") return;
    if (!current.initialized) void initializeAppLock();
    else if (current.enabled && current.locked) {
      automaticAttempt.current = current.foregroundVersion;
      void unlockApp();
    }
  };
  const openSecuritySettings = () => {
    const current = getAppLockSnapshot();
    if (
      !mounted.current ||
      current.busy ||
      current.appState !== "active" ||
      !current.initialized ||
      !current.enabled ||
      !current.locked ||
      Platform.OS !== "android" ||
      supportsAppLockDeviceFallback()
    )
      return;
    setSetupFailed(false);
    void Linking.sendIntent("android.settings.SECURITY_SETTINGS")
      .catch(() => Linking.openSettings())
      .catch(() => {
        if (mounted.current && getAppLockSnapshot().appState === "active") setSetupFailed(true);
      });
  };

  const cover = blocked ? (
    <View
      testID="app-lock-cover"
      style={styles.cover}
      pointerEvents="auto"
      accessibilityViewIsModal
      onStartShouldSetResponder={() => true}
      onLayout={() => {
        if (mounted.current) setLaidOut(true);
      }}
    >
      <SafeAreaProvider initialMetrics={initialWindowMetrics}>
        <LockScreen
          state={state}
          onUnlock={requestUnlock}
          onOpenSettings={openSecuritySettings}
          setupFailed={setupFailed}
        />
      </SafeAreaProvider>
    </View>
  ) : null;

  return (
    <View style={styles.host}>
      <View
        testID="app-lock-protected-content"
        style={[styles.host, blocked && styles.concealed]}
        pointerEvents={blocked ? "none" : "auto"}
        accessibilityElementsHidden={blocked}
        importantForAccessibility={blocked ? "no-hide-descendants" : "auto"}
      >
        {children}
      </View>
      {/* UIKit can reparent native-stack modals outside the root view. This
          native window overlay stays above them without presenting a modal. */}
      {cover && Platform.OS === "ios" ? <FullWindowOverlay>{cover}</FullWindowOverlay> : cover}
    </View>
  );
}

function LockScreen({
  state,
  onUnlock,
  onOpenSettings,
  setupFailed,
}: {
  state: AppLockSnapshot;
  onUnlock: () => void;
  onOpenSettings: () => void;
  setupFailed: boolean;
}) {
  const isRTL = useIsRTL();
  const insets = useSafeAreaInsets();
  const active = state.appState === "active";
  const checking = !state.initialized && !state.error;
  const legacyAndroid = Platform.OS === "android" && !supportsAppLockDeviceFallback();
  return (
    <ScrollView
      testID="app-lock-screen"
      style={styles.screenScroll}
      contentContainerStyle={[
        styles.screen,
        { paddingTop: Math.max(24, insets.top), paddingBottom: Math.max(24, insets.bottom) },
      ]}
      bounces={false}
      accessibilityViewIsModal
    >
      <View style={styles.panel}>
        <View style={styles.icon}>
          <Ionicons name="lock-closed-outline" size={32} color={colors.textEmphasis} />
        </View>
        <Text style={[styles.title, textDir(isRTL)]} accessibilityRole="header">
          {t(checking ? "appLock.privacyTitle" : "appLock.title")}
        </Text>
        <Text style={[styles.subtitle, textDir(isRTL)]}>
          {t(
            checking
              ? "appLock.loading"
              : legacyAndroid
                ? "appLock.biometricOnlySubtitle"
                : "appLock.subtitle",
          )}
        </Text>
        {state.error ? (
          <Text style={[styles.error, textDir(isRTL)]} accessibilityLiveRegion="polite">
            {t(
              state.error === "lockout" && legacyAndroid
                ? "settings.appLock.error.legacyLockout"
                : `settings.appLock.error.${state.error}`,
            )}
          </Text>
        ) : null}
        {setupFailed ? (
          <Text style={[styles.error, textDir(isRTL)]} accessibilityLiveRegion="polite">
            {t("settings.appLock.openSettingsFailed")}
          </Text>
        ) : null}
        {checking ? (
          <ActivityIndicator style={styles.progress} color={colors.textEmphasis} />
        ) : (
          <View style={styles.action}>
            <Button
              label={t(
                !state.initialized
                  ? "appLock.retry"
                  : state.busy
                    ? "appLock.unlocking"
                    : "appLock.unlock",
              )}
              icon="finger-print-outline"
              size="hero"
              fullWidth
              loading={state.busy}
              disabled={!active}
              onPress={onUnlock}
            />
          </View>
        )}
        {legacyAndroid && state.initialized && state.enabled && state.locked ? (
          <View style={styles.recovery}>
            <Text style={[styles.subtitle, textDir(isRTL)]}>{t("appLock.legacyRecovery")}</Text>
            <View style={styles.recoveryAction}>
              <Button
                label={t("appLock.openSecuritySettings")}
                onPress={onOpenSettings}
                variant="secondary"
                fullWidth
                disabled={!active || state.busy}
              />
            </View>
          </View>
        ) : null}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  host: { flex: 1 },
  concealed: { opacity: 0 },
  cover: {
    position: "absolute",
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    backgroundColor: colors.bgDefault,
  },
  screenScroll: { flex: 1, backgroundColor: colors.bgDefault },
  screen: {
    flexGrow: 1,
    justifyContent: "center",
    alignItems: "center",
    paddingHorizontal: 24,
    backgroundColor: colors.bgDefault,
  },
  panel: { width: "100%", maxWidth: 420, alignItems: "center" },
  icon: {
    width: 72,
    height: 72,
    borderRadius: 36,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.bgMuted,
    marginBottom: 24,
  },
  title: {
    fontFamily: fonts.sansSemi,
    fontSize: 22,
    color: colors.textEmphasis,
    textAlign: "center",
  },
  subtitle: {
    fontFamily: fonts.sansRegular,
    fontSize: 15,
    lineHeight: 24,
    color: colors.textSubtle,
    textAlign: "center",
    marginTop: 12,
  },
  error: {
    fontFamily: fonts.sansRegular,
    fontSize: 14,
    lineHeight: 22,
    color: colors.danger,
    textAlign: "center",
    marginTop: 20,
  },
  progress: { marginTop: 28 },
  action: { width: "100%", marginTop: 28 },
  recovery: { width: "100%", marginTop: 20 },
  recoveryAction: { marginTop: 12 },
});
