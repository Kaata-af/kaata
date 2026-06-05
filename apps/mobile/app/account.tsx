import { Ionicons } from "@expo/vector-icons";
import { Redirect, useRouter } from "expo-router";
import { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  DevSettings,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  type TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { FormField } from "../components/FormField";
import { useToast } from "../components/Toast";
import {
  clearLocalSession,
  getSessionUser,
  isCancellation,
  type SessionUser,
  signInWithGoogle,
  signOut,
} from "../lib/auth";
import { getLastBackupAt, SessionExpiredError, uploadBackup } from "../lib/backup";
import { colors } from "../lib/colors";
import { getLocalSelf, resetAllLocalData, updateSelfProfile } from "../lib/db";
import { rowDir, textDir, useIsRTL } from "../lib/direction";
import { fonts } from "../lib/fonts";
import { t } from "../lib/i18n";

// Account screen — identity, Google sign-in, backup.
//
// Auto-commit pattern (no Save button):
//   - Name + shop write on blur via updateSelfProfile. Name validation
//     fires inline (empty = error, no DB write).
//   - Sign-in / sign-out / backup are independent actions that commit
//     instantly.
//
// Dev-only Reset all data lives at the bottom because it's an account-
// state action (wipes SecureStore session + SQLite tables).

export default function AccountScreen() {
  const router = useRouter();
  const isRTL = useIsRTL();
  const toast = useToast();

  const [loaded, setLoaded] = useState(false);
  // Tracks whether a local_self profile exists. If false after load, we
  // bounce the user back to the start of onboarding rather than render
  // a screen that would silently fail on save (updateSelfProfile would
  // hit a no-op or error). In practice the user reaches this screen
  // only after onboarding, but the defensive guard handles weird
  // states like a partial dev-reset.
  const [selfMissing, setSelfMissing] = useState(false);
  const [name, setName] = useState("");
  const [shopName, setShopName] = useState("");
  const [nameError, setNameError] = useState<string | null>(null);
  const shopRef = useRef<TextInput>(null);

  // Original DB values — used to skip the write when nothing changed.
  // Avoids spamming the DB with identical UPDATEs on every focus event.
  const initial = useRef<{ name: string; shopName: string }>({
    name: "",
    shopName: "",
  });

  const [sessionUser, setSessionUser] = useState<SessionUser | null>(null);
  const [authBusy, setAuthBusy] = useState(false);

  const [lastBackupAt, setLastBackupAt] = useState<Date | null>(null);
  const [backupBusy, setBackupBusy] = useState(false);
  const [backupError, setBackupError] = useState<string | null>(null);
  const backupInFlightRef = useRef(false);

  useEffect(() => {
    (async () => {
      const self = await getLocalSelf();
      if (!self) {
        setSelfMissing(true);
        setLoaded(true);
        return;
      }
      setName(self.name);
      setShopName(self.shop_name ?? "");
      initial.current = { name: self.name, shopName: self.shop_name ?? "" };
      const user = await getSessionUser();
      setSessionUser(user);
      const at = await getLastBackupAt();
      setLastBackupAt(at);
      setLoaded(true);
    })();
  }, []);

  async function commitIdentity() {
    const trimmedName = name.trim();
    const trimmedShop = shopName.trim();
    if (!trimmedName) {
      setNameError(t("onboarding.nameRequired"));
      return;
    }
    setNameError(null);
    if (trimmedName === initial.current.name && trimmedShop === initial.current.shopName) {
      return; // no change — skip the DB write
    }
    try {
      await updateSelfProfile(trimmedName, trimmedShop || null);
      initial.current = { name: trimmedName, shopName: trimmedShop };
      toast.push(t("account.saved"), "success");
    } catch (err) {
      console.warn("[account] updateSelfProfile failed", err);
    }
  }

  async function onSignIn() {
    setAuthBusy(true);
    try {
      const user = await signInWithGoogle();
      setSessionUser(user);
    } catch (err) {
      if (!isCancellation(err)) {
        console.warn("[account] sign-in failed", err);
      }
    } finally {
      setAuthBusy(false);
    }
  }

  async function onSignOut() {
    setAuthBusy(true);
    try {
      await signOut();
      setSessionUser(null);
    } finally {
      setAuthBusy(false);
    }
  }

  async function onBackupNow() {
    if (backupInFlightRef.current) return;
    backupInFlightRef.current = true;
    setBackupError(null);
    setBackupBusy(true);
    try {
      const result = await uploadBackup();
      setLastBackupAt(new Date(result.updatedAt));
    } catch (err) {
      console.warn("[account] backup failed", err);
      if (err instanceof SessionExpiredError) {
        setSessionUser(null);
        setBackupError(t("settings.backup.sessionExpired"));
      } else if (err instanceof Error && err.message === "backup_timeout") {
        setBackupError(t("settings.backup.timeout"));
      } else {
        setBackupError(t("settings.backup.failed"));
      }
    } finally {
      backupInFlightRef.current = false;
      setBackupBusy(false);
    }
  }

  async function onResetAllData() {
    try {
      await clearLocalSession();
      await resetAllLocalData();
      DevSettings.reload();
    } catch (err) {
      console.warn("[account] reset failed", err);
    }
  }

  if (!loaded) {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.fillCenter}>
          <ActivityIndicator color={colors.textDefault} />
        </View>
      </SafeAreaView>
    );
  }
  if (selfMissing) {
    // No local_self row but the user somehow landed on /account. Send
    // them through onboarding instead of letting them tap on inputs that
    // would silently fail to save.
    return <Redirect href="/onboarding" />;
  }

  return (
    <SafeAreaView style={styles.container}>
      <View style={[styles.header, rowDir(isRTL)]}>
        <Pressable onPress={() => router.back()} hitSlop={8}>
          <Text style={[styles.cancel, textDir(isRTL)]}>{t("common.cancel")}</Text>
        </Pressable>
        <Text style={styles.title}>{t("account.title")}</Text>
        <View style={{ width: 60 }} />
      </View>

      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <ScrollView
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={styles.scrollContent}
        >
          {/* Identity — auto-commit on blur */}
          <Text style={[styles.sectionLabel, textDir(isRTL)]}>{t("account.identity.label")}</Text>
          <FormField
            label={t("settings.name.label")}
            required
            value={name}
            onChangeText={(s) => {
              setName(s);
              if (nameError) setNameError(null);
            }}
            onBlur={commitIdentity}
            autoCapitalize="words"
            returnKeyType="next"
            onSubmitEditing={() => shopRef.current?.focus()}
            submitBehavior="submit"
            error={nameError}
          />
          <FormField
            ref={shopRef}
            label={t("settings.shop.label")}
            value={shopName}
            onChangeText={setShopName}
            onBlur={commitIdentity}
            returnKeyType="done"
          />

          {/* Account / Google sign-in */}
          <View style={styles.field}>
            <Text style={[styles.label, textDir(isRTL)]}>{t("settings.account.label")}</Text>
            {sessionUser ? (
              <View style={{ gap: 10 }}>
                <Text style={[styles.statusText, textDir(isRTL)]}>
                  {t("settings.account.signedInAs", { email: sessionUser.email ?? "—" })}
                </Text>
                <Pressable
                  onPress={onSignOut}
                  disabled={authBusy}
                  style={({ pressed }) => [
                    styles.btn,
                    styles.btnGhost,
                    pressed && { opacity: 0.85 },
                    authBusy && { opacity: 0.6 },
                  ]}
                >
                  {authBusy ? (
                    <ActivityIndicator color={colors.textEmphasis} />
                  ) : (
                    <Text style={styles.btnGhostText}>{t("settings.account.signOut")}</Text>
                  )}
                </Pressable>
                <Text style={[styles.fieldHint, textDir(isRTL)]}>
                  {t("settings.account.signOutHint")}
                </Text>
              </View>
            ) : (
              <View>
                <Pressable
                  onPress={onSignIn}
                  disabled={authBusy}
                  style={({ pressed }) => [
                    styles.btn,
                    styles.btnPrimary,
                    rowDir(isRTL),
                    pressed && { opacity: 0.85 },
                    authBusy && { opacity: 0.6 },
                  ]}
                >
                  {authBusy ? (
                    <ActivityIndicator color={colors.textInverted} />
                  ) : (
                    <>
                      <Ionicons
                        name="logo-google"
                        size={18}
                        color={colors.textInverted}
                        style={isRTL ? { marginLeft: 10 } : { marginRight: 10 }}
                      />
                      <Text style={styles.btnPrimaryText}>{t("settings.account.signIn")}</Text>
                    </>
                  )}
                </Pressable>
                <Text style={[styles.fieldHint, textDir(isRTL)]}>
                  {t("settings.account.signInHint")}
                </Text>
              </View>
            )}
          </View>

          {/* Backup */}
          <View style={styles.field}>
            <Text style={[styles.label, textDir(isRTL)]}>{t("settings.backup.label")}</Text>
            <Text style={[styles.statusText, textDir(isRTL), { marginBottom: 8 }]}>
              {formatLastBackup(lastBackupAt)}
            </Text>
            <Pressable
              onPress={onBackupNow}
              disabled={backupBusy || !sessionUser}
              style={({ pressed }) => [
                styles.btn,
                styles.btnGhost,
                pressed && { opacity: 0.85 },
                (backupBusy || !sessionUser) && { opacity: 0.5 },
              ]}
            >
              {backupBusy ? (
                <ActivityIndicator color={colors.textEmphasis} />
              ) : (
                <Text style={styles.btnGhostText}>{t("settings.backup.now")}</Text>
              )}
            </Pressable>
            {backupError ? (
              <Text
                style={[styles.fieldHint, textDir(isRTL), { color: colors.danger, marginTop: 8 }]}
                accessibilityLiveRegion="polite"
              >
                {backupError}
              </Text>
            ) : null}
            <Text style={[styles.fieldHint, textDir(isRTL)]}>
              {sessionUser ? t("settings.backup.hint") : t("settings.backup.signInRequired")}
            </Text>
          </View>

          {/* Dev-only reset. Wipes SecureStore session + SQLite tables. */}
          {__DEV__ ? (
            <>
              <View style={{ height: 40 }} />
              <Pressable
                onPress={onResetAllData}
                style={({ pressed }) => [styles.resetBtn, pressed && { opacity: 0.7 }]}
              >
                <Text style={styles.resetBtnText}>Reset all data (dev only)</Text>
              </Pressable>
              <Text style={[styles.fieldHint, { textAlign: "center", marginTop: 8 }]}>
                Drops SQLite + clears session, then reloads.
              </Text>
            </>
          ) : null}
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function formatLastBackup(at: Date | null): string {
  if (!at) return t("settings.backup.never");
  const diffMs = Date.now() - at.getTime();
  const minutes = Math.floor(diffMs / 60_000);
  let when: string;
  if (minutes < 1) {
    when = t("settings.backup.justNow");
  } else if (minutes < 60) {
    when = t("settings.backup.minutesAgo", { n: String(minutes) });
  } else if (minutes < 60 * 24) {
    when = t("settings.backup.hoursAgo", { n: String(Math.floor(minutes / 60)) });
  } else {
    when = t("settings.backup.daysAgo", { n: String(Math.floor(minutes / (60 * 24))) });
  }
  return t("settings.backup.lastAt", { when });
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bgDefault },
  fillCenter: { flex: 1, alignItems: "center", justifyContent: "center" },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.borderDefault,
  },
  cancel: {
    fontSize: 15,
    fontFamily: fonts.sansMedium,
    color: colors.textSubtle,
    minWidth: 60,
  },
  title: {
    fontSize: 16,
    fontFamily: fonts.sansSemi,
    color: colors.textEmphasis,
  },
  scrollContent: { padding: 24, paddingBottom: 48 },
  sectionLabel: {
    fontSize: 11,
    fontFamily: fonts.sansSemi,
    color: colors.textMuted,
    letterSpacing: 0.6,
    textTransform: "uppercase",
    marginBottom: 12,
  },
  field: { marginBottom: 20 },
  label: {
    fontSize: 13,
    fontFamily: fonts.sansMedium,
    color: colors.textDefault,
    marginBottom: 8,
  },
  fieldHint: {
    fontSize: 12,
    fontFamily: fonts.sansRegular,
    color: colors.textSubtle,
    marginTop: 6,
    lineHeight: 18,
  },
  statusText: {
    fontSize: 13,
    fontFamily: fonts.sansRegular,
    color: colors.textDefault,
  },
  btn: {
    minHeight: 44,
    borderRadius: 10,
    paddingHorizontal: 16,
    alignItems: "center",
    justifyContent: "center",
  },
  btnPrimary: {
    flexDirection: "row",
    backgroundColor: colors.bgInverted,
  },
  btnPrimaryText: {
    fontSize: 15,
    fontFamily: fonts.sansSemi,
    color: colors.textInverted,
  },
  btnGhost: {
    borderWidth: 1,
    borderColor: colors.borderDefault,
    backgroundColor: colors.bgDefault,
  },
  btnGhostText: {
    fontSize: 15,
    fontFamily: fonts.sansSemi,
    color: colors.textEmphasis,
  },
  resetBtn: {
    paddingVertical: 14,
    paddingHorizontal: 18,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.danger,
    alignItems: "center",
    backgroundColor: colors.bgDefault,
  },
  resetBtnText: {
    fontFamily: fonts.sansSemi,
    color: colors.danger,
    fontSize: 13,
  },
});
