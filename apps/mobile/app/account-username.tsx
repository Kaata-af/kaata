// Account → Sign-in → Username (docs/kaata-accounts.md §6.10, §7).
//
// An optional, private sign-in handle: with the account's password it works in
// place of the email ("email or username + password"). Never shown to anyone
// else, and never a trust key. Only an account with a password can have one (a
// username alone cannot sign in), so without a password this screen points to
// "Set a password" instead. The rules are mirrored for instant feedback; the
// server's word is final (invalid_username, username_taken).

import { useRouter } from "expo-router";
import { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  type TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Button } from "../components/Button";
import { FormField, LTR_INPUT } from "../components/FormField";
import { ScreenHeader } from "../components/SettingsScreen";
import { useToast } from "../components/Toast";
import {
  accountFailureText,
  accountRefusal,
  normalizeUsernameInput,
  usernameProblem,
} from "../lib/account-rules";
import { type AccountMe, fetchAccountMe, setUsername } from "../lib/auth";
import { colors } from "../lib/colors";
import { textDir, useIsRTL } from "../lib/direction";
import { fonts, sansLineHeight } from "../lib/fonts";
import { t } from "../lib/i18n";
import { gutter, typography } from "../lib/tokens";
import { useOnboardingKeyboardScroll } from "../lib/use-onboarding-keyboard-scroll";

// ref + setTimeout, never autoFocus (Android opens no keyboard mid-transition).
const FOCUS_DELAY_MS = 280;

export default function AccountUsernameScreen() {
  const router = useRouter();
  const toast = useToast();
  const isRTL = useIsRTL();
  const { scrollProps, focusInput, blurInput } = useOnboardingKeyboardScroll();

  const [me, setMe] = useState<AccountMe | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [username, setUsernameText] = useState("");
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState<null | "save" | "remove">(null);
  const busyRef = useRef(false);
  const inputRef = useRef<TextInput>(null);

  async function load() {
    setLoadFailed(false);
    try {
      const account = await fetchAccountMe();
      setMe(account);
      setUsernameText(account.username ?? "");
    } catch (err) {
      console.warn("[account-username] load failed", err);
      setLoadFailed(true);
    }
  }

  useEffect(() => {
    void load();
    // Once per visit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const canEdit = !!me?.hasPassword;

  // The field, once it is on screen.
  useEffect(() => {
    if (!canEdit) return;
    const timer = setTimeout(() => inputRef.current?.focus(), FOCUS_DELAY_MS);
    return () => clearTimeout(timer);
  }, [canEdit]);

  async function run(kind: "save" | "remove", value: string, done: string) {
    if (busyRef.current) return;
    busyRef.current = true;
    setFieldError(null);
    setFormError(null);
    setBusy(kind);
    try {
      await setUsername(value);
      toast.push(done, "success");
      router.back();
    } catch (err) {
      const refusal = accountRefusal(err);
      if (refusal?.field === "username") setFieldError(refusal.text);
      else setFormError(accountFailureText(err));
      if (refusal?.reason === "no_password" && me) setMe({ ...me, hasPassword: false });
    } finally {
      busyRef.current = false;
      setBusy(null);
    }
  }

  async function save() {
    const name = normalizeUsernameInput(username);
    if (!name) {
      // An emptied field is a removal, when there is something to remove.
      if (me?.username) await run("remove", "", t("accountUsername.removed"));
      else router.back();
      return;
    }
    if (name === me?.username) {
      router.back();
      return;
    }
    const problem = usernameProblem(name);
    if (problem) {
      setFormError(null);
      setFieldError(
        t(problem === "reserved" ? "auth.error.username.reserved" : "auth.error.username.format"),
      );
      return;
    }
    await run("save", name, t("accountUsername.saved"));
  }

  let content;
  if (!me) {
    content = loadFailed ? (
      <>
        <Text style={[styles.body, textDir(isRTL)]}>{t("accountPassword.loadFailed")}</Text>
        <View style={styles.gap} />
        <Button label={t("common.retry")} onPress={() => void load()} variant="secondary" />
      </>
    ) : (
      <ActivityIndicator color={colors.textSubtle} style={styles.loading} />
    );
  } else if (!canEdit) {
    content = (
      <>
        <Text style={[styles.body, textDir(isRTL)]}>{t("accountUsername.needsPassword")}</Text>
        <View style={styles.gap} />
        <Button
          label={t("account.signin.password.set")}
          onPress={() => router.replace("/account-password")}
          fullWidth
        />
      </>
    );
  } else {
    content = (
      <>
        <Text style={[styles.body, textDir(isRTL)]}>{t("accountUsername.body")}</Text>
        <View style={styles.spacer} />
        <FormField
          ref={inputRef}
          onFocus={() => focusInput(inputRef.current)}
          onBlur={() => blurInput(inputRef.current)}
          label={t("accountUsername.title")}
          value={username}
          onChangeText={(s) => {
            setUsernameText(s);
            if (fieldError) setFieldError(null);
          }}
          autoCapitalize="none"
          autoCorrect={false}
          spellCheck={false}
          autoComplete="username-new"
          textContentType="username"
          maxLength={30}
          editable={busy === null}
          returnKeyType="done"
          onSubmitEditing={save}
          style={LTR_INPUT}
          error={fieldError}
        />
        <Text style={[styles.rules, textDir(isRTL)]}>{t("accountUsername.rules")}</Text>
        {formError ? (
          <Text style={[styles.formError, textDir(isRTL)]} accessibilityLiveRegion="polite">
            {formError}
          </Text>
        ) : null}
        <Button
          label={t("accountUsername.save")}
          onPress={save}
          loading={busy === "save"}
          disabled={busy !== null}
          fullWidth
        />
        {me.username ? (
          <>
            <View style={styles.gap} />
            <Button
              label={t("accountUsername.remove")}
              onPress={() => void run("remove", "", t("accountUsername.removed"))}
              loading={busy === "remove"}
              disabled={busy !== null}
              variant="secondary"
              fullWidth
            />
          </>
        ) : null}
      </>
    );
  }

  return (
    <SafeAreaView style={styles.container} edges={["top", "bottom"]}>
      <ScreenHeader
        title={t("accountUsername.title")}
        onBack={() => router.back()}
        backDisabled={busy !== null}
        isRTL={isRTL}
        backLabel={t("common.back")}
      />
      <KeyboardAvoidingView
        style={styles.flex}
        // Android draws edge-to-edge, so the window never shrinks for the
        // keyboard: without this the buttons sit under it. Inert on iOS,
        // whose ScrollView insets compensate (see the hook); enabled there it
        // would compensate twice.
        behavior="height"
        enabled={Platform.OS === "android"}
      >
        <ScrollView
          {...scrollProps}
          style={styles.flex}
          contentContainerStyle={styles.content}
          showsVerticalScrollIndicator={false}
        >
          {content}
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bgDefault },
  flex: { flex: 1 },
  content: { flexGrow: 1, paddingHorizontal: gutter.settings, paddingTop: 20, paddingBottom: 48 },
  loading: { marginTop: 48 },
  body: { ...typography.body, color: colors.textDefault },
  spacer: { height: 20 },
  gap: { height: 12 },
  // Under the field (FormField keeps 20 below itself).
  rules: { ...typography.hint, color: colors.textSubtle, marginTop: -12, marginBottom: 16 },
  formError: {
    fontSize: 13,
    fontFamily: fonts.sansMedium,
    color: colors.danger,
    lineHeight: sansLineHeight(13, 19),
    marginBottom: 12,
  },
});
