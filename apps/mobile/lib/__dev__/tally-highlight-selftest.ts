// Exercise the real component effect against controlled native preferences,
// animation handles and time. No device, ledger or network is opened.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";

type Tree = { type: string; props: Record<string, any> };
type Timer = { at: number; fn: () => void; cancelled: boolean };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function fixture() {
  let clock = 0;
  let nextTimer = 0;
  let cleanup: (() => void) | undefined;
  let lastDeps: unknown[] | undefined;
  let pendingEffect: (() => void | (() => void)) | undefined;
  const refs: any[] = [];
  let refCursor = 0;
  const queries: ReturnType<typeof deferred<boolean>>[] = [];
  const listeners: { fn: (reduced: boolean) => void; removed: boolean }[] = [];
  const timers = new Map<number, Timer>();
  const animations: { opts: any; started: boolean; stopped: boolean }[] = [];
  class Value {
    writes: number[] = [];
    constructor(public value: number) {}
    setValue(value: number) {
      this.value = value;
      this.writes.push(value);
    }
  }
  const mocks: Record<string, any> = {
    "react/jsx-runtime": {
      jsx: (type: string, props: Record<string, any>): Tree => ({ type, props }),
    },
    react: {
      useRef: (value: any) => (refs[refCursor++] ??= { current: value }),
      useEffect: (effect: () => void | (() => void), deps: unknown[]) => {
        if (!lastDeps || deps.some((value, index) => value !== lastDeps![index])) {
          lastDeps = deps;
          pendingEffect = effect;
        }
      },
    },
    "react-native": {
      AccessibilityInfo: {
        addEventListener: (name: string, fn: (reduced: boolean) => void) => {
          assert.equal(name, "reduceMotionChanged");
          const listener = { fn, removed: false };
          listeners.push(listener);
          return {
            remove: () => {
              listener.removed = true;
            },
          };
        },
        isReduceMotionEnabled: () => {
          const query = deferred<boolean>();
          queries.push(query);
          return query.promise;
        },
      },
      Animated: {
        View: "AnimatedView",
        Value,
        timing: (_: Value, opts: any) => {
          const animation = { opts, started: false, stopped: false };
          animations.push(animation);
          return {
            start: () => {
              animation.started = true;
            },
            stop: () => {
              animation.stopped = true;
            },
          };
        },
      },
      StyleSheet: { absoluteFill: { position: "absolute", top: 0, right: 0, bottom: 0, left: 0 } },
    },
    "../lib/colors": { colors: { tallyHighlight: "#D4D4D4" } },
  };
  const exports: { TallyHighlight?: (props: { requestKey: string }) => Tree } = {};
  const js = ts.transpileModule(
    readFileSync(require.resolve("../../components/TallyHighlight"), "utf8"),
    {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        jsx: ts.JsxEmit.ReactJSX,
        target: ts.ScriptTarget.ES2022,
      },
    },
  ).outputText;
  new Function("require", "exports", "setTimeout", "clearTimeout", "Date", js)(
    (name: string) => {
      assert.ok(name in mocks, "unexpected dependency: " + name);
      return mocks[name];
    },
    exports,
    (fn: () => void, ms: number) => {
      const id = ++nextTimer;
      timers.set(id, { at: clock + ms, fn, cancelled: false });
      return id;
    },
    (id: number) => {
      const timer = timers.get(id);
      if (timer) timer.cancelled = true;
    },
    { now: () => clock },
  );
  return {
    queries,
    listeners,
    timers,
    animations,
    get opacity(): Value {
      return refs[0].current;
    },
    render(requestKey: string) {
      refCursor = 0;
      const tree = exports.TallyHighlight!({ requestKey });
      if (pendingEffect) {
        cleanup?.();
        cleanup = pendingEffect() || undefined;
        pendingEffect = undefined;
      }
      return tree;
    },
    event(reduced: boolean) {
      listeners.filter((listener) => !listener.removed).forEach((listener) => listener.fn(reduced));
    },
    advance(ms: number) {
      const target = clock + ms;
      for (;;) {
        const next = [...timers.values()]
          .filter((timer) => !timer.cancelled && timer.at <= target)
          .sort((a, b) => a.at - b.at)[0];
        if (!next) break;
        next.cancelled = true;
        clock = next.at;
        next.fn();
      }
      clock = target;
    },
    unmount() {
      cleanup?.();
      cleanup = undefined;
    },
  };
}

const settle = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

