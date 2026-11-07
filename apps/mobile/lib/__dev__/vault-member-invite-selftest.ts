// Execute the member-invite screen against synthetic sessions and requests.
import assert from "node:assert/strict";
import { compileUI, deferred, jsx, nodes, settleUI, uiHooks } from "./ui-fixture";

const john = { account_id: "account-john", name: "John Smith", username: "john" };
class SessionChangedError extends Error {}
class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
  ) {
    super(code);
  }
}

function fixture(options: { profileAccountId?: string } = {}) {
  const hooks = uiHooks();
  let account = "account-owner",
    vault = "vault-a",
    binding = 1;
  let permitted = true,
    online = true,
    focused = true,
    registered = true;
  let guardWait: Promise<unknown> | null = null;
  let sharePreference: Promise<string> | null = null;
  let identityListener: () => void = () => {};
  let refresh: () => void = () => {};
  const writes: Array<{
    vault: string;
    input: any;
    session: any;
    reply: ReturnType<typeof deferred<any>>;
  }> = [];
  const links: Array<{ vault: string; input: any; session: any }> = [];
  const copies: string[] = [];
  const shares: unknown[] = [];
  const messages: unknown[] = [];
  const profileReads: Array<{
    id: string;
    session: any;
    vault: string;
    reply: ReturnType<typeof deferred<any>>;
  }> = [];
  const toast = { push: (...args: unknown[]) => messages.push(args) };
  const destinations: unknown[] = [];
  const router = {
    back: () => {},
    push: () => {},
    dismissTo: (route: unknown) => destinations.push(route),
  };
  const translate = (key: string, params?: any) =>
    params ? `${key}:${JSON.stringify(params)}` : key;
  const Screen = compileUI(
    "../../app/vault/invite",
    {
      react: {
        ...hooks.react,
        useSyncExternalStore: (
          subscribe: (notify: () => void) => () => void,
          snapshot: () => any,
        ) => {
          hooks.react.useEffect(() => subscribe(() => {}), [subscribe]);
          return snapshot();
        },
      },
      "react/jsx-runtime": { jsx, jsxs: jsx, Fragment: "Fragment" },
      "@expo/vector-icons": { Ionicons: "Ionicons" },
      "expo-clipboard": {
        setStringAsync: async (text: string) => {
          copies.push(text);
        },
      },
      "expo-network": {
        useNetworkState: () => ({ isConnected: online, isInternetReachable: online }),
      },
      "expo-router": {
        useRouter: () => router,
        useLocalSearchParams: () => ({ profileAccountId: options.profileAccountId }),
        useIsFocused: () => focused,
        useFocusEffect: (fn: () => void) =>
          hooks.react.useEffect(() => {
            if (focused) fn();
          }, [fn, focused]),
      },
      "react-native": {
        KeyboardAvoidingView: "KeyboardAvoidingView",
        Keyboard: { dismiss: () => {} },
        Platform: { OS: "android" },
        Pressable: "Pressable",
        ScrollView: "ScrollView",
        Share: {
          share: async (value: unknown) => {
            shares.push(value);
          },
        },
        StyleSheet: { create: (value: any) => value, hairlineWidth: 1 },
        Text: "Text",
        TextInput: "TextInput",
        View: "View",
      },
      "react-native-safe-area-context": { SafeAreaView: "SafeAreaView" },
      "../../components/Button": { Button: "Button" },
      "../../components/ConfirmDialog": { ConfirmDialog: "ConfirmDialog" },
      "../../components/PeopleSearchSection": { PeopleSearchSection: "PeopleSearchSection" },
      "../../components/OptionSheet": { OptionSheet: "OptionSheet", SHEET_EXIT_MS: 220 },
      "../../components/SettingsScreen": Object.fromEntries(
        ["EmptyHint", "NavRow", "ScreenHeader", "SectionGap", "SectionHeader"].map((name) => [
          name,
          name,
        ]),
      ),
      "../../components/Toast": { useToast: () => toast },
      "../../lib/colors": { colors: {} },
      "../../lib/auth": {
        SessionChangedError,
        captureCurrentSession: async () => ({
          accountId: account,
          jwt: "session",
          bindingVersion: binding,
        }),
        applyForCurrentSession: async (session: any, work: () => Promise<any>) => {
          if (guardWait) await guardWait;
          if (session.accountId !== account || session.bindingVersion !== binding)
            throw new SessionChangedError();
          return work();
        },
      },
      "../../lib/db-tx": {
        getSessionAccountIdSync: () => account,
        getActiveVaultId: async () => vault,
        getActiveVaultIdSyncMaybe: () => vault,
        onAccountIdentityChanged: (listener: () => void) => {
          identityListener = listener;
          return () => {
            identityListener = () => {};
          };
        },
      },
      "../../lib/direction": {
        ltrIsolate: (v: string) => v,
        rowDir: () => ({}),
        textDir: () => ({}),
        useIsRTL: () => false,
      },
      "../../lib/fonts": { fonts: {}, sansLineHeight: (_size: number, height: number) => height },
      "../../lib/i18n": {
        t: translate,
        tIn: (_lang: string, key: string) => key,
        getShareLangPref: async () => sharePreference ?? "en",
        resolveShareLang: (v: string) => v,
      },
      "../../lib/tokens": { icon: {}, radius: {} },
      "../../lib/use-vault-role": { useVaultPermission: () => permitted },
      "../../lib/ledger-events": {
        useLedgerRefresh: (_vault: unknown, fn: () => void) => {
          refresh = fn;
        },
      },
      "../../lib/people-search": {
        usePeopleSearch: (query: string, enabled: boolean) => ({
          visible: enabled && query.length >= 2,
          people: [john],
          existingPersonIds: { "account-john": "existing-customer" },
          vaultId: vault,
          loading: false,
          error: null,
          hasMore: false,
          retry: () => {},
        }),
      },
      "../../lib/vault-member-requests": {
        createVaultMemberRequest: (id: string, input: any, session: any) => {
          const reply = deferred<any>();
          writes.push({ vault: id, input, session, reply });
          return reply.promise;
        },
      },
      "../../lib/friends-api": {
        getPersonProfile: (id: string, session: any, vault: string, beforeDispatch: () => void) => {
          beforeDispatch();
          const reply = deferred<any>();
          profileReads.push({ id, session, vault, reply });
          return reply.promise;
        },
      },
      "../../lib/vault-api": {
        ApiError,
        listVaults: async () => (registered ? [{ vault_id: vault, name: `Shop ${vault}` }] : []),
        createVaultInvite: async (id: string, input: any, session: any) => {
          links.push({ vault: id, input, session });
          return {
            invite_url: "https://kaata.af/invite/secret",
            invite_email: "",
            expires_at: Date.now() + 86400_000,
          };
        },
      },
    },
    { __DEV__: false },
  ).default;
  const render = () => hooks.render(Screen);
  const all = () => nodes(hooks.tree);
  const one = (type: string) => {
    const node = all().find((n) => n.type === type);
    assert.ok(node, type);
    return node;
  };
  const button = (label: string) => {
    const node = all().find((n) => n.type === "Button" && n.props.label === label);
    assert.ok(node, label);
    return node;
  };
  const settle = async () => {
    await settleUI();
    render();
    await settleUI();
    render();
  };
  const select = async () => {
    one("TextInput").props.onChangeText("john");
    render();
    const section = one("PeopleSearchSection");
    assert.deepEqual(section.props.localPeople, []);
    assert.deepEqual(section.props.visiblePeople, []);
    assert.equal(section.props.actionLabel, "invite.people.action");
    section.props.onSelect(john);
    render();
  };
  const confirm = () => {
    button("invite.people.send").props.onPress();
    render();
    return one("ConfirmDialog");
  };
  render();
  return {
    hooks,
    render,
    all,
    one,
    button,
    settle,
    select,
    confirm,
    writes,
    links,
    copies,
    shares,
    messages,
    profileReads,
    destinations,
    setOnline: (value: boolean) => {
      online = value;
      render();
    },
    setRegistered: (value: boolean) => {
      registered = value;
    },
    setPermission: (value: boolean) => {
      permitted = value;
      render();
    },
    setAccount: (value: string) => {
      account = value;
      binding++;
      identityListener();
      render();
    },
    rebind: () => {
      binding++;
    },
    batchedRebind: () => {
      binding++;
      identityListener();
      identityListener();
      render();
    },
    pauseSharePreference: (wait: Promise<string>) => {
      sharePreference = wait;
    },
    setVault: (value: string) => {
      vault = value;
      refresh();
      render();
    },
    setFocus: (value: boolean) => {
      focused = value;
      render();
    },
    pauseGuard: (wait: Promise<unknown>) => {
      guardWait = wait;
    },
  };
}

