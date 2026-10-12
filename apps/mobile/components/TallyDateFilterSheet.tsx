import { Ionicons } from "@expo/vector-icons";
import DateTimePicker, { DateTimePickerAndroid } from "@react-native-community/datetimepicker";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Animated,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Button } from "./Button";
import { SheetBackdrop } from "./SheetBackdrop";
import type { Calendar } from "../lib/calendar";
import { colors } from "../lib/colors";
import { rowDir, textDir } from "../lib/direction";
import { getLocale, t } from "../lib/i18n";
import { faDigits, formatCalendarDate } from "../lib/jalali";
import { fonts } from "../lib/fonts";
import {
  adjacentCalendarMonth,
  calendarDay,
  calendarMonthDays,
  customDateRange,
  datePresetRange,
  dateRangeDraft,
  dateRangeBetween,
  formatFilterClock,
  localDayStart,
  type TallyDateRange,
  type TallyDatePreset,
} from "../lib/tally-date-filter";
import { useOverlayAnimation } from "../lib/use-overlay-animation";
import { radius, TOUCH_MIN, typography } from "../lib/tokens";

/** A single date button opens presets; the month grid appears only for custom.
 * The grid uses the same calendar conversion as the ledger's visible dates. */
export function TallyDateFilterSheet(props: {
  visible: boolean;
  range: TallyDateRange | null;
  calendar: Calendar;
  isRTL: boolean;
  onChange: (range: TallyDateRange | null) => void;
  onDismiss: () => void;
}) {
  const { rendered, opacity, position } = useOverlayAnimation(props.visible, 800);
  const [custom, setCustom] = useState(false);
  const [month, setMonth] = useState(Date.now());
  const [first, setFirst] = useState<number | null>(null);
  const [last, setLast] = useState<number | null>(null);
  const [startMinute, setStartMinute] = useState(0);
  const [endMinute, setEndMinute] = useState(1439);
  const [picker, setPicker] = useState<{ field: "start" | "end"; request: number } | null>(null);
  const [timeUnavailable, setTimeUnavailable] = useState(false);
  const pickerRequest = useRef(0),
    androidPicker = useRef(false),
    mounted = useRef(true);
  const visible = useRef(props.visible);
  visible.current = props.visible;
  const { height } = useWindowDimensions();
  const locale = getLocale();
  const cancelNativePicker = () => {
    pickerRequest.current++;
    if (androidPicker.current) {
      androidPicker.current = false;
      void DateTimePickerAndroid.dismiss("time").catch(() => undefined);
    }
  };
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      cancelNativePicker();
    };
  }, []);
  useEffect(() => {
    cancelNativePicker();
    setPicker(null);
    setTimeUnavailable(false);
    if (!props.visible) return;
    const draft = dateRangeDraft(props.range);
    setCustom(false);
    setFirst(draft.first);
    setLast(draft.last);
    setStartMinute(draft.startMinute);
    setEndMinute(draft.endMinute);
    setMonth(props.range?.start ?? Date.now());
  }, [props.visible, props.range, props.calendar]);
  const days = useMemo(() => calendarMonthDays(month, props.calendar), [month, props.calendar]);
  const weekStart = locale === "fa" ? 6 : 1;
  const padding = days.length ? (new Date(days[0]).getDay() - weekStart + 7) % 7 : 0;
  const grid: (number | null)[] = [...Array.from({ length: padding }, () => null), ...days];
  while (grid.length % 7) grid.push(null);
  const selectedDays = first != null && last != null ? dateRangeBetween(first, last) : null;
  const preview =
    first != null && last != null ? customDateRange(first, last, startMinute, endMinute) : null;
  const dateLabel = (ms: number) => formatCalendarDate(ms, locale, props.calendar);
  const clockDate = (minute: number) => new Date(2000, 0, 15, Math.floor(minute / 60), minute % 60);
  const changeClock = (field: "start" | "end", request: number, selected: Date) => {
    if (
      !mounted.current ||
      !visible.current ||
      request !== pickerRequest.current ||
      !Number.isFinite(selected.getTime())
    )
      return;
    const minute = selected.getHours() * 60 + selected.getMinutes();
    if (field === "start") setStartMinute(minute);
    else setEndMinute(minute);
    if (Platform.OS === "android") {
      androidPicker.current = false;
      pickerRequest.current++;
    }
  };
  const pickClock = (field: "start" | "end") => {
    if (!props.visible || androidPicker.current) return;
    setTimeUnavailable(false);
    const request = ++pickerRequest.current;
    if (Platform.OS === "android") {
      androidPicker.current = true;
      const unavailable = () => {
        if (!mounted.current || !visible.current || request !== pickerRequest.current) return;
        androidPicker.current = false;
        pickerRequest.current++;
        setTimeUnavailable(true);
      };
      try {
        DateTimePickerAndroid.open({
          value: clockDate(field === "start" ? startMinute : endMinute),
          mode: "time",
          is24Hour: true,
          onValueChange: (_, selected) => changeClock(field, request, selected),
          onError: unavailable,
          onDismiss: () => {
            if (request === pickerRequest.current) {
              androidPicker.current = false;
              pickerRequest.current++;
            }
          },
        });
      } catch {
        unavailable();
      }
    } else setPicker({ field, request });
  };
  const dismiss = () => {
    cancelNativePicker();
    setPicker(null);
    props.onDismiss();
  };
  const commit = (range: TallyDateRange | null) => {
    cancelNativePicker();
    props.onChange(range);
    props.onDismiss();
  };
  if (!rendered) return null;
  return (
    <Modal visible transparent animationType="none" statusBarTranslucent onRequestClose={dismiss}>
      <Animated.View style={[StyleSheet.absoluteFill, { opacity }]}>
        <SheetBackdrop onDismiss={dismiss} />
      </Animated.View>
      <Animated.View
        style={[
          styles.container,
          { maxHeight: height * 0.88, transform: [{ translateY: position }] },
        ]}
      >
        <SafeAreaView edges={["bottom"]} style={{ flexShrink: 1 }}>
          <View style={styles.grabber} />
          <View style={[styles.heading, rowDir(props.isRTL)]}>
            <Text accessibilityRole="header" style={[styles.title, textDir(props.isRTL)]}>
              {t("person.date.title")}
            </Text>
            <Pressable
              onPress={dismiss}
              style={styles.icon}
              accessibilityRole="button"
              accessibilityLabel={t("common.cancel")}
            >
              <Ionicons name="close" size={22} color={colors.textMuted} />
            </Pressable>
          </View>
          <ScrollView bounces={false} contentContainerStyle={styles.content}>
            {!custom ? (
              <>
                <Pressable
                  accessibilityRole="button"
                  onPress={() => commit(null)}
                  style={styles.row}
                >
                  <Text style={[styles.label, textDir(props.isRTL)]}>{t("person.date.all")}</Text>
                </Pressable>
                {(["today", "last7", "last30", "month"] as TallyDatePreset[]).map((preset) => (
                  <Pressable
                    key={preset}
                    accessibilityRole="button"
                    onPress={() => commit(datePresetRange(preset, Date.now(), props.calendar))}
                    style={styles.row}
                  >
                    <Text style={[styles.label, textDir(props.isRTL)]}>
                      {t(`person.date.${preset}`)}
                    </Text>
                  </Pressable>
                ))}
                <Pressable
                  accessibilityRole="button"
                  onPress={() => {
                    setCustom(true);
                  }}
                  style={[styles.row, rowDir(props.isRTL)]}
                >
                  <Text style={[styles.label, { flex: 1 }, textDir(props.isRTL)]}>
                    {t("person.date.custom")}
                  </Text>
                  <Ionicons
                    name={props.isRTL ? "chevron-back" : "chevron-forward"}
                    size={18}
                    color={colors.textSubtle}
                  />
                </Pressable>
              </>
            ) : (
              <>
                <Text style={[styles.hint, textDir(props.isRTL)]}>
                  {t(
                    first == null
                      ? "person.date.pickStart"
                      : last == null
                        ? "person.date.pickEnd"
                        : "person.date.rangeReady",
                  )}
                </Text>
                <View style={[styles.month, rowDir(props.isRTL)]}>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={t("person.date.previousMonth")}
                    style={styles.icon}
                    onPress={() => setMonth(adjacentCalendarMonth(month, -1, props.calendar))}
                  >
                    <Ionicons
                      name={props.isRTL ? "chevron-forward" : "chevron-back"}
                      size={20}
                      color={colors.textEmphasis}
                    />
                  </Pressable>
                  <Text style={styles.monthText}>
                    {dateLabel(days[0] ?? month)
                      .split(" ")
                      .slice(1)
                      .join(" ")}
                  </Text>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={t("person.date.nextMonth")}
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
                      const selected = day === first || day === last;
                      const inside =
                        !!selectedDays && day >= selectedDays.start && day < selectedDays.end;
                      const number = calendarDay(day, props.calendar).day;
                      return (
                        <Pressable
                          key={column}
                          style={[
                            styles.day,
                            inside && styles.inRange,
                            selected && styles.selected,
                          ]}
                          accessibilityRole="button"
                          accessibilityLabel={dateLabel(day)}
                          accessibilityState={{ selected: inside || selected }}
                          onPress={() => {
                            if (first == null || last != null) {
                              setFirst(localDayStart(day));
                              setLast(null);
                            } else setLast(localDayStart(day));
                          }}
                        >
                          <Text
                            style={[styles.dayText, selected && { color: colors.textInverted }]}
                          >
                            {locale === "fa" ? faDigits(number) : number}
                          </Text>
                        </Pressable>
                      );
                    })}
                  </View>
                ))}
                <Text style={[styles.range, textDir(props.isRTL)]}>
                  {selectedDays
                    ? `${dateLabel(selectedDays.start)} – ${dateLabel(selectedDays.end - 1)}`
                    : first != null
                      ? dateLabel(first)
                      : t("person.date.chooseRange")}
                </Text>
                <View style={[styles.times, rowDir(props.isRTL)]}>
                  {(["start", "end"] as const).map((field) => {
                    const label = t(
                      field === "start" ? "person.date.startTime" : "person.date.endTime",
                    );
                    const clock = formatFilterClock(
                      clockDate(field === "start" ? startMinute : endMinute).getTime(),
                      locale,
                    );
                    return (
                      <Pressable
                        key={field}
                        accessibilityRole="button"
                        accessibilityLabel={label}
                        accessibilityValue={{ text: clock }}
                        onPress={() => pickClock(field)}
                        style={[styles.timeField, picker?.field === field && styles.timeActive]}
                      >
                        <Text style={[styles.timeCaption, textDir(props.isRTL)]}>{label}</Text>
                        <Text style={[styles.timeClock, textDir(props.isRTL)]}>{clock}</Text>
                      </Pressable>
                    );
                  })}
                </View>
                {picker && Platform.OS !== "android" ? (
                  <View style={styles.timePicker}>
                    <DateTimePicker
                      key={picker.request}
                      value={clockDate(picker.field === "start" ? startMinute : endMinute)}
                      mode="time"
                      display="spinner"
                      themeVariant="light"
                      onValueChange={(_, selected) =>
                        changeClock(picker.field, picker.request, selected)
                      }
                    />
                    <Button
                      variant="secondary"
                      label={t("common.done")}
                      onPress={() => {
                        cancelNativePicker();
                        setPicker(null);
                      }}
                    />
                  </View>
                ) : null}
                {timeUnavailable ? (
                  <Text accessibilityRole="alert" style={[styles.invalid, textDir(props.isRTL)]}>
                    {t("person.date.timeUnavailable")}
                  </Text>
                ) : null}
                {selectedDays && !preview ? (
                  <Text accessibilityRole="alert" style={[styles.invalid, textDir(props.isRTL)]}>
                    {t("person.date.invalidTimes")}
                  </Text>
                ) : null}
                <Button
                  fullWidth
                  label={t("person.date.apply")}
                  disabled={!preview}
                  onPress={() => preview && commit(preview)}
                />
              </>
            )}
          </ScrollView>
        </SafeAreaView>
      </Animated.View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: colors.bgDefault,
    borderTopLeftRadius: radius.sheet,
    borderTopRightRadius: radius.sheet,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderDefault,
  },
  grabber: {
    alignSelf: "center",
    width: 40,
    height: 4,
    backgroundColor: colors.borderEmphasis,
    borderRadius: radius.grabber,
    marginTop: 10,
    marginBottom: 4,
  },
  heading: { alignItems: "center", paddingHorizontal: 20 },
  title: { ...typography.heading, flex: 1, color: colors.textEmphasis },
  icon: {
    minWidth: TOUCH_MIN,
    minHeight: TOUCH_MIN,
    alignItems: "center",
    justifyContent: "center",
  },
  content: { paddingHorizontal: 20, paddingBottom: 16 },
  row: {
    minHeight: 52,
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.borderSubtle,
    alignItems: "center",
  },
  label: { ...typography.body, color: colors.textEmphasis, alignSelf: "stretch" },
  hint: { ...typography.bodySm, color: colors.textMuted, marginVertical: 8 },
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
  inRange: { backgroundColor: colors.bgMuted },
  selected: { backgroundColor: colors.actionPrimary },
  dayText: { ...typography.body, color: colors.textEmphasis },
  range: { ...typography.bodySm, color: colors.textMuted, minHeight: 44, paddingVertical: 12 },
  times: { gap: 12, marginBottom: 14 },
  timeField: {
    flex: 1,
    minHeight: TOUCH_MIN,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: radius.sm,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderDefault,
    backgroundColor: colors.bgMuted,
  },
  timeActive: { borderColor: colors.borderEmphasis },
  timeCaption: { ...typography.caption, color: colors.textMuted },
  timeClock: { ...typography.labelBold, color: colors.textEmphasis, marginTop: 4 },
  timePicker: { marginBottom: 14 },
  invalid: { ...typography.bodySm, color: colors.danger, marginBottom: 12 },
});
