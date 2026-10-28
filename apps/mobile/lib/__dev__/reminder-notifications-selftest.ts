import assert from "node:assert/strict";
import * as schedule from "../reminder-schedule";
import { compileUI, deferred, settleUI } from "./ui-fixture";
import * as notificationPolicy from "../notification-policy";

async function main() {
  let expoGo = false,
    platform = "android",
    owner = "account:a",
    zone = "Asia/Kabul",
    locale = "en",
    permission: any = { granted: true, canAskAgain: true };
  let rows: any[] = [],
    requests = 0,
    nativeImports = 0;
  let scheduleGate: Promise<void> | null = null;
  let permissionAfterRequest: any = null;
  const handlers: { handleNotification: (notification: any) => Promise<any> }[] = [];
  const scheduled = new Map<string, any>(),
    presented = new Map<string, any>();
  const scheduledCalls: any[] = [],
    canceled: string[] = [],
    dismissed: string[] = [],
    channels: any[] = [],
    sql: any[] = [];
  const prefix = "kaata-customer-reminder:";
  let deliveryPolicy = notificationPolicy.defaultNotificationPolicy();
  const contactPolicies = new Map<string, notificationPolicy.NotificationPolicy>();
  const make = (id: string, spec: any, extra: any = {}) => ({
    id,
    owner_scope: owner,
    install_id: "private-phone",
    vault_id: "kaata",
    person_id: "customer",
    person_name: "Sensitive customer",
    schedule_json: JSON.stringify(spec),
    next_due_at: Date.now() + 3600_000,
    enabled: 1,
    updated_at: 1,
    timezone: zone,
    ...extra,
  });
  const n = {
    setNotificationHandler: (handler: (typeof handlers)[number]) => {
      handlers.push(handler);
    },
    AndroidImportance: { DEFAULT: 3 },
    IosAuthorizationStatus: { PROVISIONAL: 3 },
    setNotificationChannelAsync: async (...args: any[]) => {
      channels.push(args);
    },
    getPermissionsAsync: async () => permission,
    requestPermissionsAsync: async () => {
      requests++;
      if (permissionAfterRequest) permission = permissionAfterRequest;
      return permission;
    },
    getAllScheduledNotificationsAsync: async () => [...scheduled.values()],
    getPresentedNotificationsAsync: async () =>
      [...presented.values()].map((request) => ({ request })),
    dismissNotificationAsync: async (id: string) => {
      dismissed.push(id);
      presented.delete(id);
    },
    cancelScheduledNotificationAsync: async (id: string) => {
      canceled.push(id);
      scheduled.delete(id);
    },
    scheduleNotificationAsync: async (request: any) => {
      scheduledCalls.push(request);
      if (scheduleGate) await scheduleGate;
      scheduled.set(request.identifier, request);
      return request.identifier;
    },
  };
  const module = compileUI("../reminder-notifications", {
    "./notification-policy": notificationPolicy,
    "./notification-preferences": {
      notificationPolicyForContact: async (contact?: { vaultId: string; personId: string }) =>
        (contact && contactPolicies.get(`${contact.vaultId}:${contact.personId}`)) ||
        deliveryPolicy,
      onNotificationPreferencesChanged: () => () => {},
      notificationOwnerScope: () => owner,
      notificationPreferencesRevision: () => 0,
    },
    expo: { isRunningInExpoGo: () => expoGo },
    "react-native": {
      Platform: {
        get OS() {
          return platform;
        },
      },
    },
    "./db-tx": {
      getDb: async () => ({
        runAsync: async (...args: any[]) => {
          sql.push(args);
        },
      }),
    },
    "./i18n": {
      t: (key: string, params?: { name?: string }) =>
        params?.name ? `${key}:${params.name}` : key,
      getLocale: () => locale,
    },
    "./customer-reminders": {
      listCustomerReminders: async () => rows.filter((row) => row.owner_scope === owner),
      readReminderSchedule: (row: any) => {
        const value = JSON.parse(row.schedule_json);
        return schedule.validReminderSchedule(value) ? value : null;
      },
      reminderOwnerScope: () => owner,
      reminderTimezone: () => zone,
    },
    "./reminder-schedule": schedule,
    "expo-notifications": new Proxy(n, {
      get(target, key: keyof typeof n) {
        nativeImports++;
        return target[key];
      },
    }),
  });
  expoGo = true;
  assert.equal(await module.reminderNotificationStatus(), "unavailable");
  assert.equal(await module.requestReminderNotifications(), "unavailable");
  await module.reconcileReminderNotifications();
  assert.equal(nativeImports, 0, "Android Expo Go retains its native notifications guard");
  assert.equal(handlers.length, 0);
  expoGo = false;
  permission = { granted: false, canAskAgain: false };
  assert.equal(await module.requestReminderNotifications(), "denied");
  assert.equal(requests, 0);
  permission = { granted: false, canAskAgain: true };
  assert.equal(await module.requestReminderNotifications(), "denied");
  assert.equal(requests, 1, "permission request occurs only after explicit setup request");
  permission = { granted: false, canAskAgain: false, ios: { status: 3 } };
  assert.equal(
    await module.requestReminderNotifications(),
    "granted",
    "iOS provisional counts as usable",
  );
  permission = { granted: true, canAskAgain: true };
  rows = [
    make("once", { kind: "once", at: Date.now() + 3600_000 }),
    make("daily", { kind: "daily", hour: 11, minute: 30 }),
    make("weekly", { kind: "weekly", weekday: 4, hour: 12, minute: 5 }),
  ];
  const unrelated = { identifier: "some-other-app-feature", content: { data: {} } };
  scheduled.set(unrelated.identifier, unrelated);
  presented.set(unrelated.identifier, unrelated);
  await module.reconcileReminderNotifications();
  assert.equal(requests, 1, "reconcile never prompts permissions");
  assert.equal(scheduledCalls.length, 3);
  assert.deepEqual(
    scheduledCalls.map((request) => request.trigger.type),
    ["date", "daily", "weekly"],
  );
  assert.equal(scheduledCalls[2].trigger.weekday, 5);
  assert.ok(channels.length > 0);
  for (const request of scheduledCalls) {
    assert.equal(request.content.title, "Kaata");
    // The visible text names the customer (decided 2026-10-12)...
    assert.equal(request.content.body, "reminders.notifyBodyNamed:Sensitive customer");
    assert.equal(request.content.data.kind, "customer_reminder");
    assert.ok(
      // ...while the payload data stays opaque IDs: no name, ledger or amount.
      !JSON.stringify(request.content.data).includes("Sensitive customer"),
      "OS payload has no customer/ledger/amount data",
    );
  }
  await module.reconcileReminderNotifications();
  assert.equal(scheduledCalls.length, 3, "matching native requests are not churned");
  // The text is fixed when scheduled: a language switch must rewrite every
  // pending alert instead of leaving the old language in the tray.
  locale = "fa";
  await module.reconcileReminderNotifications();
  assert.equal(scheduledCalls.length, 6, "a language switch reschedules each request once");
  await module.reconcileReminderNotifications();
  assert.equal(scheduledCalls.length, 6, "and then leaves them alone");
  locale = "en";
  await module.reconcileReminderNotifications();
  assert.equal(scheduledCalls.length, 9);
  // The alert names the customer, so a rename rewrites pending alerts too.
  const names = rows.map((row) => row.person_name);
  rows = rows.map((row) => ({ ...row, person_name: "Renamed customer" }));
  await module.reconcileReminderNotifications();
  assert.equal(scheduledCalls.length, 12, "a rename rewrites each pending alert once");
  assert.ok(scheduledCalls.slice(9).every((r) => r.content.body.endsWith(":Renamed customer")));
  rows = rows.map((row, i) => ({ ...row, person_name: names[i] }));
  await module.reconcileReminderNotifications();
  scheduledCalls.splice(3);
  const oldDaily = scheduled.get(prefix + "daily");
  presented.set(oldDaily.identifier, oldDaily);
  rows[1] = {
    ...rows[1],
    updated_at: 2,
    schedule_json: JSON.stringify({ kind: "daily", hour: 13, minute: 15 }),
  };
  await module.reconcileReminderNotifications();
  assert.ok(canceled.includes(prefix + "daily"));
  assert.ok(dismissed.includes(prefix + "daily"), "edited task clears obsolete delivered content");
  assert.equal(scheduled.get(prefix + "daily").trigger.hour, 13);
  const dueOnce = make(
    "due",
    { kind: "once", at: Date.now() - 1000 },
    { next_due_at: Date.now() - 1000 },
  );
  const dueNotice = {
    identifier: prefix + "due",
    content: {
      data: {
        owner_scope: owner,
        reminder_fingerprint: `${dueOnce.updated_at}:${dueOnce.schedule_json}:${zone}`,
      },
    },
  };
  rows.push(dueOnce);
  presented.set(dueNotice.identifier, dueNotice);
  await module.reconcileReminderNotifications();
  assert.ok(
    presented.has(dueNotice.identifier),
    "delivered outstanding one-off stays until explicit completion",
  );
  assert.ok(!scheduled.has(dueNotice.identifier), "past one-off is not rescheduled");
  rows = rows.filter((row) => row.id !== "due" && row.id !== "weekly");
  await module.reconcileReminderNotifications();
  assert.ok(!presented.has(dueNotice.identifier));
  assert.ok(!scheduled.has(prefix + "weekly"));
  assert.ok(
    scheduled.has(unrelated.identifier) && presented.has(unrelated.identifier),
    "unrelated scheduled and delivered notices remain untouched",
  );
  rows[0] = { ...rows[0], timezone: "UTC", next_due_at: Date.now() - 100 };
  rows[1] = { ...rows[1], timezone: "UTC", next_due_at: Date.now() - 100 };
  await module.reconcileReminderNotifications();
  assert.equal(
    sql.at(-1)[1],
    rows[1].next_due_at,
    "timezone correction preserves an already-due recurring task",
  );
  permission = { granted: false, canAskAgain: false };
  await module.reconcileReminderNotifications();
  assert.equal(requests, 1);
  assert.equal(scheduled.size, 1, "denied permission cleans only reminder requests");
  permission = { granted: true };
  owner = "account:a";
  rows = [make("slow", { kind: "daily", hour: 9, minute: 0 })];
  const gate = deferred<void>();
  scheduleGate = gate.promise;
  const pending = module.reconcileReminderNotifications();
  await settleUI();
  assert.equal(scheduledCalls.at(-1).identifier, prefix + "slow");
  owner = "account:b";
  module.invalidateReminderNotificationWork();
  gate.resolve();
  await pending;
  assert.ok(
    !scheduled.has(prefix + "slow"),
    "late native schedule is canceled after account changes",
  );
  scheduleGate = null;
  await module.reconcileReminderNotifications();
  assert.equal(scheduled.size, 1);

  // Several native requests belong to a single private task. Editing its
  // selected days or month phase removes every obsolete fragment and tray item.
  owner = "account:a";
  rows = [
    make("selected", { kind: "weekdays", weekdays: [0, 2, 4], hour: 9, minute: 15 }),
    make("monthly", {
      kind: "monthly",
      day: 15,
      anchorMonth: 0,
      intervalMonths: 1,
      hour: 10,
      minute: 0,
    }),
    make("alternate", {
      kind: "monthly",
      day: 28,
      anchorMonth: 10,
      intervalMonths: 2,
      hour: 11,
      minute: 30,
    }),
  ];
  await module.reconcileReminderNotifications();
  const privateRequests = () =>
    [...scheduled.values()].filter((request) => request.identifier.startsWith(prefix));
  assert.equal(privateRequests().length, 10);
  assert.equal(scheduled.get(prefix + "monthly").trigger.type, "monthly");
  assert.deepEqual(
    privateRequests()
      .filter((request) => request.content.data.reminder_id === "alternate")
      .map((request) => request.trigger.month),
    [0, 2, 4, 6, 8, 10],
  );
  const oldThursday = scheduled.get(prefix + "selected:weekday:4");
  presented.set(oldThursday.identifier, oldThursday);
  await module.reconcileReminderNotifications();
  assert.ok(
    presented.has(oldThursday.identifier),
    "fragment notice resolves to its outstanding private task",
  );
  rows[0] = {
    ...rows[0],
    updated_at: 2,
    schedule_json: JSON.stringify({ kind: "weekdays", weekdays: [0, 2], hour: 9, minute: 15 }),
  };
  rows[2] = {
    ...rows[2],
    updated_at: 2,
    schedule_json: JSON.stringify({
      kind: "monthly",
      day: 28,
      anchorMonth: 11,
      intervalMonths: 2,
      hour: 11,
      minute: 30,
    }),
  };
  await module.reconcileReminderNotifications();
  assert.ok(!scheduled.has(oldThursday.identifier));
  assert.ok(!presented.has(oldThursday.identifier));
  assert.deepEqual(
    privateRequests()
      .filter((request) => request.content.data.reminder_id === "alternate")
      .map((request) => request.trigger.month),
    [1, 3, 5, 7, 9, 11],
  );
  assert.ok(!scheduled.has(prefix + "alternate:month:0"));
  for (const request of privateRequests()) {
    assert.equal(request.content.data.owner_scope, owner);
    assert.ok(!JSON.stringify(request.content.data).includes("Sensitive customer"));
  }
  rows = Array.from({ length: 9 }, (_, i) =>
    make(`budget-${i}`, { kind: "weekdays", weekdays: [0, 1, 2, 3, 4, 5, 6], hour: 10, minute: 0 }),
  );
  const beforeOverflow = scheduledCalls.length;
  await assert.rejects(module.reconcileReminderNotifications(), /reminder_notification_limit/);
  assert.equal(
    scheduledCalls.length,
    beforeOverflow,
    "an invalid inherited plan is reported instead of silently scheduling a subset",
  );
  rows = [];
  await module.reconcileReminderNotifications();
  assert.equal(scheduled.size, 1, "removing complex tasks cancels every weekday/month fragment");
  platform = "ios";
  rows = [
    make("ios-monthly", {
      kind: "monthly",
      day: 10,
      anchorMonth: 0,
      intervalMonths: 1,
      hour: 9,
      minute: 0,
    }),
    make("ios-alternate", {
      kind: "monthly",
      day: 10,
      anchorMonth: 0,
      intervalMonths: 2,
      hour: 9,
      minute: 0,
    }),
  ];
  await module.reconcileReminderNotifications();
  assert.equal(privateRequests().length, 7);
  assert.ok(
    privateRequests().every(
      (request) => request.trigger.type === "calendar" && request.trigger.repeats === true,
    ),
    "actual iOS reconcile uses the explicit ISO calendar plans",
  );
  assert.deepEqual(
    privateRequests()
      .filter((request) => request.content.data.reminder_id === "ios-alternate")
      .map((request) => request.trigger.month),
    [1, 3, 5, 7, 9, 11],
  );
  owner = "account:b";
  await module.reconcileReminderNotifications();
  assert.equal(scheduled.size, 1, "account change clears every iOS calendar fragment");
  assert.equal(
    handlers.length,
    0,
    "signed Android/iOS paths preserve the app-wide notification policy",
  );

  // iOS Expo Go supports local permissions, schedules and foreground delivery.
  // Its reminder-only handler is installed once, without remote setup APIs.
  expoGo = true;
  permission = { granted: false, canAskAgain: true };
  const requestsBeforeGo = requests;
  const channelsBeforeGo = channels.length;
  assert.deepEqual(
    await Promise.all([module.reminderNotificationStatus(), module.reminderNotificationStatus()]),
    ["denied", "denied"],
  );
  assert.equal(requests, requestsBeforeGo, "reading iOS Go permission never prompts");
  assert.equal(handlers.length, 1, "concurrent native access installs the Go-only handler once");
  permissionAfterRequest = { granted: true, canAskAgain: true };
  assert.equal(await module.requestReminderNotifications(), "granted");
  permissionAfterRequest = null;
  assert.equal(
    requests,
    requestsBeforeGo + 1,
    "iOS Go can explicitly request local notification permission",
  );
  assert.equal(
    channels.length,
    channelsBeforeGo,
    "iOS Go does not invoke Android notification channels",
  );
  permission = { granted: false, canAskAgain: false, ios: { status: 3 } };
  assert.equal(await module.reminderNotificationStatus(), "granted");
  assert.equal(
    await module.requestReminderNotifications(),
    "granted",
    "iOS Go provisional permission remains usable",
  );
  assert.equal(requests, requestsBeforeGo + 1);
  permission = { granted: true, canAskAgain: true };
  owner = "account:a";
  rows = [
    make("go-once", { kind: "once", at: Date.now() + 3600_000 }),
    make("go-daily", { kind: "daily", hour: 9, minute: 30 }),
  ];
  const scheduledBeforeGo = scheduledCalls.length;
  await module.reconcileReminderNotifications();
  assert.equal(
    scheduledCalls.length,
    scheduledBeforeGo + 2,
    "iOS Go schedules real local reminder requests",
  );
  assert.ok(scheduled.has(prefix + "go-once") && scheduled.has(prefix + "go-daily"));
  assert.ok(
    scheduledCalls
      .slice(scheduledBeforeGo)
      .every(
        (request) =>
          request.content.data.kind === "customer_reminder" &&
          request.content.data.owner_scope === owner,
      ),
  );
  assert.equal(
    requests,
    requestsBeforeGo + 1,
    "reconciliation remains permission-prompt free in Go",
  );
  assert.equal(handlers.length, 1);
  assert.deepEqual(
    await handlers[0].handleNotification({
      request: { content: { data: { kind: "customer_reminder", owner_scope: owner } } },
    }),
    { shouldShowBanner: true, shouldShowList: true, shouldPlaySound: true, shouldSetBadge: false },
  );
  for (const data of [{ kind: "tab_notice", tab_id: "shared-tab" }, {}, null]) {
    assert.deepEqual(
      await handlers[0].handleNotification({ request: { content: { data } } }),
      {
        shouldShowBanner: false,
        shouldShowList: false,
        shouldPlaySound: false,
        shouldSetBadge: false,
      },
      "the Go-only handler does not enable unrelated foreground notifications",
    );
  }
  expoGo = false;
  await module.reminderNotificationStatus();
  assert.equal(
    handlers.length,
    1,
    "native builds never replace their existing handler through reminder access",
  );

  // Alert delivery choices never rewrite tasks or their financial context.
  platform = "android";
  zone = "UTC";
  owner = "account:a";
  deliveryPolicy = {
    ...notificationPolicy.defaultNotificationPolicy(),
    time_zone: "UTC",
    previews: "private",
    sound: false,
    vibration: false,
    quiet_hours: {
      enabled: true,
      start_minute: 22 * 60,
      end_minute: 7 * 60,
      allow_reminders: false,
    },
  };
  const futureNight = new Date();
  futureNight.setUTCDate(futureNight.getUTCDate() + 2);
  futureNight.setUTCHours(23, 30, 0, 0);
  rows = [
    make("quiet-once", { kind: "once", at: futureNight.getTime() }),
    make("quiet-daily", { kind: "daily", hour: 23, minute: 0 }),
    make("daytime", { kind: "daily", hour: 10, minute: 0 }),
    make("contact-muted", { kind: "daily", hour: 10, minute: 0 }, { person_id: "muted-person" }),
  ];
  contactPolicies.set("kaata:muted-person", { ...deliveryPolicy, enabled: false });
  const unchangedTasks = JSON.stringify(rows);
  await module.reconcileReminderNotifications();
  assert.equal(
    scheduled.has(prefix + "quiet-once"),
    false,
    "future one-offs are checked at their occurrence, not at scheduling time",
  );
  assert.equal(
    scheduled.has(prefix + "quiet-daily"),
    false,
    "recurring quiet-hour alarms remain silent",
  );
  assert.equal(
    scheduled.has(prefix + "contact-muted"),
    false,
    "one contact can mute reminders independently",
  );
  const daytime = scheduled.get(prefix + "daytime");
  assert.ok(daytime);
  assert.equal(
    daytime.content.body,
    "reminders.notifyBody",
    "private reminders contain no contact name",
  );
  assert.equal(daytime.content.sound, undefined);
  assert.equal(daytime.trigger.channelId, "customer-reminders-s0-v0");
  assert.equal(
    JSON.stringify(rows),
    unchangedTasks,
    "muting and privacy never modify reminder tasks",
  );
  deliveryPolicy.quiet_hours.allow_reminders = true;
  await module.reconcileReminderNotifications();
  assert.ok(
    scheduled.has(prefix + "quiet-once") && scheduled.has(prefix + "quiet-daily"),
    "explicit reminder exceptions retain the user's chosen alarm time",
  );
  deliveryPolicy.enabled = false;
  await module.reconcileReminderNotifications();
  assert.equal(
    [...scheduled.keys()].filter((id) => id.startsWith(prefix)).length,
    0,
    "master pause cancels only owned native alarms",
  );
  assert.equal(JSON.stringify(rows), unchangedTasks);
  deliveryPolicy = notificationPolicy.defaultNotificationPolicy();
  assert.equal(
    (
      await handlers[0].handleNotification({
        request: { content: { data: { kind: "customer_reminder", owner_scope: "account:old" } } },
      })
    ).shouldShowBanner,
    false,
    "a late alarm from a previous account never shows",
  );

  // The actual physical-device helper is single-flight, excludes transferable
  // keychain backups and retries rather than inventing a transient fallback.
  let reads = 0,
    writes = 0,
    options: any,
    fail = true;
  const keyGate = deferred<string | null>();
  const device = compileUI("../reminder-device", {
    "expo-crypto": { randomUUID: () => "physical-device-key" },
    "expo-secure-store": {
      WHEN_UNLOCKED_THIS_DEVICE_ONLY: 7,
      getItemAsync: async (_: string, passed: any) => {
        reads++;
        options = passed;
        if (fail) throw new Error("locked");
        return keyGate.promise;
      },
      setItemAsync: async (_: string, value: string, passed: any) => {
        writes++;
        assert.equal(value, "physical-device-key");
        assert.deepEqual(passed, options);
      },
    },
  });
  await assert.rejects(device.getReminderDeviceId(), /locked/);
  assert.equal(device.getReminderDeviceIdSync(), null);
  fail = false;
  const firstKey = device.getReminderDeviceId(),
    sameKey = device.getReminderDeviceId();
  assert.equal(firstKey, sameKey);
  keyGate.resolve(null);
  assert.equal(await firstKey, "physical-device-key");
  assert.equal(await device.getReminderDeviceId(), "physical-device-key");
  assert.deepEqual(options, { keychainAccessible: 7 });
  assert.equal(reads, 2);
  assert.equal(writes, 1);
  assert.equal(device.getReminderDeviceIdSync(), "physical-device-key");
  console.log(
    "Reminder notifications: signed and iOS Go permission/scheduling, Go-only reminder foreground policy, Android Go guard, native triggers, edit/remove/tray cleanup, account cancellation and private device storage passed.",
  );
}
void main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
