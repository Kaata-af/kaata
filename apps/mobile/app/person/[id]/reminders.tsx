import { Stack, useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, BackHandler, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Button } from "../../../components/Button";
import { ConfirmDialog } from "../../../components/ConfirmDialog";
import { CustomerReminderRow } from "../../../components/CustomerReminderRow";
import { ReminderEditor } from "../../../components/ReminderEditor";
import { ReminderPermissionNotice } from "../../../components/ReminderPermissionNotice";
import { ScreenHeader } from "../../../components/SettingsScreen";
import { useToast } from "../../../components/Toast";
import { useCalendar } from "../../../lib/calendar";
import { colors } from "../../../lib/colors";
import {
  dismissCustomerReminder,
  readReminderSchedule,
  reminderOwnerScope,
  saveCustomerReminder,
  type CustomerReminder,
} from "../../../lib/customer-reminders";
import { getActiveVaultIdSyncMaybe, getInstallIdSync } from "../../../lib/db-tx";
import { getReminderDeviceIdSync } from "../../../lib/reminder-device";
import { textDir, useIsRTL } from "../../../lib/direction";
import { t } from "../../../lib/i18n";
import {
  requestReminderNotifications,
  reconcileReminderNotifications,
} from "../../../lib/reminder-notifications";
import { nextReminderOccurrence, type ReminderSchedule } from "../../../lib/reminder-schedule";
import { typography } from "../../../lib/tokens";
import { useCustomerReminders } from "../../../lib/use-customer-reminders";

