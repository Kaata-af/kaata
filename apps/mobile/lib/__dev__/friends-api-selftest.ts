// Exercises the real friendship client and transport without a ledger or server.
import assert from "node:assert/strict";
import type { SessionSnapshot } from "../auth";
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
      activity: { shared_tally: "active", kaata_invitation_role: "clerk", invite_token: "secret" },
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
      activity: { shared_tally: "active", kaata_invitation_role: "clerk" },
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
    await assert.rejects(f.api.getPersonProfile("../../friends"), { status: 404 });
    assert.equal(f.calls.length, 4);
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
    const reply = deferred<Response>();
    f.replies.push(() => reply.promise);
    const reading = f.api.getPersonProfile(peer, f.session());
    await settleUI();
    f.switchAccount(peer);
    reply.resolve(result({ person: identity, friendship: { state: "none" } }));
    await assert.rejects(reading, SessionChangedError);
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
    assert.equal(f.calls.length, 1, "stale row actions never use a re-signed account");
    f.replies.push(() => result({ requests: [] }));
    assert.deepEqual(f.render().rows, []);
    await settleHTTP();
    assert.deepEqual(f.render().rows, []);
    f.ui.unmount();
  }
  {
    const f = inboxFixture();
    f.replies.push(() => result({ requests: [row] }));
    f.render();
    await settleHTTP();
    const snapshot = f.render();
    const late = deferred<Response>();
    f.replies.push(
      () => late.promise,
      () => result(undefined, 204),
    );
    const refresh = snapshot.reload();
    await settleHTTP();
    await snapshot.decline(requestID);
    late.resolve(result({ requests: [row] }));
    await refresh;
    assert.deepEqual(f.render().rows, [], "a pending read cannot resurrect a declined request");
    f.replies.push(() => result({}, 404));
    await f.render().reload();
    assert.equal(f.render().failed, false, "older servers do not break the existing inbox");
    f.ui.unmount();
  }
  console.log(
    "PASS friendship API/inbox: private profile scope, independent lifecycle, pagination, session races, and stale decline guards",
  );
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
