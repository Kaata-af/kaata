// The home bell's unread badge, pinned by arithmetic: mono digits whose line
// box is EXACTLY the circle's inner height, on BOTH platforms. The old style
// inherited typography.caption (Vazirmatn 11px, sansLineHeight(11, 15)),
// which iOS floors to 18px — taller than the 17px circle — and which Android
// renders with the font's Persian-ascender headroom above the digits; the
// number sat low and off-centre either way (Matee, 2026-09). This compiles the
// shipped component against the REAL lib/fonts.ts with Platform.OS stubbed to
// each platform, so the assertions are on monoLineHeight's actual answer, not
// on a mock's. Yoga layout itself still needs a phone.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";

type Node = { type: string; props: Record<string, any> };
const jsx = (type: string, props: Record<string, any>): Node => ({ type, props });

function compile(file: string, mocks: Record<string, any>) {
  const out = {};
  const js = ts.transpileModule(readFileSync(require.resolve(file), "utf8"), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      jsx: ts.JsxEmit.ReactJSX,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  new Function("require", "exports", js)((name: string) => {
    assert.ok(name in mocks, "unexpected dependency: " + name);
    return mocks[name];
  }, out);
  return out as any;
}

function nodes(n: any): Node[] {
  if (Array.isArray(n)) return n.flatMap(nodes);
  if (!n || typeof n !== "object") return [];
  return [n, ...nodes(n.props?.children)];
}

// The font packages export their face names; lib/fonts.ts re-exports them as
// strings and only calls the loader hook from useAppFonts, never here.
const faces = (names: string[]) => Object.fromEntries(names.map((n) => [n, n]));
const fontPackages = {
  "@expo-google-fonts/inter": {
    ...faces(["Inter_400Regular", "Inter_500Medium", "Inter_600SemiBold", "Inter_700Bold"]),
    useFonts: () => [true, null],
  },
  "@expo-google-fonts/jetbrains-mono": faces([
    "JetBrainsMono_400Regular",
    "JetBrainsMono_500Medium",
    "JetBrainsMono_600SemiBold",
    "JetBrainsMono_700Bold",
  ]),
  "@expo-google-fonts/vazirmatn": faces([
    "Vazirmatn_400Regular",
    "Vazirmatn_500Medium",
    "Vazirmatn_600SemiBold",
    "Vazirmatn_700Bold",
  ]),
};
const realFonts = (os: "ios" | "android") =>
  compile("../fonts", { "react-native": { Platform: { OS: os } }, ...fontPackages });

const TOUCH_MIN = 44;
let unread = 0;
for (const os of ["ios", "android"] as const) {
  const fonts = realFonts(os);
  // The premise, on the real helper: JetBrains Mono at 10px is 14 natural
  // (ceil 13.2), so the 15 the badge asks for stands on both platforms —
  // while the old caption face at 11px floors to 18 on iOS, taller than the
  // 17px circle it had to fit in.
  assert.equal(fonts.monoLineHeight(10, 15), 15, os + ": monoLineHeight(10, 15)");
  assert.equal(fonts.sansLineHeight(11, 15), os === "ios" ? 18 : 15, os + ": old caption box");

  let styles: any;
  let slots: any[] = [];
  let cursor = 0;
  const mocks: Record<string, any> = {
    "react/jsx-runtime": { jsx, jsxs: jsx, Fragment: "Fragment" },
    react: {
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
      useEffect: () => {},
    },
    "react-native": {
      ActivityIndicator: "ActivityIndicator",
      Modal: "Modal",
      Pressable: "Pressable",
      ScrollView: "ScrollView",
      Text: "Text",
      View: "View",
      StyleSheet: {
        create: (s: any) => {
          styles = s;
          return s;
        },
        absoluteFill: {},
        hairlineWidth: 1,
      },
      useWindowDimensions: () => ({ width: 390, height: 844 }),
    },
    "expo-router": { router: { push() {} } },
    "react-native-safe-area-context": {
      useSafeAreaInsets: () => ({ top: 47, bottom: 34, left: 0, right: 0 }),
    },
    "@expo/vector-icons": { Ionicons: "Icon" },
    "../lib/colors": { colors: require("../colors").colors },
    "../lib/direction": { useIsRTL: () => false, rowDir: () => ({}), textDir: () => ({}) },
    "../lib/fonts": fonts,
    "../lib/format": { formatRelative: () => "now" },
    "../lib/i18n": { t: (key: string) => key },
    "../lib/tokens": { TOUCH_MIN, typography: {}, icon: { row: 22 }, radius: { lg: 16 } },
    "../lib/tabs/use-inbox": {
      useInbox: () => ({
        page: { unread, items: [], next_before: "", latest_id: "0" },
        loading: false,
        failed: false,
        signedIn: true,
        reload: async () => {},
        read: async () => {},
      }),
    },
    "../lib/tabs/open-notification": { openTabNotification: async () => {} },
    "./Toast": { useToast: () => ({ push() {} }) },
  };
  const { NotificationBell } = compile("../../components/NotificationInbox", mocks);
  const { count, countText, bell } = styles;

  // The circle: unchanged size, colour and corner position.
  assert.equal(count.height, 17, os + ": the circle keeps its size");
  assert.equal(count.position, "absolute");
  assert.equal(count.right, 1);
  assert.equal(count.top, 0);
  assert.equal(count.backgroundColor, require("../colors").colors.sharedAccount);
  assert.equal(count.borderWidth, 1);
  assert.equal(count.borderRadius, count.height / 2, os + ": radius is size/2");
  assert.ok(count.minWidth >= count.height, os + ": one digit still sits in a full circle");
  assert.ok(count.paddingHorizontal >= 4, os + ": 99+ gets air on both sides");
  assert.equal(count.alignItems, "center");
  assert.equal(count.justifyContent, "center");

  // The digits: a line box exactly as tall as the inside of the circle, in
  // the mono face, centred on both axes, no font padding, no tracking.
  assert.equal(
    count.height,
    count.borderWidth * 2 + countText.lineHeight,
    os + ": line box = circle inner height",
  );
  assert.equal(countText.lineHeight, 15, os + ": 15px line box");
  assert.equal(countText.fontSize, 10);
  assert.equal(countText.fontFamily, fonts.fonts.monoSemi);
  assert.equal(countText.fontFamily, "JetBrainsMono_600SemiBold");
  assert.equal(countText.textAlign, "center");
  assert.equal(countText.textAlignVertical, "center");
  assert.equal(countText.includeFontPadding, false);
  assert.equal(countText.letterSpacing, undefined, os + ": no tracking");

  // The bell itself is still a full touch target.
  assert.equal(bell.minWidth, TOUCH_MIN);
  assert.equal(bell.minHeight, TOUCH_MIN);

  // Rendered: 150 unread reads "99+" on ONE line, unscaled, in the badge
  // style; zero unread renders no badge at all.
  unread = 150;
  slots = [];
  cursor = 0;
  const label = nodes(NotificationBell()).find(
    (n) => n.type === "Text" && n.props.style === countText,
  );
  assert.ok(label, os + ": badge text rendered");
  assert.equal(label!.props.children, "99+");
  assert.equal(label!.props.numberOfLines, 1);
  assert.equal(label!.props.allowFontScaling, false);
  unread = 0;
  slots = [];
  cursor = 0;
  assert.equal(
    nodes(NotificationBell()).some((n) => n.type === "Text" && n.props.style === countText),
    false,
    os + ": no badge at zero",
  );
}
console.log(
  "PASS: bell badge — mono digits in a 15px line box inside the 17px circle on iOS and Android, 99+ on one line, TOUCH_MIN kept",
);
