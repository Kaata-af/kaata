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
  for (const locale of ["en", "fa", "ps"] as const)
    for (const platform of ["ios", "android"] as const) {
      const hooks = uiHooks();
      let visible = true,
        range: TallyDateRange | null = null;
      const changes: (TallyDateRange | null)[] = [];
      const requests: any[] = [],
        dismisses: string[] = [];
      let throwNextPicker = false;
      let activeCalendar = calendar;
      let inline = false;
      let contextKey = "account:vault:person";
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
          "./SheetHandle": { SheetHandle: "SheetHandle" },
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
          "../lib/use-sheet-drag": {
            useSheetDrag: (_visible: boolean, entrance: unknown, onDismiss: () => void) => ({
              translateY: entrance,
              panHandlers: {},
              dismiss: onDismiss,
            }),
          },
          "../lib/tokens": {
            radius: { sm: 8, md: 12, lg: 16, sheet: 18, grabber: 2, pill: 999 },
            space: { sm: 8, md: 12, lg: 16 },
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
            inline,
            contextKey,
            range,
            calendar: activeCalendar,
            isRTL: locale !== "en",
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
      assert.ok(
        nodes(hooks.tree).some(
          (node) =>
            node.type === "View" && flattenStyle(node.props.style)?.paddingHorizontal === 20,
        ),
        "standalone sheet retains its own 20px gutter",
      );
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
      // Audit #31: the applied choice is marked when the sheet reopens.
      const choiceRow = (label: string) =>
        nodes(hooks.tree).find(
          (node) => node.type === "Pressable" && words(node.props.children) === label,
        )!;
      assert.equal(choiceRow("person.date.month").props.accessibilityState.selected, true);
      assert.equal(choiceRow("person.date.all").props.accessibilityState.selected, false);
      press("person.date.all");
      assert.equal(range, null);
      visible = true;
      render();
      press("person.date.custom");
      const weekdays = nodes(hooks.tree).filter(
        (node) =>
          node.type === "Text" &&
          typeof node.props.children === "string" &&
          node.props.children.startsWith("person.date.weekday."),
      );
      assert.equal(
        weekdays[0]?.props.children,
        locale !== "en" || calendar !== "gregorian"
          ? "person.date.weekday.6"
          : "person.date.weekday.1",
        "Shamsi and Qamari weeks start on Saturday in either language",
      );
      const todayCell = nodes(hooks.tree).find(
        (node) =>
          node.props.accessibilityLabel ===
          formatCalendarDate(dateFilter.localDayStart(now), locale, calendar),
      );
      assert.equal(flattenStyle(todayCell!.props.style).borderWidth, 1, "today is marked");
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
      assert.equal(clockValue("start"), locale !== "en" ? "۰۰:۰۰" : "00:00");
      assert.equal(clockValue("end"), locale !== "en" ? "۲۳:۵۹" : "23:59");
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
      assert.equal(clockValue("start"), locale !== "en" ? "۱۰:۳۱" : "10:31");
      assert.equal(clockValue("end"), locale !== "en" ? "۱۰:۳۱" : "10:31");
      // Moving across months changes dates only, keeping the draft clocks.
      press("person.date.nextMonth");
      press(formatCalendarDate(first, locale, calendar));
      press("person.date.previousMonth");
      press(formatCalendarDate(last, locale, calendar));
      assert.equal(clockValue("start"), locale !== "en" ? "۱۰:۳۱" : "10:31");
      pickClock("start", 7, 5);
      press("common.cancel");
      assert.equal(changes.length, 4, "cancel does not apply draft days or clocks");
      visible = true;
      render();
      press("person.date.custom");
      assert.equal(
        clockValue("start"),
        locale !== "en" ? "۱۰:۳۱" : "10:31",
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
        locale !== "en" ? "۱۰:۳۱" : "10:31",
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
        locale !== "en" ? "۱۰:۳۱" : "10:31",
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
        assert.equal(clockValue("start"), locale !== "en" ? "۱۰:۳۱" : "10:31");
        assert.equal(clockValue("end"), locale !== "en" ? "۱۰:۳۱" : "10:31");
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
          locale !== "en" ? "۱۰:۳۱" : "10:31",
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

      // Search embeds exactly the same controls without another native Modal.
      visible = false;
      render();
      inline = true;
      visible = true;
      render();
      assert.equal(
        nodes(hooks.tree).some((node) => node.type === "Modal"),
        false,
      );
      assert.equal(
        nodes(hooks.tree).some((node) => node.type === "ScrollView"),
        false,
        "inline filters use only the parent editor's scroll area",
      );
      assert.equal(
        flattenStyle(nodes(hooks.tree)[0].props.style).paddingHorizontal,
        16,
        "inline date filters own one ledger gutter",
      );
      const inlineChoices = nodes(hooks.tree).filter(
        (node) => node.props.accessibilityRole === "radio",
      );
      assert.equal(inlineChoices.length, 6, "all presets remain available as wrapping choices");
      assert.equal(
        inlineChoices.filter((node) => node.props.accessibilityState.checked).length,
        1,
        "the applied range is announced as the selected choice",
      );
      for (const node of inlineChoices) {
        const style = flattenStyle(node.props.style({ pressed: false }));
        assert.ok(style.minHeight >= 44, "preset cards retain comfortable touch targets");
        assert.equal(style.maxWidth, "100%", "long labels fit the editor width");
        assert.equal(style.borderRadius, 12, "choices follow the shared rounded card design");
        assert.equal(style.flexDirection, locale !== "en" ? "row-reverse" : "row");
      }
      press("person.date.custom");
      const beforeBackClock = clockValue("start");
      const backedOutPicker = openClock("start");
      press("common.back");
      assert.equal(
        nodes(hooks.tree).filter((node) => node.props.accessibilityRole === "radio").length,
        6,
        "custom calendar returns to presets without closing search filters",
      );
      backedOutPicker.onValueChange({}, new Date(2000, 0, 15, 3, 4));
      render();
      press("person.date.custom");
      assert.equal(
        clockValue("start"),
        beforeBackClock,
        "leaving custom range cancels its native picker callbacks",
      );
      const abandonedStart = clockValue("start");
      const abandonedScope = openClock("start");
      contextKey = "other-account:other-vault:person";
      render();
      const beforeAbandoned = changes.length;
      abandonedScope.onValueChange({}, new Date(2000, 0, 15, 1, 1));
      render();
      assert.equal(
        changes.length,
        beforeAbandoned,
        "departed native picker cannot commit another search scope",
      );
      press("person.date.custom");
      assert.equal(
        clockValue("start"),
        abandonedStart,
        "a stale wheel cannot alter the next scope's draft",
      );
      const unmounted = openClock("start");
      hooks.unmount();
      unmounted.onValueChange({}, new Date(2000, 0, 15, 2, 5));
      if (platform === "android") unmounted.onError(new Error("late native error"));
      assert.equal(hooks.lateWrites, 0, "unmounted picker never writes state");
    }
// The reminder editor's one-off date grid (audit #25): the same month helpers,
// one day, nothing before the minimum, in the app's calendar and digits.
for (const calendar of ["gregorian", "jalali", "qamari"] as Calendar[])
  for (const locale of ["en", "fa", "ps"] as const) {
    const hooks = uiHooks();
    const picks: number[] = [];
    let value = now;
    const { CalendarDayPicker } = compileUI(
      "../../components/CalendarDayPicker",
      {
        react: hooks.react,
        "react/jsx-runtime": { jsx: keyedJSX, jsxs: keyedJSX, Fragment: "Fragment" },
        "react-native": {
          Pressable: "Pressable",
          Text: "Text",
          View: "View",
          StyleSheet: { hairlineWidth: 1, create: (style: any) => style },
        },
        "@expo/vector-icons": { Ionicons: "Icon" },
        "../lib/colors": require("../colors"),
        "../lib/direction": {
          rowDir: (rtl: boolean) => ({ flexDirection: rtl ? "row-reverse" : "row" }),
        },
        "../lib/fonts": { fonts: {} },
        "../lib/i18n": { getLocale: () => locale, t: (key: string) => key },
        "../lib/jalali": { faDigits, formatCalendarDate },
        "../lib/tally-date-filter": dateFilter,
        "../lib/tokens": { radius: { sm: 8 }, TOUCH_MIN: 44, typography: {} },
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
        CalendarDayPicker({
          value,
          calendar,
          isRTL: locale !== "en",
          minimum: now,
          onChange: (day: number) => {
            picks.push(day);
            value = day;
          },
        }),
      );
    render();
    const control = (name: string) =>
      nodes(hooks.tree).find((n: any) => n.props?.accessibilityLabel === name)!;
    const dayButtons = () =>
      nodes(hooks.tree).filter(
        (n: any) =>
          n.type === "Pressable" && !String(n.props.accessibilityLabel).startsWith("person.date."),
      );
    const month = calendarMonthDays(now, calendar);
    assert.deepEqual(
      dayButtons().map((n: any) => n.props.accessibilityLabel),
      month.map((day) => formatCalendarDate(day, locale, calendar)),
      `${calendar}/${locale}: one button per day of the app's month`,
    );
    const firstDigit = nodes(dayButtons()[0]).find((n: any) => n.type === "Text")!.props.children;
    assert.equal(String(firstDigit), locale !== "en" ? faDigits(1) : "1", "the calendar's day 1");
    const today = dateFilter.localDayStart(now);
    dayButtons().forEach((n: any, i: number) =>
      assert.equal(!!n.props.disabled, month[i] < today, "nothing before the minimum"),
    );
    assert.equal(control("person.date.previousMonth").props.disabled, true);
    const later = month.find((day) => day > today);
    if (later != null) {
      dayButtons()[month.indexOf(later)].props.onPress();
      render();
      assert.deepEqual(picks, [later], "the start of the chosen local day");
      assert.equal(dayButtons()[month.indexOf(later)].props.accessibilityState.selected, true);
    }
    control("person.date.nextMonth").props.onPress();
    render();
    const nextMonth = calendarMonthDays(adjacentCalendarMonth(now, 1, calendar), calendar);
    assert.equal(
      dayButtons()[0].props.accessibilityLabel,
      formatCalendarDate(nextMonth[0], locale, calendar),
      "the next month of the app's calendar",
    );
    assert.equal(control("person.date.previousMonth").props.disabled, false);
    hooks.unmount();
  }
console.log(
  "PASS: real date/time sheet, presets, inclusive boundaries, validation/reopen, request-keyed iOS wheels, retryable Android errors and stale native callbacks in EN/FA/PS across all three calendars",
);
