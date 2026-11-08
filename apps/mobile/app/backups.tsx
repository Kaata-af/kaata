import { Stack, useIsFocused, useLocalSearchParams, useRouter } from "expo-router";
import * as Network from "expo-network";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  ActivityIndicator,
  AppState,
  BackHandler,
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Button } from "../components/Button";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { PasswordField } from "../components/PasswordField";
import { NavRow, ScreenHeader, SectionGap, SectionHeader } from "../components/SettingsScreen";
import { readBackupStatus, syncBackupNow } from "../lib/backup-status";
import { colors } from "../lib/colors";
import { getAccountIdSync, getSessionAccountIdSync, onAccountIdentityChanged } from "../lib/db-tx";
import { textDir, useIsRTL } from "../lib/direction";
import { formatTimestamp } from "../lib/format";
import { t } from "../lib/i18n";
import {
  PersonalBackupError,
  readPersonalBackupReceipts,
  recordPersonalBackup,
  restorePersonalBackup,
  savePersonalBackup,
  type PersonalBackupDestination,
} from "../lib/personal-backup";
import { gutter, typography } from "../lib/tokens";

type BackupView = {
  scope: string;
  status: Awaited<ReturnType<typeof readBackupStatus>>;
  receipts: Awaited<ReturnType<typeof readPersonalBackupReceipts>>;
};
type Form = { scope: string; mode: "restore" | PersonalBackupDestination };
type SavedCopy = {
  scope: string;
  destination: PersonalBackupDestination;
  result: NonNullable<Awaited<ReturnType<typeof savePersonalBackup>>>;
};

function destinationLabel(destination: PersonalBackupDestination) {
  return t(destination === "googleDrive" ? "backups.googleDrive" : "backups.icloudDrive");
}

function backupError(error: unknown) {
  if (error instanceof PersonalBackupError) {
    switch (error.code) {
      case "ownership":
        return t("backups.error.ownership");
      case "differentAccount":
        return t("backups.error.differentAccount");
      case "notEmpty":
        return t("backups.error.notEmpty");
      case "invalid":
        return t("backups.error.invalid");
      case "empty":
        return t("backups.error.empty");
      case "unsupported":
        return t("backups.error.unsupported");
      case "tooLarge":
        return t("backups.error.tooLarge");
      case "password":
        return t("backups.error.password");
      case "sessionChanged":
        return t("backups.error.sessionChanged");
    }
  }
  return t("backups.error.generic");
}

