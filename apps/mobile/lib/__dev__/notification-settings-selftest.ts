// Execute personal notification policy, transactional storage and real settings
// handlers against synthetic SQLite. No device, network or ledger write is used.
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import * as policy from "../notification-policy";
import { Mutex } from "../util/mutex";
import { compileUI, deferred, jsx, nodes, settleUI, uiHooks } from "./ui-fixture";
import type { NotificationPolicy } from "../notification-policy";

function fixture() {
  const sql = new Database(":memory:");
  sql.exec(`CREATE TABLE app_meta(key TEXT PRIMARY KEY,value TEXT);
    CREATE TABLE vaults(id TEXT PRIMARY KEY,name TEXT);
    CREATE TABLE users(id TEXT PRIMARY KEY,display_name TEXT);
    CREATE TABLE relationships(id TEXT PRIMARY KEY,vault_id TEXT,user_b_id TEXT,archived_at INTEGER);
    CREATE TABLE entries(id TEXT PRIMARY KEY,type TEXT,currency TEXT,amount_afn NUMERIC,note TEXT);
    CREATE TABLE tab_entries(id TEXT PRIMARY KEY,status TEXT,amount_minor INTEGER,reviewer_party TEXT);
    CREATE TABLE event_log(id TEXT PRIMARY KEY,event_type TEXT);
    INSERT INTO vaults VALUES('v1','Business'),('v2','Personal');
    INSERT INTO users VALUES('p1','Ahmad'),('p2','Babar');
    INSERT INTO relationships VALUES('r1','v1','p1',NULL),('r2','v2','p1',NULL),('r3','v2','p2',NULL);
    INSERT INTO entries VALUES('private-afn','debt','AFN',120,'Original note'),('private-usd','payment','USD',20,'Cash');
    INSERT INTO tab_entries VALUES('pending','pending',500,NULL),('reviewed','accepted',1000,'b'),('recorded','recorded',2000,NULL);`);
  let account: string | null = "account-a",
    binding = 1,
    activeVault = "v1";
  let throwAfterRun = false;
  let afterRun: (() => void) | undefined;
  let readable = true;
  let params: { vaultId?: string; personId?: string } = {};
  let lockCalls = 0;
  const listeners = new Set<() => void>();
  const mutex = new Mutex();
  const locked = {
    runExclusive: <T>(work: () => T | Promise<T>) => {
      lockCalls++;
      return mutex.runExclusive(work);
    },
  };
  const tx = {
    getFirstAsync: async (query: string, ...args: any[]) => sql.prepare(query).get(...args) ?? null,
    runAsync: async (query: string, ...args: any[]) => {
      const result = sql.prepare(query).run(...args);
      afterRun?.();
      afterRun = undefined;
      if (throwAfterRun) {
        throwAfterRun = false;
        throw new Error("synthetic disk failure after statement");
      }
      return result;
    },
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
  const session = () => ({
    accountId: account,
    bindingVersion: binding,
    jwt: account ? "synthetic-jwt" : null,
  });
  const auth = {
    captureCurrentSession: async () => session(),
    applyForUnchangedLocalSession: async (
      expected: ReturnType<typeof session>,
      work: () => Promise<void>,
    ) => {
      if (expected.accountId !== account || expected.bindingVersion !== binding)
        throw new Error("session changed");
      await work();
      if (expected.accountId !== account || expected.bindingVersion !== binding)
        throw new Error("session changed");
    },
  };
  const dbTx = {
    getDb: async () => tx,
    getSessionAccountIdSync: () => account,
    getInstallIdSync: () => "installation-a",
    getActiveVaultIdSyncMaybe: () => activeVault,
    onAccountIdentityChanged: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  const preferences = compileUI("../notification-preferences", {
    "./auth": auth,
    "./db-tx": dbTx,
    "./notification-policy": policy,
    "./customer-reminders": { canReadReminderVault: async () => readable },
    "./projection": { applyEventMutex: locked },
  }) as typeof import("../notification-preferences");
  const hooks = uiHooks();
  const notices: string[] = [];
  const screen = compileUI("../../app/notification-settings", {
    "expo-router": {
      useFocusEffect: (work: () => any) => hooks.react.useEffect(work, [work]),
      useLocalSearchParams: () => params,
      useRouter: () => ({ back() {} }),
    },
    react: hooks.react,
    "react/jsx-runtime": { jsx, jsxs: jsx },
    "react-native": {
      ActivityIndicator: "ActivityIndicator",
      Linking: { openSettings: async () => undefined },
      Platform: { OS: "android" },
      ScrollView: "ScrollView",
      Text: "Text",
      Switch: "Switch",
      View: "View",
      StyleSheet: { create: (value: any) => value, hairlineWidth: 1 },
    },
    "react-native-safe-area-context": { SafeAreaView: "SafeAreaView" },
    expo: { isRunningInExpoGo: () => false },
    "../components/Button": { Button: "Button" },
    "../components/ConfirmDialog": { ConfirmDialog: "ConfirmDialog" },
    "../components/NotificationTimePicker": { NotificationTimePicker: "NotificationTimePicker" },
    "../components/OptionSheet": { OptionSheet: "OptionSheet" },
    "../components/SettingsScreen": {
      NavRow: "NavRow",
      ScreenHeader: "ScreenHeader",
      SectionGap: "SectionGap",
      SectionHeader: "SectionHeader",
    },
    "../components/Toast": {
      useToast: () => ({ push: (message: string) => notices.push(message) }),
    },
    "../lib/colors": require("../colors"),
    "../lib/db-tx": dbTx,
    "../lib/customer-reminders": { canReadReminderVault: async () => readable },
    "../lib/design-tokens": require("../design-tokens"),
    "../lib/direction": { rowDir: () => ({}), textDir: () => ({}), useIsRTL: () => false },
    "../lib/fonts": { fonts: {} },
    "../lib/i18n": { t: (key: string) => key },
    "../lib/notification-policy": policy,
    "../lib/notification-preferences": preferences,
    "../lib/reminder-notifications": {
      notificationPermissionDetails: async () => "granted",
      requestReminderNotifications: () =>
        assert.fail("settings must not prompt without an explicit request"),
    },
  }).default;
  const financial = () =>
    ["entries", "tab_entries", "event_log"].map((table) => [
      table,
      sql.prepare(`SELECT * FROM ${table} ORDER BY id`).all(),
    ]);
  const saved = () => sql.prepare("SELECT * FROM app_meta ORDER BY key").all();
  const render = () => hooks.render(screen);
  const flush = async () => {
    for (let i = 0; i < 5; i++) {
      await settleUI();
      render();
    }
  };
  return {
    sql,
    preferences,
    mutex: locked,
    hooks,
    render,
    flush,
    financial,
    saved,
    notices,
    lockCalls: () => lockCalls,
    setAccount(value: string | null) {
      account = value;
      binding++;
      for (const listener of listeners) listener();
    },
    setVault(value: string) {
      activeVault = value;
    },
    setContact(value?: { vaultId: string; personId: string }) {
      params = value ?? {};
    },
    setReadable(value: boolean) {
      readable = value;
    },
    failWrite() {
      throwAfterRun = true;
    },
    afterWrite(work: () => void) {
      afterRun = work;
    },
    owner: () => preferences.notificationOwnerScope(),
    one(type: string) {
      const node = nodes(hooks.tree).find((node) => node.type === type);
      assert.ok(node, `missing ${type}`);
      return node;
    },
    switch(label: string) {
      const node = nodes(hooks.tree).find(
        (node) => node.type === "Switch" && node.props.accessibilityLabel === label,
      );
      assert.ok(node, `missing switch ${label}`);
      return node;
    },
    row(label: string) {
      const node = nodes(hooks.tree).find(
        (node) => node.type === "NavRow" && node.props.label === label,
      );
      assert.ok(node, `missing row ${label}`);
      return node;
    },
    close() {
      hooks.unmount();
      sql.close();
    },
  };
}

function policyChecks() {
  const defaults = policy.defaultNotificationPolicy();
  assert.equal(defaults.previews, "name");
  for (const key of [
    "enabled",
    "tallies",
    "reviews",
    "cancellations",
    "connections",
    "reminders",
    "sound",
    "vibration",
  ] as const)
    assert.equal(defaults[key], true);
  assert.equal(defaults.foreground, false);
  assert.equal(defaults.quiet_hours.enabled, false);
  assert.equal(defaults.quiet_hours.allow_reminders, true);
  for (const corrupt of [
    undefined,
    null,
    true,
    "{}",
    [],
    3,
    {
      enabled: "false",
      previews: "all",
      sound: 0,
      quiet_hours: { start_minute: -1, end_minute: 1440 },
    },
  ]) {
    assert.deepEqual(
      policy.normalizeNotificationPolicy(corrupt),
      defaults,
      "corrupt choices cannot invent a preview or time range",
    );
  }
  const valid = policy.normalizeNotificationPolicy({
    ...defaults,
    sound: false,
    previews: "private",
    time_zone: "No/Such_Zone",
  });
  assert.equal(valid.sound, false);
  assert.equal(valid.previews, "private");
  assert.equal(
    valid.time_zone,
    policy.notificationTimeZone(),
    "travelling follows the phone rather than a stale stored zone",
  );
  assert.equal(
    policy.normalizeNotificationPolicy({
      quiet_hours: { enabled: true, start_minute: 400, end_minute: 400 },
    }).quiet_hours.enabled,
    false,
  );
  assert.deepEqual(
    policy.normalizeNotificationOverrides({
      sound: false,
      enabled: true,
      previews: "private",
      bypass_quiet_hours: true,
      quiet_hours: {},
      time_zone: "No/Such_Zone",
      arbitrary: true,
    }),
    { enabled: true, sound: false, previews: "private", bypass_quiet_hours: true },
  );
  const global = {
    ...defaults,
    enabled: false,
    quiet_hours: { ...defaults.quiet_hours, enabled: true },
  };
  const override = policy.mergeNotificationPolicy(global, {
    enabled: true,
    tallies: true,
    bypass_quiet_hours: true,
  });
  assert.equal(override.enabled, false, "a contact exception cannot bypass the app master switch");
  assert.equal(override.quiet_hours.enabled, false);
  assert.equal(policy.notificationAllowed(override, "entry_created"), false);
  for (const [input, minutes] of [
    ["00:00", 0],
    ["7:05", 425],
    ["23:59", 1439],
  ] as const) {
    assert.equal(policy.parseNotificationTime(input), minutes);
    assert.equal(policy.parseNotificationTime(policy.formatNotificationTime(minutes)), minutes);
  }
  for (const invalid of ["24:00", "23:60", "-1:00", "7:5", "7", "12:00 AM", "12:00:00"])
    assert.equal(policy.parseNotificationTime(invalid), null);
  for (const sound of [false, true])
    for (const vibration of [false, true]) {
      assert.equal(
        policy.notificationChannel({ sound, vibration }),
        `tab-updates-s${Number(sound)}-v${Number(vibration)}`,
      );
      assert.equal(
        policy.notificationChannel({ sound, vibration }, true),
        `customer-reminders-s${Number(sound)}-v${Number(vibration)}`,
      );
    }
  const p: NotificationPolicy = {
    ...defaults,
    time_zone: "Asia/Kabul",
    quiet_hours: { enabled: true, start_minute: 1320, end_minute: 420, allow_reminders: true },
  };
  for (const [iso, allow] of [
    ["2026-10-28T17:29:00Z", true],
    ["2026-10-28T17:30:00Z", false],
    ["2026-10-28T23:30:00Z", false],
    ["2026-10-29T02:30:00Z", true],
  ] as const)
    assert.equal(policy.notificationAllowed(p, "entry_created", new Date(iso)), allow);
  const night = new Date("2026-10-28T23:30:00Z");
  assert.equal(policy.notificationAllowed(p, "customer_reminder", night), true);
  assert.equal(
    policy.notificationAllowed({ ...p, reminders: false }, "customer_reminder", night),
    false,
  );
  assert.equal(
    policy.notificationAllowed(
      { ...p, quiet_hours: { ...p.quiet_hours, allow_reminders: false } },
      "customer_reminder",
      night,
    ),
    false,
  );
  p.time_zone = "America/New_York";
  p.quiet_hours.start_minute = 60;
  p.quiet_hours.end_minute = 180;
  for (const iso of ["2026-11-01T05:30:00Z", "2026-11-01T06:30:00Z", "2026-03-08T06:30:00Z"])
    assert.equal(
      policy.quietNotificationTime(p, new Date(iso)),
      true,
      "both DST repetitions and the spring interval stay quiet",
    );
  assert.equal(policy.quietNotificationTime(p, new Date("2026-03-08T07:00:00Z")), false);
  p.time_zone = "UTC";
  p.quiet_hours.start_minute = 540;
  p.quiet_hours.end_minute = 1020;
  assert.equal(policy.quietNotificationTime(p, new Date("2026-10-28T10:00:00Z")), true);
  assert.equal(policy.quietNotificationTime(p, new Date("2026-10-28T17:00:00Z")), false);
}

async function storageChecks() {
  const f = fixture();
  try {
    const finance = f.financial();
    const initial = await f.preferences.readNotificationSettings();
    let events = 0;
    f.preferences.onNotificationPreferencesChanged(() => {
      throw new Error("one faulty observer");
    });
    f.preferences.onNotificationPreferencesChanged(() => events++);
    const global = {
      ...initial.global,
      sound: false,
      quiet_hours: { ...initial.global.quiet_hours, enabled: true },
    };
    await f.preferences.saveNotificationSettings(global, { owner: initial.owner });
    const contact = { vaultId: "v1", personId: "p1" };
    await f.preferences.saveNotificationSettings(
      { tallies: false, previews: "private", bypass_quiet_hours: true },
      { contact, owner: initial.owner },
    );
    const override = await f.preferences.readNotificationSettings(contact);
    assert.equal(
      override.effective.sound,
      false,
      "unspecified contact choices inherit the app value",
    );
    assert.equal(override.effective.tallies, false);
    assert.equal(override.effective.previews, "private");
    assert.equal(override.effective.quiet_hours.enabled, false);
    assert.equal(
      (await f.preferences.readNotificationSettings({ vaultId: "v2", personId: "p1" })).overrides,
      null,
      "another kaata has an independent contact override",
    );
    const tab = { tab_id: "afn", vault_id: "v1", relationship_id: "r1", currency: "AFN" } as any;
    assert.deepEqual(
      await f.preferences.notificationPolicyForTab(tab),
      await f.preferences.notificationPolicyForTab({ ...tab, tab_id: "usd", currency: "USD" }),
      "all of one contact's currencies use the same personal override",
    );
    f.sql.prepare("UPDATE relationships SET archived_at=10 WHERE id='r1'").run();
    assert.equal(
      (await f.preferences.notificationPolicyForTab(tab)).enabled,
      false,
      "an archived contact cannot fall back to broad app-wide alerts",
    );
    f.sql.prepare("UPDATE relationships SET archived_at=NULL WHERE id='r1'").run();
    f.setReadable(false);
    assert.equal(
      (await f.preferences.notificationPolicyForTab(tab)).enabled,
      false,
      "a revoked vault cannot send local alerts from old cached rows",
    );
    f.setReadable(true);
    assert.equal(
      (await f.preferences.notificationPolicyForTab({ ...tab, relationship_id: "missing" }))
        .enabled,
      false,
      "a missing contact mapping never broadens its former private or muted policy",
    );
    const off = { ...global, enabled: false };
    await f.preferences.saveNotificationSettings(off, { owner: initial.owner });
    await f.preferences.saveNotificationSettings(
      { enabled: true, bypass_quiet_hours: true },
      { contact, owner: initial.owner },
    );
    assert.equal((await f.preferences.readNotificationSettings(contact)).effective.enabled, false);
    await f.preferences.saveNotificationSettings(null, { contact, owner: initial.owner });
    assert.equal((await f.preferences.readNotificationSettings(contact)).overrides, null);
    assert.equal(events, 5);
    assert.equal(f.preferences.notificationPreferencesRevision(), 5);
    const accountA = f.saved();
    f.setAccount("account-b");
    assert.deepEqual(
      (await f.preferences.readNotificationSettings()).global,
      policy.defaultNotificationPolicy(),
      "another account does not inherit the previous account's mute/privacy",
    );
    f.setAccount(null);
    assert.match(f.owner(), /^local:/);
    assert.deepEqual(
      (await f.preferences.readNotificationSettings()).global,
      policy.defaultNotificationPolicy(),
    );
    f.setAccount("account-a");
    assert.equal((await f.preferences.readNotificationSettings()).global.enabled, false);
    assert.deepEqual(f.saved(), accountA, "scope reads never manufacture preference writes");
    assert.deepEqual(
      f.financial(),
      finance,
      "notification settings cannot add reviews or rewrite tallies/events",
    );
    const saved = f.saved(),
      beforeEvents = events;
    f.failWrite();
    await assert.rejects(
      f.preferences.saveNotificationSettings(initial.global, { owner: f.owner() }),
      /synthetic disk failure/,
    );
    assert.deepEqual(
      f.saved(),
      saved,
      "a failed statement rolls back the entire preference mutation",
    );
    assert.equal(events, beforeEvents);
    assert.equal(f.preferences.notificationPreferencesRevision(), beforeEvents);
    let current = true;
    f.afterWrite(() => {
      current = false;
    });
    await assert.rejects(
      f.preferences.saveNotificationSettings(initial.global, {
        owner: f.owner(),
        shouldContinue: () => current,
      }),
      /scope_changed/,
    );
    assert.deepEqual(f.saved(), saved, "a scope loss after SQL rolls back before commit");
    assert.equal(events, beforeEvents);
    for (const change of ["account", "contact"] as const) {
      current = true;
      f.setVault("v1");
      const owner = f.owner(),
        hold = deferred<void>(),
        entered = deferred<void>();
      const blocking = f.mutex.runExclusive(async () => {
        entered.resolve();
        await hold.promise;
      });
      await entered.promise;
      const calls = f.lockCalls();
      const pending = f.preferences.saveNotificationSettings(
        { sound: true },
        { contact, owner, shouldContinue: () => current },
      );
      await settleUI();
      assert.ok(
        f.lockCalls() > calls,
        "the stale write is queued behind a real projection transaction",
      );
      const expectedEvents: number = events + (change === "account" ? 1 : 0);
      if (change === "account") f.setAccount("account-b");
      else {
        f.setVault("v2");
        current = false;
      }
      hold.resolve();
      await blocking;
      await assert.rejects(pending, /scope_changed|session changed/);
      assert.deepEqual(f.saved(), saved);
      assert.equal(
        events,
        expectedEvents,
        "only identity invalidation, not the refused write, announces a change",
      );
      f.setAccount("account-a");
    }
    assert.deepEqual(f.financial(), finance);
  } finally {
    f.close();
  }
}

async function screenChecks() {
  const f = fixture();
  try {
    const finance = f.financial();
    f.render();
    await f.flush();
    assert.equal(f.switch("notificationSettings.enabled").props.value, true);
    assert.equal(
      f.row("notificationSettings.previews").props.trailing,
      "notificationSettings.preview.name",
    );
    f.switch("notificationSettings.sound").props.onValueChange(false);
    await f.flush();
    assert.equal((await f.preferences.readNotificationSettings()).global.sound, false);
    f.row("notificationSettings.previews").props.onPress();
    f.render();
    const preview = f.one("OptionSheet");
    assert.equal(preview.props.visible, true);
    preview.props.onSelect("private");
    await f.flush();
    assert.equal((await f.preferences.readNotificationSettings()).global.previews, "private");
    f.switch("notificationSettings.quietHours").props.onValueChange(true);
    await f.flush();
    f.row("notificationSettings.quiet.start").props.onPress();
    f.render();
    const time = f.one("NotificationTimePicker");
    assert.equal(time.props.visible, true);
    const revision = f.preferences.notificationPreferencesRevision();
    time.props.onSelect(7 * 60);
    await f.flush();
    assert.equal(
      f.preferences.notificationPreferencesRevision(),
      revision,
      "equal start/end is not saved as an ambiguous all-day interval",
    );
    assert.equal(f.notices.at(-1), "notificationSettings.quiet.invalid");
    assert.equal(
      (await f.preferences.readNotificationSettings()).global.quiet_hours.start_minute,
      22 * 60,
    );
    f.row("notificationSettings.quiet.start").props.onPress();
    f.render();
    f.one("NotificationTimePicker").props.onSelect(21 * 60);
    await f.flush();
    assert.equal(f.row("notificationSettings.quiet.start").props.trailing, "21:00");
    const before = (await f.preferences.readNotificationSettings()).global;
    f.failWrite();
    f.switch("notificationSettings.enabled").props.onValueChange(false);
    await f.flush();
    assert.equal(
      f.switch("notificationSettings.enabled").props.value,
      true,
      "failed auto-save restores the visible committed switch",
    );
    assert.deepEqual((await f.preferences.readNotificationSettings()).global, before);
    assert.ok(nodes(f.hooks.tree).some((node) => node.props.accessibilityRole === "alert"));
    f.setContact({ vaultId: "v1", personId: "p1" });
    f.render();
    await f.flush();
    assert.equal(f.switch("notificationSettings.useDefaults").props.value, true);
    assert.equal(
      f.switch("notificationSettings.sound").props.disabled,
      true,
      "inherited rows do not pretend to be editable overrides",
    );
    f.switch("notificationSettings.useDefaults").props.onValueChange(false);
    await f.flush();
    assert.equal(f.switch("notificationSettings.sound").props.disabled, false);
    f.switch("notificationSettings.tallies").props.onValueChange(false);
    await f.flush();
    assert.equal(
      (await f.preferences.readNotificationSettings({ vaultId: "v1", personId: "p1" })).effective
        .tallies,
      false,
    );
    f.switch("notificationSettings.useDefaults").props.onValueChange(true);
    await f.flush();
    assert.equal(
      (await f.preferences.readNotificationSettings({ vaultId: "v1", personId: "p1" })).overrides,
      null,
    );
    const retained = f.switch("notificationSettings.useDefaults").props.onValueChange;
    f.setVault("v2");
    f.setContact({ vaultId: "v2", personId: "p2" });
    f.render();
    await f.flush();
    const saved = f.saved();
    retained(false);
    await f.flush();
    assert.deepEqual(
      f.saved(),
      saved,
      "a retained control cannot write the previous contact's draft into a new scope",
    );
    f.row("notificationSettings.reset").props.onPress();
    f.render();
    f.one("ConfirmDialog").props.onConfirm();
    await f.flush();
    assert.equal(
      (await f.preferences.readNotificationSettings({ vaultId: "v2", personId: "p2" })).overrides,
      null,
    );
    const oldAccountToggle = f.switch("notificationSettings.useDefaults").props.onValueChange;
    f.setAccount("account-b");
    await f.flush();
    const beforeAccountCallback = f.saved();
    oldAccountToggle(false);
    await f.flush();
    assert.deepEqual(
      f.saved(),
      beforeAccountCallback,
      "a retained control cannot apply the previous account's preferences to the new account",
    );
    assert.deepEqual(
      f.financial(),
      finance,
      "every real settings action stays outside the financial models",
    );
  } finally {
    f.close();
  }
}

async function main() {
  policyChecks();
  await storageChecks();
  await screenChecks();
  console.log(
    "PASS notification settings: recommended defaults, normalization, inherited/contact/currency/account scopes, transactional rollback and stale writes, quiet hours/DST/reminder exceptions, privacy/time-picker/reset and unchanged financial history",
  );
}
void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
