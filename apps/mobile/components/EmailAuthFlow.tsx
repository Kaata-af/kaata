import { Ionicons } from "@expo/vector-icons";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, type TextInput, View } from "react-native";
import {
  accountRefusal,
  CODE_LENGTH,
  countdownText,
  emailProblem,
  isGmailAddress,
  newPasswordProblem,
  normalizeCodeInput,
  normalizeEmailInput,
  normalizeIdentifierInput,
  type RefusalField,
} from "../lib/account-rules";
import {
  clearEmailFlowPending,
  type DifferentAccountPrompt,
  emailResetStart,
  emailResetVerify,
  emailSignIn,
  emailSignUpStart,
  emailSignUpVerify,
  type EmailFlowPending,
  isCancellation,
  type SessionUser,
  SignInFailedError,
} from "../lib/auth";
import { colors } from "../lib/colors";
import { ltrIsolate, rowDir, textDir, trackingSafe } from "../lib/direction";
import { fonts, sansLineHeight } from "../lib/fonts";
import { getLocale, t } from "../lib/i18n";
import { TOUCH_MIN, typography } from "../lib/tokens";
import { Button } from "./Button";
import { FormField, LTR_INPUT } from "./FormField";
import { GoogleGIcon } from "./GoogleGIcon";
import { PasswordField } from "./PasswordField";
import { PasswordRules } from "./PasswordRules";

// Kaata's own sign-in: email + password (docs/kaata-accounts.md §7). Rendered by
// AuthScreen (app/onboarding/auth.tsx) INSIDE its KeyboardAvoidingView +
// ScrollView, so it has no ScrollView of its own and reports focus through
// AuthScreen's focusInput/blurInput (useOnboardingKeyboardScroll), which is what
// keeps a focused field above the keyboard on both platforms.
//
// Steps:
//   signin  email or username + password; "Forgot password?"; "Create an account"
//   signup  email + a NEW Kaata password (rules shown) → a code is emailed
//   code    the 6-digit code that creates the account
//   forgot  email → a reset code (only an account that has a password gets one)
//   reset   code + new password → signed in
// Onboarding opens on signup and /sign-in on signin; each offers the other.
//
// What it does NOT own: the busy state shared with the Google and Apple cards
// (props.run), what happens after a sign-in (props.onSignedIn → AuthScreen's
// completeSignIn), failures it cannot word as a field or form error
// (props.onFailure → showSignInFailure, which also offers the retired-install
// reset), and the "different account on this phone?" dialog.
//
// A code request remembers {purpose, email, sent_at} in app_meta (lib/auth), so
// AuthScreen reopens this flow on the code step (props.resume) when Android
// killed the app while the user read their email. Leaving a code step through
// Back or "Change email" forgets it. The sign-up password is never stored: a
// reopened code step asks for it again.

export type EmailAuthStep = "signin" | "signup" | "code" | "forgot" | "reset";

type Key = Parameters<typeof t>[0];
type Field = "email" | "identifier" | "password" | "newPassword" | "code";
type FieldErrors = Partial<Record<Field, string>>;

/** The resend wait when the server names none (its own default). */
const RESEND_AFTER_S = 60;
// ref + setTimeout, never autoFocus: a field focused during a transition opens
// no keyboard on Android.
const FOCUS_DELAY_MS = 280;

