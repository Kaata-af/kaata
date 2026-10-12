// The real reminder-permission notice with a synthetic permission and Settings.
// With notifications off, reminders only show inside Kaata; this notice stays
// on the reminder screens (it used to be one toast at save time), never
// prompts, and re-reads the permission on return from Settings.
import assert from "node:assert/strict";
import { compileUI, jsx, nodes, settleUI, uiHooks } from "./ui-fixture";

async function main() {
  let status: "granted" | "denied" | "unavailable" = "granted";
  let reads = 0,
    settingsOpened = 0;
  const appListeners = new Set<(state: string) => void>();
  const hooks = uiHooks();
  const { ReminderPermissionNotice } = compileUI("../../components/ReminderPermissionNotice", {
    "react/jsx-runtime": { jsx, jsxs: jsx, Fragment: "Fragment" },
    react: hooks.react,
    "expo-router": { useFocusEffect: (fn: () => () => void) => hooks.react.useEffect(fn, [fn]) },
    "react-native": {
      AppState: {
        addEventListener: (_: string, fn: (state: string) => void) => {
          appListeners.add(fn);
          return { remove: () => appListeners.delete(fn) };
        },
      },
      Linking: {
        openSettings: async () => {
          settingsOpened++;
        },
      },
      StyleSheet: { create: (styles: any) => styles },
      Text: "Text",
      View: "View",
    },
    "./Button": { Button: "Button" },
    "../lib/colors": { colors: {} },
    "../lib/direction": { textDir: () => ({}) },
    "../lib/i18n": { t: (key: string) => key },
    "../lib/reminder-notifications": {
      reminderNotificationStatus: async () => {
        reads++;
        return status;
      },
    },
    "../lib/tokens": { radius: { md: 8 }, typography: { bodySm: {} } },
  });
  const render = () => hooks.render(() => ReminderPermissionNotice({ isRTL: false }));
  const shown = () =>
    nodes(hooks.tree).some((node) => node.props?.children === "reminders.notificationsOff");

  render();
  await settleUI();
  render();
  assert.equal(reads, 1, "the status is read on focus");
  assert.equal(shown(), false, "nothing shows while notifications are allowed");

  status = "denied";
  for (const listener of [...appListeners]) listener("active");
  await settleUI();
  render();
  assert.equal(shown(), true, "notifications off: the notice stays on screen");
  const button = nodes(hooks.tree).find((node) => node.type === "Button")!;
  assert.equal(button.props.label, "contacts.permission.button");
  button.props.onPress();
  await settleUI();
  assert.equal(settingsOpened, 1, "the button opens the system settings");

  status = "granted";
  for (const listener of [...appListeners]) listener("active");
  await settleUI();
  render();
  assert.equal(shown(), false, "back from Settings with notifications on: it goes away");

  status = "unavailable";
  for (const listener of [...appListeners]) listener("active");
  await settleUI();
  render();
  assert.equal(shown(), false, "Expo Go (no native notifications) shows nothing");
  hooks.unmount();
  assert.equal(appListeners.size, 0, "leaving the screen stops listening");
  console.log(
    "PASS: reminder permission notice shows only while notifications are off, opens Settings, re-reads on return, never prompts",
  );
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