async function main() {
  const normal = fixture();
  const tree = normal.render("first");
  assert.equal(tree.props.pointerEvents, "none", "the overlay cannot steal row taps");
  assert.equal(
    tree.props.accessible,
    false,
    "the decorative overlay does not take screen-reader focus",
  );
  assert.equal(Object.assign({}, ...tree.props.style).backgroundColor, "#D4D4D4");
  assert.equal(
    normal.opacity.value,
    0,
    "wait for the user's motion preference before showing the cue",
  );
  normal.queries[0].resolve(false);
  await settle();
  assert.equal(normal.opacity.value, 0.4);
  assert.equal(normal.animations.length, 1);
  assert.deepEqual(
    normal.animations[0],
    {
      opts: { toValue: 0, duration: 1200, delay: 300, useNativeDriver: true },
      started: true,
      stopped: false,
    },
    "the ordinary cue fades on the native driver over 1.5 seconds",
  );
  normal.render("first");
  assert.equal(normal.queries.length, 1, "an unrelated rerender must not replay the cue");
  normal.advance(1500);
  assert.equal(normal.opacity.value, 0);
  const expiredWrites = normal.opacity.writes.length;
  normal.event(true);
  normal.event(false);
  assert.equal(
    normal.opacity.writes.length,
    expiredWrites,
    "preferences do not replay an expired notification cue",
  );
  assert.equal(normal.animations.length, 1);
  normal.unmount();
  assert.ok(normal.listeners.every((listener) => listener.removed));

  const reduced = fixture();
  reduced.render("reduced");
  reduced.queries[0].resolve(true);
  await settle();
  assert.equal(reduced.opacity.value, 0.4);
  assert.equal(reduced.animations.length, 0, "reduced motion gets a static cue");
  reduced.advance(1499);
  assert.equal(reduced.opacity.value, 0.4);
  reduced.advance(1);
  assert.equal(reduced.opacity.value, 0);
  reduced.unmount();

  const raced = fixture();
  raced.render("preference-race");
  raced.event(true);
  raced.queries[0].resolve(false);
  await settle();
  assert.equal(
    raced.animations.length,
    0,
    "a stale bridge query cannot override the newer Reduce Motion event",
  );
  raced.advance(1000);
  raced.event(false);
  assert.equal(raced.animations.length, 1);
  assert.equal(
    raced.animations[0].opts.duration + raced.animations[0].opts.delay,
    500,
    "changing preferences preserves the original deadline",
  );
  raced.event(true);
  assert.equal(
    raced.animations[0].stopped,
    true,
    "turning Reduce Motion on stops an active native fade",
  );
  raced.advance(500);
  assert.equal(raced.opacity.value, 0);
  raced.unmount();

  const failedQuery = fixture();
  failedQuery.render("query-failed");
  failedQuery.queries[0].reject(new Error("native query unavailable"));
  await settle();
  assert.equal(
    failedQuery.animations.length,
    0,
    "an unavailable motion query falls back to the static cue",
  );
  assert.equal(failedQuery.opacity.value, 0.4);
  failedQuery.unmount();

  const unmounted = fixture();
  unmounted.render("unmounted");
  unmounted.unmount();
  const afterUnmount = unmounted.opacity.writes.length;
  unmounted.queries[0].resolve(false);
  unmounted.listeners[0].fn(true); // an already queued native event
  await settle();
  unmounted.advance(2000);
  assert.equal(
    unmounted.opacity.writes.length,
    afterUnmount,
    "late native results do not write after unmount",
  );
  assert.equal(unmounted.animations.length, 0);
  assert.equal(unmounted.timers.size, 0);

  const replaced = fixture();
  replaced.render("old-request");
  replaced.queries[0].resolve(false);
  await settle();
  const oldTimer = [...replaced.timers.values()][0];
  replaced.advance(500);
  replaced.render("new-request");
  assert.equal(replaced.animations[0].stopped, true);
  assert.equal(oldTimer.cancelled, true);
  assert.equal(replaced.listeners[0].removed, true);
  replaced.queries[1].resolve(true);
  await settle();
  const beforeOldCallback = replaced.opacity.writes.length;
  oldTimer.fn(); // a timer callback already queued before cleanup
  replaced.listeners[0].fn(false);
  assert.equal(
    replaced.opacity.writes.length,
    beforeOldCallback,
    "callbacks from the old request cannot erase a newer cue",
  );
  assert.equal(replaced.opacity.value, 0.4);
  replaced.advance(1500);
  assert.equal(replaced.opacity.value, 0);
  replaced.unmount();

  const pendingReplacement = fixture();
  pendingReplacement.render("old-query");
  pendingReplacement.render("new-query");
  pendingReplacement.queries[1].resolve(true);
  await settle();
  const newCueWrites = pendingReplacement.opacity.writes.length;
  pendingReplacement.queries[0].resolve(false);
  await settle();
  assert.equal(
    pendingReplacement.opacity.writes.length,
    newCueWrites,
    "a replaced request's late preference query cannot affect the new cue",
  );
  assert.equal(pendingReplacement.animations.length, 0);
  pendingReplacement.unmount();
  const liveTimer = [...pendingReplacement.timers.values()].find((timer) => !timer.cancelled);
  assert.equal(liveTimer, undefined, "cleanup cancels any remaining static-cue timer");

  console.log(
    "PASS: touch-through tally cue, native fade/static reduced motion, preference races, fixed lifetime, request replacement and unmount cleanup",
  );
}
void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
