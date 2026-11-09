import { Stack, useIsFocused, useLocalSearchParams, useRouter } from "expo-router";
import * as Network from "expo-network";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  ActivityIndicator,
  AppState,
  BackHandler,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Button } from "../components/Button";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { NavRow, ScreenHeader, SectionGap, SectionHeader } from "../components/SettingsScreen";
import { readBackupStatus, syncBackupNow } from "../lib/backup-status";
import { colors } from "../lib/colors";
import { getAccountIdSync, getSessionAccountIdSync, onAccountIdentityChanged } from "../lib/db-tx";
import { ltrIsolate, textDir, useIsRTL } from "../lib/direction";
import { formatTimestamp } from "../lib/format";
import { t } from "../lib/i18n";
import { PersonalBackupError, restorePersonalBackup } from "../lib/personal-backup";
import {
  backUpToPersonalCloudNow,
  disablePersonalCloudBackup,
  enablePersonalCloudBackup,
  findLatestPersonalCloudBackup,
  isPersonalCloudBackupSupported,
  PersonalCloudProviderError,
  readPersonalCloudBackupStatuses,
  restoreLatestPersonalCloudBackup,
  subscribePersonalCloudBackup,
  type PersonalCloudProviderId,
  type PersonalCloudStatus,
} from "../lib/personal-cloud-backup";
import { gutter, typography } from "../lib/tokens";

type BackupView = {
  scope: string;
  kaata: Awaited<ReturnType<typeof readBackupStatus>> | null;
  personal: Awaited<ReturnType<typeof readPersonalCloudBackupStatuses>> | null;
};
type Busy = "sync" | "connect" | "disable" | "backup" | "find" | "restoreCloud" | "restoreFile";
type Notice = {
  scope: string;
  message: string;
  error: boolean;
  destination?: PersonalCloudProviderId | "kaata";
};
type RestoreCandidate = {
  scope: string;
  destination: PersonalCloudProviderId;
  backup: NonNullable<Awaited<ReturnType<typeof findLatestPersonalCloudBackup>>>;
};

function destinationLabel(destination: PersonalCloudProviderId) {
  return t(destination === "googleDrive" ? "backups.googleDrive" : "backups.icloudDrive");
}

function backupError(code: string | undefined, destination?: PersonalCloudProviderId): string {
  switch (code) {
    case "ownership":
    case "foreignVault":
      return t("backups.error.ownership");
    case "ownershipUnavailable":
      return t("backups.error.ownershipUnavailable");
    case "differentAccount":
      return t("backups.error.differentAccount");
    case "notEmpty":
      return t("backups.error.notEmpty");
    case "invalid":
      return t("backups.error.invalid");
    case "empty":
      return t(destination ? "backups.autoBackupEmpty" : "backups.error.empty");
    case "noOwnedVaults":
      return t("backups.noOwnedVaults");
    case "unsupported":
      return t("backups.error.unsupported");
    case "tooLarge":
      return t("backups.error.tooLarge");
    case "sessionChanged":
      return t("backups.error.sessionChanged");
    case "busy":
      return t("backups.error.busy");
    case "offline":
      return t("backups.providerOffline");
    case "reconnect":
      return t(
        destination === "icloudDrive" ? "backups.icloudUnavailable" : "backups.reconnectHint",
      );
    default:
      return t(destination ? "backups.providerError" : "backups.error.generic");
  }
}

function providerHint(destination: PersonalCloudProviderId, status?: PersonalCloudStatus) {
  if (!status) return t("backups.automaticOff");
  return [
    t(status.error === "reconnect" ? "backups.automaticPaused" : "backups.automaticOn"),
    status.connection.label ? ltrIsolate(status.connection.label) : null,
    status.savedAt
      ? t(status.pending ? "backups.backupQueued" : "backups.lastBackup", {
          when: formatTimestamp(status.savedAt),
        })
      : status.running || status.error
        ? null
        : t("backups.noBackupYet"),
    status.running ? t("backups.backingUp") : null,
    status.error ? backupError(status.error, destination) : null,
    status.coverage?.skipped
      ? t("backups.coverage", { included: status.coverage.included, skipped: status.coverage.skipped })
      : null,
    status.coverage?.skippedPending
      ? t("backups.skippedPending")
      : null,
  ]
    .filter(Boolean)
    .join("\n");
}

