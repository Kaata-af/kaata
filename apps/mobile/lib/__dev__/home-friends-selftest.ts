import assert from "node:assert/strict";
import { compileUI, deferred, flattenStyle, jsx, nodes, settleUI, uiHooks } from "./ui-fixture";

const JOHN = {
  account_id: "john",
  name: "John Smith",
  username: "john",
  picture_url: "https://photos.invalid/john",
};
const JANE = { account_id: "jane", name: "Jane Doe", username: "jane" };
class SessionChangedError extends Error {}
class TabApiError extends Error {
  constructor(public status: number) {
    super();
  }
}
function dataFixture() {
  const hooks = uiHooks();
  const identityListeners = new Set<() => void>();
  const peopleListeners = new Set<(event: any) => void>();
  const noticeListeners = new Set<(event: any) => void>();
  const appListeners = new Set<(state: string) => void>();
  const timers = new Set<() => void>();
  let afterApplied: (() => void) | null = null;
  const directoryInvalidations: string[] = [];
  let account: string | null = "me",
    binding = 1,
    focused = true,
    enabled = true,
    offline = false,
    now = 1_000;
  const app = {
    currentState: "active",
    addEventListener: (_: string, fn: (state: string) => void) => {
      appListeners.add(fn);
      return { remove: () => appListeners.delete(fn) };
    },
  };
  const reads: { after?: string; session: any; reply: ReturnType<typeof deferred<any>> }[] = [];
  const react = {
    ...hooks.react,
    useSyncExternalStore: (subscribe: any, get: any) => {
      const [, setVersion] = hooks.react.useState(0);
      hooks.react.useEffect(() => subscribe(() => setVersion((n: number) => n + 1)), [subscribe]);
      return get();
    },
  };
  const module = compileUI(
    "../use-friends",
    {
      react,
      "expo-router": { useIsFocused: () => focused },
      "expo-network": {
        useNetworkState: () => ({ isConnected: !offline, isInternetReachable: !offline }),
      },
      "react-native": { AppState: app },
      "./auth": {
        SessionChangedError,
        captureCurrentSession: async () => ({ accountId: account, bindingVersion: binding }),
        applyForCurrentSession: async (session: any, work: () => any) => {
          if (session.accountId !== account || session.bindingVersion !== binding)
            throw new SessionChangedError();
          const result = await work();
          const after = afterApplied;
          afterApplied = null;
          after?.();
          return result;
        },
      },
      "./db-tx": {
        getSessionAccountIdSync: () => account,
        onAccountIdentityChanged: (fn: () => void) => {
          identityListeners.add(fn);
          return () => identityListeners.delete(fn);
        },
      },
      "./friends-api": {
        listFriends: (after: string | undefined, session: any) => {
          const reply = deferred<any>();
          reads.push({ after, session, reply });
          return reply.promise;
        },
      },
      "./people-search-events": {
        notifyPeopleSearchChanged: (event: any) => {
          directoryInvalidations.push(event.accountId);
          for (const fn of peopleListeners) fn(event);
        },
        onPeopleSearchChanged: (fn: (event: any) => void) => {
          peopleListeners.add(fn);
          return () => peopleListeners.delete(fn);
        },
      },
      "./notification-events": {
        onNotificationInboxChanged: (fn: (event: any) => void) => {
          noticeListeners.add(fn);
          return () => noticeListeners.delete(fn);
        },
      },
      "./tabs/errors": { TabApiError },
    },
    {
      Date: { now: () => now },
      setInterval: (fn: () => void) => {
        timers.add(fn);
        return fn;
      },
      clearInterval: (fn: () => void) => timers.delete(fn),
    },
  );
  const render = () => hooks.render(() => jsx("Hook", { value: module.useFriends(enabled) }));
  const value = () => hooks.tree.props.value;
  const settle = async () => {
    await settleUI();
    render();
    await settleUI();
    render();
  };
  render();
  return {
    reads,
    render,
    value,
    settle,
    hooks,
    directoryInvalidations,
    afterApplied: (fn: () => void) => {
      afterApplied = fn;
    },
    focus: (next: boolean) => {
      focused = next;
      render();
    },
    enable: (next: boolean) => {
      enabled = next;
      render();
    },
    offline: (next: boolean) => {
      offline = next;
      render();
    },
    advance: (ms: number) => {
      now += ms;
    },
    app: (state: string) => {
      app.currentState = state;
      for (const fn of appListeners) fn(state);
      render();
    },
    changeIdentity: (next: string | null) => {
      account = next;
      binding++;
      for (const fn of identityListeners) fn();
      render();
    },
    friendChanged: (who = account, vaultId?: string) => {
      for (const fn of peopleListeners) fn({ accountId: who, vaultId });
      render();
    },
    remoteChanged: (who = account) => {
      for (const fn of noticeListeners) fn({ account: who, source: "push" });
      render();
    },
    poll: () => {
      for (const fn of timers) fn();
      render();
    },
  };
}

