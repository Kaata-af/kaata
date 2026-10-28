import assert from "node:assert/strict";
import type { StoreReviewContext } from "../store-review";
import { compileUI, deferred, jsx, settleUI, uiHooks } from "./ui-fixture";

const initialContext: StoreReviewContext = {
  installId: "install-a",
  accountId: "account-a",
  vaultId: "kaata-a",
};
const contextKey = (context: StoreReviewContext) => JSON.stringify(context);
function fixture(options: { focused?: boolean; ready?: boolean; platform?: string } = {}) {
  const hooks = uiHooks();
  let focused = options.focused ?? true;
  let keyboardVisible = false;
  let props = {
    context: initialContext as StoreReviewContext | null,
    ready: options.ready ?? true,
  };
  let opportunity: { id: string; context: StoreReviewContext } | null = null;
  let gate: Promise<unknown> | null = null;
  let requestsThrow = false;
  const opportunityListeners = new Set<() => void>();
  const appListeners = new Map<string, Set<(...args: any[]) => void>>();
  const keyboardListeners = new Map<string, Set<(...args: any[]) => void>>();
  const timers = new Map<number, { ms: number; run: () => void }>();
  const timerHistory: (() => void)[] = [];
  const dismissals: string[] = [];
  const requests: { context: StoreReviewContext; id: string; isReady: () => boolean }[] = [];
  let nativeLaunches = 0;
  let nextTimer = 0;
  const subscribe = (
    map: Map<string, Set<(...args: any[]) => void>>,
    name: string,
    callback: (...args: any[]) => void,
  ) => {
    const set = map.get(name) ?? new Set();
    map.set(name, set);
    set.add(callback);
    return { remove: () => set.delete(callback) };
  };
  const emitOpportunity = () => [...opportunityListeners].forEach((callback) => callback());
  const AppState = {
    currentState: "active",
    addEventListener: (name: string, callback: (...args: any[]) => void) =>
      subscribe(appListeners, name, callback),
  };
  const { useStoreReviewPrompt } = compileUI(
    "../use-store-review-prompt",
    {
      react: hooks.react,
      "expo-router": { useIsFocused: () => focused },
      "react-native": {
        AppState,
        Keyboard: {
          isVisible: () => keyboardVisible,
          addListener: (name: string, callback: (...args: any[]) => void) =>
            subscribe(keyboardListeners, name, callback),
        },
        Platform: { OS: options.platform ?? "android" },
      },
      "./store-review": {
        subscribeReviewOpportunities: (callback: () => void) => {
          opportunityListeners.add(callback);
          return () => opportunityListeners.delete(callback);
        },
        getReviewOpportunity: (context: StoreReviewContext) =>
          opportunity && contextKey(opportunity.context) === contextKey(context)
            ? opportunity.id
            : null,
        dismissReviewOpportunity: (id: string) => {
          dismissals.push(id);
          if (opportunity?.id !== id) return;
          opportunity = null;
          emitOpportunity();
        },
        requestReviewOpportunity: async (
          context: StoreReviewContext,
          id: string,
          isReady: () => boolean,
        ) => {
          requests.push({ context, id, isReady });
          if (gate) await gate;
          if (requestsThrow) throw Error("fixture native request failed");
          if (!isReady() || opportunity?.id !== id) return;
          nativeLaunches++;
          opportunity = null;
          emitOpportunity();
        },
      },
    },
    {
      setTimeout: (run: () => void, ms: number) => {
        const id = ++nextTimer;
        timers.set(id, { run, ms });
        timerHistory.push(run);
        return id;
      },
      clearTimeout: (id: number) => timers.delete(id),
    },
  );
  const render = () => hooks.render(() => jsx("Home", { cancel: useStoreReviewPrompt(props) }));
  const cancel = () => hooks.tree.props.cancel();
  const publish = (id: string, context = initialContext) => {
    opportunity = { id, context };
    emitOpportunity();
  };
  const advance = async () => {
    assert.equal(timers.size, 1, "One idle timer owns the review opportunity");
    const [id, timer] = [...timers][0];
    assert.equal(timer.ms, 5000, "Allow navigation, animations and toasts to finish");
    timers.delete(id);
    timer.run();
    await settleUI();
  };
  render();
  return {
    hooks,
    timers,
    timerHistory,
    dismissals,
    requests,
    appListeners,
    keyboardListeners,
    opportunityListeners,
    publish,
    cancel,
    advance,
    emitOpportunity,
    get nativeLaunches() {
      return nativeLaunches;
    },
    get pending() {
      return opportunity;
    },
    update(next: Partial<typeof props>) {
      props = { ...props, ...next };
      render();
    },
    focus(value: boolean) {
      focused = value;
      render();
    },
    app(state: string) {
      AppState.currentState = state;
      for (const callback of appListeners.get("change") ?? []) callback(state);
    },
    window(event: "blur" | "focus") {
      for (const callback of appListeners.get(event) ?? []) callback();
    },
    keyboard(event: string) {
      keyboardVisible = event.endsWith("Show");
      for (const callback of keyboardListeners.get(event) ?? []) callback();
    },
    delayNative(promise: Promise<unknown>) {
      gate = promise;
    },
    failNative() {
      requestsThrow = true;
    },
  };
}

