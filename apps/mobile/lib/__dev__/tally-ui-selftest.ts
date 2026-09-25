// Render the real row with mocked native primitives. Pins UI behavior; this
// does NOT replace Yoga/device layout checks on iOS and Android.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";

type Node = { type: string; props: Record<string, any> };
const jsx = (type: string, props: Record<string, any>): Node => ({ type, props });
let slots: any[] = [],
  cursor = 0,
  rtl = false;
let capturedStyles: any;
const colors = require("../colors").colors;
const mocks: Record<string, any> = {
  "react/jsx-runtime": { jsx, jsxs: jsx, Fragment: "Fragment" },
  react: {
    memo: (f: any) => f,
    useState: (initial: any) => {
      const i = cursor++;
      if (!(i in slots)) slots[i] = initial;
      return [
        slots[i],
        (value: any) => {
          slots[i] = typeof value === "function" ? value(slots[i]) : value;
        },
      ];
    },
    useRef: (value: any) => {
      const i = cursor++;
      return (slots[i] ??= { current: value });
    },
  },
  "react-native": {
    Pressable: "Pressable",
    Text: "Text",
    View: "View",
    StyleSheet: {
      create: (s: any) => {
        capturedStyles = s;
        return s;
      },
      hairlineWidth: 1,
    },
    Platform: { select: (s: any) => s.ios },
  },
  "@expo/vector-icons": { Ionicons: "Icon" },
  "./InitialAvatar": { InitialAvatar: "Avatar" },
  "../lib/attribution": { chipActorFor: () => null },
  "../lib/calendar": { useCalendar() {} },
  "../lib/colors": { colors },
  "../lib/currency": { getCurrentCurrencySymbol: () => "AFN" },
  "../lib/direction": {
    useIsRTL: () => rtl,
    rowDir: (r: boolean) => ({ flexDirection: r ? "row-reverse" : "row" }),
    textDir: (r: boolean) => ({ textAlign: r ? "right" : "left" }),
  },
  "../lib/fonts": {
    fonts: { sansRegular: "Regular", sansBold: "Bold" },
    sansLineHeight: (_: number, h: number) => h,
  },
  "../lib/format": {
    formatAmount: String,
    formatRelative: () => "yesterday",
    formatTimestamp: () => "12:15 PM",
  },
  "../lib/tokens": { radius: { sm: 8, md: 12, pill: 999 } },
  "../lib/i18n": {
    t: (key: string, vars?: Record<string, string>) => {
      let value = key;
      if (key === "tab.addedBy" || key === "entry.addedBy")
        value = rtl ? "ثبت‌شده توسط {name}" : "Added by {name}";
      if (key === "entry.editedBy") value = rtl ? "ویرایش توسط {name}" : "edited by {name}";
      for (const [k, v] of Object.entries(vars ?? {})) value = value.replaceAll("{" + k + "}", v);
      return value;
    },
  },
};
function compile(source: string) {
  const out = {};
  const js = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      jsx: ts.JsxEmit.ReactJSX,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  new Function("require", "exports", js)((name: string) => {
    assert.ok(name in mocks, "unexpected native dependency: " + name);
    return mocks[name];
  }, out);
  return out as any;
}
const { EntryRow } = compile(readFileSync(require.resolve("../../components/EntryRow"), "utf8"));
function nodes(n: any): Node[] {
  if (Array.isArray(n)) return n.flatMap(nodes);
  if (!n || typeof n !== "object") return [];
  return [n, ...nodes(n.props?.children)];
}
function words(n: any): string {
  if (Array.isArray(n)) return n.map(words).join("");
  return typeof n === "string" ? n : n?.props ? words(n.props.children) : "";
}
const style = (s: any): any =>
  Array.isArray(s) ? Object.assign({}, ...s.filter(Boolean).map(style)) : s;
