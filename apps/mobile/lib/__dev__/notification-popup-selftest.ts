// Real NotificationBell with controlled native measurement, motion, animation
// completion and portal/navigation timing. No server or notification is sent.
import assert from "node:assert/strict";
import { compileUI, flattenStyle, jsx, nodes, settleUI, uiHooks } from "./ui-fixture";

function fixture() {
  const hooks = uiHooks();
  let openingCount = 0;
  const visibility: boolean[] = [];
  const onVisibilityChange = (visible: boolean) => visibility.push(visible);
  let reducedMotion = true;
  const measures: ((...coords: number[]) => void)[] = [];
  const routes: any[] = [],
    opens: any[] = [],
    reads: any[] = [];
  const timers = new Map<number, () => void>();
  let nextTimer = 0;
  class Value {
    constructor(public value: number) {}
    setValue(value: number) {
      this.value = value;
    }
  }
  const animations: {
    value: Value;
    opts: any;
    callback?: (result: { finished: boolean }) => void;
    stopped: boolean;
  }[] = [];
  const inbox = {
    page: { unread: 1, items: [], next_before: null },
    loading: false,
    failed: false,
    signedIn: true,
    reload: async () => {},
    read: async (id: any) => {
      reads.push(id);
    },
  };
  let dueCount = 0;
  const requests = {
    rows: [] as any[],
    failed: false,
    reload: async () => {},
    decline: async () => {},
  };
  const memberRequests = {
    rows: [] as any[],
    failed: false,
    reload: async () => {},
    decline: async () => {},
  };
  let friendScope = true;
  const friendRequests = {
    rows: [] as any[],
    failed: false,
    reload: async () => {},
    decline: async () => {},
    isCurrent: () => friendScope,
  };
  const component = compileUI(
    "../../components/NotificationInbox",
    {
      "../lib/use-people-requests": { usePeopleRequests: () => requests },
      "../lib/use-vault-member-requests": { useVaultMemberRequests: () => memberRequests },
      "../lib/use-friend-requests": { useFriendRequests: () => friendRequests },
      "./ProtectedModal": { ProtectedModal: "Modal" },
      "./SheetBackdrop": {
        SheetBackdrop: "SheetBackdrop",
        useSheetMotionPreference: () => reducedMotion,
      },
      "react/jsx-runtime": { jsx, jsxs: jsx, Fragment: "Fragment" },
      react: hooks.react,
      "react-native": {
        ActivityIndicator: "Spinner",
        Modal: "Modal",
        Pressable: "Pressable",
        ScrollView: "ScrollView",
        Text: "Text",
        View: "View",
        StyleSheet: { create: (style: any) => style, absoluteFill: {} },
        useWindowDimensions: () => ({ height: 844 }),
        Animated: {
          Value,
          View: "AnimatedView",
          timing: (value: Value, opts: any) => {
            const item = { value, opts, stopped: false } as (typeof animations)[number];
            animations.push(item);
            return {
              start: (callback: any) => {
                item.callback = callback;
              },
              stop: () => {
                item.stopped = true;
                item.callback?.({ finished: false });
              },
            };
          },
        },
      },
      "expo-router": { router: { push: (route: any) => routes.push(route) } },
      "react-native-safe-area-context": {
        useSafeAreaInsets: () => ({ top: 47, bottom: 34, left: 0, right: 0 }),
      },
      "@expo/vector-icons": { Ionicons: "Icon" },
      "../lib/colors": { colors: require("../colors").colors },
      "../lib/direction": { useIsRTL: () => false, rowDir: () => ({}), textDir: () => ({}) },
      "../lib/fonts": { fonts: {}, monoLineHeight: (_: number, line: number) => line },
      "../lib/format": { formatRelative: () => "now" },
      "../lib/i18n": { t: (key: string) => key },
      "../lib/tokens": { TOUCH_MIN: 44, typography: {}, icon: { row: 22 }, radius: { lg: 16 } },
      "../lib/tabs/use-inbox": { useInbox: () => inbox },
      "../lib/tabs/open-notification": {
        openTabNotification: async (...args: any[]) => {
          opens.push(args);
        },
      },
      "../lib/use-customer-reminders": {
        useCustomerReminders: (_vault: any, _person: any, active = true) => {
          const due = active ? Array.from({ length: dueCount }, (_, id) => ({ id })) : [];
          return { due, rows: due };
        },
      },
      "./Toast": { useToast: () => ({ push() {} }) },
    },
    {
      setTimeout: (fn: () => void) => {
        timers.set(++nextTimer, fn);
        return nextTimer;
      },
      clearTimeout: (id: number) => timers.delete(id),
    },
  );
  function render() {
    hooks.render(() =>
      component.NotificationBell({ onOpen: () => openingCount++, onVisibilityChange }),
    );
    const anchor = nodes(hooks.tree).find((node) => node.props.collapsable === false)!;
    anchor.props.ref.current = {
      measureInWindow: (fn: (...coords: number[]) => void) => measures.push(fn),
    };
  }
  render();
  const find = (type: string) => nodes(hooks.tree).find((node) => node.type === type)!;
  const label = (key: string) =>
    nodes(hooks.tree).find((node) => node.props.accessibilityLabel === key)!;
  // The label grows a due-reminders suffix when reminders are due.
  const bell = () =>
    nodes(hooks.tree).find(
      (node) =>
        typeof node.props.accessibilityLabel === "string" &&
        node.props.accessibilityLabel.startsWith("inbox.bell"),
    )!;
  return {
    hooks,
    policy: (reduced: boolean) => {
      reducedMotion = reduced;
      render();
    },
    measures,
    routes,
    timers,
    animations,
    opens,
    reads,
    requests,
    memberRequests,
    friendRequests,
    invalidateFriends: () => {
      friendScope = false;
    },
    render,
    find,
    bell,
    visibility,
    get openingCount() {
      return openingCount;
    },
    due: (count: number, active = true) => {
      dueCount = count;
      return component.DueRemindersShortcut({ active, onPress: () => routes.push("/reminders") });
    },
    top: () =>
      flattenStyle(
        nodes(hooks.tree).find((node) => node.props.accessibilityViewIsModal)!.props.style,
      ).top,
    measure: (y = 100) => {
      measures.shift()!(0, y, 44, 44);
      render();
    },
    open: () => {
      bell().props.onPress();
      render();
    },
    close: () => {
      find("Modal").props.onRequestClose();
      render();
    },
    finish: (item = animations.at(-1)!, force = false) => {
      if (!item.stopped || force) {
        item.value.setValue(item.opts.toValue);
        item.callback?.({ finished: true });
      }
      render();
    },
    flushTimers: () => {
      const pending = [...timers.values()];
      timers.clear();
      pending.forEach((fn) => fn());
      render();
    },
    seeAll: () => {
      nodes(hooks.tree)
        .find(
          (node) =>
            node.type === "Pressable" &&
            nodes(node).some((child) => child.props.children === "inbox.seeAll"),
        )!
        .props.onPress();
      render();
    },
  };
}

