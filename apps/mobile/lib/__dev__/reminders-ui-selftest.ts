import assert from "node:assert/strict";
import * as schedule from "../reminder-schedule";
import { compileUI, deferred, jsx, nodes, settleUI, uiHooks } from "./ui-fixture";

const primitives = {
  View: "View",
  Text: "Text",
  Pressable: "Pressable",
  ScrollView: "ScrollView",
  ActivityIndicator: "Spinner",
  StyleSheet: { create: (s: any) => s, hairlineWidth: 1 },
};
const direction = { useIsRTL: () => false, rowDir: () => ({}), textDir: () => ({}) };
const tokens = { radius: { md: 12 }, typography: {} };
const colors = require("../colors").colors;
const jsxRuntime = { jsx, jsxs: jsx, Fragment: "Fragment" };
const find = (tree: any, type: any) => nodes(tree).find((node) => node.type === type)!;
const label = (tree: any, key: string) =>
  nodes(tree).find((node) => node.props.label === key || node.props.accessibilityLabel === key)!;
function focusBoundary(hooks: ReturnType<typeof uiHooks>) {
  let callback: (() => void | (() => void)) | null = null,
    cleanup: (() => void) | undefined;
  return {
    useFocusEffect: (fn: () => void | (() => void)) =>
      hooks.react.useEffect(() => {
        callback = fn;
        cleanup = fn() || undefined;
        return () => {
          cleanup?.();
          cleanup = undefined;
        };
      }, [fn]),
    blur: () => {
      cleanup?.();
      cleanup = undefined;
    },
    focus: () => {
      cleanup = callback?.() || undefined;
    },
  };
}

