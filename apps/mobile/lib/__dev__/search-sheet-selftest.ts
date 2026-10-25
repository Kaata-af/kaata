// Native transitions, keyboard positioning and fonts still need a phone check.
import assert from "node:assert/strict";
import { createElement } from "react";
import { colors } from "../colors";
import * as nativeSearch from "../native-search";
import { compileUI, flattenStyle, jsx, nodes, uiHooks } from "./ui-fixture";
import type { SearchSheetProps } from "../../components/SearchSheet";

const direction = {
  rowDir: (rtl: boolean) => ({ flexDirection: rtl ? "row-reverse" : "row" }),
  textDir: (rtl: boolean) => ({
    textAlign: rtl ? "right" : "left",
    writingDirection: rtl ? "rtl" : "ltr",
  }),
};
const shared = {
  "react/jsx-runtime": { jsx, jsxs: jsx },
  "@expo/vector-icons": { Ionicons: "Icon" },
  "../lib/colors": { colors },
  "../lib/direction": direction,
  "../lib/i18n": { t: (key: string) => key },
  "../lib/tokens": {
    icon: { row: 22, trailing: 18 },
    radius: { sm: 8, md: 12 },
    TOUCH_MIN: 44,
    typography: { body: {}, bodySm: {} },
  },
  "../lib/native-search": nativeSearch,
  "./SettingsScreen": { ScreenHeader: "ScreenHeader" },
  "./Button": { Button: "Button" },
  "./ConfirmDialog": { ConfirmDialog: "ConfirmDialog" },
};
const label = (tree: any, text: string) => {
  const node = nodes(tree).find((node) => node.props.accessibilityLabel === text);
  assert.ok(node, `Missing control ${text}`);
  return node;
};
const press = (node: any) => {
  if (!node.props.disabled) node.props.onPress?.();
};
const find = (tree: any, type: string) => {
  const node = nodes(tree).find((node) => node.type === type);
  assert.ok(node, `Missing ${type}`);
  return node;
};
const showResults = (tree: any) => {
  const button = nodes(tree).find(
    (node) => node.type === "Button" && node.props.label === "search.showResults",
  );
  assert.ok(button, "Filters have a Show results action");
  return button;
};
const regionFor = (tree: any, childType: string) => {
  const child = find(tree, childType);
  const region = nodes(tree).find(
    (node) => node.props.testID === "search-results-panel" && nodes(node).includes(child),
  );
  assert.ok(region, `${childType} has a containing region`);
  return region;
};
const baseProps = {
  visible: false,
  contextKey: "account-a:kaata-a",
  title: "Search customers",
  resultSummary: "2 matching customers",
  query: "",
  placeholder: "Search customers",
  isRTL: false,
  onChangeQuery: (_query: string) => {},
  onDismiss: () => {},
  filtersActive: false,
  dismissDisabled: false,
  filters: jsx("FilterOptions", {}),
  children: jsx("MatchingResults", {}),
  footer: jsx("SelectionFooter", {}),
  confirmation: undefined as SearchSheetProps["confirmation"],
};

