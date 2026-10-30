// Executes the real note card at native layout/async boundaries. Text line
// measurement is synthetic here; native typography remains a device check.
import assert from "node:assert/strict";
import { compileUI, deferred, flattenStyle, jsx, nodes, settleUI, uiHooks } from "./ui-fixture";

const language = compileUI("../i18n", {
  "expo-localization": { getLocales: () => [{ languageCode: "en" }] },
  "./db": { getAppMeta: async () => null },
}) as typeof import("../i18n");
const words = (node: any): string =>
  Array.isArray(node)
    ? node.map(words).join("")
    : typeof node === "string" || typeof node === "number"
      ? String(node)
      : node?.props
        ? words(node.props.children)
        : "";
const actor = (name: string | null = "Ahmad", isSelf = false) => ({
  accountId: isSelf ? "PRIVATE-SELF-ID" : "PRIVATE-MEMBER-ID",
  name,
  isSelf,
});
const revision = (
  eventId: string,
  note: string | null,
  at: number,
  name: string | null = "Ahmad",
) => ({
  eventId,
  note,
  at,
  actor: actor(name),
});
const detailsFor = (note: string | null) => ({
  note,
  author: null as any,
  updated: null as any,
  history: [] as any[],
  hasMoreHistory: false,
  historyCursor: null as string | null,
});

function fixture(platform: "ios" | "android", initialLocale: "en" | "fa" | "ps") {
  const hooks = uiHooks();
  let locale = initialLocale;
  let dimensions = { width: 390, height: 844, scale: 3, fontScale: 1 };
  let current = true;
  let edits = 0;
  let loadImpl: (cursor: string) => Promise<any> = async () => ({
    entries: [],
    nextCursor: null,
    hasMore: false,
  });
  const loads: string[] = [];
  const nativeScrollRefs: unknown[] = [];
  const renderPart = (part: any) => (typeof part === "function" ? part() : part);
  const runtimeJSX = (type: any, props: any) => {
    if (typeof type === "function" && type.name === "NoteHistorySheet") return type(props);
    // Execute the native list render callbacks so real revision/header/footer
    // controls stay covered. Actual windowing remains the FlatList boundary.
    if (type === "FlatList")
      return jsx(type, {
        ...props,
        children: [
          renderPart(props.ListHeaderComponent),
          ...props.data.flatMap((item: any, index: number) => [
            index > 0 ? renderPart(props.ItemSeparatorComponent) : null,
            props.renderItem({ item, index }),
          ]),
          renderPart(props.ListFooterComponent),
        ],
      });
    return jsx(type, props);
  };
  const Component = compileUI("../../components/CustomerNoteCard", {
    react: hooks.react,
    "react/jsx-runtime": { jsx: runtimeJSX, jsxs: runtimeJSX, Fragment: "Fragment" },
    "@expo/vector-icons": { Ionicons: "Icon" },
    "react-native": {
      ActivityIndicator: "Spinner",
      Animated: { View: "AnimatedView" },
      FlatList: "FlatList",
      Keyboard: { dismiss: () => {} },
      Platform: { OS: platform },
      Pressable: "Pressable",
      ScrollView: "ScrollView",
      StyleSheet: {
        create: (style: any) => style,
        flatten: flattenStyle,
        hairlineWidth: 1,
        absoluteFill: { position: "absolute" },
      },
      Text: "Text",
      View: "View",
      useWindowDimensions: () => dimensions,
    },
    "../lib/attribution": {
      initialOf: (name: string | null) => name?.[0] ?? "?",
      memberTintFor: () => ({ bg: "lightblue", fg: "blue" }),
    },
    "../lib/calendar": { useCalendar: () => "gregorian" },
    "../lib/colors": require("../colors"),
    "../lib/direction": {
      bidiIsolate: (value: string) => `\u2068${value}\u2069`,
      rowDir: (rtl: boolean) => ({ flexDirection: rtl ? "row-reverse" : "row" }),
      textDir: (rtl: boolean) => ({ textAlign: rtl ? "right" : "left" }),
      useIsRTL: () => locale !== "en",
    },
    "../lib/fonts": {
      fonts: { sansRegular: "regular", sansMedium: "medium", sansSemi: "semi" },
      sansLineHeight: (size: number) => size * 1.5,
    },
    "../lib/format": {
      formatTimestamp: (at: number) => `TIMESTAMP(${at})`,
      formatRelative: (at: number) => `RELATIVE(${at})`,
    },
    "../lib/i18n": {
      getLocale: () => locale,
      t: (key: any, vars?: any) => language.tIn(locale, key, vars),
    },
    "../lib/tokens": { radius: { sm: 8, sheet: 18 }, TOUCH_MIN: 44 },
    "../lib/use-overlay-animation": {
      useOverlayAnimation: (visible: boolean) => ({ rendered: visible, opacity: 1, position: 0 }),
    },
    "../lib/use-sheet-drag": {
      useSheetDrag: (_visible: boolean, _position: unknown, onDismiss: () => void) => ({
        translateY: 0,
        dismiss: onDismiss,
        surfacePanHandlers: {},
        panHandlers: {},
        scrollProps: { ref: (value: unknown) => nativeScrollRefs.push(value) },
      }),
    },
    "./ProtectedModal": { ProtectedModal: "Modal" },
    "./SheetBackdrop": { SheetBackdrop: "SheetBackdrop" },
    "./SheetHandle": { SheetHandle: "SheetHandle" },
    "./SheetSurface": { SheetSurface: "SheetSurface" },
    "./InitialAvatar": { InitialAvatar: "InitialAvatar" },
  }).CustomerNoteCard;
  let props: any = {
    scopeKey: "account:kaata:customer",
    details: detailsFor("Call before delivery."),
    onEdit: () => edits++,
    isCurrent: () => current,
    loadMoreHistory: async (cursor: string) => {
      loads.push(cursor);
      return loadImpl(cursor);
    },
  };
  const render = (next: any = {}) => {
    props = { ...props, ...next };
    return hooks.render(() => Component(props));
  };
  const byId = (id: string) => nodes(hooks.tree).find((node) => node.props.testID === id);
  const measure = (lineCount: number) => {
    const node = byId("customer-note-measure");
    assert.ok(node, "Unclamped measurement text must exist until current content is classified");
    node.props.onTextLayout({
      nativeEvent: { lines: Array.from({ length: lineCount }, () => ({})) },
    });
    render();
  };
  const layoutWidth = (width: number) => {
    byId("customer-note-text-layout")!.props.onLayout({ nativeEvent: { layout: { width } } });
    render();
  };
  return {
    hooks,
    render,
    byId,
    measure,
    layoutWidth,
    get props() {
      return props;
    },
    get edits() {
      return edits;
    },
    loads,
    nativeScrollRefs,
    setLoad(fn: typeof loadImpl) {
      loadImpl = fn;
    },
    setCurrent(value: boolean) {
      current = value;
    },
    setLocale(value: typeof locale) {
      locale = value;
    },
    setDimensions(next: Partial<typeof dimensions>) {
      dimensions = { ...dimensions, ...next };
    },
  };
}

