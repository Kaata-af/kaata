import { Ionicons } from "@expo/vector-icons";
import { useEffect, useRef } from "react";
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useCalendar } from "../lib/calendar";
import { colors } from "../lib/colors";
import { rowDir, textDir, useIsRTL } from "../lib/direction";
import { fonts } from "../lib/fonts";
import { getLocale, t } from "../lib/i18n";
import { formatCalendarDate } from "../lib/jalali";
import { localDayStart } from "../lib/tally-date-filter";
import { radius, TOUCH_MIN, typography } from "../lib/tokens";
import { CalendarDayPicker } from "./CalendarDayPicker";

/** The parent owns the open state; the calendar floats above the form. */
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
  const latest = useRef(props);
  latest.current = props;
  const mounted = useRef(true);
  const closing = useRef(false);
  const generation = useRef(0);
  const previousExpanded = useRef(props.expanded);
  if (previousExpanded.current !== props.expanded) {
    previousExpanded.current = props.expanded;
    if (props.expanded) generation.current++;
    closing.current = false;
  }
  const request = generation.current;
  useEffect(() => {
    mounted.current = true;
    closing.current = false;
    return () => {
      mounted.current = false;
      closing.current = true;
    };
  }, []);
  const dismiss = () => {
    if (
      !mounted.current ||
      request !== generation.current ||
      closing.current ||
      !latest.current.expanded
    )
      return;
    closing.current = true;
    latest.current.onToggle();
  };
  const toggle = () => {
    if (!mounted.current || request !== generation.current || latest.current.disabled) return;
    if (latest.current.expanded) dismiss();
    else latest.current.onToggle();
  };
  const choose = (day: number) => {
    if (
      !mounted.current ||
      request !== generation.current ||
      closing.current ||
      !latest.current.expanded ||
      latest.current.disabled
    )
      return;
    closing.current = true;
    latest.current.onChange(day);
    latest.current.onToggle();
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
        <Modal
          visible
          transparent
          animationType="fade"
          presentationStyle="overFullScreen"
          statusBarTranslucent
          navigationBarTranslucent
          onRequestClose={dismiss}
        >
          <Pressable
            style={styles.backdrop}
            accessibilityRole="button"
            accessibilityLabel={t("common.close")}
            onPress={dismiss}
          />
          <SafeAreaView
            edges={["top", "bottom", "left", "right"]}
            style={styles.overlay}
            pointerEvents="box-none"
          >
            <View style={styles.popup} accessibilityViewIsModal onAccessibilityEscape={dismiss}>
              <View style={[styles.popupHeader, rowDir(isRTL)]}>
                <View style={styles.headerSide} pointerEvents="none" accessible={false} />
                <Text style={[textDir(isRTL), styles.popupTitle]} accessibilityRole="header">
                  {label}
                </Text>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={t("common.close")}
                  onPress={dismiss}
                  style={styles.headerSide}
                >
                  <Ionicons name="close" size={22} color={colors.textDefault} />
                </Pressable>
              </View>
              <ScrollView
                style={styles.popupScroll}
                contentContainerStyle={styles.picker}
                keyboardShouldPersistTaps="handled"
                bounces={false}
              >
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
              </ScrollView>
            </View>
          </SafeAreaView>
        </Modal>
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
  backdrop: {
    position: "absolute",
    left: 0,
    right: 0,
    top: 0,
    bottom: 0,
    backgroundColor: "rgba(0, 0, 0, 0.28)",
  },
  overlay: { flex: 1, alignItems: "center", justifyContent: "center", padding: 16 },
  popup: {
    width: "100%",
    maxWidth: 400,
    maxHeight: "100%",
    flexShrink: 1,
    backgroundColor: colors.bgDefault,
    borderWidth: 1,
    borderColor: colors.borderDefault,
    borderRadius: radius.sheet,
    overflow: "hidden",
  },
  popupHeader: {
    alignItems: "center",
    paddingHorizontal: 8,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderSubtle,
  },
  popupTitle: {
    ...typography.label,
    flex: 1,
    minWidth: 0,
    textAlign: "center",
    color: colors.textEmphasis,
  },
  headerSide: {
    width: TOUCH_MIN,
    minHeight: TOUCH_MIN,
    minWidth: TOUCH_MIN,
    flexShrink: 0,
    alignItems: "center",
    justifyContent: "center",
  },
  popupScroll: { flexShrink: 1 },
  picker: { padding: 8 },
  actions: { alignItems: "center", gap: 8, marginTop: 4 },
  action: {
    flex: 1,
    minHeight: TOUCH_MIN,
    minWidth: TOUCH_MIN,
    paddingHorizontal: 12,
    paddingVertical: 8,
    justifyContent: "center",
    alignItems: "center",
  },
  actionText: {
    ...typography.label,
    maxWidth: "100%",
    textAlign: "center",
    color: colors.actionPrimary,
  },
  disabled: { opacity: 0.5 },
});