export default function PersonRemindersScreen() {
  const params = useLocalSearchParams<{ id: string; vaultId?: string; reminderId?: string }>(),
    router = useRouter(),
    rtl = useIsRTL(),
    toast = useToast();
  const [vaultId] = useState(() => params.vaultId ?? getActiveVaultIdSyncMaybe());
  const state = useCustomerReminders(vaultId ?? undefined, params.id);
  useCalendar();
  const binding = `${reminderOwnerScope()}:${getInstallIdSync()}`;
  const [editorState, setEditor] = useState<{
    binding: string;
    id?: string;
    value: ReminderSchedule;
  } | null>(null);
  const [removingState, setRemoving] = useState<{ binding: string; row: CustomerReminder } | null>(
    null,
  );
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null);
  const mounted = useRef(true),
    working = useRef(false),
    initialized = useRef<string | null>(null);
  const focused = useRef(false),
    focusGeneration = useRef(0);
  useFocusEffect(
    useCallback(() => {
      focused.current = true;
      focusGeneration.current++;
      const back = BackHandler.addEventListener("hardwareBackPress", () => working.current);
      return () => {
        focused.current = false;
        focusGeneration.current++;
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
  const editor = editorState?.binding === binding ? editorState : null;
  const removing = removingState?.binding === binding ? removingState.row : null;
  useEffect(() => {
    if (!state.loaded || !state.customer || initialized.current === binding) return;
    initialized.current = binding;
    const selected = state.rows.find((row) => row.id === params.reminderId);
    const value = selected ? readReminderSchedule(selected) : null;
    if (selected && value) setEditor({ binding, id: selected.id, value });
    else if (!state.rows.length)
      setEditor({ binding, value: { kind: "once", at: Date.now() + 3_600_000 } });
  }, [binding, state.loaded, state.customer, state.rows, params.reminderId]);
  const current = (captured: string, focus: number) =>
    mounted.current &&
    focused.current &&
    focus === focusGeneration.current &&
    `${reminderOwnerScope()}:${getInstallIdSync()}` === captured;

  async function save(schedule: ReminderSchedule) {
    if (!focused.current || !vaultId || !state.customer || working.current || !editor) return;
    if (nextReminderOccurrence(schedule, Date.now()) == null) {
      setError(t("reminders.future"));
      return;
    }
    const captured = binding,
      focus = focusGeneration.current;
    working.current = true;
    setBusy(true);
    setError(null);
    try {
      await saveCustomerReminder(vaultId, params.id, schedule, editor.id);
      if (!current(captured, focus)) return;
      setEditor(null);
      let result: "granted" | "denied" | "unavailable";
      try {
        result = await requestReminderNotifications();
      } catch {
        result = "unavailable";
      }
      if (!current(captured, focus)) return;
      try {
        await reconcileReminderNotifications();
        if (current(captured, focus))
          toast.push(
            t(
              result === "denied"
                ? "reminders.permissionDenied"
                : result === "unavailable"
                  ? "reminders.permissionUnavailable"
                  : "reminders.saved",
            ),
            "success",
          );
      } catch {
        if (current(captured, focus)) toast.push(t("reminders.nativeFailed"), "info");
      }
      await state.refresh();
    } catch (err) {
      if (current(captured, focus))
        setError(
          t(
            err instanceof Error && err.message === "reminder_limit"
              ? "reminders.limit"
              : err instanceof Error && err.message === "reminder_notification_limit"
                ? "reminders.scheduleLimit"
                : err instanceof Error && err.message === "reminder_access_denied"
                  ? "reminders.unavailable"
                  : "entry.saveFailed",
          ),
        );
    } finally {
      working.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  async function complete(row: CustomerReminder, remove = false) {
    if (
      !focused.current ||
      working.current ||
      row.owner_scope !== reminderOwnerScope() ||
      row.install_id !== getReminderDeviceIdSync()
    )
      return;
    if (!remove && row.next_due_at > Date.now()) return;
    const captured = binding,
      focus = focusGeneration.current;
    working.current = true;
    setBusy(true);
    setError(null);
    setRemoving(null);
    try {
      await dismissCustomerReminder(row.id, remove);
      await reconcileReminderNotifications();
      await state.refresh();
    } catch {
      if (current(captured, focus)) setError(t("entry.saveFailed"));
    } finally {
      working.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  function edit(row: CustomerReminder) {
    const value = readReminderSchedule(row);
    if (
      value &&
      !busy &&
      row.owner_scope === reminderOwnerScope() &&
      row.install_id === getReminderDeviceIdSync()
    ) {
      setError(null);
      setEditor({ binding, id: row.id, value });
    }
  }
  return (
    <SafeAreaView edges={["top", "bottom"]} style={styles.page}>
      <Stack.Screen options={{ gestureEnabled: !busy }} />
      <ScreenHeader
        title={t("reminders.title")}
        isRTL={rtl}
        onBack={() => router.back()}
        backDisabled={busy}
      />
      <ScrollView contentContainerStyle={styles.body}>
        <Text style={[styles.hint, textDir(rtl)]}>{t("reminders.personal")}</Text>
        <ReminderPermissionNotice isRTL={rtl} />
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
        ) : !state.customer ? (
          <Text style={[styles.hint, textDir(rtl)]}>{t("reminders.unavailable")}</Text>
        ) : (
          <>
            <Text style={[styles.customer, textDir(rtl)]}>{state.customer.name}</Text>
            {editor ? (
              <ReminderEditor
                key={`${binding}:${editor.id ?? "new"}`}
                value={editor.value}
                busy={busy}
                onSave={(value) => void save(value)}
                onCancel={() => {
                  setError(null);
                  setEditor(null);
                }}
              />
            ) : (
              <Button
                label={t("reminders.add")}
                icon="add-outline"
                onPress={() => {
                  setError(null);
                  setEditor({ binding, value: { kind: "once", at: Date.now() + 3_600_000 } });
                }}
                disabled={busy}
                fullWidth
              />
            )}
            {state.rows.map((row) => (
              <CustomerReminderRow
                key={row.id}
                reminder={row}
                now={state.now}
                busy={busy}
                onDone={() => void complete(row)}
                onEdit={() => edit(row)}
                onRemove={() => setRemoving({ binding, row })}
              />
            ))}
          </>
        )}
        {error ? (
          <Text style={[styles.error, textDir(rtl)]} accessibilityLiveRegion="polite">
            {error}
          </Text>
        ) : null}
        <Button
          variant="secondary"
          label={t("reminders.all")}
          onPress={() => router.push({ pathname: "/reminders", params: { view: "all" } })}
          disabled={busy}
          fullWidth
        />
      </ScrollView>
      <ConfirmDialog
        visible={removing != null}
        title={t("reminders.removeConfirm")}
        confirmLabel={t("reminders.remove")}
        cancelLabel={t("common.cancel")}
        destructive
        onConfirm={() => {
          if (removing) void complete(removing, true);
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
  customer: { ...typography.heading, color: colors.textEmphasis },
  error: { ...typography.bodySm, color: colors.danger },
});
