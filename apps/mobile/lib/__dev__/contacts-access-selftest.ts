// Permission recovery uses real helpers/hooks with synthetic native boundaries.
// System dialogs and Settings still need a phone smoke test.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";

(globalThis as any).__DEV__ = false;
let permission = { granted: false, canAskAgain: true, accessPrivileges: "none" };
let requested = { ...permission };
let prompts = 0,
  settings = 0,
  stateWrites = 0;
let listener: ((state: string) => void) | null = null;
let settingsFail = false;
const native = {
  getPermissionsAsync: async () => ({ ...permission }),
  requestPermissionsAsync: async () => {
    prompts++;
    listener?.("inactive");
    permission = { ...requested };
    listener?.("active");
    return { ...permission };
  },
  getContactsAsync: async () => ({
    data:
      permission.accessPrivileges === "limited"
        ? []
        : [
            {
              id: "1",
              name: "Matee Saafi",
              firstName: "Matee",
              lastName: "Saafi",
              phoneNumbers: [{ number: "+93780000000" }],
            },
          ],
  }),
  Fields: {},
  SortTypes: {},
};
function compile(path: string, mocks: Record<string, any>) {
  const exports: any = {};
  new Function(
    "require",
    "exports",
    ts.transpileModule(readFileSync(require.resolve(path), "utf8"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText,
  )((key: string) => {
    assert.ok(key in mocks, key);
    return mocks[key];
  }, exports);
  return exports;
}
const contacts = compile("../contacts-sync", { "expo-contacts/legacy": native });
let slots: any[] = [],
  cursor = 0,
  effect: (() => () => void) | null = null;
const hooks = compile("../use-device-contacts", {
  "./contacts-sync": contacts,
  react: {
    useState: (initial: any) => {
      const i = cursor++;
      if (!(i in slots)) slots[i] = initial;
      return [
        slots[i],
        (value: any) => {
          stateWrites++;
          slots[i] = value;
        },
      ];
    },
    useRef: (initial: any) => {
      const i = cursor++;
      return (slots[i] ??= { current: initial });
    },
    useCallback: (fn: any) => {
      const i = cursor++;
      return (slots[i] ??= fn);
    },
    useEffect: (fn: any) => {
      effect ??= fn;
    },
  },
  "react-native": {
    AppState: {
      currentState: "active",
      addEventListener: (_: string, fn: any) => {
        listener = fn;
        return {
          remove: () => {
            listener = null;
          },
        };
      },
    },
    Linking: {
      openSettings: async () => {
        settings++;
        if (settingsFail) throw new Error("Unavailable");
        listener?.("background");
      },
    },
  },
});
const render = () => {
  cursor = 0;
  return hooks.useDeviceContacts();
};
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

async function main() {
  assert.equal((await contacts.readDeviceContacts()).granted, false);
  assert.equal(prompts, 0, "passive reads must not prompt");
  await contacts.readDeviceContacts({ requestPermission: true });
  assert.equal(prompts, 1, "button explicitly requests access");
  permission.canAskAgain = false;
  await contacts.readDeviceContacts({ requestPermission: true });
  assert.equal(prompts, 1, "OS-denied re-prompt must not be attempted");

  render();
  const stop = effect!();
  await settle();
  assert.equal(render().access.canAskAgain, false);
  await Promise.all([render().requestAccess(), render().requestAccess()]);
  assert.equal(settings, 1, "double taps open Settings once");
  permission = { granted: true, canAskAgain: true, accessPrivileges: "all" };
  listener!("active");
  await settle();
  assert.equal(
    render().access.contacts[0].name,
    "Matee Saafi",
    "return from Settings refreshes without reopening screen",
  );
  assert.equal(prompts, 1, "return from Settings is silent");

  permission = { granted: false, canAskAgain: true, accessPrivileges: "none" };
  listener!("inactive");
  listener!("active");
  await settle();
  requested = { granted: true, canAskAgain: true, accessPrivileges: "all" };
  await render().requestAccess();
  assert.equal(prompts, 2, "system dialog resume does not trigger a second prompt");
  assert.equal(render().access.contacts.length, 1);

  permission = { granted: true, canAskAgain: false, accessPrivileges: "limited" };
  listener!("background");
  listener!("active");
  await settle();
  assert.equal(
    render().access.limited,
    true,
    "limited empty selection retains manage-access affordance",
  );
  assert.equal(render().access.contacts.length, 0);
  await render().requestAccess();
  assert.equal(settings, 2);
  assert.equal(prompts, 2);
  settingsFail = true;
  await render().requestAccess();
  assert.equal(render().failed, true, "Settings failures are visible and retryable");
  assert.equal(render().busy, false);
  settingsFail = false;
  await render().requestAccess();
  assert.equal(render().failed, false);
  stop();
  assert.equal(listener, null, "resume listener removed on unmount");
  const writes = stateWrites;
  await settle();
  assert.equal(stateWrites, writes);

  const screen = readFileSync(require.resolve("../../app/person/new"), "utf8");
  assert.ok(
    screen.indexOf("{renderContactsAccess()}") <
      screen.indexOf("{people === null || sections.length"),
    "access button precedes contact rows",
  );
  assert.match(screen, /contactsAccess.granted && !contactsAccess.limited/);
  assert.match(screen, /accessibilityRole="button"/);
  console.log(
    "PASS: explicit permission request, blocked/limited Settings recovery, resume reload, no repeat prompts, double-tap guard and cleanup",
  );
}
main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
