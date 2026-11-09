import assert from "node:assert/strict";
import type { PersonalBackupCoverage } from "../personal-backup-db";
import type { PersonalCloudProviderId, PersonalCloudStatus } from "../personal-cloud-backup";
import { compileUI, deferred, jsx, nodes, settleUI, uiHooks } from "./ui-fixture";

class PersonalBackupError extends Error {
  constructor(public code: string) {
    super(code);
  }
}
class PersonalCloudProviderError extends PersonalBackupError {}

type BackupChoice = { name: string; createdAt: number };
type SavedFile = { displayName: string; coverage: PersonalBackupCoverage };

function fixture({ signedIn = true, platform = "android", directRestore = false } = {}) {
  const hooks = uiHooks();
  const identityListeners = new Set<() => void>();
  const stateListeners = new Set<() => void>();
  const providerListeners = new Set<() => void>();
  const timers = new Map<number, () => void>();
  const backHandlers = new Set<() => boolean>();
  const routes: string[] = [];
  let nextTimer = 0;
  let focused = true;
  let account = signedIn ? "account-a" : "local:a";
  let session: string | null = signedIn ? "account-a" : null;
  let offline = false;
  let reads = 0;
  let syncs = 0;
  let syncError: Error | null = null;
  let statusGate: Promise<any> | null = null;
  let providerGate: Promise<any> | null = null;
  let enableResult: boolean | Promise<boolean> = true;
  let findResult: BackupChoice | null | undefined | Promise<BackupChoice | null | undefined>;
  let findError: Error | null = null;
  let fileError: Error | null = null;
  let fileSaveError: Error | null = null;
  let fileSaveResult: SavedFile | null | Promise<SavedFile | null> = null;
  let fileSaves = 0;
  const fileRestores: unknown[][] = [];
  const toasts: [string, string][] = [];
  const operations: [string, PersonalCloudProviderId][] = [];
  const cloudRestores: BackupChoice[] = [];
  const status = {
    signedIn,
    cloudUpToDate: false,
    vaults: signedIn ? [{ id: "vault-a", name: "Shop", lastPushAt: 1000, pending: true }] : [],
    localBackupAt: 500,
  };
  const providers: Partial<Record<PersonalCloudProviderId, PersonalCloudStatus>> = {};
  const supported = { googleDrive: true, icloudDrive: true };
  const notify = () => providerListeners.forEach((listener) => listener());
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
          push: (route: string) => routes.push(route),
          replace: (route: string) => routes.push(route),
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
        Platform: { OS: platform },
        ScrollView: "ScrollView",
        Text: "Text",
        View: "View",
        StyleSheet: { create: (value: any) => value, hairlineWidth: 0.5 },
      },
      "react-native-safe-area-context": { SafeAreaView: "SafeAreaView" },
      "../components/Button": { Button: "Button" },
      "../components/ConfirmDialog": { ConfirmDialog: "ConfirmDialog" },
      "../components/Toast": {
        useToast: () => ({ push: (message: string, kind: string) => toasts.push([message, kind]) }),
      },
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
          status.cloudUpToDate = true;
          for (const vault of status.vaults) vault.pending = false;
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
      "../lib/direction": {
        useIsRTL: () => false,
        textDir: () => ({}),
        ltrIsolate: (value: string) => value,
      },
      "../lib/format": { formatTimestamp: (value: number) => "date:" + value },
      "../lib/i18n": {
        t: (key: string, values?: any) => key + (values ? JSON.stringify(values) : ""),
      },
      "../lib/personal-backup": {
        PersonalBackupError,
        savePersonalBackupToPhone: async () => {
          fileSaves++;
          if (fileSaveError) throw fileSaveError;
          return fileSaveResult;
        },
        restorePersonalBackup: async (...args: unknown[]) => {
          fileRestores.push(args);
          if (fileError) throw fileError;
          return false;
        },
      },
      "../lib/personal-cloud-backup": {
        PersonalCloudProviderError,
        isPersonalCloudBackupSupported: (id: PersonalCloudProviderId) => supported[id],
        readPersonalCloudBackupStatuses: async () => providerGate ?? { ...providers },
        subscribePersonalCloudBackup: (listener: () => void) => {
          providerListeners.add(listener);
          return () => providerListeners.delete(listener);
        },
        enablePersonalCloudBackup: async (id: PersonalCloudProviderId) => {
          operations.push(["connect", id]);
          const next = await enableResult;
          if (next) {
            providers[id] = { connection: { id: "cloud-account", label: "test@example.org" } };
            notify();
          }
          return next;
        },
        disablePersonalCloudBackup: async (id: PersonalCloudProviderId) => {
          operations.push(["disable", id]);
          delete providers[id];
          notify();
        },
        backUpToPersonalCloudNow: async (id: PersonalCloudProviderId) => {
          operations.push(["backup", id]);
          providers[id]!.savedAt = 2000;
          notify();
        },
        findLatestPersonalCloudBackup: async (id: PersonalCloudProviderId) => {
          operations.push(["find", id]);
          if (findError) throw findError;
          return findResult;
        },
        restoreLatestPersonalCloudBackup: async (choice: BackupChoice) => {
          cloudRestores.push(choice);
          return true;
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
  const find = (label: string) =>
    nodes(hooks.tree).find((node) => node.props.label?.startsWith(label));
  const text = () =>
    nodes(hooks.tree)
      .filter((node) => node.type === "Text")
      .map((node) => node.props.children)
      .join(" ");
  const dialog = () => nodes(hooks.tree).find((node) => node.type === "ConfirmDialog")!;
  const press = (label: string) => {
    find(label)!.props.onPress();
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
    press,
    notify,
    operations,
    cloudRestores,
    fileRestores,
    toasts,
    routes,
    status,
    providers,
    supported,
    timers,
    backHandlers,
    get reads() {
      return reads;
    },
    get syncs() {
      return syncs;
    },
    get fileSaves() {
      return fileSaves;
    },
    statusGate: (gate: Promise<any> | null) => {
      statusGate = gate;
    },
    providerGate: (gate: Promise<any> | null) => {
      providerGate = gate;
    },
    enableValue: (value: typeof enableResult) => {
      enableResult = value;
    },
    findValue: (value: typeof findResult) => {
      findResult = value;
    },
    syncError: (error: Error | null) => {
      syncError = error;
    },
    findError: (error: Error | null) => {
      findError = error;
    },
    fileError: (error: Error | null) => {
      fileError = error;
    },
    fileSaveError: (error: Error | null) => {
      fileSaveError = error;
    },
    fileSaveValue: (value: typeof fileSaveResult) => {
      fileSaveResult = value;
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
    assert.equal(f.find("backups.googleDrive")!.props.hint, "backups.automaticOff");
    assert.equal(f.find("backups.googleDrive")!.props.hintLines, 0);
    assert.equal(Boolean(f.find("backups.icloudDrive")), platform === "ios");
    assert.equal(f.find("backups.saveFile")!.props.disabled, false);
    f.press("backups.syncNow");
    await f.flush();
    assert.equal(f.find("backups.cloudUpToDate")!.props.variant, "success");
    f.find("backups.restoreCloud")!.props.onPress();
    f.find("backups.restoreCloud")!.props.onPress();
    assert.deepEqual(f.routes, ["/restore"]);
    f.hooks.unmount();
  }

  const ninja = fixture({ signedIn: false, platform: "ios" });
  await ninja.flush();
  assert.ok(ninja.text().includes("backups.cloudSignedOut"));
  assert.equal(ninja.find("backups.syncNow"), undefined);
  ninja.press("backups.googleDrive");
  assert.ok(ninja.text().includes("backups.readableBackup"));
  assert.deepEqual(ninja.operations, [], "opening a provider does not turn on backup");

  const connectionGate = deferred<boolean>();
  ninja.enableValue(connectionGate.promise);
  const connect = ninja.find("backups.connect")!.props.onPress;
  connect();
  connect();
  ninja.render();
  assert.deepEqual(ninja.operations, [["connect", "googleDrive"]]);
  assert.equal([...ninja.backHandlers][0](), true);
  connectionGate.resolve(false);
  await ninja.flush();
  assert.equal(ninja.find("backups.googleDrive")!.props.hint, "backups.automaticOff");
  ninja.enableValue(true);
  ninja.press("backups.connect");
  await ninja.flush();
  assert.ok(ninja.find("backups.googleDrive")!.props.hint.includes("backups.automaticOn"));
  assert.ok(ninja.find("backups.googleDrive")!.props.hint.includes("test@example.org"));
  ninja.press("backups.backUpNow");
  await ninja.flush();
  assert.ok(ninja.find("backups.googleDrive")!.props.hint.includes("date:2000"));
  assert.equal(ninja.find("backups.backupSaved")!.props.variant, "success");
  ninja.press("backups.icloudDrive");
  ninja.press("backups.connect");
  await ninja.flush();
  ninja.providers.icloudDrive!.savedAt = 3000;
  ninja.providers.icloudDrive!.pending = true;
  ninja.notify();
  await ninja.flush();
  assert.ok(ninja.find("backups.icloudDrive")!.props.hint.includes("backups.backupQueued"));
  assert.ok(ninja.find("backups.icloudDrive")!.props.hint.includes("date:3000"));
  assert.ok(!ninja.find("backups.icloudDrive")!.props.hint.includes("backups.lastBackup"));
  assert.equal(ninja.find("backups.uploadQueued")!.props.disabled, true);
  ninja.press("backups.turnOff");
  await ninja.flush();
  assert.equal(ninja.find("backups.icloudDrive")!.props.hint, "backups.automaticOff");
  assert.ok(ninja.find("backups.googleDrive")!.props.hint.includes("date:2000"));
  ninja.hooks.unmount();

  const restore = fixture({ signedIn: false, directRestore: true, platform: "ios" });
  await restore.flush();
  assert.equal(restore.find("backups.syncNow"), undefined);
  assert.equal(restore.find("backups.connect"), undefined);
  assert.equal(restore.find("backups.saveFile"), undefined);
  const remote = { name: "personal-copy.zip", createdAt: 1234 };
  restore.findValue(remote);
  restore.press("backups.googleDrive");
  await restore.flush();
  assert.equal(restore.dialog().props.visible, true);
  assert.ok(restore.dialog().props.description.includes("personal-copy.zip"));
  assert.ok(restore.dialog().props.description.includes("date:1234"));
  assert.deepEqual(restore.cloudRestores, []);
  const canceledConfirm = restore.dialog().props.onConfirm;
  restore.dialog().props.onCancel();
  canceledConfirm();
  assert.deepEqual(restore.cloudRestores, [], "cancel clears the pending restore immediately");
  restore.press("backups.googleDrive");
  await restore.flush();
  const confirm = restore.dialog().props.onConfirm;
  confirm();
  confirm();
  await restore.flush();
  assert.equal(restore.cloudRestores.length, 1);
  assert.equal(restore.cloudRestores[0], remote, "the opaque restore choice stays intact");
  assert.deepEqual(restore.operations, [
    ["find", "googleDrive"],
    ["find", "googleDrive"],
  ]);
  restore.findValue(null);
  restore.press("backups.icloudDrive");
  await restore.flush();
  assert.ok(restore.text().includes("backups.noRemoteBackup"));
  restore.findValue(undefined);
  restore.press("backups.googleDrive");
  await restore.flush();
  assert.equal(restore.dialog().props.visible, false);
  assert.ok(!restore.text().includes("backups.noRemoteBackup"));
  restore.findError(new PersonalCloudProviderError("reconnect"));
  restore.press("backups.icloudDrive");
  await restore.flush();
  assert.ok(restore.text().includes("backups.icloudUnavailable"));
  restore.setOffline(true);
  assert.equal(restore.find("backups.googleDrive")!.props.disabled, true);
  restore.press("backups.restoreFile");
  await restore.flush();
  assert.deepEqual(restore.fileRestores, [[]]);
  restore.fileError(new PersonalBackupError("invalid"));
  restore.press("backups.restoreFile");
  await restore.flush();
  assert.equal(restore.fileRestores.length, 2);
  assert.ok(restore.text().includes("backups.error.invalid"));
  restore.hooks.unmount();

  const localSave = fixture();
  localSave.setOffline(true);
  await localSave.flush();
  assert.equal(localSave.find("backups.saveFile")!.props.disabled, false);
  const saveGate = deferred<SavedFile>();
  localSave.fileSaveValue(saveGate.promise);
  const save = localSave.find("backups.saveFile")!.props.onPress;
  save();
  save();
  localSave.render();
  assert.equal(localSave.fileSaves, 1);
  assert.equal(localSave.find("backups.restoreFile")!.props.disabled, true);
  assert.equal([...localSave.backHandlers][0](), true);
  const saved = {
    displayName: "Kaata-backup.zip",
    coverage: { included: 1, skipped: 2, skippedPending: 1 },
  };
  saveGate.resolve(saved);
  await localSave.flush();
  assert.deepEqual(localSave.toasts, [["backups.backupSaved", "success"]]);
  assert.equal(localSave.find("backups.saveFile")!.props.icon, "checkmark-circle-outline");
  assert.ok(localSave.text().includes('backups.savedFile{"name":"Kaata-backup.zip"}'));
  assert.ok(localSave.text().includes('backups.coverage{"included":1,"skipped":2}'));
  assert.ok(localSave.text().includes("backups.skippedPending"));
  assert.deepEqual(localSave.operations, [], "phone save works without a connected provider");
  localSave.fileSaveValue(null);
  localSave.press("backups.saveFile");
  await localSave.flush();
  assert.ok(!localSave.text().includes("backups.savedFile"), "cancelling does not claim success");
  localSave.fileSaveError(new PersonalBackupError("saveUnavailable"));
  localSave.press("backups.saveFile");
  await localSave.flush();
  assert.ok(localSave.text().includes("backups.error.saveUnavailable"));
  localSave.fileSaveError(null);
  const staleSave = deferred<SavedFile>();
  localSave.fileSaveValue(staleSave.promise);
  localSave.press("backups.saveFile");
  localSave.identity("account-b");
  localSave.render();
  staleSave.resolve(saved);
  await localSave.flush();
  assert.ok(!localSave.text().includes("Kaata-backup.zip"), "hide a prior account’s save result");
  assert.equal(localSave.toasts.length, 1, "cancelled, failed and stale saves never show success");
  localSave.hooks.unmount();

  for (const stale of ["account", "aba", "focus", "unmount"] as const) {
    const f = fixture();
    await f.flush();
    f.press("backups.googleDrive");
    const pending = deferred<BackupChoice>();
    f.findValue(pending.promise);
    f.press("backups.restoreLatest");
    if (stale === "account" || stale === "aba") {
      f.identity("account-b");
      if (stale === "aba") f.identity("account-a");
      f.render();
    } else if (stale === "focus") {
      f.focus(false);
      f.focus(true);
    } else f.hooks.unmount();
    pending.resolve(remote);
    if (stale === "unmount") await settleUI();
    else await f.flush();
    assert.equal(f.dialog().props.visible, false, stale + " cannot show an old restore");
    assert.deepEqual(f.cloudRestores, []);
    assert.equal(f.hooks.lateWrites, 0);
    if (stale !== "unmount") f.hooks.unmount();
  }

  const staleRead = fixture();
  await staleRead.flush();
  const retained = staleRead.find("backups.restoreCloud")!.props.onPress;
  const lateStatus = deferred<any>();
  const lateProviders = deferred<any>();
  staleRead.statusGate(lateStatus.promise);
  staleRead.providerGate(lateProviders.promise);
  staleRead.notify();
  staleRead.statusGate(null);
  staleRead.providerGate(null);
  staleRead.identity("account-b");
  retained();
  assert.deepEqual(staleRead.routes, [], "old account actions are blocked before rerender");
  staleRead.status.vaults[0].name = "New account Kaata";
  await staleRead.flush();
  lateStatus.resolve({
    signedIn: true,
    vaults: [{ id: "old", name: "Old private Kaata", lastPushAt: 9999, pending: false }],
    localBackupAt: 9999,
  });
  lateProviders.resolve({
    googleDrive: { connection: { id: "old", label: "old@example.org" }, savedAt: 9999 },
  });
  await staleRead.flush();
  assert.ok(staleRead.text().includes("New account Kaata"));
  assert.ok(!staleRead.text().includes("Old private Kaata"));
  assert.equal(staleRead.find("backups.googleDrive")!.props.hint, "backups.automaticOff");
  staleRead.hooks.unmount();

  const lifecycle = fixture();
  await lifecycle.flush();
  const reads = lifecycle.reads;
  assert.equal(lifecycle.timers.size, 1);
  lifecycle.appState("background");
  assert.equal(lifecycle.timers.size, 0);
  lifecycle.press("backups.googleDrive");
  assert.equal(lifecycle.find("backups.connect"), undefined);
  lifecycle.appState("active");
  await lifecycle.flush();
  assert.ok(lifecycle.reads > reads, "returning to Settings refreshes backup status");
  lifecycle.setOffline(true);
  lifecycle.press("backups.syncNow");
  assert.equal(lifecycle.syncs, 0);
  lifecycle.setOffline(false);
  lifecycle.syncError(new Error("incomplete"));
  lifecycle.press("backups.syncNow");
  await lifecycle.flush();
  assert.ok(lifecycle.text().includes("backups.syncFailed"));
  assert.ok(lifecycle.text().includes('backups.lastUpload{"when":"date:1000"}'));
  lifecycle.hooks.unmount();
  assert.equal(lifecycle.timers.size, 0);

  console.log(
    "PASS Backups UI: opt-in destinations, provider status, read-only recovery, files and session isolation",
  );
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
