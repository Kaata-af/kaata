import assert from "node:assert/strict";
import { compileUI, flattenStyle, jsx, nodes, uiHooks } from "./ui-fixture";
import type { Calendar } from "../calendar";
import { faDigits, formatCalendarDate } from "../jalali";
import {
  adjacentCalendarMonth,
  calendarDay,
  calendarMonthDays,
  datePresetRange,
  dateRangeBetween,
  localDayStart,
  shiftLocalDay,
  type TallyDateRange,
} from "../tally-date-filter";

const now = new Date(2026, 7, 5, 12).getTime();
for (const calendar of ["gregorian", "jalali", "qamari"] as Calendar[])
  for (const locale of ["en", "fa"] as const) {
    const hooks = uiHooks();
    let visible = true,
      range: TallyDateRange | null = null;
    const changes: (TallyDateRange | null)[] = [];
    const module = compileUI(
      "../../components/TallyDateFilterSheet",
      {
        react: hooks.react,
        "react/jsx-runtime": { jsx, jsxs: jsx, Fragment: "Fragment" },
        "react-native": {
          Animated: { View: "AnimatedView" },
          Modal: "Modal",
          Pressable: "Pressable",
          ScrollView: "ScrollView",
          Text: "Text",
          View: "View",
          useWindowDimensions: () => ({ height: 844 }),
          StyleSheet: { absoluteFill: {}, hairlineWidth: 1, create: (style: any) => style },
        },
        "react-native-safe-area-context": { SafeAreaView: "Safe" },
        "@expo/vector-icons": { Ionicons: "Icon" },
        "./Button": { Button: "Button" },
        "./SheetBackdrop": { SheetBackdrop: "SheetBackdrop" },
        "../lib/colors": require("../colors"),
        "../lib/direction": {
          rowDir: (rtl: boolean) => ({ flexDirection: rtl ? "row-reverse" : "row" }),
          textDir: (rtl: boolean) => ({ textAlign: rtl ? "right" : "left" }),
        },
        "../lib/i18n": { getLocale: () => locale, t: (key: string) => key },
        "../lib/jalali": { faDigits, formatCalendarDate },
        "../lib/fonts": { fonts: {} },
        "../lib/tally-date-filter": {
          adjacentCalendarMonth,
          calendarDay,
          calendarMonthDays,
          datePresetRange,
          dateRangeBetween,
          localDayStart,
          shiftLocalDay,
        },
        "../lib/use-overlay-animation": {
          useOverlayAnimation: (open: boolean) => ({ rendered: open, opacity: 1, position: 0 }),
        },
        "../lib/tokens": {
          radius: { sm: 8, sheet: 18, grabber: 2 },
          TOUCH_MIN: 44,
          typography: {},
        },
      },
      {
        Date: class extends Date {
          static now() {
            return now;
          }
        },
      },
    );
    const render = () =>
      hooks.render(() =>
        module.TallyDateFilterSheet({
          visible,
          range,
          calendar,
          isRTL: locale === "fa",
          onChange: (value: TallyDateRange | null) => {
            changes.push(value);
            range = value;
          },
          onDismiss: () => {
            visible = false;
          },
        }),
      );
    const words = (node: any): string =>
      Array.isArray(node)
        ? node.map(words).join("")
        : typeof node === "string"
          ? node
          : node?.props
            ? words(node.props.children)
            : "";
    const press = (label: string) => {
      const button = nodes(hooks.tree).find(
        (node) =>
          node.type === "Pressable" &&
          (node.props.accessibilityLabel === label || words(node.props.children) === label),
      )!;
      assert.ok(button, "missing " + label);
      button.props.onPress();
      render();
    };
    render();
    assert.equal(
      nodes(hooks.tree).some((node) => node.type === "Button"),
      false,
      "calendar grid stays behind Custom",
    );
    press("person.date.month");
    assert.deepEqual(
      range,
      datePresetRange("month", now, calendar),
      "preset follows selected calendar month",
    );
    assert.equal(hooks.tree, null);
    visible = true;
    render();
    press("person.date.all");
    assert.equal(range, null);
    visible = true;
    render();
    press("person.date.custom");
    let apply = nodes(hooks.tree).find((node) => node.type === "Button")!;
    assert.equal(apply.props.disabled, true);
    const month = calendarMonthDays(now, calendar);
    const first = month[month.length - 1];
    press(formatCalendarDate(first, locale, calendar));
    apply = nodes(hooks.tree).find((node) => node.type === "Button")!;
    assert.equal(apply.props.disabled, true, "one endpoint is not a complete range");
    press("person.date.previousMonth");
    const previous = calendarMonthDays(adjacentCalendarMonth(now, -1, calendar), calendar);
    const last = previous[previous.length - 2];
    press(formatCalendarDate(last, locale, calendar));
    apply = nodes(hooks.tree).find((node) => node.type === "Button")!;
    assert.equal(apply.props.disabled, false);
    const day = nodes(hooks.tree).find(
      (node) => node.props.accessibilityLabel === formatCalendarDate(last, locale, calendar),
    )!;
    assert.ok(flattenStyle(day.props.style).minHeight >= 44, "calendar day keeps touch target");
    apply.props.onPress();
    render();
    assert.deepEqual(
      range,
      dateRangeBetween(first, last),
      "cross-month reverse selection includes both endpoints",
    );
    assert.equal(changes.length, 3, "month, clear and one explicit Apply only");
    assert.equal(hooks.tree, null);
    hooks.unmount();
  }
console.log(
  "PASS: real date sheet presets, hidden/custom calendar, complete-range Apply, cross-month reverse selection, touch targets and dismiss in EN/FA across all three calendars",
);
