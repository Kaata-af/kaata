// Real member-request helpers and transport against synthetic HTTP/session boundaries.
import assert from "node:assert/strict";
import { compileUI, deferred, settleUI, uiHooks } from "./ui-fixture";
import * as errors from "../tabs/errors";
import * as uuid from "../uuid-v5";
import type { SessionSnapshot } from "../auth";

const accountA = "11111111-1111-4111-8111-111111111111";
const accountB = "22222222-2222-4222-8222-222222222222";
const vaultA = "33333333-3333-4333-8333-333333333333";
const vaultB = "44444444-4444-4444-8444-444444444444";
const inviteId = "55555555-5555-4555-8555-555555555555";
const inviteId2 = "66666666-6666-4666-8666-666666666666";
const expires = new Date(Date.now() + 86400_000).toISOString();
const invited = new Date().toISOString();
const created = {
  invite_id: inviteId,
  invite_token: `v_${inviteId}`,
  delivery: "in_app",
  expires_at: expires,
};
const requestRow = {
  ...created,
  vault_id: vaultA,
  vault_name: "Shop",
  inviter_name: "Owner",
  role: "editor",
  invited_at: invited,
};
class SessionChangedError extends Error {}
class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message = code,
  ) {
    super(message);
  }
}
const tests: Array<[string, () => Promise<void>]> = [];
const test = (name: string, run: () => Promise<void>) => tests.push([name, run]);
const response = (body: unknown, status = 200) =>
  new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

function apiFixture() {
  let account: string | null = accountA,
    vault: string | null = vaultA,
    binding = 1;
  let supported: unknown = true,
    capabilityStatus = 200;
  let beforeBase: ((count: number) => Promise<void> | void) | undefined;
  let beforeCredit: (() => Promise<void> | void) | undefined;
  let bases = 0,
    creditUploads = 0,
    localWrites = 0;
  const requests: Array<{ url: string; init: RequestInit }> = [];
  const replies: Array<() => Response | Promise<Response>> = [];
  const session = (): SessionSnapshot => ({
    accountId: account,
    bindingVersion: binding,
    jwt: account ? `fixture-${binding}` : null,
  });
  const auth = {
    SessionChangedError,
    captureCurrentSession: async () => session(),
    applyForCurrentSession: async (saved: SessionSnapshot, work: () => Promise<unknown>) => {
      if (!saved.jwt || saved.accountId !== account || saved.bindingVersion !== binding)
        throw new SessionChangedError();
      return work();
    },
  };
  const forbiddenWrite = async () => {
    localWrites++;
    throw new Error("Member invitations cannot create ledger contacts or local invite caches");
  };
  const transport = compileUI(
    "../people-connections",
    {
      "./api": {
        getBackendUrl: async () => {
          await beforeBase?.(++bases);
          return "https://fixture.invalid";
        },
      },
      "./auth": auth,
      "./db": {
        getActiveVaultArchivedState: forbiddenWrite,
        getPerson: forbiddenWrite,
        setAppMeta: forbiddenWrite,
      },
      "./db-tx": {
        getAccountIdSync: () => account,
        getActiveVaultIdSyncMaybe: () => vault,
        getDb: forbiddenWrite,
      },
      "./event-log": { appendPersonAdded: forbiddenWrite },
      "./people-search-events": {
        notifyPeopleSearchChanged: () =>
          assert.fail("a member invite does not change directory contacts"),
      },
      "./tabs/link": { assertVaultAction: forbiddenWrite },
      "./tabs/errors": errors,
      "./uuid-v5": uuid,
    },
    {
      fetch: async (url: string, init: RequestInit) => {
        requests.push({ url, init });
        if (url.endsWith("/v1/sync/capabilities"))
          return response({ vault_account_invites: supported }, capabilityStatus);
        assert.ok(replies.length, `Unscripted request ${init.method} ${url}`);
        return replies.shift()!();
      },
    },
  );
  const api = compileUI("../vault-member-requests", {
    "./auth": auth,
    "./db-tx": { getActiveVaultIdSyncMaybe: () => vault },
    "./people-connections": transport,
    "./tabs/errors": errors,
    "./vault-api": { ApiError },
    "./credit-limits": {
      uploadPendingCreditPolicies: async (id: string, saved: SessionSnapshot) => {
        assert.equal(id, vaultA);
        assert.equal(saved.accountId, accountA);
        creditUploads++;
        await beforeCredit?.();
      },
    },
  }) as typeof import("../vault-member-requests");
  return {
    api,
    requests,
    replies,
    session,
    get localWrites() {
      return localWrites;
    },
    get creditUploads() {
      return creditUploads;
    },
    changeAccount: (value: string | null) => {
      account = value;
      binding++;
    },
    changeVault: (value: string | null) => {
      vault = value;
    },
    rebind: () => {
      binding++;
    },
    capability: (value: unknown, status = 200) => {
      supported = value;
      capabilityStatus = status;
    },
    onBase: (fn: typeof beforeBase) => {
      beforeBase = fn;
    },
    onCredit: (fn: typeof beforeCredit) => {
      beforeCredit = fn;
    },
  };
}