// Execute the real content for both native branches and writing directions.
for (const rtl of [false, true]) {
  for (const platform of ["ios", "android"]) {
    const hooks = uiHooks();
    const timers = new Map<number, () => void>();
    let nextTimer = 0,
      focused = 0,
      blurred = 0,
      keyboardDismissed = 0,
      dismissed = 0,
      cleared = 0;
    let dimensions = { width: 320, height: 640 };
    const changes: string[] = [];
    const native = {
      Keyboard: { dismiss: () => keyboardDismissed++ },
      KeyboardAvoidingView: "KeyboardAvoidingView",
      Platform: { OS: platform },
      Pressable: "Pressable",
      ScrollView: "ScrollView",
      StyleSheet: { create: (styles: unknown) => styles },
      Text: "Text",
      TextInput: "TextInput",
      View: "View",
      useWindowDimensions: () => dimensions,
    };
    const { SearchSheetContent } = compileUI(
      "../../components/SearchSheet",
      {
        ...shared,
        react: hooks.react,
        "expo-router": {},
        "react-native": native,
        "react-native-safe-area-context": { SafeAreaView: "SafeAreaView" },
      },
      {
        setTimeout: (fn: () => void) => {
          const id = ++nextTimer;
          timers.set(id, fn);
          return id;
        },
        clearTimeout: (id: number) => timers.delete(id),
      },
    );
    let props = {
      ...baseProps,
      active: true,
      isRTL: rtl,
      onChangeQuery: (query: string) => changes.push(query),
      onDismiss: () => dismissed++,
      onClearAll: () => cleared++,
      autoFocus: true,
    };
    const render = (next: Partial<typeof props> = {}) => {
      props = { ...props, ...next };
      const tree = hooks.render(() => SearchSheetContent(props));
      const input = nodes(tree).find((node) => node.type === "TextInput");
      if (input) input.props.ref.current = { focus: () => focused++, blur: () => blurred++ };
      return tree;
    };
    const runTimers = () => {
      const pending = [...timers.values()];
      timers.clear();
      pending.forEach((run) => run());
    };
    assert.equal(render(), null, "Hidden search cannot put results or an input on the page");
    const opened = render({ visible: true });
    assert.equal(opened.type, "SafeAreaView", "Search uses Add Customer's native content shell");
    assert.equal(opened.props.edges, undefined, "Safe areas follow Add Customer's default edges");
    assert.equal(
      nodes(opened).some((node) => node.type === "Modal"),
      false,
    );
    assert.equal(
      nodes(opened).some((node) => node.props.onMoveShouldSetPanResponder),
      false,
    );
    assert.equal(nodes(opened).filter((node) => node.type === "MatchingResults").length, 1);
    assert.equal(nodes(opened).filter((node) => node.type === "SelectionFooter").length, 1);
    const header = find(opened, "ScreenHeader");
    assert.equal(header.props.title, props.title);
    assert.equal(header.props.isRTL, rtl);
    assert.equal(header.props.backLabel, "common.close");
    const searchRow = nodes(opened).find(
      (node) =>
        node.type === "View" &&
        [node.props.children].flat().includes(label(opened, "search.filters")),
    );
    assert.ok(searchRow);
    assert.ok(
      flattenStyle(searchRow.props.style).paddingTop >= 12,
      "Search controls have space below the header divider",
    );
    const summary = nodes(opened).find((node) => node.props.testID === "search-results-summary")!;
    assert.equal(flattenStyle(summary.props.style).flexDirection, rtl ? "row-reverse" : "row");
    assert.equal(find(summary, "Text").props.children, "2 matching customers");
    for (const viewport of [
      { width: 320, height: 640 },
      { width: 640, height: 320 },
      { width: 1024, height: 1366 },
    ]) {
      dimensions = viewport;
      const resized = render();
      const container = flattenStyle(resized.props.style);
      const keyboard = find(resized, "KeyboardAvoidingView");
      assert.equal(container.flex, 1);
      assert.equal(container.paddingTop, undefined, "The native modal controls the top boundary");
      assert.equal(container.borderTopLeftRadius, undefined);
      assert.equal(container.maxWidth, undefined);
      assert.equal(keyboard.props.behavior, platform === "ios" ? "padding" : "height");
      assert.equal(flattenStyle(keyboard.props.style).flex, 1);
      assert.equal(nodes(keyboard).includes(find(resized, "ScreenHeader")), false);
    }
    runTimers();
    assert.equal(focused, 1, "Opening the native route focuses its search input");
    const oldInput = find(opened, "TextInput");
    oldInput.props.onChangeText("Ahmad");
    assert.deepEqual(changes, ["Ahmad"]);
    press(label(opened, "search.filters"));
    const expanded = render();
    assert.equal(label(expanded, "search.filters").props.accessibilityState.expanded, true);
    find(expanded, "FilterOptions");
    for (const viewport of [
      { width: 320, height: 640 },
      { width: 640, height: 320 },
      { width: 1024, height: 1366 },
    ]) {
      dimensions = viewport;
      const fullFilters = render();
      const filterRegion = nodes(fullFilters).find(
        (node) => node.props.testID === "search-filter-panel",
      )!;
      const scrolls = nodes(filterRegion).filter((node) => node.type === "ScrollView");
      assert.equal(scrolls.length, 1, "Filters use one scroll region instead of nested lists");
      const scroll = scrolls[0];
      assert.equal(flattenStyle(scroll.props.style).flex, 1);
      assert.equal(scroll.props.keyboardDismissMode, "on-drag");
      assert.equal(
        flattenStyle(scroll.props.style).maxHeight,
        undefined,
        "Filters use the available height rather than a small screen fraction",
      );
      const done = showResults(fullFilters);
      assert.equal(
        nodes(scroll).includes(done),
        false,
        "Show results stays outside filter scrolling",
      );
      assert.equal(
        flattenStyle(regionFor(fullFilters, "MatchingResults").props.style).display,
        "none",
        "Results stay mounted without taking space behind the filters",
      );
      assert.equal(find(fullFilters, "MatchingResults"), baseProps.children);
      assert.equal(
        flattenStyle(regionFor(fullFilters, "SelectionFooter").props.style).display,
        "none",
        "The selection toolbar does not squeeze the open filter region",
      );
      assert.equal(find(fullFilters, "SelectionFooter"), baseProps.footer);
      assert.equal(
        regionFor(fullFilters, "MatchingResults").props.accessibilityElementsHidden,
        true,
      );
      assert.equal(
        regionFor(fullFilters, "MatchingResults").props.importantForAccessibility,
        "no-hide-descendants",
      );
    }
    assert.ok(blurred > 0 && keyboardDismissed > 0, "Filters get room without the keyboard");
    runTimers();
    assert.equal(focused, 1, "Filters cancel queued autofocus");
    const oldShowResults = showResults(hooks.tree);
    press(oldShowResults);
    const resultsAgain = render();
    assert.equal(label(resultsAgain, "search.filters").props.accessibilityState.expanded, false);
    assert.notEqual(
      flattenStyle(regionFor(resultsAgain, "MatchingResults").props.style).display,
      "none",
    );
    assert.notEqual(
      flattenStyle(regionFor(resultsAgain, "SelectionFooter").props.style).display,
      "none",
    );
    assert.equal(
      regionFor(resultsAgain, "MatchingResults").props.accessibilityElementsHidden,
      false,
    );
    runTimers();
    assert.equal(focused, 1, "Show results returns to the list without reopening the keyboard");
    press(label(resultsAgain, "search.filters"));
    const filtersAgain = render();
    find(filtersAgain, "TextInput").props.onFocus();
    const typing = render();
    assert.equal(label(typing, "search.filters").props.accessibilityState.expanded, false);
    assert.equal(
      nodes(typing).some((node) => node.type === "FilterOptions"),
      false,
    );
    const withQuery = render({
      query: "Ahmad",
      filtersActive: true,
      resultSummary: "1 matching customer",
    });
    const matchingSummary = nodes(withQuery).find(
      (node) => node.props.testID === "search-results-summary",
    )!;
    const clearAll = label(withQuery, "search.clearAll");
    assert.ok(
      [matchingSummary.props.children].flat().includes(clearAll),
      "Clear all shares the matching-customer count row",
    );
    const summaryText = find(matchingSummary, "Text");
    assert.equal(summaryText.props.children, "1 matching customer");
    assert.equal(flattenStyle(summaryText.props.style).flex, 1);
    assert.equal(flattenStyle(summaryText.props.style).minWidth, 0);
    assert.ok(flattenStyle(clearAll.props.style).minHeight >= 44);
    assert.ok(flattenStyle(clearAll.props.style).minWidth >= 44);
    press(label(withQuery, "search.clearQuery"));
    assert.equal(changes.at(-1), "");
    press(label(withQuery, "search.clearAll"));
    assert.equal(cleared, 1);
    const staleClear = label(withQuery, "search.clearAll");
    render({ contextKey: "account-b:kaata-b", query: "", filtersActive: false });
    oldInput.props.onChangeText("wrong account");
    press(staleClear);
    assert.equal(changes.includes("wrong account"), false);
    assert.equal(cleared, 1, "An old search cannot clear a new account's filters");
    const next = hooks.tree;
    press(label(next, "search.filters"));
    render();
    oldShowResults.props.onPress();
    const nextFilters = render();
    assert.equal(
      label(nextFilters, "search.filters").props.accessibilityState.expanded,
      true,
      "An old Show results callback cannot change another account's filter view",
    );
    render({ visible: false });
    runTimers();
    assert.equal(focused, 1, "Closing cancels pending focus");
    const reopened = render({ visible: true });
    runTimers();
    assert.equal(focused, 2, "Reopening does not need an RN Modal onShow event");
    find(next, "TextInput").props.onChangeText("old opening");
    assert.equal(changes.includes("old opening"), false);
    press(label(reopened, "search.filters"));
    render();
    const busy = render({ query: "Ahmad", filtersActive: true, dismissDisabled: true });
    assert.equal(find(busy, "TextInput").props.editable, false);
    find(busy, "TextInput").props.onChangeText("during removal");
    label(busy, "search.clearAll").props.onPress();
    find(busy, "ScreenHeader").props.onBack();
    assert.equal(changes.includes("during removal"), false);
    assert.equal(cleared, 1);
    assert.equal(find(busy, "ScreenHeader").props.backDisabled, true);
    assert.equal(label(busy, "search.filters").props.disabled, true);
    assert.equal(showResults(busy).props.disabled, true);
    showResults(busy).props.onPress();
    assert.equal(
      label(render(), "search.filters").props.accessibilityState.expanded,
      true,
      "Busy work also rejects a queued Show results action",
    );
    assert.equal(dismissed, 0, "Busy work locks both queued input and the visible chevron");
    const available = render({ dismissDisabled: false });
    find(available, "ScreenHeader").props.onBack();
    assert.equal(dismissed, 1);
    const closing = render({ active: false });
    find(closing, "TextInput").props.onChangeText("during native exit");
    runTimers();
    assert.equal(changes.includes("during native exit"), false);
    find(closing, "MatchingResults");
    assert.equal(focused, 2, "The exiting view stays drawn without stealing focus");
    render({ visible: false, active: true, autoFocus: false });
    const selecting = render({ visible: true });
    runTimers();
    assert.equal(focused, 2, "Opening selection leaves the keyboard closed");
    const overlay = nodes(selecting).find(
      (node) => node.props.testID === "search-selection-overlay",
    )!;
    assert.equal(flattenStyle(overlay.props.style).backgroundColor, "transparent");
    assert.equal(
      flattenStyle(overlay.props.style).position,
      "absolute",
      "Results extend behind the rounded selection card",
    );
    assert.equal(
      flattenStyle(overlay.props.style).maxHeight,
      "60%",
      "Large text and the keyboard leave room for results",
    );
    overlay.props.onLayout({ nativeEvent: { layout: { height: 280 } } });
    const renderResults = (footerInset: number) => jsx("InsetResults", { footerInset });
    const insetTree = hooks.render(() => SearchSheetContent({ ...props, children: renderResults }));
    assert.equal(
      find(insetTree, "InsetResults").props.footerInset,
      280,
      "The last row can scroll above the measured selection card",
    );
    const noFooter = hooks.render(() =>
      SearchSheetContent({ ...props, children: renderResults, footer: undefined }),
    );
    assert.equal(find(noFooter, "InsetResults").props.footerInset, 0);
    let confirmed = 0,
      cancelled = 0;
    const confirmation = {
      visible: true,
      title: "Remove 2 contacts?",
      description: "They can be restored later.",
      confirmLabel: "Remove",
      destructive: true,
      onConfirm: () => confirmed++,
      onCancel: () => cancelled++,
    };
    const confirming = render({ confirmation });
    const dialog = find(confirming, "ConfirmDialog");
    assert.equal(dialog.props.visible, true);
    assert.equal(dialog.props.destructive, true);
    assert.equal(dialog.props.title, confirmation.title);
    assert.equal(
      nodes(find(confirming, "KeyboardAvoidingView")).includes(dialog),
      false,
      "The real native dialog is outside the footer and keyboard-sized result area",
    );
    assert.equal(
      find(confirming, "SelectionFooter"),
      baseProps.footer,
      "Confirmation retains the totals card underneath",
    );
    assert.equal(find(confirming, "TextInput").props.editable, false);
    find(selecting, "TextInput").props.onChangeText("behind confirmation");
    assert.equal(changes.includes("behind confirmation"), false);
    find(confirming, "ScreenHeader").props.onBack();
    assert.equal(dismissed, 1, "Confirmation prevents dismissing the sheet behind it");
    dialog.props.onCancel();
    dialog.props.onConfirm();
    assert.deepEqual(
      [confirmed, cancelled],
      [0, 1],
      "Cancel wins over a queued confirm before rerender",
    );
    const cancelledDialog = find(
      render({ confirmation: { ...confirmation, visible: false, title: "Remove 0 contacts?" } }),
      "ConfirmDialog",
    );
    assert.equal(
      cancelledDialog.props.title,
      confirmation.title,
      "The fading dialog retains its original selected count",
    );
    const reopenedDialog = find(render({ confirmation }), "ConfirmDialog");
    dialog.props.onConfirm();
    assert.equal(confirmed, 0, "A canceled dialog cannot confirm a later opening");
    reopenedDialog.props.onConfirm();
    reopenedDialog.props.onConfirm();
    assert.equal(confirmed, 1, "A confirmation dispatches at most once");
    render({ confirmation: { ...confirmation, visible: false } });
    const oldDialog = find(render({ confirmation }), "ConfirmDialog");
    render({ contextKey: "next-account:next-kaata" });
    oldDialog.props.onConfirm();
    assert.equal(confirmed, 1, "Old dialog cannot confirm in the next scope");
    const leavingDialog = find(render({ active: false }), "ConfirmDialog");
    assert.equal(leavingDialog.props.visible, false, "Native exit never leaves another modal open");
    leavingDialog.props.onConfirm();
    assert.equal(confirmed, 1);
    hooks.unmount();
    find(reopened, "TextInput").props.onChangeText("after unmount");
    runTimers();
    assert.equal(changes.includes("after unmount"), false);
    assert.equal(focused, 2);

    const { SearchFieldTrigger } = compileUI("../../components/SearchFieldTrigger", {
      ...shared,
      "react-native": native,
    });
    let triggered = 0;
    const trigger = SearchFieldTrigger({
      placeholder: "Search customers",
      isRTL: rtl,
      onPress: () => triggered++,
    });
    assert.equal(
      nodes(trigger).some((node) => node.type === "TextInput"),
      false,
    );
    assert.equal(trigger.props.accessibilityRole, "button");
    const triggerStyle = flattenStyle(trigger.props.style({ pressed: false }));
    assert.equal(triggerStyle.flexDirection, rtl ? "row-reverse" : "row");
    assert.ok(triggerStyle.minHeight >= 44);
    press(trigger);
    press(SearchFieldTrigger({ ...trigger.props, disabled: true, onPress: () => triggered++ }));
    assert.equal(triggered, 1, "The input-shaped page trigger respects disabled state");
  }
}

