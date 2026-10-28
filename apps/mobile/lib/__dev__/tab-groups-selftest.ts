// Real group orchestration with synthetic storage/network boundaries.
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { compileUI, deferred } from "./ui-fixture";
import * as errors from "../tabs/errors";
import { directionFor } from "../tabs/direction";
import { minorToWire } from "../tabs/wire";
import { Mutex } from "../util/mutex";
import { canWriteSharedTallies, isTabRecordingMode } from "../tabs/recording-mode";
import type {
  CreateTabGroupRequest,
  TabGroupResponse,
  TabLink,
  TabRecordingMode,
} from "../tabs/types";

function fixture() {
  let vault = "vault",
    account = "owner",
    writable = true,
    supported = true;
  const meta = new Map<string, string>(),
    cache = new Map<string, TabLink>();
  const balances = new Map([
    ["AFN", 100],
    ["USD", -20],
    ["EUR", 0],
  ]);
  const sent: CreateTabGroupRequest[] = [],
    joinedBodies: unknown[] = [],
    batches: TabLink[][] = [];
  const writer = new Mutex(),
    recordedCurrencies = ["EUR"];
  let inSnapshot = false,
    pendingSource = false,
    joinedRequests = 0;
  let beforeHistory: (() => void) | null = null,
    writeOnRead = false;
  let competingWrite: Promise<unknown> | null = null;
  let createPeople = 0,
    ensured = 0,
    closed = 0,
    regenerated = 0,
    notices = 0,
    pushes = 0;
  let loseCreate = false,
    loseJoin = false,
    sourceResponse: TabGroupResponse | null = null;
  let lookupMissing = false,
    retryRefusal: errors.TabApiError | null = null;
  let pauseCreate: ReturnType<typeof deferred<void>> | null = null;
  const started = deferred<void>();
  const response = (
    id: string,
    mode: TabRecordingMode,
    currencies: string[],
    role: "a" | "b" = "a",
  ): TabGroupResponse => {
    const parties = {
      a: {
        label: "Owner",
        joined_at_ms: 1,
        bound: true,
        vault_id: role === "a" ? vault : "creator-vault",
        relationship_id: "rel",
        history_order: "1",
        linked_at_ms: 123,
      },
      b: {
        label: "Recipient",
        joined_at_ms: role === "b" ? 2 : null,
        bound: role === "b",
        vault_id: role === "b" ? vault : null,
        relationship_id: role === "b" ? "rel" : null,
        history_order: "2",
        linked_at_ms: 456,
      },
    };
    return {
      group: {
        id,
        recording_mode: mode,
        rev: 0,
        created_at_ms: 1,
        closed_at_ms: null,
        closed_by: null,
        you: role,
        currencies,
        parties,
      },
      tabs: currencies.map((currency, index) => ({
        full: true,
        entries: [],
        tab: {
          id: `${id}-${currency}`,
          group_id: id,
          recording_mode: mode,
          currency,
          rev: 0,
          created_at_ms: 1,
          closed_at_ms: null,
          closed_by: null,
          you: role,
          parties: {
            a: { ...parties.a, linked_at_ms: 123 + index },
            b: { ...parties.b, linked_at_ms: 456 + index },
          },
          unjoined_invitation: role === "a",
          balance: { a: "0", b: "0" },
          pending_for_you: 0,
        },
      })),
      invite_url: `https://kaata.af/t/g_${"A".repeat(43)}`,
    };
  };
  const auth = {
    captureCurrentSession: async () => ({ jwt: "jwt", accountId: account }),
    applyForCurrentSession: async (session: any, action: () => any) => {
      if (session.accountId !== account) throw new errors.TabAuthUnavailableError();
      return action();
    },
  };
  const api = {
    ensureTabGroupSupport: async () => {
      if (!supported) throw new errors.TabApiError(503, "shared_account_unsupported", "update");
    },
    createTabGroup: async (body: CreateTabGroupRequest) => {
      assert.equal(inSnapshot, false, "Create never holds the local writer lock during a request");
      sent.push(structuredClone(body));
      if (retryRefusal) throw retryRefusal;
      started.resolve();
      if (pauseCreate) await pauseCreate.promise;
      sourceResponse ??= response(
        body.request_id,
        body.recording_mode,
        body.currencies.map((item) => item.currency),
      );
      if (loseCreate) {
        loseCreate = false;
        throw new errors.TabApiError(0, "network", "lost reply");
      }
      return structuredClone(sourceResponse);
    },
    fetchTabGroup: async () => {
      if (lookupMissing) throw new errors.TabApiError(404, "not_found", "not found");
      const result = structuredClone(sourceResponse!);
      delete result.invite_url;
      return result;
    },
    fetchTabGroupByToken: async () => ({ ...structuredClone(sourceResponse!), tabs: [] }),
    joinTabGroup: async (_id: string, body: any) => {
      assert.equal(inSnapshot, false, "Join never holds the local writer lock during a request");
      joinedRequests++;
      joinedBodies.push(structuredClone(body));
      if (retryRefusal) throw retryRefusal;
      assert.equal(body.token, "A".repeat(43));
      assert.deepEqual(
        body.currencies.map((item: any) => item.currency),
        sourceResponse!.group.currencies,
      );
      sourceResponse = response(
        sourceResponse!.group.id,
        sourceResponse!.group.recording_mode,
        sourceResponse!.group.currencies,
        "b",
      );
      if (loseJoin) {
        loseJoin = false;
        throw new errors.TabApiError(0, "network", "lost reply");
      }
      return structuredClone(sourceResponse);
    },
    ensureTabGroupCurrency: async (_id: string, body: any) => {
      ensured++;
      assert.equal(body.opening, null);
      sourceResponse = response(sourceResponse!.group.id, sourceResponse!.group.recording_mode, [
        ...sourceResponse!.group.currencies,
        body.currency,
      ]);
      return structuredClone(sourceResponse);
    },
    closeTabGroup: async () => {
      closed++;
      const result = structuredClone(sourceResponse!);
      result.group.closed_at_ms = 50;
      result.tabs.forEach((item) => {
        item.tab.closed_at_ms = 50;
      });
      return result;
    },
    regenerateTabGroupLink: async () => {
      regenerated++;
      return { ...structuredClone(sourceResponse!), invite_url: "https://kaata.af/t/g_new" };
    },
  };
  const module = compileUI("../tabs/groups", {
    "expo-crypto": { randomUUID, getRandomBytesAsync: async (count: number) => randomBytes(count) },
    "../auth": auth,
    "../currency": {
      getEnabledCurrencies: async () => ["AFN", "USD"],
      applyVaultCurrency: async () => {},
    },
    "../currency-scope": {
      requireCurrencyCode: (code: string) => {
        assert.match(code, /^[A-Z]{3}$/);
        return code;
      },
      effectiveEntryCurrencySql: () => "e.currency",
    },
    "../db": {
      getActiveRelationshipIdForPerson: async () => "rel",
      getAppMeta: async (key: string) => meta.get(key) ?? null,
      setAppMeta: async (key: string, value: string) => {
        meta.set(key, value);
      },
      getPerson: async (_id: string, currency: string) => {
        if (writeOnRead && inSnapshot) {
          writeOnRead = false;
          competingWrite = writer
            .runExclusive(async () => {
              if (
                [...meta.entries()].some(
                  ([key, value]) =>
                    value &&
                    (key.startsWith("tab_group_create:") ||
                      key.startsWith("tab_group_pending_join:")),
                )
              )
                throw new errors.TabApiError(409, "shared_account_pending", "source is frozen");
              balances.set(currency, 999);
            })
            .then(
              () => null,
              (error) => error,
            );
        }
        return { balance: balances.get(currency) ?? 0 };
      },
      createPerson: async () => {
        createPeople++;
        return { ok: true, id: "new-person" };
      },
    },
    "../db-tx": {
      getActiveVaultIdSyncMaybe: () => vault,
      getAccountIdSync: () => account,
      setActiveVaultId: async (id: string) => {
        vault = id;
      },
      getDb: async () => ({
        getAllAsync: async () => recordedCurrencies.map((currency) => ({ currency })),
        getFirstAsync: async (sql: string, ...args: unknown[]) => {
          assert.match(sql, /source.server_acked_at IS NULL/);
          assert.deepEqual(args, [vault, "rel", vault, "rel"]);
          return pendingSource ? { one: 1 } : null;
        },
        runAsync: async (_sql: string, key: string, value: string) => {
          if (meta.get(key) === value) meta.set(key, "");
        },
        withTransactionAsync: async (work: () => Promise<void>) => {
          const previous = new Map(meta);
          try {
            await work();
          } catch (error) {
            meta.clear();
            previous.forEach((value, key) => meta.set(key, value));
            throw error;
          }
        },
      }),
    },
    "../money": require("../money"),
    "../projection": {
      applyEventMutex: {
        runExclusive: (work: () => Promise<unknown>) =>
          writer.runExclusive(async () => {
            inSnapshot = true;
            try {
              return await work();
            } finally {
              inSnapshot = false;
            }
          }),
      },
    },
    "../types": { ENTRY_NOTE_MAX_LENGTH: 2000 },
    "./api": api,
    "./db": {
      getTabLink: async (id: string) => cache.get(id) ?? null,
      listOpenTabLinksForPerson: async () =>
        [...cache.values()].filter((link) => link.closed_at == null),
      getTabGroupLinkForPerson: async () =>
        [...cache.values()].find((link) => link.group_id && link.closed_at == null) ?? null,
      upsertTabGroupFromWire: async (links: TabLink[]) => {
        batches.push(structuredClone(links));
        links.forEach((link) =>
          cache.set(link.tab_id, {
            ...link,
            invite_url: link.invite_url ?? cache.get(link.tab_id)?.invite_url ?? null,
          }),
        );
      },
    },
    "./direction": { directionFor },
    "./errors": errors,
    "./link": {
      assertVaultAction: async () => {
        if (!writable) throw new errors.TabPermissionError();
      },
      cleanLabel: (label: string) => label.trim(),
      relationshipInVault: async () => "rel",
      fetchTabPreview: async () => ({ tab: { currency: "AFN" }, entries: [] }),
      joinFailure: async (error: unknown) => error,
      prepareSharedHistory: async () => {
        assert.equal(
          inSnapshot,
          false,
          "History network work happens before the local writer lock",
        );
        const hook = beforeHistory;
        beforeHistory = null;
        hook?.();
        return {};
      },
      resendSelfPhone: async () => {},
      pushVaultBestEffort: async () => {
        pushes++;
      },
      askNotifyPermission: () => {
        notices++;
      },
    },
    "./recording-mode": { canWriteSharedTallies, isTabRecordingMode },
    "./sync": { reconcileTabsFromServer: async () => {} },
    "./wire": { minorToWire },
  }) as typeof import("../tabs/groups");
  return {
    module,
    meta,
    cache,
    sent,
    joinedBodies,
    batches,
    balances,
    started,
    get joinedRequests() {
      return joinedRequests;
    },
    get competingWrite() {
      return competingWrite;
    },
    raceSourceWrite: () => {
      writeOnRead = true;
    },
    pendingSource: (value = true) => {
      pendingSource = value;
    },
    beforeHistory: (hook: () => void) => {
      beforeHistory = hook;
    },
    addRecordedCurrency: (currency: string) => {
      recordedCurrencies.push(currency);
    },
    closeOnServer: () => {
      sourceResponse!.group.closed_at_ms = 999;
      sourceResponse!.tabs.forEach((item) => {
        item.tab.closed_at_ms = 999;
      });
    },
    missingLookup: (missing = true) => {
      lookupMissing = missing;
    },
    refuseRetry: (code: string, status = 409) => {
      retryRefusal = new errors.TabApiError(status, code, "retry refused");
    },
    get notices() {
      return notices;
    },
    get pushes() {
      return pushes;
    },
    get createPeople() {
      return createPeople;
    },
    get ensured() {
      return ensured;
    },
    get closed() {
      return closed;
    },
    get regenerated() {
      return regenerated;
    },
    loseCreate: () => {
      loseCreate = true;
    },
    loseJoin: () => {
      loseJoin = true;
    },
    pauseCreate: () => (pauseCreate = deferred<void>()),
    scope: (next: string) => {
      account = next;
    },
    role: (allowed: boolean) => {
      writable = allowed;
    },
    support: (value: boolean) => {
      supported = value;
    },
    seed: (mode: TabRecordingMode = "notify", currencies = ["AFN"], role: "a" | "b" = "a") => {
      sourceResponse = response("group", mode, currencies, role);
      return structuredClone(sourceResponse);
    },
    async bind(response: TabGroupResponse) {
      const role = response.group.you;
      for (const item of response.tabs)
        cache.set(item.tab.id, {
          tab_id: item.tab.id,
          group_id: response.group.id,
          currency: item.tab.currency,
          vault_id: vault,
          relationship_id: "rel",
          role,
          recording_mode: response.group.recording_mode,
          recording_mode_known: 1,
          closed_at: null,
        } as TabLink);
    },
  };
}