test("new account endpoint sends only recipient and allowed role with the captured session", async () => {
  for (const role of ["editor", "clerk", "viewer"] as const) {
    const f = apiFixture();
    f.replies.push(() => response(created));
    const result = await f.api.createVaultMemberRequest(
      vaultA,
      { recipientAccountId: accountB, role },
      f.session(),
    );
    assert.deepEqual(result, { ...created, expires_at: Date.parse(expires) });
    assert.equal(f.creditUploads, 1);
    assert.equal(f.localWrites, 0);
    assert.equal(f.requests.length, 2);
    const post = f.requests[1];
    assert.equal(post.url, `https://fixture.invalid/v1/vaults/${vaultA}/account-invites`);
    assert.equal(post.init.method, "POST");
    assert.deepEqual(JSON.parse(post.init.body as string), {
      target_account_id: accountB,
      role,
      readmit_removed: true,
    });
    assert.equal((post.init.headers as Record<string, string>).Authorization, "Bearer fixture-1");
  }
});

test("old servers, invalid roles and self-invites cannot create wildcard links", async () => {
  for (const capability of [false, undefined, "true"]) {
    const f = apiFixture();
    f.capability(capability);
    await assert.rejects(
      f.api.createVaultMemberRequest(vaultA, { recipientAccountId: accountB, role: "editor" }),
      (e: any) => e.code === "vault_account_invites_unsupported",
    );
    assert.equal(f.requests.length, 1);
    assert.equal(f.creditUploads, 0);
    assert.equal(f.localWrites, 0);
  }
  const old = apiFixture();
  old.capability(false, 404);
  await assert.rejects(
    old.api.createVaultMemberRequest(vaultA, { recipientAccountId: accountB, role: "viewer" }),
  );
  assert.equal(old.requests.length, 1);
  for (const body of [
    { recipientAccountId: accountA, role: "editor" },
    { recipientAccountId: accountB, role: "manager" },
    { recipientAccountId: "bad", role: "viewer" },
  ]) {
    const f = apiFixture();
    await assert.rejects(f.api.createVaultMemberRequest(vaultA, body as any));
    assert.equal(f.requests.length, 0);
  }
});

test("credit-policy and URL awaits cannot dispatch after account or vault changes", async () => {
  for (const boundary of ["credit", "base"])
    for (const scope of ["account", "vault", "session"]) {
      const f = apiFixture();
      const change = () =>
        scope === "account"
          ? f.changeAccount(accountB)
          : scope === "vault"
            ? f.changeVault(vaultB)
            : f.rebind();
      if (boundary === "credit") f.onCredit(change);
      else
        f.onBase((count) => {
          if (count === 2) change();
        });
      await assert.rejects(
        f.api.createVaultMemberRequest(vaultA, { recipientAccountId: accountB, role: "editor" }),
        SessionChangedError,
      );
      assert.equal(
        f.requests.filter((r) => r.init.method === "POST").length,
        0,
        `${boundary}/${scope}`,
      );
      assert.equal(f.localWrites, 0);
    }
});

