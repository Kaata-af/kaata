// Execute the real sender screen. All account, clipboard and composer IO is
// controlled; the English and Dari dictionaries are the production ones.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { compileUI, deferred, jsx, nodes, settleUI, uiHooks } from "./ui-fixture";
import type { VaultRole } from "../events";

const i18n = compileUI("../i18n", {
  "expo-localization": { getLocales: () => [{ languageCode: "en" }] },
  "./db": { getAppMeta: async () => null },
}) as typeof import("../i18n");
class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}
type Pending = { recipient_email: string; expires_at: number };
const expires = Date.now() + 86400_000;
const result = {
  invite_url: "https://kaata.af/invite/private-ownership-token",
  invite_email: "new.owner@example.test",
  expires_at: expires,
};
function fixture(
  options: {
    locale?: "en" | "fa";
    role?: VaultRole;
    jwt?: string | null;
    offline?: boolean;
    pending?: Pending;
    delayFetch?: boolean;
  } = {},
) {
  const hooks = uiHooks();
  const locale = options.locale ?? "en";
  i18n.setLocale(locale);
  let role: VaultRole = options.role ?? "owner";
  let activeVault = "vault",
    account = "owner",
    binding = 1;
  let jwt = options.jwt === undefined ? "jwt" : options.jwt;
  let remotePending = options.pending ?? null;
  let ledgerRefresh: () => void = () => {};
  let createGate: ReturnType<typeof deferred<void>> | null = null;
  let cancelGate: ReturnType<typeof deferred<void>> | null = null;
  const fetchGate = options.delayFetch ? deferred<void>() : null;
  let fetchError: ApiError | null = null;
  const creates: { vault: string; email: string }[] = [];
  const cancels: string[] = [];
  const opens: string[] = [],
    copies: string[] = [],
    notices: string[] = [],
    routes: any[] = [];
  const listeners = new Set<(state: string) => void>();
  const router = { back: () => routes.push("back"), push: (route: any) => routes.push(route) };
  const toast = { push: (value: string) => notices.push(value) };
  const Screen = compileUI("../../app/vault/transfer", {
    react: hooks.react,
    "react/jsx-runtime": { jsx, jsxs: jsx },
    "@expo/vector-icons": { Ionicons: "Ionicons" },
    "expo-clipboard": {
      setStringAsync: async (value: string) => {
        copies.push(value);
      },
    },
    "expo-network": {
      getNetworkStateAsync: async () => ({
        isConnected: !options.offline,
        isInternetReachable: !options.offline,
      }),
    },
    "expo-router": {
      useRouter: () => router,
      useFocusEffect: (fn: () => void) => hooks.react.useEffect(fn, [fn]),
    },
    "react-native": {
      AppState: {
        addEventListener: (_: string, fn: (state: string) => void) => {
          listeners.add(fn);
          return { remove: () => listeners.delete(fn) };
        },
      },
      KeyboardAvoidingView: "KeyboardAvoidingView",
      ScrollView: "ScrollView",
      Text: "Text",
      View: "View",
      Platform: { OS: "android" },
      StyleSheet: { create: (value: any) => value },
      Linking: {
        openURL: async (value: string) => {
          opens.push(value);
        },
      },
    },
    "react-native-safe-area-context": { SafeAreaView: "SafeAreaView" },
    "../../components/Button": { Button: "Button" },
    "../../components/ConfirmDialog": { ConfirmDialog: "ConfirmDialog" },
    "../../components/FormField": {
      FormField: "FormField",
      LTR_INPUT: { writingDirection: "ltr", textAlign: "left" },
    },
    "../../components/ScreenLoading": { ScreenLoading: "ScreenLoading" },
    "../../components/SettingsScreen": {
      EmptyHint: "EmptyHint",
      NavRow: "NavRow",
      ScreenHeader: "ScreenHeader",
      SectionGap: "SectionGap",
      SectionHeader: "SectionHeader",
    },
    "../../components/Toast": {
      useToast: () => toast,
    },
    "../../lib/auth": {
      captureCurrentSession: async () => ({ jwt, accountId: account, bindingVersion: binding }),
      applyForCurrentSession: async (snapshot: any, fn: () => Promise<any>) => {
        if (!jwt || snapshot.bindingVersion !== binding || snapshot.accountId !== account)
          throw Error("session_changed");
        const value = await fn();
        if (snapshot.bindingVersion !== binding || snapshot.accountId !== account)
          throw Error("session_changed");
        return value;
      },
    },
    "../../lib/colors": require("../colors"),
    "../../lib/db-tx": {
      getActiveVaultId: async () => activeVault,
      getActiveVaultIdSyncMaybe: () => activeVault,
      getAccountIdSync: () => account,
      getDb: async () => ({
        getFirstAsync: async () => ({
          name: locale === "fa" ? "دکان" : "Store",
          archived_at: null,
        }),
      }),
    },
    "../../lib/direction": {
      useIsRTL: () => locale === "fa",
      textDir: (rtl: boolean) => ({ textAlign: rtl ? "right" : "left" }),
      rowDir: (rtl: boolean) => ({ flexDirection: rtl ? "row-reverse" : "row" }),
    },
    "../../lib/i18n": i18n,
    "../../lib/ledger-events": {
      useLedgerRefresh: (_: string | null, fn: () => void) => {
        ledgerRefresh = fn;
      },
    },
    "../../lib/tokens": { typography: {}, icon: {}, radius: {} },
    "../../lib/use-vault-role": { useVaultRole: () => role, readVaultRole: async () => role },
    "../../lib/vault-api": {
      ApiError,
      fetchOwnershipTransferInvite: async (_vault: string, session: any) => {
        assert.equal(session.accountId, account, "status uses the screen's captured account");
        assert.equal(session.bindingVersion, binding, "status uses the screen's captured session");
        const captured = remotePending;
        if (fetchGate) await fetchGate.promise;
        if (fetchError) throw fetchError;
        return captured;
      },
      createOwnershipTransferInvite: async (vault: string, email: string, session: any) => {
        assert.equal(session.accountId, account, "create uses the screen's captured account");
        assert.equal(session.bindingVersion, binding, "create uses the screen's captured session");
        creates.push({ vault, email });
        if (createGate) await createGate.promise;
        remotePending = { recipient_email: result.invite_email, expires_at: expires };
        return result;
      },
      cancelOwnershipTransferInvite: async (vault: string, session: any) => {
        assert.equal(session.accountId, account, "cancel uses the screen's captured account");
        assert.equal(session.bindingVersion, binding, "cancel uses the screen's captured session");
        cancels.push(vault);
        if (cancelGate) await cancelGate.promise;
        remotePending = null;
      },
    },
  }).default;
  const render = async () => {
    for (let i = 0; i < 8; i++) {
      await settleUI();
      hooks.render(Screen);
    }
  };
  const find = (type: string, label?: string) =>
    nodes(hooks.tree).find(
      (node) => node.type === type && (label === undefined || node.props.label === label),
    );
  const row = (key: Parameters<typeof i18n.t>[0]) => find("NavRow", i18n.tIn(locale, key));
  const createButton = () => find("Button", i18n.tIn(locale, "ownershipTransfer.create"));
  const confirm = () =>
    nodes(hooks.tree).find((node) => node.type === "ConfirmDialog" && node.props.visible);
  const fill = async (email = result.invite_email) => {
    find("FormField")!.props.onChangeText(email);
    await render();
  };
  const startCreate = async () => {
    await fill();
    createButton()!.props.onPress();
    await render();
    confirm()!.props.onConfirm();
    await render();
  };
  hooks.render(Screen);
  return {
    hooks,
    render,
    find,
    row,
    confirm,
    fill,
    startCreate,
    createButton,
    creates,
    cancels,
    opens,
    copies,
    notices,
    routes,
    setRole: (value: VaultRole) => {
      role = value;
    },
    switchSession: () => {
      binding++;
      account = "different-owner";
      jwt = "different-jwt";
    },
    rotateSession: () => {
      binding++;
      jwt = "new-jwt-for-same-account";
    },
    switchVault: () => {
      activeVault = "other-vault";
    },
    refresh: () => ledgerRefresh(),
    resume: () => listeners.forEach((fn) => fn("active")),
    fetchGate,
    setFetchError: () => {
      fetchError = new ApiError(503, "unavailable");
    },
    delayCreate: () => (createGate = deferred<void>()),
    delayCancel: () => (cancelGate = deferred<void>()),
    listenerCount: () => listeners.size,
  };
}

