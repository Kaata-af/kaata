import assert from "node:assert/strict";
import type { Calendar } from "../calendar";
import { formatCalendarDate } from "../jalali";
import { localDayStart } from "../tally-date-filter";
import { compileUI, flattenStyle, jsx, nodes } from "./ui-fixture";

const now = new Date(2026, 9, 25, 16, 42).getTime();
const past = new Date(2026, 8, 12).getTime();

const { formatRelative } = compileUI("../format", {
  "./calendar": { getEffectiveCalendar: () => "jalali" },
  "./currency": { getCurrentCurrencySymbol: () => "AFN" },
  "./i18n": { getLocale: () => "fa", t: (key: string) => key },
  "./jalali": require("../jalali"),
  "./money": require("../money"),
});
const future = new Date(2027, 0, 2).getTime();
assert.equal(
  formatRelative(future, now, { alwaysRelative: true }),
  formatCalendarDate(future, "fa", "jalali"),
  "a future tally shows its chosen business date instead of just now",
);

for (const calendar of ["gregorian", "jalali", "qamari"] as Calendar[])
  for (const locale of ["en", "fa", "ps"] as const) {
    let value = now;
    let expanded = false;
    let disabled = false;
    const events: string[] = [];
    const words = {
      "entry.date.label": locale === "en" ? "Date" : locale === "fa" ? "تاریخ" : "نېټه",
      "person.date.today": locale === "en" ? "Today" : locale === "fa" ? "امروز" : "نن",
      "common.done": locale === "en" ? "Done" : locale === "fa" ? "تمام" : "وشول",
    };
    const { EntryDateField } = compileUI(
      "../../components/EntryDateField",
      {
        "react/jsx-runtime": { jsx, jsxs: jsx },
        "react-native": {
          Pressable: "Pressable",
          Text: "Text",
          View: "View",
          StyleSheet: { create: (style: any) => style },
        },
        "@expo/vector-icons": { Ionicons: "Icon" },
        "../lib/calendar": { useCalendar: () => calendar },
        "../lib/colors": require("../colors"),
        "../lib/direction": {
          useIsRTL: () => locale !== "en",
          rowDir: (rtl: boolean) => ({ flexDirection: rtl ? "row-reverse" : "row" }),
          textDir: (rtl: boolean) => ({ textAlign: rtl ? "right" : "left" }),
        },
        "../lib/fonts": { fonts: {} },
        "../lib/i18n": {
          getLocale: () => locale,
          t: (key: keyof typeof words) => words[key],
        },
        "../lib/jalali": { formatCalendarDate },
        "../lib/tally-date-filter": { localDayStart },
        "../lib/tokens": { radius: { sm: 8 }, TOUCH_MIN: 44, typography: {} },
        "./CalendarDayPicker": { CalendarDayPicker: "CalendarDayPicker" },
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
      EntryDateField({
        value,
        expanded,
        disabled,
        onToggle: () => {
          events.push("toggle");
          expanded = !expanded;
        },
        onChange: (day: number) => {
          events.push("change");
          value = day;
        },
      });
    const control = (tree: any, label: string) => {
      const node = nodes(tree).find((n) => n.props.accessibilityLabel === label);
      assert.ok(node, `Missing control ${label}`);
      return node;
    };
    const grid = (tree: any) => nodes(tree).find((n) => n.type === "CalendarDayPicker");

    let tree = render();
    assert.equal(grid(tree), undefined, "closed form does not mount a calendar");
    const field = control(tree, words["entry.date.label"]);
    assert.equal(field.props.accessibilityValue.text, formatCalendarDate(now, locale, calendar));
    assert.equal(field.props.accessibilityState.expanded, false);
    const fieldStyle = flattenStyle(field.props.style({ pressed: false }));
    assert.equal(fieldStyle.flexDirection, locale === "en" ? "row" : "row-reverse");
    assert.ok(fieldStyle.minHeight >= 44);
    field.props.onPress();
    tree = render();
    const calendarNode = grid(tree)!;
    assert.ok(calendarNode, "tap opens the inline calendar");
    assert.equal(calendarNode.props.calendar, calendar);
    assert.equal(calendarNode.props.isRTL, locale !== "en");
    assert.equal(calendarNode.props.minimum, undefined, "past dates are offered for backdating");
    calendarNode.props.onChange(past);
    assert.deepEqual(events, ["toggle", "change", "toggle"], "choose day then collapse");
    assert.equal(value, past, "the date field emits the chosen local day without changing time");
    assert.equal(expanded, false);
    tree = render();
    assert.equal(
      control(tree, words["entry.date.label"]).props.accessibilityValue.text,
      formatCalendarDate(past, locale, calendar),
    );

    control(tree, words["entry.date.label"]).props.onPress();
    tree = render();
    control(tree, words["person.date.today"]).props.onPress();
    assert.equal(value, localDayStart(now), "Today emits the current local day");
    assert.equal(expanded, false);

    expanded = true;
    tree = render();
    const beforeDone = value;
    control(tree, words["common.done"]).props.onPress();
    assert.equal(expanded, false);
    assert.equal(value, beforeDone, "Done closes without changing the date");

    expanded = true;
    disabled = true;
    tree = render();
    const eventCount = events.length;
    for (const label of Object.values(words)) {
      const button = control(tree, label);
      assert.equal(button.props.disabled, true);
      button.props.onPress();
    }
    assert.equal(grid(tree)!.props.disabled, true);
    grid(tree)!.props.onChange(past);
    assert.equal(events.length, eventCount, "disabled callbacks cannot modify the tally date");
    assert.equal(value, beforeDone);
  }

console.log(
  "PASS: tally date field, backdating, Today, Done, disabled guards and EN/FA/PS calendars",
);