// Keep the real store between the publishing owner and the native route.
{
  const hooks = uiHooks();
  const pushes: any[] = [];
  let dismissed = 0,
    mayDismiss = true;
  const events = new Map<string, (event?: any) => void>();
  const timers = new Map<number, () => void>();
  let nextTimer = 0;
  const flushTimers = () => {
    const pending = [...timers.values()];
    timers.clear();
    pending.forEach((run) => run());
  };
  let ownerFocused = false;
  const ownerNavigation = {
    isFocused: () => ownerFocused,
    addListener: (event: string, listener: (event?: any) => void) => {
      events.set(event, listener);
      return () => {
        events.delete(event);
      };
    },
  };
  const { SearchSheet } = compileUI(
    "../../components/SearchSheet",
    {
      ...shared,
      react: { ...hooks.react, createElement: jsx, useLayoutEffect: hooks.react.useEffect },
      "expo-router": {
        useRouter: () => ({
          push: (href: unknown) => {
            pushes.push(href);
            ownerFocused = false;
          },
        }),
        useRoute: () => ({ key: "home-owner" }),
        useNavigation: () => ownerNavigation,
      },
      "react-native": { Keyboard: { dismiss() {} }, StyleSheet: { create: (value: any) => value } },
      "react-native-safe-area-context": {},
    },
    {
      setTimeout: (run: () => void, delay: number) => {
        assert.ok(delay >= 500, "Fallback gives the native dismissal time to settle");
        const id = ++nextTimer;
        timers.set(id, run);
        return id;
      },
      clearTimeout: (id: number) => timers.delete(id),
    },
  );
  let props = {
    ...baseProps,
    canDismiss: () => mayDismiss,
    onDismiss: () => dismissed++,
  };
  const render = (next: Partial<typeof props> = {}) => {
    props = { ...props, ...next };
    return hooks.render(() => SearchSheet(props));
  };
  assert.equal(render(), null);
  assert.equal(pushes.length, 0);
  render({ visible: true });
  assert.equal(pushes.length, 1);
  assert.equal(pushes[0].pathname, "/search");
  assert.equal(pushes[0].params.ownerKey, "home-owner");
  const firstId = pushes[0].params.sessionId;
  const first = nativeSearch.getNativeSearch(firstId)!;
  assert.equal(first.contextKey, props.contextKey);
  assert.equal((first.content as any).props.query, "");
  render({ query: "Ahmad", children: jsx("LiveSyncResult", { revision: 2 }) });
  const updated = nativeSearch.getNativeSearch(firstId)!;
  assert.notEqual(updated, first, "A changed snapshot wakes native-route subscribers");
  assert.equal(nativeSearch.getNativeSearch(firstId), updated, "Unchanged snapshots stay cached");
  assert.equal((updated.content as any).props.query, "Ahmad");
  assert.equal((updated.content as any).props.children.props.revision, 2);
  assert.equal(pushes.length, 1, "Live owner updates never push another modal");
  render({
    confirmation: { visible: true, title: "Remove contacts?", onConfirm() {}, onCancel() {} },
  });
  assert.equal(
    nativeSearch.getNativeSearch(firstId)?.busy,
    true,
    "A native confirmation disables the search sheet swipe gesture",
  );
  nativeSearch.closeNativeSearch(firstId);
  assert.equal(nativeSearch.getNativeSearch(firstId)?.closing, false);
  render({ confirmation: undefined });
  assert.equal(
    nativeSearch.getNativeSearch(firstId)?.busy,
    false,
    "Cancel restores ordinary sheet dismissal",
  );
  mayDismiss = false;
  nativeSearch.closeNativeSearch(firstId);
  assert.equal(nativeSearch.getNativeSearch(firstId)?.closing, false);
  assert.equal(dismissed, 0, "A ref guard blocks Back even before busy state publishes");
  mayDismiss = true;
  nativeSearch.closeNativeSearch(firstId);
  nativeSearch.closeNativeSearch(firstId);
  assert.equal(dismissed, 1, "Native dismissal notifies its owner exactly once");
  let afterClose = 0;
  assert.equal(
    nativeSearch.afterNativeSearchClosed(props.contextKey, () => afterClose++),
    true,
  );
  render({ visible: false });
  nativeSearch.removeNativeSearch(firstId);
  assert.equal(afterClose, 0, "Route cleanup is earlier than the native exit finishing");
  events.get("transitionEnd")?.({ data: { closing: false } });
  assert.equal(afterClose, 0, "A covered owner cannot execute a pending destination");
  ownerFocused = true;
  events.get("transitionEnd")?.({ data: { closing: true } });
  assert.equal(afterClose, 0);
  events.get("transitionEnd")?.({ data: { closing: false } });
  events.get("transitionEnd")?.({ data: { closing: false } });
  assert.equal(afterClose, 1, "The completed native entrance runs a destination once");

  let fallbackRuns = 0;
  const fallbackId = nativeSearch.createNativeSearch("home-owner", "fallback-context", () => {});
  nativeSearch.afterNativeSearchClosed("fallback-context", () => fallbackRuns++);
  nativeSearch.closeNativeSearch(fallbackId);
  nativeSearch.removeNativeSearch(fallbackId);
  events.get("focus")?.();
  assert.equal(timers.size, 1);
  ownerFocused = false;
  events.get("blur")?.();
  flushTimers();
  assert.equal(fallbackRuns, 0, "A foreign route cancels the pending owner fallback");
  ownerFocused = true;
  events.get("state")?.();
  flushTimers();
  assert.equal(fallbackRuns, 1, "Focus fallback works when iOS omits appearance transitionEnd");
  const coveredId = nativeSearch.createNativeSearch("home-owner", "covered-context", () => {});
  nativeSearch.afterNativeSearchClosed("covered-context", () => fallbackRuns++);
  nativeSearch.closeNativeSearch(coveredId);
  nativeSearch.removeNativeSearch(coveredId);
  events.get("state")?.();
  render({ visible: true });
  flushTimers();
  assert.equal(fallbackRuns, 1, "A reopened search prevents a pending owner's fallback");
  nativeSearch.cancelNativeSearchClose("home-owner");
  const secondId = pushes.at(-1).params.sessionId;
  assert.notEqual(secondId, firstId, "Every opening has a distinct route session");
  nativeSearch.removeNativeSearch(firstId);
  assert.equal(dismissed, 1, "Late old-route cleanup cannot dismiss the new opening");
  assert.equal(nativeSearch.getNativeSearch(secondId)?.closing, false);
  nativeSearch.afterNativeSearchClosed(props.contextKey, () => afterClose++);
  render({ contextKey: "account-b:kaata-b", dismissDisabled: true });
  const thirdId = pushes.at(-1).params.sessionId;
  assert.notEqual(thirdId, secondId);
  assert.equal(nativeSearch.getNativeSearch(secondId)?.content, null);
  assert.equal(dismissed, 1, "Context invalidation cannot call the new account's dismiss callback");
  assert.equal(nativeSearch.getNativeSearch(thirdId)?.busy, true);
  nativeSearch.completeNativeSearchClose("home-owner");
  assert.equal(afterClose, 1, "A context switch cancels its pending destination");
  nativeSearch.afterNativeSearchClosed(props.contextKey, () => afterClose++);
  hooks.unmount();
  assert.equal(nativeSearch.getNativeSearch(thirdId)?.closing, true);
  assert.equal(nativeSearch.getNativeSearch(thirdId)?.content, null);
  assert.equal(hooks.lateWrites, 0);
  nativeSearch.completeNativeSearchClose("home-owner");
  assert.equal(afterClose, 1, "Unmounting cancels its pending destination");
  nativeSearch.removeNativeSearch(secondId);
  nativeSearch.removeNativeSearch(thirdId);
}