const base = {
  entry: { id: "1", type: "debt", amount_afn: 10, created_at: 1000, note: "Goods" },
  onAccept() {},
  onReject() {},
};
function render(props: any) {
  cursor = 0;
  return EntryRow(props);
}
function opened(props: any) {
  slots = [];
  const closed = render(props);
  nodes(closed)
    .find((n) => n.type === "Pressable")!
    .props.onPress();
  return render(props);
}
for (const isRTL of [false, true]) {
  rtl = isRTL;
  for (const status of ["pending", "accepted", "disputed"]) {
    const tree = opened({
      ...base,
      tab: { by: "them", status, other_label: "Shop", author_name: "احمد" },
    });
    const buttons = nodes(tree).filter(
      (n) =>
        n.type === "Pressable" && ["tab.accept", "tab.reject"].includes(n.props.accessibilityLabel),
    );
    assert.equal(
      buttons.length,
      status === "pending" ? 2 : 0,
      "opening reviewed rows must not resurrect actions",
    );
    const author = nodes(tree).find((n) => n.type === "Text" && n.props.numberOfLines === 2)!;
    assert.equal(style(author.props.style).textAlign, rtl ? "left" : "right", "same edge as date");
    const name = nodes(author).find((n) => n.type === "Text" && n.props.children === "احمد")!;
    assert.equal(style(name.props.style).fontFamily, "Bold");
    assert.equal(words(author), rtl ? "ثبت‌شده توسط احمد" : "Added by احمد");
    const statusKey =
      status === "pending" ? "new" : status === "accepted" ? "accepted" : "disputed";
    const statusPill = nodes(tree).find(
      (n) => n.type === "View" && n.props.accessibilityLabel === "tab.status." + statusKey,
    )!;
    assert.equal(
      style(statusPill.props.style).backgroundColor,
      status === "pending"
        ? colors.pendingBg
        : status === "accepted"
          ? colors.acceptedBg
          : colors.rejectedBg,
    );
    if (status === "disputed") {
      const pill = nodes(tree).find(
        (n) => n.type === "View" && n.props.accessibilityLabel === "tab.status.disputed",
      )!;
      assert.equal(style(pill.props.style).backgroundColor, colors.rejectedBg);
      const amount = nodes(tree).find((n) => n.type === "Text" && n.props.children === "10")!;
      assert.equal(style(amount.props.style).textDecorationLine, "line-through");
    }
  }
  const voided = opened({ ...base, tab: { by: "me", status: "accepted", voided: true } });
  assert.equal(
    nodes(voided).filter((n) => n.type === "Text" && n.props.children === "tab.status.voided")
      .length,
    1,
    "Voided appears only in the date pill",
  );
  const voidPill = nodes(voided).find(
    (n) => n.type === "View" && n.props.accessibilityLabel === "tab.status.voided",
  )!;
  assert.equal(style(voidPill.props.style).backgroundColor, colors.rejectedBg);
  const sent = opened({ ...base, tab: { by: "me", status: "pending", author_name: "Matee" } });
  const pendingPill = nodes(sent).find(
    (n) => n.type === "View" && n.props.accessibilityLabel === "tab.status.pending",
  )!;
  assert.equal(style(pendingPill.props.style).backgroundColor, colors.pendingBg);
  const member = opened({
    ...base,
    attribution: {
      author: { name: "Matee", isSelf: false },
      editor: { name: "Ahmad", isSelf: false },
    },
  });
  assert.equal(
    nodes(member).filter((n) => n.type === "Text" && style(n.props.style)?.fontFamily === "Bold")
      .length,
    2,
  );
}

// Execute the shipped style declarations, not a second copied fixture.
const person = readFileSync(require.resolve("../../app/person/[id]"), "utf8");
compile(
  'const { StyleSheet, Platform } = require("react-native"); const { colors } = require("../lib/colors"); const { fonts, sansLineHeight } = require("../lib/fonts"); const { radius } = require("../lib/tokens"); const typography = {}; const TOUCH_MIN = 44; const ACTION_COIN_SIZE = 26; ' +
    person.slice(person.indexOf("const styles = StyleSheet.create(")),
);
assert.equal(capturedStyles.actions.position, "absolute");
assert.equal(capturedStyles.actions.bottom, 0);
assert.equal(capturedStyles.actionBtn.flex, undefined, "no vertical flex collapse");
assert.ok(capturedStyles.actionBtn.minHeight >= 52);
assert.equal(capturedStyles.actionBtnWrap.flex, 1, "equal-width buttons");
assert.equal(capturedStyles.actionText.color, colors.textInverted);
assert.ok(capturedStyles.actionText.lineHeight >= 20, "visible Dari line box");
assert.match(person, /translateY: toastOffset/);
assert.ok(
  person.indexOf('label: t("person.ping"') <
    person.indexOf('label: t("person.sheet.edit"', person.indexOf("<OverflowMenu")),
);
console.log(
  "PASS: final review controls, bold/date-side names in EN/FA, one void label, muted rejection, floating full-size button styles",
);

