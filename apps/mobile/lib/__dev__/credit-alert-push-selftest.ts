// Real account/device/vault cache SQL with synthetic HTTPS, token and native
// permission adapters. Never registers a real device or contacts a server.
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { defaultNotificationPolicy } from "../notification-policy";
import { Mutex } from "../util/mutex";
import { compileUI, deferred } from "./ui-fixture";
import * as observation from "../credit-alert-observation";

function fixture() {
  const sql = new Database(":memory:");
  sql.exec(`CREATE TABLE app_meta(key TEXT PRIMARY KEY,value TEXT);
    CREATE TABLE vaults(id TEXT PRIMARY KEY,archived_at INTEGER);
    CREATE TABLE users(id TEXT PRIMARY KEY,archived_at INTEGER);
    CREATE TABLE relationships(id TEXT PRIMARY KEY,vault_id TEXT,user_b_id TEXT,archived_at INTEGER);
    INSERT INTO vaults VALUES('v1',NULL),('v2',NULL),('archived',1);
    INSERT INTO users VALUES('p',NULL),('removed',1);
    INSERT INTO relationships VALUES('r1','v1','p',NULL),('r2','v2','p',NULL),('gone','v1','removed',NULL);`);
  const db = {
    getFirstAsync: async (query: string, ...args: any[]) => sql.prepare(query).get(...args) ?? null,
    getAllAsync: async (query: string, ...args: any[]) => sql.prepare(query).all(...args),
    runAsync: async (query: string, ...args: any[]) => sql.prepare(query).run(...args),
  };
  let account: string | null = "account-a",
    binding = 1,
    install = "install-a",
    device = "private-a";
  let revision = 0,
    locale = "en",
    now = 100000,
    status = 200,
    enabled: unknown = true,
    granted = true;
  let responseGate: ReturnType<typeof deferred<void>> | null = null;
  let policy = defaultNotificationPolicy();
  const contactOverrides = new Map<string, Partial<typeof policy>>();
  const roles = new Map([
    ["v1", "owner"],
    ["v2", "viewer"],
  ]);
  const unreadable = new Set<string>();
  const requests: any[] = [];
  let tokenReads = 0;
  const module = compileUI(
    "../credit-alert-push",
    {
      expo: { isRunningInExpoGo: () => false },
      "expo-constants": {
        __esModule: true,
        default: { easConfig: { projectId: "synthetic-project" } },
      },
      "./api": { getBackendUrl: async () => "https://synthetic.invalid" },
      "./auth": {
        captureCurrentSession: async () => ({
          accountId: account,
          bindingVersion: binding,
          jwt: account ? "synthetic-jwt" : null,
        }),
        applyForCurrentSession: async (snapshot: any, work: () => Promise<void>) => {
          if (snapshot.accountId !== account || snapshot.bindingVersion !== binding)
            throw new Error("session changed");
          await work();
        },
      },
      "./customer-reminders": {
        canReadReminderVault: async (_db: any, vault: string) => !unreadable.has(vault),
      },
      "./db-tx": { getDb: async () => db, getInstallIdSync: () => install },
      "./i18n": { getLocale: () => locale },
      "./notification-preferences": {
        notificationOwnerScope: () => (account ? `account:${account}` : "local:installation"),
        notificationPreferencesRevision: () => revision,
        notificationPolicyForContact: async (contact?: { personId: string }) =>
          contact ? { ...policy, ...contactOverrides.get(contact.personId) } : policy,
      },
      "./reminder-device": { getReminderDeviceId: async () => device },
      "./use-vault-role": { readVaultRole: async (vault: string) => roles.get(vault) },
      "./credit-alert-observation": observation,
      "./projection": { applyEventMutex: new Mutex() },
      "expo-notifications": {
        getPermissionsAsync: async () => ({ granted }),
        IosAuthorizationStatus: { PROVISIONAL: 3 },
        requestPermissionsAsync: async () => {
          throw new Error("startup must not request permission");
        },
        getExpoPushTokenAsync: async () => {
          tokenReads++;
          return { data: "synthetic-token" };
        },
      },
    },
    {
      Date: { now: () => now },
      fetch: async (url: string, options: any) => {
        requests.push({ url, body: JSON.parse(options.body), headers: options.headers });
        if (responseGate) await responseGate.promise;
        return {
          ok: status === 200,
          status,
          json: async () => ({
            remote_delivery_enabled: enabled,
            remote_delivery_lease_ms: 30 * 24 * 3600_000,
          }),
        };
      },
    },
  ) as typeof import("../credit-alert-push");
  return {
    sql,
    module,
    requests,
    roles,
    unreadable,
    get tokenReads() {
      return tokenReads;
    },
    setStatus: (value: number) => {
      status = value;
    },
    setEnabled: (value: unknown) => {
      enabled = value;
    },
    setGranted: (value: boolean) => {
      granted = value;
    },
    setPolicy: (value: Partial<typeof policy>) => {
      policy = { ...policy, ...value };
      revision++;
    },
    setContactPolicy: (person: string, value: Partial<typeof policy>) => {
      contactOverrides.set(person, value);
      revision++;
    },
    setAccount: (value: string | null) => {
      account = value;
      binding++;
    },
    setDevice: (value: string) => {
      device = value;
    },
    setInstall: (value: string) => {
      install = value;
    },
    setLocale: (value: string) => {
      locale = value;
    },
    setGate: (value: typeof responseGate) => {
      responseGate = value;
    },
    advance: (milliseconds: number) => {
      now += milliseconds;
    },
  };
}