test("strict creation replies and late changed-session replies cannot confirm delivery", async () => {
  for (const broken of [
    { invite_id: "bad" },
    { invite_token: "share-secret" },
    { delivery: "link" },
    { expires_at: "bad" },
    { expires_at: 1 },
  ]) {
    const f = apiFixture();
    f.replies.push(() => response({ ...created, ...broken }));
    await assert.rejects(
      f.api.createVaultMemberRequest(vaultA, { recipientAccountId: accountB, role: "editor" }),
      (e: any) => e.code === "invalid_response",
    );
  }
  const f = apiFixture();
  f.replies.push(() => {
    f.rebind();
    return response(created);
  });
  await assert.rejects(
    f.api.createVaultMemberRequest(vaultA, { recipientAccountId: accountB, role: "editor" }),
    SessionChangedError,
  );
});

test("preview and decline use protected selectors and never return raw email", async () => {
  const f = apiFixture();
  f.replies.push(() =>
    response({
      vault_name: "Shop",
      role: "viewer",
      inviter_name: "Owner",
      inviter_email: "private@example.test",
      expires_at: expires,
    }),
  );
  const info = await f.api.fetchVaultMemberRequestInfo(`v_${inviteId}`, f.session());
  assert.deepEqual(info, {
    vault_name: "Shop",
    role: "viewer",
    inviter_name: "Owner",
    inviter_email_redacted: null,
    expires_at: Date.parse(expires),
  });
  assert.equal(f.requests[0].url, `https://fixture.invalid/v1/vaults/invites/requests/${inviteId}`);
  assert.equal(
    (f.requests[0].init.headers as Record<string, string>).Authorization,
    "Bearer fixture-1",
  );
  f.replies.push(() => response({}, 404));
  assert.equal(await f.api.fetchVaultMemberRequestInfo(`v_${inviteId}`), null);
  assert.equal(await f.api.fetchVaultMemberRequestInfo("old-share-token"), null);
  f.replies.push(() => response({}, 404));
  await f.api.declineVaultMemberRequest(inviteId);
  assert.equal(f.requests[2].init.method, "DELETE");
  await assert.rejects(f.api.declineVaultMemberRequest("bad"));
  assert.equal(f.requests.length, 3);
  assert.equal(f.localWrites, 0);
  const denied = apiFixture();
  denied.replies.push(() => response({ error_code: "forbidden" }, 403));
  await assert.rejects(
    denied.api.declineVaultMemberRequest(inviteId),
    (e: any) => e.status === 403,
  );
});

test("account inbox filters legacy, duplicate, expired and invalid rows without local caches", async () => {
  const f = apiFixture();
  f.replies.push(() =>
    response({
      pending: [
        ...Array.from({ length: 101 }, () => ({ ...requestRow, invite_token: "wildcard-secret" })),
        requestRow,
        requestRow,
        { ...requestRow, invite_token: "wildcard-secret" },
        { ...requestRow, invite_id: inviteId2, invite_token: `v_${inviteId2}`, role: "owner" },
        {
          ...requestRow,
          invite_id: inviteId2,
          invite_token: `v_${inviteId2}`,
          expires_at: "2000-01-01T00:00:00Z",
        },
        null,
      ],
    }),
  );
  const rows = await f.api.listVaultMemberRequests();
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].init.method, "GET");
  assert.equal(
    f.requests[0].url,
    "https://fixture.invalid/v1/vaults/invites/pending?include_account_invites=1",
    "Only the new account-scoped inbox may opt into direct member requests; legacy clients keep their original pending list",
  );
  assert.deepEqual(rows, [
    {
      id: inviteId,
      token: `v_${inviteId}`,
      vault_id: vaultA,
      vault_name: "Shop",
      inviter_name: "Owner",
      role: "editor",
      invited_at: Date.parse(invited),
      expires_at: Date.parse(expires),
    },
  ]);
  assert.equal(f.localWrites, 0);
});

