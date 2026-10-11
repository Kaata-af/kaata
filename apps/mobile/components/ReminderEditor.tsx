import DateTimePicker, { DateTimePickerAndroid } from "@react-native-community/datetimepicker";
import { useFocusEffect } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { Platform, Pressable, StyleSheet, Text, View } from "react-native";
import { Button } from "./Button";
import { colors } from "../lib/colors";
import { rowDir, textDir, useIsRTL } from "../lib/direction";
import { formatDate } from "../lib/format";
import { t } from "../lib/i18n";
import {
  reminderClock,
  reminderMonthCount,
  reminderMonthlyDate,
  reminderWeekday,
} from "../lib/reminder-format";
import {
  nextReminderOccurrence,
  REMINDER_MONTH_INTERVALS,
  validReminderSchedule,
  type ReminderSchedule,
} from "../lib/reminder-schedule";
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
  const [kind, setKind] = useState<"once" | "daily" | "weekly" | "monthly">(
    value.kind === "weekdays" ? "weekly" : value.kind,
  );
  const [when, setWhen] = useState(
    () =>
      new Date(
        value.kind === "once"
          ? value.at
          : (nextReminderOccurrence(value, Date.now()) ?? Date.now()),
      ),
  );
  const [weekdays, setWeekdays] = useState(
    value.kind === "weekdays"
      ? value.weekdays
      : [value.kind === "weekly" ? value.weekday : when.getDay()],
  );
  const [intervalMonths, setIntervalMonths] = useState<1 | 2 | 3 | 6 | 12>(
    value.kind === "monthly" ? value.intervalMonths : 1,
  );
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
        minimumDate: mode === "date" && kind === "once" ? new Date() : undefined,
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
        : kind === "monthly"
          ? {
              kind,
              day: when.getDate(),
              anchorMonth: when.getMonth(),
              intervalMonths,
              hour: when.getHours(),
              minute: when.getMinutes(),
            }
          : weekdays.length === 1
            ? {
                kind: "weekly",
                weekday: weekdays[0],
                hour: when.getHours(),
                minute: when.getMinutes(),
              }
            : { kind: "weekdays", weekdays, hour: when.getHours(), minute: when.getMinutes() };
  const valid = validReminderSchedule(schedule);
  const next = nextReminderOccurrence(schedule, Date.now());
  return (
    <View style={styles.editor}>
      <View style={[styles.kinds, rowDir(rtl)]} accessibilityRole="radiogroup">
        {(["once", "daily", "weekly", "monthly"] as const).map((choice) => (
          <Pressable
            key={choice}
            accessibilityRole="radio"
            accessibilityLabel={t(`reminders.${choice}`)}
            accessibilityState={{ checked: kind === choice, disabled: busy }}
            disabled={busy}
            onPress={() => {
              setPicker(null);
              if (choice === "monthly" && when.getDate() > 28)
                setWhen((previous) => {
                  const next = new Date(previous);
                  next.setDate(28);
                  return next;
                });
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
          <Text style={[styles.caption, textDir(rtl)]}>{t("reminders.chooseWeekdays")}</Text>
          <View style={[styles.kinds, rowDir(rtl)]}>
            {[6, 0, 1, 2, 3, 4, 5].map((day) => (
              <Pressable
                key={day}
                accessibilityRole="checkbox"
                accessibilityLabel={reminderWeekday(day)}
                accessibilityState={{ checked: weekdays.includes(day), disabled: busy }}
                disabled={busy}
                onPress={() =>
                  setWeekdays((days) =>
                    days.includes(day)
                      ? days.filter((selected) => selected !== day)
                      : [...days, day],
                  )
                }
                style={[styles.choice, weekdays.includes(day) && styles.selected]}
              >
                <Text style={styles.label}>{reminderWeekday(day)}</Text>
              </Pressable>
            ))}
          </View>
        </View>
      ) : null}
      {kind === "monthly" ? (
        <View style={styles.weekdays}>
          <Text style={[styles.caption, textDir(rtl)]}>{t("reminders.repeatEvery")}</Text>
          <View style={[styles.kinds, rowDir(rtl)]} accessibilityRole="radiogroup">
            {REMINDER_MONTH_INTERVALS.map((months) => (
              <Pressable
                key={months}
                accessibilityRole="radio"
                accessibilityLabel={reminderMonthCount(months)}
                accessibilityState={{ checked: intervalMonths === months, disabled: busy }}
                disabled={busy}
                onPress={() => setIntervalMonths(months)}
                style={[styles.choice, intervalMonths === months && styles.selected]}
              >
                <Text style={styles.label}>{reminderMonthCount(months)}</Text>
              </Pressable>
            ))}
          </View>
          <Text style={[styles.caption, textDir(rtl)]}>{t("reminders.monthlyCalendar")}</Text>
        </View>
      ) : null}
      {kind === "once" || kind === "monthly" ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t(kind === "monthly" ? "reminders.monthlyDate" : "reminders.date")}
          disabled={busy}
          onPress={() => pick("date")}
          style={styles.field}
        >
          <Text style={[styles.caption, textDir(rtl)]}>
            {t(kind === "monthly" ? "reminders.monthlyDate" : "reminders.date")}
          </Text>
          <Text style={[styles.label, textDir(rtl)]}>
            {kind === "monthly" ? reminderMonthlyDate(when.getTime()) : formatDate(when.getTime())}
          </Text>
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
            minimumDate={picker === "date" && kind === "once" ? new Date() : undefined}
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
      {!valid ? (
        <Text style={[styles.error, textDir(rtl)]} accessibilityRole="alert">
          {t(kind === "weekly" ? "reminders.chooseOneDay" : "reminders.monthDayRange")}
        </Text>
      ) : kind === "monthly" && next != null ? (
        <Text style={[styles.next, textDir(rtl)]}>
          {t("reminders.next", { date: formatDate(next) })}
        </Text>
      ) : null}
      <View style={styles.footer}>
        <Button
          label={t("entry.save")}
          onPress={() => {
            if (valid) onSave(schedule);
          }}
          loading={busy}
          disabled={busy || !valid}
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
  error: { ...typography.bodySm, color: colors.danger, marginTop: 16 },
  next: { ...typography.caption, color: colors.textSubtle, marginTop: 16 },
  weekdays: { gap: 10, marginTop: 20 },
  field: {
    paddingVertical: 16,
    gap: 6,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.borderSubtle,
  },
  footer: { gap: 12, marginTop: 24 },
});
