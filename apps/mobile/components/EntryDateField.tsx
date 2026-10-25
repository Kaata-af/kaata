import { Ionicons } from "@expo/vector-icons";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useCalendar } from "../lib/calendar";
import { colors } from "../lib/colors";
import { rowDir, textDir, useIsRTL } from "../lib/direction";
import { fonts } from "../lib/fonts";
import { getLocale, t } from "../lib/i18n";
import { formatCalendarDate } from "../lib/jalali";
import { localDayStart } from "../lib/tally-date-filter";
import { radius, TOUCH_MIN, typography } from "../lib/tokens";
import { CalendarDayPicker } from "./CalendarDayPicker";

/** The parent owns the open state so the date grid and amount/note keyboards
 * can share a form without competing for space or focus. */
export function EntryDateField(props: {
  value: number;
  expanded: boolean;
  disabled?: boolean;
  onToggle: () => void;
  /** A local day start; the parent preserves the tally's time of day. */
  onChange: (day: number) => void;
}) {
  const calendar = useCalendar();
  const isRTL = useIsRTL();
  const label = t("entry.date.label");
  const valueLabel = formatCalendarDate(props.value, getLocale(), calendar);
  const toggle = () => {
    if (!props.disabled) props.onToggle();
  };
  const choose = (day: number) => {
    if (props.disabled) return;
    props.onChange(day);
    props.onToggle();
  };

  return (
    <View>
      <Text style={[styles.label, textDir(isRTL)]}>{label}</Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityValue={{ text: valueLabel }}
        accessibilityState={{ expanded: props.expanded, disabled: !!props.disabled }}
        disabled={props.disabled}
        onPress={toggle}
        style={({ pressed }) => [
          styles.input,
          rowDir(isRTL),
          props.disabled && styles.disabled,
          pressed && { backgroundColor: colors.bgMuted },
        ]}
      >
        <Ionicons name="calendar-outline" size={20} color={colors.textSubtle} />
        <Text style={[styles.value, textDir(isRTL)]}>{valueLabel}</Text>
        <Ionicons
          name={props.expanded ? "chevron-up" : "chevron-down"}
          size={16}
          color={colors.textSubtle}
        />
      </Pressable>
      {props.expanded ? (
        <View style={styles.picker}>
          <CalendarDayPicker
            value={props.value}
            calendar={calendar}
            isRTL={isRTL}
            disabled={props.disabled}
            onChange={choose}
          />
          <View style={[styles.actions, rowDir(isRTL)]}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t("person.date.today")}
              accessibilityState={{ disabled: !!props.disabled }}
              disabled={props.disabled}
              onPress={() => choose(localDayStart(Date.now()))}
              style={styles.action}
            >
              <Text style={styles.actionText}>{t("person.date.today")}</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t("common.done")}
              accessibilityState={{ disabled: !!props.disabled }}
              disabled={props.disabled}
              onPress={toggle}
              style={styles.action}
            >
              <Text style={styles.actionText}>{t("common.done")}</Text>
            </Pressable>
          </View>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  label: {
    ...typography.bodySm,
    fontFamily: fonts.sansMedium,
    color: colors.textDefault,
    marginBottom: 8,
  },
  input: {
    minHeight: TOUCH_MIN,
    alignItems: "center",
    gap: 12,
    borderWidth: 1,
    borderColor: colors.borderDefault,
    borderRadius: radius.sm,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  value: { ...typography.label, flex: 1, color: colors.textEmphasis },
  picker: {
    marginTop: 8,
    padding: 8,
    borderWidth: 1,
    borderColor: colors.borderDefault,
    borderRadius: radius.sm,
  },
  actions: { alignItems: "center", justifyContent: "space-between", marginTop: 4 },
  action: {
    minHeight: TOUCH_MIN,
    minWidth: TOUCH_MIN,
    paddingHorizontal: 12,
    justifyContent: "center",
    alignItems: "center",
  },
  actionText: { ...typography.label, color: colors.actionPrimary },
  disabled: { opacity: 0.5 },
});
