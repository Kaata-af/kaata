// Real durable latch SQL and shipped notification orchestration; native/remote
// adapters stay synthetic, and no user database, device or server is touched.
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import * as engine from "../credit-alert-policy";
import * as notifications from "../notification-policy";
import { sha256 } from "@noble/hashes/sha256";
import { Mutex } from "../util/mutex";
import { compileUI, deferred } from "./ui-fixture";
import * as observation from "../credit-alert-observation";
import * as limitWatches from "../credit-limit-notification-watches";
import { KAATA_DEFAULT_CREDIT_ID } from "../credit-policy";

const VAULT = "00000000-0000-4000-8000-000000000001";
const REL = "00000000-0000-4000-8000-000000000002";
const PERSON = "00000000-0000-4000-8000-000000000003";
const REMOTE_EVENT = "00000000-0000-4000-8000-000000000004";

function fixture() {
  const sql = new Database(":memory:");
  sql.exec(`CREATE TABLE app_meta(key TEXT PRIMARY KEY,value TEXT);
    CREATE TABLE vaults(id TEXT PRIMARY KEY,archived_at INTEGER);
    CREATE TABLE users(id TEXT PRIMARY KEY,display_name TEXT,archived_at INTEGER);
    CREATE TABLE relationships(id TEXT PRIMARY KEY,vault_id TEXT,user_b_id TEXT,archived_at INTEGER);
    CREATE TABLE customer_credit_limits(vault_id TEXT,relationship_id TEXT,currency TEXT,max_collect_minor INTEGER,max_pay_minor INTEGER,updated_at_ms INTEGER,sync_pending INTEGER DEFAULT 0,PRIMARY KEY(vault_id,relationship_id,currency));
    CREATE TABLE kaata_credit_defaults(vault_id TEXT,currency TEXT,max_collect_minor INTEGER,max_pay_minor INTEGER,updated_at_ms INTEGER,PRIMARY KEY(vault_id,currency));
    CREATE TABLE customer_credit_limit_notifications(vault_id TEXT,relationship_id TEXT,enabled INTEGER,updated_at_ms INTEGER,sync_pending INTEGER DEFAULT 0,deleted INTEGER DEFAULT 0,PRIMARY KEY(vault_id,relationship_id));
    INSERT INTO users VALUES('${PERSON}','Sensitive customer',NULL);
    INSERT INTO vaults VALUES('${VAULT}',NULL);
    INSERT INTO relationships VALUES('${REL}','${VAULT}','${PERSON}',NULL);`);
  const tx = {
    getFirstAsync: async (query: string, ...args: any[]) => sql.prepare(query).get(...args) ?? null,
    getAllAsync: async (query: string, ...args: any[]) => sql.prepare(query).all(...args),
    runAsync: async (query: string, ...args: any[]) => sql.prepare(query).run(...args),
    withTransactionAsync: async (work: () => Promise<void>) => {
      sql.exec("BEGIN");
      try {
        await work();
        sql.exec("COMMIT");
      } catch (error) {
        sql.exec("ROLLBACK");
        throw error;
      }
    },
  };
  let owner = "account:a",
    role = "owner",
    readable = true,
    platform = "android",
    expoGo = false;
  let revision = 0,
    foreground = "background",
    remote = false,
    remoteLimits = false,
    permission = true;
  let binding = 1,
    lookupStatus = 200;
  let lookupGate: ReturnType<typeof deferred<void>> | null = null;
  let lookupDetails: any = {
    kind: "credit_alert",
    owner_scope: "account:a",
    vault_id: VAULT,
    relationship_id: REL,
    person_id: PERSON,
    direction: "collect",
    event_key: REMOTE_EVENT,
    policy_updated_at_ms: 1,
  };
  const lookups: any[] = [];
  const syncCalls: string[] = [];
  const registrationForces: boolean[] = [];
  let onPull: (() => void) | null = null;
  let onRefresh: (() => void) | null = null;
  let notificationPolicy = notifications.defaultNotificationPolicy();
  let groups: engine.CreditAlertGroup[] = [
    { direction: "collect", conditions: [{ currency: "USD", threshold_minor: 1000000 }] },
    {
      direction: "collect",
      conditions: [
        { currency: "USD", threshold_minor: 500000 },
        { currency: "AFN", threshold_minor: 10000000 },
      ],
    },
  ];
  let vector: Record<string, number | null> = { USD: 0, AFN: 0 };
  let customers = true,
    syncPending = false;
  const scheduled: any[] = [],
    dismissed: string[] = [],
    cancelled: string[] = [],
    routes: any[] = [];
  const tray = new Map<string, any>();
  const channels: any[] = [];
  const ledger = new Set<() => void>(),
    tabs = new Set<() => void>(),
    policies = new Set<() => void>(),
    preferences = new Set<() => void>(),
    identities = new Set<() => void>(),
    locale = new Set<() => void>();
  const states = new Set<(state: string) => void>();
  const timers = new Map<number, () => void>();
  let timerSeq = 0;
  let scheduledGate: ReturnType<typeof deferred<void>> | null = null;
  let deviceGate: ReturnType<typeof deferred<void>> | null = null;
  let registrationGate: ReturnType<typeof deferred<void>> | null = null;
  const policy = () => ({ relationship_id: REL, groups, updated_at_ms: 1 });
  const customerRows = () =>
    customers
      ? [
          {
            vault_id: VAULT,
            relationship_id: REL,
            person_id: PERSON,
            policy: policy(),
            sync_pending: syncPending,
          },
        ]
      : [];
  const listen = (set: Set<any>) => (fn: any) => {
    set.add(fn);
    return () => set.delete(fn);
  };
  const n = {
    AndroidImportance: { DEFAULT: 3 },
    IosAuthorizationStatus: { PROVISIONAL: 3 },
    getPermissionsAsync: async () => ({ granted: permission }),
    requestPermissionsAsync: async () => {
      throw new Error("monitor must never prompt");
    },
    getPresentedNotificationsAsync: async () => [...tray.values()],
    dismissNotificationAsync: async (id: string) => {
      dismissed.push(id);
      tray.delete(id);
    },
    cancelScheduledNotificationAsync: async (id: string) => {
      cancelled.push(id);
    },
    setNotificationChannelAsync: async (...args: any[]) => {
      channels.push(args);
    },
    scheduleNotificationAsync: async (request: any) => {
      scheduled.push(request);
      tray.set(request.identifier, { request });
      if (scheduledGate) await scheduledGate.promise;
      return request.identifier;
    },
  };
  const service = compileUI(
    "../credit-alert-notifications",
    {
      expo: { isRunningInExpoGo: () => expoGo },
      "react-native": {
        AppState: {
          get currentState() {
            return foreground;
          },
          addEventListener: (_: string, fn: any) => {
            states.add(fn);
            return { remove: () => states.delete(fn) };
          },
        },
        Platform: {
          get OS() {
            return platform;
          },
        },
      },
      "@noble/hashes/sha256": { sha256 },
      "./db-tx": {
        getDb: async () => tx,
        getInstallIdSync: () => "installation",
        getSessionAccountIdSync: () => (owner.startsWith("account:") ? owner.slice(8) : null),
        onAccountIdentityChanged: listen(identities),
        setActiveVaultId: async () => {},
      },
      "./customer-reminders": { canReadReminderVault: async () => readable },
      "./reminder-device": {
        getReminderDeviceId: async () => {
          if (deviceGate) await deviceGate.promise;
          return "private-device";
        },
      },
      "./credit-alerts": {
        listEffectiveCreditAlertCustomers: async () => customerRows(),
        readEffectiveCreditAlertPolicy: async () => (customers ? policy() : null),
        creditAlertBalancesInTx: async () => vector,
        refreshCreditAlerts: async () => {
          syncCalls.push("refresh");
          onRefresh?.();
        },
      },
      "./credit-alert-policy": engine,
      "./credit-limit-notification-watches": limitWatches,
      "./credit-limits": {
        refreshCreditPolicies: async () => {
          syncCalls.push("refreshLimits");
          onRefresh?.();
        },
      },
      "./credit-alert-observation": observation,
      "./credit-policy-events": { onCreditPoliciesChanged: listen(policies) },
      "./ledger-events": { onLedgerApplied: listen(ledger) },
      "./tabs/events": { onTabApplied: listen(tabs) },
      "./notification-preferences": {
        notificationOwnerScope: () => owner,
        notificationPolicyForContact: async () => notificationPolicy,
        notificationPreferencesRevision: () => revision,
        onNotificationPreferencesChanged: listen(preferences),
      },
      "./notification-policy": notifications,
      "./i18n": {
        getLocale: () => "en",
        subscribeLocale: listen(locale),
        t: (key: string, values?: { name?: string; currency?: string }) =>
          values
            ? `${key}:${values.name ?? ""}${values.currency ? `:${values.currency}` : ""}`
            : key,
      },
      "./use-vault-role": { readVaultRole: async () => role },
      "./api": { getBackendUrl: async () => "https://synthetic.invalid" },
      "./auth": {
        captureCurrentSession: async () => ({
          accountId: owner.startsWith("account:") ? owner.slice(8) : null,
          jwt: owner.startsWith("account:") ? "synthetic-jwt" : null,
          bindingVersion: binding,
        }),
      },
      "./credit-alert-push": {
        syncCreditAlertPushSubscriptions: async (force = false) => {
          registrationForces.push(force);
          if (registrationGate) await registrationGate.promise;
        },
        creditAlertRemoteDeliveryActive: async (_vault: string, source?: string) =>
          source === "limit" ? remoteLimits : remote,
      },
      "./projection": { applyEventMutex: new Mutex() },
      "expo-notifications": n,
      "./currency": {
        applyVaultCurrency: async () => {},
        getCurrencyLabel: (code: string) => code,
      },
      "./sync/pull": {
        pullEvents: async () => {
          syncCalls.push("pull");
          onPull?.();
        },
      },
      "./recovery": {
        recoverJoinedVault: async () => {
          syncCalls.push("recover");
          sql.prepare("INSERT OR IGNORE INTO vaults VALUES(?,NULL)").run(VAULT);
        },
      },
      "expo-router": { router: { push: (route: any) => routes.push(route) } },
    },
    {
      setTimeout: (work: () => void) => {
        const id = ++timerSeq;
        timers.set(id, work);
        return id;
      },
      clearTimeout: (id: number) => timers.delete(id),
      fetch: async (url: string, options: any) => {
        lookups.push({ url, options });
        if (lookupGate) await lookupGate.promise;
        return { ok: lookupStatus === 200, json: async () => ({ ...lookupDetails }) };
      },
    },
  ) as typeof import("../credit-alert-notifications");
  return {
    sql,
    tx,
    service,
    scheduled,
    dismissed,
    cancelled,
    routes,
    channels,
    tray,
    lookups,
    syncCalls,
    registrationForces,
    setPullHook: (value: typeof onPull) => {
      onPull = value;
    },
    setRefreshHook: (value: typeof onRefresh) => {
      onRefresh = value;
    },
    setLookupStatus: (value: number) => {
      lookupStatus = value;
    },
    setLookupDetails: (value: any) => {
      lookupDetails = value;
    },
    setLookupGate: (value: typeof lookupGate) => {
      lookupGate = value;
    },
    setBalance: (values: typeof vector) => {
      vector = values;
    },
    setGroups: (values: typeof groups) => {
      groups = values;
    },
    setPolicy: (values: Partial<typeof notificationPolicy>) => {
      notificationPolicy = { ...notificationPolicy, ...values };
      revision++;
    },
    setOwner: (value: string) => {
      owner = value;
      binding++;
      for (const fn of identities) fn();
    },
    setRole: (value: string) => {
      role = value;
    },
    setReadable: (value: boolean) => {
      readable = value;
    },
    setPermission: (value: boolean) => {
      permission = value;
    },
    setRemote: (value: boolean) => {
      remote = value;
    },
    setRemoteLimits: (value: boolean) => {
      remoteLimits = value;
    },
    setLimitNotifications: (
      enabled: boolean,
      options: { default?: boolean; pending?: boolean; revision?: number } = {},
    ) => {
      sql
        .prepare(
          `INSERT INTO customer_credit_limit_notifications VALUES(?,?,?,?,?,0)
        ON CONFLICT(vault_id,relationship_id) DO UPDATE SET enabled=excluded.enabled,updated_at_ms=excluded.updated_at_ms,sync_pending=excluded.sync_pending,deleted=0`,
        )
        .run(
          VAULT,
          options.default ? KAATA_DEFAULT_CREDIT_ID : REL,
          Number(enabled),
          options.revision ?? 1,
          Number(!!options.pending),
        );
    },
    setCap: (
      currency: string,
      collect: number | null,
      pay: number | null,
      options: { default?: boolean; pending?: boolean; revision?: number } = {},
    ) => {
      if (options.default)
        sql
          .prepare(
            `INSERT INTO kaata_credit_defaults VALUES(?,?,?,?,?)
        ON CONFLICT(vault_id,currency) DO UPDATE SET max_collect_minor=excluded.max_collect_minor,max_pay_minor=excluded.max_pay_minor,updated_at_ms=excluded.updated_at_ms`,
          )
          .run(VAULT, currency, collect, pay, options.revision ?? 1);
      else
        sql
          .prepare(
            `INSERT INTO customer_credit_limits VALUES(?,?,?,?,?,?,?)
        ON CONFLICT(vault_id,relationship_id,currency) DO UPDATE SET max_collect_minor=excluded.max_collect_minor,max_pay_minor=excluded.max_pay_minor,updated_at_ms=excluded.updated_at_ms,sync_pending=excluded.sync_pending`,
          )
          .run(
            VAULT,
            REL,
            currency,
            collect,
            pay,
            options.revision ?? 1,
            Number(!!options.pending),
          );
    },
    setPending: (value: boolean) => {
      syncPending = value;
    },
    setCustomers: (value: boolean) => {
      customers = value;
    },
    setForeground: (value: string) => {
      foreground = value;
    },
    setExpoGo: (value: boolean) => {
      expoGo = value;
    },
    setPlatform: (value: string) => {
      platform = value;
    },
    setScheduleGate: (value: typeof scheduledGate) => {
      scheduledGate = value;
    },
    setDeviceGate: (value: typeof deviceGate) => {
      deviceGate = value;
    },
    setRegistrationGate: (value: typeof registrationGate) => {
      registrationGate = value;
    },
    emitLedger: () => {
      for (const fn of ledger) fn();
    },
    emitTabs: () => {
      for (const fn of tabs) fn();
    },
    emitPolicies: () => {
      for (const fn of policies) fn();
    },
    timerCount: () => timers.size,
    flushTimers: async () => {
      for (const fn of [...timers.values()]) fn();
      timers.clear();
      await service.reconcileCreditAlertNotifications();
    },
  };
}