/** Backup destinations live together inside Settings, including for Ninja users. */
export default function BackupsScreen() {
  const router = useRouter();
  const rtl = useIsRTL();
  const params = useLocalSearchParams<{ restore?: string }>();
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
  const operation = useRef<object | null>(null);
  const [busy, setBusy] = useState<"sync" | "save" | "restore" | "receipt" | null>(null);
  const [stored, setStored] = useState<BackupView | null>(null);
  const [readFailure, setReadFailure] = useState<string | null>(null);
  const [error, setError] = useState<{ scope: string; message: string } | null>(null);
  const [form, setForm] = useState<Form | null>(() =>
    params.restore === "1" ? { scope, mode: "restore" } : null,
  );
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [savedCopy, setSavedCopy] = useState<SavedCopy | null>(null);
  const [restored, setRestored] = useState<string | null>(null);
  const view = stored?.scope === scope ? stored : null;
  const currentForm = form?.scope === scope ? form : null;
  const currentCopy = savedCopy?.scope === scope ? savedCopy : null;
  const currentError = error?.scope === scope ? error.message : null;
  const failed = readFailure === scope;
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
    if (!current()) return;
    const version = ++readVersion.current;
    try {
      const [status, receipts] = await Promise.all([
        readBackupStatus(),
        readPersonalBackupReceipts(),
      ]);
      if (!current() || readVersion.current !== version) return;
      setStored({ scope, status, receipts });
      setReadFailure(null);
    } catch {
      if (current() && readVersion.current === version) setReadFailure(scope);
    }
  }, [scope, current]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      readVersion.current++;
    };
  }, []);
  useEffect(() => {
    opening.current = false;
    setPassword("");
    setConfirmation("");
    if (!focused) return;
    let timer: ReturnType<typeof setInterval> | null = null;
    const resume = () => {
      if (timer !== null) clearInterval(timer);
      timer = null;
      if (AppState.currentState !== "active") return;
      void refresh();
      timer = setInterval(() => {
        if (!operation.current) void refresh();
      }, 30_000);
    };
    resume();
    const sub = AppState.addEventListener("change", resume);
    return () => {
      readVersion.current++;
      if (timer !== null) clearInterval(timer);
      sub.remove();
    };
  }, [focused, refresh]);
  useEffect(() => {
    if (!focused) return;
    const sub = BackHandler.addEventListener("hardwareBackPress", () => {
      if (operation.current) return true;
      if (currentCopy) {
        setSavedCopy(null);
        return true;
      }
      if (currentForm) {
        closeForm();
        return true;
      }
      return false;
    });
    return () => sub.remove();
  }, [focused, scope, currentForm, currentCopy]);

  function closeForm() {
    if (!canAct()) return;
    Keyboard.dismiss();
    setForm(null);
    setPassword("");
    setConfirmation("");
    setError(null);
  }
  function choose(mode: Form["mode"]) {
    if (!canAct() || opening.current || currentCopy) return;
    setPassword("");
    setConfirmation("");
    setError(null);
    setRestored(null);
    setForm({ scope, mode });
  }
  function navigate(path: "/restore" | "/sign-in") {
    if (!canAct() || opening.current || currentCopy) return;
    if (path === "/restore" && (!signedIn || offline)) return;
    opening.current = true;
    Keyboard.dismiss();
    router.push(path);
  }
  function start(kind: NonNullable<typeof busy>) {
    const token = {};
    operation.current = token;
    setBusy(kind);
    setError(null);
    return token;
  }
  function finish(token: object) {
    if (operation.current === token) {
      operation.current = null;
      if (mounted.current) setBusy(null);
    }
  }
  async function sync() {
    if (!canAct() || !signedIn || offline || currentForm || currentCopy) return;
    const token = start("sync");
    try {
      await syncBackupNow();
    } catch {
      if (current()) setError({ scope, message: t("backups.syncFailed") });
    } finally {
      finish(token);
      if (current()) await refresh();
    }
  }
  async function submit() {
    if (!canAct() || !currentForm || currentCopy) return;
    const passwordLength = Array.from(password).length;
    if (passwordLength < 12 || passwordLength > 256) {
      setError({ scope, message: t("backups.passwordMin") });
      return;
    }
    if (currentForm.mode !== "restore" && password !== confirmation) {
      setError({ scope, message: t("backups.passwordMismatch") });
      return;
    }
    const mode = currentForm.mode;
    const secret = password;
    const token = start(mode === "restore" ? "restore" : "save");
    Keyboard.dismiss();
    setPassword("");
    setConfirmation("");
    try {
      if (mode === "restore") {
        const imported = await restorePersonalBackup(secret);
        if (current() && imported) {
          setForm(null);
          setRestored(scope);
        }
      } else {
        const result = await savePersonalBackup(secret);
        if (current() && result) {
          setForm(null);
          setSavedCopy({ scope, destination: mode, result });
        }
      }
    } catch (failure) {
      if (current()) setError({ scope, message: backupError(failure) });
    } finally {
      finish(token);
    }
  }
  async function confirmSaved() {
    if (!canAct() || !currentCopy) return;
    const token = start("receipt");
    try {
      await recordPersonalBackup(currentCopy.destination, currentCopy.result);
      if (current()) {
        setSavedCopy(null);
        await refresh();
      }
    } catch (failure) {
      if (current()) setError({ scope, message: backupError(failure) });
    } finally {
      finish(token);
    }
  }

  const locked = Boolean(busy || currentForm || currentCopy);
  return (
    <SafeAreaView style={styles.screen} edges={["top", "bottom"]}>
      <Stack.Screen options={{ gestureEnabled: !busy }} />
      <ScreenHeader
        title={t("backups.title")}
        isRTL={rtl}
        backDisabled={Boolean(busy)}
        onBack={() => {
          if (!canAct()) return;
          if (currentForm) closeForm();
          else if (currentCopy) setSavedCopy(null);
          else if (router.canGoBack()) router.back();
          else router.replace("/");
        }}
      />
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          <SectionHeader label={t("backups.cloud")} isRTL={rtl} />
          <Text style={[styles.hint, styles.inset, textDir(rtl)]}>
            {t(signedIn ? "backups.cloudHint" : "backups.cloudSignedOut")}
          </Text>
          {!view && !failed ? (
            <ActivityIndicator color={colors.textSubtle} style={styles.inset} />
          ) : null}
          {failed ? (
            <View style={styles.block}>
              <Text style={[styles.error, textDir(rtl)]}>{t("backups.readFailed")}</Text>
              <Button
                label={t("common.retry")}
                variant="muted"
                disabled={Boolean(busy)}
                onPress={() => {
                  if (canAct()) void refresh();
                }}
              />
            </View>
          ) : null}
          {signedIn && view?.status.signedIn ? (
            <>
              {view.status.vaults.map((vault) => (
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
              {!view.status.vaults.length ? (
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
                label={t("backups.syncNow")}
                loading={busy === "sync"}
                disabled={locked || offline}
                onPress={() => void sync()}
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
          <SectionGap />
          <SectionHeader label={t("backups.personal")} isRTL={rtl} />
          <Text style={[styles.hint, styles.inset, textDir(rtl)]}>{t("backups.personalHint")}</Text>
          {(
            [
              "googleDrive",
              ...(Platform.OS === "ios" ? ["icloudDrive"] : []),
            ] as PersonalBackupDestination[]
          ).map((destination) => {
            const receipt = view?.receipts[destination];
            return (
              <NavRow
                key={destination}
                icon={destination === "googleDrive" ? "logo-google" : "logo-apple"}
                label={destinationLabel(destination)}
                hint={
                  receipt
                    ? `${t("backups.lastSaved", { when: formatTimestamp(receipt.savedAt) })}\n${receipt.displayName}`
                    : t(view ? "backups.notSaved" : "backups.statusUnknown")
                }
                onPress={() => choose(destination)}
                disabled={locked}
                isRTL={rtl}
              />
            );
          })}
          <NavRow
            icon="folder-open-outline"
            label={t("backups.restorePersonal")}
            onPress={() => choose("restore")}
            disabled={locked}
            isRTL={rtl}
            isLast
          />
          <Text style={[styles.hint, styles.inset, textDir(rtl)]}>
            {t("backups.restoreRestriction")}
          </Text>
          {currentForm ? (
            <View style={styles.block}>
              <Text style={[styles.label, textDir(rtl)]}>
                {currentForm.mode === "restore"
                  ? t("backups.restorePersonal")
                  : t("backups.saveTo", { destination: destinationLabel(currentForm.mode) })}
              </Text>
              <Text style={[styles.hint, textDir(rtl)]}>
                {t(
                  currentForm.mode === "restore"
                    ? "backups.restoreInstructions"
                    : currentForm.mode === "googleDrive"
                      ? "backups.googleInstructions"
                      : "backups.icloudInstructions",
                )}
              </Text>
              <Text style={[styles.hint, textDir(rtl)]}>{t("backups.passwordHint")}</Text>
              <PasswordField
                label={t("backups.password")}
                accessibilityLabel={t("backups.password")}
                value={password}
                onChangeText={(value) => {
                  if (!canAct()) return;
                  setPassword(value);
                  setError(null);
                }}
                editable={!busy}
                textContentType="none"
                autoComplete="off"
              />
              {currentForm.mode !== "restore" ? (
                <PasswordField
                  label={t("backups.confirmPassword")}
                  accessibilityLabel={t("backups.confirmPassword")}
                  value={confirmation}
                  onChangeText={(value) => {
                    if (!canAct()) return;
                    setConfirmation(value);
                    setError(null);
                  }}
                  editable={!busy}
                  textContentType="none"
                  autoComplete="off"
                />
              ) : null}
              <Button
                label={t(
                  currentForm.mode === "restore" ? "backups.chooseFile" : "backups.saveCopy",
                )}
                onPress={() => void submit()}
                loading={busy === "save" || busy === "restore"}
                disabled={Boolean(busy)}
                wrapLabel
              />
              <Button
                label={t("common.cancel")}
                variant="secondary"
                onPress={closeForm}
                disabled={Boolean(busy)}
              />
            </View>
          ) : null}
          {currentError ? (
            <Text
              style={[styles.error, styles.inset, textDir(rtl)]}
              accessibilityLiveRegion="polite"
            >
              {currentError}
            </Text>
          ) : null}
          {restored === scope ? (
            <Text style={[styles.hint, styles.inset, textDir(rtl)]}>{t("backups.restoring")}</Text>
          ) : null}
          <SectionGap />
          <SectionHeader label={t("backups.onDevice")} isRTL={rtl} />
          <Text style={[styles.hint, styles.inset, textDir(rtl)]}>
            {view?.status.localBackupAt
              ? t("backups.localSaved", { when: formatTimestamp(view.status.localBackupAt) })
              : t(view ? "backups.localNone" : "backups.statusUnknown")}
          </Text>
          <Text style={[styles.hint, styles.inset, textDir(rtl)]}>{t("backups.localHint")}</Text>
        </ScrollView>
      </KeyboardAvoidingView>
      <ConfirmDialog
        visible={Boolean(currentCopy) && !busy}
        title={t("backups.confirmSavedTitle")}
        description={
          currentCopy
            ? [
                t("backups.confirmSavedBody", {
                  destination: destinationLabel(currentCopy.destination),
                  file: currentCopy.result.displayName,
                }),
                currentError,
              ]
                .filter(Boolean)
                .join("\n\n")
            : ""
        }
        confirmLabel={t("backups.confirmSaved")}
        cancelLabel={t("backups.notSavedYet")}
        onConfirm={() => void confirmSaved()}
        onCancel={() => {
          if (canAct()) setSavedCopy(null);
        }}
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