export type EmailAuthFlowProps = {
  /** The step a fresh flow opens on: sign-up in onboarding, sign-in on /sign-in. */
  entry: "signin" | "signup";
  /** A code step to reopen (lib/auth readEmailFlowPending), or null. */
  resume?: EmailFlowPending | null;
  isRTL: boolean;
  /** Any sign-in on the screen is running: every control holds still. */
  busy: boolean;
  /** Google sign-in works in this build: a Gmail address gets the shortcut. */
  googleAvailable: boolean;
  focusInput: (input: TextInput | null) => void;
  blurInput: (input: TextInput | null) => void;
  /** AuthScreen's busy wrapper: one request at a time across the whole screen. */
  run: (task: () => Promise<void>) => Promise<void>;
  /** A session is installed: AuthScreen's completeSignIn(user, "email"). */
  onSignedIn: (user: SessionUser) => Promise<void>;
  /** A failure this flow does not word (timeout, outage, retired install). */
  onFailure: (err: unknown) => void;
  /** "Continue with Google": AuthScreen's Google sign-in. */
  onGoogle: () => void;
  /** Back to the Google and Apple choices. */
  onExit: () => void;
  promptDifferentAccount: DifferentAccountPrompt;
  /** AuthScreen's failure text and retired-install reset, shown above the button. */
  notice?: ReactNode;
  /** Set to this flow's one-step back; it answers false at the first step. */
  backRef: { current: (() => boolean) | null };
  /** Native Back can leave the email route only at its first step. */
  onCanStepBackChange?: (canGoBack: boolean) => void;
};

function initialHistory(
  entry: "signin" | "signup",
  resume: EmailFlowPending | null,
): EmailAuthStep[] {
  if (resume?.purpose === "signup") return ["signup", "code"];
  if (resume?.purpose === "reset") return ["signin", "forgot", "reset"];
  return [entry];
}