async function main() {
  {
    const f = dataFixture();
    await f.settle();
    assert.equal(f.reads.length, 1);
    f.focus(false);
    f.focus(true);
    await f.settle();
    f.reads[0].reply.resolve({ friends: [JOHN], next_cursor: "page-two" });
    await f.settle();
    assert.deepEqual(f.value().rows, [JOHN], "First page is usable while remaining friends arrive");
    assert.equal(f.reads[1].after, "page-two");
    f.reads[1].reply.resolve({ friends: [JOHN, JANE] });
    await f.settle();
    assert.deepEqual(f.value().rows, [JOHN, JANE], "Pagination deduplicates by account");
    assert.equal(f.value().loaded, true);
    assert.equal(
      f.reads.length,
      2,
      "Returning during the first load joins it without a second fetch",
    );
    const stale = f.value().isCurrent;
    f.focus(false);
    assert.equal(stale(), false, "Retained row callbacks respect current focus");
    f.focus(true);
    f.app("background");
    f.app("active");
    f.enable(false);
    f.enable(true);
    await f.settle();
    assert.equal(f.reads.length, 2, "Sheets, resume and focus do not refetch fresh friends");
    assert.deepEqual(f.value().rows, [JOHN, JANE]);
    f.offline(true);
    assert.deepEqual(f.value().rows, [JOHN, JANE], "Offline retains known friends");
    f.offline(false);
    f.advance(5 * 60_000);
    f.poll();
    await f.settle();
    assert.equal(f.reads.length, 3);
    assert.deepEqual(f.value().rows, [JOHN, JANE], "A background refresh never blanks the list");
    f.reads[2].reply.resolve({ friends: [JANE], next_cursor: "page-two" });
    await f.settle();
    assert.deepEqual(
      f.value().rows,
      [JOHN, JANE],
      "Refresh waits for every page before replacing rows",
    );
    f.reads[3].reply.reject(new Error("offline"));
    await f.settle();
    assert.equal(f.value().failed, true);
    assert.deepEqual(
      f.value().rows,
      [JOHN, JANE],
      "Transient failures keep the last complete list",
    );
    f.focus(false);
    f.focus(true);
    await f.settle();
    assert.equal(f.reads.length, 4, "Failures do not cause a focus retry loop");
    f.friendChanged();
    await f.settle();
    assert.equal(f.reads.length, 5, "Explicit friendship changes bypass failure backoff");
    f.reads[4].reply.resolve({ friends: [JANE] });
    await f.settle();
    assert.deepEqual(f.value().rows, [JANE], "Removed friends disappear after refresh");
    assert.equal(f.value().removedAccountIds.has("john"), true);
    assert.deepEqual(
      f.directoryInvalidations,
      ["me"],
      "Authoritative membership changes invalidate stale directory badges",
    );
    f.friendChanged("another-account");
    f.friendChanged("me", "another-book");
    await f.settle();
    assert.equal(f.reads.length, 5, "Other accounts and ledger-only changes leave friends alone");
    f.remoteChanged();
    await f.settle();
    assert.equal(f.reads.length, 6, "Remote acceptance/removal invalidates friends");
    f.reads[5].reply.resolve({ friends: [JOHN, JANE] });
    await f.settle();
    assert.equal(
      f.value().removedAccountIds.has("john"),
      false,
      "Re-added friends clear their stale-directory tombstone",
    );
    f.hooks.unmount();
  }
  {
    const f = dataFixture();
    await f.settle();
    f.afterApplied(() => f.changeIdentity("second"));
    f.reads[0].reply.resolve({ friends: [JOHN], next_cursor: "page-two" });
    await f.settle();
    assert.equal(f.value().accountId, "second");
    assert.deepEqual(
      f.value().rows,
      [],
      "Identity changes after the protected callback cannot commit another account's page",
    );
    assert.equal(f.reads.length, 2, "Old pagination stops before dispatching another page");
    f.reads[1].reply.resolve({ friends: [JANE] });
    await f.settle();
    const isCurrent = f.value().isCurrent;
    f.hooks.unmount();
    assert.equal(isCurrent(), false, "Unmounted rows cannot navigate");
  }
  {
    const f = dataFixture();
    await f.settle();
    const old = f.reads[0];
    f.changeIdentity(null);
    assert.equal(f.value().accountId, null);
    assert.deepEqual(f.value().rows, []);
    f.changeIdentity("second");
    await f.settle();
    old.reply.resolve({ friends: [JOHN] });
    await f.settle();
    assert.deepEqual(f.value().rows, [], "A stale account reply cannot repopulate the cache");
    f.reads[1].reply.resolve({ friends: [JANE] });
    await f.settle();
    assert.deepEqual(f.value().rows, [JANE]);
    const oldAction = f.value().isCurrent;
    f.changeIdentity("second");
    await f.settle();
    assert.equal(oldAction(), false, "Same-account credential rebind invalidates old actions");
    assert.deepEqual(f.value().rows, []);
    f.reads[2].reply.resolve({ friends: [] });
    await f.settle();
    f.hooks.unmount();
  }
  {
    const f = dataFixture();
    await f.settle();
    f.reads[0].reply.resolve({ friends: [JOHN] });
    await f.settle();
    f.value().retry();
    await f.settle();
    f.reads[1].reply.reject(new TabApiError(401));
    await f.settle();
    assert.deepEqual(f.value().rows, [], "Revoked authentication clears cached identities");
    f.hooks.unmount();
  }
  {
    const f = dataFixture();
    await f.settle();
    f.reads[0].reply.resolve({ friends: [JOHN], next_cursor: "cursor-a" });
    await f.settle();
    f.reads[1].reply.resolve({ friends: [JANE], next_cursor: "cursor-b" });
    await f.settle();
    f.reads[2].reply.resolve({ friends: [], next_cursor: "cursor-a" });
    await f.settle();
    assert.equal(f.value().failed, true, "A cursor cycle cannot keep fetching forever");
    assert.equal(f.reads.length, 3);
    f.hooks.unmount();
    assert.equal(f.hooks.lateWrites, 0);
  }
  componentChecks();
  console.log(
    "PASS home friends: account-scoped cache, full pagination, background/failed refresh, identity and stale callback guards, photo fallback, RTL and inline search",
  );
}