async function editorTests() {
  const hooks = uiHooks(),
    focus = focusBoundary(hooks),
    requests: any[] = [],
    dismisses: any[] = [],
    saves: any[] = [];
  let platform = "android",
    busy = false;
  const { ReminderEditor } = compileUI("../../components/ReminderEditor", {
    "react/jsx-runtime": jsxRuntime,
    react: hooks.react,
    "expo-router": focus,
    "@react-native-community/datetimepicker": {
      __esModule: true,
      default: "Picker",
      DateTimePickerAndroid: {
        open: (r: any) => requests.push(r),
        dismiss: async (mode: any) => {
          dismisses.push(mode);
        },
      },
    },
    "react-native": {
      ...primitives,
      Platform: {
        get OS() {
          return platform;
        },
      },
    },
    "./Button": { Button: "Button" },
    "../lib/colors": { colors },
    "../lib/direction": direction,
    "../lib/format": { formatDate: (at: number) => `preferred-calendar:${at}` },
    "../lib/i18n": { t: (key: string) => key },
    "../lib/reminder-format": {
      reminderClock: (h: number, m: number) => `${h}:${m}`,
      reminderWeekday: (d: number) => `weekday:${d}`,
      reminderMonthlyDate: (at: number) => `gregorian-month-day:${at}`,
      reminderMonthCount: (months: number) => `months:${months}`,
    },
    "../lib/reminder-schedule": schedule,
    "../lib/tokens": tokens,
  });
  const at = new Date(2026, 10, 1, 10, 15).getTime();
  const render = () =>
    hooks.render(() =>
      ReminderEditor({
        value: { kind: "once", at },
        busy,
        onSave: (s: any) => saves.push(s),
        onCancel() {},
      }),
    );
  render();
  label(hooks.tree, "reminders.time").props.onPress();
  assert.equal(requests[0].mode, "time");
  requests[0].onValueChange({}, new Date(2000, 0, 1, 13, 45));
  render();
  label(hooks.tree, "entry.save").props.onPress();
  assert.equal(new Date(saves.at(-1).at).getDate(), 1, "time picker preserves selected date");
  assert.equal(new Date(saves.at(-1).at).getHours(), 13);
  label(hooks.tree, "reminders.date").props.onPress();
  requests.at(-1).onValueChange({}, new Date(2027, 0, 3, 0));
  render();
  label(hooks.tree, "entry.save").props.onPress();
  assert.equal(new Date(saves.at(-1).at).getHours(), 13, "date picker preserves selected time");
  assert.equal(new Date(saves.at(-1).at).getFullYear(), 2027);
  label(hooks.tree, "reminders.time").props.onPress();
  const blurred = requests.at(-1);
  focus.blur();
  blurred.onValueChange({}, new Date(2027, 0, 3, 2));
  render();
  assert.ok(dismisses.includes("time"));
  label(hooks.tree, "entry.save").props.onPress();
  assert.equal(new Date(saves.at(-1).at).getHours(), 13);
  focus.focus();
  platform = "ios";
  label(hooks.tree, "reminders.time").props.onPress();
  render();
  const picker = find(hooks.tree, "Picker");
  picker.props.onValueChange({}, new Date(2000, 0, 1, 16, 20));
  render();
  label(hooks.tree, "entry.save").props.onPress();
  assert.equal(new Date(saves.at(-1).at).getFullYear(), 2027);
  assert.equal(new Date(saves.at(-1).at).getHours(), 16);
  busy = true;
  render();
  picker.props.onValueChange({}, new Date(2000, 0, 1, 1));
  render();
  assert.equal(
    find(hooks.tree, "Picker").props.value.getHours(),
    16,
    "late native callback cannot modify a busy editor",
  );
  busy = false;
  render();
  label(hooks.tree, "reminders.weekly").props.onPress();
  render();
  label(hooks.tree, "weekday:4").props.onPress();
  render();
  assert.equal(label(hooks.tree, "weekday:4").props.accessibilityRole, "checkbox");
  assert.equal(label(hooks.tree, "weekday:4").props.accessibilityState.checked, true);
  label(hooks.tree, "entry.save").props.onPress();
  assert.deepEqual(saves.at(-1).weekdays, [0, 4], "weekly editor supports several selected days");
  label(hooks.tree, "weekday:0").props.onPress();
  render();
  label(hooks.tree, "entry.save").props.onPress();
  assert.equal(saves.at(-1).kind, "weekly", "single-day saves retain the legacy storage kind");
  assert.equal(saves.at(-1).weekday, 4);
  label(hooks.tree, "weekday:4").props.onPress();
  render();
  assert.equal(
    label(hooks.tree, "entry.save").props.disabled,
    true,
    "an empty weekday selection cannot be saved",
  );
  const beforeInvalid = saves.length;
  label(hooks.tree, "entry.save").props.onPress();
  assert.equal(saves.length, beforeInvalid);
  label(hooks.tree, "reminders.monthly").props.onPress();
  render();
  label(hooks.tree, "months:2").props.onPress();
  render();
  label(hooks.tree, "reminders.monthlyDate").props.onPress();
  render();
  const monthlyPicker = find(hooks.tree, "Picker");
  assert.equal(
    monthlyPicker.props.minimumDate,
    undefined,
    "monthly date sets a phase, not a start deadline",
  );
  monthlyPicker.props.onValueChange({}, new Date(2027, 0, 31, 0));
  render();
  assert.equal(label(hooks.tree, "entry.save").props.disabled, true);
  assert.ok(nodes(hooks.tree).some((node) => node.props.children === "reminders.monthDayRange"));
  find(hooks.tree, "Picker").props.onValueChange({}, new Date(2027, 10, 28, 0));
  render();
  label(hooks.tree, "entry.save").props.onPress();
  assert.deepEqual(saves.at(-1), {
    kind: "monthly",
    day: 28,
    anchorMonth: 10,
    intervalMonths: 2,
    hour: 16,
    minute: 20,
  });
  assert.ok(nodes(hooks.tree).some((node) => node.props.children === "reminders.monthlyCalendar"));
  hooks.unmount();
  picker.props.onValueChange({}, new Date());
  assert.equal(hooks.lateWrites, 0);
}

