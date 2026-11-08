import { Ionicons } from "@expo/vector-icons";
import { useEffect, useRef, useState } from "react";
import { Pressable, StyleSheet, Switch, Text, View } from "react-native";
import { useCalendar } from "../lib/calendar";
import { colors } from "../lib/colors";
import { rowDir, textDir, useIsRTL } from "../lib/direction";
import type { ExportDestination, ExportFormat, ExportOptions } from "../lib/export";
import { tExport } from "../lib/export-copy";
import { exportPeriod, type ExportPeriodChoice } from "../lib/export-period";
import { fonts } from "../lib/fonts";
import { getLocale, t } from "../lib/i18n";
import { formatCalendarDate } from "../lib/jalali";
import { datePresetRange, localDayStart } from "../lib/tally-date-filter";
import { radius, TOUCH_MIN } from "../lib/tokens";
import { BottomSheet } from "./BottomSheet";
import { CalendarDayPicker } from "./CalendarDayPicker";

/** One chooser in the existing export entry point. Native share/save actions
 * run through BottomSheet's delayed action handoff after its modal closes. */
export function ExportSheet(props: {
  visible: boolean;
  contextKey: string;
  title: string;
  kind: "person" | "vault";
  onDismiss: () => void;
  onExport: (format: ExportFormat, destination: ExportDestination, options: ExportOptions) => void;
}) {
  const isRTL = useIsRTL();
  const calendar = useCalendar();
  const [format, setFormat] = useState<ExportFormat>("pdf");
  const [period, setPeriod] = useState<ExportPeriodChoice>("all");
  const [now, setNow] = useState(Date.now);
  const [first, setFirst] = useState(() => localDayStart(Date.now()));
  const [last, setLast] = useState(() => localDayStart(Date.now()));
  const [dateField, setDateField] = useState<"first" | "last" | null>(null);
  const [more, setMore] = useState(false);
  const [detailed, setDetailed] = useState(false);
  const [includeNotes, setIncludeNotes] = useState(false);
  const currentContext = useRef(props.contextKey);
  currentContext.current = props.contextKey;
  useEffect(() => {
    if (!props.visible) return;
    const openedAt = Date.now();
    setNow(openedAt);
    setFormat("pdf");
    setPeriod("all");
    setFirst(datePresetRange("month", openedAt, calendar).start);
    setLast(localDayStart(openedAt));
    setDateField(null);
    setMore(false);
    // Sharing internal notes is an explicit decision for each new export.
    setIncludeNotes(false);
    setDetailed(false);
  }, [props.visible, props.contextKey, calendar]);

  const invalid = period === "custom" && last < first;
  const selectedPeriod = invalid ? undefined : exportPeriod(period, now, calendar, first, last);
  const options: ExportOptions = {
    detail: detailed ? "detailed" : "standard",
    period: selectedPeriod,
    includeNotes,
  };
  const send = (destination: ExportDestination) => {
    // The action is deferred until the sheet closes. Discard it if the
    // account, Kaata or customer changed during that handoff.
    if (currentContext.current !== props.contextKey) return;
    props.onExport(format, destination, options);
  };
  const selectedCount = Number(detailed) + Number(includeNotes);
  const dateLabel = (ms: number) => formatCalendarDate(ms, getLocale(), calendar);
  const choice = (key: string, label: string, selected: boolean, onPress: () => void) => (
    <Pressable
      key={key}
      accessibilityRole="radio"
      accessibilityLabel={label}
      accessibilityState={{ checked: selected }}
      onPress={onPress}
      style={({ pressed }) => [
        styles.choice,
        selected && styles.choiceSelected,
        pressed && styles.pressed,
      ]}
    >
      <Text style={[styles.choiceLabel, textDir(isRTL), selected && styles.choiceSelectedLabel]}>
        {label}
      </Text>
    </Pressable>
  );
  const toggle = (
    label: string,
    hint: string,
    value: boolean,
    onChange: (value: boolean) => void,
  ) => (
    <View style={[styles.toggleRow, rowDir(isRTL)]}>
      <View style={styles.toggleCopy}>
        <Text style={[styles.label, textDir(isRTL)]}>{label}</Text>
        <Text style={[styles.hint, textDir(isRTL)]}>{hint}</Text>
      </View>
      <Switch
        accessibilityLabel={label}
        accessibilityHint={hint}
        value={value}
        onValueChange={onChange}
        trackColor={{ false: colors.borderEmphasis, true: colors.actionPrimary }}
      />
    </View>
  );

  return (
    <BottomSheet
      visible={props.visible}
      title={props.title}
      onDismiss={props.onDismiss}
      actions={[
        {
          label: t(format === "pdf" ? "export.action.sharePdf" : "export.action.shareCsv"),
          icon: "share-outline",
          disabled: invalid,
          onPress: () => send("share"),
        },
        {
          label: t(format === "pdf" ? "export.action.savePdf" : "export.action.saveCsv"),
          icon: "download-outline",
          disabled: invalid,
          onPress: () => send("save"),
        },
      ]}
    >
      <View style={styles.content}>
        <Text style={[styles.heading, textDir(isRTL)]}>{tExport("format")}</Text>
        <View style={[styles.choices, rowDir(isRTL)]}>
          {choice("pdf", tExport("pdf"), format === "pdf", () => setFormat("pdf"))}
          {choice("csv", tExport("csv"), format === "csv", () => setFormat("csv"))}
        </View>
        <Text style={[styles.hint, textDir(isRTL)]}>
          {tExport(format === "pdf" ? "pdfHint" : "csvHint")}
        </Text>

        <Text style={[styles.heading, styles.periodHeading, textDir(isRTL)]}>
          {tExport("period")}
        </Text>
        <View style={[styles.choices, rowDir(isRTL)]}>
          {(["all", "month", "lastMonth", "custom"] as const).map((value) =>
            choice(value, tExport(value), period === value, () => {
              setPeriod(value);
              setDateField(value === "custom" ? "first" : null);
            }),
          )}
        </View>
        {period === "custom" ? (
          <>
            <View style={[styles.dateFields, rowDir(isRTL)]}>
              {(["first", "last"] as const).map((field) => (
                <Pressable
                  key={field}
                  accessibilityRole="button"
                  accessibilityLabel={tExport(field === "first" ? "from" : "through")}
                  accessibilityValue={{ text: dateLabel(field === "first" ? first : last) }}
                  accessibilityState={{ expanded: dateField === field }}
                  onPress={() => setDateField(dateField === field ? null : field)}
                  style={[styles.dateField, dateField === field && styles.dateActive]}
                >
                  <Text style={[styles.hint, textDir(isRTL)]}>
                    {tExport(field === "first" ? "from" : "through")}
                  </Text>
                  <Text style={[styles.label, textDir(isRTL)]}>
                    {dateLabel(field === "first" ? first : last)}
                  </Text>
                </Pressable>
              ))}
            </View>
            {dateField ? (
              <CalendarDayPicker
                value={dateField === "first" ? first : last}
                calendar={calendar}
                isRTL={isRTL}
                onChange={(day) => {
                  if (dateField === "first") {
                    setFirst(day);
                    setLast(day);
                    setDateField("last");
                  } else {
                    setLast(day);
                    setDateField(null);
                  }
                }}
              />
            ) : null}
          </>
        ) : selectedPeriod ? (
          <Text
            style={[styles.hint, textDir(isRTL)]}
          >{`${dateLabel(selectedPeriod.startMs!)} – ${dateLabel(selectedPeriod.endMs! - 1)}`}</Text>
        ) : null}
        {invalid ? (
          <Text accessibilityRole="alert" style={[styles.invalid, textDir(isRTL)]}>
            {tExport("invalidDates")}
          </Text>
        ) : null}

        <Pressable
          accessibilityRole="button"
          accessibilityLabel={tExport("more")}
          accessibilityState={{ expanded: more }}
          onPress={() => setMore(!more)}
          style={[styles.more, rowDir(isRTL)]}
        >
          <Text style={[styles.label, styles.moreLabel, textDir(isRTL)]}>{tExport("more")}</Text>
          {selectedCount ? (
            <Text style={styles.hint}>{tExport("selectedOptions", { count: selectedCount })}</Text>
          ) : null}
          <Ionicons
            name={more ? "chevron-up" : "chevron-down"}
            size={18}
            color={colors.textSubtle}
          />
        </Pressable>
        {more ? (
          <View>
            {toggle(
              tExport("detailed"),
              tExport(props.kind === "vault" ? "detailedReportHint" : "detailedHint"),
              detailed,
              setDetailed,
            )}
            {toggle(tExport("includeNotes"), tExport("notesHint"), includeNotes, setIncludeNotes)}
          </View>
        ) : null}
        <Text style={[styles.scope, textDir(isRTL)]}>
          {tExport(props.kind === "person" ? "allCurrencies" : "reportScope")}
        </Text>
      </View>
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  content: { paddingHorizontal: 20, paddingBottom: 8 },
  heading: {
    fontFamily: fonts.sansSemi,
    fontSize: 13,
    color: colors.textEmphasis,
    marginBottom: 8,
  },
  periodHeading: { marginTop: 18 },
  choices: { flexWrap: "wrap", gap: 8 },
  choice: {
    minHeight: TOUCH_MIN,
    justifyContent: "center",
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderWidth: 1,
    borderColor: colors.borderDefault,
    borderRadius: radius.md,
  },
  choiceSelected: { backgroundColor: colors.actionPrimary, borderColor: colors.actionPrimary },
  choiceLabel: { color: colors.textDefault, fontFamily: fonts.sansMedium, fontSize: 13 },
  choiceSelectedLabel: { color: colors.textInverted },
  pressed: { opacity: 0.7 },
  label: { color: colors.textEmphasis, fontFamily: fonts.sansMedium, fontSize: 14 },
  hint: {
    color: colors.textSubtle,
    fontFamily: fonts.sansRegular,
    fontSize: 12,
    lineHeight: 18,
    marginTop: 5,
  },
  scope: {
    color: colors.textSubtle,
    fontFamily: fonts.sansRegular,
    fontSize: 12,
    lineHeight: 18,
    marginTop: 6,
  },
  dateFields: { gap: 10, marginTop: 10 },
  dateField: {
    flex: 1,
    minHeight: TOUCH_MIN,
    padding: 10,
    borderWidth: 1,
    borderColor: colors.borderDefault,
    borderRadius: radius.md,
  },
  dateActive: { borderColor: colors.textEmphasis },
  more: {
    minHeight: TOUCH_MIN,
    alignItems: "center",
    gap: 8,
    marginTop: 12,
    borderTopWidth: 1,
    borderTopColor: colors.borderSubtle,
  },
  moreLabel: { flex: 1 },
  toggleRow: { gap: 12, alignItems: "center", paddingVertical: 10 },
  toggleCopy: { flex: 1 },
  invalid: { color: colors.danger, fontFamily: fonts.sansRegular, fontSize: 12, marginTop: 8 },
});
