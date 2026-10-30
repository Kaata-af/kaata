import assert from "node:assert/strict";
import type { Calendar } from "../calendar";
import { withEntryDay } from "../entry-date";
import { faDigits, formatCalendarDate } from "../jalali";
import { compileUI, flattenStyle, jsx, nodes, uiHooks } from "./ui-fixture";

const now = new Date(2026, 9, 25, 16, 42, 12, 345).getTime();
const past = new Date(2026, 8, 12).getTime();
const midnight = new Date(2030, 3, 2, 0, 5, 44, 987),
  noon = new Date(2030, 3, 2, 12),
  late = new Date(2030, 3, 2, 23, 59);
const formatMocks = {
  "./calendar": { getEffectiveCalendar: () => "jalali" },
  "./currency": { getCurrentCurrencySymbol: () => "AFN" },
  "./i18n": { getLocale: () => "fa", t: (key: string) => key },
  "./jalali": require("../jalali"),
  "./money": require("../money"),
};
const { formatRelative } = compileUI("../format", formatMocks);
const future = new Date(2027, 0, 2).getTime();
assert.equal(
  formatRelative(future, now, { alwaysRelative: true }),
  formatCalendarDate(future, "fa", "jalali"),
);

for (const calendar of ["gregorian", "jalali", "qamari"] as Calendar[])
  for (const locale of ["en", "fa", "ps"] as const)
    for (const os of ["android", "ios"] as const) {
      const hooks = uiHooks();
      let value = now,
        expanded = false,
        disabled = false,
        blocked = false,
        reducedMotion = false;
      const events: string[] = [],
        opened: any[] = [],
        dismissed: string[] = [];
      const words = {
        "entry.date.label":
          locale === "en" ? "Date and time" : locale === "fa" ? "تاریخ و زمان" : "نېټه او وخت",
        "entry.time.label": locale === "en" ? "Time" : locale === "fa" ? "زمان" : "وخت",
        "person.date.today": locale === "en" ? "Today" : locale === "fa" ? "امروز" : "نن",
        "common.done": locale === "en" ? "Done" : locale === "fa" ? "تمام" : "وشول",
        "common.close": locale === "en" ? "Close" : locale === "fa" ? "بستن" : "تړل",
        "common.cancel": locale === "en" ? "Cancel" : locale === "fa" ? "لغو" : "لغوه",
        "format.am": locale === "en" ? "AM" : locale === "fa" ? "ق.ظ" : "غ.م",
        "format.pm": locale === "en" ? "PM" : locale === "fa" ? "ب.ظ" : "غ.و",
      };
      const format = compileUI("../format", {
        ...formatMocks,
        "./calendar": { getEffectiveCalendar: () => "gregorian" },
        "./i18n": { getLocale: () => locale, t: (key: keyof typeof words) => words[key] },
      });
      const { EntryDateField } = compileUI(
        "../../components/EntryDateField",
        {
          react: hooks.react,
          "react/jsx-runtime": { jsx, jsxs: jsx },
          "react-native": {
            Platform: { OS: os },
            Pressable: "Pressable",
            Text: "Text",
            View: "View",
            ScrollView: "ScrollView",
            StyleSheet: { create: (style: any) => style },
          },
          "react-native-safe-area-context": { SafeAreaView: "SafeAreaView" },
          "@expo/vector-icons": { Ionicons: "Icon" },
          "@react-native-community/datetimepicker": {
            __esModule: true,
            default: "DateTimePicker",
            DateTimePickerAndroid: {
              open: (options: any) => opened.push(options),
              dismiss: async (mode: string) => {
                dismissed.push(mode);
              },
            },
          },
          "../lib/app-lock-privacy": {
            getAppLockPrivacy: () => blocked,
            useAppLockPrivacy: () => blocked,
          },
          "../lib/calendar": { useCalendar: () => calendar },
          "../lib/colors": require("../colors"),
          "../lib/direction": {
            useIsRTL: () => locale !== "en",
            rowDir: (rtl: boolean) => ({ flexDirection: rtl ? "row-reverse" : "row" }),
            textDir: (rtl: boolean) => ({
              textAlign: rtl ? "right" : "left",
              writingDirection: rtl ? "rtl" : "ltr",
            }),
          },
          "../lib/entry-date": require("../entry-date"),
          "../lib/fonts": { fonts: {} },
          "../lib/format": format,
          "../lib/i18n": { t: (key: keyof typeof words) => words[key] },
          "../lib/tokens": { radius: { sm: 8, sheet: 18 }, TOUCH_MIN: 44, typography: {} },
          "./CalendarDayPicker": { CalendarDayPicker: "CalendarDayPicker" },
          "./ProtectedModal": { ProtectedModal: "Modal" },
          "./SheetBackdrop": { useSheetMotionPreference: () => reducedMotion },
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
          EntryDateField({
            value,
            expanded,
            disabled,
            onToggle: () => {
              events.push("toggle");
              expanded = !expanded;
            },
            onChange: (timestamp: number) => {
              events.push("change");
              value = timestamp;
            },
          }),
        );
      const control = (label: string) => {
        const node = nodes(hooks.tree).find((n) => n.props.accessibilityLabel === label);
        assert.ok(node, `Missing control ${label}`);
        return node;
      };
      const grid = () => nodes(hooks.tree).find((n) => n.type === "CalendarDayPicker")!;
      const popup = () => nodes(hooks.tree).find((n) => n.type === "Modal")!;
      const surface = () => nodes(hooks.tree).find((n) => n.props.accessibilityViewIsModal)!;
      const openPopup = () => {
        control(words["entry.date.label"]).props.onPress();
        render();
        assert.equal(expanded, true);
      };
      const timeCallback = () => {
        if (os === "ios") {
          const picker = nodes(hooks.tree).find((n) => n.type === "DateTimePicker")!;
          assert.ok(picker);
          assert.equal(picker.props.mode, "time");
          assert.equal(picker.props.display, "spinner");
          assert.equal(picker.props.value.getTime(), value);
          return picker.props.onValueChange;
        }
        const time = control(words["entry.time.label"]);
        assert.equal(time.props.accessibilityValue.text, format.formatTime(value));
        assert.ok(flattenStyle(time.props.style({ pressed: false })).minHeight >= 44);
        const before = opened.length;
        time.props.onPress();
        time.props.onPress();
        assert.equal(opened.length, before + 1, "duplicate taps open one native dialog");
        const options = opened.at(-1)!;
        assert.equal(options.mode, "time");
        assert.equal(options.is24Hour, false);
        assert.equal(options.value.getTime(), value);
        assert.equal(options.positiveButton.label, words["common.done"]);
        assert.equal(options.negativeButton.label, words["common.cancel"]);
        return options.onValueChange;
      };
      render();
      assert.equal(grid(), undefined);
      const field = control(words["entry.date.label"]),
        fieldStyle = flattenStyle(field.props.style({ pressed: false }));
      assert.equal(field.props.accessibilityValue.text, format.formatTimestamp(now, calendar));
      assert.ok(
        field.props.accessibilityValue.text.includes(formatCalendarDate(now, locale, calendar)),
      );
      assert.ok(field.props.accessibilityValue.text.includes(format.formatTime(now)));
      assert.equal(field.props.accessibilityState.expanded, false);
      assert.equal(fieldStyle.flexDirection, locale === "en" ? "row" : "row-reverse");
      assert.ok(fieldStyle.minHeight >= 44);
      for (const invalid of [NaN, Infinity, -Infinity]) {
        assert.equal(format.formatTime(invalid), "");
        assert.equal(format.formatTimestamp(invalid, calendar), "");
      }
      openPopup();
      const initialGrid = grid(),
        initialPopup = popup(),
        initialSurface = surface();
      assert.equal(initialPopup.props.transparent, true);
      assert.equal(initialPopup.props.animationType, "fade");
      assert.equal(initialPopup.props.presentationStyle, "overFullScreen");
      assert.ok(nodes(initialPopup).includes(initialGrid));
      assert.equal(
        [hooks.tree.props.children].flat().filter((node) => node?.type !== "Modal").length,
        2,
        "popup adds no inline form space",
      );
      assert.equal(flattenStyle(initialSurface.props.style).maxWidth, 400);
      assert.equal(flattenStyle(initialSurface.props.style).maxHeight, "100%");
      const header = initialSurface.props.children[0],
        [spacer, title, headerClose] = header.props.children,
        headerStyle = flattenStyle(header.props.style);
      assert.equal(headerStyle.paddingHorizontal, 8);
      assert.equal(headerStyle.paddingStart, undefined);
      assert.equal(headerStyle.paddingEnd, undefined);
      assert.deepEqual(flattenStyle(spacer.props.style), flattenStyle(headerClose.props.style));
      assert.equal(spacer.props.accessible, false);
      assert.equal(spacer.props.pointerEvents, "none");
      assert.ok(
        flattenStyle(headerClose.props.style).minWidth >= 44 &&
          flattenStyle(headerClose.props.style).minHeight >= 44,
      );
      assert.equal(flattenStyle(title.props.style).textAlign, "center");
      assert.equal(
        flattenStyle(title.props.style).writingDirection,
        locale === "en" ? "ltr" : "rtl",
      );
      assert.equal(flattenStyle(title.props.style).minWidth, 0);
      assert.equal(title.props.numberOfLines, undefined);
      const today = control(words["person.date.today"]),
        done = control(words["common.done"]);
      assert.deepEqual(flattenStyle(today.props.style), flattenStyle(done.props.style));
      assert.equal(flattenStyle(today.props.style).flex, 1);
      assert.ok(
        flattenStyle(today.props.style).minWidth >= 44 &&
          flattenStyle(today.props.style).minHeight >= 44,
      );
      for (const action of [today, done]) {
        assert.equal(flattenStyle(action.props.children.props.style).textAlign, "center");
        assert.equal(flattenStyle(action.props.children.props.style).maxWidth, "100%");
        assert.equal(action.props.children.props.numberOfLines, undefined);
      }
      assert.equal(nodes(initialPopup).filter((node) => node.type === "ScrollView").length, 1);
      assert.equal(initialGrid.props.calendar, calendar);
      assert.equal(initialGrid.props.isRTL, locale !== "en");
      assert.equal(initialGrid.props.minimum, undefined);
      reducedMotion = true;
      render();
      assert.equal(popup().props.animationType, "none");
      assert.equal(grid().props.value, now);
      assert.equal(expanded, true);
      assert.deepEqual(events, ["toggle"]);
      assert.deepEqual(
        flattenStyle(surface().props.style),
        flattenStyle(initialSurface.props.style),
      );

      grid().props.onChange(past);
      assert.equal(value, withEntryDay(now, past), "day change preserves original clock");
      assert.equal(expanded, true);
      render();
      timeCallback()({}, midnight);
      assert.equal(value, new Date(2026, 8, 12, 0, 5).getTime());
      assert.equal(expanded, true);
      assert.equal(
        format.formatTime(value),
        `${locale === "en" ? "12:05" : faDigits("12:05")} ${words["format.am"]}`,
      );
      render();
      grid().props.onChange(now);
      assert.equal(
        value,
        new Date(2026, 9, 25, 0, 5).getTime(),
        "day selection retains chosen time",
      );
      render();
      timeCallback()({}, noon);
      assert.equal(
        value,
        new Date(2026, 9, 25, 12).getTime(),
        "native time never replaces chosen day",
      );
      assert.equal(
        format.formatTime(value),
        `${locale === "en" ? "12:00" : faDigits("12:00")} ${words["format.pm"]}`,
      );
      const exactMidnight = new Date(2026, 9, 25).getTime();
      assert.equal(
        format.formatTime(exactMidnight),
        `${locale === "en" ? "12:00" : faDigits("12:00")} ${words["format.am"]}`,
      );
      render();
      grid().props.onChange(past);
      render();
      control(words["person.date.today"]).props.onPress();
      assert.equal(value, new Date(2026, 9, 25, 12).getTime(), "Today retains chosen time");
      assert.equal(expanded, true);
      render();
      if (os === "android") {
        const beforeCancel = value;
        timeCallback();
        const cancelled = opened.at(-1)!;
        cancelled.onDismiss();
        cancelled.onValueChange({}, late);
        assert.equal(value, beforeCancel);
        timeCallback();
        const selected = opened.at(-1)!,
          changes = events.length;
        selected.onValueChange({}, noon);
        selected.onValueChange({}, late);
        selected.onDismiss();
        assert.equal(events.length, changes + 1, "duplicate callback cannot reapply time");
        timeCallback();
        const failed = opened.at(-1)!;
        failed.onError(new Error("native picker error"));
        failed.onValueChange({}, late);
        assert.equal(value, beforeCancel);
      }
      render();
      const oldGrid = grid(),
        oldTime = timeCallback(),
        beforeDone = value;
      control(words["common.done"]).props.onPress();
      assert.equal(expanded, false);
      assert.equal(value, beforeDone);
      if (os === "android") assert.equal(dismissed.at(-1), "time");
      render();
      const afterClose = events.length;
      oldGrid.props.onChange(past);
      oldTime({}, late);
      assert.equal(events.length, afterClose, "closed callbacks cannot change timestamps");
      assert.equal(
        control(words["entry.date.label"]).props.accessibilityValue.text,
        format.formatTimestamp(value, calendar),
      );
      openPopup();
      const afterReopen = events.length;
      oldGrid.props.onChange(past);
      oldTime({}, late);
      assert.equal(events.length, afterReopen, "old callbacks cannot change reopened popup");
      reducedMotion = false;
      render();
      const beforeBack = value;
      popup().props.onRequestClose();
      assert.equal(expanded, false);
      assert.equal(value, beforeBack);
      render();
      openPopup();
      surface().props.onAccessibilityEscape();
      assert.equal(expanded, false);
      render();
      openPopup();
      const beforeClose = events.length,
        close = control(words["common.close"]);
      surface().props.children[0].props.children[2].props.onPress();
      close.props.onPress();
      close.props.onPress();
      assert.equal(expanded, false);
      assert.equal(events.length, beforeClose + 1);
      render();
      openPopup();
      const beforeDisableGrid = grid(),
        beforeDisableTime = timeCallback();
      disabled = true;
      render();
      const disabledEvents = events.length;
      for (const label of [
        words["entry.date.label"],
        words["person.date.today"],
        words["common.done"],
      ]) {
        const button = control(label);
        assert.equal(button.props.disabled, true);
        button.props.onPress();
      }
      assert.equal(grid().props.disabled, true);
      grid().props.onChange(past);
      beforeDisableTime({}, late);
      assert.equal(events.length, disabledEvents);
      disabled = false;
      render();
      beforeDisableGrid.props.onChange(past);
      beforeDisableTime({}, late);
      assert.equal(events.length, disabledEvents, "disabled callbacks stay stale after reenable");
      const beforeLockGrid = grid(),
        beforeLockTime = timeCallback();
      blocked = true;
      render();
      const blockedEvents = events.length;
      grid().props.onChange(past);
      beforeLockTime({}, late);
      assert.equal(events.length, blockedEvents);
      blocked = false;
      render();
      beforeLockGrid.props.onChange(past);
      beforeLockTime({}, late);
      assert.equal(events.length, blockedEvents, "locked callbacks stay stale after unlock");
      const unmountedGrid = grid(),
        unmountedTime = timeCallback(),
        beforeUnmount = events.length,
        dismissCount = dismissed.length;
      hooks.unmount();
      unmountedGrid.props.onChange(past);
      unmountedTime({}, late);
      assert.equal(events.length, beforeUnmount);
      if (os === "android") assert.equal(dismissed.length, dismissCount + 1);
      assert.equal(hooks.lateWrites, 0);
    }
console.log(
  "PASS: date/time popup layout and motion, independent day/clock, midnight/noon, Today/Done, native cancel/deduplication/cleanup, stale/disabled/privacy guards in EN/FA/PS and all calendars on Android/iOS",
);