function screenFixture(global = false) {
  const hooks = uiHooks(),
    focus = focusBoundary(hooks),
    writes: any[] = [],
    completions: any[] = [],
    routes: any[] = [],
    notices: any[] = [],
    events: string[] = [];
  let owner = "account:a",
    install = "sqlite-install",
    device = "private-device",
    permissions = 0,
    reconciles = 0;
  let saveGate: Promise<void> | null = null,
    saveError: Error | null = null;
  let hardwareBack: (() => boolean) | null = null;
  const row = {
    id: "reminder",
    owner_scope: owner,
    install_id: device,
    vault_id: "house",
    vault_name: "House",
    person_id: "customer",
    person_name: "Customer",
    schedule_json: JSON.stringify({ kind: "once", at: Date.now() - 1000 }),
    next_due_at: Date.now() - 1000,
    updated_at: 1,
  };
  const state = {
    rows: [] as any[],
    due: [] as any[],
    now: Date.now(),
    loaded: true,
    failed: false,
    customer: { name: "Customer" } as any,
    refresh: async () => {
      events.push("refresh");
    },
  };
  const dbMock = { getInstallIdSync: () => install, getActiveVaultIdSyncMaybe: () => "house" };
  const storage = {
    reminderOwnerScope: () => owner,
    readReminderSchedule: (r: any) => JSON.parse(r.schedule_json),
    saveCustomerReminder: async (...args: any[]) => {
      events.push("save");
      writes.push(args);
      if (saveGate) await saveGate;
      if (saveError) throw saveError;
      return "new-reminder";
    },
    dismissCustomerReminder: async (...args: any[]) => {
      completions.push(args);
    },
  };
  const notification = {
    requestReminderNotifications: async () => {
      permissions++;
      events.push("permission");
      return "denied";
    },
    reconcileReminderNotifications: async () => {
      reconciles++;
      events.push("reconcile");
    },
  };
  const mocks: any = {
    "react/jsx-runtime": jsxRuntime,
    react: hooks.react,
    "expo-router": {
      ...focus,
      Stack: { Screen: "StackScreen" },
      useRouter: () => ({ back: () => routes.push("back"), push: (r: any) => routes.push(r) }),
      useLocalSearchParams: () => ({ id: "customer", vaultId: "house" }),
    },
    "react-native": {
      ...primitives,
      BackHandler: {
        addEventListener: (_: string, fn: any) => {
          hardwareBack = fn;
          return {
            remove() {
              hardwareBack = null;
            },
          };
        },
      },
    },
    "react-native-safe-area-context": { SafeAreaView: "SafeArea" },
  };
  for (const prefix of ["../", "../../../"]) {
    Object.assign(mocks, {
      [prefix + "components/Button"]: { Button: "Button" },
      [prefix + "components/ConfirmDialog"]: { ConfirmDialog: "Confirm" },
      [prefix + "components/CustomerReminderRow"]: { CustomerReminderRow: "Row" },
      [prefix + "components/ReminderEditor"]: { ReminderEditor: "Editor" },
      [prefix + "components/SettingsScreen"]: { ScreenHeader: "Header" },
      [prefix + "components/Toast"]: {
        useToast: () => ({ push: (...a: any[]) => notices.push(a) }),
      },
      [prefix + "lib/calendar"]: { useCalendar() {} },
      [prefix + "lib/colors"]: { colors },
      [prefix + "lib/customer-reminders"]: storage,
      [prefix + "lib/db-tx"]: dbMock,
      [prefix + "lib/reminder-device"]: { getReminderDeviceIdSync: () => device },
      [prefix + "lib/direction"]: direction,
      [prefix + "lib/i18n"]: { t: (key: string) => key },
      [prefix + "lib/reminder-notifications"]: notification,
      [prefix + "lib/reminder-schedule"]: schedule,
      [prefix + "lib/tokens"]: tokens,
      [prefix + "lib/use-customer-reminders"]: { useCustomerReminders: () => state },
      [prefix + "lib/open-customer-reminder"]: {
        openCustomerReminder: async (...a: any[]) => routes.push(a),
      },
    });
  }
  const Screen = compileUI(
    global ? "../../app/reminders" : "../../app/person/[id]/reminders",
    mocks,
  ).default;
  const render = () => hooks.render(() => Screen());
  render();
  return {
    hooks,
    focus,
    writes,
    completions,
    routes,
    notices,
    events,
    state,
    row,
    render,
    get permissions() {
      return permissions;
    },
    get reconciles() {
      return reconciles;
    },
    back: () => hardwareBack?.(),
    account: (value: string) => {
      owner = value;
      state.rows = [];
      state.due = [];
      state.customer = null;
    },
    gate: (value: Promise<void> | null) => {
      saveGate = value;
    },
    fail: (value: Error | null) => {
      saveError = value;
    },
  };
}
async function screenTests() {
  const f = screenFixture();
  assert.equal(f.permissions, 0, "visiting setup never prompts notification permission");
  assert.equal(f.completions.length, 0);
  const save = find(f.hooks.tree, "Editor").props.onSave;
  const gate = deferred<void>();
  f.gate(gate.promise);
  save({ kind: "daily", hour: 9, minute: 30 });
  save({ kind: "daily", hour: 9, minute: 30 });
  f.render();
  assert.equal(f.writes.length, 1, "rapid save is single flight");
  assert.equal(f.back(), true, "hardware back is blocked while save runs");
  assert.equal(find(f.hooks.tree, "StackScreen").props.options.gestureEnabled, false);
  assert.equal(f.permissions, 0, "persist first, then request permission");
  gate.resolve();
  await settleUI();
  f.render();
  assert.deepEqual(f.events.slice(0, 3), ["save", "permission", "reconcile"]);
  assert.equal(f.notices.at(-1)[0], "reminders.permissionDenied");
  assert.equal(f.writes[0][0], "house", "saved explicit scoped kaata");
  f.state.rows = [f.row];
  f.state.due = [f.row];
  f.render();
  find(f.hooks.tree, "Row").props.onDone();
  await settleUI();
  f.render();
  assert.deepEqual(f.completions, [["reminder", false]], "completion is explicit only");
  f.state.rows = [{ ...f.row, next_due_at: Date.now() + 1000 }];
  f.render();
  find(f.hooks.tree, "Row").props.onDone();
  await settleUI();
  assert.equal(f.completions.length, 1, "future reminder cannot be completed by stale handler");

  const blur = screenFixture(),
    pending = deferred<void>();
  blur.gate(pending.promise);
  find(blur.hooks.tree, "Editor").props.onSave({ kind: "daily", hour: 9, minute: 30 });
  blur.focus.blur();
  blur.focus.focus();
  pending.resolve();
  await settleUI();
  assert.equal(blur.permissions, 0, "blur and refocus invalidates late permission continuation");
  assert.equal(blur.notices.length, 0);
  const switcher = screenFixture(),
    accountGate = deferred<void>();
  switcher.gate(accountGate.promise);
  const oldHandler = find(switcher.hooks.tree, "Editor").props.onSave;
  oldHandler({ kind: "daily", hour: 9, minute: 30 });
  switcher.account("account:b");
  switcher.render();
  accountGate.resolve();
  await settleUI();
  assert.equal(switcher.permissions, 0);
  assert.ok(
    !nodes(switcher.hooks.tree).some((node) => node.type === "Editor"),
    "old account editor disappears immediately",
  );
  const failing = screenFixture();
  failing.fail(new Error("reminder_limit"));
  find(failing.hooks.tree, "Editor").props.onSave({ kind: "daily", hour: 9, minute: 0 });
  await settleUI();
  failing.render();
  assert.equal(failing.permissions, 0);
  assert.ok(nodes(failing.hooks.tree).some((node) => node.props.children === "reminders.limit"));
  const slots = screenFixture();
  slots.fail(new Error("reminder_notification_limit"));
  find(slots.hooks.tree, "Editor").props.onSave({
    kind: "monthly",
    day: 15,
    anchorMonth: 0,
    intervalMonths: 2,
    hour: 9,
    minute: 0,
  });
  await settleUI();
  slots.render();
  assert.equal(slots.permissions, 0);
  assert.ok(
    nodes(slots.hooks.tree).some((node) => node.props.children === "reminders.scheduleLimit"),
  );
  const unmount = screenFixture(),
    unmountGate = deferred<void>();
  unmount.gate(unmountGate.promise);
  find(unmount.hooks.tree, "Editor").props.onSave({ kind: "daily", hour: 9, minute: 0 });
  unmount.hooks.unmount();
  unmountGate.resolve();
  await settleUI();
  assert.equal(unmount.hooks.lateWrites, 0);
  assert.equal(unmount.permissions, 0);
  const all = screenFixture(true);
  all.state.rows = [all.row];
  all.state.due = [all.row];
  all.render();
  const globalRow = find(all.hooks.tree, "Row");
  assert.equal(globalRow.props.showVault, true);
  globalRow.props.onOpen();
  await settleUI();
  assert.equal(all.completions.length, 0, "open does not mark done");
  globalRow.props.onEdit();
  assert.deepEqual(all.routes.at(-1), {
    pathname: "/person/[id]/reminders",
    params: { id: "customer", vaultId: "house", reminderId: "reminder" },
  });
  globalRow.props.onRemove();
  all.render();
  find(all.hooks.tree, "Confirm").props.onConfirm();
  await settleUI();
  assert.deepEqual(all.completions, [["reminder", true]]);
}

