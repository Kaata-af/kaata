// Exercises the real friendship client and transport without a ledger or server.
import assert from "node:assert/strict";
import type { SessionSnapshot } from "../auth";
import type { PeopleSearchChange } from "../people-search-events";
import * as tabErrors from "../tabs/errors";
import * as uuid from "../uuid-v5";
import { compileUI, deferred, settleUI, uiHooks } from "./ui-fixture";

const owner = "11111111-1111-4111-8111-111111111111";
const peer = "22222222-2222-4222-8222-222222222222";
const vault = "33333333-3333-4333-8333-333333333333";
const requestID = "44444444-4444-4444-8444-444444444444";
const relationship = "55555555-5555-4555-8555-555555555555";
const identity = { account_id: peer, name: "Peer", username: "peer" };
const row = { id: requestID, from: identity, created_at_ms: 1000 };
const result = (data?: unknown, status = 200) =>
  new Response(status === 204 ? null : JSON.stringify(data), { status });
const settleHTTP = async () => {
  await settleUI();
  await new Promise<void>((resolve) => setImmediate(resolve));
  await settleUI();
};

class SessionChangedError extends Error {}

function fixture() {
  let account: string | null = owner;
  let epoch = 1;
  let beforeBase: (() => Promise<unknown>) | undefined;
  const listeners = new Set<() => void>();
  const calls: { path: string; init: RequestInit }[] = [];
  const replies: Array<() => Response | Promise<Response>> = [];
  const searchEvents = compileUI(
    "../people-search-events",
    {},
  ) as typeof import("../people-search-events");
  const searchChanges: PeopleSearchChange[] = [];
  searchEvents.onPeopleSearchChanged((change) => searchChanges.push(change));
  const session = (): SessionSnapshot => ({
    accountId: account,
    jwt: account ? `token-${epoch}` : null,
    bindingVersion: epoch,
  });
  const auth = {
    SessionChangedError,
    captureCurrentSession: async () => session(),
    applyForCurrentSession: async (expected: SessionSnapshot, work: () => Promise<unknown>) => {
      if (!expected.jwt || expected.accountId !== account || expected.bindingVersion !== epoch)
        throw new SessionChangedError();
      return work();
    },
  };
  const forbidden = () => assert.fail("friendship touched a ledger, contact, or membership");
  const transport = compileUI(
    "../people-connections",
    {
      "./auth": auth,
      "./api": {
        getBackendUrl: async () => {
          await beforeBase?.();
          return "https://fixture.invalid";
        },
      },
      "./db": {
        getActiveVaultArchivedState: forbidden,
        getPerson: forbidden,
        setAppMeta: forbidden,
      },
      "./db-tx": {
        getAccountIdSync: () => account,
        getActiveVaultIdSyncMaybe: forbidden,
        getDb: forbidden,
      },
      "./event-log": { appendPersonAdded: forbidden },
      "./people-search-events": searchEvents,
      "./tabs/link": { assertVaultAction: forbidden },
      "./tabs/errors": tabErrors,
      "./uuid-v5": uuid,
    },
    {
      fetch: async (url: string, init: RequestInit) => {
        calls.push({ path: url.replace("https://fixture.invalid", ""), init });
        assert.ok(replies.length, `Unexpected ${init.method} ${url}`);
        return replies.shift()!();
      },
    },
  );
  const api = compileUI("../friends-api", {
    "./auth": auth,
    "./people-connections": transport,
    "./people-search-events": searchEvents,
    "./tabs/errors": tabErrors,
  }) as typeof import("../friends-api");
  const dbScope = {
    getSessionAccountIdSync: () => account,
    onAccountIdentityChanged: (fn: () => void) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
  return {
    auth,
    api,
    dbScope,
    calls,
    replies,
    searchEvents,
    searchChanges,
    session,
    switchAccount: (next: string | null) => {
      account = next;
      epoch++;
      listeners.forEach((fn) => fn());
    },
    delayURL: (fn: () => Promise<unknown>) => (beforeBase = fn),
  };
}

function inboxFixture() {
  const f = fixture();
  const ui = uiHooks();
  const { useFriendRequests } = compileUI(
    "../use-friend-requests",
    {
      react: {
        ...ui.react,
        useSyncExternalStore: (subscribe: (fn: () => void) => () => void, read: () => string) => {
          ui.react.useEffect(() => subscribe(() => {}), [subscribe]);
          return read();
        },
      },
      "expo-router": { useFocusEffect: (fn: () => () => void) => ui.react.useEffect(fn, [fn]) },
      "react-native": {
        AppState: { currentState: "active", addEventListener: () => ({ remove() {} }) },
      },
      "./auth": f.auth,
      "./db-tx": f.dbScope,
      "./friends-api": f.api,
      "./incoming-request-cue": { observeIncomingRequests: () => null },
      "./tabs/errors": tabErrors,
    },
    { setInterval: () => 1, clearInterval: () => {} },
  ) as typeof import("../use-friend-requests");
  const render = () => {
    ui.render(() => ({ type: "FriendInboxResult", props: useFriendRequests() }));
    return ui.tree!.props as ReturnType<typeof useFriendRequests>;
  };
  return { ...f, ui, render };
}

async function main() {
  {
    const events = compileUI(
      "../people-search-events",
      {},
    ) as typeof import("../people-search-events");
    const changes: PeopleSearchChange[] = [];
    events.onPeopleSearchChanged(() => {
      throw new Error("observer failed");
    });
    const stop = events.onPeopleSearchChanged((change) => changes.push(change));
    events.notifyPeopleSearchChanged({ accountId: owner, vaultId: vault });
    assert.deepEqual(
      changes,
      [{ accountId: owner, vaultId: vault }],
      "observer failures cannot suppress later invalidation listeners",
    );
    stop();
    events.notifyPeopleSearchChanged({ accountId: owner });
    assert.equal(changes.length, 1, "unsubscribed observers receive no updates");
  }
  {
    const f = fixture();
    const profile = {
      person: {
        ...identity,
        phone: "+93000000000",
        email: "private@test",
        existing_relationship_id: relationship,
      },
      friendship: { state: "friends", id: requestID },
      can_receive_requests: true,
      activity: { shared_tally: "active", kaata_member_role: "clerk", invite_token: "secret" },
    };
    f.replies.push(
      () => result(profile),
      () => result(profile),
    );
    assert.deepEqual(await f.api.getPersonProfile(peer, f.session()), {
      person: identity,
      friendship: { state: "friends", id: requestID },
      can_receive_requests: true,
    });
    assert.deepEqual(await f.api.getPersonProfile(peer, f.session(), vault), {
      person: { ...identity, existing_relationship_id: relationship },
      friendship: { state: "friends", id: requestID },
      can_receive_requests: true,
      activity: { shared_tally: "active", kaata_member_role: "clerk" },
    });
    assert.equal(f.calls[1].path, `/v1/people/profiles/${peer}?vault_id=${vault}`);
    assert.equal(
      (f.calls[1].init.headers as Record<string, string>).Authorization,
      "Bearer token-1",
    );
    f.replies.push(() => result({ ...profile, person: { ...identity, account_id: owner } }));
    await assert.rejects(f.api.getPersonProfile(peer), { code: "invalid_response" });
    f.replies.push(() => result({ ...profile, can_receive_requests: "true" }));
    assert.equal((await f.api.getPersonProfile(peer)).can_receive_requests, false);
    f.replies.push(() =>
      result({ ...profile, activity: { ...profile.activity, shared_tally: "declined" } }),
    );
    assert.equal(
      (await f.api.getPersonProfile(peer, f.session(), vault)).activity?.shared_tally,
      "declined",
    );
    await assert.rejects(f.api.getPersonProfile("../../friends"), { status: 404 });
    assert.equal(f.calls.length, 5);
  }
  {
    const f = fixture();
    f.replies.push(
      () => result({ friendship: { state: "incoming", id: requestID } }),
      () => result({ friendship: { state: "friends", id: requestID } }),
      () => result(undefined, 204),
      () => result(undefined, 204),
    );
    assert.equal(
      (await f.api.sendFriendRequest(peer)).state,
      "incoming",
      "cross-send is not consent",
    );
    assert.equal((await f.api.acceptFriendRequest(requestID)).state, "friends");
    await f.api.dismissFriendRequest(requestID);
    await f.api.removeFriend(requestID);
    assert.deepEqual(
      f.searchChanges,
      Array.from({ length: 4 }, () => ({ accountId: owner })),
      "validated friendship mutations invalidate that account across its books",
    );
    assert.deepEqual(
      f.calls.map(({ path, init }) => [init.method, path, init.body]),
      [
        ["POST", "/v1/friends/requests", JSON.stringify({ account_id: peer })],
        ["POST", `/v1/friends/requests/${requestID}/accept`, undefined],
        ["DELETE", `/v1/friends/requests/${requestID}`, undefined],
        ["DELETE", `/v1/friends/${requestID}`, undefined],
      ],
    );
    f.replies.push(() => result({ friendship: { state: "friends", id: relationship } }));
    await assert.rejects(f.api.acceptFriendRequest(requestID), { code: "invalid_response" });
    f.replies.push(() => result({ friendship: { state: "invented" } }));
    await assert.rejects(f.api.sendFriendRequest(peer), { code: "invalid_response" });
    f.replies.push(() => result({ error_code: "forbidden" }, 403));
    await assert.rejects(f.api.dismissFriendRequest(requestID), { status: 403 });
    assert.equal(
      f.searchChanges.length,
      4,
      "invalid or failed mutations do not invalidate settled results",
    );
    f.searchEvents.onPeopleSearchChanged(() => {
      throw new Error("observer failed");
    });
    f.replies.push(() => result(undefined, 204));
    await f.api.removeFriend(requestID);
    assert.equal(
      f.searchChanges.length,
      5,
      "an observer cannot turn a successful removal into failure",
    );
  }
  {
    const f = fixture();
    f.replies.push(() =>
      result({
        friends: [identity, identity, { ...identity, account_id: owner }],
        next_cursor: peer,
      }),
    );
    assert.deepEqual(await f.api.listFriends(), { friends: [identity], next_cursor: peer });
    f.replies.push(() => result({ friends: [], next_cursor: peer }));
    await assert.rejects(f.api.listFriends(peer), { code: "invalid_response" });
    assert.equal(f.calls[1].path, `/v1/friends?after=${peer}`);
    f.replies.push(() =>
      result({
        requests: [
          row,
          row,
          { ...row, id: relationship, created_at_ms: "wrong" },
          { ...row, id: relationship, from: { ...identity, account_id: owner } },
        ],
      }),
    );
    assert.deepEqual(await f.api.listFriendRequests(), [row]);
  }
  {
    const f = fixture();
    const gate = deferred<void>();
    f.delayURL(() => gate.promise);
    const pending = f.api.sendFriendRequest(peer, f.session());
    f.switchAccount(null);
    f.switchAccount(owner);
    gate.resolve();
    await assert.rejects(pending, SessionChangedError);
    await assert.rejects(
      f.api.sendFriendRequest(peer, f.session(), () => {
        throw new SessionChangedError();
      }),
      SessionChangedError,
    );
    assert.deepEqual(f.calls, [], "account replacement and screen departure block dispatch");
    assert.deepEqual(f.searchChanges, []);
    const reply = deferred<Response>();
    f.replies.push(() => reply.promise);
    const reading = f.api.getPersonProfile(peer, f.session());
    await settleUI();
    f.switchAccount(peer);
    reply.resolve(result({ person: identity, friendship: { state: "none" } }));
    await assert.rejects(reading, SessionChangedError);
  }
  {
    const f = fixture();
    const reply = deferred<Response>();
    f.replies.push(() => reply.promise);
    const removing = f.api.removeFriend(requestID);
    await settleHTTP();
    f.switchAccount(peer);
    reply.resolve(result(undefined, 204));
    await assert.rejects(removing, SessionChangedError);
    assert.deepEqual(
      f.searchChanges,
      [],
      "a late mutation from another session cannot invalidate the current directory",
    );
  }
  {
    const f = inboxFixture();
    f.replies.push(() => result({ requests: [row] }));
    f.render();
    await settleHTTP();
    const old = f.render();
    assert.deepEqual(old.rows, [row]);
    f.switchAccount(null);
    f.switchAccount(owner);
    assert.equal(old.isCurrent(), false);
    await old.decline(requestID);
    await old.accept(requestID);
    assert.equal(f.calls.length, 1, "stale row actions never use a re-signed account");
    f.replies.push(() => result({ requests: [] }));
    assert.deepEqual(f.render().rows, []);
    await settleHTTP();
    assert.deepEqual(f.render().rows, []);
    f.ui.unmount();
  }
  for (const action of ["accept", "decline"] as const) {
    const f = inboxFixture();
    f.replies.push(() => result({ requests: [row] }));
    f.render();
    await settleHTTP();
    const snapshot = f.render();
    const late = deferred<Response>();
    const response = deferred<Response>();
    f.replies.push(
      () => late.promise,
      () => response.promise,
    );
    const refresh = snapshot.reload();
    await settleHTTP();
    const pending = snapshot[action](requestID);
    await settleHTTP();
    assert.equal(f.render().responding?.action, action);
    assert.equal(
      snapshot.isRequestCurrent(requestID),
      false,
      "profile is disabled while responding",
    );
    await snapshot.accept(requestID);
    await snapshot.decline(requestID);
    assert.equal(f.calls.length, 3, "duplicate and opposite taps do not dispatch another action");
    assert.equal(f.calls[2].init.method, action === "accept" ? "POST" : "DELETE");
    response.resolve(
      action === "accept"
        ? result({ friendship: { state: "friends", id: requestID } })
        : result(undefined, 204),
    );
    await pending;
    await snapshot[action](requestID);
    assert.equal(f.calls.length, 3, "a retained handler cannot resubmit a completed action");
    late.resolve(result({ requests: [row] }));
    await refresh;
    assert.deepEqual(f.render().rows, [], "a pending read cannot resurrect a resolved request");
    f.replies.push(() => result({}, 404));
    await f.render().reload();
    assert.equal(f.render().failed, false, "older servers do not break the existing inbox");
    f.ui.unmount();
  }
  {
    const f = inboxFixture();
    f.replies.push(() => result({ requests: [row] }));
    f.render();
    await settleHTTP();
    f.replies.push(
      () => result({}, 503),
      () => result({ requests: [row] }),
    );
    await assert.rejects(f.render().accept(requestID), { status: 503 });
    await settleHTTP();
    assert.deepEqual(
      f.render().rows,
      [row],
      "a failed response leaves the request available for retry",
    );
    assert.equal(f.render().responding, null);
    f.replies.push(() => result({ friendship: { state: "friends", id: requestID } }));
    await f.render().accept(requestID);
    assert.deepEqual(f.render().rows, []);
    f.ui.unmount();
  }
  console.log(
    "PASS friendship API/inbox: private profile scope, independent lifecycle, pagination, session races, and guarded accept/reject",
  );
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