// Render the real bell/header against different safe viewports. In particular,
// the preview must not retain an x-coordinate from the bell or a 380px width cap.
let viewport = { width: 390, height: 844 };
let insets = { top: 47, bottom: 34, left: 0, right: 0 };
mocks.react.useEffect = () => {};
Object.assign(mocks["react-native"], {
  Modal: "Modal",
  ScrollView: "ScrollView",
  ActivityIndicator: "ActivityIndicator",
  useWindowDimensions: () => viewport,
});
Object.assign(mocks["../lib/tokens"], { TOUCH_MIN: 44, typography: {}, icon: {} });
mocks["expo-router"] = { router: { push() {}, back() {} } };
mocks["react-native-safe-area-context"] = {
  useSafeAreaInsets: () => insets,
  SafeAreaView: "SafeAreaView",
};
mocks["./Toast"] = { useToast: () => ({ push() {} }) };
mocks["../lib/tabs/use-inbox"] = {
  useInbox: () => ({
    page: { unread: 2, items: [], next_before: "" },
    loading: false,
    failed: false,
    signedIn: true,
    reload: async () => {},
    read: async () => {},
  }),
};
mocks["../lib/tabs/open-notification"] = { openTabNotification: async () => {} };
const { NotificationBell, FullNotificationInbox } = compile(
  readFileSync(require.resolve("../../components/NotificationInbox"), "utf8"),
);
for (const width of [320, 390, 430, 844]) {
  viewport = { width, height: width === 844 ? 390 : 844 };
  insets = { top: 47, bottom: 34, left: width === 844 ? 47 : 0, right: 0 };
  for (const r of [false, true]) {
    rtl = r;
    slots = [];
    cursor = 0;
    const tree = NotificationBell();
    const anchor = nodes(tree).find((n) => n.props.ref)!;
    anchor.props.ref.current = {
      measureInWindow: (callback: any) => callback(r ? 30 : width - 90, 48, 44, 44),
    };
    nodes(tree)
      .find((n) => n.type === "Pressable")!
      .props.onPress();
    cursor = 0;
    const opened = NotificationBell();
    const popup = nodes(opened).find((n) => n.props.accessibilityViewIsModal)!;
    const frame = style(popup.props.style);
    assert.equal(frame.left, frame.right, "equal margins independent of bell/locale");
    assert.equal(frame.left, Math.max(12, insets.left + 12, insets.right + 12));
    assert.equal(frame.width, undefined, "stretch across viewport without fixed width cap");
    assert.ok(frame.top >= insets.top);
  }
}
mocks["../components/NotificationInbox"] = { FullNotificationInbox: "FullInbox" };
const { default: NotificationsScreen } = compile(
  readFileSync(require.resolve("../../app/notifications"), "utf8"),
);
const screen = NotificationsScreen();
const header = nodes(screen).find((n) => n.props.accessibilityRole === "header")!;
assert.equal(style(header.props.style).textAlign, "center");
assert.equal(style(header.props.style).flex, 1);
const bar = nodes(screen).find(
  (n) => Array.isArray(n.props.children) && n.props.children.includes(header),
)!;
assert.equal(
  style(bar.props.children[0].props.style).minWidth,
  style(bar.props.children[2].props.style).width,
  "symmetric back-button and spacer",
);
slots = [];
cursor = 0;
const content = FullNotificationInbox();
const renderedContent = content.type(content.props);
assert.equal(
  nodes(renderedContent).filter((n) => n.type === "Text" && n.props.children === "inbox.title")
    .length,
  0,
  "page title is not duplicated in the list",
);
console.log(
  "PASS: centered edge-to-edge inbox in EN/FA at 320/390/430/844px, symmetric page header, no duplicate title",
);

// The identity badge stays a fixed centered scalloped glyph, not a menu icon.
mocks["@expo/vector-icons"].MaterialIcons = "MaterialIcon";
const { SharedAccountBadge } = compile(
  readFileSync(require.resolve("../../components/SharedAccountBadge"), "utf8"),
);
const badge = SharedAccountBadge({ size: 20 });
assert.equal(style(badge.props.style).alignItems, "center");
assert.equal(style(badge.props.style).justifyContent, "center");
assert.equal(style(badge.props.style).flexShrink, 0);
assert.equal(nodes(badge).find((n) => n.type === "MaterialIcon")?.props.name, "verified");
assert.match(person, /icon: "link-outline" as const/);
assert.equal(person.includes('t("tab.chip.linked"'), false);

// A highlight never intercepts a row tap; its cue fades rather than staying on.
let timing: any,
  started = false,
  stopped = false,
  cleanup: any;
mocks.react.useEffect = (fn: any) => {
  cleanup = fn();
};
mocks["react-native"].StyleSheet.absoluteFill = {
  position: "absolute",
  top: 0,
  bottom: 0,
  left: 0,
  right: 0,
};
mocks["react-native"].Animated = {
  View: "AnimatedView",
  Value: class {
    constructor(public value: number) {}
    setValue(n: number) {
      this.value = n;
    }
  },
  timing: (_: any, opts: any) => {
    timing = opts;
    return {
      start() {
        started = true;
      },
      stop() {
        stopped = true;
      },
    };
  },
};
const { TallyHighlight } = compile(
  readFileSync(require.resolve("../../components/TallyHighlight"), "utf8"),
);
slots = [];
cursor = 0;
const glow = TallyHighlight({ requestKey: "tap" });
assert.equal(glow.props.pointerEvents, "none");
assert.equal(glow.props.accessible, false);
assert.equal(timing.toValue, 0);
assert.equal(timing.duration + timing.delay, 2900);
assert.equal(timing.useNativeDriver, true);
assert.equal(started, true);
cleanup();
assert.equal(stopped, true);
console.log(
  "PASS: centered scalloped identity badge, link action icon, touch-through 2.9s highlight with cleanup",
);
