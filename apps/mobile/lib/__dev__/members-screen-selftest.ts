// Execute the real members screen and ledger notifier against controlled native,
// session and query boundaries. No production database, account or network IO.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { colors } from "../colors";
import { VAULT_ROLE_RANK } from "../vault-roles";
import type { VaultRole } from "../events";
import type { MemberCreditPermission } from "../member-credit-permissions";

type Node = { type: string; props: Record<string, any> };
type Deferred = { promise: Promise<void>; resolve: () => void };
const deferred = (): Deferred => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
let slots: any[] = [],
  cursor = 0,
  dirty = false,
  tree: Node;
let effects: (() => void)[] = [];
let focused = true,
  focusEpoch = 0,
  appState = "active";
let activeVault = "v",
  account = "caller",
  binding = 1;
let sessionAccount: string | null | undefined;
let sessionCaptureFails = false;
const currentSessionAccount = () => (sessionAccount === undefined ? account : sessionAccount);
let callerAccepted = true,
  peerAccepted = true,
  peerRevoked = false;
let actorRole: VaultRole = "owner",
  peerRole: VaultRole = "viewer";
let permission: MemberCreditPermission = "inherit";
let permissionRefreshes = 0;
const permissionSaves: { vault: string; account: string; value: MemberCreditPermission }[] = [];
let permissionGate: Deferred | null = null;
let permissionError = false;
let permissionSaveError: string | null = null;
class TestMemberCreditPermissionError extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}
const toastMessages: string[] = [];
const pendingToasts: string[] = [];
let backCalls = 0;
let sessionGate: Deferred | null = null;
let transferGate: Deferred | null = null;
let transferResult: { ok: true } | { ok: false; error: { kind: string } } = { ok: true };
let transferThrows = false;
let failReadsAfterTransfer = false;
let memberReadFailure = false;
const transfers: { vault: string; to: string; from: string | null; demote: string }[] = [];
let inviteGate: Deferred | null = null;
let authorityGate: Deferred | null = null;
let profileGate: Deferred | null = null;
let memberQueries = 0,
  authorityQueries = 0,
  profileRequests = 0;
let nextTimer = 0;
const timeouts = new Map<number, { fn: () => void; ms: number }>();
const intervals = new Map<number, { fn: () => void; ms: number }>();
const appListeners = new Set<(state: string) => void>();
const same = (a?: unknown[], b?: unknown[]) =>
  !!a && !!b && a.length === b.length && a.every((value, index) => Object.is(value, b[index]));
const react = {
  useState(initial: any) {
    const index = cursor++;
    if (!(index in slots)) slots[index] = typeof initial === "function" ? initial() : initial;
    return [
      slots[index],
      (value: any) => {
        const next = typeof value === "function" ? value(slots[index]) : value;
        if (!Object.is(next, slots[index])) {
          slots[index] = next;
          dirty = true;
        }
      },
    ];
  },
  useRef(initial: any) {
    return (slots[cursor++] ??= { current: initial });
  },
  useMemo(fn: () => any, deps: unknown[]) {
    const index = cursor++;
    if (!(index in slots) || !same(slots[index].deps, deps)) slots[index] = { deps, value: fn() };
    return slots[index].value;
  },
  useCallback(fn: (...args: any[]) => any, deps: unknown[]) {
    return react.useMemo(() => fn, deps);
  },
  useEffect(fn: () => void | (() => void), deps?: unknown[]) {
    const index = cursor++;
    const before = slots[index];
    if (before && same(before.deps, deps)) return;
    slots[index] = { deps };
    effects.push(() => {
      before?.cleanup?.();
      slots[index].cleanup = fn();
    });
  },
};
const jsx = (type: any, props: any): Node => ({
  type: typeof type === "function" ? type.name : type,
  props,
});
const nodes = (node: any): Node[] =>
  Array.isArray(node)
    ? node.flatMap(nodes)
    : !node || typeof node !== "object"
      ? []
      : [node, ...nodes(node.props?.children)];
const memberRow = () =>
  nodes(tree).find(
    (node) => node.type === "MemberIdentityRow" && node.props.name === "Current Peer",
  );
