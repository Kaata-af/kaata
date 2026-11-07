// Real profile/list screens at the hook boundary. All identities and transport are synthetic.
import assert from "node:assert/strict";
import { compileUI, deferred, flattenStyle, jsx, nodes, settleUI, uiHooks } from "./ui-fixture";

const me = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const john = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const jane = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const friendshipId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const person = { account_id: john, name: "John Smith", username: "john" };
class SessionChangedError extends Error {}
class TabApiError extends Error {
  constructor(
    public status: number,
    public code?: string,
  ) {
    super("fixture failure");
  }
}
type State = "none" | "incoming" | "outgoing" | "friends";
type Session = { accountId: string | null; jwt: string; bindingVersion: number };

function fixture(state: State = "none", list = false) {
  const hooks = uiHooks();
  let account: string | null = me,
    route = john,
    binding = 1,
    focused = true,
    offline = false,
    canGoBack = true,
    platform = "ios";
  let insets = { top: 59, bottom: 34, left: 0, right: 0 };
  let nextState = state;
  let getGate: Promise<any> | undefined;
  let mutationGate: Promise<any> | undefined;
  let dispatchGate: Promise<void> | undefined;
  let listGate: Promise<any> | undefined;
  const calls: Array<{ action: string; target?: string; session: Session }> = [];
  const routes: any[] = [];
  const listeners = new Set<() => void>();
  const snapshot = (): Session => ({
    accountId: account,
    jwt: `jwt-${binding}`,
    bindingVersion: binding,
  });
  const check = (session: Session) => {
    if (session.accountId !== account || session.bindingVersion !== binding)
      throw new SessionChangedError();
  };
  const friendship = () =>
    nextState === "none" ? { state: nextState } : { state: nextState, id: friendshipId };
  const action =
    (name: string) => async (target: string, session: Session, beforeDispatch: () => void) => {
      await dispatchGate;
      beforeDispatch();
      check(session);
      calls.push({ action: name, target, session });
      if (mutationGate) return mutationGate;
      if (name === "send") nextState = "outgoing";
      else if (name === "accept") nextState = "friends";
      else nextState = "none";
      return friendship();
    };
  const native = {
    ActivityIndicator: "Spinner",
    Image: "Image",
    ScrollView: "ScrollView",
    Text: "Text",
    View: "View",
    Pressable: "Pressable",
    Platform: {
      get OS() {
        return platform;
      },
    },
    StyleSheet: { create: (value: unknown) => value, hairlineWidth: 1 },
  };
  const safeArea = {
    SafeAreaView: "SafeAreaView",
    useSafeAreaInsets: () => insets,
  };
  const PeopleScreen = compileUI("../../components/PeopleScreen", {
    "react/jsx-runtime": { jsx, jsxs: jsx },
    "react-native": native,
    "react-native-safe-area-context": safeArea,
    "../lib/colors": { colors: { bgDefault: "#fff" } },
  }).PeopleScreen;
  const mocks = {
    react: {
      ...hooks.react,
      useSyncExternalStore: (subscribe: (notify: () => void) => () => void, get: () => string) => {
        hooks.react.useEffect(() => subscribe(() => {}), [subscribe]);
        return get();
      },
    },
    "react/jsx-runtime": { jsx, jsxs: jsx, Fragment: "Fragment" },
    "expo-router": {
      useIsFocused: () => focused,
      useLocalSearchParams: () => ({ accountId: route, name: "UNTRUSTED ROUTE NAME" }),
      useRouter: () => ({
        push: (value: any) => routes.push(value),
        replace: (value: any) => routes.push(value),
        dismissTo: (value: any) => routes.push(value),
        canGoBack: () => canGoBack,
        back: () => routes.push("back"),
      }),
    },
    "expo-network": {
      useNetworkState: () => ({ isConnected: !offline, isInternetReachable: !offline }),
    },
    "react-native": native,
    "react-native-safe-area-context": safeArea,
    "../../components/Button": { Button: "Button" },
    "../../components/ConfirmDialog": { ConfirmDialog: "ConfirmDialog" },
    "../../components/InitialAvatar": { InitialAvatar: "Avatar" },
    "../../components/PeopleProfileActions": { PeopleProfileActions: "PeopleProfileActions" },
    "../../components/PeopleScreen": { PeopleScreen },
    "../../components/SettingsScreen": {
      ScreenHeader: "ScreenHeader",
      NavRow: "NavRow",
      SectionGap: "SectionGap",
    },
    "../../lib/auth": {
      SessionChangedError,
      captureCurrentSession: async () => {
        if (!account) throw new SessionChangedError();
        return snapshot();
      },
      applyForCurrentSession: async (session: Session, work: () => Promise<any>) => {
        check(session);
        return work();
      },
    },
    "../../lib/db-tx": {
      getSessionAccountIdSync: () => account,
      onAccountIdentityChanged: (notify: () => void) => {
        listeners.add(notify);
        return () => listeners.delete(notify);
      },
    },
    "../../lib/friends-api": {
      getPersonProfile: async (
        id: string,
        session: Session,
        vault: string | undefined,
        guard: () => void,
      ) => {
        guard();
        check(session);
        assert.equal(vault, undefined, "friendship is independent of financial books");
        calls.push({ action: "get", target: id, session });
        return getGate ?? { person: { ...person, account_id: id }, friendship: friendship() };
      },
      sendFriendRequest: action("send"),
      acceptFriendRequest: action("accept"),
      dismissFriendRequest: action("dismiss"),
      removeFriend: action("remove"),
      listFriends: async (after: string | undefined, session: Session) => {
        check(session);
        calls.push({ action: "list", target: after, session });
        return listGate ?? { friends: [person], next_cursor: friendshipId };
      },
    },
    "../../lib/colors": { colors: {} },
    "../../lib/design-tokens": { SETTINGS_ROW_PADDING_X: 20 },
    "../../lib/direction": {
      useIsRTL: () => false,
      textDir: () => ({}),
      rowDir: () => ({}),
      ltrIsolate: (value: string) => value,
    },
    "../../lib/i18n": { t: (key: string) => key },
    "../../lib/tokens": { typography: {}, TOUCH_MIN: 44 },
    "../../lib/tabs/errors": { TabApiError },
  };
  const Screen = compileUI(
    list ? "../../app/people/friends" : "../../app/people/[accountId]",
    mocks,
  ).default;
  const render = () => hooks.render(() => Screen());
  const find = (type: string, label?: string) =>
    nodes(hooks.tree).find((node) => node.type === type && (!label || node.props.label === label));
  const button = (key: string) => find("Button", key)!;
  const text = (key: string) =>
    nodes(hooks.tree).some((node) => node.type === "Text" && node.props.children === key);
  const flush = async () => {
    await settleUI();
    render();
    await settleUI();
    render();
  };
  return {
    hooks,
    calls,
    routes,
    render,
    flush,
    find,
    button,
    text,
    frame() {
      assert.equal(hooks.tree.type, PeopleScreen, "the route root owns its safe-area frame");
      return PeopleScreen(hooks.tree.props);
    },
    setPlatform(value: string) {
      platform = value;
    },
    setInsets(value: typeof insets) {
      insets = value;
    },
    setCanGoBack(value: boolean) {
      canGoBack = value;
    },
    setState(value: State) {
      nextState = value;
    },
    setGet(promise?: Promise<any>) {
      getGate = promise;
    },
    setMutation(promise?: Promise<any>) {
      mutationGate = promise;
    },
    setDispatch(promise?: Promise<void>) {
      dispatchGate = promise;
    },
    setList(promise?: Promise<any>) {
      listGate = promise;
    },
    setRoute(value: string) {
      route = value;
    },
    setFocus(value: boolean) {
      focused = value;
    },
    setOffline(value: boolean) {
      offline = value;
    },
    identity(value: string | null) {
      account = value;
      binding++;
      listeners.forEach((notify) => notify());
    },
  };
}

