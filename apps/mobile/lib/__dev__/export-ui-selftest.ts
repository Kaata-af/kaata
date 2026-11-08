import assert from "node:assert/strict";
import { compileUI, jsx, nodes, uiHooks } from "./ui-fixture";
import { exportPeriod } from "../export-period";
import { ExportScopeError } from "../export/options";
import { calendarDay, localDayStart, shiftLocalDay } from "../tally-date-filter";
import type { Calendar } from "../calendar";
import type { LocaleCode } from "../i18n";

// Presets use the chosen calendar, and the inclusive final day is represented
// by the next local midnight rather than a fixed 24-hour addition.
const feb = new Date(2024, 1, 18, 12).getTime();
assert.deepEqual(exportPeriod("month", feb, "gregorian", 0, 0), {
  startMs: new Date(2024, 1, 1).getTime(),
  endMs: new Date(2024, 2, 1).getTime(),
});
assert.deepEqual(exportPeriod("lastMonth", new Date(2025, 0, 8).getTime(), "gregorian", 0, 0), {
  startMs: new Date(2024, 11, 1).getTime(),
  endMs: new Date(2025, 0, 1).getTime(),
});
for (const calendar of ["jalali", "qamari"] as const) {
  const reference = new Date(2026, 3, 10).getTime();
  const period = exportPeriod("month", reference, calendar, 0, 0)!;
  assert.equal(calendarDay(period.startMs, calendar).day, 1);
  assert.equal(calendarDay(period.endMs, calendar).day, 1);
  assert.equal(calendarDay(period.startMs, calendar).month, calendarDay(reference, calendar).month);
  const previous = exportPeriod("lastMonth", reference, calendar, 0, 0)!;
  assert.equal(previous.endMs, period.startMs);
}
assert.equal(exportPeriod("all", feb, "gregorian", 0, 0), undefined);
const single = new Date(2026, 9, 5, 18).getTime();
assert.deepEqual(exportPeriod("custom", feb, "gregorian", single, single), {
  startMs: localDayStart(single),
  endMs: shiftLocalDay(single, 1),
});
assert.throws(() => exportPeriod("custom", feb, "gregorian", single, single - 86_400_000));