export function EmailAuthFlow(props: EmailAuthFlowProps) {
  const { isRTL } = props;
  const resume = props.resume ?? null;
  // A stack, so Back retraces exactly the steps the user took.
  const [history, setHistory] = useState<EmailAuthStep[]>(initialHistory(props.entry, resume));
  const step = history[history.length - 1];
  const [email, setEmail] = useState(resume?.email ?? "");
  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [code, setCode] = useState("");
  // The sign-up password lives only in memory, so a code step reopened after
  // the app was killed asks for it again; so does a code step whose password
  // the server refused (common or personal: the checks only it can make).
  const [askPassword, setAskPassword] = useState(resume?.purpose === "signup");
  const [resendAt, setResendAt] = useState(resume ? resume.sentAt + RESEND_AFTER_S * 1000 : 0);
  const [now, setNow] = useState(Date.now());
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  // The way out a form error offers: the provider buttons after
  // invalid_credentials. (account_exists needs none: the sign-up code step
  // always offers "Already have an account? Sign in".)
  const [formAction, setFormAction] = useState<null | "providers">(null);
  const [info, setInfo] = useState<string | null>(null);
  const [working, setWorking] = useState<null | "submit" | "resend">(null);
  // The last verify of this step failed on the network, so it may have reached
  // the server: lib/auth then reads a spent code as our own success.
  const afterTimeout = useRef(false);
  const emailRef = useRef<TextInput>(null);
  const identifierRef = useRef<TextInput>(null);
  const passwordRef = useRef<TextInput>(null);
  const newPasswordRef = useRef<TextInput>(null);
  const codeRef = useRef<TextInput>(null);

  const disabled = props.busy;
  const remaining = Math.max(0, Math.ceil((resendAt - now) / 1000));

  // The step's first field, once the step is on screen. Never on the FIRST
  // step (the one the flow opened on, or the bottom of the stack after Back):
  // a keyboard that opens by itself hides the step, its words and its other
  // way in, which is what Play's reviewer met. A step the user moved to on
  // purpose is focused.
  const focusArmed = useRef(false);
  useEffect(() => {
    const opening = !focusArmed.current;
    focusArmed.current = true;
    if (opening || history.length === 1) return;
    const target =
      step === "signin"
        ? identifier
          ? passwordRef
          : identifierRef
        : step === "signup" || step === "forgot"
          ? emailRef
          : codeRef;
    const timer = setTimeout(() => target.current?.focus(), FOCUS_DELAY_MS);
    return () => clearTimeout(timer);
    // Only a new step moves the focus; typing must not.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);

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

  // AuthScreen's Back, hardware or on-screen, retraces this flow first.
  useEffect(() => {
    props.backRef.current = stepBack;
  });

  useEffect(() => {
    props.onCanStepBackChange?.(history.length > 1);
  }, [history.length, props.onCanStepBackChange]);

  function clearMessages() {
    setErrors({});
    setFormError(null);
    setFormAction(null);
    setInfo(null);
  }

  function goTo(next: EmailAuthStep) {
    clearMessages();
    setHistory([...history, next]);
  }

  // To `target`: back down the stack when it is the step below, else in place
  // of the current step (sign-in and sign-up are siblings, not a path).
  function backTo(target: EmailAuthStep) {
    clearMessages();
    setHistory(
      history.length > 1 && history[history.length - 2] === target
        ? history.slice(0, -1)
        : [...history.slice(0, -1), target],
    );
  }

  // Leaving a code step is a cancel: it will not be reopened.
  function forgetCodeStep() {
    void clearEmailFlowPending();
    setCode("");
    afterTimeout.current = false;
  }

  function stepBack(): boolean {
    if (history.length <= 1) return false;
    if (step === "code" || step === "reset") forgetCodeStep();
    clearMessages();
    setHistory(history.slice(0, -1));
    return true;
  }

  function startCountdown(seconds: number) {
    const at = Date.now();
    setNow(at);
    setResendAt(at + Math.max(0, seconds) * 1000);
  }

  // The field of THIS step a refusal belongs under, or null for the form line.
  function fieldFor(field: RefusalField): Field | null {
    if (field === "email" && (step === "signup" || step === "forgot")) return "email";
    if (field === "newPassword" && step !== "signin" && step !== "forgot") return "newPassword";
    if (field === "code" && (step === "code" || step === "reset")) return "code";
    return null;
  }

  function show(err: unknown, kind: "submit" | "resend") {
    // Only the step's own request says whether IT may have landed; a failed
    // resend says nothing about the last verify.
    if (kind === "submit") {
      afterTimeout.current =
        err instanceof SignInFailedError && (err.stage === "timeout" || err.stage === "network");
    }
    const refusal = accountRefusal(err);
    if (!refusal) {
      props.onFailure(err);
      return;
    }
    const field = fieldFor(refusal.field);
    if (field) setErrors({ [field]: refusal.text });
    else setFormError(refusal.text);
    if (refusal.field === "newPassword" && step === "code") setAskPassword(true);
    if (refusal.reason === "invalid_credentials") setFormAction("providers");
  }

  // One request, through AuthScreen's busy gate. A cancelled
  // "different account?" dialog is the user's answer, not a failure.
  async function attempt(kind: "submit" | "resend", work: () => Promise<void>) {
    await props.run(async () => {
      clearMessages();
      setWorking(kind);
      try {
        await work();
      } catch (err) {
        if (!isCancellation(err)) show(err, kind);
      } finally {
        setWorking(null);
      }
    });
  }

  function refuse(next: FieldErrors): boolean {
    if (Object.keys(next).length === 0) return false;
    clearMessages();
    setErrors(next);
    return true;
  }

  function emailError(address: string): string | null {
    const problem = emailProblem(address);
    if (problem === "empty") return t("auth.email.required");
    if (problem === "relay") return t("auth.error.email.relay");
    return problem ? t("auth.error.email.format") : null;
  }

  function newPasswordError(value: string): string | null {
    const problem = newPasswordProblem(value);
    return problem ? t(`auth.error.password.${problem}` as Key) : null;
  }

  function codeError(digits: string): string | null {
    return digits.length === CODE_LENGTH ? null : t("auth.email.codeRequired");
  }

  // Drops an error from `errors` (typing into a field clears its own error).
  function clearError(field: Field) {
    if (errors[field]) setErrors({ ...errors, [field]: undefined });
  }

  // ---- actions ----

  async function submitSignIn() {
    if (disabled) return;
    const id = normalizeIdentifierInput(identifier);
    const next: FieldErrors = {};
    if (!id) next.identifier = t("auth.email.identifierRequired");
    // The server trims, so a password of spaces only is no password.
    if (!password.trim()) next.password = t("auth.email.passwordRequired");
    if (refuse(next)) return;
    await attempt("submit", async () => {
      const user = await emailSignIn(id, password, {
        onDifferentAccount: props.promptDifferentAccount,
      });
      await props.onSignedIn(user);
    });
  }

  async function submitSignUp() {
    if (disabled) return;
    const address = normalizeEmailInput(email);
    const next: FieldErrors = {};
    const badEmail = emailError(address);
    if (badEmail) next.email = badEmail;
    const badPassword = newPasswordError(newPassword);
    if (badPassword) next.newPassword = badPassword;
    if (refuse(next)) return;
    await attempt("submit", async () => {
      const sent = await emailSignUpStart(address, getLocale());
      setEmail(address);
      setCode("");
      setAskPassword(false);
      afterTimeout.current = false;
      startCountdown(sent.resendAfterS);
      goTo("code");
    });
  }

  async function submitCode() {
    if (disabled) return;
    const digits = normalizeCodeInput(code);
    const next: FieldErrors = {};
    const badCode = codeError(digits);
    if (badCode) next.code = badCode;
    const badPassword = askPassword ? newPasswordError(newPassword) : null;
    if (badPassword) next.newPassword = badPassword;
    if (refuse(next)) return;
    await attempt("submit", async () => {
      const user = await emailSignUpVerify(
        { email, code: digits, password: newPassword, lang: getLocale() },
        { onDifferentAccount: props.promptDifferentAccount, afterTimeout: afterTimeout.current },
      );
      await props.onSignedIn(user);
    });
  }

  async function submitForgot() {
    if (disabled) return;
    const address = normalizeEmailInput(email);
    const badEmail = emailError(address);
    if (refuse(badEmail ? { email: badEmail } : {})) return;
    await attempt("submit", async () => {
      const sent = await emailResetStart(address, getLocale());
      setEmail(address);
      setCode("");
      setNewPassword("");
      afterTimeout.current = false;
      startCountdown(sent.resendAfterS);
      goTo("reset");
    });
  }

  async function submitReset() {
    if (disabled) return;
    const digits = normalizeCodeInput(code);
    const next: FieldErrors = {};
    const badCode = codeError(digits);
    if (badCode) next.code = badCode;
    const badPassword = newPasswordError(newPassword);
    if (badPassword) next.newPassword = badPassword;
    if (refuse(next)) return;
    await attempt("submit", async () => {
      const user = await emailResetVerify(
        { email, code: digits, newPassword, lang: getLocale() },
        { onDifferentAccount: props.promptDifferentAccount, afterTimeout: afterTimeout.current },
      );
      await props.onSignedIn(user);
    });
  }

  async function resend() {
    if (disabled || remaining > 0) return;
    const reset = step === "reset";
    await attempt("resend", async () => {
      const sent = reset
        ? await emailResetStart(email, getLocale())
        : await emailSignUpStart(email, getLocale());
      startCountdown(sent.resendAfterS);
      setInfo(t("auth.email.code.resent"));
    });
  }

  function changeEmail() {
    forgetCodeStep();
    backTo(step === "reset" ? "forgot" : "signup");
  }

  // What the sign-in field holds, as sent: "@ali_shop" is a username, never an
  // address to carry into the email field.
  const typedIdentifier = () => normalizeIdentifierInput(identifier);

  function openForgot() {
    const id = typedIdentifier();
    if (id.includes("@")) setEmail(normalizeEmailInput(id));
    goTo("forgot");
  }

  // Between the two siblings, carrying what was typed across.
  function switchTo(target: "signin" | "signup") {
    const id = typedIdentifier();
    if (target === "signup" && !email && id.includes("@")) {
      setEmail(normalizeEmailInput(id));
    }
    if (target === "signin" && !identifier && email) setIdentifier(normalizeEmailInput(email));
    backTo(target);
  }

  // From the sign-up code step: the address already has an account (the email
  // that arrived says so, or verify answered account_exists).
  function signInInstead() {
    forgetCodeStep();
    setIdentifier(normalizeEmailInput(email));
    setPassword("");
    clearMessages();
    setHistory(history[0] === "signin" ? ["signin"] : [history[0], "signin"]);
  }

  const onFocus = (ref: { current: TextInput | null }) => () => props.focusInput(ref.current);
  const onBlur = (ref: { current: TextInput | null }) => () => props.blurInput(ref.current);

  // ---- pieces ----

  function header(title: Key, body: string) {
    return (
      <>
        <Text
          style={[styles.title, textDir(isRTL), trackingSafe(isRTL)]}
          accessibilityRole="header"
        >
          {t(title)}
        </Text>
        <Text style={[styles.subtitle, textDir(isRTL)]}>{body}</Text>
        <View style={styles.spacer} />
      </>
    );
  }

  // A quiet text button. Every one carries its label as accessibilityLabel.
  function link(label: string, onPress: () => void, spinning = false) {
    return (
      <Pressable
        onPress={onPress}
        disabled={disabled}
        accessibilityRole="button"
        accessibilityLabel={label}
        style={({ pressed }) => [
          styles.link,
          pressed && { opacity: 0.6 },
          disabled && !spinning && { opacity: 0.5 },
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

  // A Gmail address needs no Kaata password: Google signs it in. Offered on the
  // SIGN-UP step only. Under a sign-in it would steer the reviewer of a Gmail
  // review account to Android's device-bound Google sign-in, the path Play
  // rejected (build 49); there, invalid_credentials points to the provider
  // buttons instead.
  function gmailShortcut(value: string) {
    if (!props.googleAvailable || !isGmailAddress(value)) return null;
    const label = t("auth.email.gmail");
    return (
      <Pressable
        onPress={props.onGoogle}
        disabled={disabled}
        accessibilityRole="button"
        accessibilityLabel={label}
        style={({ pressed }) => [styles.gmail, rowDir(isRTL), pressed && { opacity: 0.6 }]}
      >
        <GoogleGIcon size={18} />
        <Text style={[styles.gmailText, textDir(isRTL)]}>{label}</Text>
      </Pressable>
    );
  }

  function newPasswordField(label: Key, onSubmit: () => void) {
    return (
      <>
        <PasswordField
          ref={newPasswordRef}
          onFocus={onFocus(newPasswordRef)}
          onBlur={onBlur(newPasswordRef)}
          label={t(label)}
          value={newPassword}
          onChangeText={(s) => {
            setNewPassword(s);
            clearError("newPassword");
          }}
          autoComplete="new-password"
          textContentType="newPassword"
          editable={!disabled}
          returnKeyType="go"
          onSubmitEditing={onSubmit}
          error={errors.newPassword ?? null}
        />
        <PasswordRules value={newPassword} isRTL={isRTL} />
      </>
    );
  }

  function codeField(onSubmit: () => void, nextIsPassword: boolean) {
    return (
      <FormField
        ref={codeRef}
        onFocus={onFocus(codeRef)}
        onBlur={onBlur(codeRef)}
        label={t("auth.email.code.label")}
        value={code}
        onChangeText={(s) => {
          setCode(normalizeCodeInput(s));
          clearError("code");
        }}
        keyboardType="number-pad"
        autoComplete="one-time-code"
        textContentType="oneTimeCode"
        autoCorrect={false}
        editable={!disabled}
        returnKeyType={nextIsPassword ? "next" : "go"}
        onSubmitEditing={nextIsPassword ? () => newPasswordRef.current?.focus() : onSubmit}
        submitBehavior={nextIsPassword ? "submit" : undefined}
        style={[LTR_INPUT, styles.codeInput]}
        error={errors.code ?? null}
      />
    );
  }

  function resendControls() {
    return (
      <>
        <Text style={[styles.hint, textDir(isRTL)]}>{t("auth.email.code.spam")}</Text>
        {remaining > 0 ? (
          <Text style={styles.countdown}>
            {t("auth.email.code.resendIn", { time: ltrIsolate(countdownText(remaining)) })}
          </Text>
        ) : (
          link(t("auth.email.code.resend"), resend, working === "resend")
        )}
        {link(t("auth.email.code.changeEmail"), changeEmail)}
      </>
    );
  }

  // The form's own line, its way out, a confirmation, and AuthScreen's notice.
  function messages() {
    return (
      <>
        {formError ? (
          <Text style={[styles.formError, textDir(isRTL)]} accessibilityLiveRegion="polite">
            {formError}
          </Text>
        ) : null}
        {formAction === "providers" ? link(t("auth.email.providerHint"), props.onExit) : null}
        {info ? (
          <Text style={[styles.info, textDir(isRTL)]} accessibilityLiveRegion="polite">
            {info}
          </Text>
        ) : null}
        {props.notice}
      </>
    );
  }

  function submitButton(label: Key, onPress: () => void) {
    return (
      <>
        <View style={styles.gap} />
        <Button
          label={t(label)}
          onPress={onPress}
          loading={working === "submit"}
          disabled={disabled}
          size="hero"
          fullWidth
        />
      </>
    );
  }

  function emailField(onSubmit: () => void, nextIsPassword: boolean) {
    return (
      <FormField
        ref={emailRef}
        onFocus={onFocus(emailRef)}
        onBlur={onBlur(emailRef)}
        label={t("auth.email.email")}
        value={email}
        onChangeText={(s) => {
          setEmail(s);
          clearError("email");
        }}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="email-address"
        autoComplete="email"
        textContentType="emailAddress"
        editable={!disabled}
        returnKeyType={nextIsPassword ? "next" : "go"}
        onSubmitEditing={nextIsPassword ? () => newPasswordRef.current?.focus() : onSubmit}
        submitBehavior={nextIsPassword ? "submit" : undefined}
        style={LTR_INPUT}
        error={errors.email ?? null}
      />
    );
  }

  // Directly above a NEW password: the one thing a Gmail user must not do is
  // type their Google password here.
  function newPasswordHelper(text: Key) {
    return (
      <View style={[styles.helperRow, rowDir(isRTL)]}>
        <Ionicons name="key-outline" size={16} color={colors.textEmphasis} />
        <Text style={[styles.helper, textDir(isRTL)]}>{t(text)}</Text>
      </View>
    );
  }

  // ---- steps ----

  if (step === "signin") {
    return (
      <>
        {header("auth.email.signIn.title", t("auth.email.signIn.subtitle"))}
        <FormField
          ref={identifierRef}
          onFocus={onFocus(identifierRef)}
          onBlur={onBlur(identifierRef)}
          label={t("auth.email.identifier")}
          value={identifier}
          onChangeText={(s) => {
            setIdentifier(s);
            clearError("identifier");
          }}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="email-address"
          autoComplete="username"
          textContentType="username"
          editable={!disabled}
          returnKeyType="next"
          onSubmitEditing={() => passwordRef.current?.focus()}
          submitBehavior="submit"
          style={LTR_INPUT}
          error={errors.identifier ?? null}
        />

        <PasswordField
          ref={passwordRef}
          onFocus={onFocus(passwordRef)}
          onBlur={onBlur(passwordRef)}
          label={t("auth.email.password")}
          value={password}
          onChangeText={(s) => {
            setPassword(s);
            clearError("password");
          }}
          autoComplete="current-password"
          textContentType="password"
          editable={!disabled}
          returnKeyType="go"
          onSubmitEditing={submitSignIn}
          error={errors.password ?? null}
        />
        {messages()}
        {submitButton("auth.email.signIn.submit", submitSignIn)}
        {link(t("auth.email.forgot"), openForgot)}
        {link(t("auth.email.toSignUp"), () => switchTo("signup"))}
      </>
    );
  }

  if (step === "signup") {
    return (
      <>
        {header("auth.email.signUp.title", t("auth.email.signUp.subtitle"))}
        {/* Above the fields, where it is seen before anything is typed: a
            returning user should never start an account they already have. */}
        {link(t("auth.email.toSignIn"), () => switchTo("signin"))}
        {emailField(submitSignUp, true)}
        {gmailShortcut(email)}
        {newPasswordHelper("auth.email.newPassword.helper")}
        {newPasswordField("auth.email.newPassword", submitSignUp)}
        {messages()}
        {submitButton("auth.email.sendCode", submitSignUp)}
      </>
    );
  }

  if (step === "code") {
    return (
      <>
        {header("auth.email.code.title", t("auth.email.code.sent", { email: ltrIsolate(email) }))}
        {/* A returning user who typed into sign-up gets a "you already have an
            account" email, not a code: the way in is right here. */}
        {link(t("auth.email.toSignIn"), signInInstead)}
        {codeField(submitCode, askPassword)}
        {askPassword ? (
          <>
            {newPasswordHelper("auth.email.code.passwordAgain")}
            {newPasswordField("auth.email.newPassword", submitCode)}
          </>
        ) : null}
        {messages()}
        {submitButton("auth.email.code.submit", submitCode)}
        {resendControls()}
      </>
    );
  }

  if (step === "forgot") {
    return (
      <>
        {header("auth.email.forgot.title", t("auth.email.forgot.subtitle"))}
        {emailField(submitForgot, false)}
        {messages()}
        {submitButton("auth.email.sendCode", submitForgot)}
        {link(t("auth.email.backToSignIn"), () => backTo("signin"))}
      </>
    );
  }

  return (
    <>
      {header("auth.email.reset.title", t("auth.email.reset.sent", { email: ltrIsolate(email) }))}
      {codeField(submitReset, true)}
      {newPasswordField("auth.email.reset.newPassword", submitReset)}
      {messages()}
      {submitButton("auth.email.reset.submit", submitReset)}
      {resendControls()}
    </>
  );
}

const styles = StyleSheet.create({
  // AuthScreen's own title and subtitle, so the flow reads as the same screen.
  title: {
    ...typography.heading,
    fontFamily: fonts.sansBold,
    color: colors.textEmphasis,
    letterSpacing: -0.4,
  },
  subtitle: {
    fontSize: 14,
    fontFamily: fonts.sansRegular,
    color: colors.textSubtle,
    marginTop: 8,
    lineHeight: sansLineHeight(14, 20),
  },
  spacer: { height: 24 },
  gap: { height: 4 },
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
  gmail: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    minHeight: TOUCH_MIN,
    marginTop: -14,
    marginBottom: 6,
  },
  gmailText: {
    flex: 1,
    fontSize: 13,
    fontFamily: fonts.sansSemi,
    color: colors.textEmphasis,
    textDecorationLine: "underline",
    lineHeight: sansLineHeight(13, 19),
  },
  // Six Latin digits: mono, spaced, a size up. Tracking is safe here, the
  // field is LTR digits in both languages.
  codeInput: { fontFamily: fonts.monoMedium, fontSize: 20, letterSpacing: 4 },
  hint: {
    fontSize: 13,
    fontFamily: fonts.sansRegular,
    color: colors.textSubtle,
    lineHeight: sansLineHeight(13, 19),
    marginTop: 16,
  },
  countdown: {
    fontSize: 14,
    fontFamily: fonts.sansMedium,
    color: colors.textMuted,
    textAlign: "center",
    lineHeight: sansLineHeight(14, 20),
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
    marginBottom: 4,
  },
  info: {
    fontSize: 13,
    fontFamily: fonts.sansMedium,
    color: colors.textEmphasis,
    lineHeight: sansLineHeight(13, 19),
    marginBottom: 4,
  },
});
