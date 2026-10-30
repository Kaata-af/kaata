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
import { fonts, sansLineHeight } from "../lib/fonts";
import { radius } from "../lib/tokens";
import { t } from "../lib/i18n";
import { Button } from "./Button";
import { BalanceCardGlass } from "./BalanceCardGlass";

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
  const locked = state.initialized && state.enabled && state.locked;
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
        <Text style={[styles.brand, textDir(isRTL), styles.centered]}>{t("brand.wordmark")}</Text>
        <View testID="app-lock-card" style={styles.card}>
          <BalanceCardGlass />
          <View style={styles.cardContent}>
            <View testID="app-lock-status" style={[styles.status, !locked && styles.statusNeutral]}>
              <View style={[styles.statusDot, !locked && styles.statusDotNeutral]} />
              <Text
                style={[
                  styles.statusText,
                  textDir(isRTL),
                  styles.centered,
                  !locked && styles.statusTextNeutral,
                ]}
              >
                {t(locked ? "appLock.protected" : "settings.appLock.label")}
              </Text>
            </View>
            <View
              style={styles.icon}
              accessibilityElementsHidden
              importantForAccessibility="no-hide-descendants"
            >
              <Ionicons
                name={locked ? "shield-checkmark-outline" : "shield-outline"}
                size={40}
                color={colors.entryActionReceivedText}
              />
            </View>
            <Text
              testID="app-lock-title"
              style={[styles.title, textDir(isRTL), styles.centered]}
              accessibilityRole="header"
            >
              {t(checking ? "appLock.privacyTitle" : "appLock.title")}
            </Text>
            <Text
              testID="app-lock-subtitle"
              style={[styles.subtitle, textDir(isRTL), styles.centered]}
            >
              {t(
                checking
                  ? "appLock.loading"
                  : legacyAndroid
                    ? "appLock.biometricOnlySubtitle"
                    : "appLock.subtitle",
              )}
            </Text>
            {state.error ? (
              <Text
                style={[styles.error, textDir(isRTL), styles.centered]}
                accessibilityLiveRegion="polite"
              >
                {t(
                  state.error === "lockout" && legacyAndroid
                    ? "settings.appLock.error.legacyLockout"
                    : `settings.appLock.error.${state.error}`,
                )}
              </Text>
            ) : null}
            {setupFailed ? (
              <Text
                style={[styles.error, textDir(isRTL), styles.centered]}
                accessibilityLiveRegion="polite"
              >
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
                  showLabelWhileLoading
                  wrapLabel
                  disabled={!active}
                  onPress={onUnlock}
                />
              </View>
            )}
            {legacyAndroid && state.initialized && state.enabled && state.locked ? (
              <View style={styles.recovery}>
                <Text style={[styles.recoveryText, textDir(isRTL), styles.centered]}>
                  {t("appLock.legacyRecovery")}
                </Text>
                <View style={styles.recoveryAction}>
                  <Button
                    label={t("appLock.openSecuritySettings")}
                    onPress={onOpenSettings}
                    variant="secondary"
                    fullWidth
                    wrapLabel
                    disabled={!active || state.busy}
                  />
                </View>
              </View>
            ) : null}
            {locked ? (
              <Text
                testID="app-lock-reassurance"
                style={[styles.reassurance, textDir(isRTL), styles.centered]}
              >
                {t("appLock.reassurance")}
              </Text>
            ) : null}
          </View>
        </View>
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
    paddingHorizontal: 20,
    backgroundColor: colors.bgDefault,
  },
  panel: { width: "100%", maxWidth: 420, minWidth: 0 },
  brand: {
    width: "100%",
    fontFamily: fonts.sansSemi,
    fontSize: 16,
    lineHeight: sansLineHeight(16, 25),
    color: colors.textEmphasis,
    marginBottom: 20,
    paddingHorizontal: 4,
  },
  card: {
    borderWidth: 1,
    borderColor: colors.borderBalanceGlass,
    borderRadius: radius.lg,
    backgroundColor: colors.bgBalanceGlass,
    overflow: "hidden",
  },
  cardContent: { paddingHorizontal: 24, paddingTop: 24, paddingBottom: 28, alignItems: "center" },
  status: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 7,
    maxWidth: "100%",
    backgroundColor: colors.entryActionReceived,
    borderRadius: radius.pill,
    paddingHorizontal: 12,
    paddingVertical: 5,
    marginBottom: 28,
  },
  statusNeutral: { backgroundColor: colors.bgMuted },
  statusDot: {
    width: 5,
    height: 5,
    borderRadius: 3,
    backgroundColor: colors.entryActionReceivedText,
  },
  statusDotNeutral: { backgroundColor: colors.textSubtle },
  statusText: {
    flexShrink: 1,
    minWidth: 0,
    fontFamily: fonts.sansMedium,
    fontSize: 12,
    lineHeight: sansLineHeight(12, 18),
    color: colors.entryActionReceivedText,
  },
  statusTextNeutral: { color: colors.textSubtle },
  icon: {
    width: 88,
    height: 88,
    borderRadius: 30,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#FFFFFFB3",
    borderWidth: 1,
    borderColor: "#FFFFFF",
    marginBottom: 20,
  },
  title: {
    fontFamily: fonts.sansSemi,
    width: "100%",
    minWidth: 0,
    paddingHorizontal: 4,
    fontSize: 26,
    lineHeight: sansLineHeight(26, 36),
    color: colors.textEmphasis,
    textAlign: "center",
  },
  subtitle: {
    width: "100%",
    minWidth: 0,
    paddingHorizontal: 4,
    fontFamily: fonts.sansRegular,
    fontSize: 15,
    lineHeight: sansLineHeight(15, 24),
    color: colors.textSubtle,
    textAlign: "center",
    marginTop: 10,
  },
  error: {
    width: "100%",
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: radius.sm,
    backgroundColor: "#FFFFFFB3",
    fontFamily: fonts.sansRegular,
    fontSize: 14,
    lineHeight: sansLineHeight(14, 22),
    color: colors.danger,
    textAlign: "center",
    marginTop: 20,
  },
  progress: { marginTop: 28 },
  action: { width: "100%", marginTop: 28 },
  recovery: { width: "100%", marginTop: 20 },
  recoveryText: {
    width: "100%",
    fontFamily: fonts.sansRegular,
    fontSize: 13,
    lineHeight: sansLineHeight(13, 21),
    color: colors.textSubtle,
  },
  recoveryAction: { marginTop: 12 },
  reassurance: {
    width: "100%",
    paddingHorizontal: 4,
    marginTop: 20,
    fontFamily: fonts.sansRegular,
    fontSize: 12,
    lineHeight: sansLineHeight(12, 20),
    color: colors.entryActionReceivedText,
  },
  centered: { textAlign: "center" },
});
