import { useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Linking,
  Platform,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { isRunningInExpoGo } from "expo";
import { Button } from "../components/Button";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { NotificationTimePicker } from "../components/NotificationTimePicker";
import { OptionSheet } from "../components/OptionSheet";
import { NavRow, ScreenHeader, SectionGap, SectionHeader } from "../components/SettingsScreen";
import { useToast } from "../components/Toast";
import { colors } from "../lib/colors";
import { getActiveVaultIdSyncMaybe, getDb, onAccountIdentityChanged } from "../lib/db-tx";
import { canReadReminderVault } from "../lib/customer-reminders";
import { SETTINGS_DISABLED_OPACITY } from "../lib/design-tokens";
import { rowDir, textDir, useIsRTL } from "../lib/direction";
import { fonts } from "../lib/fonts";
import { t } from "../lib/i18n";
import {
  defaultNotificationPolicy,
  formatNotificationTime,
  mergeNotificationPolicy,
  normalizeNotificationPolicy,
  type NotificationOverrides,
  type NotificationPolicy,
} from "../lib/notification-policy";
import {
  notificationOwnerScope,
  readNotificationSettings,
  saveNotificationSettings,
  type NotificationContact,
} from "../lib/notification-preferences";
import {
  notificationPermissionDetails,
  requestReminderNotifications,
} from "../lib/reminder-notifications";

type Settings = Awaited<ReturnType<typeof readNotificationSettings>>;
type BoolKey =
  | "enabled"
  | "tallies"
  | "reviews"
  | "cancellations"
  | "connections"
  | "reminders"
  | "credit_alerts"
  | "sound"
  | "vibration"
  | "foreground"
  | "review_actions";
type Permission = Awaited<ReturnType<typeof notificationPermissionDetails>>;

export default function NotificationSettingsScreen() {
  const router = useRouter(),
    rtl = useIsRTL(),
    toast = useToast();
  const params = useLocalSearchParams<{ personId?: string; vaultId?: string }>();
  const personId = typeof params.personId === "string" ? params.personId : undefined;
  const vaultId = typeof params.vaultId === "string" ? params.vaultId : getActiveVaultIdSyncMaybe();
  const contact = personId && vaultId ? { personId, vaultId } : undefined;
  const contactKey = contact ? `${contact.vaultId}:${contact.personId}` : "global";
  const [settings, setSettings] = useState<Settings | null>(null);
  const [name, setName] = useState("");
  const [permission, setPermission] = useState<Permission>("notAsked");
  const [saving, setSaving] = useState(false),
    [error, setError] = useState<string | null>(null);
  const [syncPending, setSyncPending] = useState(false);
  const [previewsOpen, setPreviewsOpen] = useState(false),
    [resetOpen, setResetOpen] = useState(false);
  const [timeField, setTimeField] = useState<"start_minute" | "end_minute" | null>(null);
  const live = useRef(false),
    generation = useRef(0),
    writing = useRef(false);
  const snapshot = useRef(settings);
  snapshot.current = settings;
  const scope = useRef(contactKey);
  scope.current = contactKey;
  const current = (owner: string, key = contactKey) =>
    live.current &&
    scope.current === key &&
    notificationOwnerScope() === owner &&
    (!contact || getActiveVaultIdSyncMaybe() === contact.vaultId);

  const load = useCallback(async () => {
    const request = ++generation.current;
    setSettings(null);
    setError(null);
    setPreviewsOpen(false);
    setTimeField(null);
    setResetOpen(false);
    setSyncPending(false);
    try {
      const owner = notificationOwnerScope(),
        db = await getDb();
      if (contact && !(await canReadReminderVault(db, contact.vaultId))) throw new Error("scope");
      const [next, status, person] = await Promise.all([
        readNotificationSettings(contact),
        notificationPermissionDetails(),
        contact
          ? db.getFirstAsync<{ name: string }>(
              "SELECT u.display_name AS name FROM relationships r JOIN users u ON u.id=r.user_b_id WHERE r.user_b_id=? AND r.vault_id=? AND r.archived_at IS NULL LIMIT 1",
              contact.personId,
              contact.vaultId,
            )
          : Promise.resolve(null),
      ]);
      if (!live.current || request !== generation.current || owner !== notificationOwnerScope())
        return;
      if (contact && !person) throw new Error("scope");
      setSettings(next);
      setPermission(status);
      setName(person?.name ?? "");
    } catch {
      if (live.current && request === generation.current)
        setError(t("notificationSettings.scopeChanged"));
    }
  }, [contactKey]);
  useFocusEffect(
    useCallback(() => {
      live.current = true;
      void load();
      const unsubscribe = onAccountIdentityChanged(() => {
        generation.current++;
        void load();
      });
      return () => {
        live.current = false;
        generation.current++;
        unsubscribe();
      };
    }, [load]),
  );
  useEffect(
    () => () => {
      live.current = false;
      generation.current++;
    },
    [],
  );

  async function write(
    value: NotificationPolicy | NotificationOverrides | null,
    startCustom = false,
  ) {
    const before = snapshot.current;
    if (!before || before.owner !== settings?.owner || writing.current || !current(before.owner))
      return;
    if (contact && before.overrides == null && value != null && !startCustom) return;
    const key = contactKey;
    writing.current = true;
    setSaving(true);
    setError(null);
    const next = contact
      ? {
          ...before,
          overrides: value as NotificationOverrides | null,
          effective: mergeNotificationPolicy(before.global, value as NotificationOverrides | null),
        }
      : { ...before, global: value as NotificationPolicy, effective: value as NotificationPolicy };
    setSettings(next);
    snapshot.current = next;
    try {
      await saveNotificationSettings(value, {
        contact,
        owner: before.owner,
        shouldContinue: () =>
          scope.current === key &&
          notificationOwnerScope() === before.owner &&
          (!contact || getActiveVaultIdSyncMaybe() === contact.vaultId),
      });
      if (current(before.owner, key)) setSyncPending(true);
      void import("../lib/tabs/notify")
        .then(async (module) => {
          await module.ensureTabNotificationPermission();
          const row = await (
            await getDb()
          ).getFirstAsync<{ value: string }>(
            "SELECT value FROM app_meta WHERE key=?",
            "tab_push_error",
          );
          if (current(before.owner, key))
            setSyncPending(
              row?.value === "registration_failed" ||
                row?.value === "credentials_or_network" ||
                row?.value === "settings_unsupported",
            );
        })
        .catch(() => undefined);
    } catch {
      if (current(before.owner, key)) {
        setSettings(before);
        snapshot.current = before;
        setError(t("notificationSettings.saveFailed"));
      }
    } finally {
      writing.current = false;
      if (live.current) setSaving(false);
    }
  }
  const display = settings
    ? normalizeNotificationPolicy({ ...settings.global, ...settings.overrides })
    : defaultNotificationPolicy();
  const inherited = !!contact && settings?.overrides == null;
  const disabled = saving || !settings || inherited || !current(settings.owner);
  const update = (key: BoolKey, value: boolean) => {
    const latest = snapshot.current;
    if (!latest || disabled) return;
    void write(
      contact ? { ...latest.overrides, [key]: value } : { ...latest.global, [key]: value },
    );
  };
  function toggle(key: BoolKey, label: Parameters<typeof t>[0], hint?: Parameters<typeof t>[0]) {
    return (
      <View key={key} style={[styles.row, rowDir(rtl)]}>
        <View style={styles.text}>
          <Text style={[styles.label, textDir(rtl), disabled && styles.disabledText]}>
            {t(label)}
          </Text>
          {hint ? <Text style={[styles.hint, textDir(rtl)]}>{t(hint)}</Text> : null}
        </View>
        <Switch
          value={display[key]}
          disabled={disabled}
          accessibilityLabel={t(label)}
          accessibilityHint={hint ? t(hint) : undefined}
          accessibilityState={{ checked: display[key], disabled, busy: saving }}
          onValueChange={(value) => update(key, value)}
          style={disabled ? styles.disabledControl : undefined}
          trackColor={{ false: colors.borderDefault, true: colors.actionPrimary }}
          thumbColor={colors.bgDefault}
        />
      </View>
    );
  }
  const previewKey =
    display.previews === "full"
      ? "notificationSettings.preview.full"
      : display.previews === "name"
        ? "notificationSettings.preview.name"
        : "notificationSettings.preview.private";
  return (
    <SafeAreaView style={styles.screen}>
      <ScreenHeader
        title={t(contact ? "notificationSettings.contact.title" : "notificationSettings.title")}
        onBack={() => router.back()}
        isRTL={rtl}
      />
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.content}>
        {name ? <Text style={[styles.name, textDir(rtl)]}>{name}</Text> : null}
        <Text style={[styles.intro, textDir(rtl)]}>
          {t(contact ? "notificationSettings.contact.hint" : "notificationSettings.description")}
        </Text>
        {!settings && !error ? <ActivityIndicator color={colors.textDefault} /> : null}
        {error ? (
          <Text style={[styles.error, textDir(rtl)]} accessibilityRole="alert">
            {error}
          </Text>
        ) : null}
        {syncPending ? (
          <Text style={[styles.intro, textDir(rtl)]} accessibilityLiveRegion="polite">
            {t("notificationSettings.syncPending")}
          </Text>
        ) : null}
        {contact && settings ? (
          <View style={[styles.row, rowDir(rtl)]}>
            <View style={styles.text}>
              <Text style={[styles.label, textDir(rtl)]}>
                {t("notificationSettings.useDefaults")}
              </Text>
              <Text style={[styles.hint, textDir(rtl)]}>
                {t("notificationSettings.useDefaults.hint")}
              </Text>
            </View>
            <Switch
              value={inherited}
              disabled={saving}
              accessibilityLabel={t("notificationSettings.useDefaults")}
              accessibilityState={{ checked: inherited, disabled: saving }}
              onValueChange={(value) => {
                if (writing.current) return;
                if (value) void write(null);
                else {
                  void write({}, true);
                }
              }}
            />
          </View>
        ) : null}
        {contact && settings && !settings.global.enabled ? (
          <Text style={[styles.intro, textDir(rtl)]}>{t("notificationSettings.masterOff")}</Text>
        ) : null}
        {toggle("enabled", "notificationSettings.enabled", "notificationSettings.enabled.hint")}
        <SectionGap />
        <SectionHeader label={t("notificationSettings.types")} isRTL={rtl} />
        {toggle("tallies", "notificationSettings.tallies")}
        {toggle("reviews", "notificationSettings.reviews")}
        {toggle("cancellations", "notificationSettings.cancellations")}
        {toggle("connections", "notificationSettings.connections")}
        {toggle("reminders", "notificationSettings.reminders")}
        {toggle("credit_alerts", "notificationSettings.creditAlerts")}
        <SectionGap />
        <SectionHeader label={t("notificationSettings.delivery")} isRTL={rtl} />
        {toggle("sound", "notificationSettings.sound")}
        {Platform.OS === "android" ? toggle("vibration", "notificationSettings.vibration") : null}
        {toggle(
          "foreground",
          "notificationSettings.foreground",
          "notificationSettings.foreground.hint",
        )}
        {toggle(
          "review_actions",
          "notificationSettings.reviewActions",
          "notificationSettings.reviewActions.hint",
        )}
        <SectionGap />
        <SectionHeader label={t("notificationSettings.privacy")} isRTL={rtl} />
        <NavRow
          icon="eye-off-outline"
          label={t("notificationSettings.previews")}
          hint={t("notificationSettings.preview.hint")}
          trailing={t(previewKey)}
          disabled={disabled}
          onPress={() => setPreviewsOpen(true)}
          isRTL={rtl}
          isLast
        />
        <SectionGap />
        <SectionHeader label={t("notificationSettings.quietHours")} isRTL={rtl} />
        {contact ? (
          <View style={[styles.row, rowDir(rtl)]}>
            <Text
              style={[styles.label, styles.text, textDir(rtl), disabled && styles.disabledText]}
            >
              {t("notificationSettings.quiet.bypass")}
            </Text>
            <Switch
              value={settings?.overrides?.bypass_quiet_hours ?? false}
              disabled={disabled}
              accessibilityLabel={t("notificationSettings.quiet.bypass")}
              accessibilityState={{
                disabled,
                checked: settings?.overrides?.bypass_quiet_hours ?? false,
              }}
              onValueChange={(value) => {
                if (!disabled && settings)
                  void write({ ...settings.overrides, bypass_quiet_hours: value });
              }}
            />
          </View>
        ) : (
          <>
            <View style={[styles.row, rowDir(rtl)]}>
              <View style={styles.text}>
                <Text style={[styles.label, textDir(rtl)]}>
                  {t("notificationSettings.quietHours")}
                </Text>
                <Text style={[styles.hint, textDir(rtl)]}>
                  {t("notificationSettings.quietHours.hint")}
                </Text>
              </View>
              <Switch
                value={display.quiet_hours.enabled}
                disabled={disabled}
                accessibilityLabel={t("notificationSettings.quietHours")}
                accessibilityState={{ disabled, checked: display.quiet_hours.enabled }}
                onValueChange={(value) => {
                  if (!disabled && settings)
                    void write({
                      ...settings.global,
                      quiet_hours: { ...settings.global.quiet_hours, enabled: value },
                    });
                }}
              />
            </View>
            {display.quiet_hours.enabled ? (
              <>
                <NavRow
                  icon="moon-outline"
                  label={t("notificationSettings.quiet.start")}
                  trailing={formatNotificationTime(display.quiet_hours.start_minute)}
                  disabled={disabled}
                  onPress={() => setTimeField("start_minute")}
                  isRTL={rtl}
                />
                <NavRow
                  icon="sunny-outline"
                  label={t("notificationSettings.quiet.end")}
                  trailing={formatNotificationTime(display.quiet_hours.end_minute)}
                  disabled={disabled}
                  onPress={() => setTimeField("end_minute")}
                  isRTL={rtl}
                />
                <View style={[styles.row, rowDir(rtl)]}>
                  <View style={styles.text}>
                    <Text style={[styles.label, textDir(rtl)]}>
                      {t("notificationSettings.quiet.allowReminders")}
                    </Text>
                    <Text style={[styles.hint, textDir(rtl)]}>
                      {t("notificationSettings.quiet.allowReminders.hint")}
                    </Text>
                  </View>
                  <Switch
                    value={display.quiet_hours.allow_reminders}
                    disabled={disabled}
                    accessibilityLabel={t("notificationSettings.quiet.allowReminders")}
                    accessibilityState={{ disabled, checked: display.quiet_hours.allow_reminders }}
                    onValueChange={(value) => {
                      if (!disabled && settings)
                        void write({
                          ...settings.global,
                          quiet_hours: { ...settings.global.quiet_hours, allow_reminders: value },
                        });
                    }}
                  />
                </View>
              </>
            ) : null}
          </>
        )}
        <SectionGap />
        <SectionHeader label={t("notificationSettings.permission")} isRTL={rtl} />
        <Text style={[styles.intro, textDir(rtl)]}>
          {t(
            permission === "granted"
              ? "notificationSettings.permission.granted"
              : permission === "denied"
                ? "notificationSettings.permission.denied"
                : permission === "unavailable"
                  ? "notificationSettings.permission.unavailable"
                  : "notificationSettings.permission.notAsked",
          )}
        </Text>
        {isRunningInExpoGo() && permission !== "unavailable" ? (
          <Text style={[styles.intro, textDir(rtl)]}>
            {t("notificationSettings.permission.unavailable")}
          </Text>
        ) : null}
        {permission === "notAsked" ? (
          <View style={styles.button}>
            <Button
              label={t("notificationSettings.permission.request")}
              disabled={saving}
              onPress={async () => {
                if (writing.current || !live.current) return;
                await requestReminderNotifications();
                if (live.current) setPermission(await notificationPermissionDetails());
                void import("../lib/tabs/notify")
                  .then((module) => module.ensureTabNotificationPermission())
                  .catch(() => undefined);
              }}
            />
          </View>
        ) : null}
        <NavRow
          icon="settings-outline"
          label={t("notificationSettings.permission.settings")}
          onPress={() => {
            void Linking.openSettings().catch(() =>
              toast.push(t("notificationSettings.saveFailed"), "error"),
            );
          }}
          isRTL={rtl}
          isLast
        />
        <SectionGap />
        <NavRow
          icon="refresh-outline"
          label={t("notificationSettings.reset")}
          disabled={saving || !settings}
          onPress={() => setResetOpen(true)}
          isRTL={rtl}
          isLast
        />
      </ScrollView>
      <OptionSheet
        visible={previewsOpen && !disabled}
        title={t("notificationSettings.previews")}
        options={(["full", "name", "private"] as const).map((key) => ({
          key,
          label: t(
            key === "full"
              ? "notificationSettings.preview.full"
              : key === "name"
                ? "notificationSettings.preview.name"
                : "notificationSettings.preview.private",
          ),
        }))}
        selected={display.previews}
        isRTL={rtl}
        onDismiss={() => setPreviewsOpen(false)}
        onSelect={(value) => {
          setPreviewsOpen(false);
          if (
            disabled ||
            !settings ||
            (value !== "full" && value !== "name" && value !== "private")
          )
            return;
          void write(
            contact
              ? { ...settings.overrides, previews: value }
              : { ...settings.global, previews: value },
          );
        }}
      />
      <NotificationTimePicker
        visible={timeField != null && !disabled}
        title={t(
          timeField === "start_minute"
            ? "notificationSettings.quiet.start"
            : "notificationSettings.quiet.end",
        )}
        minute={timeField ? display.quiet_hours[timeField] : 0}
        onDismiss={() => setTimeField(null)}
        onSelect={(value) => {
          const field = timeField;
          setTimeField(null);
          if (!field || disabled || !settings || contact) return;
          const quiet = { ...settings.global.quiet_hours, [field]: value };
          if (quiet.start_minute === quiet.end_minute) {
            toast.push(t("notificationSettings.quiet.invalid"), "error");
            return;
          }
          void write({ ...settings.global, quiet_hours: quiet });
        }}
      />
      <ConfirmDialog
        visible={resetOpen && !!settings}
        title={t("notificationSettings.reset.title")}
        description={t("notificationSettings.reset.body")}
        confirmLabel={t("notificationSettings.reset")}
        onCancel={() => setResetOpen(false)}
        onConfirm={() => {
          setResetOpen(false);
          void write(contact ? null : defaultNotificationPolicy());
        }}
      />
    </SafeAreaView>
  );
}
const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bgDefault },
  content: { paddingBottom: 24 },
  row: {
    minHeight: 60,
    paddingHorizontal: 20,
    paddingVertical: 12,
    alignItems: "center",
    gap: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.borderSubtle,
  },
  text: { flex: 1, minWidth: 0 },
  label: { fontFamily: fonts.sansMedium, fontSize: 15, color: colors.textDefault },
  hint: {
    fontFamily: fonts.sansRegular,
    fontSize: 12,
    color: colors.textSubtle,
    marginTop: 4,
    lineHeight: 19,
  },
  intro: {
    fontFamily: fonts.sansRegular,
    fontSize: 13,
    color: colors.textSubtle,
    paddingHorizontal: 20,
    paddingVertical: 12,
    lineHeight: 21,
  },
  name: {
    fontFamily: fonts.sansSemi,
    fontSize: 18,
    color: colors.textEmphasis,
    paddingHorizontal: 20,
    paddingTop: 16,
  },
  error: { fontFamily: fonts.sansRegular, color: colors.danger, padding: 20 },
  button: { paddingHorizontal: 20, paddingBottom: 12 },
  disabledText: { color: colors.textMuted },
  disabledControl: { opacity: SETTINGS_DISABLED_OPACITY },
});