for (const locale of ["en", "fa", "ps"] as LocaleCode[]) {
  const hooks = uiHooks();
  const calendar: Calendar = locale === "en" ? "gregorian" : "jalali";
  const copy = compileUI("../export-copy", {
    "./i18n": { getLocale: () => locale },
  }) as typeof import("../export-copy");
  const feedback = compileUI("../export-feedback", {
    "./export/options": { ExportScopeError },
    "./export-copy": copy,
  }) as typeof import("../export-feedback");
  const scopeError = feedback.exportFailureMessage(
    new ExportScopeError("beforeSharedOpening"),
    "generic",
  );
  assert.ok(scopeError.includes(copy.tExport("all")));
  assert.ok(scopeError.includes(copy.tExport("detailed")));
  assert.ok(!scopeError.includes("{all}") && !scopeError.includes("{detailed}"));
  assert.equal(
    feedback.exportFailureMessage(new Error("private diagnostic path"), "generic"),
    "generic",
  );
  const { ExportSheet } = compileUI("../../components/ExportSheet", {
    react: hooks.react,
    "react/jsx-runtime": { jsx, jsxs: jsx },
    "@expo/vector-icons": { Ionicons: "Ionicons" },
    "react-native": {
      Pressable: "Pressable",
      Switch: "Switch",
      Text: "Text",
      View: "View",
      StyleSheet: { create: (s: unknown) => s },
    },
    "../lib/calendar": { useCalendar: () => calendar },
    "../lib/colors": { colors: {} },
    "../lib/direction": {
      rowDir: () => ({}),
      textDir: () => ({}),
      useIsRTL: () => locale !== "en",
    },
    "../lib/export-copy": copy,
    "../lib/export-period": { exportPeriod },
    "../lib/fonts": { fonts: {} },
    "../lib/i18n": { getLocale: () => locale, t: (key: string) => key },
    "../lib/jalali": require("../jalali"),
    "../lib/tally-date-filter": require("../tally-date-filter"),
    "../lib/tokens": { radius: {}, TOUCH_MIN: 44 },
    "./BottomSheet": { BottomSheet: "BottomSheet" },
    "./CalendarDayPicker": { CalendarDayPicker: "CalendarDayPicker" },
  }) as typeof import("../../components/ExportSheet");
  const sent: any[] = [];
  let props = {
    visible: true,
    title: "Export",
    contextKey: "a:kaata:customer",
    kind: "person" as const,
    onDismiss: () => {},
    onExport: (...args: any[]) => sent.push(args),
  };
  const render = () => hooks.render(() => ExportSheet(props));
  render();
  const byLabel = (label: string) =>
    nodes(hooks.tree).find((n) => n.props.accessibilityLabel === label)!;
  const tap = (label: string) => {
    byLabel(label).props.onPress();
    render();
  };
  const action = (index: number) => hooks.tree.props.actions[index];

  assert.equal(
    hooks.tree.type,
    "BottomSheet",
    "Native dialogs use the existing deferred sheet handoff",
  );
  assert.equal(hooks.tree.props.actions.length, 2);
  assert.equal(action(0).label, "export.action.sharePdf");
  action(0).onPress();
  assert.deepEqual(sent.pop(), [
    "pdf",
    "share",
    { detail: "standard", period: undefined, includeNotes: false },
  ]);

  tap(copy.tExport("csv"));
  tap(copy.tExport("lastMonth"));
  tap(copy.tExport("more"));
  byLabel(copy.tExport("includeNotes")).props.onValueChange(true);
  byLabel(copy.tExport("detailed")).props.onValueChange(true);
  render();
  assert.equal(action(1).label, "export.action.saveCsv");
  action(1).onPress();
  const saved = sent.pop();
  assert.equal(saved[0], "csv");
  assert.equal(saved[1], "save");
  assert.equal(saved[2].includeNotes, true);
  assert.equal(saved[2].detail, "detailed");
  assert.equal(calendarDay(saved[2].period.startMs, calendar).day, 1);
  assert.equal(calendarDay(saved[2].period.endMs, calendar).day, 1);

  tap(copy.tExport("custom"));
  const picker = () => nodes(hooks.tree).find((n) => n.type === "CalendarDayPicker")!;
  picker().props.onChange(new Date(2026, 4, 12).getTime());
  render();
  picker().props.onChange(new Date(2026, 4, 11).getTime());
  render();
  assert.ok(
    action(0).disabled && action(1).disabled,
    "Reversed ranges cannot create misleading statements",
  );
  assert.ok(nodes(hooks.tree).some((n) => n.props.accessibilityRole === "alert"));
  tap(copy.tExport("through"));
  picker().props.onChange(new Date(2026, 4, 12).getTime());
  render();
  assert.equal(action(0).disabled, false);
  action(0).onPress();
  assert.deepEqual(sent.pop()[2].period, {
    startMs: new Date(2026, 4, 12).getTime(),
    endMs: new Date(2026, 4, 13).getTime(),
  });

  const oldAction = action(0).onPress;
  props = { ...props, contextKey: "a:different:customer" };
  render();
  oldAction();
  assert.equal(
    sent.length,
    0,
    "A deferred action cannot export the previous account/Kaata/customer",
  );
  action(0).onPress();
  assert.deepEqual(sent.pop(), [
    "pdf",
    "share",
    { detail: "standard", period: undefined, includeNotes: false },
  ]);

  tap(copy.tExport("more"));
  byLabel(copy.tExport("includeNotes")).props.onValueChange(true);
  render();
  props = { ...props, visible: false };
  render();
  props = { ...props, visible: true };
  render();
  action(0).onPress();
  assert.equal(
    sent.pop()[2].includeNotes,
    false,
    "Internal-note sharing requires a fresh opt-in each opening",
  );
  hooks.unmount();
}
console.log(
  "PASS export chooser: calendar periods, format/destination, custom range validation, internal-note opt-in and context-safe delayed actions in English/Dari/Pashto",
);