async function main() {
  for (const list of [false, true]) {
    const f = fixture("none", list);
    f.render();
    await f.flush();
    let frame = f.frame();
    assert.equal(frame.type, "View", "iOS uses context insets across native modal boundaries");
    assert.deepEqual(flattenStyle(frame.props.style), {
      flex: 1,
      backgroundColor: "#fff",
      paddingTop: 59,
      paddingBottom: 34,
      paddingLeft: 0,
      paddingRight: 0,
    });
    const header = f.find("ScreenHeader")!;
    assert.equal(frame.props.children[0], header, "the back header is inside the safe-area frame");
    assert.equal(
      nodes(frame).filter((node) => node.type === "SafeAreaView").length,
      0,
      "iOS does not apply the same inset twice through a nested native safe-area view",
    );
    f.setInsets({ top: 0, bottom: 21, left: 59, right: 59 });
    frame = f.frame();
    assert.deepEqual(
      flattenStyle(frame.props.style),
      {
        flex: 1,
        backgroundColor: "#fff",
        paddingTop: 0,
        paddingBottom: 21,
        paddingLeft: 59,
        paddingRight: 59,
      },
      "updated context insets protect landscape edges without retaining portrait padding",
    );
    f.setPlatform("android");
    frame = f.frame();
    assert.equal(
      frame.type,
      "SafeAreaView",
      "Android keeps the existing native safe-area behavior",
    );
    assert.deepEqual(frame.props.edges, ["top", "bottom"]);
    assert.deepEqual(flattenStyle(frame.props.style), { flex: 1, backgroundColor: "#fff" });
    assert.equal(frame.props.children[0], header);
    header.props.onBack();
    assert.equal(f.routes.at(-1), "back");
    f.setCanGoBack(false);
    header.props.onBack();
    assert.equal(f.routes.at(-1), "/", "a directly opened profile/list keeps the home fallback");
    f.hooks.unmount();
  }
  {
    const f = fixture();
    const get = deferred<any>();
    f.setGet(get.promise);
    f.render();
    assert.ok(f.text("peopleProfile.loading"));
    assert.equal(
      f.find("PeopleProfileActions"),
      undefined,
      "actions wait for authoritative profile",
    );
    get.resolve({ person, friendship: { state: "none" } });
    await f.flush();
    assert.ok(f.text(person.name));
    assert.equal(f.text("UNTRUSTED ROUTE NAME"), false);
    assert.ok(f.find("PeopleProfileActions"), "financial actions remain separate from friendship");
    const change = deferred<any>();
    f.setMutation(change.promise);
    const send = f.button("peopleProfile.addFriend").props.onPress;
    send();
    send();
    await f.flush();
    assert.equal(
      f.calls.filter((c) => c.action === "send").length,
      1,
      "same-frame double presses send once",
    );
    change.resolve({ state: "outgoing", id: friendshipId });
    await f.flush();
    assert.ok(f.text("peopleProfile.outgoing"));
    assert.ok(f.button("peopleProfile.cancel"));
    f.hooks.unmount();
  }
  for (const action of ["accept", "decline"] as const) {
    const f = fixture("incoming");
    f.render();
    await f.flush();
    assert.ok(f.text("peopleProfile.incoming"));
    f.button(`peopleProfile.${action}`).props.onPress();
    await f.flush();
    assert.equal(
      f.calls.filter((c) => c.action === (action === "accept" ? "accept" : "dismiss")).length,
      1,
    );
    assert.ok(
      action === "accept" ? f.text("peopleProfile.friends") : f.button("peopleProfile.addFriend"),
    );
    if (action === "decline")
      assert.equal(
        f.calls.filter((c) => c.action === "get").length,
        2,
        "dismiss rechecks profile visibility",
      );
    f.hooks.unmount();
  }
  {
    const f = fixture("friends");
    f.render();
    await f.flush();
    f.button("peopleProfile.remove").props.onPress();
    f.render();
    assert.equal(f.find("ConfirmDialog")!.props.visible, true);
    assert.equal(
      f.calls.filter((c) => c.action === "remove").length,
      0,
      "removing a friend requires confirmation",
    );
    const hidden = deferred<any>();
    f.setGet(hidden.promise);
    f.find("ConfirmDialog")!.props.onConfirm();
    await f.flush();
    hidden.reject(new TabApiError(404));
    await f.flush();
    assert.ok(
      f.text("peopleProfile.unavailable"),
      "removing the last relationship can revoke profile access",
    );
    assert.equal(f.find("PeopleProfileActions"), undefined);
    f.hooks.unmount();
  }
  {
    const f = fixture();
    f.render();
    await f.flush();
    const change = deferred<any>();
    f.setMutation(change.promise);
    f.button("peopleProfile.addFriend").props.onPress();
    await f.flush();
    change.reject(new Error("reply lost"));
    await f.flush();
    assert.ok(f.text("peopleProfile.actionFailed"));
    f.button("peopleProfile.addFriend").props.onPress();
    await f.flush();
    assert.equal(
      f.calls.filter((c) => c.action === "send").length,
      1,
      "an uncertain write cannot be blindly retried",
    );
    f.setState("outgoing");
    f.button("peopleProfile.refresh").props.onPress();
    await f.flush();
    assert.ok(
      f.text("peopleProfile.outgoing"),
      "refresh reconciles the server state without another mutation",
    );
    f.hooks.unmount();
  }
  {
    const f = fixture();
    f.render();
    await f.flush();
    const held = f.button("peopleProfile.addFriend").props.onPress;
    f.identity(null);
    f.identity(me);
    held();
    await f.flush();
    assert.equal(
      f.calls.filter((c) => c.action === "send").length,
      0,
      "A -> signed out -> A invalidates old callbacks before paint",
    );
    f.hooks.unmount();
  }
  for (const [code, message] of [
    ["friend_request_cooldown", "peopleProfile.cooldown"],
    ["friend_request_limit", "peopleProfile.requestLimit"],
  ]) {
    const f = fixture();
    f.render();
    await f.flush();
    const rejected = deferred<any>();
    f.setMutation(rejected.promise);
    f.button("peopleProfile.addFriend").props.onPress();
    await f.flush();
    rejected.reject(new TabApiError(429, code));
    await f.flush();
    assert.ok(f.text(message), "definitive request limits explain the actual reason");
    assert.equal(f.text("peopleProfile.actionFailed"), false);
    assert.equal(
      f.find("Button", "peopleProfile.refresh"),
      undefined,
      "a definite rejection does not require ambiguous-mutation reconciliation",
    );
    assert.equal(f.button("peopleProfile.addFriend").props.disabled, false);
    f.setRoute(jane);
    f.render();
    await f.flush();
    assert.equal(f.text(message), false, "rate limit notices do not follow another profile");
    f.hooks.unmount();
  }
  for (const invalidation of ["route", "focus", "identity", "unmount"] as const) {
    const f = fixture();
    f.render();
    await f.flush();
    const dispatch = deferred<void>();
    f.setDispatch(dispatch.promise);
    f.button("peopleProfile.addFriend").props.onPress();
    await settleUI();
    if (invalidation === "route") {
      f.setRoute(jane);
      f.render();
    }
    if (invalidation === "focus") {
      f.setFocus(false);
      f.render();
    }
    if (invalidation === "identity") f.identity(jane);
    if (invalidation === "unmount") f.hooks.unmount();
    dispatch.resolve();
    await settleUI();
    assert.equal(
      f.calls.filter((c) => c.action === "send").length,
      0,
      `${invalidation}: stale transport setup cannot dispatch a friend request`,
    );
    if (invalidation !== "unmount") f.hooks.unmount();
    assert.equal(f.hooks.lateWrites, 0);
  }
  {
    const f = fixture();
    f.render();
    await f.flush();
    const sent = deferred<any>();
    f.setMutation(sent.promise);
    f.button("peopleProfile.addFriend").props.onPress();
    await f.flush();
    assert.equal(f.calls.filter((call) => call.action === "send").length, 1);
    f.setRoute(jane);
    f.render();
    sent.resolve({ state: "outgoing", id: friendshipId });
    await f.flush();
    assert.ok(
      f.button("peopleProfile.addFriend"),
      "a late sent reply cannot change another person's friendship",
    );
    assert.equal(f.text("peopleProfile.outgoing"), false);
    assert.equal(f.find("PeopleProfileActions")!.props.person.account_id, jane);
    f.hooks.unmount();
  }
  {
    const f = fixture();
    const expired = deferred<any>();
    f.setGet(expired.promise);
    f.render();
    await settleUI();
    expired.reject(new SessionChangedError());
    await f.flush();
    assert.ok(f.text("peopleProfile.failed"));
    assert.equal(f.calls.length, 1, "an expired session does not cause an automatic reload loop");
    f.setGet(undefined);
    f.button("peopleProfile.retry").props.onPress();
    await f.flush();
    assert.ok(f.button("peopleProfile.addFriend"));
    f.hooks.unmount();
  }
  {
    const f = fixture();
    const old = deferred<any>();
    f.setGet(old.promise);
    f.render();
    await settleUI();
    f.identity(jane);
    f.setGet(undefined);
    f.render();
    assert.equal(
      f.text(person.name),
      false,
      "account switch hides the old profile before replacement read",
    );
    old.resolve({
      person: { ...person, name: "OLD PRIVATE NAME" },
      friendship: { state: "friends", id: friendshipId },
    });
    await f.flush();
    assert.equal(f.text("OLD PRIVATE NAME"), false);
    f.hooks.unmount();
  }
  for (const restriction of ["signedOut", "offline", "invalidRoute", "own"] as const) {
    const f = fixture();
    if (restriction === "signedOut") f.identity(null);
    if (restriction === "offline") f.setOffline(true);
    if (restriction === "invalidRoute") f.setRoute("bad-id");
    if (restriction === "own") f.setRoute(me);
    f.render();
    await f.flush();
    assert.equal(f.find("Button", "peopleProfile.addFriend"), undefined);
    assert.equal(f.find("PeopleProfileActions"), undefined);
    assert.equal(f.calls.length, restriction === "own" ? 1 : 0);
    f.hooks.unmount();
  }
  {
    const f = fixture("none", true);
    f.render();
    await f.flush();
    const row = f.find("Pressable")!;
    row.props.onPress();
    assert.deepEqual(f.routes.at(-1), {
      pathname: "/people/[accountId]",
      params: { accountId: john },
    });
    const more = deferred<any>();
    f.setList(more.promise);
    const press = f.button("friends.more").props.onPress;
    press();
    press();
    await settleUI();
    assert.equal(f.calls.filter((c) => c.action === "list").length, 2);
    more.resolve({ friends: [person, { ...person, account_id: jane, name: "Jane" }] });
    await f.flush();
    assert.equal(
      nodes(f.hooks.tree).filter((node) => node.type === "Pressable").length,
      2,
      "pagination deduplicates existing friends",
    );
    f.identity(null);
    row.props.onPress();
    f.render();
    assert.equal(f.routes.length, 1, "retained friend rows cannot navigate after sign-out");
    assert.equal(f.find("Pressable"), undefined);
    assert.ok(f.text("peopleProfile.signIn"));
    f.hooks.unmount();
  }
  {
    const f = fixture("none", true);
    f.render();
    await f.flush();
    const more = deferred<any>();
    f.setList(more.promise);
    f.button("friends.more").props.onPress();
    await settleUI();
    f.identity(jane);
    f.setList(Promise.resolve({ friends: [] }));
    f.render();
    assert.equal(f.find("Pressable"), undefined, "list hides previous-account rows immediately");
    more.resolve({ friends: [person] });
    await f.flush();
    assert.ok(f.text("friends.empty"));
    assert.equal(f.find("Pressable"), undefined);
    f.hooks.unmount();
    assert.equal(f.hooks.lateWrites, 0);
  }
  console.log(
    "people profiles: modal safe-area frames, back navigation, explicit friendship actions, uncertainty reconciliation, independent financial actions, list pagination and account/focus/route races passed",
  );
}
void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
