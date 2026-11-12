// Real profile/QR screens and the retired friends route. All identities and transport are synthetic.
import assert from "node:assert/strict";
import { decodePeopleQr, encodePeopleQr } from "../people-qr";
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

function fixture(state: State = "none", list = false, qrMode?: "scan" | "show") {
  const hooks = uiHooks();
  let activeHooks = hooks;
  let qrChild: { type: any; accountId: string; hooks: ReturnType<typeof uiHooks> } | undefined;
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
  let accountMeGate: Promise<any> | undefined;
  let discoveryEnabled = false;
  let appState = "active";
  const appListeners = new Set<(state: string) => void>();
  const timers = new Set<() => void>();
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
    AppState: {
      get currentState() {
        return appState;
      },
      addEventListener: (_event: string, listener: (state: string) => void) => {
        appListeners.add(listener);
        return { remove: () => appListeners.delete(listener) };
      },
    },
    Linking: { openSettings: async () => {} },
    useWindowDimensions: () => ({ width: 390, height: 844 }),
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
      useState: (initial: any) => activeHooks.react.useState(initial),
      useRef: (initial: any) => activeHooks.react.useRef(initial),
      useMemo: (work: () => any, deps: unknown[]) => activeHooks.react.useMemo(work, deps),
      useCallback: (work: () => any, deps: unknown[]) => activeHooks.react.useCallback(work, deps),
      useEffect: (work: () => void | (() => void), deps?: unknown[]) =>
        activeHooks.react.useEffect(work, deps),
      useLayoutEffect: (work: () => void | (() => void), deps?: unknown[]) =>
        activeHooks.react.useEffect(work, deps),
      useSyncExternalStore: (subscribe: (notify: () => void) => () => void, get: () => string) => {
        activeHooks.react.useEffect(() => subscribe(() => {}), [subscribe]);
        return get();
      },
    },
    "react/jsx-runtime": { jsx, jsxs: jsx, Fragment: "Fragment" },
    "expo-router": {
      Redirect: "Redirect",
      useIsFocused: () => focused,
      useNavigation: () => ({ isFocused: () => focused }),
      useLocalSearchParams: () => ({
        accountId: route,
        name: "UNTRUSTED ROUTE NAME",
        mode: qrMode === "scan" ? "scan" : undefined,
      }),
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
    "expo-camera": {
      CameraView: "Camera",
      useCameraPermissions: () => [
        { granted: true, canAskAgain: true },
        async () => ({ granted: true }),
        async () => ({ granted: true }),
      ],
    },
    "react-native-qrcode-svg": { __esModule: true, default: "QRCode" },
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
      fetchAccountMe: async (session: Session) => {
        check(session);
        calls.push({ action: "accountMe", session });
        return accountMeGate ?? { discoveryEnabled };
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
    "../../lib/tokens": { typography: {}, TOUCH_MIN: 44, radius: {} },
    "../../lib/tabs/errors": { TabApiError },
    "../../lib/people-qr": { encodePeopleQr, decodePeopleQr },
  };
  const Screen = compileUI(
    qrMode
      ? "../../app/people/qr"
      : list
        ? "../../app/people/friends"
        : "../../app/people/[accountId]",
    mocks,
    {
      setInterval: (work: () => void) => {
        timers.add(work);
        return work;
      },
      clearInterval: (work: () => void) => timers.delete(work),
    },
  ).default;
  const render = () => {
    activeHooks = hooks;
    hooks.render(() => Screen());
    if (!qrMode) return;
    const child = nodes(hooks.tree).find(
      (node) =>
        typeof node.type === "function" &&
        ["MyPeopleQr", "PeopleQrScanner"].includes(node.type.name),
    );
    if (qrChild && (qrChild.type !== child?.type || qrChild.accountId !== child?.props.accountId)) {
      qrChild.hooks.unmount();
      qrChild = undefined;
    }
    if (!child) return;
    qrChild ??= { type: child.type, accountId: child.props.accountId, hooks: uiHooks() };
    activeHooks = qrChild.hooks;
    qrChild.hooks.render(() => child.type(child.props));
    activeHooks = hooks;
  };
  const screenNodes = () => nodes([hooks.tree, qrChild?.hooks.tree]);
  const find = (type: string, label?: string) =>
    screenNodes().find((node) => node.type === type && (!label || node.props.label === label));
  const button = (key: string) => find("Button", key)!;
  const text = (key: string) =>
    screenNodes().some(
      (node) =>
        (node.type === "Text" || node.type?.name === "QrMessage") && node.props.children === key,
    );
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
    unmount() {
      qrChild?.hooks.unmount();
      hooks.unmount();
    },
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
    setDiscovery(value: boolean, pending?: Promise<any>) {
      discoveryEnabled = value;
      accountMeGate = pending;
    },
    setAppState(value: string) {
      appState = value;
      appListeners.forEach((notify) => notify(value));
    },
    tick() {
      [...timers].forEach((work) => work());
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

async function qrScreens() {
  {
    const f = fixture("none", false, "show");
    f.identity(null);
    f.render();
    await f.flush();
    assert.ok(f.text("peopleProfile.signIn"));
    assert.equal(f.find("QRCode"), undefined);
    assert.equal(f.find("Camera"), undefined);
    assert.equal(f.calls.length, 0, "signed-out QR does not request account data");
    f.unmount();
  }
  for (const discoverable of [false, true]) {
    const f = fixture("none", false, "show");
    const pending = deferred<any>();
    f.setDiscovery(discoverable, pending.promise);
    f.render();
    await f.flush();
    assert.equal(f.find("QRCode"), undefined, "unknown discoverability never exposes a code");
    pending.resolve({ discoveryEnabled: discoverable });
    await f.flush();
    if (discoverable) {
      assert.equal(f.find("QRCode")!.props.value, encodePeopleQr(me));
      assert.equal(f.find("QRCode")!.props.quietZone, 16);
      assert.ok(f.text("peopleQr.showHint"));
    } else {
      assert.equal(f.find("QRCode"), undefined, "hidden accounts do not display a personal code");
      assert.ok(f.text("peopleQr.hidden"));
    }
    assert.equal(f.calls.filter((call) => call.action === "accountMe").length, 1);
    f.setAppState("background");
    f.render();
    assert.equal(f.find("QRCode"), undefined, "backgrounding removes the personal code");
    f.setDiscovery(false);
    f.setAppState("active");
    f.render();
    assert.equal(f.find("QRCode"), undefined, "returning waits for a fresh privacy check");
    await f.flush();
    assert.ok(f.text("peopleQr.hidden"));
    assert.equal(f.calls.filter((call) => call.action === "accountMe").length, 2);
    f.unmount();
  }
  for (const invalid of ["not a Kaata person code", encodePeopleQr(me)!]) {
    const f = fixture("none", false, "scan");
    f.render();
    const camera = f.find("Camera")!;
    assert.deepEqual(camera.props.barcodeScannerSettings, { barcodeTypes: ["qr"] });
    camera.props.onBarcodeScanned({ data: invalid });
    camera.props.onBarcodeScanned({ data: encodePeopleQr(john) });
    f.render();
    assert.ok(f.text(invalid === encodePeopleQr(me) ? "peopleQr.own" : "peopleQr.invalid"));
    assert.equal(f.find("Camera"), undefined);
    assert.equal(
      f.routes.length,
      0,
      "invalid/self codes remain on the scanner with explicit retry",
    );
    f.button("peopleQr.scanAgain").props.onPress();
    f.render();
    const retry = f.find("Camera")!.props.onBarcodeScanned;
    retry({ data: encodePeopleQr(john) });
    retry({ data: encodePeopleQr(jane) });
    assert.deepEqual(f.routes, [{ pathname: "/people/[accountId]", params: { accountId: john } }]);
    assert.equal(f.calls.length, 0, "scanning only opens a profile; it grants no relationship");
    f.unmount();
  }
  for (const restriction of ["background", "blur", "signedOut"] as const) {
    const f = fixture("none", false, "scan");
    f.render();
    const retained = f.find("Camera")!.props.onBarcodeScanned;
    if (restriction === "background") f.setAppState("background");
    if (restriction === "blur") f.setFocus(false);
    if (restriction === "signedOut") f.identity(null);
    retained({ data: encodePeopleQr(john) });
    f.render();
    assert.equal(f.find("Camera"), undefined, `${restriction} removes the camera`);
    retained({ data: encodePeopleQr(john) });
    assert.equal(f.routes.length, 0, `${restriction} rejects even a retained scan callback`);
    f.unmount();
  }
}

async function main() {
  await qrScreens();
  {
    const f = fixture("outgoing");
    f.render();
    await f.flush();
    f.setState("friends");
    f.tick();
    f.render();
    assert.equal(f.find("Spinner"), undefined, "poll keeps the loaded profile visible");
    await f.flush();
    assert.ok(f.text("peopleProfile.friends"), "remote acceptance updates the open profile");
    const reads = () => f.calls.filter((call) => call.action === "get").length;
    const count = reads();
    f.setState("outgoing");
    f.setAppState("background");
    f.tick();
    await f.flush();
    assert.equal(reads(), count, "background profiles do not poll");
    f.setAppState("active");
    await f.flush();
    assert.ok(f.text("peopleProfile.outgoing"), "resume refreshes without navigation");
    const delayed = deferred<any>();
    f.setGet(delayed.promise);
    f.tick();
    await settleUI();
    const inFlight = reads();
    f.tick();
    f.setAppState("active");
    await settleUI();
    assert.equal(reads(), inFlight, "poll and resume coalesce an in-flight read");
    f.setFocus(false);
    f.render();
    delayed.resolve({ person, friendship: { state: "friends", id: friendshipId } });
    await f.flush();
    assert.equal(
      f.find("PeopleProfileActions"),
      undefined,
      "a late poll cannot repaint a blurred profile",
    );
    f.unmount();
    assert.equal(f.hooks.lateWrites, 0);
  }
  {
    const f = fixture();
    f.render();
    await f.flush();
    const stale = deferred<any>();
    f.setGet(stale.promise);
    f.tick();
    await settleUI();
    f.button("peopleProfile.addFriend").props.onPress();
    await f.flush();
    stale.resolve({ person, friendship: { state: "none" } });
    await f.flush();
    assert.ok(
      f.text("peopleProfile.outgoing"),
      "a pre-action poll cannot overwrite a sent request",
    );
    f.setGet(Promise.reject(new Error("temporary offline")));
    f.tick();
    await f.flush();
    assert.ok(
      f.text("peopleProfile.outgoing"),
      "transient refresh failure retains the current profile",
    );
    f.setGet(Promise.reject(new TabApiError(404)));
    f.tick();
    await f.flush();
    assert.ok(
      f.text("peopleProfile.unavailable"),
      "revoked visibility clears cached profile details",
    );
    assert.equal(f.find("PeopleProfileActions"), undefined);
    f.unmount();
  }
  {
    const f = fixture();
    f.identity(null);
    f.render();
    await f.flush();
    assert.ok(f.text("peopleProfile.signIn"));
    assert.equal(f.calls.length, 0, "the sign-in gate does not fetch a signed-out profile");
    const signIn = f.button("peopleProfile.signInAction");
    signIn.props.onPress();
    assert.deepEqual(f.routes, [{ pathname: "/sign-in", params: { profileAccountId: john } }]);
    f.identity(me);
    signIn.props.onPress();
    await f.flush();
    assert.equal(f.routes.length, 1, "a retained sign-in tap cannot reopen auth after signing in");
    assert.equal(f.calls[0]?.action, "get");
    assert.equal(f.calls[0]?.target, john);
    f.unmount();
  }
  for (const account of [me, null]) {
    const f = fixture("none", true);
    f.identity(account);
    f.render();
    await f.flush();
    assert.equal(
      f.find("Redirect")?.props.href,
      "/",
      "Old Friends links lead to inline friends on Home",
    );
    assert.equal(f.calls.length, 0, "The retired list route starts no account requests");
    assert.equal(
      f.find("ScreenHeader"),
      undefined,
      "The retired route renders no separate friends page",
    );
    f.unmount();
  }

  {
    const f = fixture();
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
    assert.equal(f.routes.at(-1), "/", "a directly opened profile keeps the home fallback");
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
  console.log(
    "people profiles: modal safe-area frames, back navigation, explicit friendship actions, uncertainty reconciliation, independent financial actions, retired friends-route redirect and account/focus/route races passed",
  );
}
void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
