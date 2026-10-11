import DateTimePicker, { DateTimePickerAndroid } from "@react-native-community/datetimepicker";
import { useFocusEffect } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { Platform, Pressable, StyleSheet, Text, View } from "react-native";
import { Button } from "./Button";
import { colors } from "../lib/colors";
import { rowDir, textDir, useIsRTL } from "../lib/direction";
import { formatDate } from "../lib/format";
import { t } from "../lib/i18n";
import { reminderClock, reminderWeekday } from "../lib/reminder-format";
import { nextReminderOccurrence, type ReminderSchedule } from "../lib/reminder-schedule";
import { radius, typography } from "../lib/tokens";

export function ReminderEditor({
  value,
  busy,
  onSave,
  onCancel,
}: {
  value: ReminderSchedule;
  busy: boolean;
  onSave: (schedule: ReminderSchedule) => void;
  onCancel: () => void;
}) {
  const rtl = useIsRTL();
  const [kind, setKind] = useState(value.kind);
  const [when, setWhen] = useState(
    () =>
      new Date(
        value.kind === "once"
          ? value.at
          : (nextReminderOccurrence(value, Date.now()) ?? Date.now()),
      ),
  );
  const [weekday, setWeekday] = useState(value.kind === "weekly" ? value.weekday : when.getDay());
  const [picker, setPicker] = useState<"date" | "time" | null>(null);
  const mounted = useRef(true),
    pickerRequest = useRef(0),
    androidMode = useRef<"date" | "time" | null>(null);
  const focused = useRef(false),
    busyRef = useRef(busy);
  busyRef.current = busy;
  useFocusEffect(
    useCallback(() => {
      focused.current = true;
      return () => {
        focused.current = false;
        pickerRequest.current++;
        if (androidMode.current) {
          void DateTimePickerAndroid.dismiss(androidMode.current).catch(() => undefined);
          androidMode.current = null;
        }
      };
    }, []),
  );
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      pickerRequest.current++;
      if (androidMode.current)
        void DateTimePickerAndroid.dismiss(androidMode.current).catch(() => undefined);
    };
  }, []);
  function pick(mode: "date" | "time") {
    if (busy || !focused.current || androidMode.current) return;
    const request = ++pickerRequest.current;
    const change = (_: unknown, selected: Date) => {
      if (
        !mounted.current ||
        !focused.current ||
        busyRef.current ||
        request !== pickerRequest.current ||
        !Number.isFinite(selected.getTime())
      )
        return;
      setWhen((previous) => {
        const next = new Date(previous);
        if (mode === "date")
          next.setFullYear(selected.getFullYear(), selected.getMonth(), selected.getDate());
        else next.setHours(selected.getHours(), selected.getMinutes(), 0, 0);
        return next;
      });
      if (Platform.OS === "android") androidMode.current = null;
    };
    if (Platform.OS === "android") {
      androidMode.current = mode;
      DateTimePickerAndroid.open({
        value: when,
        mode,
        onValueChange: change,
        minimumDate: mode === "date" ? new Date() : undefined,
        onDismiss: () => {
          if (request === pickerRequest.current) androidMode.current = null;
        },
      });
    } else setPicker(mode);
  }
  const schedule: ReminderSchedule =
    kind === "once"
      ? { kind, at: when.getTime() }
      : kind === "daily"
        ? { kind, hour: when.getHours(), minute: when.getMinutes() }
        : { kind, weekday, hour: when.getHours(), minute: when.getMinutes() };
  return (
    <View style={styles.editor}>
      <View style={[styles.kinds, rowDir(rtl)]} accessibilityRole="radiogroup">
        {(["once", "daily", "weekly"] as const).map((choice) => (
          <Pressable
            key={choice}
            accessibilityRole="radio"
            accessibilityLabel={t(`reminders.${choice}`)}
            accessibilityState={{ checked: kind === choice, disabled: busy }}
            disabled={busy}
            onPress={() => {
              setPicker(null);
              setKind(choice);
            }}
            style={[styles.choice, kind === choice && styles.selected]}
          >
            <Text style={styles.label}>{t(`reminders.${choice}`)}</Text>
          </Pressable>
        ))}
      </View>
      {kind === "weekly" ? (
        <View style={styles.weekdays}>
          <Text style={[styles.caption, textDir(rtl)]}>{t("reminders.weekday")}</Text>
          <View style={[styles.kinds, rowDir(rtl)]}>
            {[6, 0, 1, 2, 3, 4, 5].map((day) => (
              <Pressable
                key={day}
                accessibilityRole="radio"
                accessibilityLabel={reminderWeekday(day)}
                accessibilityState={{ checked: weekday === day, disabled: busy }}
                disabled={busy}
                onPress={() => setWeekday(day)}
                style={[styles.choice, weekday === day && styles.selected]}
              >
                <Text style={styles.label}>{reminderWeekday(day)}</Text>
              </Pressable>
            ))}
          </View>
        </View>
      ) : null}
      {kind === "once" ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("reminders.date")}
          disabled={busy}
          onPress={() => pick("date")}
          style={styles.field}
        >
          <Text style={[styles.caption, textDir(rtl)]}>{t("reminders.date")}</Text>
          <Text style={[styles.label, textDir(rtl)]}>{formatDate(when.getTime())}</Text>
        </Pressable>
      ) : null}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t("reminders.time")}
        disabled={busy}
        onPress={() => pick("time")}
        style={styles.field}
      >
        <Text style={[styles.caption, textDir(rtl)]}>{t("reminders.time")}</Text>
        <Text style={[styles.label, textDir(rtl)]}>
          {reminderClock(when.getHours(), when.getMinutes())}
        </Text>
      </Pressable>
      {picker && Platform.OS !== "android" ? (
        <View>
          <DateTimePicker
            value={when}
            mode={picker}
            display="spinner"
            themeVariant="light"
            minimumDate={picker === "date" ? new Date() : undefined}
            onValueChange={(_, selected) => {
              if (
                busyRef.current ||
                !mounted.current ||
                !focused.current ||
                !Number.isFinite(selected.getTime())
              )
                return;
              setWhen((previous) => {
                const next = new Date(previous);
                if (picker === "date")
                  next.setFullYear(selected.getFullYear(), selected.getMonth(), selected.getDate());
                else next.setHours(selected.getHours(), selected.getMinutes(), 0, 0);
                return next;
              });
            }}
          />
          <Button
            variant="secondary"
            label={t("common.done")}
            onPress={() => setPicker(null)}
            disabled={busy}
          />
        </View>
      ) : null}
      <View style={styles.footer}>
        <Button
          label={t("entry.save")}
          onPress={() => onSave(schedule)}
          loading={busy}
          disabled={busy}
          fullWidth
        />
        <Button
          variant="secondary"
          label={t("common.cancel")}
          onPress={onCancel}
          disabled={busy}
          fullWidth
        />
      </View>
    </View>
  );
}
const styles = StyleSheet.create({
  editor: { paddingVertical: 12 },
  kinds: { flexWrap: "wrap", gap: 10 },
  choice: {
    minHeight: 44,
    justifyContent: "center",
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderWidth: 1,
    borderColor: colors.borderDefault,
    borderRadius: radius.md,
  },
  selected: { borderColor: colors.actionPrimary, backgroundColor: colors.bgMuted },
  label: { ...typography.bodySm, color: colors.textDefault },
  caption: { ...typography.caption, color: colors.textSubtle },
  weekdays: { gap: 10, marginTop: 20 },
  field: {
    paddingVertical: 16,
    gap: 6,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.borderSubtle,
  },
  footer: { gap: 12, marginTop: 24 },
});
