import type { TextInputInstance } from "react-native";
// Account → Sign-in → Password (docs/kaata-accounts.md §6.7-6.9, §7).
//
// "Set a password": a Google or Apple account's FIRST Kaata password, which
// only a signed-in account can add (principle 1). A code goes to an address the
// user proves, prefilled with the account's own email unless that is an Apple
// relay address (which nobody can read); the code and the new password then set
// it, and this session stays signed in.
// "Change password": the current one and a new one. Every OTHER phone signed in
// to the account is signed out.
//
// Which of the two is the server's answer (GET /v1/account/me), not what the
// Account screen showed, and a refusal that says otherwise (password_exists,
// no_password) switches over. A setup code the app was killed on reopens on the
// code step for its 15 minutes (lib/auth readSetupFlowPending), for the account
// that started it only.
//
// Where the code goes is the server's call (§6.7): the account's own address
// whenever it is usable (GET /v1/account/me's setup_email, shown read-only),
// so whoever holds this session cannot attach a mailbox of their own. Only an
// account without a usable address (an Apple relay) names one in the field.

import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
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
import { Button } from "../components/Button";
import { FormField, LTR_INPUT } from "../components/FormField";
import { PasswordField } from "../components/PasswordField";
import { PasswordRules } from "../components/PasswordRules";
import { ScreenHeader } from "../components/SettingsScreen";
import { useToast } from "../components/Toast";
import {
  accountFailureText,
  accountRefusal,
  CODE_LENGTH,
  countdownText,
  emailProblem,
  isAppleRelayAddress,
  newPasswordProblem,
  normalizeCodeInput,
  normalizeEmailInput,
  type RefusalField,
} from "../lib/account-rules";
import {
  type AccountMe,
  changePassword,
  clearEmailFlowPending,
  fetchAccountMe,
  passwordSetupStart,
  passwordSetupVerify,
  readSetupFlowPending,
} from "../lib/auth";
import { colors } from "../lib/colors";
import { ltrIsolate, rowDir, textDir, useIsRTL } from "../lib/direction";
import { fonts, sansLineHeight } from "../lib/fonts";
import { getLocale, t } from "../lib/i18n";
import { gutter, TOUCH_MIN, typography } from "../lib/tokens";
import { useOnboardingKeyboardScroll } from "../lib/use-onboarding-keyboard-scroll";

type Key = Parameters<typeof t>[0];
type Field = "email" | "code" | "current" | "newPassword";

/** The resend wait when the server names none. */
const RESEND_AFTER_S = 60;

// The address a first-password code goes to: the server's fixed one when it
// gives one; otherwise the account's own, unless that is an Apple relay
// address nobody can read (then the user types one).
function setupAddress(account: AccountMe): string {
  if (account.setupEmail) return account.setupEmail;
  return isAppleRelayAddress(account.email) ? "" : account.email;
}
// ref + setTimeout, never autoFocus (Android opens no keyboard mid-transition).
const FOCUS_DELAY_MS = 280;