async function apiChecks() {
  const api = compileUI("../tabs/api", {
    "../api": { getBackendUrl: async () => "https://synthetic.invalid" },
    "../auth": { getSessionJWT: async () => "session" },
    "../currency-sync": { ensureCurrencySyncSupported: async () => {} },
    "./errors": errors,
    "./recording-mode": {
      canWriteSharedTallies,
      isTabRecordingMode,
      isNotificationOnlyMode: (mode: string) => mode === "notify" || mode === "notify_one_way",
    },
    "./wire": { minorToWire },
  }) as typeof import("../tabs/api");
  const realFetch = globalThis.fetch;
  const full = fixture().seed("review", ["AFN", "USD"]);
  let supported = true,
    writes = 0,
    scalarReads = 0;
  let reply: unknown = full;
  try {
    globalThis.fetch = async (url, options) => {
      const headers = options?.headers as Record<string, string>;
      assert.equal(headers["X-Kaata-Tab-Group"], "1");
      assert.equal(headers.Authorization, "Bearer session");
      if (String(url).endsWith("/capabilities"))
        return Response.json({
          multi_currency_tabs: supported,
          notification_only_tallies: true,
          one_way_tallies: true,
        });
      if (options?.method === "POST") writes++;
      else scalarReads++;
      return Response.json(reply);
    };
    supported = false;
    await assert.rejects(
      api.createTabGroup({ recording_mode: "review" } as any),
      (error: any) => error.code === "shared_account_unsupported",
    );
    assert.equal(writes, 0, "Unsupported servers receive no group mutation");
    supported = true;
    reply = { ...full, tabs: [] };
    const preview = await api.fetchTabGroupByToken(`g_${"A".repeat(43)}`);
    assert.deepEqual(
      preview.tabs,
      [],
      "Unjoined invitation preview needs no private financial records",
    );
    await assert.rejects(
      api.fetchTabGroup("group"),
      (error: any) => error.code === "shared_account_invalid",
    );
    reply = { ...full, tabs: full.tabs.slice(0, 1) };
    await assert.rejects(
      api.fetchTabGroup("group"),
      (error: any) => error.code === "shared_account_invalid",
    );
    reply = full;
    await assert.rejects(
      api.fetchTabGroup("group", { jwt: "session", recordingMode: "notify" }),
      (error: any) => error.code === "shared_account_invalid",
    );
    assert.equal((await api.fetchTabGroup("group")).tabs.length, 2);
    const auth = { jwt: "session", groupId: "group", recordingMode: "review" as const };
    supported = false;
    const beforeReads = scalarReads;
    await assert.rejects(
      api.fetchTab(auth, "leg", 0),
      (error: any) => error.code === "shared_account_unsupported",
    );
    assert.equal(
      scalarReads,
      beforeReads,
      "A rolled-back server cannot read a grouped leg as a legacy link",
    );
    supported = true;
    reply = { ...full.tabs[0], tab: { ...full.tabs[0].tab, group_id: null } };
    await assert.rejects(
      api.fetchTab(auth, "leg", 0),
      (error: any) => error.code === "shared_account_unsupported",
    );
    reply = {};
    await assert.rejects(
      api.fetchTab(auth, "leg", 0),
      (error: any) => error.code === "shared_account_unsupported",
    );
  } finally {
    globalThis.fetch = realFetch;
  }
}

