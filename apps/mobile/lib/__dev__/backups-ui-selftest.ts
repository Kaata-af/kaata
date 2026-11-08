import assert from "node:assert/strict";
import { compileUI, deferred, jsx, nodes, settleUI, uiHooks } from "./ui-fixture";

class PersonalBackupError extends Error {
  constructor(public code: string) {
    super(code);
  }
}

function fixture({ signedIn = true, platform = "android", directRestore = false } = {}) {
  const hooks = uiHooks();
  const identityListeners = new Set<() => void>();
  const stateListeners = new Set<() => void>();
  const timers = new Map<number, () => void>();
  const backHandlers = new Set<() => boolean>();
  const routes: any[] = [];
  let nextTimer = 0,
    focused = true,
    account = signedIn ? "account-a" : "local:a";
  let session: string | null = signedIn ? "account-a" : null;
  let offline = false,
    dismissed = 0,
    reads = 0,
    syncs = 0;
  let syncError: Error | null = null,
    receiptError: Error | null = null;
  let statusGate: Promise<any> | null = null,
    saveGate: Promise<any> | null = null;
  let saveResult: any = { displayName: "kaata-backup.zip", opaque: "original" };
  let restoreResult = false,
    restoreError: Error | null = null;
  const saves: { destination: string; password?: string }[] = [],
    restores: { format: string; password?: string }[] = [],
    recorded: any[] = [];
  const status = {
    signedIn,
    vaults: signedIn ? [{ id: "vault-a", name: "Shop", lastPushAt: 1000, pending: true }] : [],
    localBackupAt: 500,
  };
  const receipts: Record<string, any> = {};
  const AppState = {
    currentState: "active",
    addEventListener: (_: string, callback: () => void) => {
      stateListeners.add(callback);
      return { remove: () => stateListeners.delete(callback) };
    },
  };
  const react = {
    ...hooks.react,
    useSyncExternalStore(subscribe: (notify: () => void) => () => void, read: () => string) {
      const [, update] = hooks.react.useState(0);
      hooks.react.useEffect(
        () => subscribe(() => update((value: number) => value + 1)),
        [subscribe],
      );
      return read();
    },
  };
  const Screen = compileUI(
    "../../app/backups",
    {
      react,
      "react/jsx-runtime": { jsx, jsxs: jsx, Fragment: "Fragment" },
      "expo-router": {
        Stack: { Screen: "StackScreen" },
        useRouter: () => ({
          push: (route: any) => routes.push(route),
          replace: (route: any) => routes.push(route),
          canGoBack: () => true,
          back: () => routes.push("back"),
        }),
        useIsFocused: () => focused,
        useLocalSearchParams: () => (directRestore ? { restore: "1" } : {}),
      },
      "expo-network": {
        useNetworkState: () => ({ isConnected: !offline, isInternetReachable: !offline }),
      },
      "react-native": {
        ActivityIndicator: "Spinner",
        AppState,
        BackHandler: {
          addEventListener: (_: string, callback: () => boolean) => {
            backHandlers.add(callback);
            return { remove: () => backHandlers.delete(callback) };
          },
        },
        Keyboard: { dismiss: () => dismissed++ },
        KeyboardAvoidingView: "KeyboardAvoidingView",
        Platform: { OS: platform },
        ScrollView: "ScrollView",
        Text: "Text",
        View: "View",
        StyleSheet: { create: (value: any) => value, hairlineWidth: 0.5 },
      },
      "react-native-safe-area-context": { SafeAreaView: "SafeAreaView" },
      "../components/Button": { Button: "Button" },
      "../components/ConfirmDialog": { ConfirmDialog: "ConfirmDialog" },
      "../components/PasswordField": { PasswordField: "PasswordField" },
      "../components/SettingsScreen": {
        NavRow: "NavRow",
        ScreenHeader: "ScreenHeader",
        SectionGap: "Gap",
        SectionHeader: "SectionHeader",
      },
      "../lib/backup-status": {
        readBackupStatus: async () => {
          reads++;
          return statusGate ?? { ...status, vaults: [...status.vaults] };
        },
        syncBackupNow: async () => {
          syncs++;
          if (syncError) throw syncError;
        },
      },
      "../lib/colors": { colors: {} },
      "../lib/db-tx": {
        getAccountIdSync: () => account,
        getSessionAccountIdSync: () => session,
        onAccountIdentityChanged: (callback: () => void) => {
          identityListeners.add(callback);
          return () => identityListeners.delete(callback);
        },
      },
      "../lib/direction": { useIsRTL: () => false, textDir: () => ({}) },
      "../lib/format": { formatTimestamp: (value: number) => "date:" + value },
      "../lib/i18n": {
        t: (key: string, values?: any) => key + (values ? JSON.stringify(values) : ""),
      },
      "../lib/personal-backup": {
        PersonalBackupError,
        readPersonalBackupReceipts: async () => ({ ...receipts }),
        savePersonalBackup: async (destination: string, password?: string) => {
          saves.push({ destination, password });
          return saveGate ?? saveResult;
        },
        recordPersonalBackup: async (destination: string, result: any) => {
          recorded.push({ destination, result });
          if (receiptError) throw receiptError;
          receipts[destination] = { displayName: result.displayName, savedAt: 2000 };
        },
        restorePersonalBackup: async (format: string, password?: string) => {
          restores.push({ format, password });
          if (restoreError) throw restoreError;
          return restoreResult;
        },
      },
      "../lib/tokens": { gutter: { settings: 20 }, typography: {} },
    },
    {
      setInterval: (callback: () => void) => {
        timers.set(++nextTimer, callback);
        return nextTimer;
      },
      clearInterval: (id: number) => timers.delete(id),
    },
  ).default;
  const render = () => hooks.render(() => Screen());
  const flush = async () => {
    for (let i = 0; i < 5; i++) {
      await settleUI();
      render();
    }
  };
  const find = (label: string) => nodes(hooks.tree).find((node) => node.props.label === label);
  const text = () =>
    nodes(hooks.tree)
      .filter((node) => node.type === "Text")
      .map((node) => node.props.children)
      .join(" ");
  const dialog = () => nodes(hooks.tree).find((node) => node.type === "ConfirmDialog")!;
  const fill = (password = "long-password-123", confirm = password) => {
    find("backups.password")!.props.onChangeText(password);
    find("backups.confirmPassword")?.props.onChangeText(confirm);
    render();
  };
  render();
  return {
    hooks,
    render,
    flush,
    find,
    text,
    dialog,
    fill,
    saves,
    restores,
    recorded,
    routes,
    status,
    receipts,
    timers,
    backHandlers,
    saveResult,
    get reads() {
      return reads;
    },
    get syncs() {
      return syncs;
    },
    get dismissed() {
      return dismissed;
    },
    statusGate: (gate: Promise<any> | null) => {
      statusGate = gate;
    },
    saveGate: (gate: Promise<any> | null) => {
      saveGate = gate;
    },
    saveValue: (value: any) => {
      saveResult = value;
    },
    syncError: (error: Error | null) => {
      syncError = error;
    },
    receiptError: (error: Error | null) => {
      receiptError = error;
    },
    restoreError: (error: Error | null) => {
      restoreError = error;
    },
    restoreValue: (value: boolean) => {
      restoreResult = value;
    },
    setOffline: (value: boolean) => {
      offline = value;
      render();
    },
    focus: (value: boolean) => {
      focused = value;
      render();
    },
    identity: (value: string, signed: string | null = value) => {
      account = value;
      session = signed;
      identityListeners.forEach((callback) => callback());
    },
    appState: (value: string) => {
      AppState.currentState = value;
      stateListeners.forEach((callback) => callback());
      render();
    },
  };
}