async function hookTests() {
  const hooks = uiHooks(),
    focus = focusBoundary(hooks),
    identity = new Set<() => void>(),
    ledger = new Set<() => void>(),
    changed = new Set<() => void>(),
    resumes = new Set<(s: string) => void>();
  let owner = "account:a",
    install = "sqlite-install",
    vault = "house",
    person = "customer",
    active = true,
    timer: (() => void) | null = null,
    gate: Promise<any[]> | null = null;
  let rows: any[] = [{ id: "due", next_due_at: Date.now() - 1 }],
    calls = 0;
  const on = (set: Set<any>) => (fn: any) => {
    set.add(fn);
    return () => set.delete(fn);
  };
  const { useCustomerReminders } = compileUI(
    "../use-customer-reminders",
    {
      react: hooks.react,
      "expo-router": focus,
      "react-native": {
        AppState: {
          addEventListener: (_: string, fn: any) => {
            resumes.add(fn);
            return { remove: () => resumes.delete(fn) };
          },
        },
      },
      "./db-tx": { getInstallIdSync: () => install, onAccountIdentityChanged: on(identity) },
      "./customer-reminders": {
        listCustomerReminders: async () => {
          calls++;
          return gate ? gate : rows;
        },
        readReminderCustomer: async () => ({ name: "Customer" }),
        onCustomerRemindersChanged: on(changed),
        reminderOwnerScope: () => owner,
      },
      "./ledger-events": { onLedgerApplied: on(ledger) },
    },
    {
      setInterval: (fn: any) => {
        timer = fn;
        return 1;
      },
      clearInterval: () => {
        timer = null;
      },
    },
  );
  let state: any;
  const render = () =>
    hooks.render(() => {
      state = useCustomerReminders(vault, person, active);
      return jsx("Result", {});
    });
  render();
  await settleUI();
  render();
  assert.equal(state.due.length, 1);
  const old = deferred<any[]>();
  gate = old.promise;
  ledger.forEach((fn) => fn());
  await settleUI();
  owner = "account:b";
  rows = [];
  gate = null;
  identity.forEach((fn) => fn());
  render();
  assert.equal(state.rows.length, 0, "identity event clears rows synchronously");
  old.resolve([{ id: "private-old-account", next_due_at: 1 }]);
  await settleUI();
  render();
  assert.equal(state.rows.length, 0);
  rows = [{ id: "new-account", next_due_at: Date.now() - 1 }];
  resumes.forEach((fn) => fn("active"));
  await settleUI();
  render();
  assert.equal(state.rows[0].id, "new-account");
  const scope = deferred<any[]>();
  gate = scope.promise;
  vault = "other";
  render();
  assert.equal(state.rows.length, 0, "new vault cannot show previous scope while loading");
  scope.resolve([]);
  gate = null;
  await settleUI();
  render();
  assert.equal(state.rows.length, 0);
  const before = calls;
  focus.blur();
  ledger.forEach((fn) => fn());
  assert.equal(calls, before);
  focus.focus();
  await settleUI();
  render();
  assert.ok(calls > before);
  active = false;
  render();
  assert.equal(state.rows.length, 0);
  assert.equal(timer, null);
  hooks.unmount();
  assert.equal(identity.size + ledger.size + changed.size + resumes.size, 0);
  assert.equal(hooks.lateWrites, 0);
}