async function main() {
  await apiChecks();
  {
    const f = fixture();
    f.pendingSource();
    await assert.rejects(
      f.module.linkContactGroup("person", { myLabel: "Owner" }),
      (error: any) => error.code === "shared_account_source_unsynced",
    );
    assert.equal(f.sent.length, 0);
    assert.equal(f.meta.size, 0, "A failed source preflight persists no half-created fence");
    const preview = f.seed("notify", ["AFN"]);
    preview.tabs = [];
    f.balances.set("AFN", 20);
    await assert.rejects(
      f.module.joinTabGroupAsContact(
        `g_${"A".repeat(43)}`,
        preview,
        { vaultId: "vault", personId: "person" },
        "Recipient",
      ),
      (error: any) => error.code === "shared_account_source_unsynced",
    );
    assert.equal(
      f.joinedRequests,
      0,
      "An offline/failed source push cannot cut over an unacknowledged recipient balance",
    );
    assert.equal(f.balances.get("AFN"), 20);
    assert.equal(f.meta.size, 0);
  }
  {
    const f = fixture();
    f.beforeHistory(() => f.addRecordedCurrency("GBP"));
    await assert.rejects(
      f.module.linkContactGroup("person", { myLabel: "Owner" }),
      (error: any) => error.code === "shared_account_changed",
    );
    assert.equal(f.sent.length, 0);
    assert.equal(
      f.meta.size,
      0,
      "A newly recorded currency aborts the stale source snapshot before any fence or request",
    );
  }
  {
    const f = fixture();
    f.raceSourceWrite();
    await f.module.linkContactGroup("person", { myLabel: "Owner" });
    assert.equal(((await f.competingWrite) as errors.TabApiError).code, "shared_account_pending");
    assert.equal(f.balances.get("AFN"), 100);
    assert.equal(f.sent[0].currencies[0].opening?.amount, "100");
  }
  {
    const f = fixture(),
      preview = f.seed("review", ["AFN"]);
    preview.tabs = [];
    f.balances.set("AFN", 0);
    f.raceSourceWrite();
    await f.module.joinTabGroupAsContact(
      `g_${"A".repeat(43)}`,
      preview,
      { vaultId: "vault", personId: "person" },
      "Recipient",
    );
    assert.equal(((await f.competingWrite) as errors.TabApiError).code, "shared_account_pending");
    assert.equal(f.balances.get("AFN"), 0);
  }
  for (const recordingMode of ["notify", "review", "notify_one_way"] as const) {
    const f = fixture();
    const group = await f.module.linkContactGroup("person", { myLabel: " Owner ", recordingMode });
    assert.deepEqual(group.group.currencies, ["AFN", "EUR", "USD"]);
    assert.equal(group.links.length, 3);
    assert.deepEqual(
      group.links.map((link) => link.linked_at),
      [123, 124, 125],
      "Each leg uses its own server source boundary, not group or join time",
    );
    assert.equal(f.batches.length, 1);
    assert.equal(f.notices, 1);
    assert.ok(f.pushes > 0);
    assert.match(f.sent[0].invite_token, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(f.sent[0].currencies[0].opening!.amount, "100");
    assert.equal(f.sent[0].currencies[2].opening!.direction, "b_to_a");
    assert.equal(f.sent[0].currencies[2].opening!.amount, "20");
    assert.ok([...f.meta.values()].every((value) => value === ""));
  }
  {
    const f = fixture();
    f.loseCreate();
    await assert.rejects(
      f.module.linkContactGroup("person", { myLabel: "Owner", recordingMode: "review" }),
      (error: any) => error.code === "network",
    );
    assert.equal(f.cache.size, 0);
    assert.equal(f.notices, 0);
    assert.deepEqual(await f.module.getPendingContactGroupSettings("person"), {
      myLabel: "Owner",
      recordingMode: "review",
    });
    await assert.rejects(
      f.module.linkContactGroup("person", { myLabel: "New profile name", recordingMode: "notify" }),
      (error: any) => error.code === "shared_account_changed",
    );
    f.balances.set("AFN", 999);
    f.missingLookup();
    await f.module.linkContactGroup("person", {
      myLabel: "New profile name",
      recordingMode: "review",
    });
    assert.deepEqual(
      f.sent[1],
      f.sent[0],
      "A lost response retries the same credential and opening snapshots",
    );
    assert.equal(f.notices, 1);
  }
  {
    const f = fixture(),
      pause = f.pauseCreate();
    const pending = f.module.linkContactGroup("person", { myLabel: "Owner" });
    await f.started.promise;
    f.scope("another-account");
    pause.resolve();
    await assert.rejects(pending, errors.TabAuthUnavailableError);
    assert.equal(f.cache.size, 0, "A late response cannot bind into a different account");
    assert.equal(f.notices, 0);
  }
  {
    const f = fixture();
    f.role(false);
    await assert.rejects(
      f.module.linkContactGroup("person", { myLabel: "Owner" }),
      errors.TabPermissionError,
    );
    assert.equal(f.sent.length, 0);
    assert.equal(f.meta.size, 0);
    f.role(true);
    f.support(false);
    await assert.rejects(
      f.module.linkContactGroup("person", { myLabel: "Owner" }),
      (error: any) => error.code === "shared_account_unsupported",
    );
    assert.equal(f.sent.length, 0);
    assert.equal(f.meta.size, 0);
  }
  {
    const f = fixture(),
      preview = f.seed("review", ["AFN", "USD"]);
    preview.tabs = [];
    await assert.rejects(
      f.module.joinTabGroupAsContact(
        `g_${"A".repeat(43)}`,
        preview,
        { vaultId: "vault", personId: "person" },
        "Recipient",
      ),
      (error: any) => error.code === "shared_account_currency_history",
    );
    assert.equal(f.cache.size, 0);
    assert.equal(f.balances.get("AFN"), 100);
    f.balances.set("AFN", 0);
    f.balances.set("USD", 0);
    const joined = await f.module.joinTabGroupAsContact(
      `g_${"A".repeat(43)}`,
      preview,
      { vaultId: "vault", personId: "person" },
      "Recipient",
    );
    assert.equal(joined.links.length, 2);
    assert.ok(joined.links.every((link) => link.role === "b"));
    assert.equal(f.notices, 1);
  }
  {
    const f = fixture(),
      preview = f.seed("notify", ["AFN", "USD"]);
    preview.tabs = [];
    const target = {
      vaultId: "vault",
      newPerson: { firstName: "Recipient", lastName: null, phone: null },
    };
    f.loseJoin();
    await assert.rejects(
      f.module.joinTabGroupAsContact(`g_${"A".repeat(43)}`, preview, target, "Recipient"),
    );
    f.missingLookup();
    await f.module.joinTabGroupAsContact(`g_${"A".repeat(43)}`, preview, target, "Recipient");
    assert.equal(f.createPeople, 1, "Retry reuses the first new contact instead of duplicating it");
    assert.deepEqual(
      f.joinedBodies[1],
      f.joinedBodies[0],
      "An unknown Join outcome retries its exact frozen source boundary and receipt",
    );
  }
  for (const kind of ["create", "join"] as const) {
    const f = fixture();
    const preview = kind === "join" ? f.seed("notify", ["AFN", "USD"]) : null;
    const attempt = () =>
      kind === "create"
        ? f.module.linkContactGroup("person", { myLabel: "Owner" })
        : f.module.joinTabGroupAsContact(
            `g_${"A".repeat(43)}`,
            preview!,
            { vaultId: "vault", personId: "person" },
            "Recipient",
          );
    if (kind === "create") f.loseCreate();
    else f.loseJoin();
    await assert.rejects(attempt(), (error: any) => error.code === "network");
    f.closeOnServer();
    const recovered = await attempt();
    assert.ok(
      recovered.links.every((link) => link.closed_at === 999),
      "A committed invitation that closed after a lost reply is recovered before retrying the old token",
    );
    assert.ok([...f.meta.values()].every((value) => value === ""));
    assert.equal(
      kind === "create" ? f.sent.length : f.joinedRequests,
      1,
      "Authenticated group recovery never posts the obsolete invitation again",
    );
  }
  for (const kind of ["create", "join"] as const) {
    const f = fixture();
    const preview = kind === "join" ? f.seed("notify", ["AFN"]) : null;
    const attempt = () =>
      kind === "create"
        ? f.module.linkContactGroup("person", { myLabel: "Owner" })
        : f.module.joinTabGroupAsContact(
            `g_${"A".repeat(43)}`,
            preview!,
            { vaultId: "vault", personId: "person" },
            "Recipient",
          );
    if (kind === "create") f.loseCreate();
    else f.loseJoin();
    await assert.rejects(attempt());
    const pending = [...f.meta.entries()];
    f.missingLookup();
    f.refuseRetry(kind === "create" ? "tab_closed" : "not_found", kind === "create" ? 409 : 404);
    await assert.rejects(attempt());
    assert.deepEqual(
      [...f.meta.entries()],
      pending,
      "A failed lookup and terminal old-token error cannot erase a previously ambiguous intent",
    );
    assert.equal(f.cache.size, 0);
  }
  {
    const f = fixture();
    f.refuseRetry("shared_account_changed");
    await assert.rejects(
      f.module.linkContactGroup("person", { myLabel: "Owner" }),
      (error: any) => error.code === "shared_account_changed",
    );
    assert.ok(
      [...f.meta.values()].every((value) => value === ""),
      "A fresh authoritative source refusal permits a new snapshot without discarding an ambiguous request",
    );
  }
  {
    const f = fixture(),
      first = f.seed("notify", ["AFN"]),
      second = structuredClone(first);
    second.group.id = "other-group";
    first.tabs = second.tabs = [];
    const results = await Promise.allSettled(
      [first, second].map((preview) =>
        f.module.joinTabGroupAsContact(
          `g_${"A".repeat(43)}`,
          preview,
          { vaultId: "vault", personId: "person" },
          "Recipient",
        ),
      ),
    );
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(
      f.joinedRequests,
      1,
      "Concurrent joins cannot replace the contact's frozen source or post a second invitation",
    );
  }
  {
    const f = fixture();
    await f.bind(f.seed());
    const empty = await f.module.ensureContactGroupCurrency("person", "EUR");
    assert.equal(empty?.currency, "EUR");
    assert.equal(f.ensured, 1);
    f.balances.set("USD", 4);
    await assert.rejects(
      f.module.ensureContactGroupCurrency("person", "USD"),
      (error: any) => error.code === "shared_account_currency_history",
    );
    assert.equal(f.ensured, 1, "Existing history never silently becomes a new group leg");
    const link = [...f.cache.values()][0];
    assert.equal(await f.module.regenerateTabGroupInvite(link), "https://kaata.af/t/g_new");
    await f.module.fetchContactTabGroup(link);
    assert.ok(
      f.batches.at(-1)!.every((item) => item.invite_url === null),
      "A URL-free GET never re-submits a possibly stale cached invitation URL",
    );
    assert.equal([...f.cache.values()][0].invite_url, "https://kaata.af/t/g_new");
    await f.module.unlinkTabGroup(link);
    assert.equal(f.closed, 1);
    assert.equal(f.regenerated, 1);
    assert.ok([...f.cache.values()].every((item) => item.closed_at != null));
  }
  {
    const f = fixture();
    await f.bind(f.seed("notify_one_way", ["AFN"], "b"));
    await assert.rejects(
      f.module.ensureContactGroupCurrency("person", "EUR"),
      (error: any) => error.code === "one_way_read_only",
    );
    assert.equal(f.ensured, 0);
  }
  console.log(
    "PASS multi-currency group flows: atomic cache handoff, immutable openings and modes, durable invitation retry, peer-history refusal, new-currency admission, role/session fences and group management",
  );
}
void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
