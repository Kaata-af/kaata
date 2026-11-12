import assert from "node:assert/strict";
import { compileUI, deferred } from "./ui-fixture";
import * as events from "../notification-events";
import { defaultNotificationPolicy } from "../notification-policy";

const ACCOUNT = "00000000-0000-4000-8000-000000000001";
const settleUI = () => new Promise<void>((resolve) => setImmediate(resolve));
const PEER = "00000000-0000-4000-8000-000000000002";
const REQUEST = "00000000-0000-4000-8000-000000000003";
const VAULT = "00000000-0000-4000-8000-000000000004";
let account: string | null = ACCOUNT,
  epoch = 1,
  now = 1000;
const meta = new Map<string, string>();
const current = () => account === ACCOUNT;
const session = () => ({
  accountId: account,
  bindingVersion: epoch,
  jwt: account ? "synthetic" : null,
});
const auth = {
  captureCurrentSession: async () => session(),
  applyForCurrentSession: async (snapshot: any, work: () => Promise<any>) => {
    if (!snapshot.jwt || snapshot.accountId !== account || snapshot.bindingVersion !== epoch)
      throw new Error("session changed");
    return work();
  },
};
const storage = {
  getAppMeta: async (key: string) => meta.get(key) ?? null,
  setAppMeta: async (key: string, value: string) => {
    meta.set(key, value);
  },
};
const delivery = compileUI("../notification-delivery", {
  "./db": storage,
  "./db-tx": { getSessionAccountIdSync: () => account },
}) as typeof import("../notification-delivery");