function componentChecks() {
  const hooks = uiHooks();
  let currentHooks = hooks;
  let rtl = false,
    current = true;
  const selected: string[] = [];
  const state: any = {
    accountId: "me",
    rows: [JOHN, JANE],
    removedAccountIds: new Set(),
    loaded: true,
    loading: false,
    failed: false,
    offline: false,
    isCurrent: () => current,
    retry: () => {},
  };
  const normalize = (value: string) => value.toLowerCase().trim();
  const mocks = {
    react: {
      useRef: (value: any) => currentHooks.react.useRef(value),
      useState: (value: any) => currentHooks.react.useState(value),
    },
    "react/jsx-runtime": { jsx, jsxs: jsx },
    "@expo/vector-icons": { Ionicons: "Icon" },
    "react-native": {
      ActivityIndicator: "Spinner",
      Image: "Image",
      Pressable: "Pressable",
      Text: "Text",
      View: "View",
      StyleSheet: { create: (v: any) => v, hairlineWidth: 1 },
    },
    "../lib/colors": { colors: {} },
    "../lib/direction": {
      ltrIsolate: (v: string) => v,
      rowDir: (v: boolean) => ({ flexDirection: v ? "row-reverse" : "row" }),
      textDir: () => ({}),
      trackingSafe: () => ({}),
      useIsRTL: () => rtl,
    },
    "../lib/fonts": { fonts: {} },
    "../lib/i18n": { t: (key: string) => key },
    "../lib/search": {
      normalize,
      scoreMatch: (query: string, value: string) => (normalize(value).includes(query) ? 1 : 0),
    },
    "../lib/tokens": { radius: {}, TOUCH_MIN: 44, typography: {} },
    "../lib/use-friends": { useFriends: () => state },
    "./InitialAvatar": { InitialAvatar: "InitialAvatar" },
  };
  const { HomeFriendsSection } = compileUI("../../components/HomeFriendsSection", mocks);
  const props: any = {
    query: "",
    onSelect: (person: any) => selected.push(person.account_id),
    onScanQr: () => selected.push("qr"),
  };
  const render = () => hooks.render(() => HomeFriendsSection(props));
  const all = () => nodes(hooks.tree);
  const row = (id: string) => all().find((n) => n.props.testID === `home-friend-${id}`)!;
  render();
  assert.ok(row("john"));
  assert.ok(row("jane"));
  assert.ok(flattenStyle(row("john").props.style({ pressed: false })).minHeight >= 64);
  const stale = row("john").props.onPress;
  props.disabled = true;
  render();
  stale();
  assert.deepEqual(selected, [], "Old row callback respects the latest selection state");
  props.disabled = false;
  props.query = "@john";
  render();
  assert.ok(row("john"));
  assert.equal(row("jane"), undefined);
  const basit = { account_id: "basit", name: "باسط", is_friend: true };
  props.query = "basit";
  props.directoryMatches = [basit, basit];
  render();
  assert.equal(
    all().filter((n) => n.props.testID === "home-friend-basit").length,
    1,
    "New server friend and cross-script/phone matches appear once even before cached friends refresh",
  );
  state.rows = [JOHN, JANE];
  state.removedAccountIds = new Set(["basit"]);
  render();
  assert.equal(
    row("basit"),
    undefined,
    "Cached directory badges cannot resurrect a removed friend",
  );
  props.query = "";
  props.directoryMatches = undefined;
  rtl = true;
  render();
  assert.equal(
    flattenStyle(row("john").props.style({ pressed: false })).flexDirection,
    "row-reverse",
  );
  const avatar = nodes(row("john")).find((n) => typeof n.type === "function")!;
  assert.ok(avatar);
  const imageHooks = uiHooks();
  currentHooks = imageHooks;
  let imageTree = imageHooks.render(() => avatar.type(avatar.props));
  let photo = nodes(imageTree).find((n) => n.type === "Image")!;
  assert.equal(photo.props.source.uri, JOHN.picture_url);
  photo.props.onError();
  imageTree = imageHooks.render();
  assert.equal(
    nodes(imageTree).some((n) => n.type === "Image"),
    false,
  );
  assert.equal(
    nodes(imageTree).some((n) => n.type === "InitialAvatar"),
    true,
  );
  currentHooks = hooks;
  state.rows = [];
  props.query = "";
  render();
  assert.ok(
    all().find((n) => n.props.testID === "home-friends-qr"),
    "QR remains available without friends",
  );
  current = false;
  all()
    .find((n) => n.props.testID === "home-friends-qr")!
    .props.onPress();
  assert.deepEqual(selected, []);
  state.accountId = null;
  render();
  assert.equal(hooks.tree, null, "Signed-out users never see cached friends");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
