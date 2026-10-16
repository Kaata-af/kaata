// Execute the real provider/host lifecycle with native drawing mocked. The
// search route test separately checks that its host is inside the native sheet.
import assert from "node:assert/strict";
import { compileUI, jsx, nodes, uiHooks, type UINode } from "./ui-fixture";

const providerHooks = uiHooks();
let currentHooks = providerHooks;
const contextValues = new Map<object, unknown>();
const announcements: string[] = [];
const timers = new Map<number, () => void>();
let nextTimer = 0;
const hook =
  (name: keyof typeof providerHooks.react) =>
  (...args: any[]) =>
    (currentHooks.react[name] as (...values: any[]) => any)(...args);
const react = {
  ...Object.fromEntries(Object.keys(providerHooks.react).map((name) => [name, hook(name as any)])),
  useLayoutEffect: hook("useEffect"),
  createContext: (initial: unknown) => {
    const context = { Provider: {} };
    contextValues.set(context.Provider, initial);
    return context;
  },
  useContext: (context: { Provider: object }) => contextValues.get(context.Provider),
};
const { ToastProvider, ToastHost, useToast, queuePendingToast } = compileUI(
  "../../components/Toast",
  {
    react,
    "react/jsx-runtime": { jsx, jsxs: jsx },
    "@expo/vector-icons": { Ionicons: "Icon" },
    "react-native": {
      AccessibilityInfo: {
        announceForAccessibility: (message: string) => announcements.push(message),
      },
      Animated: {},
      Platform: { OS: "ios", select: (options: any) => options.ios },
      StyleSheet: { create: (styles: unknown) => styles },
      Text: "Text",
      View: "View",
    },
    "react-native-gesture-handler": {},
    "react-native-safe-area-context": { useSafeAreaInsets: () => ({ bottom: 20 }) },
    "../lib/colors": { colors: {} },
    "../lib/direction": {},
    "../lib/fonts": { fonts: {}, sansLineHeight: (_size: number, height: number) => height },
  },
  {
    setTimeout: (callback: () => void, delay: number) => {
      assert.equal(delay, 2500, "The existing feedback duration is preserved");
      const id = ++nextTimer;
      timers.set(id, callback);
      return id;
    },
  },
);

let rootViewport: UINode | null = null;
const renderProvider = () => {
  currentHooks = providerHooks;
  const tree = providerHooks.render(() => ToastProvider({ children: jsx("AppStack", {}) }));
  contextValues.set(tree.type, tree.props.value);
  const presentation = tree.props.children;
  contextValues.set(presentation.type, presentation.props.value);
  rootViewport = presentation.props.children[1];
};
const makeHost = () => {
  const hooks = uiHooks();
  return {
    render() {
      currentHooks = hooks;
      return hooks.render(() => ToastHost());
    },
    unmount: hooks.unmount,
  };
};
const messages = (viewport: UINode | null) => {
  if (!viewport) return [];
  // Execute the actual viewport, which positions the existing toast items.
  // Items' animation/gesture drawing is immaterial to queue ownership.
  const tree = viewport.type(viewport.props);
  return nodes(tree)
    .filter((node) => node.props.toast)
    .map((node) => node.props.toast.message);
};
const expire = (id: number) => {
  const callback = timers.get(id);
  assert.ok(callback);
  timers.delete(id);
  callback();
  renderProvider();
};

renderProvider();
const toast = useToast();
toast.push("2 customers removed", "success");
renderProvider();
assert.deepEqual(messages(rootViewport), ["2 customers removed"]);
assert.deepEqual(announcements, ["2 customers removed"]);
assert.equal(timers.size, 1);
const originalTimer = nextTimer;

const firstHost = makeHost();
firstHost.render();
renderProvider();
let firstViewport = firstHost.render();
assert.equal(rootViewport, null, "Root has no hidden duplicate while the sheet owns feedback");
assert.deepEqual(messages(firstViewport), ["2 customers removed"]);
assert.equal(useToast(), toast, "Moving feedback preserves the stable push context");
assert.equal(timers.size, 1, "Host mounting does not restart or duplicate expiry");
assert.deepEqual(announcements, ["2 customers removed"], "Host mounting does not announce again");

// A new search can mount before an old route finishes unmounting. Only the
// newer surface should display feedback; late cleanup cannot steal its queue.
const secondHost = makeHost();
secondHost.render();
renderProvider();
assert.equal(firstHost.render(), null, "Older hosts cannot display a second copy");
assert.deepEqual(messages(secondHost.render()), ["2 customers removed"]);
firstHost.unmount();
renderProvider();
assert.equal(rootViewport, null, "Older cleanup leaves the newer host active");
assert.deepEqual(messages(secondHost.render()), ["2 customers removed"]);
expire(originalTimer);
assert.deepEqual(messages(secondHost.render()), [], "Original expiry also removes sheet feedback");

queuePendingToast("1 customer could not be removed", "error");
renderProvider();
const failedViewport = secondHost.render();
assert.deepEqual(messages(failedViewport), ["1 customer could not be removed"]);
assert.equal(announcements.length, 2, "Pending feedback is drained and announced only once");
assert.equal(timers.size, 1);

// Dismiss from the actual sheet viewport and then return to the parent. The
// provider's queue is shared, so dismissed messages must not replay below it.
const failedItem = nodes(failedViewport.type(failedViewport.props)).find(
  (node) => node.props.toast,
)!;
failedItem.props.onDismiss(failedItem.props.toast.id);
renderProvider();
assert.deepEqual(messages(secondHost.render()), []);
secondHost.unmount();
renderProvider();
assert.deepEqual(messages(rootViewport), [], "A sheet-dismissed toast cannot reappear at root");
expire(nextTimer);

toast.push("Saved", "success");
renderProvider();
const thirdHost = makeHost();
thirdHost.render();
renderProvider();
assert.deepEqual(messages(thirdHost.render()), ["Saved"]);
thirdHost.unmount();
renderProvider();
assert.deepEqual(
  messages(rootViewport),
  ["Saved"],
  "A live toast returns to root after sheet closes",
);
assert.deepEqual(announcements, [
  "2 customers removed",
  "1 customer could not be removed",
  "Saved",
]);
assert.equal(timers.size, 1, "Moving back to root retains the original expiry");
expire(nextTimer);
assert.deepEqual(messages(rootViewport), []);
providerHooks.unmount();
console.log(
  "Toast host selftest passed: single queue, native-sheet host transfer, cleanup, dismissal and expiry.",
);
