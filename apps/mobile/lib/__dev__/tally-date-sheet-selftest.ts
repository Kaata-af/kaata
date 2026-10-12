import assert from "node:assert/strict";
import { compileUI, flattenStyle, jsx, nodes, uiHooks } from "./ui-fixture";
import type { Calendar } from "../calendar";
import { faDigits, formatCalendarDate } from "../jalali";
import * as dateFilter from "../tally-date-filter";
import {
  adjacentCalendarMonth,
  calendarMonthDays,
  customDateRange,
  datePresetRange,
  dateRangeBetween,
  type TallyDateRange,
} from "../tally-date-filter";

const now = new Date(2026, 7, 5, 12).getTime();
const keyedJSX = (type: any, props: any, key?: string | number) => ({ ...jsx(type, props), key });
for (const calendar of ["gregorian", "jalali", "qamari"] as Calendar[])
  for (const locale of ["en", "fa"] as const)
    for (const platform of ["ios", "android"] as const) {
      const hooks = uiHooks();
      let visible = true,
        range: TallyDateRange | null = null;
      const changes: (TallyDateRange | null)[] = [];
      const requests: any[] = [],
        dismisses: string[] = [];
      let throwNextPicker = false;
      let activeCalendar = calendar;
      const module = compileUI(
        "../../components/TallyDateFilterSheet",
        {
          react: hooks.react,
          "react/jsx-runtime": { jsx: keyedJSX, jsxs: keyedJSX, Fragment: "Fragment" },
          "@react-native-community/datetimepicker": {
            __esModule: true,
            default: "TimePicker",
            DateTimePickerAndroid: {
              open: (request: any) => {
                requests.push(request);
                if (throwNextPicker) {
                  throwNextPicker = false;
                  throw new Error("native activity unavailable");
                }
              },
              dismiss: async (mode: string) => {
                dismisses.push(mode);
              },
            },
          },
          "react-native": {
            Animated: { View: "AnimatedView" },
            Modal: "Modal",
            Platform: { OS: platform },
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
          "../lib/tally-date-filter": dateFilter,
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
            calendar: activeCalendar,
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
      const applyButton = () =>
        nodes(hooks.tree).find((node) => node.props.label === "person.date.apply")!;
      const clockValue = (field: "start" | "end") =>
        nodes(hooks.tree).find(
          (node) => node.props.accessibilityLabel === `person.date.${field}Time`,
        )!.props.accessibilityValue.text;
      const openClock = (field: "start" | "end") => {
        press(`person.date.${field}Time`);
        const native =
          platform === "android"
            ? requests.at(-1)
            : nodes(hooks.tree).find((node) => node.type === "TimePicker")!.props;
        assert.equal(native.mode, "time");
        if (platform === "android") assert.equal(native.is24Hour, true);
        return native;
      };
      const pickClock = (field: "start" | "end", hour: number, minute: number) => {
        openClock(field).onValueChange({}, new Date(1999, 11, 31, hour, minute, 43, 999));
        render();
        if (platform === "ios") {
          nodes(hooks.tree)
            .find((node) => node.props.label === "common.done")!
            .props.onPress();
          render();
        }
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
      let apply = applyButton();
      assert.equal(apply.props.disabled, true);
      const month = calendarMonthDays(now, calendar);
      const first = month[month.length - 1];
      press(formatCalendarDate(first, locale, calendar));
      apply = applyButton();
      assert.equal(apply.props.disabled, true, "one endpoint is not a complete range");
      press("person.date.previousMonth");
      const previous = calendarMonthDays(adjacentCalendarMonth(now, -1, calendar), calendar);
      const last = previous[previous.length - 2];
      press(formatCalendarDate(last, locale, calendar));
      apply = applyButton();
      assert.equal(apply.props.disabled, false);
      const day = nodes(hooks.tree).find(
        (node) => node.props.accessibilityLabel === formatCalendarDate(last, locale, calendar),
      )!;
      assert.ok(flattenStyle(day.props.style).minHeight >= 44, "calendar day keeps touch target");
      apply.props.onPress();
      render();
      assert.deepEqual(
        range,
        { ...dateRangeBetween(first, last), timePrecision: "minute" },
        "cross-month reverse selection includes both endpoints",
      );
      assert.equal(changes.length, 3, "month, clear and one explicit Apply only");
      assert.equal(hooks.tree, null);

      visible = true;
      render();
      press("person.date.custom");
      assert.equal(applyButton().props.disabled, false, "reopening retains the selected days");
      assert.equal(clockValue("start"), locale === "fa" ? "۰۰:۰۰" : "00:00");
      assert.equal(clockValue("end"), locale === "fa" ? "۲۳:۵۹" : "23:59");
      // The native time picker's unrelated date and seconds never replace grid days.
      pickClock("start", 10, 31);
      pickClock("end", 10, 30);
      press(formatCalendarDate(last, locale, calendar));
      press(formatCalendarDate(last, locale, calendar));
      assert.equal(
        applyButton().props.disabled,
        true,
        "same-day reverse clocks are not silently swapped",
      );
      assert.ok(nodes(hooks.tree).some((node) => node.props.accessibilityRole === "alert"));
      applyButton().props.onPress();
      assert.equal(changes.length, 3, "invalid Apply does not emit a range");
      pickClock("end", 10, 31);
      assert.equal(
        applyButton().props.disabled,
        false,
        "equal clocks include the complete selected minute",
      );
      applyButton().props.onPress();
      render();
      assert.deepEqual(range, customDateRange(last, last, 631, 631));
      const saved = changes.at(-1)!;
      assert.equal(saved.end - saved.start, 60_000);
      assert.equal(new Date(saved.start).getSeconds(), 0);
      assert.equal(new Date(saved.start).getMilliseconds(), 0);

      visible = true;
      render();
      press("person.date.custom");
      assert.equal(clockValue("start"), locale === "fa" ? "۱۰:۳۱" : "10:31");
      assert.equal(clockValue("end"), locale === "fa" ? "۱۰:۳۱" : "10:31");
      // Moving across months changes dates only, keeping the draft clocks.
      press("person.date.nextMonth");
      press(formatCalendarDate(first, locale, calendar));
      press("person.date.previousMonth");
      press(formatCalendarDate(last, locale, calendar));
      assert.equal(clockValue("start"), locale === "fa" ? "۱۰:۳۱" : "10:31");
      pickClock("start", 7, 5);
      press("common.cancel");
      assert.equal(changes.length, 4, "cancel does not apply draft days or clocks");
      visible = true;
      render();
      press("person.date.custom");
      assert.equal(
        clockValue("start"),
        locale === "fa" ? "۱۰:۳۱" : "10:31",
        "cancelled time is discarded",
      );

      const stale = openClock("start");
      const beforeRequests = requests.length;
      if (platform === "android") {
        press("person.date.endTime");
        assert.equal(requests.length, beforeRequests, "one native dialog at a time");
      }
      press("common.cancel");
      if (platform === "android") assert.ok(dismisses.includes("time"));
      visible = true;
      render();
      press("person.date.custom");
      stale.onValueChange({}, new Date(2000, 0, 15, 1, 2));
      render();
      assert.equal(
        clockValue("start"),
        locale === "fa" ? "۱۰:۳۱" : "10:31",
        "late picker after reopen cannot change new draft",
      );

      const changedCalendar = openClock("end");
      activeCalendar = calendar === "gregorian" ? "qamari" : "gregorian";
      render();
      press("person.date.custom");
      changedCalendar.onValueChange({}, new Date(2000, 0, 15, 22, 30));
      render();
      assert.equal(
        clockValue("end"),
        locale === "fa" ? "۱۰:۳۱" : "10:31",
        "calendar change invalidates old picker callback",
      );

      if (platform === "ios") {
        const firstWheel = openClock("start");
        const firstIdentity = (nodes(hooks.tree).find((node) => node.type === "TimePicker") as any)
          .key;
        const secondWheel = openClock("end");
        const secondIdentity = (nodes(hooks.tree).find((node) => node.type === "TimePicker") as any)
          .key;
        assert.notEqual(firstIdentity, undefined);
        assert.notEqual(
          firstIdentity,
          secondIdentity,
          "switching clocks remounts the native wheel with a new request key",
        );
        firstWheel.onValueChange({}, new Date(2000, 0, 15, 4, 5));
        render();
        assert.equal(clockValue("start"), locale === "fa" ? "۱۰:۳۱" : "10:31");
        assert.equal(clockValue("end"), locale === "fa" ? "۱۰:۳۱" : "10:31");
        secondWheel.onValueChange({}, new Date(2000, 0, 15, 10, 31));
        render();
      } else {
        const failed = openClock("start");
        failed.onError(new Error("native activity unavailable"));
        render();
        assert.ok(
          nodes(hooks.tree).some((node) => node.props.children === "person.date.timeUnavailable"),
        );
        failed.onValueChange({}, new Date(2000, 0, 15, 4, 5));
        render();
        assert.equal(
          clockValue("start"),
          locale === "fa" ? "۱۰:۳۱" : "10:31",
          "error invalidates picker selection",
        );
        const beforeRetry = requests.length;
        const retried = openClock("start");
        assert.equal(
          requests.length,
          beforeRetry + 1,
          "native error clears guard so the user can retry",
        );
        assert.equal(
          nodes(hooks.tree).some((node) => node.props.children === "person.date.timeUnavailable"),
          false,
        );
        failed.onError(new Error("late error"));
        render();
        const beforeOldErrorPress = requests.length;
        press("person.date.endTime");
        assert.equal(
          requests.length,
          beforeOldErrorPress,
          "old errors cannot clear the new request guard",
        );
        assert.equal(
          nodes(hooks.tree).some((node) => node.props.children === "person.date.timeUnavailable"),
          false,
        );
        retried.onValueChange({}, new Date(2000, 0, 15, 10, 31));
        render();
        throwNextPicker = true;
        openClock("start");
        assert.ok(
          nodes(hooks.tree).some((node) => node.props.children === "person.date.timeUnavailable"),
          "synchronous native failures are also retryable",
        );
        const beforeSynchronousRetry = requests.length;
        openClock("start").onDismiss();
        render();
        assert.equal(requests.length, beforeSynchronousRetry + 1);
      }

      const unmounted = openClock("start");
      hooks.unmount();
      unmounted.onValueChange({}, new Date(2000, 0, 15, 2, 5));
      if (platform === "android") unmounted.onError(new Error("late native error"));
      assert.equal(hooks.lateWrites, 0, "unmounted picker never writes state");
    }
console.log(
  "PASS: real date/time sheet, presets, inclusive boundaries, validation/reopen, request-keyed iOS wheels, retryable Android errors and stale native callbacks in EN/FA across all three calendars",
);