async function main() {
  const request = { kind: "friend_requested", source_id: REQUEST, notification_id: "1" };
  assert.equal(
    events.notificationEventKey(`account:${ACCOUNT}`, request),
    events.notificationEventKey(`account:${ACCOUNT}`, {
      ...request,
      id: "1",
      notification_id: undefined,
    }),
  );
  const key = events.notificationEventKey(`account:${ACCOUNT}`, request)!;
  assert.deepEqual(
    await Promise.all([
      delivery.claimNotificationDelivery(ACCOUNT, key, current),
      delivery.claimNotificationDelivery(ACCOUNT, key, current),
    ]),
    [true, false],
  );
  const restartedDelivery = compileUI("../notification-delivery", {
    "./db": storage,
    "./db-tx": { getSessionAccountIdSync: () => account },
  });
  assert.equal(
    await restartedDelivery.claimNotificationDelivery(ACCOUNT, key, current),
    false,
    "dedupe survives JS restart",
  );
  assert.equal(
    await delivery.claimNotificationDelivery(PEER, key, () => true),
    false,
    "wrong account cannot claim receipt",
  );
  assert.notEqual(
    events.notificationEventKey(ACCOUNT, {
      kind: "vault_member_role_changed",
      source_id: REQUEST,
      id: "2",
    }),
    events.notificationEventKey(ACCOUNT, {
      kind: "vault_member_role_changed",
      source_id: REQUEST,
      id: "3",
    }),
    "each role change has its own event",
  );
  const pending = {
    friends: Array.from({ length: 55 }, (_, i) => ({ id: String(i) })),
    members: [],
    shared: [],
  };
  assert.equal(
    events.notificationBadgeCount({ unread: 60, request_unread: 55, items: [] }, pending),
    60,
    "pagination cannot double-count 55 pending requests",
  );
  assert.equal(
    events.notificationBadgeCount(
      { unread: 60, request_unread: 55, items: [] },
      { friends: [], members: [], shared: [] },
    ),
    60,
    "before request cards load, unread badge remains visible",
  );
  assert.equal(
    events.noticeHasRequestCard({ kind: "friend_requested", source_id: "0" }, pending),
    true,
  );
  console.log(
    "PASS: canonical event identities, race/restart dedupe, account scope and paginated badges",
  );

  const registrations: any[] = [];
  let registrationGate: Promise<void> | null = null;
  const registration = compileUI(
    "../account-notifications",
    {
      "./api": { getBackendUrl: async () => "https://example.test" },
      "./auth": auth,
      "./db-tx": { getInstallIdSync: () => VAULT },
      "./tabs/errors": require("../tabs/errors"),
    },
    {
      fetch: async (url: string, options: any) => {
        registrations.push({ url, ...options });
        await registrationGate;
        return { ok: true, json: async () => ({ enabled: true }) };
      },
    },
  ) as typeof import("../account-notifications");
  await registration.registerAccountNotifications(
    session(),
    "synthetic-token",
    "ps",
    defaultNotificationPolicy(),
  );
  assert.equal(registrations[0].url, "https://example.test/v1/notifications/registration");
  const body = JSON.parse(registrations[0].body);
  assert.equal(body.install_id, VAULT);
  assert.equal(
    body.preferences.credit_alerts,
    undefined,
    "wire shape matches server's strict connection policy decoder",
  );
  assert.equal(body.preferences.connections, true);
  const registerWait = deferred<void>();
  registrationGate = registerWait.promise;
  const staleRegistration = registration.registerAccountNotifications(
    session(),
    "synthetic-token",
    "en",
  );
  await settleUI();
  account = PEER;
  epoch++;
  registerWait.resolve();
  await assert.rejects(staleRegistration, /session changed/);
  account = ACCOUNT;
  epoch++;
  console.log("PASS: account registration wire contract and stale-session acknowledgement guard");

  const appListeners = new Set<(state: string) => void>();
  const identities = new Set<() => void>();
  const timers = new Map<number, () => void>();
  const intervals = new Map<number, () => void>();
  let timerId = 0,
    fetches = 0,
    page: any = { items: [], latest_id: "0", unread: 0, next_before: "" };
  let fetchGate: Promise<any> | null = null;
  let policy = defaultNotificationPolicy();
  let revoked = false,
    closed = false;
  const cues: string[] = [];
  const state = {
    currentState: "active",
    addEventListener: (_: string, listener: (state: string) => void) => {
      appListeners.add(listener);
      return { remove: () => appListeners.delete(listener) };
    },
  };
  const observer = compileUI(
    "../notification-observer",
    {
      "react-native": { AppState: state },
      "./auth": auth,
      "./db": storage,
      "./db-tx": {
        getSessionAccountIdSync: () => account,
        onAccountIdentityChanged: (fn: () => void) => {
          identities.add(fn);
          return () => identities.delete(fn);
        },
      },
      "./i18n": { getLocale: () => "en", subscribeLocale: () => () => {} },
      "./foreground-notification-cue": {
        playForegroundNotificationCue: (_: unknown, guard: () => boolean, key: string) => {
          if (guard()) cues.push(key);
        },
      },
      "./notification-delivery": delivery,
      "./notification-events": events,
      "./notification-policy": require("../notification-policy"),
      "./notification-preferences": {
        notificationOwnerScope: () => `account:${account}`,
        notificationPreferencesRevision: () => 0,
        notificationPolicyForContact: async () => policy,
        notificationPolicyForTab: async () => policy,
      },
      "./tabs/api": {
        fetchInbox: async () => {
          fetches++;
          return fetchGate ? await fetchGate : page;
        },
      },
      "./tabs/db": {
        listTabLinksForId: async () => [
          { role: "b", vault_id: VAULT, closed_at: closed ? 1 : null },
        ],
      },
      "./tabs/binding-access": { isTabVaultRevoked: async () => revoked },
      "./tabs/events": { onTabApplied: () => () => {} },
      "./tabs/inbox-reads": {
        announceServerReads: () => {},
        pendingInboxReadSpecs: async () => [],
        inboxItemMatches: () => false,
      },
      "./tabs/notify": { syncTabPushSubscriptions: async () => {} },
    },
    {
      Date: { now: () => now },
      setTimeout: (fn: () => void) => {
        const id = ++timerId;
        timers.set(id, fn);
        return id;
      },
      clearTimeout: (id: number) => timers.delete(id),
      setInterval: (fn: () => void) => {
        const id = ++timerId;
        intervals.set(id, fn);
        return id;
      },
      clearInterval: (id: number) => intervals.delete(id),
    },
  ) as typeof import("../notification-observer");
  const flush = async () => {
    const work = [...timers.values()];
    timers.clear();
    work.forEach((fn) => fn());
    await settleUI();
  };
  const stop = observer.startNotificationObserver();
  await flush();
  assert.equal(fetches, 1, "global observer starts without a Home/inbox mount");
  const notice = (id: number, kind = "friend_accepted", time = now) => ({
    id: String(id),
    kind,
    source_id: REQUEST,
    actor_account_id: PEER,
    recipient_account_id: ACCOUNT,
    tab_id: "",
    role: "" as const,
    entry_id: "",
    rev: 0,
    body: "Update",
    created_at_ms: time,
    read: false,
  });
  now = 8_000_000_000_000; // Phone clock is years ahead of the server.
  page = {
    items: [notice(2, "friend_accepted", 1100)],
    latest_id: "2",
    unread: 1,
    next_before: "",
  };
  for (const fn of intervals.values()) fn();
  await settleUI();
  assert.equal(
    cues.length,
    1,
    "new event sounds on any page despite a wildly incorrect phone clock",
  );
  events.notifyNotificationInboxChanged(ACCOUNT, "push");
  await flush();
  assert.equal(cues.length, 1, "push arriving after poll does not repeat the cue");
  page = { items: [notice(3, "friend_rejected")], latest_id: "3", unread: 1, next_before: "" };
  await delivery.claimNotificationDelivery(
    ACCOUNT,
    events.notificationEventKey(`account:${ACCOUNT}`, page.items[0])!,
    current,
  );
  events.notifyNotificationInboxChanged(ACCOUNT, "push");
  await flush();
  assert.equal(cues.length, 1, "poll after native presentation does not repeat the cue");
  policy = { ...policy, connections: false };
  await observer.cueInboxNotification(notice(4), ACCOUNT, current);
  assert.equal(cues.length, 1, "muted category respects user choice");
  policy = defaultNotificationPolicy();
  closed = true;
  await observer.cueInboxNotification(
    { ...notice(5, "entry_created"), tab_id: REQUEST, role: "b", rev: 5 } as any,
    ACCOUNT,
    current,
  );
  assert.equal(cues.length, 1, "closed relationship new-work noise stays suppressed");
  await observer.cueInboxNotification(
    { ...notice(6, "unlinked"), tab_id: REQUEST, role: "b", rev: 6 } as any,
    ACCOUNT,
    current,
  );
  assert.equal(cues.length, 2, "unlink outcome still sounds");
  revoked = true;
  await observer.cueInboxNotification(
    { ...notice(7, "settled"), tab_id: REQUEST, role: "b", rev: 7 } as any,
    ACCOUNT,
    current,
  );
  assert.equal(cues.length, 2, "revoked perspective cannot deliver financial detail");
  revoked = false;
  state.currentState = "background";
  appListeners.forEach((fn) => fn("background"));
  const before = fetches;
  intervals.forEach((fn) => fn());
  await settleUI();
  assert.equal(fetches, before);
  now = 2000;
  page = { items: [notice(8, "friend_removed", 1800)], latest_id: "8", unread: 1, next_before: "" };
  state.currentState = "active";
  appListeners.forEach((fn) => fn("active"));
  await flush();
  assert.equal(cues.length, 2, "resume does not replay background OS alerts");
  const wait = deferred<any>();
  fetchGate = wait.promise;
  intervals.forEach((fn) => fn());
  await settleUI();
  account = PEER;
  epoch++;
  identities.forEach((fn) => fn());
  wait.resolve({ items: [notice(9)], latest_id: "9", unread: 1, next_before: "" });
  await settleUI();
  assert.equal(cues.length, 2, "late old-session fetch cannot cue on another account");
  stop();
  console.log(
    "PASS: global polling, push/poll races, muted/closed/revoked views, resume and account change",
  );

  account = ACCOUNT;
  epoch++;
  const routes: any[] = [],
    reads: any[] = [],
    switches: string[] = [];
  let liveShared: any[] = [],
    liveMembers: any[] = [],
    liveVaults: any[] = [],
    profileWait: Promise<void> | null = null,
    localVault = true;
  let unlocked = true;
  const routing = compileUI("../open-connection-notification", {
    "expo-router": { router: { push: (route: any) => routes.push(route) } },
    "./auth": auth,
    "./db-tx": {
      getSessionAccountIdSync: () => account,
      getDb: async () => ({ getFirstAsync: async () => (localVault ? { id: VAULT } : null) }),
      setActiveVaultId: async (id: string) => {
        switches.push(id);
      },
    },
    "./friends-api": {
      getPersonProfile: async () => {
        await profileWait;
        return { person: { account_id: PEER } };
      },
    },
    "./people-connections": { listPeopleRequests: async () => liveShared },
    "./vault-member-requests": { listVaultMemberRequests: async () => liveMembers },
    "./vault-api": { listVaults: async () => liveVaults },
    "./currency": { applyVaultCurrency: async () => {} },
    "./notification-events": events,
    "./tabs/inbox-reads": {
      markInboxHandled: async (spec: any) => {
        reads.push(spec);
      },
    },
    "./sync/pull": { pullEvents: async () => {} },
    "./recovery": { recoverJoinedVault: async () => false },
  }) as typeof import("../open-connection-notification");
  const data = {
    target: "connection",
    notification_id: "20",
    kind: "friend_accepted",
    recipient_account_id: ACCOUNT,
    actor_account_id: PEER,
    source_id: REQUEST,
    vault_id: VAULT,
  };
  await routing.openConnectionNotification({ ...data, recipient_account_id: PEER });
  assert.equal(routes.length, 0);
  await routing.openConnectionNotification({ ...data, notification_id: "../../account" });
  assert.equal(routes.length, 0);
  await routing.openConnectionNotification(data);
  assert.equal(routes.at(-1).params.accountId, PEER);
  liveShared = [{ id: REQUEST, token: "server-confirmed-token" }];
  await routing.openConnectionNotification({
    ...data,
    kind: "shared_invite_requested",
    token: "forged-token",
  });
  assert.equal(routes.at(-1).params.token, "server-confirmed-token");
  assert.equal(routes.at(-1).params.intent, undefined, "tap never accepts the request");
  liveShared = [];
  await routing.openConnectionNotification({ ...data, kind: "shared_invite_requested" });
  assert.equal(routes.at(-1), "/notifications", "expired request opens history");
  liveMembers = [{ id: REQUEST, token: "live-member-token" }];
  await routing.openConnectionNotification({ ...data, kind: "vault_invite_requested" });
  assert.equal(routes.at(-1).params.token, "live-member-token");
  liveVaults = [{ vault_id: VAULT }];
  await routing.openConnectionNotification({ ...data, kind: "vault_member_return_requested" });
  assert.equal(routes.at(-1), "/vault/members");
  assert.deepEqual(switches, [VAULT]);
  localVault = false;
  const readCount = reads.length,
    routeCount = routes.length;
  await assert.rejects(
    routing.openConnectionNotification({ ...data, kind: "vault_invite_accepted" }),
    /temporarily unavailable/,
  );
  assert.equal(routes.length, routeCount);
  assert.equal(reads.length, readCount, "failed recovery keeps notification retryable and unread");
  localVault = true;
  liveVaults = [];
  await routing.openConnectionNotification({ ...data, kind: "vault_member_removed" });
  assert.equal(routes.at(-1), "/notifications");
  assert.deepEqual(switches, [VAULT]);
  const profile = deferred<void>();
  profileWait = profile.promise;
  const opening = routing.openConnectionNotification(data, () => unlocked);
  await settleUI();
  unlocked = false;
  profile.resolve();
  await opening;
  assert.equal(routes.at(-1), "/notifications", "locking during fetch cannot navigate");
  unlocked = true;
  profileWait = null;
  const next = deferred<void>();
  profileWait = next.promise;
  const switched = routing.openConnectionNotification(data);
  await settleUI();
  account = PEER;
  epoch++;
  next.resolve();
  await assert.rejects(switched, /session changed/);
  assert.equal(routes.at(-1), "/notifications");
  console.log(
    "PASS: verified profile/request/member routes, expired/removed resources, app lock and account switch",
  );
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