async function main() {
  for (const platform of ["android", "ios"]) {
    const f = fixture({ platform });
    assert.equal(f.timers.size, 0, "Launching Home alone never asks for a review");
    f.publish("save-10");
    f.emitOpportunity();
    f.update({ context: { ...initialContext } });
    assert.equal(f.timers.size, 1, "Repeated notifications/renders never duplicate a timer");
    await f.advance();
    assert.equal(f.requests.length, 1);
    assert.deepEqual(f.requests[0].context, initialContext);
    assert.equal(f.nativeLaunches, 1);
    assert.equal(f.pending, null);
    f.focus(false);
    f.focus(true);
    f.emitOpportunity();
    assert.equal(f.timers.size, 0, "Returning later cannot retry the same review opportunity");
    f.hooks.unmount();
  }

  for (const focused of [false, true]) {
    const f = fixture({ focused, ready: false });
    f.publish("save-behind-tally");
    assert.equal(f.timers.size, 0);
    assert.ok(f.pending, "A fresh save behind another page waits for the completed workflow");
    f.focus(true);
    f.update({ ready: true });
    await f.advance();
    assert.equal(f.nativeLaunches, 1);
  }

  {
    const f = fixture();
    f.publish("superseded-save");
    const staleTimer = f.timerHistory.at(-1)!;
    f.publish("latest-save");
    assert.equal(f.timers.size, 1, "A newer completed tally replaces the idle interval");
    staleTimer();
    await settleUI();
    assert.equal(f.requests.length, 0);
    await f.advance();
    assert.equal(f.requests[0].id, "latest-save");
    assert.equal(f.nativeLaunches, 1);
  }

  for (const interrupt of [
    "touch",
    "blur",
    "ready",
    "background",
    "inactive",
    "keyboard",
  ] as const) {
    const f = fixture();
    f.publish(`save-${interrupt}`);
    const staleTimer = f.timerHistory.at(-1)!;
    if (interrupt === "touch") f.cancel();
    if (interrupt === "blur") f.focus(false);
    if (interrupt === "ready") f.update({ ready: false });
    if (interrupt === "background" || interrupt === "inactive") f.app(interrupt);
    if (interrupt === "keyboard") f.keyboard("keyboardWillShow");
    assert.equal(f.timers.size, 0, `${interrupt} cancels the idle opportunity`);
    assert.equal(f.pending, null);
    staleTimer();
    await settleUI();
    assert.equal(f.requests.length, 0, "A queued stale timer never starts native work");
    f.focus(true);
    f.update({ ready: true });
    f.app("active");
    f.keyboard("keyboardDidHide");
    f.emitOpportunity();
    assert.equal(
      f.timers.size,
      0,
      "Finishing the interruption does not reschedule a discarded ask",
    );
    f.publish(`fresh-after-${interrupt}`);
    await f.advance();
    assert.equal(f.nativeLaunches, 1, "A later completed tally gets its own opportunity");
  }

  {
    const f = fixture();
    f.publish("save-window-blur");
    f.window("blur");
    assert.equal(f.pending, null);
    assert.equal(f.timers.size, 0);
    f.window("focus");
    assert.equal(f.timers.size, 0, "Android notification shade cannot defer an old prompt");
    f.publish("save-window-return");
    await f.advance();
    assert.equal(f.nativeLaunches, 1);
  }

  for (const change of [
    { installId: "install-b" },
    { accountId: "account-b" },
    { vaultId: "kaata-b" },
  ]) {
    const f = fixture({ focused: false });
    f.publish("save-old-context");
    const nextContext = { ...initialContext, ...change };
    f.update({ context: nextContext });
    assert.equal(f.pending, null, "Even an unarmed opportunity cannot cross local context");
    f.focus(true);
    assert.equal(f.timers.size, 0);
    f.publish("save-new-context", nextContext);
    const staleTimer = f.timerHistory.at(-1)!;
    f.update({ context: initialContext });
    f.update({ context: nextContext });
    staleTimer();
    assert.equal(f.requests.length, 0, "Context ABA cannot revive a timer");
    assert.equal(f.pending, null);
  }

  for (const interrupt of [
    "touch",
    "ready",
    "focus",
    "app",
    "context",
    "window",
    "keyboard",
    "unmount",
  ] as const) {
    const f = fixture();
    const native = deferred<void>();
    f.delayNative(native.promise);
    f.publish(`availability-${interrupt}`);
    await f.advance();
    assert.equal(f.requests.length, 1);
    const isReady = f.requests[0].isReady;
    assert.equal(isReady(), true);
    if (interrupt === "touch") f.cancel();
    if (interrupt === "ready") {
      f.update({ ready: false });
      f.update({ ready: true });
    }
    if (interrupt === "focus") {
      f.focus(false);
      f.focus(true);
    }
    if (interrupt === "app") {
      f.app("inactive");
      f.app("active");
    }
    if (interrupt === "context") {
      f.update({ context: { ...initialContext, accountId: "other" } });
      f.update({ context: initialContext });
    }
    if (interrupt === "window") {
      f.window("blur");
      f.window("focus");
    }
    if (interrupt === "keyboard") {
      f.keyboard("keyboardWillShow");
      f.keyboard("keyboardDidHide");
    }
    if (interrupt === "unmount") f.hooks.unmount();
    assert.equal(isReady(), false, "Async native availability retains its exact idle generation");
    native.resolve();
    await settleUI();
    assert.equal(f.nativeLaunches, 0);
    assert.equal(f.timers.size, 0);
    assert.equal(f.hooks.lateWrites, 0);
  }

  {
    const f = fixture({ focused: false });
    f.app("background");
    f.publish("late-save-background");
    assert.equal(
      f.pending,
      null,
      "A late save completion cannot carry a prompt across backgrounding",
    );
    f.app("active");
    f.focus(true);
    assert.equal(f.timers.size, 0);
    f.update({ context: null });
    f.publish("no-context");
    assert.equal(f.timers.size, 0);
  }

  {
    const f = fixture();
    f.failNative();
    f.publish("native-error");
    await f.advance();
    assert.equal(f.nativeLaunches, 0);
    assert.equal(f.pending, null, "A failed native request never becomes a repeated prompt");
    assert.equal(f.timers.size, 0);
  }

  {
    const f = fixture();
    f.publish("save-unmount");
    const retainedCancel = f.hooks.tree.props.cancel;
    const oldApp = [...f.appListeners.get("change")!][0];
    const oldKeyboard = [...f.keyboardListeners.get("keyboardDidShow")!][0];
    const oldWindow = [...f.appListeners.get("blur")!][0];
    f.hooks.unmount();
    assert.equal(f.timers.size, 0);
    assert.equal(f.opportunityListeners.size, 0);
    assert.ok([...f.appListeners.values()].every((listeners) => listeners.size === 0));
    assert.ok([...f.keyboardListeners.values()].every((listeners) => listeners.size === 0));
    f.publish("later-screen-save");
    retainedCancel();
    oldApp("background");
    oldKeyboard();
    oldWindow();
    assert.equal(
      f.pending?.id,
      "later-screen-save",
      "Old native callbacks cannot cancel another screen's work",
    );
    assert.equal(f.requests.length, 0);
    assert.equal(f.hooks.lateWrites, 0);
  }
  console.log(
    "PASS review prompt idle timing, completed-workflow handoff, keyboard/modal/navigation/AppState cancellation, context ABA and stale async/native callbacks",
  );
}
void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