async function main() {
  for (const locale of ["en", "fa", "ps"] as const)
    for (const key of [
      "customerNote.authorUnavailable",
      "customerNote.firstRecordedBy",
      "customerNote.updatedBy",
      "customerNote.history",
      "customerNote.historyTitle",
      "customerNote.cleared",
      "customerNote.saved",
      "customerNote.current",
      "customerNote.by",
      "customerNote.olderChanges",
      "customerNote.historyFailed",
    ] as const) {
      const translated = language.tIn(locale, key, { name: "Sara" });
      assert.ok(translated && translated !== key, `${locale}: ${key} must be translated`);
      if (key.endsWith("By") || key === "customerNote.by")
        assert.ok(translated.includes("Sara"), `${locale}: ${key} must identify the writer`);
    }
  let scenarios = 0;
  for (const platform of ["ios", "android"] as const)
    for (const locale of ["en", "fa", "ps"] as const) {
      const f = fixture(platform, locale);
      f.render();
      f.layoutWidth(342);
      assert.equal(
        f.byId("customer-note-disclosure"),
        undefined,
        "No speculative disclosure before measurement",
      );
      assert.equal(f.byId("customer-note-value")!.props.numberOfLines, 3);
      f.measure(1);
      assert.equal(f.byId("customer-note-disclosure"), undefined, "Short notes need no disclosure");
      const edit = f.byId("customer-note-edit")!;
      assert.equal(
        flattenStyle(edit.props.style).right,
        2,
        "Edit stays physically right in every language",
      );
      assert.equal(flattenStyle(edit.props.style).top, 2, "Edit sits at the top of the card");
      edit.props.onPress();
      assert.equal(f.edits, 1);
      f.render({ onEdit: undefined });
      assert.equal(f.byId("customer-note-edit"), undefined, "View-only staff have no Edit action");

      const longNote =
        "A longer customer instruction.\nCall their son.\nAsk for the receipt.\nAfter four.";
      f.render({ details: detailsFor(longNote) });
      f.measure(4);
      const disclosure = f.byId("customer-note-disclosure")!;
      assert.ok(disclosure);
      assert.ok(words(disclosure).includes(language.tIn(locale, "common.more")));
      assert.ok(
        !nodes(disclosure).some((node) => node.type === "Icon"),
        "Disclosure uses text, not a chevron",
      );
      disclosure.props.onPress();
      f.render();
      assert.equal(f.byId("customer-note-value")!.props.numberOfLines, undefined);
      assert.ok(
        words(f.byId("customer-note-disclosure")).includes(language.tIn(locale, "common.less")),
      );
      f.byId("customer-note-disclosure")!.props.onPress();
      f.render();
      assert.equal(f.byId("customer-note-value")!.props.numberOfLines, 3);

      f.render({ details: detailsFor("Exactly three lines fit.") });
      f.measure(3);
      assert.equal(
        f.byId("customer-note-disclosure"),
        undefined,
        "Three fitting lines do not need more",
      );
      f.setDimensions({ fontScale: 1.8 });
      f.render();
      f.measure(5);
      assert.ok(f.byId("customer-note-disclosure"), "Larger system type is remeasured");
      f.setDimensions({ width: 844, height: 390 });
      f.render();
      f.layoutWidth(796);
      const staleLayout = f.byId("customer-note-measure")!.props.onTextLayout;
      f.measure(2);
      assert.equal(
        f.byId("customer-note-disclosure"),
        undefined,
        "Wider layout removes unnecessary disclosure",
      );

      f.render({ details: detailsFor("New short note") });
      staleLayout({ nativeEvent: { lines: Array.from({ length: 9 }, () => ({})) } });
      f.render();
      assert.equal(
        f.byId("customer-note-disclosure"),
        undefined,
        "Late previous-text measurements cannot classify new text",
      );
      f.measure(1);
      f.setLocale(locale === "fa" ? "ps" : "fa");
      f.render();
      f.measure(4);
      assert.ok(f.byId("customer-note-disclosure"), "A live language change is remeasured");

      f.hooks.unmount();
      scenarios++;
    }
  console.log(
    `PASS customer note card: measured more/less, short notes, system type/resize, edit placement and view-only roles in ${scenarios} platform/language cases`,
  );

  for (const platform of ["ios", "android"] as const)
    for (const locale of ["en", "fa", "ps"] as const) {
      const f = fixture(platform, locale);
      const original = revision("original", "Call their son.", 100, "Sara");
      const edited = revision("edited", "Check the receipt before delivery.", 300, "Ahmad");
      f.render({
        details: {
          ...detailsFor(edited.note),
          author: original,
          updated: edited,
          history: [edited, original],
        },
      });
      const attribution = words(f.byId("customer-note-attribution"));
      for (const expected of ["Sara", "Ahmad", "TIMESTAMP(100)", "TIMESTAMP(300)"])
        assert.ok(attribution.includes(expected), `Inline attribution includes ${expected}`);
      assert.ok(
        !words(f.hooks.tree).includes("PRIVATE-MEMBER-ID"),
        "Internal account IDs are never user-facing names",
      );
      assert.equal(
        nodes(f.hooks.tree).find((node) => node.type === "Modal"),
        undefined,
      );
      f.byId("customer-note-history")!.props.onPress();
      f.render();
      assert.ok(
        nodes(f.hooks.tree).some((node) => node.type === "Modal"),
        "History uses the protected sheet host",
      );
      const list = nodes(f.hooks.tree).find((node) => node.type === "FlatList")!;
      assert.ok(list, "History virtualizes long revisions rather than mounting every note");
      assert.equal(list.props.initialNumToRender, 4);
      assert.equal(list.props.maxToRenderPerBatch, 4);
      assert.equal(list.props.windowSize, 5);
      const nativeScroll = { nativeHistoryScroll: true };
      list.props.ref({ getNativeScrollRef: () => nativeScroll });
      assert.equal(
        f.nativeScrollRefs.at(-1),
        nativeScroll,
        "Sheet dragging follows the native list scroll view",
      );
      list.props.ref(null);
      assert.equal(f.nativeScrollRefs.at(-1), null);
      assert.ok(words(f.byId("customer-note-revision-edited")).includes(edited.note!));
      assert.ok(words(f.byId("customer-note-revision-original")).includes(original.note!));
      assert.ok(words(f.byId("customer-note-revision-edited")).includes("TIMESTAMP(300)"));
      assert.ok(words(f.byId("customer-note-revision-original")).includes("Sara"));
      assert.ok(
        words(f.byId("customer-note-revision-edited")).includes(
          language.tIn(locale, "customerNote.current"),
        ),
      );
      nodes(f.hooks.tree)
        .find((node) => node.type === "Modal")!
        .props.onRequestClose();
      f.render();
      assert.equal(
        nodes(f.hooks.tree).find((node) => node.type === "Modal"),
        undefined,
      );

      const cleared = revision("cleared", null, 400, null);
      f.render({
        details: { ...detailsFor(null), updated: cleared, history: [cleared, edited, original] },
        onEdit: undefined,
      });
      assert.equal(
        f.byId("customer-note-measure"),
        undefined,
        "Cleared notes need no text measurement",
      );
      assert.equal(f.byId("customer-note-disclosure"), undefined);
      assert.ok(f.byId("customer-note-history"), "Cleared-note history stays reachable for staff");
      assert.ok(!words(f.hooks.tree).includes("PRIVATE-MEMBER-ID"));
      f.byId("customer-note-history")!.props.onPress();
      f.render();
      assert.ok(f.byId("customer-note-revision-cleared"));
      assert.ok(
        !words(f.byId("customer-note-revision-cleared")).includes("null"),
        "A removal is labelled rather than rendering null as note text",
      );
      assert.ok(words(f.byId("customer-note-revision-edited")).includes(edited.note!));
      f.hooks.unmount();
    }
  console.log(
    "PASS customer note attribution/history: authors, editors, exact timestamps, protected sheet, current version, unknown identities and cleared notes in all locales",
  );

  const f = fixture("android", "en");
  const latest = revision("latest", "Current staff instruction", 500);
  const details = {
    ...detailsFor(latest.note),
    author: latest,
    updated: latest,
    history: [latest],
    hasMoreHistory: true,
    historyCursor: "cursor-older",
  };
  f.render({ details });
  f.byId("customer-note-history")!.props.onPress();
  f.render();
  const pending = deferred<any>();
  f.setLoad(() => pending.promise);
  const more = f.byId("customer-note-history-more")!;
  more.props.onPress();
  more.props.onPress();
  f.render();
  assert.deepEqual(f.loads, ["cursor-older"], "Rapid taps start only one page request");
  assert.equal(f.byId("customer-note-history-more")!.props.disabled, true);
  pending.resolve({
    entries: [latest, revision("older", "Earlier staff instruction", 200)],
    nextCursor: null,
    hasMore: false,
  });
  await settleUI();
  f.render();
  assert.equal(
    nodes(f.hooks.tree).filter((node) => node.props.testID === "customer-note-revision-latest")
      .length,
    1,
    "Page overlap does not duplicate revisions",
  );
  assert.ok(f.byId("customer-note-revision-older"));
  assert.equal(
    f.byId("customer-note-history-more"),
    undefined,
    "Completed history has no endless older button",
  );
  f.hooks.unmount();

  const failed = fixture("android", "en");
  failed.render({ details });
  failed.byId("customer-note-history")!.props.onPress();
  failed.render();
  failed.setLoad(async () => {
    throw new Error("Synthetic history read failed");
  });
  failed.byId("customer-note-history-more")!.props.onPress();
  await settleUI();
  failed.render();
  assert.ok(
    failed.byId("customer-note-history-error"),
    "History errors are visible and recoverable",
  );
  assert.equal(failed.byId("customer-note-history-more")!.props.disabled, false);
  failed.setLoad(async () => ({
    entries: [revision("retried", "Recovered prior note", 100)],
    nextCursor: null,
    hasMore: false,
  }));
  failed.byId("customer-note-history-more")!.props.onPress();
  await settleUI();
  failed.render();
  assert.equal(failed.byId("customer-note-history-error"), undefined);
  assert.ok(failed.byId("customer-note-revision-retried"));
  failed.hooks.unmount();

  for (const exit of ["scope", "unmount", "no-longer-current"] as const) {
    const stale = fixture("ios", "fa");
    stale.render({ details });
    stale.byId("customer-note-history")!.props.onPress();
    stale.render();
    const read = deferred<any>();
    stale.setLoad(() => read.promise);
    stale.byId("customer-note-history-more")!.props.onPress();
    stale.render();
    if (exit === "scope")
      stale.render({
        scopeKey: "another-account:kaata:customer",
        details: detailsFor("Another customer's note"),
      });
    else if (exit === "unmount") stale.hooks.unmount();
    else stale.setCurrent(false);
    read.resolve({
      entries: [revision("private-old-customer", "PRIVATE OLD CUSTOMER VERSION", 50)],
      nextCursor: null,
      hasMore: false,
    });
    await settleUI();
    if (exit !== "unmount") stale.render();
    assert.equal(
      stale.hooks.lateWrites,
      0,
      "Settled history reads cannot write to an unmounted card",
    );
    assert.equal(
      stale.byId("customer-note-revision-private-old-customer"),
      undefined,
      "History cannot leak after account/customer scope changes",
    );
    if (exit !== "unmount") stale.hooks.unmount();
  }
  console.log(
    "PASS customer note paging: duplicate-tap guard, overlapping-page deduplication, finite history, retry and stale/unmounted/scope isolation",
  );
}

void main();