test("private return preview preserves its explicit consent kind", async () => {
  const f = apiFixture();
  f.replies.push(() =>
    response({
      kind: "member_readmission",
      vault_name: "Shop",
      role: "viewer",
      expires_at: expires,
    }),
  );
  assert.equal(
    (await f.api.fetchVaultMemberRequestInfo(`v_${inviteId}`, f.session()))?.kind,
    "member_readmission",
  );
  assert.equal(f.localWrites, 0);
});

test("create result retains only the literal owner return marker", async () => {
  for (const marker of [true, false, "true"]) {
    const f = apiFixture();
    f.replies.push(() => response({ ...created, member_readmission: marker }));
    const result = await f.api.createVaultMemberRequest(
      vaultA,
      { recipientAccountId: accountB, role: "viewer" },
      f.session(),
    );
    assert.equal(result.member_readmission, marker === true ? true : undefined);
  }
});

function hookFixture(kind: "members" | "people" = "members") {
  const hooks = uiHooks();
  let account: string | null = accountA,
    focused = true;
  let listener: () => void = () => {},
    appListener: (state: string) => void = () => {};
  let nextTimer = 0;
  const timers = new Map<number, () => void>();
  const lists: Array<ReturnType<typeof deferred<any[]>>> = [];
  const declines: Array<{ id: string; reply: ReturnType<typeof deferred<void>> }> = [];
  const appState = {
    currentState: "active",
    addEventListener: (_event: string, callback: (state: string) => void) => {
      appListener = callback;
      return {
        remove: () => {
          appListener = () => {};
        },
      };
    },
  };
  const startList = () => {
    const reply = deferred<any[]>();
    lists.push(reply);
    return reply.promise;
  };
  const startDecline = (id: string) => {
    const reply = deferred<void>();
    declines.push({ id, reply });
    return reply.promise;
  };
  const compiled = compileUI(
    kind === "members" ? "../use-vault-member-requests" : "../use-people-requests",
    {
      react: {
        ...hooks.react,
        useSyncExternalStore: (
          subscribe: (callback: () => void) => () => void,
          snapshot: () => unknown,
        ) => {
          hooks.react.useEffect(() => subscribe(() => {}), [subscribe]);
          return snapshot();
        },
      },
      "expo-router": {
        useFocusEffect: (fn: () => void | (() => void)) =>
          hooks.react.useEffect(() => (focused ? fn() : undefined), [fn, focused]),
      },
      "react-native": { AppState: appState },
      "./db-tx": {
        getAccountIdSync: () => accountA,
        getSessionAccountIdSync: () => account,
        onAccountIdentityChanged: (fn: () => void) => {
          listener = fn;
          return () => {
            listener = () => {};
          };
        },
      },
      "./auth": { SessionChangedError },
      "./vault-api": { ApiError },
      "./incoming-request-cue": { observeIncomingRequests: () => null },
      "./notification-events": compileUI("../notification-events", {}),
      "./tabs/errors": errors,
      "./people-connections": { listPeopleRequests: startList, declinePeopleRequest: startDecline },
      "./vault-member-requests": {
        listVaultMemberRequests: startList,
        declineVaultMemberRequest: startDecline,
      },
    },
    {
      setInterval: (fn: () => void) => {
        const id = ++nextTimer;
        timers.set(id, fn);
        return id;
      },
      clearInterval: (id: number) => {
        timers.delete(id);
      },
    },
  );
  const render = () =>
    hooks.render(kind === "members" ? compiled.useVaultMemberRequests : compiled.usePeopleRequests);
  const result = () =>
    hooks.tree as unknown as ReturnType<
      typeof import("../use-vault-member-requests").useVaultMemberRequests
    >;
  render();
  return {
    hooks,
    render,
    result,
    lists,
    declines,
    timers,
    settle: async () => {
      await settleUI();
      render();
    },
    account: (value: string | null) => {
      account = value;
      listener();
      render();
    },
    rebind: (paint = true) => {
      listener();
      listener();
      if (paint) render();
    },
    focus: (value: boolean) => {
      focused = value;
      render();
    },
    poll: () => {
      for (const fn of timers.values()) fn();
    },
    appState: (value: string) => {
      appState.currentState = value;
      appListener(value);
    },
  };
}

