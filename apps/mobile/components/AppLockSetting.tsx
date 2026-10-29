import { Ionicons } from "@expo/vector-icons";
import { useIsFocused } from "expo-router";
import { useEffect, useRef, useState } from "react";
import {
  AppState,
  Linking,
  Platform,
  Pressable,
  StyleSheet,
  Switch,
  Text,
  View,
} from "react-native";
import {
  clearAppLockError,
  refreshAppLockCapability,
  setAppLockEnabled,
  supportsAppLockDeviceFallback,
  useAppLock,
} from "../lib/app-lock";
import { colors } from "../lib/colors";
import {
  SETTINGS_DISABLED_OPACITY,
  SETTINGS_ROW_HINT_FONT_SIZE,
  SETTINGS_ROW_HINT_MARGIN_TOP,
  SETTINGS_ROW_ICON_GAP,
  SETTINGS_ROW_ICON_SIZE,
  SETTINGS_ROW_LABEL_FONT_SIZE,
  SETTINGS_ROW_MIN_HEIGHT,
  SETTINGS_ROW_PADDING_X,
  SETTINGS_ROW_PADDING_Y,
} from "../lib/design-tokens";
import { rowDir, textDir, useIsRTL } from "../lib/direction";
import { fonts } from "../lib/fonts";
import { t } from "../lib/i18n";