async function main() {
  const f = fixture();
  await f.module.syncCreditAlertPushSubscriptions();
  assert.equal(f.requests.length, 1, "register only owner/admin readable active vaults");
  assert.match(f.requests[0].url, /credit-alerts\/notifications\?vault_id=v1$/);
  assert.equal(f.requests[0].body.install_id, "install-a");
  assert.equal(f.requests[0].body.token, "synthetic-token");
  assert.equal(f.requests[0].body.preferences.credit_alerts, true);
  assert.deepEqual(
    f.requests[0].body.customer_preferences,
    [],
    "inherited defaults use a sparse registration payload",
  );
  assert.equal(await f.module.creditAlertRemoteDeliveryActive("v1"), true);
  assert.equal(await f.module.creditAlertRemoteDeliveryActive("v2"), false);
  await f.module.syncCreditAlertPushSubscriptions();
  assert.equal(f.requests.length, 1, "successful registration is throttled");
  f.setPolicy({ credit_alerts: false, previews: "private" });
  await f.module.syncCreditAlertPushSubscriptions();
  assert.equal(f.requests.length, 2, "personal changes bypass the hourly retry delay");
  assert.equal(f.requests[1].body.preferences.credit_alerts, false);
  assert.equal(f.requests[1].body.preferences.previews, "private");
  f.setContactPolicy("p", { credit_alerts: true });
  await f.module.syncCreditAlertPushSubscriptions();
  assert.equal(f.requests.at(-1).body.customer_preferences[0].preferences.credit_alerts, true);
  const addPerson = f.sql.prepare("INSERT INTO users VALUES(?,NULL)");
  const addCustomer = f.sql.prepare("INSERT INTO relationships VALUES(?,'v1',?,NULL)");
  f.sql.transaction(() => {
    for (let i = 0; i < 2500; i++) {
      addPerson.run(`large-p-${i}`);
      addCustomer.run(`large-r-${i}`, `large-p-${i}`);
    }
  })();
  await f.module.syncCreditAlertPushSubscriptions(true);
  assert.equal(
    f.requests.at(-1).body.customer_preferences.length,
    1,
    "2500 inherited customers do not consume the server's personal-override bound",
  );
  f.setStatus(404);
  await f.module.syncCreditAlertPushSubscriptions(true);
  assert.equal(
    await f.module.creditAlertRemoteDeliveryActive("v1"),
    true,
    "unsupported endpoint preserves prior confirmed transport cache",
  );
  f.advance(2 * 3600_000);
  assert.equal(
    await f.module.creditAlertRemoteDeliveryActive("v1"),
    true,
    "offline time cannot transfer server-owned delivery back to local fallback",
  );
  f.advance(30 * 24 * 3600_000);
  assert.equal(
    await f.module.creditAlertRemoteDeliveryActive("v1"),
    false,
    "the server's actual 30-day lease permits fallback after expiry",
  );
  f.setStatus(200);
  f.setGranted(false);
  await f.module.syncCreditAlertPushSubscriptions(true);
  assert.equal(
    f.requests.at(-1).body.token,
    "",
    "OS denial unregisters remote delivery without prompting",
  );
  assert.equal(await f.module.creditAlertRemoteDeliveryActive("v1"), false);
  f.setGranted(true);
  await f.module.syncCreditAlertPushSubscriptions(true);
  assert.equal(await f.module.creditAlertRemoteDeliveryActive("v1"), true);
  f.setDevice("another-phone");
  assert.equal(
    await f.module.creditAlertRemoteDeliveryActive("v1"),
    false,
    "a copied database cannot reuse another device's cache",
  );
  f.setDevice("private-a");
  f.setInstall("another-install");
  assert.equal(await f.module.creditAlertRemoteDeliveryActive("v1"), false);
  f.setInstall("install-a");
  f.setAccount("account-b");
  assert.equal(await f.module.creditAlertRemoteDeliveryActive("v1"), false);
  f.setAccount(null);
  const count = f.requests.length;
  await f.module.syncCreditAlertPushSubscriptions(true);
  assert.equal(f.requests.length, count, "signed-out local use never registers remote authority");

  const race = fixture();
  const gate = deferred<void>();
  race.setGate(gate);
  const pending = race.module.syncCreditAlertPushSubscriptions();
  for (let i = 0; i < 100 && race.requests.length === 0; i++)
    await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(race.requests.length, 1);
  race.setAccount("new-account");
  gate.resolve();
  await pending;
  assert.equal(
    (race.sql.prepare("SELECT COUNT(*) AS n FROM app_meta").get() as { n: number }).n,
    0,
    "stale registration response cannot save across accounts",
  );
  console.log(
    "PASS credit push registration: owner authority, sparse large-vault settings, permission opt-in, account/device/vault cache, unsupported endpoint preservation, server lease expiry and response scope",
  );
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
