import * as BackgroundTask from "expo-background-task";
import * as Network from "expo-network";
import * as TaskManager from "expo-task-manager";
import { AppState, Platform } from "react-native";
import { onAccountIdentityChanged, refreshAccountIdCache } from "./db-tx";
import { onLedgerApplied } from "./ledger-events";
import {
  isPersonalCloudBackupSupported,
  readPersonalCloudBackupStatuses,
  runPersonalCloudBackupIfDue,
  subscribePersonalCloudBackup,
} from "./personal-cloud-backup";

const TASK = "kaata-personal-cloud-backup";
const POLL_MS = 5 * 60_000;
let foregroundBootFinished = false;

TaskManager.defineTask(TASK, async () => {
  try {
    if (!foregroundBootFinished) {
      // A headless launch has no RootLayout to hydrate the in-memory account.
      // The database opener blocks access if a personal restore is pending.
      if (AppState.currentState === "active") return BackgroundTask.BackgroundTaskResult.Success;
      await refreshAccountIdCache();
    }
    await runPersonalCloudBackupIfDue();
    return BackgroundTask.BackgroundTaskResult.Success;
  } catch {
    return BackgroundTask.BackgroundTaskResult.Failed;
  }
});

export function startPersonalCloudBackupSchedule(): () => void {
  if (Platform.OS !== "ios" && Platform.OS !== "android") return () => {};
  foregroundBootFinished = true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let registration = Promise.resolve();
  let stopped = false;

  const runSoon = () => {
    if (timer !== undefined || AppState.currentState !== "active") return;
    timer = setTimeout(() => {
      timer = undefined;
      if (AppState.currentState === "active") void runPersonalCloudBackupIfDue().catch(() => {});
    }, 5000);
  };
  const reconcileTask = () => {
    registration = registration.then(async () => {
      if (stopped || !await TaskManager.isAvailableAsync()) return;
      const statuses = await readPersonalCloudBackupStatuses();
      const enabled = Object.keys(statuses).some((key) =>
        (key === "googleDrive" || key === "icloudDrive") && isPersonalCloudBackupSupported(key),
      );
      const registered = await TaskManager.isTaskRegisteredAsync(TASK);
      if (enabled && !registered) await BackgroundTask.registerTaskAsync(TASK, { minimumInterval: 15 });
      else if (!enabled && registered) await BackgroundTask.unregisterTaskAsync(TASK);
    }).catch(() => {});
  };
  const subscription = AppState.addEventListener("change", (state) => {
    if (state === "active") {
      reconcileTask();
      runSoon();
    }
  });
  const network = Network.addNetworkStateListener((state) => {
    if (state.isConnected && state.isInternetReachable !== false) runSoon();
  });
  const stopLedger = onLedgerApplied(runSoon);
  const stopStatus = subscribePersonalCloudBackup(reconcileTask);
  const stopAccount = onAccountIdentityChanged(() => {
    reconcileTask();
    runSoon();
  });
  const interval = setInterval(runSoon, POLL_MS);
  reconcileTask();
  runSoon();
  return () => {
    stopped = true;
    clearTimeout(timer);
    clearInterval(interval);
    subscription.remove();
    network.remove();
    stopLedger();
    stopStatus();
    stopAccount();
  };
}