async function independentLimitChecks() {
  const f = fixture();
  f.setGroups([]);
  f.setLimitNotifications(true);
  f.setCap("USD", 1000, 2000);
  f.setCap("AFN", 5000, 10000);
  await f.service.reconcileCreditAlertNotifications();
  f.setBalance({ USD: 1000, AFN: 0 });
  await f.service.reconcileCreditAlertNotifications();
  assert.equal(f.scheduled.length, 1, "An exact ordinary collect cap triggers once");
  assert.equal(f.scheduled[0].content.data.limit_currency, "USD");
  assert.equal(f.scheduled[0].content.data.direction, "collect");
  assert.doesNotMatch(f.scheduled[0].content.body, /USD/, "Names-only previews omit currency");
  await f.service.openCreditAlertNotification(f.scheduled[0].content.data);
  assert.equal(f.routes[0].params.id, PERSON);
  f.setPolicy({ previews: "full" });
  f.setBalance({ USD: 1500, AFN: 5000 });
  await f.service.reconcileCreditAlertNotifications();
  assert.equal(f.scheduled.length, 2, "AFN can cross while USD remains above its cap");
  assert.equal(f.scheduled[1].content.data.limit_currency, "AFN");
  assert.match(f.scheduled[1].content.body, /limitCollectNamed.*AFN/);
  f.setBalance({ USD: 2000, AFN: 6000 });
  await f.service.reconcileCreditAlertNotifications();
  assert.equal(f.scheduled.length, 2, "Additional money above either cap does not repeat alerts");
  f.setBalance({ USD: -2000, AFN: -10000 });
  await f.service.reconcileCreditAlertNotifications();
  assert.equal(
    f.scheduled.length,
    4,
    "Both pay episodes are independent of collect and each other",
  );
  assert.deepEqual(
    f.scheduled.slice(2).map((n) => n.content.data.direction),
    ["pay", "pay"],
  );
  f.setLimitNotifications(false);
  await f.service.reconcileCreditAlertNotifications();
  assert.equal(await f.service.creditAlertNoticeAllowed(f.scheduled[3].content.data), false);
  f.setLimitNotifications(true, { revision: 2 });
  await f.service.reconcileCreditAlertNotifications();
  assert.equal(
    f.scheduled.length,
    4,
    "Turning on notifications quietly baselines existing exposure",
  );
  f.setBalance({ USD: 0, AFN: 0 });
  await f.service.reconcileCreditAlertNotifications();
  f.setBalance({ USD: 0, AFN: -10000 });
  await f.service.reconcileCreditAlertNotifications();
  assert.equal(f.scheduled.length, 5, "A cleared currency limit can notify again");
  f.setCap("AFN", 5000, 9000, { revision: 3 });
  await f.service.reconcileCreditAlertNotifications();
  assert.equal(f.scheduled.length, 5, "Editing a cap does not replay its current exposure");
  assert.equal(await f.service.creditAlertNoticeAllowed(f.scheduled[4].content.data), false);

  const inherited = fixture();
  inherited.setGroups([]);
  inherited.setLimitNotifications(true, { default: true });
  inherited.setCap("USD", 0, null, { default: true });
  inherited.setCap("AUD", 700, null, { default: true });
  let watches = await limitWatches.listCreditLimitNotificationWatches(inherited.tx as any);
  assert.deepEqual(
    watches.map((watch) => watch.limit_currency),
    ["AUD", "USD"],
  );
  assert.equal(watches[1].policy.groups[0].conditions[0].threshold_minor, 1);
  inherited.setCap("AUD", null, null);
  watches = await limitWatches.listCreditLimitNotificationWatches(inherited.tx as any);
  assert.deepEqual(
    watches.map((watch) => watch.limit_currency),
    ["USD"],
    "Explicit unlimited caps override defaults",
  );
  await inherited.service.reconcileCreditAlertNotifications();
  assert.equal(inherited.scheduled.length, 0, "A zero cap does not alert a settled account");
  inherited.setBalance({ USD: 1, AFN: 0 });
  await inherited.service.reconcileCreditAlertNotifications();
  assert.equal(inherited.scheduled.length, 1, "A zero cap alerts on the first positive minor unit");
  inherited.setLimitNotifications(false);
  assert.deepEqual(
    await limitWatches.listCreditLimitNotificationWatches(inherited.tx as any),
    [],
    "An explicit off switch overrides default notifications",
  );

  const transport = fixture();
  transport.setGroups([]);
  transport.setRemote(true);
  transport.setLimitNotifications(true);
  transport.setCap("USD", 1000, null);
  await transport.service.reconcileCreditAlertNotifications();
  transport.setBalance({ USD: 1000, AFN: 0 });
  await transport.service.reconcileCreditAlertNotifications();
  assert.equal(
    transport.scheduled.length,
    1,
    "An older server's combined lease does not suppress cap alerts",
  );
  transport.setRemoteLimits(true);
  transport.setBalance({ USD: 0, AFN: 0 });
  await transport.service.reconcileCreditAlertNotifications();
  transport.setBalance({ USD: 1000, AFN: 0 });
  await transport.service.reconcileCreditAlertNotifications();
  assert.equal(
    transport.scheduled.length,
    1,
    "A capable server owns synced cap notification delivery",
  );
  transport.setCap("USD", 1000, null, { pending: true });
  transport.setBalance({ USD: 0, AFN: 0 });
  await transport.service.reconcileCreditAlertNotifications();
  transport.setBalance({ USD: 1000, AFN: 0 });
  await transport.service.reconcileCreditAlertNotifications();
  assert.equal(transport.scheduled.length, 2, "An unpublished cap retains local delivery fallback");
  transport.setCap("USD", 1000, null);
  transport.setLimitNotifications(true, { pending: true });
  transport.setBalance({ USD: 0, AFN: 0 });
  await transport.service.reconcileCreditAlertNotifications();
  transport.setBalance({ USD: 1000, AFN: 0 });
  await transport.service.reconcileCreditAlertNotifications();
  assert.equal(
    transport.scheduled.length,
    3,
    "An unpublished notification switch retains local fallback",
  );

  const reset = fixture();
  reset.setGroups([]);
  reset.setRemoteLimits(true);
  reset.setLimitNotifications(true, { default: true });
  reset.setLimitNotifications(false);
  reset.setCap("USD", 1000, null);
  await reset.service.reconcileCreditAlertNotifications();
  reset.sql
    .prepare(
      "UPDATE customer_credit_limit_notifications SET deleted=1,sync_pending=1 WHERE vault_id=? AND relationship_id=?",
    )
    .run(VAULT, REL);
  const resetWatches = await limitWatches.listCreditLimitNotificationWatches(reset.tx as any);
  assert.equal(resetWatches.length, 1, "An offline reset inherits the enabled Kaata default");
  assert.equal(
    resetWatches[0].sync_pending,
    true,
    "The pending reset remains unpublished even though its default is synced",
  );
  await reset.service.reconcileCreditAlertNotifications();
  reset.setBalance({ USD: 1000, AFN: 0 });
  await reset.service.reconcileCreditAlertNotifications();
  assert.equal(
    reset.scheduled.length,
    1,
    "A pending reset retains local crossing delivery until the server knows it",
  );

  const remote = fixture();
  remote.setGroups([]);
  remote.setLimitNotifications(true);
  remote.setCap("USD", 1000, null);
  remote.setLookupDetails({
    kind: "credit_alert",
    owner_scope: "account:a",
    vault_id: VAULT,
    relationship_id: REL,
    person_id: PERSON,
    direction: "collect",
    limit_currency: "USD",
    event_key: REMOTE_EVENT,
    policy_updated_at_ms: 1,
  });
  await remote.service.openCreditAlertNotification({
    kind: "credit_alert",
    event_key: REMOTE_EVENT,
  });
  assert.deepEqual(
    remote.syncCalls,
    ["pull", "refreshLimits"],
    "Cap notification taps refresh caps and their switch",
  );
  assert.equal(remote.routes[0].params.id, PERSON);
  remote.setLimitNotifications(false);
  await remote.service.openCreditAlertNotification({
    kind: "credit_alert",
    event_key: REMOTE_EVENT,
  });
  assert.equal(remote.routes.length, 1, "Turning off cap alerts invalidates old remote notices");

  const legacy = fixture();
  legacy.sql.exec("DROP TABLE customer_credit_limit_notifications");
  await legacy.service.reconcileCreditAlertNotifications();
  legacy.setBalance({ USD: 1000000, AFN: 0 });
  await legacy.service.reconcileCreditAlertNotifications();
  assert.equal(
    legacy.scheduled.length,
    1,
    "An older open schema still delivers existing combined alerts",
  );
  await assert.rejects(
    limitWatches.listCreditLimitNotificationWatches({
      getAllAsync: async () => {
        throw Error("disk error");
      },
    } as any),
    /disk error/,
  );
  console.log(
    "PASS ordinary credit notifications: independent currency/direction episodes, inclusive/zero caps, inherited/off/unlimited rules, edit baselines, privacy, transport fallback and guarded taps",
  );
}