async function openTests() {
  let owner = "account:a",
    listed: any[] = [],
    gate: Promise<void> | null = null;
  const routes: any[] = [],
    vaults: string[] = [],
    listeners = new Set<() => void>();
  const id = "12345678-1234-1234-1234-123456789abc";
  const row = { id, vault_id: "house", person_id: "customer" };
  const { openCustomerReminder } = compileUI("../open-customer-reminder", {
    "expo-router": { router: { push: (r: any) => routes.push(r) } },
    "./currency": { applyVaultCurrency: async () => {} },
    "./db-tx": {
      onAccountIdentityChanged: (fn: any) => {
        listeners.add(fn);
        return () => listeners.delete(fn);
      },
      setActiveVaultId: async (id: string) => {
        vaults.push(id);
        if (gate) await gate;
      },
    },
    "./customer-reminders": {
      listCustomerReminders: async () => listed,
      reminderOwnerScope: () => owner,
    },
  });
  listed = [row];
  await openCustomerReminder("not-an-id", owner);
  await openCustomerReminder(id, "account:other");
  assert.equal(
    vaults.length,
    0,
    "payload owner and opaque UUID are checked before any route side effect",
  );
  await openCustomerReminder(id, owner);
  assert.deepEqual(routes[0], {
    pathname: "/person/[id]",
    params: { id: "customer", reminderId: id },
  });
  const removed = deferred<void>();
  gate = removed.promise;
  const removal = openCustomerReminder(id, owner);
  await settleUI();
  listed = [];
  removed.resolve();
  await removal;
  assert.equal(
    routes.length,
    1,
    "customer/membership removal while switching vault prevents navigation",
  );
  listed = [row];
  const switched = deferred<void>();
  gate = switched.promise;
  const switching = openCustomerReminder(id, owner);
  await settleUI();
  owner = "account:b";
  listeners.forEach((fn) => fn());
  switched.resolve();
  await switching;
  assert.equal(routes.length, 1);
  assert.equal(listeners.size, 0);
}

async function main() {
  await editorTests();
  await screenTests();
  await hookTests();
  await openTests();
  console.log(
    "Reminder UI: actual picker, screens, explicit completion, permission order, focus/account guards and live scoped hook passed.",
  );
}
void main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
