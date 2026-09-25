// Exercise the real hook's async/cache logic with deterministic hook slots.
// Framework/native/network boundaries are mocked; no production database.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
import type { InboxPage } from "../tabs/api";

const saved = new Map<string, NodeJS.Module | undefined>();
function stub(name: string, exports: object) {
  const filename = require.resolve(name);
  saved.set(filename, require.cache[filename]);
  require.cache[filename] = { id: filename, filename, loaded: true, exports } as NodeJS.Module;
}
const slots: any[] = [];
let slot = 0,
  focused = true,
  queued = false;
let activeEffect: (() => void | (() => void)) | undefined;
let nextEffect: (() => void | (() => void)) | undefined;
let cleanup: void | (() => void);
let output: ReturnType<typeof import("../tabs/use-inbox").useInbox>;
let hook: typeof import("../tabs/use-inbox").useInbox;
const render = () => {
  queued = false;
  slot = 0;
  output = hook();
  if (focused && nextEffect !== activeEffect) {
    cleanup?.();
    activeEffect = nextEffect;
    cleanup = activeEffect?.();
  }
};
const schedule = () => {
  if (!queued) {
    queued = true;
    queueMicrotask(render);
  }
};
const same = (a: unknown[], b: unknown[]) =>
  a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
stub("react", {
  useState: (initial: any) => {
    const i = slot++;
    if (!(i in slots)) slots[i] = typeof initial === "function" ? initial() : initial;
    return [
      slots[i],
      (value: any) => {
        const next = typeof value === "function" ? value(slots[i]) : value;
        if (!Object.is(next, slots[i])) {
          slots[i] = next;
          schedule();
        }
      },
    ];
  },
  useRef: (initial: any) => {
    const i = slot++;
    return (slots[i] ??= { current: initial });
  },
  useCallback: (fn: any, deps: unknown[]) => {
    const i = slot++;
    if (!slots[i] || !same(slots[i].deps, deps)) slots[i] = { deps, fn };
    return slots[i].fn;
  },
});
stub("expo-router", {
  useFocusEffect: (fn: () => void) => {
    nextEffect = fn;
  },
});
stub("react-native", {
  AppState: { currentState: "active", addEventListener: () => ({ remove() {} }) },
});
let account: string | null = "a";
let locale = "en";
const cache = new Map<string, string>();
stub("../db-tx", { getAccountIdSync: () => account });
stub("../db", {
  getAppMeta: async (key: string) => cache.get(key) ?? null,
  setAppMeta: async (key: string, value: string) => {
    cache.set(key, value);
  },
});
stub("../i18n", { getLocale: () => locale });
stub("../tabs/events", { onTabApplied: () => () => {} });
function page(id: string, body = id, read = false): InboxPage {
  return {
    items: [
      {
        id,
        tab_id: "tab",
        role: "a",
        rev: 1,
        kind: "entry_created",
        entry_id: "entry",
        body,
        created_at_ms: 1,
        read,
      },
    ],
    unread: read ? 0 : 1,
    latest_id: id,
    next_before: "",
  };
}
let fetcher = async (_locale: string, _before: string): Promise<InboxPage> => page("1", "A");
let marker = async (_body: unknown) => {};
stub("../tabs/api", {
  fetchInbox: (lang: string, before: string) => fetcher(lang, before),
  markInboxRead: (body: unknown) => marker(body),
});
const Module = require("node:module");
const filename = require.resolve("../tabs/use-inbox");
const compiled = new Module(filename, module);
compiled.filename = filename;
compiled.paths = module.paths;
compiled._compile(
  ts.transpileModule(readFileSync(filename, "utf8"), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
  }).outputText,
  filename,
);
hook = compiled.exports.useInbox;
async function settle() {
  for (let i = 0; i < 12; i++) await new Promise<void>((r) => setImmediate(r));
}
function defer<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
async function main() {
  render();
  await settle();
  assert.equal(output.page.items[0].body, "A");
  assert(cache.has("notification_inbox:a:en"));
  console.log("PASS 1: account/locale cache and initial history");

  const stale = defer<InboxPage>();
  fetcher = () => stale.promise;
  const pending = output.reload();
  fetcher = async () => page("2", "B");
  account = "b";
  render();
  await settle();
  stale.resolve(page("1", "A stale"));
  await pending;
  await settle();
  assert.equal(output.page.items[0].body, "B", "late A response leaked into B");
  assert(cache.has("notification_inbox:b:en"));
  console.log("PASS 2: account switches ignore late previous-account responses");

  const oldCount = defer<InboxPage>();
  fetcher = () => oldCount.promise;
  const preRead = output.reload();
  marker = async (body) => {
    assert.deepEqual(body, { id: "2" });
    fetcher = async () => page("2", "B", true);
  };
  await output.read("2");
  await settle();
  oldCount.resolve(page("2", "B", false));
  await preRead;
  await settle();
  assert.equal(output.page.unread, 0, "pre-mark GET restored old unread count");
  assert(output.page.items[0].read);
  console.log("PASS 3: marking read wins over an earlier in-flight refresh");

  fetcher = async () => {
    throw new Error("offline");
  };
  await output.reload();
  await settle();
  assert(output.failed);
  assert.equal(output.page.items[0].body, "B");
  console.log("PASS 4: offline refresh keeps the signed-in account's cached history");

  fetcher = async (_lang, before) =>
    before ? page("1", "older") : { ...page("2", "B"), next_before: "2" };
  await output.reload();
  await settle();
  await output.reload("2");
  await settle();
  assert.deepEqual(
    output.page.items.map((n) => n.id),
    ["2", "1"],
  );
  await output.reload("2");
  await settle();
  assert.equal(output.page.items.length, 2, "pagination duplicated notice");
  console.log("PASS 5: pagination appends without duplicate items");

  const inflight = defer<InboxPage>();
  fetcher = () => inflight.promise;
  const refreshing = output.reload();
  fetcher = async () => page("3", "arrival during refresh");
  await output.reload();
  inflight.resolve(page("2", "older response"));
  await refreshing;
  await settle();
  assert.equal(output.page.items[0].id, "3", "refresh hint was dropped while busy");
  console.log("PASS 6: an in-flight refresh coalesces one trailing refresh");

  locale = "fa";
  fetcher = async (lang) => page("2", lang);
  render();
  await settle();
  assert.equal(output.page.items[0].body, "fa");
  assert(cache.has("notification_inbox:b:fa"));
  account = null;
  render();
  await settle();
  assert.equal(output.page.items.length, 0);
  assert.equal(output.page.unread, 0);
  assert(!output.signedIn);
  console.log("PASS 7: locale refresh and sign-out clear the visible inbox");
}
main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => {
    focused = false;
    cleanup?.();
    for (const [key, old] of saved) {
      if (old) require.cache[key] = old;
      else delete require.cache[key];
    }
  });