async function main() {
  const assertNativeWindow = (popup: ReturnType<typeof fixture>) => {
    const modal = popup.find("Modal").props;
    assert.deepEqual(
      {
        statusBarTranslucent: modal.statusBarTranslucent,
        navigationBarTranslucent: modal.navigationBarTranslucent,
        hardwareAccelerated: modal.hardwareAccelerated,
      },
      {
        statusBarTranslucent: true,
        navigationBarTranslucent: true,
        hardwareAccelerated: true,
      },
      "The transparent dropdown keeps an accelerated edge-to-edge Android window throughout dismissal",
    );
  };
  const normal = fixture();
  normal.policy(false);
  await settleUI();
  normal.open();
  assert.equal(normal.openingCount, 1, "Opening inbox cancels an idle review before native layout");
  normal.measure(120);
  assert.equal(normal.top(), 170);
  assert.equal(normal.find("Modal").props.visible, true);
  assertNativeWindow(normal);
  assert.equal(normal.visibility.at(-1), true, "An open inbox prevents idle rating requests");
  normal.finish();
  normal.close();
  assert.equal(
    normal.top(),
    170,
    "closing keeps measured placement while native portal is visible",
  );
  assert.equal(normal.find("Modal").props.visible, true, "fade completes before portal dismisses");
  assertNativeWindow(normal);
  assert.equal(
    normal.find("AnimatedView").props.pointerEvents,
    "none",
    "closing controls cannot queue another action",
  );
  normal.finish();
  assert.equal(normal.find("Modal").props.visible, false);
  assertNativeWindow(normal);
  assert.equal(normal.visibility.at(-1), false, "The inbox remains busy until its exit finishes");
  assert.equal(normal.top(), 170, "last native dismissal frame cannot jump to safe-area top");
  assert.equal(
    normal.animations.every((item) => item.opts.useNativeDriver),
    true,
  );

  // A stopped animation can still deliver its completion through the bridge.
  normal.open();
  normal.measure();
  normal.close();
  const oldClose = normal.animations.at(-1)!;
  normal.open();
  normal.measure(220);
  normal.finish(oldClose, true);
  assert.equal(
    normal.find("Modal").props.visible,
    true,
    "old close callback cannot dismiss a new opening",
  );
  assert.equal(normal.top(), 270);
  normal.close();
  normal.finish();

  // Out-of-order measurement, close-before-measure and unmount are common
  // during rapid taps/navigation. Only the current open request may paint.
  const pending = fixture();
  pending.open();
  const oldMeasure = pending.measures.shift()!;
  pending.open();
  pending.measure(210);
  oldMeasure(0, 10, 44, 44);
  pending.render();
  assert.equal(pending.top(), 260);
  pending.close();
  pending.open();
  const lateMeasure = pending.measures.shift()!;
  pending.close();
  lateMeasure(0, 300, 44, 44);
  pending.render();
  assert.equal(pending.find("Modal").props.visible, false);
  pending.open();
  const unmountedMeasure = pending.measures.shift()!;
  pending.hooks.unmount();
  unmountedMeasure(0, 300, 44, 44);
  await settleUI();
  assert.equal(pending.hooks.lateWrites, 0);

  const reduced = fixture();
  reduced.policy(true);
  await settleUI();
  reduced.open();
  reduced.measure();
  reduced.close();
  assert.equal(
    reduced.animations.length,
    0,
    "The shared reduced-motion policy keeps popup transitions instant",
  );
  assert.equal(reduced.find("Modal").props.visible, false);
  assert.equal(reduced.top(), 150);
  reduced.policy(false);
  reduced.open();
  reduced.measure();
  reduced.close();
  reduced.policy(true);
  reduced.render();
  assert.equal(
    reduced.find("Modal").props.visible,
    false,
    "enabling reduced motion completes a running close immediately",
  );

  const nav = fixture();
  nav.policy(true);
  await settleUI();
  assert.equal(nav.due(0), null, "due shortcut stays quiet when there are no tasks");
  const dueShortcut = nav.due(2);
  assert.ok(dueShortcut && dueShortcut.props.accessibilityLabel === "reminders.dueShortcut");
  assert.equal(
    nav.due(2, false),
    null,
    "closing/hidden dropdown cannot retain a live private shortcut",
  );
  nav.open();
  nav.measure();
  nav.seeAll();
  nav.seeAll();
  assert.equal(nav.timers.size, 1, "double action queues one navigation");
  assert.deepEqual(nav.routes, []);
  nav.flushTimers();
  assert.deepEqual(nav.routes, ["/notifications"]);
  nav.open();
  nav.measure();
  nav.seeAll();
  nav.open();
  nav.measure();
  nav.flushTimers();
  assert.equal(nav.routes.length, 1, "reopening cancels pending navigation");
  nav.seeAll();
  nav.flushTimers();
  // Due reminders count on the bell (they used to be invisible until the
  // dropdown opened), and the dropdown's row takes the bell's count, so it no
  // longer pops in after opening or vanishes as the fade begins.
  nav.due(2);
  nav.render();
  const badge = nodes(nav.bell()).find(
    (node) => node.type === "Text" && node.props.allowFontScaling === false,
  )!;
  assert.equal(badge.props.children, 3, "1 unread notice + 2 due reminders on the badge");
  assert.ok(nav.bell().props.accessibilityLabel.includes("reminders.dueShortcut"));
  const rowCount = () =>
    nodes(nav.hooks.tree).find((node) => "dueReminders" in node.props)?.props.dueReminders;
  nav.open();
  nav.measure();
  assert.equal(rowCount(), 2, "the open dropdown shows the bell's due count");
  assert.equal(
    nodes(nav.hooks.tree).find((node) => "hasReminders" in node.props)?.props.hasReminders,
    true,
    "any reminder at all makes the row the way into the full list (audit #25)",
  );
  nav.close();
  assert.equal(rowCount(), 2, "the row keeps its count while the panel fades out");
  nav.seeAll();
  nav.hooks.unmount();
  assert.equal(nav.timers.size, 0, "unmount cancels pending navigation");
  assert.equal(nav.hooks.lateWrites, 0);
  const invitation = fixture();
  invitation.requests.rows = [{ id: "request", token: "r_recipient-bound" }];
  invitation.render();
  const invitationBadge = nodes(invitation.bell()).find(
    (node) => node.type === "Text" && node.props.allowFontScaling === false,
  )!;
  assert.equal(
    invitationBadge.props.children,
    2,
    "pending invitations appear on the existing inbox badge",
  );
  invitation.open();
  invitation.measure();
  const invitationContent = nodes(invitation.hooks.tree).find(
    (node) => typeof node.props.openRequest === "function",
  )!;
  invitationContent.props.openRequest(invitation.requests.rows[0]);
  assert.deepEqual(invitation.routes, [], "review waits for the existing inbox to dismiss");
  invitation.flushTimers();
  assert.deepEqual(
    invitation.routes,
    [{ pathname: "/t/[token]", params: { token: "r_recipient-bound" } }],
    "review uses the existing invitation screen without creating a contact or binding a ledger",
  );
  assert.deepEqual(
    invitation.opens,
    [],
    "an unaccepted request is never opened as an authorized tally",
  );
  invitation.hooks.unmount();
  const membership = fixture();
  membership.memberRequests.rows = [{ id: "member-invite", token: "v_account-bound" }];
  membership.render();
  const memberBadge = nodes(membership.bell()).find(
    (node) => node.type === "Text" && node.props.allowFontScaling === false,
  )!;
  assert.equal(
    memberBadge.props.children,
    2,
    "member invitations count on the existing notification badge",
  );
  membership.open();
  membership.measure();
  const memberContent = nodes(membership.hooks.tree).find(
    (node) => typeof node.props.openMemberRequest === "function",
  )!;
  memberContent.props.openMemberRequest(membership.memberRequests.rows[0]);
  assert.deepEqual(membership.routes, [], "member review waits for the popup to close");
  membership.flushTimers();
  assert.deepEqual(
    membership.routes,
    [{ pathname: "/invite/[token]", params: { token: "v_account-bound" } }],
    "member requests reuse the existing access invitation route",
  );
  assert.deepEqual(
    membership.opens,
    [],
    "reviewing a member invitation cannot open a financial tally",
  );
  membership.hooks.unmount();
  for (const switched of [false, true]) {
    const friendship = fixture();
    const friend = { id: "friend-request", from: { account_id: "peer-account", name: "Peer" } };
    friendship.friendRequests.rows = [friend];
    friendship.render();
    const badge = nodes(friendship.bell()).find(
      (node) => node.type === "Text" && node.props.allowFontScaling === false,
    )!;
    assert.equal(
      badge.props.children,
      2,
      "friend requests are counted in the existing inbox badge",
    );
    friendship.open();
    friendship.measure();
    const content = nodes(friendship.hooks.tree).find(
      (node) => typeof node.props.openFriendRequest === "function",
    )!;
    content.props.openFriendRequest(friend);
    assert.deepEqual(friendship.routes, [], "profile waits for the notification popup to dismiss");
    if (switched) friendship.invalidateFriends();
    friendship.flushTimers();
    assert.deepEqual(
      friendship.routes,
      switched ? [] : [{ pathname: "/people/[accountId]", params: { accountId: "peer-account" } }],
      "review navigates only to the profile and only while the original account is current",
    );
    assert.deepEqual(friendship.opens, [], "friend requests never open a tally");
    friendship.hooks.unmount();
  }
  normal.hooks.unmount();
  reduced.hooks.unmount();
  console.log(
    "PASS: notification dropdown keeps accelerated edge-to-edge window flags and placement through dismissal; reduced motion, stale measurements/completions, rapid reopening, navigation and unmount guards",
  );
}
void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
