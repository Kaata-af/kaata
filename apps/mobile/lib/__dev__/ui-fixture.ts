// Minimal hook/JSX boundary for tests that execute real screens and effects.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";

export type UINode = { type: any; props: Record<string, any> };
export const jsx = (type: any, props: Record<string, any>): UINode => ({ type, props });
export const nodes = (node: any): UINode[] =>
  Array.isArray(node)
    ? node.flatMap(nodes)
    : !node || typeof node !== "object"
      ? []
      : [node, ...nodes(node.props?.children)];
export const flattenStyle = (style: any): any =>
  Array.isArray(style) ? Object.assign({}, ...style.filter(Boolean).map(flattenStyle)) : style;
const same = (a?: unknown[], b?: unknown[]) =>
  !!a && !!b && a.length === b.length && a.every((value, i) => Object.is(value, b[i]));

export function compileUI(
  file: string,
  mocks: Record<string, any>,
  globals: Record<string, any> = {},
) {
  const exports: any = {};
  const code = ts.transpileModule(readFileSync(require.resolve(file), "utf8"), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      jsx: ts.JsxEmit.ReactJSX,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  new Function("require", "exports", ...Object.keys(globals), code)(
    (name: string) => {
      assert.ok(name in mocks, `Unexpected dependency ${name} in ${file}`);
      return mocks[name];
    },
    exports,
    ...Object.values(globals),
  );
  return exports;
}

export function uiHooks() {
  let slots: any[] = [],
    cursor = 0,
    dirty = false,
    unmounted = false;
  let pending: (() => void)[] = [];
  let lastRender: () => UINode;
  let tree: UINode;
  let lateWrites = 0;
  const react = {
    useState(initial: any) {
      const i = cursor++;
      if (!(i in slots)) slots[i] = typeof initial === "function" ? initial() : initial;
      return [
        slots[i],
        (value: any) => {
          if (unmounted) {
            lateWrites++;
            return;
          }
          const next = typeof value === "function" ? value(slots[i]) : value;
          if (!Object.is(next, slots[i])) {
            slots[i] = next;
            dirty = true;
          }
        },
      ];
    },
    useRef(value: any) {
      const i = cursor++;
      return (slots[i] ??= { current: value });
    },
    useMemo(fn: () => any, deps: unknown[]) {
      const i = cursor++;
      if (!(i in slots) || !same(slots[i].deps, deps)) slots[i] = { deps, value: fn() };
      return slots[i].value;
    },
    useCallback(fn: () => any, deps: unknown[]) {
      return react.useMemo(() => fn, deps);
    },
    useEffect(fn: () => void | (() => void), deps?: unknown[]) {
      const i = cursor++,
        before = slots[i];
      if (before && same(before.deps, deps)) return;
      slots[i] = { deps };
      pending.push(() => {
        before?.cleanup?.();
        slots[i].cleanup = fn();
      });
    },
  };
  function render(fn = lastRender) {
    lastRender = fn;
    let count = 0;
    do {
      assert.ok(count++ < 20, "Effect/render loop");
      dirty = false;
      cursor = 0;
      tree = fn();
      const effects = pending;
      pending = [];
      effects.forEach((run) => run());
    } while (dirty);
    return tree;
  }
  return {
    react,
    render,
    get tree() {
      return tree;
    },
    get lateWrites() {
      return lateWrites;
    },
    unmount() {
      unmounted = true;
      slots.forEach((slot) => slot?.cleanup?.());
    },
  };
}

export function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
export const settleUI = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
};
