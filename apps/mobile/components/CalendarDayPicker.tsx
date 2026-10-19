import { Ionicons } from "@expo/vector-icons";
import { useEffect, useMemo, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import type { Calendar } from "../lib/calendar";
import { colors } from "../lib/colors";
import { rowDir } from "../lib/direction";
import { fonts } from "../lib/fonts";
import { getLocale, t } from "../lib/i18n";
import { faDigits, formatCalendarDate } from "../lib/jalali";
import {
  adjacentCalendarMonth,
  calendarDay,
  calendarMonthDays,
  localDayStart,
} from "../lib/tally-date-filter";
import { radius, TOUCH_MIN, typography } from "../lib/tokens";

/** One day from a month grid in the app's calendar. The native date pickers
 *  only know the phone's calendar, so a Shamsi or Qamari user picked dates in
 *  Gregorian months they then saw written as Shamsi (audit #25). Same grid
 *  helpers and look as the tally date filter. */
export function CalendarDayPicker(props: {
  /** Any moment of the chosen day. */
  value: number;
  calendar: Calendar;
  isRTL: boolean;
  /** Days before this day are not offered. */
  minimum?: number;
  disabled?: boolean;
  /** The start of the chosen local day. */
  onChange: (day: number) => void;
}) {
  const locale = getLocale();
  const [month, setMonth] = useState(() => localDayStart(props.value));
  useEffect(() => setMonth(localDayStart(props.value)), [props.value, props.calendar]);
  const days = useMemo(() => calendarMonthDays(month, props.calendar), [month, props.calendar]);
  // Saturday first in Persian or a non-Gregorian calendar, as in the filter.
  const weekStart = locale !== "en" || props.calendar !== "gregorian" ? 6 : 1;
  const padding = days.length ? (new Date(days[0]).getDay() - weekStart + 7) % 7 : 0;
  const grid: (number | null)[] = [...Array.from({ length: padding }, () => null), ...days];
  while (grid.length % 7) grid.push(null);
  const label = (ms: number) => formatCalendarDate(ms, locale, props.calendar);
  const chosen = localDayStart(props.value);
  const today = localDayStart(Date.now());
  const minimum = props.minimum == null ? null : localDayStart(props.minimum);
  const canGoBack = minimum == null || (days[0] ?? month) > minimum;
  const disabled = !!props.disabled;
  return (
    <View>
      <View style={[styles.month, rowDir(props.isRTL)]}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("person.date.previousMonth")}
          accessibilityState={{ disabled: !canGoBack || disabled }}
          disabled={!canGoBack || disabled}
          style={[styles.icon, !canGoBack && styles.off]}
          onPress={() => setMonth(adjacentCalendarMonth(month, -1, props.calendar))}
        >
          <Ionicons
            name={props.isRTL ? "chevron-forward" : "chevron-back"}
            size={20}
            color={colors.textEmphasis}
          />
        </Pressable>
        <Text style={styles.monthText}>
          {label(days[0] ?? month)
            .split(" ")
            .slice(1)
            .join(" ")}
        </Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("person.date.nextMonth")}
          accessibilityState={{ disabled }}
          disabled={disabled}
          style={styles.icon}
          onPress={() => setMonth(adjacentCalendarMonth(month, 1, props.calendar))}
        >
          <Ionicons
            name={props.isRTL ? "chevron-back" : "chevron-forward"}
            size={20}
            color={colors.textEmphasis}
          />
        </Pressable>
      </View>
      <View style={[styles.week, rowDir(props.isRTL)]}>
        {Array.from({ length: 7 }, (_, n) => (n + weekStart) % 7).map((day) => (
          <Text key={day} style={styles.weekday}>
            {t(`person.date.weekday.${day as 0 | 1 | 2 | 3 | 4 | 5 | 6}`)}
          </Text>
        ))}
      </View>
      {Array.from({ length: grid.length / 7 }, (_, week) => (
        <View key={week} style={[styles.week, rowDir(props.isRTL)]}>
          {grid.slice(week * 7, week * 7 + 7).map((day, column) => {
            if (day == null) return <View key={column} style={styles.day} />;
            const selected = day === chosen;
            const unavailable = minimum != null && day < minimum;
            const number = calendarDay(day, props.calendar).day;
            return (
              <Pressable
                key={column}
                style={[
                  styles.day,
                  day === today && !selected && styles.today,
                  selected && styles.selected,
                  unavailable && styles.off,
                ]}
                accessibilityRole="button"
                accessibilityLabel={label(day)}
                accessibilityState={{ selected, disabled: unavailable || disabled }}
                disabled={unavailable || disabled}
                onPress={() => props.onChange(day)}
              >
                <Text style={[styles.dayText, selected && { color: colors.textInverted }]}>
                  {locale !== "en" ? faDigits(number) : number}
                </Text>
              </Pressable>
            );
          })}
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  icon: {
    minWidth: TOUCH_MIN,
    minHeight: TOUCH_MIN,
    alignItems: "center",
    justifyContent: "center",
  },
  month: { alignItems: "center", justifyContent: "space-between" },
  monthText: { ...typography.body, fontFamily: fonts.sansSemi, color: colors.textEmphasis },
  week: { flexDirection: "row", gap: 2 },
  weekday: {
    flex: 1,
    textAlign: "center",
    ...typography.caption,
    color: colors.textMuted,
    paddingVertical: 8,
  },
  day: {
    flex: 1,
    minHeight: TOUCH_MIN,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radius.sm,
    marginVertical: 1,
  },
  today: { borderWidth: 1, borderColor: colors.textSubtle },
  selected: { backgroundColor: colors.actionPrimary },
  off: { opacity: 0.35 },
  dayText: { ...typography.body, color: colors.textEmphasis },
});
