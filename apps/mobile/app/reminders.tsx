import { Stack, useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, BackHandler, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Button } from "../components/Button";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { CustomerReminderRow } from "../components/CustomerReminderRow";
import { ReminderPermissionNotice } from "../components/ReminderPermissionNotice";
import { ScreenHeader } from "../components/SettingsScreen";
import { useCalendar } from "../lib/calendar";
import { colors } from "../lib/colors";
import {
  dismissCustomerReminder,
  reminderOwnerScope,
  type CustomerReminder,
} from "../lib/customer-reminders";
import { getReminderDeviceIdSync } from "../lib/reminder-device";
import { rowDir, textDir, useIsRTL } from "../lib/direction";
import { t } from "../lib/i18n";
import { openCustomerReminder } from "../lib/open-customer-reminder";
import { reconcileReminderNotifications } from "../lib/reminder-notifications";
import { typography } from "../lib/tokens";
import { useCustomerReminders } from "../lib/use-customer-reminders";

export default function RemindersScreen() {
  const router = useRouter(),
    rtl = useIsRTL(),
    state = useCustomerReminders();
  useCalendar();
  // "All" opens the full list; a due shortcut opens the due ones (audit #25:
  // "All" used to land on Due and needed a second tap).
  const { view } = useLocalSearchParams<{ view?: string }>();
  const [dueOnly, setDueOnly] = useState(view !== "all"),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null);
  const [removing, setRemoving] = useState<CustomerReminder | null>(null);
  const working = useRef(false),
    mounted = useRef(true);
  const focused = useRef(false);
  useFocusEffect(
    useCallback(() => {
      focused.current = true;
      const back = BackHandler.addEventListener("hardwareBackPress", () => working.current);
      return () => {
        focused.current = false;
        back.remove();
      };
    }, []),
  );
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const owner = reminderOwnerScope(),
    install = getReminderDeviceIdSync();
  const removal =
    removing?.owner_scope === owner && removing.install_id === install ? removing : null;
  const rows = dueOnly ? state.due : state.rows;
  async function done(row: CustomerReminder, remove = false) {
    if (
      !focused.current ||
      working.current ||
      row.owner_scope !== reminderOwnerScope() ||
      row.install_id !== getReminderDeviceIdSync() ||
      (!remove && row.next_due_at > Date.now())
    )
      return;
    working.current = true;
    setBusy(true);
    setError(null);
    setRemoving(null);
    try {
      await dismissCustomerReminder(row.id, remove);
      await reconcileReminderNotifications();
      await state.refresh();
    } catch {
      if (
        mounted.current &&
        row.owner_scope === reminderOwnerScope() &&
        row.install_id === getReminderDeviceIdSync()
      )
        setError(t("entry.saveFailed"));
    } finally {
      working.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  function edit(row: CustomerReminder) {
    if (
      focused.current &&
      !busy &&
      row.owner_scope === reminderOwnerScope() &&
      row.install_id === getReminderDeviceIdSync()
    )
      router.push({
        pathname: "/person/[id]/reminders",
        params: { id: row.person_id, vaultId: row.vault_id, reminderId: row.id },
      });
  }
  return (
    <SafeAreaView edges={["top", "bottom"]} style={styles.page}>
      <Stack.Screen options={{ gestureEnabled: !busy }} />
      <ScreenHeader
        title={t("reminders.title")}
        onBack={() => router.back()}
        isRTL={rtl}
        backDisabled={busy}
      />
      <ScrollView contentContainerStyle={styles.body}>
        <Text style={[styles.hint, textDir(rtl)]}>{t("reminders.personal")}</Text>
        <ReminderPermissionNotice isRTL={rtl} />
        <View style={[styles.filters, rowDir(rtl)]}>
          <Button
            label={t("reminders.due")}
            variant={dueOnly ? "primary" : "secondary"}
            onPress={() => setDueOnly(true)}
            disabled={busy}
          />
          <Button
            label={t("reminders.all")}
            variant={dueOnly ? "secondary" : "primary"}
            onPress={() => setDueOnly(false)}
            disabled={busy}
          />
        </View>
        {!state.loaded ? (
          <ActivityIndicator color={colors.textDefault} />
        ) : state.failed ? (
          // Say what failed: a bare "Tap to retry." explained nothing (audit #25).
          <>
            <Text style={[styles.hint, textDir(rtl)]}>{t("reminders.loadFailed")}</Text>
            <Button
              variant="secondary"
              label={t("inbox.retry")}
              onPress={() => void state.refresh()}
            />
          </>
        ) : !rows.length ? (
          <Text style={[styles.hint, textDir(rtl)]}>
            {t(dueOnly ? "reminders.noDue" : "reminders.empty")}
          </Text>
        ) : (
          rows.map((row) => (
            <CustomerReminderRow
              key={row.id}
              reminder={row}
              now={state.now}
              busy={busy}
              showVault
              onOpen={() => {
                void openCustomerReminder(row.id, row.owner_scope).catch(() => {
                  if (mounted.current) setError(t("reminders.unavailable"));
                });
              }}
              onDone={() => void done(row)}
              onEdit={() => edit(row)}
              onRemove={() => setRemoving(row)}
            />
          ))
        )}
        {error ? (
          <Text style={[styles.error, textDir(rtl)]} accessibilityLiveRegion="polite">
            {error}
          </Text>
        ) : null}
      </ScrollView>
      <ConfirmDialog
        visible={removal != null}
        title={t("reminders.removeConfirm")}
        confirmLabel={t("reminders.remove")}
        cancelLabel={t("common.cancel")}
        destructive
        onConfirm={() => {
          if (removal) void done(removal, true);
        }}
        onCancel={() => setRemoving(null)}
      />
    </SafeAreaView>
  );
}
const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: colors.bgDefault },
  body: { padding: 20, gap: 16 },
  hint: { ...typography.bodySm, color: colors.textSubtle },
  filters: { gap: 12 },
  error: { ...typography.bodySm, color: colors.danger },
});