for (const kind of ["members", "people"] as const) {
  test(`${kind} inbox hook immediately hides signed-out and batched same-account session rows`, async () => {
    const f = hookFixture(kind);
    f.lists[0].resolve([{ id: inviteId }]);
    await f.settle();
    assert.equal(f.result().rows.length, 1);
    f.account(null);
    assert.deepEqual(f.result().rows, []);
    f.account(accountA);
    assert.deepEqual(f.result().rows, []);
    f.lists.at(-1)!.resolve([{ id: inviteId }]);
    await f.settle();
    f.rebind();
    assert.deepEqual(f.result().rows, []);
    f.hooks.unmount();
  });

  test(`${kind} late reloads and successful declines cannot restore old account inbox rows`, async () => {
    const f = hookFixture(kind);
    f.account(accountB);
    f.lists[0].resolve([{ id: inviteId }]);
    await f.settle();
    assert.deepEqual(f.result().rows, []);
    f.lists[1].resolve([{ id: inviteId2 }]);
    await f.settle();
    assert.deepEqual(
      f.result().rows.map((r) => r.id),
      [inviteId2],
    );
    const reload = f.result().reload();
    const decline = f.result().decline(inviteId2);
    f.declines[0].reply.resolve();
    await decline;
    await f.settle();
    assert.deepEqual(f.result().rows, []);
    f.lists[2].resolve([{ id: inviteId2 }]);
    await reload;
    await f.settle();
    assert.deepEqual(f.result().rows, [], "An older read cannot resurrect the declined invitation");
    f.hooks.unmount();
  });

  test(`${kind} hook polling follows focus/foreground and failed decline stays retryable`, async () => {
    const f = hookFixture(kind);
    f.lists[0].resolve([{ id: inviteId }]);
    await f.settle();
    const decline = f.result().decline(inviteId);
    f.declines[0].reply.reject(new ApiError(503, "unavailable"));
    await assert.rejects(decline);
    assert.equal(f.result().rows.length, 1);
    f.appState("background");
    f.poll();
    assert.equal(f.lists.length, 1);
    f.appState("active");
    assert.equal(f.lists.length, 2);
    f.focus(false);
    f.lists[1].resolve([{ id: inviteId2 }]);
    await f.settle();
    assert.equal(f.timers.size, 0);
    assert.deepEqual(
      f.result().rows.map((r) => r.id),
      [inviteId],
    );
    f.focus(true);
    assert.equal(f.lists.length, 3);
    f.hooks.unmount();
    f.lists[2].resolve([]);
    await settleUI();
    assert.equal(f.hooks.lateWrites, 0);
  });

  test(`${kind} old callbacks are blocked before the identity change renders`, async () => {
    const f = hookFixture(kind);
    f.lists[0].resolve([{ id: inviteId }]);
    await f.settle();
    const previous = f.result();
    if (kind === "members") assert.equal(previous.isRequestCurrent(inviteId), true);
    f.rebind(false);
    if (kind === "members") assert.equal(previous.isRequestCurrent(inviteId), false);
    await previous.decline(inviteId);
    await previous.reload();
    assert.equal(f.declines.length, 0);
    assert.equal(f.lists.length, 1);
    f.render();
    assert.deepEqual(f.result().rows, []);
    f.lists[1].reject(new ApiError(503, "unavailable"));
    await f.settle();
    assert.equal(f.result().failed, true);
    f.account(accountB);
    assert.equal(f.result().failed, false);
    f.hooks.unmount();
  });
}

async function main() {
  for (const [name, run] of tests) {
    await run();
    console.log(`PASS ${name}`);
  }
  console.log(`vault-member-requests: ${tests.length} focused API/transport/hook tests passed`);
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