const native = {
  AppState: {
    get currentState() {
      return appState;
    },
    addEventListener: (_: string, fn: (state: string) => void) => {
      appListeners.add(fn);
      return { remove: () => appListeners.delete(fn) };
    },
  },
  Pressable: "Pressable",
  RefreshControl: "RefreshControl",
  ScrollView: "ScrollView",
  Text: "Text",
  View: "View",
  StyleSheet: { create: (styles: any) => styles },
};
function compile(file: string, mocks: Record<string, any>) {
  const exports: any = {};
  const code = ts.transpileModule(readFileSync(require.resolve(file), "utf8"), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      jsx: ts.JsxEmit.ReactJSX,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  new Function(
    "require",
    "exports",
    "setTimeout",
    "clearTimeout",
    "setInterval",
    "clearInterval",
    "__DEV__",
    code,
  )(
    (name: string) => {
      assert.ok(name in mocks, `${file}: unexpected dependency ${name}`);
      return mocks[name];
    },
    exports,
    (fn: () => void, ms: number) => {
      const id = ++nextTimer;
      timeouts.set(id, { fn, ms });
      return id;
    },
    (id: number) => timeouts.delete(id),
    (fn: () => void, ms: number) => {
      const id = ++nextTimer;
      intervals.set(id, { fn, ms });
      return id;
    },
    (id: number) => intervals.delete(id),
    false,
  );
  return exports;
}
const ledger = compile("../ledger-events", { react, "react-native": native });
const router = {
  push() {},
  replace() {},
  back() {
    backCalls++;
  },
};
const toast = {
  push(message: string) {
    toastMessages.push(message);
  },
};
const membership = () => [
  { account_id: "caller", accepted_at: callerAccepted ? 1 : null, revoked_at: null },
  { account_id: "next-caller", accepted_at: 1, revoked_at: null },
  { account_id: "peer", accepted_at: peerAccepted ? 1 : null, revoked_at: peerRevoked ? 2 : null },
];
const db = {
  getAllAsync: async (sql: string, ...args: any[]) => {
    if (sql.includes("SELECT vmm.account_id")) {
      memberQueries++;
      if (memberReadFailure) throw new Error("member read unavailable");
      const authorized =
        (args[0] === "next-caller" || callerAccepted) && peerAccepted && !peerRevoked;
      return peerRevoked
        ? []
        : [
            {
              account_id: "peer",
              role: peerRole,
              accepted_at: peerAccepted ? 1 : null,
              revoked_at: null,
              display_name: "Current Peer",
              profile_name: authorized ? "Current Peer" : null,
              has_profile: authorized ? 1 : 0,
              email: authorized ? `${args[0]}-${args[2]}@example.test` : null,
            },
          ];
    }
    if (sql.includes("FROM pending_invitations")) {
      const gate = inviteGate;
      inviteGate = null;
      if (gate) await gate.promise;
      return [];
    }
    if (sql.includes("SELECT account_id, accepted_at, revoked_at")) {
      authorityQueries++;
      const rows = membership();
      const gate = authorityGate;
      authorityGate = null;
      if (gate) await gate.promise;
      return rows;
    }
    if (sql.includes("FROM vault_device_registry")) return [];
    throw new Error(`unexpected members query ${sql}`);
  },
};
const screen = compile("../../app/vault/members", {
  react,
  "react/jsx-runtime": { jsx, jsxs: jsx, Fragment: "Fragment" },
  "react-native": native,
  "react-native-safe-area-context": { SafeAreaView: "SafeArea" },
  "expo-router": {
    useRouter: () => router,
    useLocalSearchParams: () => ({}),
    useFocusEffect: (fn: any) =>
      react.useEffect(() => (focused ? fn() : undefined), [fn, focusEpoch]),
  },
  "../../components/BottomSheet": { BottomSheet: "BottomSheet" },
  "../../components/OptionSheet": { OptionSheet: "OptionSheet" },
  "../../components/ConfirmDialog": { ConfirmDialog: "ConfirmDialog" },
  "../../components/ScreenLoading": { ScreenLoading: "Loading" },
  "../../components/SettingsScreen": Object.fromEntries(
    ["EmptyHint", "NavRow", "ScreenHeader", "SectionGap", "SectionHeader"].map((name) => [
      name,
      name,
    ]),
  ),
  "../../components/Toast": {
    useToast: () => toast,
    queuePendingToast(message: string) {
      pendingToasts.push(message);
    },
  },
  "../../lib/auth": {
    captureCurrentSession: async () => {
      if (sessionCaptureFails) throw new Error("session capture unavailable");
      const snapshot = {
        accountId: currentSessionAccount(),
        jwt: sessionAccount === null ? null : `token-${binding}`,
        bindingVersion: binding,
      };
      if (sessionGate) await sessionGate.promise;
      return snapshot;
    },
    applyForCurrentSession: async (before: any, work: () => Promise<unknown>) => {
      if (before.accountId !== currentSessionAccount() || before.bindingVersion !== binding)
        throw new Error("session changed");
      return work();
    },
    applyForUnchangedLocalSession: async (before: any, work: () => Promise<unknown>) => {
      if (before.accountId !== currentSessionAccount() || before.bindingVersion !== binding)
        throw new Error("session changed");
      return work();
    },
  },
  "../../lib/colors": { colors },
  "../../lib/db-tx": {
    getActiveVaultId: async () => activeVault,
    getActiveVaultIdSyncMaybe: () => activeVault,
    getDb: async () => db,
  },
  "../../lib/db": {
    getAppMeta: async () => account,
    getLocalSelf: async () => ({ name: "Caller" }),
  },
  "../../lib/direction": {
    useIsRTL: () => false,
    rowDir: () => ({}),
    textDir: () => ({}),
    trackingSafe: () => ({}),
  },
  "../../lib/fonts": { fonts: {} },
  "../../lib/i18n": { t: (key: string) => key },
  "../../lib/member-profiles": {
    memberIdentityName: (member: any) => member.display_name,
    refreshMemberProfiles: async () => {
      profileRequests++;
      if (profileGate) await profileGate.promise;
      return true;
    },
  },
  "../../lib/member-credit-permissions": {
    MemberCreditPermissionError: TestMemberCreditPermissionError,
    readMemberCreditPermission: async () => permission,
    refreshMemberCreditPermissions: async () => {
      permissionRefreshes++;
      if (permissionGate) await permissionGate.promise;
      if (permissionError) throw new Error("offline");
    },
    saveMemberCreditPermission: async (
      vault: string,
      account: string,
      value: MemberCreditPermission,
    ) => {
      if (permissionSaveError) throw new TestMemberCreditPermissionError(permissionSaveError);
      permissionSaves.push({ vault, account, value });
      permission = value;
    },
  },
  "../../lib/ledger-events": ledger,
  "../../lib/tokens": { radius: {} },
  "../../lib/use-vault-role": { useVaultRole: () => actorRole },
  "../../lib/vault-roles": { VAULT_ROLE_RANK },
  "../../lib/mesh/presence": { subscribePresence: () => () => {}, isPeerOnline: () => false },
  "../../lib/vault-api": { fetchPendingInvitations: async () => {} },
  "../../lib/event-log": { appendVaultMemberRemoved() {}, appendVaultMemberRoleChanged() {} },
  "../../lib/vault-router": {
    transferVaultOwnership: async (
      vault: string,
      to: string,
      from: string | null,
      demote: string,
      options: { expectedSession: any; shouldContinue: () => boolean },
    ) => {
      assert.equal(options.expectedSession.accountId, currentSessionAccount());
      assert.equal(options.expectedSession.bindingVersion, binding);
      assert.equal(options.shouldContinue(), true);
      transfers.push({ vault, to, from, demote });
      if (transferGate) await transferGate.promise;
      if (transferThrows) throw new Error("transfer unavailable");
      if (failReadsAfterTransfer) memberReadFailure = true;
      return transferResult;
    },
  },
  "../../lib/mesh/device-key": {
    ensureDeviceKey: async () => {},
    readOwnDevicePubkeys: async () => ({ current: null, retired: [] }),
  },
  "../../lib/trust/account-id": { buildLocalAccountId: () => "local" },
}).default;
function unmount() {
  for (const slot of slots) slot?.cleanup?.();
  slots = [];
  effects = [];
}
function fixture() {
  unmount();
  assert.equal(appListeners.size, 0);
  assert.equal(timeouts.size, 0);
  assert.equal(intervals.size, 0);
  focused = true;
  focusEpoch = 0;
  appState = "active";
  activeVault = "v";
  account = "caller";
  binding = 1;
  sessionAccount = undefined;
  sessionCaptureFails = false;
  callerAccepted = true;
  peerAccepted = true;
  peerRevoked = false;
  actorRole = "owner";
  peerRole = "viewer";
  permission = "inherit";
  permissionRefreshes = 0;
  permissionSaves.length = 0;
  permissionGate = null;
  permissionError = false;
  permissionSaveError = null;
  toastMessages.length = 0;
  pendingToasts.length = 0;
  backCalls = 0;
  sessionGate = null;
  transferGate = null;
  transferResult = { ok: true };
  transferThrows = false;
  failReadsAfterTransfer = false;
  memberReadFailure = false;
  transfers.length = 0;
  inviteGate = null;
  authorityGate = null;
  profileGate = null;
  memberQueries = 0;
  authorityQueries = 0;
  profileRequests = 0;
  dirty = true;
}
async function flush() {
  for (let tick = 0; tick < 60; tick++) {
    if (dirty) {
      dirty = false;
      cursor = 0;
      tree = screen();
    }
    effects.splice(0).forEach((fn) => fn());
    await Promise.resolve();
  }
  assert.equal(dirty, false, "member screen settled");
}
async function coalescedReload() {
  const pending = [...timeouts.values()];
  timeouts.clear();
  pending.forEach(({ fn }) => fn());
  await flush();
}
async function poll() {
  for (const timer of intervals.values()) if (timer.ms === 30_000) timer.fn();
  await flush();
}
function appChange(next: string) {
  appState = next;
  for (const fn of [...appListeners]) fn(next);
}
async function refocus() {
  focused = false;
  focusEpoch++;
  dirty = true;
  await flush();
  focused = true;
  focusEpoch++;
  dirty = true;
  await flush();
}

export async function runMembersScreenSelftest() {
  fixture();
  actorRole = "manager";
  await flush();
  assert.equal(memberRow()?.props.disabled, false, "admins can manage staff rows");
  memberRow()!.props.onPress();
  await flush();
  const memberSheet = () => nodes(tree).find((node) => node.type === "BottomSheet")!;
  const permissionSheet = () => nodes(tree).find((node) => node.type === "OptionSheet")!;
  assert.equal(memberSheet().props.visible, true);
  assert.equal(
    memberSheet().props.actions.some((action: any) => action.label === "members.sheet.makeManager"),
    false,
    "admins cannot appoint peer admins",
  );
  assert.equal(
    memberSheet().props.actions.some((action: any) => action.label === "members.sheet.transfer"),
    false,
    "admins cannot transfer ownership",
  );
  memberSheet()
    .props.actions.find((action: any) => action.label === "members.credit.action")
    .onPress();
  await flush();
  assert.equal(permissionSheet().props.visible, true);
  assert.equal(permissionSheet().props.selected, "inherit");
  assert.deepEqual(
    permissionSheet().props.options.map((option: any) => option.key),
    ["inherit", "enforce", "bypass"],
  );
  permissionSheet().props.onSelect("enforce");
  permissionSheet().props.onSelect("bypass");
  await flush();
  assert.deepEqual(
    permissionSaves,
    [{ vault: "v", account: "peer", value: "enforce" }],
    "same-frame taps save one scoped permission",
  );
  assert.equal(permissionSheet().props.visible, false);
  assert.ok(permissionRefreshes >= 2, "permissions refresh on focus and before editing");

  for (const protectedRole of ["manager", "owner"] as const) {
    fixture();
    actorRole = "manager";
    peerRole = protectedRole;
    await flush();
    assert.equal(memberRow()?.props.disabled, true, `admin cannot manage ${protectedRole}`);
    memberRow()!.props.onPress();
    await flush();
    assert.equal(memberSheet().props.visible, false);
  }

  fixture();
  await flush();
  memberRow()!.props.onPress();
  await flush();
  const stalePermission = deferred();
  permissionGate = stalePermission;
  memberSheet()
    .props.actions.find((action: any) => action.label === "members.credit.action")
    .onPress();
  await flush();
  account = "next-caller";
  binding++;
  stalePermission.resolve();
  await flush();
  assert.equal(
    permissionSheet().props.visible,
    false,
    "old session cannot open a permission editor",
  );
  assert.deepEqual(permissionSaves, []);

  fixture();
  await flush();
  memberRow()!.props.onPress();
  await flush();
  permissionError = true;
  memberSheet()
    .props.actions.find((action: any) => action.label === "members.credit.action")
    .onPress();
  await flush();
  assert.equal(
    permissionSheet().props.visible,
    false,
    "offline refresh cannot edit stale exceptions",
  );

  fixture();
  await flush();
  memberRow()!.props.onPress();
  await flush();
  memberSheet()
    .props.actions.find((action: any) => action.label === "members.credit.action")
    .onPress();
  await flush();
  permissionSaveError = "member_cloud_enrollment_required";
  permissionSheet().props.onSelect("enforce");
  await flush();
  assert.ok(
    toastMessages.includes("members.credit.memberNeedsSignIn"),
    "local staff get an actionable enrollment message",
  );

  fixture();
  await flush();
  memberRow()!.props.onPress();
  await flush();
  memberSheet()
    .props.actions.find((action: any) => action.label === "members.credit.action")
    .onPress();
  await flush();
  activeVault = "next-vault";
  permissionSheet().props.onSelect("enforce");
  await flush();
  assert.deepEqual(
    permissionSaves,
    [],
    "switching kaatas cannot save from the old permission editor",
  );
  console.log(
    "PASS admin staff access, protected roles, online member permission choices, duplicate taps and stale session guards",
  );

  const transferDialog = () => nodes(tree).filter((node) => node.type === "ConfirmDialog")[1]!;
  const openTransfer = async () => {
    memberRow()!.props.onPress();
    await flush();
    memberSheet()
      .props.actions.find((action: any) => action.label === "members.sheet.transfer")
      .onPress();
    await flush();
    assert.equal(transferDialog().props.visible, true);
    return transferDialog().props.onConfirm as () => void;
  };
  const dismissTransferDialog = async () => {
    assert.equal(transferDialog().props.visible, false, "confirmation closed before transfer");
    const timers = [...timeouts.entries()].filter(([, timer]) => timer.ms === 300);
    assert.equal(timers.length, 1, "one post-commit native dialog dismissal buffer");
    for (const [id, timer] of timers) {
      timeouts.delete(id);
      timer.fn();
    }
    await flush();
  };

  fixture();
  await flush();
  const confirmTransfer = await openTransfer();
  confirmTransfer();
  confirmTransfer();
  assert.equal(backCalls, 0);
  assert.equal(transfers.length, 0);
  assert.equal(timeouts.size, 0, "dismissal wait starts after the closed render commits");
  await flush();
  assert.equal(transfers.length, 0, "even a fast transfer waits for the native dialog to close");
  assert.equal(
    memberRow()?.props.disabled,
    true,
    "pending transfer disables another member dialog",
  );
  memberSheet().props.onDismiss();
  memberRow()!.props.onPress();
  await flush();
  assert.equal(
    memberSheet().props.visible,
    false,
    "pending transfer cannot open another native modal",
  );
  failReadsAfterTransfer = true;
  const readsBeforeTransfer = memberQueries;
  await dismissTransferDialog();
  assert.deepEqual(
    transfers,
    [{ vault: "v", to: "peer", from: "caller", demote: "editor" }],
    "same callback fired twice before rerender dispatches exactly one ownership change",
  );
  assert.equal(backCalls, 1);
  assert.deepEqual(pendingToasts, ["members.toast.transferred"]);
  assert.deepEqual(toastMessages, [], "successful transfer never becomes a reload failure");
  assert.equal(memberQueries, readsBeforeTransfer, "success returns without a cosmetic read");

  fixture();
  sessionAccount = null;
  await flush();
  const signedOutConfirm = await openTransfer();
  signedOutConfirm();
  await flush();
  await dismissTransferDialog();
  assert.deepEqual(
    transfers,
    [{ vault: "v", to: "peer", from: "caller", demote: "editor" }],
    "signed-out local transfers retain the persisted owner account binding",
  );
  assert.equal(backCalls, 1);
  assert.deepEqual(pendingToasts, ["members.toast.transferred"]);

  for (const phase of ["before", "during"] as const) {
    fixture();
    sessionAccount = null;
    await flush();
    const confirm = await openTransfer();
    const gate = deferred();
    if (phase === "during") transferGate = gate;
    confirm();
    await flush();
    if (phase === "before") account = "next-caller";
    await dismissTransferDialog();
    if (phase === "during") {
      account = "next-caller";
      gate.resolve();
      await flush();
    }
    assert.equal(transfers.length, phase === "before" ? 0 : 1);
    assert.deepEqual(toastMessages, [], "signed-out stale persisted account has no late error");
    assert.deepEqual(pendingToasts, [], "signed-out stale persisted account has no late success");
    assert.equal(backCalls, 0, "signed-out stale persisted account cannot pop another context");
  }

  for (const stale of [false, true]) {
    fixture();
    await flush();
    const confirm = await openTransfer();
    sessionCaptureFails = true;
    confirm();
    await flush();
    if (stale) account = "next-caller";
    await dismissTransferDialog();
    assert.deepEqual(transfers, []);
    assert.deepEqual(toastMessages, stale ? [] : ["members.toast.transferFailed"]);
    assert.equal(backCalls, 0);
  }

  for (const stale of ["account", "vault", "session", "blur"] as const) {
    fixture();
    await flush();
    const confirm = await openTransfer();
    confirm();
    await flush();
    if (stale === "account") account = "next-caller";
    if (stale === "vault") activeVault = "next-vault";
    if (stale === "session") binding++;
    if (stale === "blur") {
      focused = false;
      focusEpoch++;
      dirty = true;
      await flush();
      assert.equal(timeouts.size, 0, "blur cancels pending native dismissal work");
    } else await dismissTransferDialog();
    assert.deepEqual(transfers, [], `${stale} changed before dispatch prevents transfer`);
    assert.deepEqual(toastMessages, []);
    assert.deepEqual(pendingToasts, []);
    assert.equal(backCalls, 0);
    if (stale !== "blur")
      assert.equal(memberRow()?.props.disabled, false, "stale dispatch releases the transfer UI");
  }

  fixture();
  await flush();
  const staleDisplayedAccount = await openTransfer();
  account = "next-caller";
  binding++;
  staleDisplayedAccount();
  await flush();
  await dismissTransferDialog();
  assert.deepEqual(transfers, [], "a newly captured session cannot authorize an older account row");

  for (const throws of [false, true]) {
    for (const stale of ["account", "vault", "session", "blur-and-return"] as const) {
      fixture();
      await flush();
      const confirm = await openTransfer();
      const gate = deferred();
      transferGate = gate;
      transferThrows = throws;
      confirm();
      await flush();
      await dismissTransferDialog();
      assert.equal(transfers.length, 1);
      if (stale === "account") {
        account = "next-caller";
        binding++;
      }
      if (stale === "vault") activeVault = "next-vault";
      if (stale === "session") binding++;
      if (stale === "blur-and-return") await refocus();
      gate.resolve();
      await flush();
      assert.deepEqual(toastMessages, [], `${stale} suppresses late transfer errors`);
      assert.deepEqual(pendingToasts, [], `${stale} suppresses late transfer success`);
      assert.equal(backCalls, 0, `${stale} cannot pop a new screen after transfer completes`);
    }
  }

  fixture();
  await flush();
  const lateSessionConfirm = await openTransfer();
  const delayedSession = deferred();
  sessionGate = delayedSession;
  lateSessionConfirm();
  await flush();
  await dismissTransferDialog();
  binding++;
  delayedSession.resolve();
  await flush();
  assert.deepEqual(transfers, [], "a deferred capture is rechecked immediately before dispatch");
  assert.deepEqual(toastMessages, []);

  fixture();
  await flush();
  transferResult = { ok: false, error: { kind: "not_member" } };
  failReadsAfterTransfer = true;
  const rejectedConfirm = await openTransfer();
  rejectedConfirm();
  await flush();
  await dismissTransferDialog();
  assert.deepEqual(
    toastMessages,
    ["members.toast.transferNotMember"],
    "best-effort rejection reload does not duplicate or replace the real error",
  );
  assert.deepEqual(pendingToasts, []);
  assert.equal(backCalls, 0);

  fixture();
  await flush();
  transferResult = { ok: false, error: { kind: "sync_required" } };
  const notReadyConfirm = await openTransfer();
  notReadyConfirm();
  await flush();
  await dismissTransferDialog();
  assert.deepEqual(toastMessages, ["members.toast.transferSyncRequired"]);
  assert.deepEqual(
    pendingToasts,
    [],
    "an unpublished signing identity never reports transfer success",
  );
  assert.equal(backCalls, 0);

  fixture();
  await flush();
  const unmountedConfirm = await openTransfer();
  const lateTransfer = deferred();
  transferGate = lateTransfer;
  unmountedConfirm();
  await flush();
  await dismissTransferDialog();
  unmount();
  dirty = false;
  lateTransfer.resolve();
  for (let tick = 0; tick < 60; tick++) await Promise.resolve();
  assert.equal(dirty, false, "a completed transfer cannot update an unmounted member screen");
  assert.deepEqual(toastMessages, []);
  assert.deepEqual(pendingToasts, []);
  assert.equal(backCalls, 0);
  console.log(
    "PASS member ownership transfer: one activation, native dialog dismissal before dispatch/pop, successful mutation independent of reads, stale account/vault/session/focus and unmount guards",
  );

  fixture();
  await flush();
  assert.equal(memberRow()?.props.sub, "caller-v@example.test");
  const ordinary = memberRow();
  const queriesBeforeOtherVault = memberQueries;
  ledger.emitLedgerApplied("other", "remote");
  await flush();
  assert.equal(timeouts.size, 0, "another vault does not schedule the visible member query");
  assert.equal(memberQueries, queriesBeforeOtherVault);
  ledger.emitLedgerApplied("v", "remote");
  await flush();
  assert.equal(
    memberRow()?.props.sub,
    ordinary?.props.sub,
    "ordinary tallies preserve current emails before full reload",
  );
  assert.equal(memberRow()?.props.name, ordinary?.props.name);
  assert.equal(authorityQueries, 1);
  await coalescedReload();
  assert.equal(memberRow()?.props.sub, "caller-v@example.test");

  const oldLoad = deferred();
  inviteGate = oldLoad;
  const network = deferred();
  profileGate = network;
  await poll();
  peerRevoked = true;
  ledger.emitLedgerApplied("v", "remote");
  await flush();
  assert.equal(
    memberRow()?.props.sub,
    null,
    "a revoked peer's displayed email is removed before the coalesced reload",
  );
  oldLoad.resolve();
  await flush();
  assert.equal(
    memberRow()?.props.sub,
    null,
    "an older deferred member load cannot repaint the revoked email",
  );
  assert.equal(focusEpoch, 0, "the removal does not require navigation focus");
  await coalescedReload();
  assert.equal(memberRow(), undefined, "the complete reload removes the revoked member row");
  network.resolve();
  await flush();

  fixture();
  await flush();
  callerAccepted = false;
  ledger.emitLedgerApplied("v", "remote");
  await flush();
  assert.equal(
    memberRow()?.props.sub,
    null,
    "a pending caller loses the cached peer email promptly",
  );
  assert.equal(
    memberRow()?.props.name,
    "Current Peer",
    "authorization cleanup leaves the name stable",
  );
  await coalescedReload();
  assert.equal(memberRow()?.props.sub, null);

  fixture();
  const initialLoad = deferred();
  inviteGate = initialLoad;
  const initialNetwork = deferred();
  profileGate = initialNetwork;
  await flush();
  peerRevoked = true;
  ledger.emitLedgerApplied("v", "remote");
  initialLoad.resolve();
  await flush();
  assert.equal(
    memberRow(),
    undefined,
    "commit invalidates the initial load before vault state was populated",
  );
  await coalescedReload();
  assert.equal(memberRow(), undefined);
  initialNetwork.resolve();
  await flush();

  fixture();
  await flush();
  callerAccepted = false;
  const oldAuthorization = deferred();
  authorityGate = oldAuthorization;
  ledger.emitLedgerApplied("v", "remote");
  await flush();
  callerAccepted = true;
  ledger.emitLedgerApplied("v", "remote");
  await flush();
  oldAuthorization.resolve();
  await flush();
  assert.equal(
    memberRow()?.props.sub,
    "caller-v@example.test",
    "a superseded denial cannot clear restored current authorization",
  );
  await coalescedReload();

  fixture();
  await flush();
  assert.ok(memberRow());
  // Audit #19: coming back keeps the list on screen while it refreshes; it
  // used to blank to a full-screen spinner (and could flash "No members").
  focused = false;
  focusEpoch++;
  dirty = true;
  await flush();
  focused = true;
  focusEpoch++;
  // One synchronous tick: render, run the focus effect, render what it set.
  cursor = 0;
  tree = screen();
  effects.splice(0).forEach((fn) => fn());
  if (dirty) {
    dirty = false;
    cursor = 0;
    tree = screen();
  }
  assert.ok(memberRow(), "the list stays while it refreshes on return");
  await flush();

  fixture();
  await flush();
  callerAccepted = false;
  const beforeBlur = deferred();
  authorityGate = beforeBlur;
  ledger.emitLedgerApplied("v", "remote");
  await flush();
  focused = false;
  focusEpoch++;
  dirty = true;
  await flush();
  callerAccepted = true;
  ledger.emitLedgerApplied("v", "remote");
  await flush();
  focused = true;
  focusEpoch++;
  dirty = true;
  await flush();
  beforeBlur.resolve();
  await flush();
  assert.equal(
    memberRow()?.props.sub,
    "caller-v@example.test",
    "a pre-blur denial cannot wipe a freshly refocused view of the same account/vault",
  );

  fixture();
  await flush();
  callerAccepted = false;
  const oldSession = deferred();
  authorityGate = oldSession;
  ledger.emitLedgerApplied("v", "remote");
  await flush();
  account = "next-caller";
  binding++;
  callerAccepted = true;
  await refocus();
  assert.equal(memberRow()?.props.sub, "next-caller-v@example.test");
  oldSession.resolve();
  await flush();
  assert.equal(
    memberRow()?.props.sub,
    "next-caller-v@example.test",
    "the previous session's denial cannot wipe the new session's email",
  );

  fixture();
  await flush();
  callerAccepted = false;
  const oldVault = deferred();
  authorityGate = oldVault;
  ledger.emitLedgerApplied("v", "remote");
  await flush();
  activeVault = "next-vault";
  callerAccepted = true;
  await refocus();
  oldVault.resolve();
  await flush();
  assert.equal(
    memberRow()?.props.sub,
    "caller-next-vault@example.test",
    "the previous vault's check cannot wipe a new vault overlay",
  );

  fixture();
  await flush();
  const beforeBackground = profileRequests;
  appChange("background");
  await poll();
  assert.equal(profileRequests, beforeBackground, "background polling does not request profiles");
  peerAccepted = false;
  ledger.emitLedgerApplied("v", "remote");
  await flush();
  assert.equal(
    memberRow()?.props.sub,
    null,
    "background membership application clears the unauthorized overlay",
  );
  appChange("active");
  await flush();
  await coalescedReload();
  assert.equal(memberRow()?.props.sub, null);
  assert.equal(focusEpoch, 0);

  fixture();
  await flush();
  callerAccepted = false;
  const afterUnmount = deferred();
  authorityGate = afterUnmount;
  ledger.emitLedgerApplied("v", "remote");
  await flush();
  unmount();
  dirty = false;
  afterUnmount.resolve();
  for (let tick = 0; tick < 60; tick++) await Promise.resolve();
  assert.equal(dirty, false, "authorization work cannot set state after unmount");
  assert.equal(appListeners.size, 0);
  assert.equal(timeouts.size, 0);
  assert.equal(intervals.size, 0);
  console.log(
    "PASS members screen: deferred/initial loads, immediate scoped email authorization, stable ordinary tallies, superseded/session/vault guards, background/resume and subscription cleanup",
  );
}

if (require.main === module)
  void runMembersScreenSelftest().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