async function run() {
  for (const locale of ["en", "fa"] as const) {
    const f = fixture({ locale });
    await f.render();
    const key = (value: Parameters<typeof i18n.t>[0]) => i18n.tIn(locale, value);
    assert.ok(f.createButton());
    assert.equal(
      f.find("FormField")!.props.style.writingDirection,
      "ltr",
      "email remains LTR in Dari",
    );
    f.createButton()!.props.onPress();
    await f.render();
    assert.equal(f.find("FormField")!.props.error, key("invite.email.required"));
    await f.fill("no-email");
    f.createButton()!.props.onPress();
    await f.render();
    assert.equal(f.find("FormField")!.props.error, key("invite.email.invalid"));
    assert.equal(f.creates.length, 0);
    await f.fill(" new.owner@example.test ");
    f.createButton()!.props.onPress();
    await f.render();
    assert.ok(f.confirm()!.props.description.includes("new.owner@example.test"));
    const gate = f.delayCreate();
    const confirm = f.confirm()!.props.onConfirm;
    confirm();
    confirm();
    await f.render();
    assert.deepEqual(
      f.creates,
      [{ vault: "vault", email: "new.owner@example.test" }],
      "same-frame taps mint one token",
    );
    gate.resolve();
    await f.render();
    assert.ok(!f.createButton(), "pending invitation replaces the form");
    assert.ok(f.row("ownershipTransfer.cancel"));
    f.row("invite.copy")!.props.onPress();
    await f.render();
    assert.deepEqual(f.copies, [result.invite_url]);
    f.row("ownershipTransfer.shareEmail")!.props.onPress();
    await f.render();
    const email = new URL(f.opens[0]);
    assert.equal(email.protocol, "mailto:");
    assert.equal(decodeURIComponent(email.pathname), result.invite_email);
    assert.ok(email.searchParams.get("body")?.includes(result.invite_url));
    assert.ok(email.searchParams.get("subject"));
    f.row("invite.shareWhatsapp")!.props.onPress();
    await f.render();
    const whatsapp = new URL(f.opens[1]);
    assert.equal(whatsapp.protocol, "whatsapp:");
    assert.ok(whatsapp.searchParams.get("text")?.includes(result.invite_url));
    f.resume();
    await f.render();
    assert.ok(f.row("invite.copy"), "resuming retains the matching in-memory link");
    const cancelGate = f.delayCancel();
    f.row("ownershipTransfer.cancel")!.props.onPress();
    await f.render();
    const cancel = f.confirm()!.props.onConfirm;
    cancel();
    cancel();
    await f.render();
    assert.equal(f.cancels.length, 1);
    assert.ok(!f.row("invite.copy"), "cancellation immediately hides the old link");
    cancelGate.resolve();
    await f.render();
    assert.ok(f.createButton());
    f.row("ownershipTransfer.existingMember")!.props.onPress();
    assert.deepEqual(f.routes.at(-1), {
      pathname: "/vault/members",
      params: { action: "transfer" },
    });
    f.hooks.unmount();
    assert.equal(f.listenerCount(), 0);
  }
  console.log(
    "PASS ownership sender: English/Dari validation, explicit confirmation, duplicate locking, pending status, scoped native composers, copy and cancellation",
  );

  for (const options of [
    { role: "manager" as const },
    { role: "editor" as const },
    { jwt: null },
    { offline: true },
  ]) {
    const f = fixture(options);
    await f.render();
    assert.ok(!f.createButton());
    assert.ok(!f.row("invite.copy"));
    assert.equal(f.creates.length, 0);
    if (options.jwt === null || options.offline)
      assert.ok(
        f.row("ownershipTransfer.existingMember"),
        "existing offline member transfer remains available",
      );
    f.hooks.unmount();
  }
  const recovered = fixture({
    pending: { recipient_email: result.invite_email, expires_at: expires },
  });
  await recovered.render();
  assert.ok(recovered.row("ownershipTransfer.cancel"));
  assert.ok(
    !recovered.row("invite.copy"),
    "server status cannot invent or expose a plaintext token",
  );
  assert.ok(!recovered.createButton(), "recovered pending invitation cannot be silently replaced");
  recovered.hooks.unmount();
  const failure = fixture();
  await failure.render();
  failure.setFetchError();
  failure.refresh();
  await failure.render();
  assert.ok(
    !failure.createButton(),
    "unknown pending status blocks creation until a successful check",
  );
  failure.hooks.unmount();
  console.log(
    "PASS ownership sender: owners only, signed-in/online gates, recoverable pending status without stored tokens and failed-status guard",
  );

  for (const change of ["switchSession", "switchVault", "rotateSession"] as const) {
    const f = fixture();
    await f.render();
    const gate = f.delayCreate();
    await f.startCreate();
    assert.equal(f.creates.length, 1);
    f[change]();
    await f.render();
    if (change !== "rotateSession")
      assert.equal(f.hooks.tree.type, "ScreenLoading", "a changed scope cannot paint old data");
    gate.resolve();
    await f.render();
    assert.ok(!f.row("invite.copy"), "old scope reply cannot publish its secret");
    assert.equal(f.notices.length, 0);
    f.hooks.unmount();
  }
  const beforeSend = fixture();
  await beforeSend.render();
  await beforeSend.fill();
  beforeSend.createButton()!.props.onPress();
  await beforeSend.render();
  const staleConfirm = beforeSend.confirm()!.props.onConfirm;
  beforeSend.setRole("editor");
  staleConfirm();
  await beforeSend.render();
  assert.equal(
    beforeSend.creates.length,
    0,
    "permission is checked again at submit, before a role rerender",
  );
  beforeSend.hooks.unmount();
  const demotion = fixture();
  await demotion.render();
  const demoteGate = demotion.delayCreate();
  await demotion.startCreate();
  demotion.setRole("editor");
  await demotion.render();
  demoteGate.resolve();
  await demotion.render();
  assert.ok(!demotion.row("invite.copy"));
  assert.ok(!demotion.createButton());
  assert.equal(demotion.notices.length, 0);
  demotion.hooks.unmount();
  const unmounted = fixture();
  await unmounted.render();
  const unmountGate = unmounted.delayCreate();
  await unmounted.startCreate();
  unmounted.hooks.unmount();
  unmountGate.resolve();
  await settleUI();
  assert.equal(unmounted.hooks.lateWrites, 0);
  console.log(
    "PASS ownership sender: account/vault/role changes and unmount cannot expose stale links or update a different scope",
  );

  // Entry points must also reach the new screen for a one-person store build.
  const settings = readFileSync(require.resolve("../../app/vault/settings"), "utf8");
  assert.ok(settings.includes('pathname: "/vault/transfer"'));
  assert.ok(!settings.includes("memberCount > 1 || !SOLO_STORE_MODE"));
}
void run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