export default function AccountPasswordScreen() {
  const router = useRouter();
  const toast = useToast();
  const isRTL = useIsRTL();
  const { scrollProps, focusInput, blurInput } = useOnboardingKeyboardScroll();

  const [me, setMe] = useState<AccountMe | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  // null while loading; then the server's answer.
  const [mode, setMode] = useState<null | "set" | "change">(null);
  const [step, setStep] = useState<"email" | "code">("email");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [current, setCurrent] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [errors, setErrors] = useState<Partial<Record<Field, string>>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [busy, setBusy] = useState<null | "submit" | "resend">(null);
  const busyRef = useRef(false);
  const [resendAt, setResendAt] = useState(0);
  const [now, setNow] = useState(Date.now());
  const emailRef = useRef<TextInputInstance>(null);
  const codeRef = useRef<TextInputInstance>(null);
  const currentRef = useRef<TextInputInstance>(null);
  const newPasswordRef = useRef<TextInputInstance>(null);

  const remaining = Math.max(0, Math.ceil((resendAt - now) / 1000));

  async function load() {
    setLoadFailed(false);
    try {
      const account = await fetchAccountMe();
      // Only THIS account's setup step: one left by another account on this
      // phone is forgotten, never offered here.
      const pending = account.hasPassword ? null : await readSetupFlowPending();
      setMe(account);
      if (account.hasPassword) {
        setMode("change");
      } else if (pending && (pending.email || account.setupEmail)) {
        setMode("set");
        setEmail(account.setupEmail ?? pending.email);
        setStep("code");
        setNow(Date.now());
        setResendAt(pending.sentAt + RESEND_AFTER_S * 1000);
      } else {
        setMode("set");
        setEmail(setupAddress(account));
      }
    } catch (err) {
      console.warn("[account-password] load failed", err);
      setLoadFailed(true);
    }
  }

  useEffect(() => {
    void load();
    // Once per visit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The first field of whatever is on screen.
  useEffect(() => {
    if (!mode) return;
    const target = mode === "change" ? currentRef : step === "code" ? codeRef : emailRef;
    const timer = setTimeout(() => target.current?.focus(), FOCUS_DELAY_MS);
    return () => clearTimeout(timer);
  }, [mode, step]);

  // The resend countdown ticks only while it runs.
  useEffect(() => {
    if (resendAt <= Date.now()) return;
    const timer = setInterval(() => {
      const at = Date.now();
      setNow(at);
      if (at >= resendAt) clearInterval(timer);
    }, 1000);
    return () => clearInterval(timer);
  }, [resendAt]);

  function clearMessages() {
    setErrors({});
    setFormError(null);
    setInfo(null);
  }

  function fieldFor(field: RefusalField): Field | null {
    // The email field exists only where the user names the address.
    if (field === "email" && mode === "set" && step === "email" && !me?.setupEmail) return "email";
    if (field === "code" && step === "code") return "code";
    if (field === "currentPassword" && mode === "change") return "current";
    if (field === "newPassword" && (mode === "change" || step === "code")) return "newPassword";
    return null;
  }

  // One request at a time. The server's refusals land under their field;
  // everything else on the form's own line.
  async function run(kind: "submit" | "resend", work: () => Promise<void>) {
    if (busyRef.current) return;
    busyRef.current = true;
    clearMessages();
    setBusy(kind);
    try {
      await work();
    } catch (err) {
      const refusal = accountRefusal(err);
      const field = refusal ? fieldFor(refusal.field) : null;
      if (refusal && field) setErrors({ [field]: refusal.text });
      else setFormError(accountFailureText(err));
      // The server knows better than the screen did.
      if (refusal?.reason === "password_exists") {
        void clearEmailFlowPending();
        setStep("email");
        setMode("change");
      } else if (refusal?.reason === "no_password") {
        if (!email && me) setEmail(setupAddress(me));
        setStep("email");
        setMode("set");
      }
    } finally {
      busyRef.current = false;
      setBusy(null);
    }
  }

  function refuse(next: Partial<Record<Field, string>>): boolean {
    if (Object.keys(next).length === 0) return false;
    clearMessages();
    setErrors(next);
    return true;
  }

  function newPasswordError(value: string): string | undefined {
    const problem = newPasswordProblem(value);
    return problem ? t(`auth.error.password.${problem}` as Key) : undefined;
  }

  function startCountdown(seconds: number) {
    const at = Date.now();
    setNow(at);
    setResendAt(at + Math.max(0, seconds) * 1000);
  }

  // ---- set: a code to the address, then the code and the password ----

  async function sendCode() {
    const fixed = me?.setupEmail ?? null;
    const address = fixed ?? normalizeEmailInput(email);
    const problem = fixed ? null : emailProblem(address);
    if (
      refuse(
        problem
          ? {
              email: t(
                problem === "empty"
                  ? "auth.error.email.required"
                  : problem === "relay"
                    ? "auth.error.email.relay"
                    : "auth.error.email.format",
              ),
            }
          : {},
      )
    ) {
      return;
    }
    await run("submit", async () => {
      const sent = await passwordSetupStart(address, getLocale());
      setEmail(address);
      setCode("");
      startCountdown(sent.resendAfterS);
      setStep("code");
    });
  }

  async function resend() {
    if (remaining > 0) return;
    await run("resend", async () => {
      const sent = await passwordSetupStart(email, getLocale());
      startCountdown(sent.resendAfterS);
      setInfo(t("auth.email.code.resent"));
    });
  }

  function changeEmail() {
    void clearEmailFlowPending();
    clearMessages();
    setCode("");
    setStep("email");
  }

  async function savePassword() {
    const digits = normalizeCodeInput(code);
    const next: Partial<Record<Field, string>> = {};
    if (digits.length !== CODE_LENGTH) next.code = t("auth.email.codeRequired");
    const badPassword = newPasswordError(newPassword);
    if (badPassword) next.newPassword = badPassword;
    if (refuse(next)) return;
    await run("submit", async () => {
      const { loginEmail } = await passwordSetupVerify(digits, newPassword, getLocale());
      toast.push(
        t("accountPassword.set.done", { email: ltrIsolate(loginEmail ?? email) }),
        "success",
      );
      router.back();
    });
  }

  // ---- change ----

  async function savePasswordChange() {
    const next: Partial<Record<Field, string>> = {};
    if (!current.trim()) next.current = t("auth.email.passwordRequired");
    const badPassword = newPasswordError(newPassword);
    if (badPassword) next.newPassword = badPassword;
    if (refuse(next)) return;
    await run("submit", async () => {
      // This session stays; lib/auth stores the re-signed token it returns.
      await changePassword(current, newPassword, getLocale());
      toast.push(t("accountPassword.change.done"), "success");
      router.back();
    });
  }

  const focusHandlers = (ref: { current: TextInputInstance | null }) => ({
    onFocus: () => focusInput(ref.current),
    onBlur: () => blurInput(ref.current),
  });

  function link(label: string, onPress: () => void, spinning = false) {
    return (
      <Pressable
        onPress={onPress}
        disabled={busy !== null}
        accessibilityRole="button"
        accessibilityLabel={label}
        style={({ pressed }) => [
          styles.link,
          pressed && { opacity: 0.6 },
          busy !== null && !spinning && { opacity: 0.5 },
        ]}
      >
        {spinning ? (
          <ActivityIndicator color={colors.textSubtle} />
        ) : (
          <Text style={styles.linkText}>{label}</Text>
        )}
      </Pressable>
    );
  }

  function newPasswordField(onSubmit: () => void, label: Key) {
    return (
      <>
        <PasswordField
          ref={newPasswordRef}
          {...focusHandlers(newPasswordRef)}
          label={t(label)}
          value={newPassword}
          onChangeText={(s) => {
            setNewPassword(s);
            if (errors.newPassword) setErrors({ ...errors, newPassword: undefined });
          }}
          autoComplete="new-password"
          textContentType="newPassword"
          editable={busy === null}
          returnKeyType="go"
          onSubmitEditing={onSubmit}
          error={errors.newPassword ?? null}
        />
        <PasswordRules value={newPassword} isRTL={isRTL} />
      </>
    );
  }

  function messages() {
    return (
      <>
        {formError ? (
          <Text style={[styles.formError, textDir(isRTL)]} accessibilityLiveRegion="polite">
            {formError}
          </Text>
        ) : null}
        {info ? (
          <Text style={[styles.info, textDir(isRTL)]} accessibilityLiveRegion="polite">
            {info}
          </Text>
        ) : null}
      </>
    );
  }

  let content;
  if (mode === null) {
    content = loadFailed ? (
      <>
        <Text style={[styles.body, textDir(isRTL)]}>{t("accountPassword.loadFailed")}</Text>
        <View style={styles.gap} />
        <Button label={t("common.retry")} onPress={() => void load()} variant="secondary" />
      </>
    ) : (
      <ActivityIndicator color={colors.textSubtle} style={styles.loading} />
    );
  } else if (mode === "change") {
    content = (
      <>
        <Text style={[styles.body, textDir(isRTL)]}>{t("accountPassword.change.body")}</Text>
        <View style={styles.spacer} />
        <PasswordField
          ref={currentRef}
          {...focusHandlers(currentRef)}
          label={t("accountPassword.change.current")}
          value={current}
          onChangeText={(s) => {
            setCurrent(s);
            if (errors.current) setErrors({ ...errors, current: undefined });
          }}
          autoComplete="current-password"
          textContentType="password"
          editable={busy === null}
          returnKeyType="next"
          onSubmitEditing={() => newPasswordRef.current?.focus()}
          submitBehavior="submit"
          error={errors.current ?? null}
        />
        {newPasswordField(savePasswordChange, "auth.email.reset.newPassword")}
        {messages()}
        <Button
          label={t("accountPassword.change.submit")}
          onPress={savePasswordChange}
          loading={busy === "submit"}
          disabled={busy !== null}
          fullWidth
        />
      </>
    );
  } else if (step === "email") {
    content = (
      <>
        <Text style={[styles.body, textDir(isRTL)]}>{t("accountPassword.set.body")}</Text>
        {me?.setupEmail ? (
          // The server's fixed address: shown, never edited.
          <Text style={[styles.fixedEmail, textDir(isRTL)]}>
            {t("accountPassword.set.fixedEmail", { email: ltrIsolate(me.setupEmail) })}
          </Text>
        ) : (
          <>
            {me && isAppleRelayAddress(me.email) ? (
              <Text style={[styles.note, textDir(isRTL)]}>
                {t("accountPassword.set.relayNote")}
              </Text>
            ) : null}
            <View style={styles.spacer} />
            <FormField
              ref={emailRef}
              {...focusHandlers(emailRef)}
              label={t("auth.email.email")}
              value={email}
              onChangeText={(s) => {
                setEmail(s);
                if (errors.email) setErrors({ ...errors, email: undefined });
              }}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="email-address"
              autoComplete="email"
              textContentType="emailAddress"
              editable={busy === null}
              returnKeyType="go"
              onSubmitEditing={sendCode}
              style={LTR_INPUT}
              error={errors.email ?? null}
            />
          </>
        )}
        {messages()}
        <Button
          label={t("auth.email.sendCode")}
          onPress={sendCode}
          loading={busy === "submit"}
          disabled={busy !== null}
          fullWidth
        />
      </>
    );
  } else {
    content = (
      <>
        <Text style={[styles.body, textDir(isRTL)]}>
          {t("accountPassword.set.codeSent", { email: ltrIsolate(email) })}
        </Text>
        <View style={styles.spacer} />
        <FormField
          ref={codeRef}
          {...focusHandlers(codeRef)}
          label={t("auth.email.code.label")}
          value={code}
          onChangeText={(s) => {
            setCode(normalizeCodeInput(s));
            if (errors.code) setErrors({ ...errors, code: undefined });
          }}
          keyboardType="number-pad"
          autoComplete="one-time-code"
          textContentType="oneTimeCode"
          autoCorrect={false}
          editable={busy === null}
          returnKeyType="next"
          onSubmitEditing={() => newPasswordRef.current?.focus()}
          submitBehavior="submit"
          style={[LTR_INPUT, styles.codeInput]}
          error={errors.code ?? null}
        />
        {/* The one thing a Gmail user must not do here: reuse their Google password. */}
        <View style={[styles.helperRow, rowDir(isRTL)]}>
          <Ionicons name="key-outline" size={16} color={colors.textEmphasis} />
          <Text style={[styles.helper, textDir(isRTL)]}>{t("auth.email.newPassword.helper")}</Text>
        </View>
        {newPasswordField(savePassword, "auth.email.newPassword")}
        {messages()}
        <Button
          label={t("accountPassword.set.submit")}
          onPress={savePassword}
          loading={busy === "submit"}
          disabled={busy !== null}
          fullWidth
        />
        <Text style={[styles.note, textDir(isRTL)]}>{t("auth.email.code.spam")}</Text>
        {remaining > 0 ? (
          <Text style={styles.countdown}>
            {t("auth.email.code.resendIn", { time: ltrIsolate(countdownText(remaining)) })}
          </Text>
        ) : (
          link(t("auth.email.code.resend"), resend, busy === "resend")
        )}
        {/* A fixed address cannot change; only a typed one can. */}
        {me?.setupEmail ? null : link(t("auth.email.code.changeEmail"), changeEmail)}
      </>
    );
  }

  return (
    <SafeAreaView style={styles.container} edges={["top", "bottom"]}>
      <ScreenHeader
        title={t(mode === "change" ? "accountPassword.title.change" : "accountPassword.title.set")}
        onBack={() => router.back()}
        backDisabled={busy !== null}
        isRTL={isRTL}
        backLabel={t("common.back")}
      />
      <KeyboardAvoidingView
        style={styles.flex}
        // Android draws edge-to-edge, so the window never shrinks for the
        // keyboard: without this the lower fields and the button sit under
        // it. Inert on iOS, whose ScrollView insets compensate (see the hook);
        // enabled there it would compensate twice.
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
  note: { ...typography.bodySm, color: colors.textSubtle, marginTop: 12 },
  fixedEmail: {
    ...typography.body,
    fontFamily: fonts.sansSemi,
    color: colors.textEmphasis,
    marginTop: 16,
    marginBottom: 20,
  },
  spacer: { height: 20 },
  gap: { height: 16 },
  helperRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 8,
    marginBottom: 10,
  },
  helper: {
    flex: 1,
    fontSize: 13,
    fontFamily: fonts.sansMedium,
    color: colors.textEmphasis,
    lineHeight: sansLineHeight(13, 19),
  },
  // Six Latin digits: mono, spaced, a size up (LTR in both languages).
  codeInput: { fontFamily: fonts.monoMedium, fontSize: 20, letterSpacing: 4 },
  countdown: {
    ...typography.body,
    fontFamily: fonts.sansMedium,
    color: colors.textMuted,
    textAlign: "center",
    paddingVertical: 12,
  },
  link: {
    alignSelf: "center",
    justifyContent: "center",
    minHeight: TOUCH_MIN,
    marginTop: 4,
    paddingHorizontal: 12,
  },
  linkText: {
    fontSize: 14,
    fontFamily: fonts.sansMedium,
    color: colors.textSubtle,
    textDecorationLine: "underline",
    textAlign: "center",
    lineHeight: sansLineHeight(14, 20),
  },
  formError: {
    fontSize: 13,
    fontFamily: fonts.sansMedium,
    color: colors.danger,
    lineHeight: sansLineHeight(13, 19),
    marginBottom: 12,
  },
  info: {
    fontSize: 13,
    fontFamily: fonts.sansMedium,
    color: colors.textEmphasis,
    lineHeight: sansLineHeight(13, 19),
    marginBottom: 12,
  },
});