/** This phone's optional lock, independent of Kaata membership and role. */
export function AppLockSetting() {
  const rtl = useIsRTL();
  const focused = useIsFocused();
  const state = useAppLock();
  const biometricOnly = Platform.OS === "android" && !supportsAppLockDeviceFallback();
  const appActive = state.appState === "active";
  const [pending, setPending] = useState(false);
  const [localError, setLocalError] = useState<"storage" | "unavailable" | "open_settings" | null>(
    null,
  );
  const mounted = useRef(true);
  const operating = useRef(false);
  const lease = useRef({
    active: focused && appActive,
    enabled: state.enabled,
    foregroundVersion: state.foregroundVersion,
    version: 0,
  });
  const active = focused && appActive;
  if (
    lease.current.active !== active ||
    lease.current.enabled !== state.enabled ||
    lease.current.foregroundVersion !== state.foregroundVersion
  )
    lease.current = {
      active,
      enabled: state.enabled,
      foregroundVersion: state.foregroundVersion,
      version: lease.current.version + 1,
    };
  const version = lease.current.version;
  const latest = useRef({ state, active });
  latest.current = { state, active };

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      lease.current.version++;
    };
  }, []);
  useEffect(() => {
    if (active) void refreshAppLockCapability().catch(() => {});
  }, [active]);

  const current = () =>
    mounted.current &&
    lease.current.version === version &&
    latest.current.active &&
    AppState.currentState === "active";
  const disabled =
    !state.initialized ||
    !active ||
    state.busy ||
    pending ||
    (!state.enabled && state.capability !== "available");

  const change = (enabled: boolean) => {
    const before = latest.current.state;
    if (
      !current() ||
      operating.current ||
      !before.initialized ||
      before.busy ||
      enabled === before.enabled ||
      (enabled && before.capability !== "available")
    )
      return;
    operating.current = true;
    setPending(true);
    setLocalError(null);
    clearAppLockError();
    void setAppLockEnabled(enabled)
      .catch(() => {
        if (current()) setLocalError("storage");
      })
      .finally(() => {
        operating.current = false;
        if (mounted.current) setPending(false);
      });
  };

  const openSetup = () => {
    const before = latest.current.state;
    if (
      !current() ||
      operating.current ||
      !before.initialized ||
      before.busy ||
      before.enabled ||
      (before.capability !== "not_enrolled" && before.capability !== "weak")
    )
      return;
    operating.current = true;
    setPending(true);
    setLocalError(null);
    void (
      Platform.OS === "android"
        ? Linking.sendIntent("android.settings.SECURITY_SETTINGS").catch(() =>
            Linking.openSettings(),
          )
        : Linking.openSettings()
    )
      .catch(() => {
        if (current()) setLocalError("open_settings");
      })
      .finally(() => {
        operating.current = false;
        if (mounted.current) setPending(false);
      });
  };

  const retryCapability = () => {
    if (!current() || operating.current || latest.current.state.busy) return;
    operating.current = true;
    setPending(true);
    setLocalError(null);
    clearAppLockError();
    void refreshAppLockCapability()
      .catch(() => {
        if (current()) setLocalError("unavailable");
      })
      .finally(() => {
        operating.current = false;
        if (mounted.current) setPending(false);
      });
  };

  const hint = !state.initialized
    ? t("settings.appLock.checking")
    : state.enabled
      ? t("settings.appLock.hintOn")
      : state.capability === "available"
        ? t(biometricOnly ? "settings.appLock.legacyHint" : "settings.appLock.hintOff")
        : t(`settings.appLock.capability.${state.capability}`);
  const recoveryHint =
    state.enabled || state.capability === "available"
      ? biometricOnly
        ? state.enabled
          ? t("settings.appLock.legacyHint")
          : null
        : t("settings.appLock.fallbackHint")
      : null;
  const storedErrorCode = localError === "open_settings" ? null : (localError ?? state.error);
  const errorCode =
    biometricOnly && storedErrorCode === "lockout" ? "legacyLockout" : storedErrorCode;
  const error =
    localError === "open_settings"
      ? t("settings.appLock.openSettingsFailed")
      : errorCode
        ? t(`settings.appLock.error.${errorCode}`)
        : null;
  const setupAvailable =
    state.initialized &&
    !state.enabled &&
    (state.capability === "not_enrolled" || state.capability === "weak");

  return (
    <View style={styles.container} testID="app-lock-setting">
      <View style={[styles.row, rowDir(rtl)]}>
        <Ionicons
          name="finger-print-outline"
          size={SETTINGS_ROW_ICON_SIZE}
          color={disabled ? colors.textMuted : colors.textDefault}
          style={
            rtl ? { marginLeft: SETTINGS_ROW_ICON_GAP } : { marginRight: SETTINGS_ROW_ICON_GAP }
          }
          accessible={false}
        />
        <View style={[styles.text, rtl ? { paddingLeft: 12 } : { paddingRight: 12 }]}>
          <Text style={[styles.label, textDir(rtl), disabled && styles.disabledText]}>
            {t("settings.appLock.label")}
          </Text>
          <Text style={[styles.hint, textDir(rtl)]}>{hint}</Text>
          {recoveryHint ? <Text style={[styles.hint, textDir(rtl)]}>{recoveryHint}</Text> : null}
        </View>
        <Switch
          testID="app-lock-switch"
          value={state.enabled}
          disabled={disabled}
          accessibilityLabel={t("settings.appLock.label")}
          accessibilityHint={hint}
          accessibilityState={{ checked: state.enabled, disabled, busy: state.busy || pending }}
          onValueChange={change}
          trackColor={{ false: colors.borderDefault, true: colors.actionPrimary }}
          thumbColor={colors.bgDefault}
          style={disabled ? { opacity: SETTINGS_DISABLED_OPACITY } : undefined}
        />
      </View>
      {Platform.OS === "android" && (state.enabled || state.capability === "available") ? (
        <Text style={[styles.privacyHint, textDir(rtl)]}>
          {t("settings.appLock.androidPrivacyHint")}
        </Text>
      ) : null}
      {setupAvailable ? (
        <Pressable
          testID="app-lock-open-settings"
          onPress={openSetup}
          disabled={!active || pending || state.busy}
          accessibilityRole="button"
          accessibilityState={{ disabled: !active || pending || state.busy }}
          style={[
            styles.action,
            (!active || pending || state.busy) && { opacity: SETTINGS_DISABLED_OPACITY },
          ]}
        >
          <Text style={[styles.actionLabel, textDir(rtl)]}>
            {t(biometricOnly ? "appLock.openSecuritySettings" : "settings.appLock.openSettings")}
          </Text>
        </Pressable>
      ) : null}
      {!state.enabled && state.initialized && state.capability === "unavailable" ? (
        <Pressable
          testID="app-lock-check-again"
          onPress={retryCapability}
          disabled={!active || pending || state.busy}
          accessibilityRole="button"
          accessibilityState={{ disabled: !active || pending || state.busy }}
          style={[
            styles.action,
            (!active || pending || state.busy) && { opacity: SETTINGS_DISABLED_OPACITY },
          ]}
        >
          <Text style={[styles.actionLabel, textDir(rtl)]}>{t("appLock.retry")}</Text>
        </Pressable>
      ) : null}
      {error ? (
        <Text
          testID="app-lock-setting-error"
          style={[styles.error, textDir(rtl)]}
          accessibilityRole="alert"
          accessibilityLiveRegion="polite"
        >
          {error}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.borderSubtle,
  },
  row: {
    minHeight: SETTINGS_ROW_MIN_HEIGHT,
    paddingHorizontal: SETTINGS_ROW_PADDING_X,
    paddingVertical: SETTINGS_ROW_PADDING_Y,
    alignItems: "center",
  },
  text: { flex: 1, minWidth: 0 },
  label: {
    color: colors.textDefault,
    fontFamily: fonts.sansRegular,
    fontSize: SETTINGS_ROW_LABEL_FONT_SIZE,
  },
  hint: {
    color: colors.textSubtle,
    fontFamily: fonts.sansRegular,
    fontSize: SETTINGS_ROW_HINT_FONT_SIZE,
    marginTop: SETTINGS_ROW_HINT_MARGIN_TOP,
  },
  disabledText: { color: colors.textMuted },
  action: {
    minHeight: 44,
    paddingHorizontal: SETTINGS_ROW_PADDING_X,
    paddingBottom: SETTINGS_ROW_PADDING_Y,
    justifyContent: "center",
  },
  actionLabel: {
    color: colors.textEmphasis,
    fontFamily: fonts.sansSemi,
    fontSize: SETTINGS_ROW_HINT_FONT_SIZE,
  },
  error: {
    color: colors.danger,
    fontFamily: fonts.sansRegular,
    fontSize: SETTINGS_ROW_HINT_FONT_SIZE,
    paddingHorizontal: SETTINGS_ROW_PADDING_X,
    paddingBottom: SETTINGS_ROW_PADDING_Y,
  },
  privacyHint: {
    color: colors.textSubtle,
    fontFamily: fonts.sansRegular,
    fontSize: SETTINGS_ROW_HINT_FONT_SIZE,
    paddingHorizontal: SETTINGS_ROW_PADDING_X,
    paddingBottom: SETTINGS_ROW_PADDING_Y,
  },
});