// Exercise the installed stack reducer rather than mirroring its behavior.
const { StackRouter } = require("expo-router/build/react-navigation/routers/StackRouter");
const stackRouter = StackRouter({});
function host(
  params: Record<string, unknown>,
  options: { onlyRoute?: boolean; noOwner?: boolean } = {},
) {
  const hooks = uiHooks();
  const replacements: string[] = [];
  const dispatched: any[] = [];
  let state: any = {
    stale: false,
    type: "stack",
    key: "root-stack",
    index: options.onlyRoute || options.noOwner ? 0 : 1,
    routeNames: ["index", "search", "person/[id]"],
    routes: [
      ...(!options.onlyRoute && !options.noOwner ? [{ key: "owner", name: "index" }] : []),
      { key: "search-route", name: "search" },
    ],
    preloadedRoutes: [],
  };
  let preventRemove = false;
  let preventedCallback: () => void = () => {};
  let back: (() => boolean) | undefined;
  const navigation = {
    isFocused: () => state.routes[state.index]?.key === "search-route",
    getState: () => state,
    dispatch: (action: any) => {
      dispatched.push(action);
      const result = stackRouter.getStateForAction(state, action, {
        routeNames: state.routeNames,
        routeParamList: {},
        routeGetIdList: {},
      });
      if (result && typeof result === "object") state = result.state;
    },
  };
  const router = { replace: (href: string) => replacements.push(href) };
  const storeReact = {
    ...hooks.react,
    isValidElement: (value: any) => !!value && typeof value === "object" && "props" in value,
    cloneElement: (element: any, props: any) => ({
      ...element,
      props: { ...element.props, ...props },
    }),
    useSyncExternalStore(subscribe: (fn: () => void) => () => void, snapshot: () => unknown) {
      const [, wake] = hooks.react.useState(0);
      hooks.react.useEffect(
        () => subscribe(() => wake((before: number) => before + 1)),
        [subscribe],
      );
      return snapshot();
    },
  };
  const NativeSearchScreen = compileUI("../../app/search", {
    "react/jsx-runtime": { jsx, jsxs: jsx },
    react: storeReact,
    "expo-router": {
      Stack: { Screen: "StackScreen" },
      useLocalSearchParams: () => params,
      useNavigation: () => navigation,
      useIsFocused: () => navigation.isFocused(),
      useRoute: () => ({ key: "search-route" }),
      useRouter: () => router,
      usePreventRemove: (prevent: boolean, callback?: () => void) => {
        preventRemove = prevent;
        preventedCallback = callback ?? (() => {});
        return () => {
          preventRemove = false;
        };
      },
    },
    "react-native": {
      View: "View",
      BackHandler: {
        addEventListener: (_event: string, listener: () => boolean) => {
          back = listener;
          return {
            remove: () => {
              back = undefined;
            },
          };
        },
      },
    },
    "../lib/native-search": nativeSearch,
    "../components/Toast": { ToastHost: "ToastHost" },
  }).default;
  return {
    render: () => hooks.render(() => NativeSearchScreen()),
    back: () => back?.(),
    nativeDismiss: () => {
      if (preventRemove) {
        preventedCallback();
        return false;
      }
      hooks.unmount();
      return true;
    },
    unmount: () => hooks.unmount(),
    pushDestination: () => {
      state = {
        ...state,
        index: state.routes.length,
        routes: [...state.routes, { key: "destination", name: "person/[id]" }],
      };
    },
    get state() {
      return state;
    },
    get prevented() {
      return preventRemove;
    },
    replacements,
    dispatched,
  };
}
{
  let dismissed = 0;
  const id = nativeSearch.createNativeSearch("owner", "account:kaata", () => dismissed++);
  nativeSearch.publishNativeSearch(id, createElement("FirstResults", {}), false);
  const screen = host({ sessionId: id, ownerKey: "owner" });
  const opened = screen.render();
  find(opened, "FirstResults");
  const sheetContent = find(opened, "View");
  assert.equal(
    sheetContent.props.collapsable,
    false,
    "Search keeps a native parent before pointerEvents changes during Android dismissal",
  );
  assert.equal(
    sheetContent.props.children.at(-1).type,
    "ToastHost",
    "Success feedback renders inside the native sheet above its content",
  );
  nativeSearch.publishNativeSearch(id, createElement("RefreshedResults", { balance: 1200 }), false);
  assert.equal(find(screen.render(), "RefreshedResults").props.balance, 1200);
  nativeSearch.publishNativeSearch(id, createElement("RefreshedResults", {}), true);
  assert.equal(find(screen.render(), "StackScreen").props.options.gestureEnabled, false);
  assert.equal(screen.prevented, true);
  assert.equal(screen.back(), true);
  assert.equal(screen.nativeDismiss(), false, "Busy native gestures/removal are prevented");
  assert.equal(nativeSearch.getNativeSearch(id)?.closing, false);
  assert.equal(dismissed, 0);
  nativeSearch.publishNativeSearch(id, createElement("RefreshedResults", {}), false);
  assert.equal(find(screen.render(), "StackScreen").props.options.gestureEnabled, true);
  assert.equal(screen.prevented, false);
  assert.equal(screen.back(), true);
  assert.equal(dismissed, 1);
  const closing = screen.render();
  assert.equal(
    nodes(closing).some((node) => node.type === "ToastHost"),
    false,
  );
  assert.equal(find(closing, "RefreshedResults").props.active, false);
  assert.equal(find(closing, "View").props.collapsable, false);
  assert.equal(find(closing, "View").props.pointerEvents, "none");
  assert.deepEqual(
    screen.state.routes.map((route: any) => route.key),
    ["owner"],
  );
  assert.equal(screen.dispatched[0].source, "search-route");
  screen.unmount();
  assert.equal(nativeSearch.getNativeSearch(id), null);
  assert.equal(dismissed, 1);
}
{
  let dismissed = 0;
  const id = nativeSearch.createNativeSearch("owner", "account:kaata", () => dismissed++);
  nativeSearch.publishNativeSearch(id, createElement("Results", {}), false);
  const screen = host({ sessionId: id, ownerKey: "owner" });
  screen.render();
  assert.equal(screen.nativeDismiss(), true, "An idle native swipe removes its opening");
  assert.equal(dismissed, 1);
  assert.equal(nativeSearch.getNativeSearch(id), null);
}
{
  const id = nativeSearch.createNativeSearch("owner", "account:kaata", () => {});
  nativeSearch.publishNativeSearch(id, createElement("Results", {}), false);
  const screen = host({ sessionId: id, ownerKey: "owner" });
  screen.render();
  screen.pushDestination();
  assert.equal(
    nodes(screen.render()).some((node) => node.type === "ToastHost"),
    false,
    "A covered search cannot keep the toast host behind another route",
  );
  assert.equal(screen.back(), false, "A covered search does not intercept the destination's Back");
  nativeSearch.closeNativeSearch(id);
  screen.render();
  assert.deepEqual(
    screen.state.routes.map((route: any) => route.key),
    ["owner", "destination"],
  );
  assert.equal(screen.state.index, 1, "Targeted removal preserves the opened contact");
  screen.unmount();
}
{
  const missing = host({});
  assert.equal(
    nodes(missing.render()).some((node) => node.type === "ToastHost"),
    false,
  );
  assert.equal(
    nodes(missing.render()).some((node) => node.type === "Results"),
    false,
  );
  assert.equal(missing.dispatched.length, 1, "A cold /search cannot remain as a blank modal");
  missing.unmount();
  const restored = host({ sessionId: "unknown", ownerKey: "owner" }, { onlyRoute: true });
  restored.render();
  assert.deepEqual(restored.replacements, ["/"]);
  restored.unmount();
  let dismissed = 0;
  const id = nativeSearch.createNativeSearch("owner", "account:kaata", () => dismissed++);
  nativeSearch.publishNativeSearch(id, createElement("PrivateResults", {}), false);
  const foreign = host({ sessionId: id, ownerKey: "different-owner" });
  assert.equal(
    nodes(foreign.render()).some((node) => node.type === "PrivateResults"),
    false,
  );
  foreign.unmount();
  assert.ok(
    nativeSearch.getNativeSearch(id),
    "A malformed route cannot delete another owner's session",
  );
  assert.equal(dismissed, 0);
  const orphan = host({ sessionId: id, ownerKey: "owner" }, { noOwner: true });
  assert.equal(
    nodes(orphan.render()).some((node) => node.type === "PrivateResults"),
    false,
  );
  assert.deepEqual(orphan.replacements, ["/"]);
  orphan.unmount();
}
{
  let emissions = 0,
    dismissed = 0;
  const unsubscribe = nativeSearch.subscribeNativeSearch(() => emissions++);
  const id = nativeSearch.createNativeSearch("owner", "account:kaata", () => dismissed++);
  nativeSearch.publishNativeSearch(id, createElement("PrivateResults", {}), true);
  let afterClose = 0;
  assert.equal(
    nativeSearch.afterNativeSearchClosed("missing-context", () => afterClose++),
    false,
  );
  assert.equal(
    nativeSearch.afterNativeSearchClosed("account:kaata", () => afterClose++),
    true,
  );
  nativeSearch.closeNativeSearch(id, true, true);
  assert.equal(
    nativeSearch.getNativeSearch(id)?.content,
    null,
    "Context invalidation clears busy data",
  );
  assert.equal(nativeSearch.getNativeSearch(id)?.busy, false);
  nativeSearch.publishNativeSearch(id, createElement("StaleResults", {}), false);
  assert.equal(
    nativeSearch.getNativeSearch(id)?.content,
    null,
    "A closed owner cannot republish stale data",
  );
  nativeSearch.removeNativeSearch(id);
  assert.equal(dismissed, 1);
  nativeSearch.completeNativeSearchClose("different-owner");
  assert.equal(afterClose, 0, "Another owner's transition cannot run this destination");
  nativeSearch.completeNativeSearchClose("owner");
  nativeSearch.completeNativeSearchClose("owner");
  assert.equal(afterClose, 1, "The intended owner completes its destination once");
  assert.ok(emissions >= 3);
  unsubscribe();
  const previous = emissions;
  nativeSearch.removeNativeSearch("missing");
  assert.equal(emissions, previous);
}
console.log(
  "PASS search: native Add Customer content shell, RTL/platform keyboard controls, live session publishing, native Back/swipe/busy guards, targeted navigation, reopen isolation and invalid-session privacy",
);