async function main() {
  {
    const f = fixture({ profileAccountId: john.account_id });
    await f.settle();
    f.profileReads[0].reply.resolve({ person: john, can_receive_requests: false });
    await f.settle();
    assert.equal(
      f.all().some((node) => node.props.testID === "member-invite-recipient"),
      false,
    );
    assert.equal(f.button("invite.link.create").props.disabled, true);
    assert.equal(
      f.writes.length + f.links.length,
      0,
      "An ineligible profile never becomes a member or wildcard invitation",
    );
  }
  {
    const f = fixture({ profileAccountId: john.account_id });
    await f.settle();
    assert.equal(f.profileReads.length, 1);
    assert.equal(f.profileReads[0].id, john.account_id);
    assert.equal(f.profileReads[0].session.accountId, "account-owner");
    assert.equal(f.profileReads[0].vault, "vault-a");
    assert.equal(
      f.button("invite.link.create").props.disabled,
      true,
      "Profile lookup cannot fall back to a wildcard invite",
    );
    f.profileReads[0].reply.resolve({
      person: { ...john, name: "Authoritative John" },
      can_receive_requests: true,
    });
    await f.settle();
    assert.equal(f.writes.length, 0, "Profile lookup only stages the person");
    const confirmation = f.confirm();
    assert.match(confirmation.props.description, /Authoritative John/);
    assert.match(confirmation.props.description, /Shop vault-a/);
    const sending = confirmation.props.onConfirm();
    await f.settle();
    assert.equal(f.writes.length, 1);
    assert.equal(f.links.length, 0);
    f.writes[0].reply.resolve({ expires_at: Date.now() + 86400_000 });
    await sending;
    await f.settle();
    f.button("peopleProfile.backToProfile").props.onPress();
    await f.settle();
    assert.deepEqual(f.destinations, [
      { pathname: "/people/[accountId]", params: { accountId: john.account_id } },
    ]);
  }
  {
    const f = fixture({ profileAccountId: john.account_id });
    await f.settle();
    f.profileReads[0].reply.reject(new ApiError(404, "person_not_found"));
    await f.settle();
    assert.equal(f.button("invite.link.create").props.disabled, true);
    assert.equal(f.links.length + f.writes.length, 0);
    const retry = f
      .all()
      .find((node) => node.type === "NavRow" && node.props.label === "invite.people.unavailable");
    assert.ok(retry);
    retry.props.onPress();
    await f.settle();
    assert.equal(f.profileReads.length, 2);
    f.setAccount("account-b");
    await f.settle();
    f.profileReads[1].reply.resolve({ person: john, can_receive_requests: true });
    await f.settle();
    assert.equal(
      f.all().some((node) => node.props.testID === "member-invite-recipient"),
      false,
      "Late profile from A cannot stage a person under B",
    );
    assert.equal(f.writes.length, 0);
  }
  {
    const f = fixture({ profileAccountId: john.account_id });
    await f.settle();
    f.profileReads[0].reply.resolve({ person: john, can_receive_requests: true });
    await f.settle();
    const wait = deferred<void>();
    f.pauseGuard(wait.promise);
    f.one("ScreenHeader").props.onBack();
    f.rebind();
    wait.resolve();
    await f.settle();
    assert.deepEqual(
      f.destinations,
      [],
      "A late profile return never navigates under a replacement session",
    );
  }
  {
    const f = fixture();
    await f.settle();
    await f.select();
    assert.equal(f.writes.length, 0, "Selection must only stage the recipient");
    const viewer = f.all().find((n) => n.props?.value === "viewer");
    assert.ok(viewer);
    viewer.props.onSelect("viewer");
    f.render();
    const dialog = f.confirm();
    assert.equal(dialog.props.visible, true);
    assert.match(dialog.props.description, /John Smith/);
    assert.match(dialog.props.description, /invite.role.viewer/);
    dialog.props.onCancel();
    f.render();
    assert.equal(f.writes.length, 0);
    const confirm = f.confirm().props.onConfirm;
    const first = confirm();
    const second = confirm();
    await f.settle();
    assert.equal(f.writes.length, 1, "Same-frame double press sends once");
    assert.deepEqual(f.writes[0].input, { recipientAccountId: john.account_id, role: "viewer" });
    assert.equal(f.writes[0].session.accountId, "account-owner");
    f.writes[0].reply.resolve({ expires_at: Date.now() + 86400_000, delivery: "in_app" });
    await Promise.all([first, second]);
    await f.settle();
    assert.ok(f.button("invite.people.sendAnother"));
    assert.equal(f.links.length, 0);
    assert.equal(
      f.all().some((n) => n.props.label === "invite.copy"),
      false,
      "Targeted invitations never expose a secret share link",
    );
  }
  {
    const f = fixture();
    await f.settle();
    await f.select();
    f.one("TextInput").props.onChangeText("jane");
    f.render();
    assert.equal(
      f.all().some((n) => n.props.testID === "member-invite-recipient"),
      false,
    );
    assert.equal(f.writes.length, 0);
    await f.select();
    const pending = f.confirm().props.onConfirm();
    await f.settle();
    f.writes[0].reply.reject(new ApiError(409, "invite_role_conflict"));
    await pending;
    await f.settle();
    assert.ok(f.all().some((n) => n.props.children === "invite.people.roleConflict"));
    assert.ok(f.button("invite.people.send"));
    assert.equal(f.links.length, 0);
  }
  {
    const f = fixture();
    await f.settle();
    await f.select();
    const barrier = deferred<void>();
    f.pauseGuard(barrier.promise);
    const pending = f.confirm().props.onConfirm();
    f.setVault("vault-b");
    barrier.resolve();
    await pending;
    await f.settle();
    assert.equal(f.writes.length, 0, "Switching vault before transport must prevent the request");
    assert.equal(f.one("TextInput").props.value, "");
  }
  for (const change of ["vault", "account", "session", "focus", "unmount"]) {
    const f = fixture();
    await f.settle();
    await f.select();
    const pending = f.confirm().props.onConfirm();
    await f.settle();
    assert.equal(f.writes.length, 1);
    if (change === "vault") f.setVault("vault-b");
    if (change === "account") f.setAccount("account-b");
    if (change === "session") f.rebind();
    if (change === "focus") f.setFocus(false);
    if (change === "unmount") f.hooks.unmount();
    f.writes[0].reply.resolve({ expires_at: Date.now() + 86400_000 });
    await pending;
    if (change !== "unmount") {
      await f.settle();
      assert.equal(
        f.all().some((n) => n.props.label === "invite.people.sendAnother"),
        false,
        `Old ${change} response must not show success`,
      );
    }
    assert.equal(f.hooks.lateWrites, 0);
  }
  {
    const f = fixture();
    await f.settle();
    await f.select();
    const confirm = f.confirm().props.onConfirm;
    f.setPermission(false);
    await confirm();
    await f.settle();
    assert.equal(f.writes.length, 0, "A permission downgrade invalidates the choice");
  }
  {
    const f = fixture();
    await f.settle();
    f.setOnline(false);
    assert.equal(f.one("TextInput").props.editable, false);
    assert.equal(f.button("invite.link.create").props.disabled, true);
    assert.equal(f.one("PeopleSearchSection").props.search.visible, false);
    await f.button("invite.link.create").props.onPress();
    assert.equal(f.links.length, 0);
  }
  {
    const f = fixture();
    await f.settle();
    await f.select();
    f.batchedRebind();
    await f.settle();
    assert.equal(
      f.all().some((n) => n.props.testID === "member-invite-recipient"),
      false,
      "Same-account sign-out/sign-in clears selection",
    );
    await f.select();
    f.rebind();
    await f.confirm().props.onConfirm();
    await f.settle();
    assert.equal(f.writes.length, 0);
    await f.select();
    const pending = f.confirm().props.onConfirm();
    await f.settle();
    assert.equal(
      f.writes.length,
      1,
      "A rejected old session reloads so the next explicit invitation can proceed",
    );
    f.writes[0].reply.resolve({ expires_at: Date.now() + 86400_000 });
    await pending;
  }
  {
    const f = fixture();
    await f.settle();
    await f.button("invite.link.create").props.onPress();
    await f.settle();
    const copy = f.all().find((n) => n.props.label === "invite.copy");
    assert.ok(copy);
    const share = f.all().find((n) => n.props.label === "invite.shareWhatsapp");
    assert.ok(share);
    const preference = deferred<string>();
    f.pauseSharePreference(preference.promise);
    const pending = share.props.onPress();
    f.setVault("vault-b");
    await f.settle();
    await copy.props.onPress();
    preference.resolve("en");
    await pending;
    assert.deepEqual(f.copies, []);
    assert.deepEqual(f.shares, []);
    assert.equal(
      f.all().some((n) => n.props.label === "invite.copy"),
      false,
    );
  }
  {
    const f = fixture();
    await f.settle();
    await f.button("invite.link.create").props.onPress();
    await f.settle();
    assert.equal(f.links.length, 1);
    assert.deepEqual(f.links[0].input, { email: "", role: "editor" });
    assert.equal(f.links[0].session.accountId, "account-owner");
    const copy = f.all().find((n) => n.props.label === "invite.copy");
    assert.ok(copy);
    await copy.props.onPress();
    assert.deepEqual(f.copies, ["https://kaata.af/invite/secret"]);
    assert.equal(f.writes.length, 0);
  }
  console.log(
    "vault-member-invite selftest: passed (recipient confirmation, role, retry, scope, permissions, offline, and link flow)",
  );
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
