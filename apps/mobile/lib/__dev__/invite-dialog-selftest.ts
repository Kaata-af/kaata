// Drive the real dialog through creation, sharing, retries and inline language
// selection. Mock only React/native/data boundaries; no account/network writes.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { TabAlreadyLinkedError, TabAuthUnavailableError, TabApiError } from "../tabs/errors";
import type { TabLink } from "../tabs/types";
import { compileUI } from "./ui-fixture";

const translations = compileUI("../i18n", {
  "expo-localization": { getLocales: () => [{ languageCode: "en" }] },
  "./db": { getAppMeta: async () => null },
}) as typeof import("../i18n");

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
let accountId = "account",
  vaultId = "vault";
const createArguments: any[] = [];
let copied: string[] = [];
let shares: Array<{ link: TabLink; phone: string | null; text: string }> = [];
const invitationMessages: string[] = [];
let openResult = true,
  copyFails = false;
let create: () => Promise<{ link: TabLink }>;
const fresh = {
  group_id: "group",
  currency: "AFN",
  recording_mode: "notify",
  tab_id: "new-tab",
  invite_url: "https://kaata.af/t/fresh",
  my_label: "Shop",
  role: "a",
  closed_at: null,
} as TabLink;
let recoveredLinks: TabLink[] = [fresh];
type PendingSettings = { myLabel: string; recordingMode: "notify" | "review" | "notify_one_way" };
let pendingSettings: Promise<PendingSettings | null> | null = null;
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
  "@expo/vector-icons": { Ionicons: "Ionicons", MaterialCommunityIcons: "MaterialCommunityIcons" },
  "./ProtectedModal": { ProtectedModal: "Modal" },
  "./SheetBackdrop": { SheetBackdrop: "SheetBackdrop" },
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
  "../lib/currency": {
    getCurrentCurrencyCode: () => "AFN",
    getCurrencyLabel: (code: string) => code,
  },
  "../lib/db-tx": { getAccountIdSync: () => accountId, getActiveVaultIdSyncMaybe: () => vaultId },
  "../lib/direction": { useIsRTL: () => locale !== "en", rowDir: () => ({}), textDir: () => ({}) },
  "../lib/i18n": {
    getLocale: () => locale,
    getShareLangPref: async () => pref,
    resolveShareLang: (p: string) => (p === "auto" ? locale : p),
    t: (k: string, vars?: Record<string, string>) =>
      k === "tab.group.currencies" ? `${k}:${vars?.currencies}` : k,
    tIn: (lang: string, key: string, vars: any) => {
      invitationMessages.push(key);
      return lang + ":" + vars.name + ":" + vars.url;
    },
  },
  "../lib/tabs/db": { listOpenTabLinksForPerson: async () => recoveredLinks },
  "../lib/tabs/link": {
    getPendingContactGroupSettings: async () => (pendingSettings ? await pendingSettings : null),
    linkContactGroup: async (...args: any[]) => {
      createCalls++;
      createArguments.push(args);
      const created = await create();
      return {
        ...created,
        group: { id: "group", currencies: ["AFN", "USD"] },
        links: [created.link, { ...created.link, currency: "USD" }],
        inviteUrl: created.link.invite_url,
      };
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
function reset(
  phone: string | null,
  preference = "auto",
  existing: TabLink | null = null,
  pending: Promise<PendingSettings | null> | null = null,
) {
  accountId = "account";
  vaultId = "vault";
  createArguments.length = 0;
  for (const slot of slots) slot?.cleanup?.();
  slots = [];
  effects = [];
  cursor = 0;
  pref = preference;
  locale = "fa";
  createCalls = dismissals = linkedCalls = 0;
  shares = [];
  invitationMessages.length = 0;
  copied = [];
  openResult = true;
  copyFails = false;
  create = async () => ({
    link: {
      ...fresh,
      recording_mode: createArguments.at(-1)?.[1]?.recordingMode ?? fresh.recording_mode,
    },
  });
  recoveredLinks = [fresh];
  pendingSettings = pending;
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
  assert.equal(translations.tIn("en", "tab.recordingMode.oneWay"), "Notify");
  assert.equal(translations.tIn("en", "tab.recordingMode.notify"), "Both can write");
  assert.equal(translations.tIn("en", "tab.recordingMode.review"), "Require approval");
  for (const [code, key] of [
    ["shared_account_pending", "tab.group.pending"],
    ["shared_account_source_unsynced", "tab.group.syncFirst"],
    ["shared_history_pending", "tab.history.pending"],
  ] as const) {
    reset(null);
    create = async () => {
      throw new TabApiError(409, code, "Synthetic preparation guard");
    };
    await settle();
    await tap("tab.link.action");
    assert.ok(
      nodes(tree).some(
        (node) => node.props.accessibilityRole === "alert" && node.props.children === key,
      ),
      `${code} explains the required recovery step`,
    );
    assert.equal(linkedCalls + dismissals + shares.length + copied.length, 0);
    assert.equal(button("tab.link.action").props.disabled, false, "The invitation can be retried");
  }

  for (const [recordingMode, label] of [
    ["notify_one_way", "tab.recordingMode.oneWay"],
    ["notify", "tab.recordingMode.notify"],
    ["review", "tab.recordingMode.review"],
  ] as const) {
    reset(null, "auto", null, Promise.resolve({ myLabel: "Original label", recordingMode }));
    await settle();
    assert.equal(
      nodes(tree).find((node) => node.props.accessibilityLabel === label)!.props.accessibilityState
        .checked,
      true,
      "Retrying an unfinished invitation restores its original recording contract",
    );
    await tap("tab.link.action");
    assert.equal(createArguments[0][1].recordingMode, recordingMode);
  }
  let resolvePending!: (settings: PendingSettings) => void;
  reset(
    null,
    "auto",
    null,
    new Promise((resolve) => {
      resolvePending = resolve;
    }),
  );
  await settle();
  assert.equal(button("tab.link.action").props.disabled, true);
  nodes(tree)
    .find((node) => node.props.accessibilityLabel === "tab.recordingMode.oneWay")!
    .props.onPress();
  resolvePending({ myLabel: "Original label", recordingMode: "review" });
  await settle();
  assert.equal(
    nodes(tree).find((node) => node.props.accessibilityLabel === "tab.recordingMode.oneWay")!.props
      .accessibilityState.checked,
    true,
    "A late local draft read cannot overwrite a newer user choice",
  );
  await tap("tab.link.action");
  assert.equal(createCalls, 0, "A changed mode cannot send a conflicting retry");
  assert.ok(
    nodes(tree).some(
      (node) =>
        node.props.accessibilityRole === "alert" && node.props.children === "tab.group.pendingMode",
    ),
  );
  nodes(tree)
    .find((node) => node.props.accessibilityLabel === "tab.recordingMode.review")!
    .props.onPress();
  await settle();
  await tap("tab.link.action");
  assert.equal(createCalls, 1);
  assert.equal(createArguments[0][1].recordingMode, "review");

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
  assert.ok(
    nodes(tree).some(
      (node) =>
        node.props.testID === "shared-account-currencies" &&
        node.props.children === "tab.group.currencies:AFN · USD",
    ),
    "One created invitation names both currencies without choosing between them",
  );
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
  const languages = nodes(tree).filter(
    (n) =>
      n.props.accessibilityRole === "radio" &&
      !n.props.accessibilityLabel?.startsWith("tab.recordingMode."),
  );
  assert.equal(languages.length, 3);
  languages[2].props.onPress();
  await settle();
  await tap("tab.link.whatsapp");
  assert.equal(shares[0].text, "en:Shop:" + fresh.invite_url);
  assert.equal(dismissals, 1);
  reset("+93700000000", "ask");
  await settle();
  nodes(tree)
    .filter(
      (n) =>
        n.props.accessibilityRole === "radio" &&
        !n.props.accessibilityLabel?.startsWith("tab.recordingMode."),
    )[1]
    .props.onPress();
  await settle();
  await tap("tab.link.whatsapp");
  assert.equal(shares[0].text, "ps:Shop:" + fresh.invite_url);
  reset("+93700000000", "ps");
  await settle();
  assert.equal(
    nodes(tree).filter(
      (n) =>
        n.props.accessibilityRole === "radio" &&
        !n.props.accessibilityLabel?.startsWith("tab.recordingMode."),
    ).length,
    0,
  );
  await tap("tab.link.whatsapp");
  assert.equal(shares[0].text, "ps:Shop:" + fresh.invite_url);
  reset("+93700000000", "en");
  await settle();
  assert.equal(
    nodes(tree).filter(
      (n) =>
        n.props.accessibilityRole === "radio" &&
        !n.props.accessibilityLabel?.startsWith("tab.recordingMode."),
    ).length,
    0,
  );
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
  recoveredLinks = [{ ...fresh, group_id: null }];
  create = async () => {
    throw new TabAlreadyLinkedError(fresh.tab_id);
  };
  await settle();
  await tap("tab.link.whatsapp");
  assert.equal(
    shares.length,
    0,
    "A legacy currency link cannot silently substitute for an all-currency invitation",
  );
  assert.ok(
    nodes(tree).some(
      (node) =>
        node.props.accessibilityRole === "alert" && node.props.children === "tab.group.conflict",
    ),
  );

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
  props.currency = "USD";
  render();
  await settle();
  await tap("tab.link.whatsapp");
  assert.equal(
    createArguments[0][1].currency,
    undefined,
    "A new shared account never narrows its currencies to a selected action currency",
  );
  assert.equal(
    createArguments[0][1].recordingMode,
    "notify_one_way",
    "new links default to creator writing and recipient notifications",
  );
  assert.deepEqual(invitationMessages, ["tab.invite.oneWayMessage"]);
  reset("+93700000000");
  await settle();
  nodes(tree)
    .find((node) => node.props.accessibilityLabel === "tab.recordingMode.notify")!
    .props.onPress();
  await settle();
  assert.ok(nodes(tree).some((node) => node.props.children === "tab.group.confirm.notifyBody"));
  await tap("tab.link.whatsapp");
  assert.equal(createArguments[0][1].recordingMode, "notify", "Both can write remains explicit");
  assert.deepEqual(invitationMessages, ["tab.invite.notifyMessage"]);
  reset("+93700000000");
  await settle();
  const reviewMode = nodes(tree).find(
    (node) => node.props.accessibilityLabel === "tab.recordingMode.review",
  )!;
  reviewMode.props.onPress();
  await settle();
  await tap("tab.link.whatsapp");
  assert.equal(
    createArguments[0][1].recordingMode,
    "review",
    "explicit approval mode remains available",
  );
  for (const lang of ["en", "fa", "ps"]) {
    reset("+93700000000");
    locale = lang;
    render();
    await settle();
    const choices = nodes(tree).filter((node) => node.props.accessibilityRole === "radio");
    assert.deepEqual(
      choices.map((choice) => choice.props.accessibilityLabel),
      ["tab.recordingMode.oneWay", "tab.recordingMode.notify", "tab.recordingMode.review"],
      "Notify precedes Both can write and Require approval in every language",
    );
    assert.deepEqual(
      choices.map((choice) => choice.props.accessibilityState.checked),
      [true, false, false],
      "Notify is the selected default before any choice is tapped",
    );
    assert.ok(
      nodes(choices[2]).some(
        (node) =>
          node.type === "MaterialCommunityIcons" &&
          /^handshake(?:-outline)?$/.test(node.props.name),
      ),
      "Require approval has a handshake visual aid",
    );
    const oneWay = nodes(tree).find(
      (node) => node.props.accessibilityLabel === "tab.recordingMode.oneWay",
    )!;
    oneWay.props.onPress();
    await settle();
    assert.ok(nodes(tree).some((node) => node.props.children === "tab.group.confirm.oneWayBody"));
    create = async () => ({ link: { ...fresh, recording_mode: "notify_one_way" } });
    await tap("tab.link.whatsapp");
    assert.equal(createArguments[0][1].recordingMode, "notify_one_way");
    assert.deepEqual(invitationMessages, ["tab.invite.oneWayMessage"]);
    assert.equal(shares[0].text, lang + ":Shop:" + fresh.invite_url);
  }
  for (const [mode, message] of [
    ["notify_one_way", "tab.invite.oneWayMessage"],
    ["notify", "tab.invite.notifyMessage"],
    ["review", "tab.invite.message"],
  ] as const) {
    reset(null, "auto", { ...fresh, recording_mode: mode });
    await settle();
    assert.equal(
      nodes(tree).filter((node) => node.props.accessibilityRole === "radiogroup").length,
      0,
      "an existing link cannot be silently switched to the new default",
    );
    await tap("tab.share.whatsapp");
    assert.equal(createCalls, 0);
    assert.deepEqual(invitationMessages, [message], "resharing preserves the existing contract");
  }
  reset(null, "auto", { ...fresh, recording_mode_known: 0 });
  await settle();
  assert.ok(nodes(tree).some((node) => node.props.children === "tab.recordingMode.unknown"));
  assert.equal(
    nodes(tree).filter((node) => node.props.accessibilityRole === "radiogroup").length,
    0,
    "an existing unknown contract remains guarded rather than adopting the new default",
  );
  console.log(
    "PASS: Notify default, ordered recording modes, explicit two-way/approval choices, pending contracts and fixed existing links in EN/FA/PS",
  );
  reset(null);
  await settle();
  nodes(tree)
    .find((node) => node.props.accessibilityLabel === "tab.recordingMode.notify")!
    .props.onPress();
  await settle();
  props.visible = false;
  render();
  props.visible = true;
  render();
  await settle();
  assert.equal(
    nodes(tree).find((node) => node.props.accessibilityLabel === "tab.recordingMode.oneWay")!.props
      .accessibilityState.checked,
    true,
    "A fresh invitation reopens with Notify selected",
  );
  for (const owner of ["account", "vault"]) {
    reset("+93700000000");
    create = () =>
      new Promise((resolve) => {
        finish = resolve;
      });
    await settle();
    await tap("tab.link.whatsapp");
    if (owner === "vault") vaultId = "another-vault";
    else accountId = "another-account";
    render();
    await settle();
    finish({ link: fresh });
    await settle();
    assert.equal(shares.length, 0, "A late create cannot share from another account/book");
    assert.equal(linkedCalls, 0);
  }
  console.log(
    "PASS: new invitations cover all currencies while late account/book scopes remain isolated",
  );

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