/** Backup destinations live together inside Settings, including for Ninja users. */
export default function BackupsScreen() {
  const router = useRouter();
  const rtl = useIsRTL();
  const { restore } = useLocalSearchParams<{ restore?: string }>();
  const restoreOnly = restore === "1";
  const focused = useIsFocused();
  const focusedRef = useRef(focused);
  const focusEpoch = useRef(0);
  if (focusedRef.current !== focused) focusEpoch.current++;
  focusedRef.current = focused;
  const network = Network.useNetworkState();
  const offline = network.isConnected === false || network.isInternetReachable === false;
  const revision = useRef(0);
  const subscribe = useCallback(
    (notify: () => void) =>
      onAccountIdentityChanged(() => {
        revision.current++;
        notify();
      }),
    [],
  );
  const snapshot = useCallback(
    () => `${revision.current}:${getAccountIdSync() ?? ""}:${getSessionAccountIdSync() ?? ""}`,
    [],
  );
  const identity = useSyncExternalStore(subscribe, snapshot, snapshot);
  const scope = `${identity}:${focusEpoch.current}`;
  const latestScope = useRef(scope);
  latestScope.current = scope;
  const mounted = useRef(true);
  const readVersion = useRef(0);
  const opening = useRef(false);
  const operation = useRef(false);
  const [busy, setBusy] = useState<Busy | null>(null);
  const [stored, setStored] = useState<BackupView | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [form, setForm] = useState<{ scope: string; mode: PersonalCloudProviderId } | null>(null);
  const [candidate, setCandidate] = useState<RestoreCandidate | null>(null);
  const pendingRestore = useRef<RestoreCandidate | null>(null);
  const view = stored?.scope === scope ? stored : null;
  const mode = form?.scope === scope ? form.mode : null;
  const currentCandidate = candidate?.scope === scope ? candidate : null;
  const currentNotice = notice?.scope === scope ? notice : null;
  const cloudUpToDate = view?.kaata?.cloudUpToDate === true &&
    !(currentNotice?.destination === "kaata" && currentNotice.error);
  const readFailed = view !== null && (!view.personal || !view.kaata);
  const signedIn = Boolean(getSessionAccountIdSync());
  const current = useCallback(
    () =>
      mounted.current &&
      focusedRef.current &&
      latestScope.current === scope &&
      snapshot() === identity,
    [scope, identity, snapshot],
  );
  const canAct = () => current() && AppState.currentState === "active" && !operation.current;

  const refresh = useCallback(async () => {
    if (restoreOnly || !current()) return;
    const version = ++readVersion.current;
    const [kaata, personal] = await Promise.allSettled([
      readBackupStatus(),
      readPersonalCloudBackupStatuses(),
    ]);
    if (!current() || readVersion.current !== version) return;
    setStored({
      scope,
      kaata: kaata.status === "fulfilled" ? kaata.value : null,
      personal: personal.status === "fulfilled" ? personal.value : null,
    });
  }, [scope, current, restoreOnly]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      readVersion.current++;
    };
  }, []);
  useEffect(() => {
    opening.current = false;
    pendingRestore.current = null;
    setCandidate(null);
    if (!focused || restoreOnly) return;
    let timer: ReturnType<typeof setInterval> | null = null;
    const refreshIfActive = () => {
      if (AppState.currentState === "active" && !operation.current) void refresh();
    };
    const resume = () => {
      if (timer !== null) clearInterval(timer);
      timer = null;
      if (AppState.currentState !== "active") return;
      refreshIfActive();
      timer = setInterval(refreshIfActive, 30_000);
    };
    resume();
    const subscription = AppState.addEventListener("change", resume);
    const unsubscribe = subscribePersonalCloudBackup(refreshIfActive);
    return () => {
      readVersion.current++;
      if (timer !== null) clearInterval(timer);
      subscription.remove();
      unsubscribe();
    };
  }, [focused, refresh, restoreOnly]);
  useEffect(() => {
    if (!focused) return;
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
      if (operation.current) return true;
      if (currentCandidate) {
        cancelCandidate();
        return true;
      }
      if (mode) {
        choose(null);
        return true;
      }
      return false;
    });
    return () => subscription.remove();
  }, [focused, scope, mode, currentCandidate]);

  function choose(next: PersonalCloudProviderId | null) {
    if (!canAct() || opening.current || pendingRestore.current) return;
    setNotice(null);
    setForm(next && next !== mode ? { scope, mode: next } : null);
  }
  function cancelCandidate() {
    if (!canAct()) return;
    pendingRestore.current = null;
    setCandidate(null);
  }
  function navigate(path: "/restore" | "/sign-in") {
    if (!canAct() || opening.current || pendingRestore.current) return;
    if (path === "/restore" && (!signedIn || offline)) return;
    opening.current = true;
    router.push(path);
  }
  function showNotice(message: string, error = false, destination?: Notice["destination"]) {
    if (current()) setNotice({ scope, message, error, destination });
  }
  async function run(kind: Busy, work: () => Promise<void>, destination?: PersonalCloudProviderId) {
    if (!canAct() || opening.current) return;
    operation.current = true;
    setBusy(kind);
    setNotice(null);
    try {
      await work();
    } catch (failure) {
      const code =
        failure instanceof PersonalBackupError || failure instanceof PersonalCloudProviderError
          ? failure.code
          : undefined;
      showNotice(
        kind === "sync" ? t("backups.syncFailed") : backupError(code, destination),
        true,
        kind === "sync" ? "kaata" : destination,
      );
    } finally {
      operation.current = false;
      if (mounted.current) {
        setBusy(null);
        if (current()) void refresh();
      }
    }
  }
  function find(destination: PersonalCloudProviderId) {
    if (offline || pendingRestore.current || !isPersonalCloudBackupSupported(destination)) return;
    return run(
      "find",
      async () => {
        const backup = await findLatestPersonalCloudBackup(destination);
        if (!current() || backup === undefined) return;
        if (backup === null) {
          showNotice(
            t("backups.noRemoteBackup", { destination: destinationLabel(destination) }),
            false,
            destination,
          );
          return;
        }
        const next = { scope, destination, backup };
        pendingRestore.current = next;
        setCandidate(next);
      },
      destination,
    );
  }
  function confirmRestore() {
    if (!currentCandidate || pendingRestore.current !== currentCandidate) return;
    const { backup, destination } = currentCandidate;
    return run(
      "restoreCloud",
      async () => {
        pendingRestore.current = null;
        setCandidate(null);
        if (await restoreLatestPersonalCloudBackup(backup)) {
          showNotice(t("backups.restoring"), false, destination);
        }
      },
      destination,
    );
  }
  function restoreFile() {
    if (!canAct() || pendingRestore.current) return;
    return run("restoreFile", async () => {
      setForm(null);
      if (await restorePersonalBackup()) {
        if (current()) setForm(null);
        showNotice(t("backups.restoring"));
      }
    });
  }

  const locked = Boolean(busy || currentCandidate);
  const destinations: PersonalCloudProviderId[] =
    Platform.OS === "ios" ? ["googleDrive", "icloudDrive"] : ["googleDrive"];
  const statusMessage = currentNotice ? (
    <Text
      style={[currentNotice.error ? styles.error : styles.hint, styles.inset, textDir(rtl)]}
      accessibilityLiveRegion="polite"
    >
      {currentNotice.message}
    </Text>
  ) : null;
  return (
    <SafeAreaView style={styles.screen} edges={["top", "bottom"]}>
      <Stack.Screen options={{ gestureEnabled: !locked && !mode }} />
      <ScreenHeader
        title={t(restoreOnly ? "backups.restorePersonal" : "backups.title")}
        isRTL={rtl}
        backDisabled={Boolean(busy)}
        onBack={() => {
          if (!canAct()) return;
          if (currentCandidate) cancelCandidate();
          else if (mode) choose(null);
          else if (router.canGoBack()) router.back();
          else router.replace("/");
        }}
      />
      <View style={styles.flex}>
        <ScrollView contentContainerStyle={styles.content}>
          <SectionHeader label={t("backups.personal")} isRTL={rtl} />
          <Text style={[styles.hint, styles.inset, textDir(rtl)]}>
            {t(
              restoreOnly
                ? "backups.personalRestoreHint"
                : Platform.OS === "ios"
                  ? "backups.personalHint"
                  : "backups.personalHintAndroid",
            )}
          </Text>
          {offline ? (
            <Text style={[styles.hint, styles.inset, textDir(rtl)]}>
              {t("backups.providerOffline")}
            </Text>
          ) : null}
          {!view && !restoreOnly ? (
            <ActivityIndicator color={colors.textSubtle} style={styles.inset} />
          ) : null}
          {readFailed ? (
            <View style={styles.block}>
              <Text style={[styles.error, textDir(rtl)]}>{t("backups.readFailed")}</Text>
              <Button
                label={t("common.retry")}
                variant="muted"
                disabled={locked}
                onPress={() => {
                  if (canAct()) void refresh();
                }}
              />
            </View>
          ) : null}
          {destinations.map((destination) => {
            const available = isPersonalCloudBackupSupported(destination);
            const selected = mode === destination;
            const status = view?.personal?.[destination];
            const label = destinationLabel(destination);
            const hint = !available
              ? t("backups.providerUnavailable")
              : restoreOnly
                ? undefined
                : view?.personal
                  ? providerHint(destination, status)
                  : t("backups.statusUnknown");
            const reconnect = status?.error === "reconnect";
            const queued = Boolean(status?.pending && !status.error);
            const saved = Boolean(status?.savedAt && !status.pending && !status.error);
            return (
              <View key={destination}>
                <NavRow
                  icon={destination === "googleDrive" ? "logo-google" : "logo-apple"}
                  label={label}
                  hint={hint}
                  hintLines={0}
                  accessibilityHint={hint}
                  trailing={
                    restoreOnly || !available
                      ? undefined
                      : t(selected ? "common.close" : "backups.manage")
                  }
                  onPress={() => (restoreOnly ? void find(destination) : choose(destination))}
                  disabled={locked || !available || (restoreOnly && offline)}
                  isRTL={rtl}
                />
                {selected ? (
                  <View style={styles.block}>
                    {!status || reconnect ? (
                      <>
                        {!status ? (
                          <Text style={[styles.hint, textDir(rtl)]}>
                            {t("backups.readableBackup")}
                          </Text>
                        ) : null}
                        <Button
                          label={t(reconnect ? "backups.reconnect" : "backups.connect", {
                            destination: label,
                          })}
                          disabled={locked || offline || !view?.personal}
                          loading={busy === "connect"}
                          onPress={() => {
                            if (offline || !view?.personal) return;
                            void run(
                              "connect",
                              async () => {
                                await enablePersonalCloudBackup(destination);
                              },
                              destination,
                            );
                          }}
                          wrapLabel
                        />
                      </>
                    ) : (
                      <Button
                        label={t(queued ? "backups.uploadQueued" : saved ? "backups.backupSaved" : "backups.backUpNow")}
                        accessibilityLabel={saved ? `${t("backups.backupSaved")}. ${t("backups.backUpNow")}` : undefined}
                        variant={saved ? "success" : queued ? "muted" : "primary"}
                        icon={saved ? "checkmark-circle-outline" : queued ? "time-outline" : undefined}
                        disabled={locked || offline || status.running || queued}
                        loading={busy === "backup" || status.running}
                        onPress={() => {
                          if (offline || status.running || queued) return;
                          void run(
                            "backup",
                            () => backUpToPersonalCloudNow(destination),
                            destination,
                          );
                        }}
                        wrapLabel
                      />
                    )}
                    <Button
                      label={t("backups.restoreLatest")}
                      variant="secondary"
                      disabled={locked || offline}
                      loading={busy === "find" || busy === "restoreCloud"}
                      onPress={() => void find(destination)}
                      wrapLabel
                    />
                    {status ? (
                      <Button
                        label={t("backups.turnOff")}
                        variant="muted"
                        disabled={locked}
                        loading={busy === "disable"}
                        onPress={() =>
                          void run(
                            "disable",
                            () => disablePersonalCloudBackup(destination),
                            destination,
                          )
                        }
                        wrapLabel
                      />
                    ) : null}
                  </View>
                ) : null}
                {currentNotice?.destination === destination ? statusMessage : null}
              </View>
            );
          })}
          <NavRow
            icon="folder-open-outline"
            label={t("backups.restoreFile")}
            hint={t("backups.restoreFileHint")}
            onPress={() => void restoreFile()}
            disabled={locked}
            isRTL={rtl}
            isLast
          />
          <Text style={[styles.hint, styles.inset, textDir(rtl)]}>
            {t("backups.restoreRestriction")}
          </Text>
          {!restoreOnly ? (
            <Text style={[styles.hint, styles.inset, textDir(rtl)]}>{t("backups.ownedScope")}</Text>
          ) : null}
          {(restoreOnly && (busy === "find" || busy === "restoreCloud")) ||
          busy === "restoreFile" ? (
            <ActivityIndicator color={colors.textSubtle} style={styles.inset} />
          ) : null}
          {currentNotice?.destination === undefined ? statusMessage : null}
          {!restoreOnly ? (
            <>
              <SectionGap />
              <SectionHeader label={t("backups.cloud")} isRTL={rtl} />
              <Text style={[styles.hint, styles.inset, textDir(rtl)]}>
                {t(signedIn ? "backups.cloudHint" : "backups.cloudSignedOut")}
              </Text>
              {signedIn && view?.kaata?.signedIn ? (
                <>
                  {view.kaata.vaults.map((vault) => (
                    <View key={vault.id} style={styles.statusRow}>
                      <Text style={[styles.label, textDir(rtl)]}>{vault.name}</Text>
                      <Text style={[styles.hint, textDir(rtl)]}>
                        {vault.lastPushAt
                          ? t("backups.lastUpload", { when: formatTimestamp(vault.lastPushAt) })
                          : t("backups.neverUploaded")}
                      </Text>
                      {vault.pending ? (
                        <Text style={[styles.hint, textDir(rtl)]}>{t("backups.pending")}</Text>
                      ) : null}
                    </View>
                  ))}
                  {!view.kaata.vaults.length ? (
                    <Text style={[styles.hint, styles.inset, textDir(rtl)]}>
                      {t("backups.noKaatas")}
                    </Text>
                  ) : null}
                </>
              ) : null}
              {signedIn ? (
                <View style={styles.block}>
                  {offline ? (
                    <Text style={[styles.hint, textDir(rtl)]}>{t("backups.offline")}</Text>
                  ) : null}
                  <Button
                    label={t(cloudUpToDate ? "backups.cloudUpToDate" : "backups.syncNow")}
                    variant={cloudUpToDate ? "success" : "primary"}
                    icon={cloudUpToDate ? "checkmark-circle-outline" : undefined}
                    accessibilityLabel={cloudUpToDate ? `${t("backups.cloudUpToDate")}. ${t("backups.syncNow")}` : undefined}
                    loading={busy === "sync"}
                    disabled={locked || offline}
                    onPress={() => {
                      if (signedIn && !offline) void run("sync", syncBackupNow);
                    }}
                    wrapLabel
                  />
                  <Button
                    label={t("backups.restoreCloud")}
                    variant="secondary"
                    disabled={locked || offline}
                    onPress={() => navigate("/restore")}
                    wrapLabel
                  />
                </View>
              ) : (
                <View style={styles.block}>
                  <Button
                    label={t("menu.account.signIn.choose")}
                    variant="secondary"
                    disabled={locked}
                    onPress={() => navigate("/sign-in")}
                  />
                </View>
              )}
              {currentNotice?.destination === "kaata" ? statusMessage : null}
              <SectionGap />
              <SectionHeader label={t("backups.onDevice")} isRTL={rtl} />
              <Text style={[styles.hint, styles.inset, textDir(rtl)]}>
                {view?.kaata?.localBackupAt
                  ? t("backups.localSaved", { when: formatTimestamp(view.kaata.localBackupAt) })
                  : t(view?.kaata ? "backups.localNone" : "backups.statusUnknown")}
              </Text>
              <Text style={[styles.hint, styles.inset, textDir(rtl)]}>
                {t("backups.localHint")}
              </Text>
            </>
          ) : null}
        </ScrollView>
      </View>
      <ConfirmDialog
        visible={Boolean(currentCandidate) && !busy}
        title={
          currentCandidate
            ? t("backups.restoreLatestTitle", {
                destination: destinationLabel(currentCandidate.destination),
              })
            : ""
        }
        description={
          currentCandidate
            ? [
                t("backups.restoreLatestBody", {
                  destination: destinationLabel(currentCandidate.destination),
                }),
                t("backups.lastBackup", {
                  when: formatTimestamp(currentCandidate.backup.createdAt),
                }),
                ltrIsolate(currentCandidate.backup.name),
              ].join("\n\n")
            : ""
        }
        confirmLabel={t("backups.restoreLatest")}
        onConfirm={() => void confirmRestore()}
        onCancel={cancelCandidate}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bgDefault },
  flex: { flex: 1 },
  content: { paddingBottom: 24 },
  inset: { marginHorizontal: gutter.settings, marginBottom: 12 },
  block: { paddingHorizontal: gutter.settings, paddingVertical: 12, gap: 12 },
  statusRow: {
    paddingHorizontal: gutter.settings,
    paddingVertical: 12,
    gap: 4,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.borderDefault,
  },
  label: { ...typography.label, color: colors.textEmphasis },
  hint: { ...typography.body, color: colors.textSubtle },
  error: { ...typography.body, color: colors.danger },
});
