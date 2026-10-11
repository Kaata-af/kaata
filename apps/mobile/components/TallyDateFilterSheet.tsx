import { Ionicons } from "@expo/vector-icons";
import { useEffect, useMemo, useState } from "react";
import {
  Animated,
  Modal,
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
  datePresetRange,
  dateRangeBetween,
  localDayStart,
  shiftLocalDay,
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
  const { height } = useWindowDimensions();
  const locale = getLocale();
  useEffect(() => {
    if (!props.visible) return;
    setCustom(false);
    setFirst(props.range?.start ?? null);
    setLast(props.range ? shiftLocalDay(props.range.end, -1) : null);
    setMonth(props.range?.start ?? Date.now());
  }, [props.visible, props.range]);
  const days = useMemo(() => calendarMonthDays(month, props.calendar), [month, props.calendar]);
  const weekStart = locale === "fa" ? 6 : 1;
  const padding = days.length ? (new Date(days[0]).getDay() - weekStart + 7) % 7 : 0;
  const grid: (number | null)[] = [...Array.from({ length: padding }, () => null), ...days];
  while (grid.length % 7) grid.push(null);
  const preview = first != null && last != null ? dateRangeBetween(first, last) : null;
  const dateLabel = (ms: number) => formatCalendarDate(ms, locale, props.calendar);
  const commit = (range: TallyDateRange | null) => {
    props.onChange(range);
    props.onDismiss();
  };
  if (!rendered) return null;
  return (
    <Modal
      visible
      transparent
      animationType="none"
      statusBarTranslucent
      onRequestClose={props.onDismiss}
    >
      <Animated.View style={[StyleSheet.absoluteFill, { opacity }]}>
        <SheetBackdrop onDismiss={props.onDismiss} />
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
              onPress={props.onDismiss}
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
                    setFirst(null);
                    setLast(null);
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
                      const inside = !!preview && day >= preview.start && day < preview.end;
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
                  {preview
                    ? `${dateLabel(preview.start)} – ${dateLabel(shiftLocalDay(preview.end, -1))}`
                    : first != null
                      ? dateLabel(first)
                      : t("person.date.chooseRange")}
                </Text>
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
});
