// Drive the real dialog through creation, sharing, retries and inline language
// selection. Mock only React/native/data boundaries; no account/network writes.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { TabAlreadyLinkedError, TabAuthUnavailableError } from "../tabs/errors";
import type { TabLink } from "../tabs/types";

type Element = { type: string; props: Record<string, any> };
let slots: any[] = [],
  cursor = 0;
let effects: Array<() => void> = [];
let tree: Element;
let scheduled = false;
let ui: (p: any) => Element;
let props: any;
let pref = "auto",
  locale = "fa";
let createCalls = 0,
  dismissals = 0,
  linkedCalls = 0;
let copied: string[] = [];
let shares: Array<{ link: TabLink; phone: string | null; text: string }> = [];
let openResult = true,
  copyFails = false;
let create: () => Promise<{ link: TabLink }>;
const fresh = {
  tab_id: "new-tab",
  invite_url: "https://kaata.af/t/fresh",
  my_label: "Shop",
  role: "a",
  closed_at: null,
} as TabLink;
const equal = (a: any[], b: any[]) =>
  a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
function render() {
  cursor = 0;
  tree = ui(props);
  const run = effects;
  effects = [];
  run.forEach((fn) => fn());
}
function schedule() {
  if (scheduled) return;
  scheduled = true;
  queueMicrotask(() => {
    scheduled = false;
    render();
  });
}
const jsx = (type: string, props: Record<string, any>) => ({ type, props });
const mocks: Record<string, any> = {
  "react/jsx-runtime": { jsx, jsxs: jsx, Fragment: "Fragment" },
  react: {
    useState: (initial: any) => {
      const i = cursor++;
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
    useRef: (value: any) => {
      const i = cursor++;
      return (slots[i] ??= { current: value });
    },
    useEffect: (fn: () => any, deps: any[]) => {
      const i = cursor++,
        prev = slots[i];
      if (!prev || !equal(prev.deps, deps)) {
        slots[i] = { deps, cleanup: undefined };
        effects.push(() => {
          prev?.cleanup?.();
          slots[i].cleanup = fn();
        });
      }
    },
  },
  "react-native": {
    Modal: "Modal",
    Pressable: "Pressable",
    ScrollView: "ScrollView",
    Text: "Text",
    View: "View",
    StyleSheet: { create: (s: any) => s },
  },
  "react-native-safe-area-context": { SafeAreaView: "SafeAreaView" },
  "expo-clipboard": {
    setStringAsync: async (url: string) => {
      if (copyFails) throw Error("clipboard");
      copied.push(url);
    },
  },
  "./Button": { Button: "Button" },
  "./Toast": { useToast: () => ({ push() {} }) },
  "../lib/colors": { colors: {} },
  "../lib/direction": { useIsRTL: () => locale === "fa", rowDir: () => ({}), textDir: () => ({}) },
  "../lib/i18n": {
    getLocale: () => locale,
    getShareLangPref: async () => pref,
    resolveShareLang: (p: string) => (p === "auto" ? locale : p),
    t: (k: string) => k,
    tIn: (lang: string, _key: string, vars: any) => lang + ":" + vars.name + ":" + vars.url,
  },
  "../lib/tabs/db": { getTabLinkForPerson: async () => fresh },
  "../lib/tabs/link": {
    linkContact: async () => {
      createCalls++;
      return create();
    },
    shareTabLinkOnWhatsApp: async (link: TabLink, person: any, text: string) => {
      shares.push({ link, phone: person.phone, text });
      return openResult;
    },
  },
  "../lib/tabs/errors": require("../tabs/errors"),
  "../lib/tabs/types": {},
  "../lib/tokens": { radius: {}, TOUCH_MIN: 44, typography: {} },
};
const source = readFileSync(require.resolve("../../components/LinkAccountDialog"), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    jsx: ts.JsxEmit.ReactJSX,
    target: ts.ScriptTarget.ES2022,
  },
}).outputText;
const output: any = {};
new Function("require", "exports", compiled)((name: string) => {
  assert.ok(name in mocks, "unexpected dependency " + name);
  return mocks[name];
}, output);
ui = output.LinkAccountDialog;
function nodes(n: any): Element[] {
  if (Array.isArray(n)) return n.flatMap(nodes);
  if (!n || typeof n !== "object") return [];
  return [n, ...nodes(n.props?.children)];
}
const settle = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
};
function button(key: string) {
  const btn = nodes(tree).find((n) => n.type === "Button" && n.props.label === key);
  assert.ok(btn, "missing button " + key);
  return btn;
}
async function tap(key: string) {
  button(key).props.onPress();
  await settle();
}
function reset(phone: string | null, preference = "auto", existing: TabLink | null = null) {
  for (const slot of slots) slot?.cleanup?.();
  slots = [];
  effects = [];
  cursor = 0;
  pref = preference;
  locale = "fa";
  createCalls = dismissals = linkedCalls = 0;
  shares = [];
  copied = [];
  openResult = true;
  copyFails = false;
  create = async () => ({ link: fresh });
  props = {
    visible: true,
    person: { id: "person", name: "Ahmad", phone },
    myLabel: "Shop",
    link: existing,
    onLinked: (link: TabLink) => {
      linkedCalls++;
      props.link = link;
      schedule();
    },
    onDismiss: () => {
      dismissals++;
      props.visible = false;
      schedule();
    },
    onAuthRequired() {},
  };
  render();
}
function assertOneModal() {
  assert.equal(nodes(tree).filter((n) => n.type === "Modal").length, 1);
}

