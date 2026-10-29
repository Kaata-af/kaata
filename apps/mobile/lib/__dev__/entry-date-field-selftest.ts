import assert from "node:assert/strict";
import type { Calendar } from "../calendar";
import { formatCalendarDate } from "../jalali";
import { localDayStart } from "../tally-date-filter";
import { compileUI, flattenStyle, jsx, nodes, uiHooks } from "./ui-fixture";

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
    const hooks = uiHooks();
    let value = now;
    let expanded = false;
    let disabled = false;
    let reducedMotion = false;
    const events: string[] = [];
    const words = {
      "entry.date.label": locale === "en" ? "Date" : locale === "fa" ? "تاریخ" : "نېټه",
      "person.date.today": locale === "en" ? "Today" : locale === "fa" ? "امروز" : "نن",
      "common.done": locale === "en" ? "Done" : locale === "fa" ? "تمام" : "وشول",
      "common.close": locale === "en" ? "Close" : locale === "fa" ? "بستن" : "تړل",
    };
    const { EntryDateField } = compileUI(
      "../../components/EntryDateField",
      {
        react: hooks.react,
        "react/jsx-runtime": { jsx, jsxs: jsx },
        "react-native": {
          Pressable: "Pressable",
          Text: "Text",
          View: "View",
          Modal: "Modal",
          ScrollView: "ScrollView",
          StyleSheet: { create: (style: any) => style },
        },
        "react-native-safe-area-context": { SafeAreaView: "SafeAreaView" },
        "@expo/vector-icons": { Ionicons: "Icon" },
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
        "../lib/fonts": { fonts: {} },
        "../lib/i18n": {
          getLocale: () => locale,
          t: (key: keyof typeof words) => words[key],
        },
        "../lib/jalali": { formatCalendarDate },
        "../lib/tally-date-filter": { localDayStart },
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
          onChange: (day: number) => {
            events.push("change");
            value = day;
          },
        }),
      );
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
    assert.ok(calendarNode, "tap opens the calendar popup");
    const popup = nodes(tree).find((node) => node.type === "Modal")!;
    assert.equal(popup.props.transparent, true);
    assert.equal(popup.props.animationType, "fade", "Normal mode retains the native fade");
    assert.equal(popup.props.presentationStyle, "overFullScreen");
    assert.ok(nodes(popup).includes(calendarNode), "The calendar overlays the native form");
    assert.equal(
      [tree.props.children].flat().filter((node) => node?.type !== "Modal").length,
      2,
      "Opening the calendar adds no inline grid or expanded form space",
    );
    const popupSurface = nodes(popup).find((node) => node.props.accessibilityViewIsModal)!;
    assert.ok(popupSurface);
    assert.equal(flattenStyle(popupSurface.props.style).maxWidth, 400);
    assert.equal(flattenStyle(popupSurface.props.style).maxHeight, "100%");
    const header = popupSurface.props.children[0];
    const [spacer, title, headerClose] = header.props.children;
    const headerStyle = flattenStyle(header.props.style);
    assert.equal(headerStyle.paddingHorizontal, 8);
    assert.equal(headerStyle.paddingStart, undefined);
    assert.equal(headerStyle.paddingEnd, undefined);
    assert.deepEqual(
      flattenStyle(spacer.props.style),
      flattenStyle(headerClose.props.style),
      "equal fixed side slots center the title in the popup frame in both directions",
    );
    assert.equal(spacer.props.accessible, false);
    assert.equal(spacer.props.pointerEvents, "none");
    assert.ok(
      flattenStyle(headerClose.props.style).minWidth >= 44 &&
        flattenStyle(headerClose.props.style).minHeight >= 44,
    );
    assert.equal(flattenStyle(title.props.style).textAlign, "center");
    assert.equal(flattenStyle(title.props.style).writingDirection, locale === "en" ? "ltr" : "rtl");
    assert.equal(flattenStyle(title.props.style).minWidth, 0);
    assert.equal(
      title.props.numberOfLines,
      undefined,
      "large localized titles can wrap without clipping",
    );
    const todayAction = control(popup, words["person.date.today"]);
    const doneAction = control(popup, words["common.done"]);
    assert.deepEqual(
      flattenStyle(todayAction.props.style),
      flattenStyle(doneAction.props.style),
      "Today and Done have equal width and insets rather than unequal intrinsic labels",
    );
    assert.equal(flattenStyle(todayAction.props.style).flex, 1);
    assert.ok(
      flattenStyle(todayAction.props.style).minWidth >= 44 &&
        flattenStyle(todayAction.props.style).minHeight >= 44,
    );
    for (const action of [todayAction, doneAction]) {
      assert.equal(flattenStyle(action.props.children.props.style).textAlign, "center");
      assert.equal(flattenStyle(action.props.children.props.style).maxWidth, "100%");
      assert.equal(action.props.children.props.numberOfLines, undefined);
    }
    assert.equal(
      nodes(popup).filter((node) => node.type === "ScrollView").length,
      1,
      "A short window can scroll the popup instead of clipping its calendar",
    );
    assert.equal(calendarNode.props.calendar, calendar);
    assert.equal(calendarNode.props.isRTL, locale !== "en");
    assert.equal(calendarNode.props.minimum, undefined, "past dates are offered for backdating");
    reducedMotion = true;
    tree = render();
    const quietPopup = nodes(tree).find((node) => node.type === "Modal")!;
    assert.equal(
      quietPopup.props.animationType,
      "none",
      "Off/system/automatic reduction removes native motion",
    );
    assert.equal(grid(tree)!.props.value, now, "Changing motion keeps the selected date");
    assert.equal(expanded, true, "Changing motion leaves an open date popup open");
    assert.deepEqual(events, ["toggle"], "Changing motion never submits or dismisses the date");
    const quietSurface = nodes(quietPopup).find((node) => node.props.accessibilityViewIsModal)!;
    assert.deepEqual(
      flattenStyle(quietSurface.props.style),
      flattenStyle(popupSurface.props.style),
    );
    calendarNode.props.onChange(past);
    assert.deepEqual(events, ["toggle", "change", "toggle"], "choose day then collapse");
    assert.equal(value, past, "the date field emits the chosen local day without changing time");
    assert.equal(expanded, false);
    reducedMotion = false;
    tree = render();
    const chosenEvents = events.length;
    calendarNode.props.onChange(now);
    assert.equal(
      events.length,
      chosenEvents,
      "A closed popup cannot submit a retained day callback",
    );
    assert.equal(
      control(tree, words["entry.date.label"]).props.accessibilityValue.text,
      formatCalendarDate(past, locale, calendar),
    );

    control(tree, words["entry.date.label"]).props.onPress();
    tree = render();
    const beforeReopenChoice = events.length;
    calendarNode.props.onChange(now);
    assert.equal(
      events.length,
      beforeReopenChoice,
      "A previous popup cannot change a reopened calendar",
    );
    control(tree, words["person.date.today"]).props.onPress();
    assert.equal(value, localDayStart(now), "Today emits the current local day");
    assert.equal(expanded, false);
    render();

    expanded = true;
    tree = render();
    const beforeDone = value;
    control(tree, words["common.done"]).props.onPress();
    assert.equal(expanded, false);
    assert.equal(value, beforeDone, "Done closes without changing the date");
    render();

    control(render(), words["entry.date.label"]).props.onPress();
    tree = render();
    const beforeBack = value;
    nodes(tree)
      .find((node) => node.type === "Modal")!
      .props.onRequestClose();
    assert.equal(expanded, false, "Android Back closes the popup before the entry screen");
    assert.equal(value, beforeBack);
    render();

    control(render(), words["entry.date.label"]).props.onPress();
    tree = render();
    nodes(tree)
      .find((node) => node.props.accessibilityViewIsModal)!
      .props.onAccessibilityEscape();
    assert.equal(expanded, false, "Accessibility escape dismisses the popup");
    render();

    expanded = true;
    tree = render();
    const beforeClose = events.length;
    const close = control(tree, words["common.close"]);
    nodes(tree)
      .find((node) => node.props.accessibilityViewIsModal)!
      .props.children[0].props.children[2].props.onPress();
    close.props.onPress();
    close.props.onPress();
    assert.equal(expanded, false);
    assert.equal(
      events.length,
      beforeClose + 1,
      "Backdrop and repeated close callbacks dismiss once",
    );
    render();

    expanded = true;
    disabled = true;
    tree = render();
    const eventCount = events.length;
    for (const label of [
      words["entry.date.label"],
      words["person.date.today"],
      words["common.done"],
    ]) {
      const button = control(tree, label);
      assert.equal(button.props.disabled, true);
      button.props.onPress();
    }
    assert.equal(grid(tree)!.props.disabled, true);
    grid(tree)!.props.onChange(past);
    assert.equal(events.length, eventCount, "disabled callbacks cannot modify the tally date");
    assert.equal(value, beforeDone);
    const disabledGrid = grid(tree)!;
    nodes(tree)
      .find((node) => node.type === "Modal")!
      .props.onRequestClose();
    assert.equal(expanded, false, "A disabled popup remains dismissible without editing its date");
    hooks.unmount();
    disabledGrid.props.onChange(now);
    assert.equal(events.length, eventCount + 1, "Unmounted popup callbacks cannot change a tally");
  }

console.log(
  "PASS: date popup overlay, normal/reduced motion without layout or date changes, Back/escape dismissal, stale/disabled guards, backdating, Today/Done and EN/FA/PS calendars",
);