async function main() {
  for (const platform of ["android", "ios"]) {
    const f = fixture({ platform });
    await f.flush();
    assert.equal(f.hooks.tree.type, "SafeAreaView");
    assert.deepEqual(f.hooks.tree.props.edges, ["top", "bottom"]);
    assert.ok(f.text().includes('backups.lastUpload{"when":"date:1000"}'));
    assert.ok(f.text().includes("backups.pending"));
    assert.ok(f.text().includes('backups.localSaved{"when":"date:500"}'));
    assert.ok(f.find("backups.googleDrive")!.props.hint.includes("backups.googleFormat"));
    assert.equal(f.find("backups.googleDrive")!.props.hintLines, 0);
    assert.equal(Boolean(f.find("backups.icloudDrive")), platform === "ios");
    f.find("backups.restoreCloud")!.props.onPress();
    f.find("backups.restoreCloud")!.props.onPress();
    assert.deepEqual(f.routes, ["/restore"]);
    f.hooks.unmount();
  }

  const ninja = fixture({ signedIn: false });
  await ninja.flush();
  assert.ok(ninja.text().includes("backups.cloudSignedOut"));
  assert.equal(ninja.find("backups.syncNow"), undefined);
  assert.ok(ninja.find("backups.googleDrive"));
  assert.ok(ninja.find("backups.restorePersonal"));
  ninja.find("backups.googleDrive")!.props.onPress();
  ninja.render();
  assert.ok(ninja.text().includes("backups.googlePrivacy"));
  assert.equal(ninja.find("backups.password"), undefined);
  assert.equal(ninja.find("backups.confirmPassword"), undefined);
  assert.deepEqual(ninja.saves, [], "opening the form never creates an unencrypted copy");

  const gate = deferred<any>();
  ninja.saveGate(gate.promise);
  const save = ninja.find("backups.saveZip")!.props.onPress;
  save();
  save();
  ninja.render();
  assert.deepEqual(
    ninja.saves,
    [{ destination: "googleDrive", password: undefined }],
    "a double press creates one ZIP with no password",
  );
  assert.equal(
    [...ninja.backHandlers][0](),
    true,
    "Back cannot leave while a file operation is running",
  );
  gate.resolve(ninja.saveResult);
  await ninja.flush();
  assert.equal(ninja.dialog().props.visible, true);
  assert.equal(ninja.recorded.length, 0, "returning from Files never implies a saved copy");
  const confirm = ninja.dialog().props.onConfirm;
  confirm();
  confirm();
  await ninja.flush();
  assert.equal(ninja.recorded.length, 1);
  assert.equal(
    ninja.recorded[0].result,
    ninja.saveResult,
    "the opaque owner-bound result is passed unchanged",
  );
  assert.equal(ninja.recorded[0].destination, "googleDrive");
  assert.ok(ninja.find("backups.googleDrive")!.props.hint.includes("date:2000"));
  ninja.hooks.unmount();

  const icloud = fixture({ platform: "ios" });
  await icloud.flush();
  icloud.find("backups.icloudDrive")!.props.onPress();
  icloud.render();
  assert.ok(icloud.text().includes("backups.passwordHint"));
  for (const invalid of ["short", "🔒".repeat(6), "x".repeat(257)]) {
    icloud.fill(invalid);
    icloud.find("backups.saveCopy")!.props.onPress();
    icloud.render();
    assert.ok(icloud.text().includes("backups.passwordMin"));
  }
  icloud.fill("long-password-123", "not-the-same-password");
  icloud.find("backups.saveCopy")!.props.onPress();
  icloud.render();
  assert.ok(icloud.text().includes("backups.passwordMismatch"));
  assert.deepEqual(icloud.saves, []);
  const encrypted = { displayName: "kaata-backup.kaatabackup", opaque: "encrypted" };
  const encryptedGate = deferred<typeof encrypted>();
  icloud.saveGate(encryptedGate.promise);
  icloud.fill();
  icloud.find("backups.saveCopy")!.props.onPress();
  icloud.render();
  assert.deepEqual(icloud.saves, [{ destination: "icloudDrive", password: "long-password-123" }]);
  assert.equal(icloud.find("backups.password")!.props.value, "", "password clears before Files");
  encryptedGate.resolve(encrypted);
  await icloud.flush();
  icloud.dialog().props.onConfirm();
  await icloud.flush();
  assert.deepEqual(icloud.recorded, [{ destination: "icloudDrive", result: encrypted }]);
  assert.ok(icloud.find("backups.icloudDrive")!.props.hint.includes("date:2000"));
  icloud.hooks.unmount();

  const cancelled = fixture();
  await cancelled.flush();
  cancelled.saveValue(null);
  cancelled.find("backups.googleDrive")!.props.onPress();
  cancelled.render();
  cancelled.find("backups.saveZip")!.props.onPress();
  await cancelled.flush();
  assert.equal(cancelled.dialog().props.visible, false);
  assert.deepEqual(cancelled.recorded, []);
  cancelled.saveValue(cancelled.saveResult);
  cancelled.find("backups.saveZip")!.props.onPress();
  await cancelled.flush();
  cancelled.dialog().props.onCancel();
  cancelled.render();
  assert.deepEqual(cancelled.recorded, [], "Not saved preserves the previous receipt");
  cancelled.hooks.unmount();

  const recordFailure = fixture();
  await recordFailure.flush();
  recordFailure.find("backups.googleDrive")!.props.onPress();
  recordFailure.render();
  recordFailure.find("backups.saveZip")!.props.onPress();
  await recordFailure.flush();
  recordFailure.receiptError(new PersonalBackupError("sessionChanged"));
  recordFailure.dialog().props.onConfirm();
  await recordFailure.flush();
  assert.ok(
    recordFailure.dialog().props.description.includes("backups.error.sessionChanged"),
    "a receipt failure is visible above the dialog backdrop",
  );
  assert.ok(recordFailure.find("backups.googleDrive")!.props.hint.includes("backups.notSaved"));
  recordFailure.hooks.unmount();

  const restore = fixture({ signedIn: false, directRestore: true });
  await restore.flush();
  assert.ok(restore.find("backups.restoreZip"), "restore=1 opens the format choice");
  assert.ok(restore.find("backups.restoreEncrypted"));
  assert.equal(restore.find("backups.chooseFile"), undefined);
  restore.find("backups.restoreZip")!.props.onPress();
  restore.render();
  assert.equal(restore.find("backups.password"), undefined);
  assert.equal(restore.find("backups.confirmPassword"), undefined);
  assert.ok(restore.text().includes("backups.restoreRestriction"));
  restore.find("backups.chooseFile")!.props.onPress();
  await restore.flush();
  assert.deepEqual(restore.restores, [{ format: "zip", password: undefined }]);
  assert.deepEqual(restore.recorded, [], "file-picker cancel never records a save or restore");
  restore.restoreError(new PersonalBackupError("notEmpty"));
  restore.find("backups.chooseFile")!.props.onPress();
  await restore.flush();
  assert.ok(restore.text().includes("backups.error.notEmpty"));
  restore.hooks.unmount();

  const oldRestore = fixture({ directRestore: true, platform: "ios" });
  await oldRestore.flush();
  oldRestore.find("backups.restoreEncrypted")!.props.onPress();
  oldRestore.render();
  assert.equal(oldRestore.find("backups.confirmPassword"), undefined);
  oldRestore.find("backups.chooseFile")!.props.onPress();
  oldRestore.render();
  assert.ok(oldRestore.text().includes("backups.passwordMin"));
  assert.deepEqual(oldRestore.restores, []);
  oldRestore.fill();
  oldRestore.restoreError(new PersonalBackupError("legacyUnsupported"));
  oldRestore.find("backups.chooseFile")!.props.onPress();
  await oldRestore.flush();
  assert.deepEqual(oldRestore.restores, [{ format: "encrypted", password: "long-password-123" }]);
  assert.ok(oldRestore.text().includes("backups.error.legacyUnsupported"));
  oldRestore.hooks.unmount();

  for (const stale of ["account", "aba", "focus", "unmount"] as const) {
    const f = fixture();
    await f.flush();
    f.find("backups.googleDrive")!.props.onPress();
    f.render();
    const pending = deferred<any>();
    f.saveGate(pending.promise);
    f.find("backups.saveZip")!.props.onPress();
    f.render();
    if (stale === "account" || stale === "aba") {
      f.identity("account-b");
      if (stale === "aba") f.identity("account-a");
      f.render();
    } else if (stale === "focus") {
      f.focus(false);
      f.focus(true);
    } else f.hooks.unmount();
    pending.resolve(f.saveResult);
    if (stale === "unmount") await settleUI();
    else await f.flush();
    assert.equal(f.dialog().props.visible, false, stale + " cannot show an old save confirmation");
    assert.deepEqual(f.recorded, []);
    assert.equal(f.hooks.lateWrites, 0);
    if (stale !== "unmount") f.hooks.unmount();
  }

  const stalePress = fixture();
  await stalePress.flush();
  const oldPress = stalePress.find("backups.restoreCloud")!.props.onPress;
  stalePress.identity("account-b");
  oldPress();
  assert.deepEqual(
    stalePress.routes,
    [],
    "identity changes block retained actions before a rerender",
  );
  stalePress.hooks.unmount();

  const staleRead = fixture();
  await staleRead.flush();
  const lateStatus = deferred<any>();
  staleRead.statusGate(lateStatus.promise);
  [...staleRead.timers.values()][0]();
  staleRead.statusGate(null);
  staleRead.status.vaults[0].name = "New account Kaata";
  staleRead.identity("account-b");
  await staleRead.flush();
  lateStatus.resolve({
    signedIn: true,
    vaults: [{ id: "old", name: "Old private Kaata", lastPushAt: 9999, pending: false }],
    localBackupAt: 9999,
  });
  await staleRead.flush();
  assert.ok(staleRead.text().includes("New account Kaata"));
  assert.ok(
    !staleRead.text().includes("Old private Kaata"),
    "an old-account status response cannot replace the new view",
  );
  staleRead.hooks.unmount();

  const lifecycle = fixture();
  await lifecycle.flush();
  const reads = lifecycle.reads;
  assert.equal(lifecycle.timers.size, 1);
  lifecycle.appState("background");
  assert.equal(lifecycle.timers.size, 0);
  lifecycle.find("backups.googleDrive")!.props.onPress();
  lifecycle.render();
  assert.equal(
    lifecycle.find("backups.saveZip"),
    undefined,
    "background callbacks cannot open a save form",
  );
  lifecycle.appState("active");
  await lifecycle.flush();
  assert.ok(lifecycle.reads > reads, "returning to Settings refreshes backup status");
  lifecycle.setOffline(true);
  lifecycle.find("backups.syncNow")!.props.onPress();
  assert.equal(lifecycle.syncs, 0);
  lifecycle.setOffline(false);
  lifecycle.syncError(new Error("incomplete"));
  lifecycle.find("backups.syncNow")!.props.onPress();
  await lifecycle.flush();
  assert.ok(lifecycle.text().includes("backups.syncFailed"));
  assert.ok(
    lifecycle.text().includes('backups.lastUpload{"when":"date:1000"}'),
    "a failed sync does not invent a fresh timestamp",
  );
  lifecycle.hooks.unmount();
  assert.equal(lifecycle.timers.size, 0);

  console.log(
    "PASS Backups UI: ZIP consent, encrypted iCloud, format-specific restore, scoped receipts and lifecycle",
  );
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