async function main() {
  reset("+93700000000");
  await settle();
  assertOneModal();
  assert.equal(createCalls, 0, "opening the dialog does not link without confirmation");
  await tap("tab.link.whatsapp");
  assert.equal(createCalls, 1);
  assert.equal(linkedCalls, 1);
  assert.equal(shares.length, 1);
  assert.equal(shares[0].link.invite_url, fresh.invite_url, "share the fresh returned URL");
  assert.equal(shares[0].phone, "+93700000000");
  assert.equal(shares[0].text, "fa:Shop:" + fresh.invite_url);
  assert.equal(dismissals, 1);
  assert.equal(copied.length, 0);
  console.log("PASS: saved phone → one confirmation → targeted WhatsApp, no chooser");

  reset(null);
  await settle();
  await tap("tab.link.action");
  assertOneModal();
  assert.equal(shares.length, 0);
  assert.equal(dismissals, 0);
  await tap("tab.share.copy");
  assert.deepEqual(copied, [fresh.invite_url]);
  assert.equal(createCalls, 1);
  console.log("PASS: no phone keeps sharing/copy inside the SAME modal");

  reset("+93700000000");
  openResult = false;
  await settle();
  await tap("tab.link.whatsapp");
  assertOneModal();
  assert.equal(dismissals, 0);
  assert.ok(button("tab.share.copy"), "failed WhatsApp has a copy fallback");
  await tap("tab.share.whatsapp");
  assert.equal(createCalls, 1, "delivery retry must not create a second opening tally");
  await tap("tab.share.copy");
  assert.equal(copied.length, 1);
  console.log("PASS: WhatsApp failure/retry/copy reuses the created invitation");

  reset("+93700000000", "ask");
  await settle();
  assertOneModal();
  const languages = nodes(tree).filter((n) => n.props.accessibilityRole === "radio");
  assert.equal(languages.length, 2);
  languages[1].props.onPress();
  await settle();
  await tap("tab.link.whatsapp");
  assert.equal(shares[0].text, "en:Shop:" + fresh.invite_url);
  assert.equal(dismissals, 1);
  reset("+93700000000", "en");
  await settle();
  assert.equal(nodes(tree).filter((n) => n.props.accessibilityRole === "radio").length, 0);
  await tap("tab.link.whatsapp");
  assert.equal(shares[0].text, "en:Shop:" + fresh.invite_url);
  console.log("PASS: ask-language is inline; explicit preference is respected");

  reset("+93700000000");
  let finish!: (value: { link: TabLink }) => void;
  create = () =>
    new Promise((resolve) => {
      finish = resolve;
    });
  await settle();
  const twice = button("tab.link.whatsapp").props.onPress;
  twice();
  twice();
  await settle();
  assert.equal(createCalls, 1);
  assert.equal(button("tab.link.whatsapp").props.loading, true);
  nodes(tree)
    .find((n) => n.type === "Modal")!
    .props.onRequestClose();
  assert.equal(dismissals, 0, "cannot dismiss an in-flight create");
  finish({ link: fresh });
  await settle();
  assert.equal(shares.length, 1);
  console.log("PASS: double taps coalesce, in-flight creation cannot be dismissed");

  reset("+93700000000");
  create = async () => {
    throw new TabAlreadyLinkedError(fresh.tab_id);
  };
  await settle();
  await tap("tab.link.whatsapp");
  assert.equal(shares[0].link.invite_url, fresh.invite_url);
  assert.equal(createCalls, 1);
  assert.equal(linkedCalls, 1);
  console.log("PASS: another phone's existing link is recovered and shared");

  reset("+93700000000");
  create = async () => {
    throw Error("offline");
  };
  await settle();
  await tap("tab.link.whatsapp");
  assertOneModal();
  assert.equal(dismissals, 0);
  assert.equal(shares.length, 0);
  assert.ok(nodes(tree).some((n) => n.props.accessibilityRole === "alert"));
  create = async () => ({ link: fresh });
  await tap("tab.link.whatsapp");
  assert.equal(shares.length, 1);
  console.log("PASS: creation failure stays inline; retry completes normally");

  reset(null, "auto", fresh);
  await settle();
  await tap("tab.share.whatsapp");
  assert.equal(createCalls, 0);
  assert.equal(shares[0].phone, null);
  console.log("PASS: resharing an existing invitation never creates another account");

  reset(null, "auto", fresh);
  copyFails = true;
  await settle();
  await tap("tab.share.copy");
  assertOneModal();
  assert.equal(dismissals, 0);
  assert.equal(createCalls, 0);
  copyFails = false;
  await tap("tab.share.copy");
  assert.deepEqual(copied, [fresh.invite_url]);
  console.log("PASS: clipboard failure stays inline and retries without relinking");

  reset("+93700000000");
  create = () =>
    new Promise((resolve) => {
      finish = resolve;
    });
  await settle();
  await tap("tab.link.whatsapp");
  props.visible = false;
  render();
  await settle(); // navigation/unmount invalidation
  finish({ link: fresh });
  await settle();
  assert.equal(shares.length, 0, "late completion cannot launch WhatsApp from another screen");
  console.log("PASS: closing the screen invalidates late delivery");

  reset("+93700000000");
  create = async () => {
    throw new TabAuthUnavailableError();
  };
  await settle();
  await tap("tab.link.whatsapp");
  assert.equal(dismissals, 1);
  assert.equal(shares.length, 0);
  for (const slot of slots) slot?.cleanup?.(); // cancel deferred navigation
  console.log("PASS: sign-in is the only necessary route out, never an extra invite sheet");
}
main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