async function main() {
  await independentLimitChecks();
  const f = fixture();
  await f.service.reconcileCreditAlertNotifications();
  f.setBalance({ USD: 500000, AFN: 10000000 });
  await f.service.reconcileCreditAlertNotifications();
  assert.equal(f.scheduled.length, 1, "inclusive AND crossing delivers once");
  const notice = f.scheduled[0];
  assert.match(notice.content.body, /Sensitive customer/);
  assert.ok(
    !JSON.stringify(notice.content.data).includes("Sensitive customer"),
    "payload stays opaque",
  );
  assert.ok(f.channels.length > 0);
  await f.service.openCreditAlertNotification(notice.content.data);
  assert.equal(f.routes[0].params.id, PERSON);
  f.setBalance({ USD: 1000000, AFN: 10000000 });
  await f.service.reconcileCreditAlertNotifications();
  assert.equal(f.scheduled.length, 1, "another matching OR branch does not notify twice");
  f.setBalance({ USD: null, AFN: null });
  await f.service.reconcileCreditAlertNotifications();
  f.setBalance({ USD: 1000000, AFN: 0 });
  await f.service.reconcileCreditAlertNotifications();
  assert.equal(f.scheduled.length, 1, "unknown does not rearm");
  f.setBalance({ USD: 499999, AFN: null });
  await f.service.reconcileCreditAlertNotifications();
  f.setBalance({ USD: 1000000, AFN: null });
  await f.service.reconcileCreditAlertNotifications();
  assert.equal(
    f.scheduled.length,
    2,
    "known false AND terms clear the whole expression despite unknown AFN",
  );
  assert.notEqual(f.scheduled[0].identifier, f.scheduled[1].identifier);
  await f.service.openCreditAlertNotification(notice.content.data);
  assert.equal(f.routes.length, 1, "stale episode cannot navigate");
  const beforeRestart = f.scheduled.length;
  await f.service.reconcileCreditAlertNotifications();
  assert.equal(f.scheduled.length, beforeRestart, "durable matched state does not repeat");

  const quiet = fixture();
  quiet.setBalance({ USD: 1000000, AFN: 0 });
  await quiet.service.reconcileCreditAlertNotifications();
  assert.equal(quiet.scheduled.length, 0, "first above-threshold observation is a quiet baseline");
  quiet.setGroups([
    { direction: "collect", conditions: [{ currency: "USD", threshold_minor: 900000 }] },
  ]);
  await quiet.service.reconcileCreditAlertNotifications();
  assert.equal(quiet.scheduled.length, 0, "configuration changes also baseline quietly");
  quiet.setBalance({ USD: 0, AFN: 0 });
  await quiet.service.reconcileCreditAlertNotifications();
  quiet.setPolicy({ credit_alerts: false });
  quiet.setBalance({ USD: 1000000, AFN: 0 });
  await quiet.service.reconcileCreditAlertNotifications();
  quiet.setPolicy({ credit_alerts: true });
  await quiet.service.reconcileCreditAlertNotifications();
  assert.equal(quiet.scheduled.length, 0, "unmuting never floods historical crossings");
  quiet.setBalance({ USD: 0, AFN: 0 });
  await quiet.service.reconcileCreditAlertNotifications();
  quiet.setPermission(false);
  quiet.setBalance({ USD: 1000000, AFN: 0 });
  await quiet.service.reconcileCreditAlertNotifications();
  quiet.setPermission(true);
  await quiet.service.reconcileCreditAlertNotifications();
  assert.equal(quiet.scheduled.length, 0, "granting OS permission does not replay a crossing");

  for (const blocked of ["viewer", "clerk", "editor"]) {
    const denied = fixture();
    denied.setRole(blocked);
    await denied.service.reconcileCreditAlertNotifications();
    denied.setBalance({ USD: 1000000, AFN: 0 });
    await denied.service.reconcileCreditAlertNotifications();
    assert.equal(denied.scheduled.length, 0, `${blocked} receives no owner-risk notification`);
    assert.equal(
      (denied.sql.prepare("SELECT COUNT(*) AS n FROM app_meta").get() as { n: number }).n,
      0,
    );
  }
  const cloud = fixture();
  cloud.setRemote(true);
  await cloud.service.reconcileCreditAlertNotifications();
  cloud.setBalance({ USD: 1000000, AFN: 0 });
  await cloud.service.reconcileCreditAlertNotifications();
  assert.equal(cloud.scheduled.length, 0, "server transport suppresses local duplicates");
  cloud.setBalance({ USD: 0, AFN: 0 });
  await cloud.service.reconcileCreditAlertNotifications();
  cloud.setPending(true);
  cloud.setBalance({ USD: 1000000, AFN: 0 });
  await cloud.service.reconcileCreditAlertNotifications();
  assert.equal(cloud.scheduled.length, 1, "unpublished local policy still has local fallback");

  const offline = fixture();
  const registration = deferred<void>();
  offline.setRegistrationGate(registration);
  await offline.service.reconcileCreditAlertNotifications();
  offline.setBalance({ USD: 1000000, AFN: 0 });
  await offline.service.reconcileCreditAlertNotifications();
  assert.equal(
    offline.scheduled.length,
    1,
    "pending token/registration network never blocks local observation or delivery",
  );
  registration.resolve();

  const privateNotice = fixture();
  privateNotice.setPolicy({ previews: "private" });
  await privateNotice.service.reconcileCreditAlertNotifications();
  privateNotice.setBalance({ USD: 1000000, AFN: 0 });
  await privateNotice.service.reconcileCreditAlertNotifications();
  assert.equal(privateNotice.scheduled[0].content.body, "notificationSettings.alert.private");
  privateNotice.setReadable(false);
  await privateNotice.service.reconcileCreditAlertNotifications();
  assert.ok(
    privateNotice.dismissed.includes(privateNotice.scheduled[0].identifier),
    "revocation dismisses shown private alerts",
  );
  await privateNotice.service.openCreditAlertNotification(privateNotice.scheduled[0].content.data);
  assert.equal(privateNotice.routes.length, 0);

  const race = fixture();
  const stop = race.service.startCreditAlertNotifications();
  race.emitLedger();
  race.emitTabs();
  assert.equal(race.timerCount(), 1, "ledger/tab bursts coalesce");
  await race.flushTimers();
  assert.ok(
    race.registrationForces.every((force) => !force),
    "Ordinary ledger observations keep transport registration throttled",
  );
  race.emitPolicies();
  assert.equal(
    race.registrationForces.at(-1),
    true,
    "Changing a limit or its notification switch immediately refreshes remote capability",
  );
  assert.equal(
    race.timerCount(),
    1,
    "The forced registration also schedules a single local observation",
  );
  await race.flushTimers();
  race.setBalance({ USD: 1000000, AFN: 0 });
  const gate = deferred<void>();
  race.setScheduleGate(gate);
  const pending = race.service.reconcileCreditAlertNotifications();
  for (let i = 0; i < 100 && race.scheduled.length === 0; i++)
    await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(race.scheduled.length, 1);
  race.setOwner("account:b");
  gate.resolve();
  await pending;
  assert.ok(
    race.dismissed.includes(race.scheduled[0].identifier),
    "account switch retracts a native request already in flight",
  );
  assert.ok(race.cancelled.length > 0);
  stop();
  assert.equal(race.timerCount(), 0);

  const directional = fixture();
  directional.setGroups([
    { direction: "collect", conditions: [{ currency: "USD", threshold_minor: 1000000 }] },
    { direction: "pay", conditions: [{ currency: "AFN", threshold_minor: 10000000 }] },
  ]);
  await directional.service.reconcileCreditAlertNotifications();
  directional.setBalance({ USD: 1000000, AFN: -10000000 });
  await directional.service.reconcileCreditAlertNotifications();
  assert.deepEqual(
    directional.scheduled.map((row) => row.content.data.direction).sort(),
    ["collect", "pay"],
    "collect and pay have independent crossing latches",
  );
  assert.equal(
    notifications.notificationAllowed(
      { ...notifications.defaultNotificationPolicy(), connections: false },
      "credit_alert",
    ),
    true,
    "credit category is independent from connection notices",
  );

  const resolved = fixture();
  const opaque = { kind: "credit_alert", event_key: REMOTE_EVENT };
  const details = await resolved.service.resolveCreditAlertNotificationData(opaque);
  assert.equal(details?.person_id, PERSON);
  assert.equal(resolved.lookups.length, 1);
  assert.match(
    resolved.lookups[0].url,
    /credit-alerts\/events\/00000000-0000-4000-8000-000000000004$/,
  );
  assert.equal(resolved.lookups[0].options.headers.Authorization, "Bearer synthetic-jwt");
  assert.equal(
    resolved.lookups[0].options.body,
    undefined,
    "opaque lookup sends no financial metadata",
  );
  assert.equal(await resolved.service.creditAlertNoticeAllowed(details), true);
  assert.equal(
    resolved.lookups.length,
    1,
    "one resolved object is reused only within its bound current session",
  );
  await resolved.service.openCreditAlertNotification(details);
  assert.equal(resolved.routes[0].params.id, PERSON);
  assert.deepEqual(
    resolved.syncCalls,
    ["pull", "refresh"],
    "remote taps refresh target ledger and rules before local gates",
  );
  resolved.setLookupStatus(404);
  assert.equal(
    await resolved.service.resolveCreditAlertNotificationData(opaque),
    null,
    "stale or unauthorized server event cannot resolve",
  );
  resolved.setOwner("local:installation");
  const lookupCount = resolved.lookups.length;
  assert.equal(await resolved.service.resolveCreditAlertNotificationData(opaque), null);
  assert.equal(
    resolved.lookups.length,
    lookupCount,
    "signed-out payload cannot request another account's details",
  );
  const lookupRace = fixture();
  const responseGate = deferred<void>();
  lookupRace.setLookupGate(responseGate);
  const lookup = lookupRace.service.resolveCreditAlertNotificationData(opaque);
  for (let i = 0; i < 100 && lookupRace.lookups.length === 0; i++)
    await new Promise<void>((resolve) => setImmediate(resolve));
  lookupRace.setOwner("account:b");
  lookupRace.setOwner("account:a");
  responseGate.resolve();
  assert.equal(
    await lookup,
    null,
    "an account round trip cannot revive a stale authenticated response",
  );
  const cold = fixture();
  cold.sql.prepare("DELETE FROM vaults").run();
  cold.sql.prepare("DELETE FROM relationships").run();
  cold.setCustomers(false);
  cold.setPullHook(() => {
    cold.sql
      .prepare("INSERT OR IGNORE INTO relationships VALUES(?,?,?,NULL)")
      .run(REL, VAULT, PERSON);
  });
  cold.setRefreshHook(() => cold.setCustomers(true));
  await cold.service.openCreditAlertNotification(opaque);
  assert.deepEqual(cold.syncCalls, ["recover", "pull", "refresh"]);
  assert.equal(
    cold.routes[0].params.id,
    PERSON,
    "cold tap recovers a newly authorized customer and rule",
  );
  cold.setGroups([]);
  await cold.service.openCreditAlertNotification(opaque);
  assert.equal(
    cold.routes.length,
    1,
    "an explicit pending local off policy still prevents navigation from the old alert",
  );
  const restoring = fixture();
  const stopRestoring = restoring.service.startCreditAlertNotifications();
  await restoring.flushTimers();
  const endRestore = observation.beginCreditAlertRestore();
  restoring.setBalance({ USD: 1000000, AFN: 0 });
  await restoring.service.reconcileCreditAlertNotifications();
  assert.equal(restoring.scheduled.length, 0, "partial restore state cannot deliver alerts");
  restoring.sql.prepare("DELETE FROM app_meta WHERE key LIKE 'credit_alert_latch:v1:%'").run();
  endRestore();
  endRestore();
  assert.equal(restoring.timerCount(), 1, "restore completion schedules one quiet fresh baseline");
  await restoring.flushTimers();
  assert.equal(
    restoring.scheduled.length,
    0,
    "completed restore baselines its full replay quietly",
  );
  assert.equal(observation.creditAlertObservationPaused(), false);
  stopRestoring();
  console.log(
    "PASS combined credit notifications: durable directional crossing state, quiet baseline, unknown/rearm, mute/permission privacy, owner authority, remote dedup, guarded tap and account race",
  );
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
