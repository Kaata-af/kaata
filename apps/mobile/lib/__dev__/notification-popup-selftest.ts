// Real NotificationBell with controlled native measurement, motion, animation
// completion and portal/navigation timing. No server or notification is sent.
import assert from "node:assert/strict";
import { compileUI, flattenStyle, jsx, nodes, settleUI, uiHooks } from "./ui-fixture";

function fixture(full = false) {
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
  let inboxCurrent = true;
  const inbox = {
    page: { unread: 1, items: [] as import("../tabs/api").InboxItem[], next_before: null },
    loading: false,
    failed: false,
    signedIn: true,
    isCurrent: () => inboxCurrent,
    reload: async () => {},
    read: async (id: any) => {
      reads.push(id);
    },
  };
  let dueCount = 0;
  let requestScope = true;
  const declined: string[] = [];
  const requests = {
    rows: [] as any[],
    failed: false,
    reload: async () => {},
    decline: async (id: string) => {
      declined.push(id);
      requests.rows = requests.rows.filter((row) => row.id !== id);
    },
    isCurrent: () => requestScope,
  };
  let memberScope = true;
  const memberAccepts: string[] = [];
  const memberRejects: string[] = [];
  const memberRequests = {
    rows: [] as any[],
    failed: false,
    reload: async () => {},
    decline: async (id: string) => {
      memberRejects.push(id);
      memberRequests.rows = memberRequests.rows.filter((row) => row.id !== id);
    },
    isCurrent: () => memberScope,
    isRequestCurrent: (id: string): boolean =>
      memberScope && memberRequests.rows.some((row) => row.id === id),
  };
  let friendScope = true;
  const friendActions: [string, string][] = [];
  const respondToFriend = async (action: string, id: string) => {
    friendActions.push([action, id]);
    friendRequests.rows = friendRequests.rows.filter((row) => row.id !== id);
  };
  const friendRequests = {
    rows: [] as any[],
    failed: false,
    responding: null,
    reload: async () => {},
    accept: (id: string) => respondToFriend("accept", id),
    decline: (id: string) => respondToFriend("decline", id),
    isCurrent: () => friendScope,
    isRequestCurrent: (id: string): boolean =>
      friendScope && friendRequests.rows.some((row) => row.id === id),
  };
  const component = compileUI(
    "../../components/NotificationInbox",
    {
      "../lib/use-people-requests": { usePeopleRequests: () => requests },
      "../lib/use-vault-member-requests": { useVaultMemberRequests: () => memberRequests },
      "../lib/vault-member-invite-intent": {
        prepareVaultMemberInviteAcceptance: async (token: string, current: () => boolean) => {
          if (!current()) return null;
          memberAccepts.push(token);
          return "in-app-consent";
        },
      },
      "../lib/use-friend-requests": { useFriendRequests: () => friendRequests },
      "./ProtectedModal": { ProtectedModal: "Modal" },
      "./Button": { Button: "Button" },
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
      "../lib/direction": {
        ltrIsolate: (text: string) => text,
        useIsRTL: () => false,
        rowDir: () => ({}),
        textDir: () => ({}),
      },
      "../lib/fonts": { fonts: {}, monoLineHeight: (_: number, line: number) => line },
      "../lib/format": { formatRelative: () => "now" },
      "../lib/i18n": { t: (key: string) => key },
      "../lib/tokens": { TOUCH_MIN: 44, typography: {}, icon: { row: 22 }, radius: { lg: 16 } },
      "../lib/tabs/use-inbox": { useInbox: () => inbox },
      "../lib/notification-events": require("../notification-events"),
      "../lib/db-tx": { getSessionAccountIdSync: () => "test-account" },
      "../lib/open-connection-notification": {
        openConnectionNotification: async (item: any, current: () => boolean) => {
          if (current())
            routes.push({
              pathname: "/people/[accountId]",
              params: { accountId: item.actor_account_id },
            });
        },
      },
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
    hooks.render(() => {
      const root = full
        ? component.FullNotificationInbox()
        : component.NotificationBell({ onOpen: () => openingCount++, onVisibilityChange });
      const content = nodes(root).find((node) => typeof node.props.openRequest === "function")!;
      content.props.children = content.type(content.props);
      return root;
    });
    if (full) return;
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
    inbox,
    invalidateInbox: () => {
      inboxCurrent = false;
    },
    requests,
    declined,
    invalidateRequests: () => {
      requestScope = false;
    },
    memberRequests,
    memberAccepts,
    memberRejects,
    invalidateMembers: () => {
      memberScope = false;
    },
    friendRequests,
    friendActions,
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
  const sharedRequest = {
    id: "request",
    token: "r_recipient-bound",
    from: { account_id: "sender", name: "Sender", username: "sender" },
  };
  invitation.requests.rows = [sharedRequest];
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
  const review = nodes(invitation.hooks.tree).find(
    (node) => node.props.accessibilityLabel === "peopleSearch.requestBody",
  )!;
  assert.equal(review.props.accessibilityHint, "peopleSearch.review");
  review.props.onPress();
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
  for (const full of [false, true]) {
    const inbox = fixture(full);
    inbox.requests.rows = [sharedRequest];
    inbox.render();
    if (!full) {
      inbox.open();
      inbox.measure();
    }
    const action = (key: string) =>
      nodes(inbox.hooks.tree).find((node) => node.type === "Button" && node.props.label === key)!;
    const reject = action("tab.reject").props.onPress;
    reject();
    reject();
    await settleUI();
    inbox.render();
    assert.deepEqual(inbox.declined, [sharedRequest.id], "Reject is dispatched once");
    assert.deepEqual(inbox.routes, [], "Reject stays in the inbox");
    assert.equal(action("tab.reject"), undefined, "The rejected invitation disappears");
    inbox.requests.rows = [sharedRequest];
    inbox.render();
    action("tab.accept").props.onPress();
    if (!full) {
      assert.deepEqual(inbox.routes, [], "Accept waits for the popup to dismiss");
      inbox.flushTimers();
    }
    assert.deepEqual(inbox.routes, [
      { pathname: "/t/[token]", params: { token: sharedRequest.token, intent: "accept" } },
    ]);
    inbox.hooks.unmount();
  }
  const stale = fixture();
  stale.requests.rows = [sharedRequest];
  stale.open();
  stale.measure();
  nodes(stale.hooks.tree)
    .find((node) => node.type === "Button" && node.props.label === "tab.accept")!
    .props.onPress();
  stale.invalidateRequests();
  stale.flushTimers();
  assert.deepEqual(stale.routes, [], "Accept cannot open an old account's invitation");
  stale.hooks.unmount();
  const member = { id: "member-invite", token: "v_account-bound", vault_name: "Demo Kaata" };
  const membership = fixture();
  membership.memberRequests.rows = [member];
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
  const cardBody = nodes(membership.hooks.tree).find(
    (node) =>
      node.type === "Pressable" && node.props.accessibilityLabel === "invite.people.requestBody",
  )!;
  assert.ok(!nodes(cardBody).some((node) => node.type === "Button"));
  cardBody.props.onPress();
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
  assert.deepEqual(membership.memberAccepts, [], "opening details alone does not grant consent");
  await settleUI();
  membership.hooks.unmount();
  for (const [full, action] of [
    [false, "accept"],
    [true, "accept"],
    [false, "reject"],
    [true, "reject"],
    [false, "stale"],
  ] as const) {
    const invite = fixture(full);
    invite.memberRequests.rows = [member];
    invite.render();
    if (!full) {
      invite.open();
      invite.measure();
    }
    const label = action === "reject" ? "tab.reject" : "tab.accept";
    const button = nodes(invite.hooks.tree).find(
      (node) => node.type === "Button" && node.props.label === label,
    )!;
    button.props.onPress();
    button.props.onPress();
    assert.deepEqual(invite.routes, [], "accept waits for the scoped handoff");
    if (action === "stale") invite.invalidateMembers();
    invite.flushTimers();
    await settleUI();
    assert.deepEqual(invite.memberAccepts, action === "accept" ? [member.token] : []);
    assert.deepEqual(invite.memberRejects, action === "reject" ? [member.id] : []);
    assert.deepEqual(
      invite.routes,
      action === "accept"
        ? [
            {
              pathname: "/invite/[token]",
              params: { token: member.token, acceptance: "in-app-consent" },
            },
          ]
        : [],
    );
    if (action === "reject") assert.deepEqual(invite.memberRequests.rows, []);
    invite.hooks.unmount();
  }
  const accepted = {
    id: "42",
    tab_id: "",
    role: "" as const,
    rev: 0,
    kind: "friend_accepted",
    entry_id: "",
    actor_account_id: "peer-account",
    body: "Peer accepted your friend request.",
    created_at_ms: 1,
    read: false,
  };
  for (const kind of ["friend_accepted", "vault_invite_accepted"]) {
    accepted.kind = kind;
    for (const [full, current] of [
      [false, true],
      [true, true],
      [false, false],
    ]) {
      const confirmations = fixture(full);
      confirmations.inbox.page.items = [accepted];
      confirmations.render();
      if (!full) {
        confirmations.open();
        confirmations.measure();
      }
      const row = nodes(confirmations.hooks.tree).find((node) => node.props.item === accepted)!;
      assert.ok(row, "friend acceptance is shown in the notification list");
      row.props.onPress();
      if (!current) confirmations.invalidateInbox();
      confirmations.flushTimers();
      await settleUI();
      assert.deepEqual(confirmations.opens, [], "a friend notice never opens a tally");
      assert.deepEqual(
        confirmations.routes,
        current ? [{ pathname: "/people/[accountId]", params: { accountId: "peer-account" } }] : [],
      );
      assert.deepEqual(confirmations.reads, current ? ["42"] : []);
      confirmations.hooks.unmount();
    }
  }
  const rejected = {
    ...accepted,
    id: "43",
    kind: "vault_invite_rejected",
    body: "Peer declined your invitation to Demo Kaata.",
  };
  for (const full of [false, true]) {
    const confirmations = fixture(full);
    confirmations.inbox.page.items = [rejected];
    confirmations.render();
    if (!full) {
      confirmations.open();
      confirmations.measure();
    }
    const row = nodes(confirmations.hooks.tree).find((node) => node.props.item === rejected)!;
    assert.ok(row, "a rejected invitation appears in the inbox");
    row.props.onPress();
    confirmations.flushTimers();
    await settleUI();
    assert.deepEqual(confirmations.reads, ["43"]);
    assert.deepEqual(confirmations.opens, []);
    assert.deepEqual(
      confirmations.routes,
      [{ pathname: "/people/[accountId]", params: { accountId: "peer-account" } }],
      "responses use the connection destination resolver",
    );
    if (!full) {
      confirmations.render();
      assert.equal(confirmations.find("Modal").props.visible, false);
    }
    confirmations.hooks.unmount();
  }
  const friend = { id: "friend-request", from: { account_id: "peer-account", name: "Peer" } };
  for (const full of [false, true]) {
    const friendship = fixture(full);
    const action = (label: string) =>
      nodes(friendship.hooks.tree).find(
        (node) => node.type === "Button" && node.props.label === label,
      );
    for (const [label, response] of [
      ["tab.accept", "accept"],
      ["tab.reject", "decline"],
    ]) {
      friendship.friendRequests.rows = [friend];
      friendship.render();
      if (!full && !friendship.find("Modal").props.visible) {
        friendship.open();
        friendship.measure();
      }
      action(label)!.props.onPress();
      await settleUI();
      friendship.render();
      assert.equal(action(label), undefined, "the resolved request disappears from the inbox");
      assert.deepEqual(friendship.friendActions.at(-1), [response, friend.id]);
      assert.deepEqual(friendship.routes, [], "Accept and Reject never navigate to the profile");
    }
    friendship.hooks.unmount();
  }
  for (const switched of [false, true]) {
    const friendship = fixture();
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
    const card = nodes(friendship.hooks.tree).find(
      (node) => node.type === "Pressable" && node.props.accessibilityHint === "peopleProfile.view",
    )!;
    assert.equal(card.props.accessibilityLabel, "friends.requestBody");
    assert.ok(
      !nodes(card).some((node) => node.type === "Button"),
      "the action buttons are separate tap targets",
    );
    card.props.onPress();
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
