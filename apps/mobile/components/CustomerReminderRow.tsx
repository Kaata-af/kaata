import { Pressable, StyleSheet, Text, View } from "react-native";
import { Button } from "./Button";
import { colors } from "../lib/colors";
import { readReminderSchedule, type CustomerReminder } from "../lib/customer-reminders";
import { rowDir, textDir, useIsRTL } from "../lib/direction";
import { formatTimestamp } from "../lib/format";
import { t } from "../lib/i18n";
import { formatReminderSchedule } from "../lib/reminder-format";
import { typography } from "../lib/tokens";

export function CustomerReminderRow({
  reminder,
  now,
  busy,
  onOpen,
  onDone,
  onEdit,
  onRemove,
  showVault = false,
}: {
  reminder: CustomerReminder;
  now: number;
  busy: boolean;
  onOpen?: () => void;
  onDone: () => void;
  onEdit: () => void;
  onRemove: () => void;
  showVault?: boolean;
}) {
  const rtl = useIsRTL(),
    schedule = readReminderSchedule(reminder),
    due = reminder.next_due_at <= now;
  return (
    <View style={styles.row}>
      {onOpen ? (
        <Pressable
          accessibilityRole="button"
          disabled={busy}
          onPress={onOpen}
          style={styles.customer}
        >
          <Text style={[styles.name, textDir(rtl)]}>{reminder.person_name}</Text>
          {showVault && reminder.vault_name ? (
            <Text style={[styles.meta, textDir(rtl)]}>{reminder.vault_name}</Text>
          ) : null}
        </Pressable>
      ) : null}
      <Text style={[styles.schedule, textDir(rtl)]}>
        {schedule ? formatReminderSchedule(schedule) : t("reminders.unavailable")}
      </Text>
      <Text style={[styles.meta, textDir(rtl)]}>
        {due
          ? t("reminders.due")
          : t("reminders.next", { date: formatTimestamp(reminder.next_due_at) })}
      </Text>
      <View style={[styles.actions, rowDir(rtl)]}>
        {due ? (
          <Button size="pill" label={t("reminders.markDone")} disabled={busy} onPress={onDone} />
        ) : null}
        <Button
          size="pill"
          variant="secondary"
          label={t("reminders.edit")}
          disabled={busy}
          onPress={onEdit}
        />
        <Button
          size="pill"
          variant="secondary"
          label={t("reminders.remove")}
          disabled={busy}
          onPress={onRemove}
        />
      </View>
    </View>
  );
}
const styles = StyleSheet.create({
  row: {
    paddingVertical: 18,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.borderDefault,
  },
  customer: { minHeight: 44, justifyContent: "center" },
  name: { ...typography.title, color: colors.textEmphasis },
  schedule: { ...typography.bodySm, color: colors.textDefault },
  meta: { ...typography.caption, color: colors.textSubtle, marginTop: 6 },
  actions: { flexWrap: "wrap", gap: 18, marginTop: 18 },
});
