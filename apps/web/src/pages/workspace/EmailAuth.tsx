import { useEffect, useRef, useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { useI18n } from "../../lib/i18n";
import {
  cancelPendingWebSignIn,
  signInWithEmail,
  startWebEmailSignup,
  verifyWebEmailSignup,
  startWebEmailReset,
  verifyWebEmailReset,
  WebApiError,
  type WebSession,
} from "../../lib/web-auth";
import { WEB_ROUTES } from "../../lib/web-routes";
import {
  newWebPasswordProblem,
  normalizeWebEmailAddress as emailAddress,
  normalizeWebEmailCode as codeDigits,
  normalizeWebEmailIdentifier,
} from "../../lib/web-email-rules";
import { emailAuthCopy } from "./email-auth-copy";

type Step = "signin" | "signup" | "code" | "forgot" | "reset";
type Pending = { purpose: "signup" | "reset"; email: string; sentAt: number; resendAt: number };
const PENDING_KEY = "kaata_web_email_pending_v1";
const CODE_LIFETIME = 15 * 60_000;

function readPending(): Pending | null {
  try {
    const value: Pending = JSON.parse(sessionStorage.getItem(PENDING_KEY) ?? "null");
    if (
      value &&
      ["signup", "reset"].includes(value.purpose) &&
      typeof value.email === "string" &&
      value.email.length <= 254 &&
      Number.isFinite(value.sentAt) &&
      Number.isFinite(value.resendAt) &&
      value.sentAt <= Date.now() &&
      value.sentAt + CODE_LIFETIME > Date.now()
    )
      return value;
    sessionStorage.removeItem(PENDING_KEY);
  } catch {
    /* The in-memory form also works when tab storage is disabled. */
  }
  return null;
}

function forgetPending() {
  try {
    sessionStorage.removeItem(PENDING_KEY);
  } catch {
    /* No saved step. */
  }
}

export function EmailAuth({
  onSignedIn,
  onBusyChange,
}: {
  onSignedIn: (session: WebSession) => void;
  onBusyChange: (busy: boolean) => void;
}) {
  const { lang } = useI18n();
  const c = emailAuthCopy[lang];
  const navigate = useNavigate();
  const [initial] = useState(readPending);
  const [history, setHistory] = useState<Step[]>(
    initial?.purpose === "signup"
      ? ["signup", "code"]
      : initial?.purpose === "reset"
        ? ["signin", "forgot", "reset"]
        : ["signin"],
  );
  const step = history[history.length - 1];
  const [identifier, setIdentifier] = useState("");
  const [email, setEmail] = useState(initial?.email ?? "");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [needsPassword, setNeedsPassword] = useState(initial?.purpose === "signup");
  const [visiblePassword, setVisiblePassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");
  const [resendAt, setResendAt] = useState(initial?.resendAt ?? 0);
  const [retryAt, setRetryAt] = useState(0);
  const [now, setNow] = useState(Date.now());
  const working = useRef(false);
  const active = useRef(true);
  const afterTimeout = useRef(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const latest = useRef({ onSignedIn, onBusyChange });
  latest.current = { onSignedIn, onBusyChange };
  const countdown = Math.max(0, Math.ceil((Math.max(resendAt, retryAt) - now) / 1000));
  const blocked = busy || now < retryAt;

  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  useEffect(() => {
    heading.current?.focus({ preventScroll: true });
  }, [step]);
  useEffect(() => {
    const until = Math.max(resendAt, retryAt);
    if (until <= Date.now()) return;
    const timer = setInterval(() => {
      const at = Date.now();
      setNow(at);
      if (at >= until) clearInterval(timer);
    }, 1000);
    return () => clearInterval(timer);
  }, [resendAt, retryAt]);

  function clearMessage() {
    setError("");
    setInfo("");
    afterTimeout.current = false;
  }
  function go(next: Step) {
    if (working.current) return;
    clearMessage();
    setCode("");
    setVisiblePassword(false);
    if (next === "signup" || next === "forgot") {
      const address = emailAddress(identifier);
      if (address.includes("@") && !address.startsWith("@")) setEmail(address);
      setPassword("");
    }
    setHistory((value) => [...value, next]);
  }
  function back() {
    if (working.current) return;
    clearMessage();
    forgetPending();
    setCode("");
    setPassword("");
    setVisiblePassword(false);
    if (history.length > 1) setHistory((value) => value.slice(0, -1));
    else navigate(WEB_ROUTES.signin);
  }
  function providers() {
    if (working.current) return;
    forgetPending();
    cancelPendingWebSignIn();
    navigate(WEB_ROUTES.signin);
  }
  function signInInstead() {
    if (working.current) return;
    forgetPending();
    clearMessage();
    setIdentifier(email);
    setPassword("");
    setCode("");
    setVisiblePassword(false);
    setHistory(["signin"]);
  }
  function message(reason: unknown): string {
    if (!(reason instanceof WebApiError)) return c.unavailable;
    switch (reason.code) {
      case "invalid_credentials":
        return c.invalidCredentials;
      case "invalid_email":
        return reason.reason === "relay" ? c.relayEmail : c.invalidEmail;
      case "invalid_code":
      case "invalid_code_format":
        return c.invalidCode;
      case "weak_password":
        return c.weakPassword;
      case "account_exists":
        return c.accountExists;
      case "email_unavailable":
        return c.emailUnavailable;
      case "network":
        return c.network;
      case "account_disabled":
      case "account_deletion_expired":
        return c.accountDisabled;
      default:
        return reason.status === 429 ? c.rateLimit : c.unavailable;
    }
  }
  async function run(task: () => Promise<void>) {
    if (working.current || Date.now() < retryAt) return;
    working.current = true;
    setBusy(true);
    latest.current.onBusyChange(true);
    setError("");
    setInfo("");
    try {
      await task();
    } catch (reason) {
      if (!active.current) return;
      afterTimeout.current ||= reason instanceof WebApiError && reason.code === "network";
      if (reason instanceof WebApiError && reason.code === "weak_password" && step === "code")
        setNeedsPassword(true);
      if (reason instanceof WebApiError && reason.status === 429) {
        setNow(Date.now());
        setRetryAt(Date.now() + (reason.retryAfterSeconds ?? 60) * 1000);
      }
      setError(message(reason));
    } finally {
      working.current = false;
      if (active.current) {
        setBusy(false);
        latest.current.onBusyChange(false);
      }
    }
  }
  async function send(purpose: "signup" | "reset", resend = false) {
    const address = emailAddress(email);
    const sent =
      purpose === "signup"
        ? await startWebEmailSignup(address, lang)
        : await startWebEmailReset(address, lang);
    if (!active.current) return;
    const pending: Pending = {
      purpose,
      email: address,
      sentAt: Date.now(),
      resendAt: Date.now() + sent.resendAfterSeconds * 1000,
    };
    // Only the address and step timing can survive reload. Secrets stay in memory.
    try {
      sessionStorage.setItem(PENDING_KEY, JSON.stringify(pending));
    } catch {
      /* The current step still works. */
    }
    setEmail(address);
    setCode("");
    setResendAt(pending.resendAt);
    setNow(Date.now());
    afterTimeout.current = false;
    if (resend) setInfo(c.codeResent);
    else {
      setNeedsPassword(false);
      if (purpose === "reset") setPassword("");
      setHistory((value) => [...value, purpose === "signup" ? "code" : "reset"]);
    }
  }
  function complete(session: WebSession) {
    forgetPending();
    setPassword("");
    setCode("");
    if (active.current) latest.current.onSignedIn(session);
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (working.current || Date.now() < retryAt) return;
    if (step === "signin") {
      if (!identifier.trim() || !password.trim()) {
        setError(c.required);
        return;
      }
      await run(async () =>
        complete(await signInWithEmail(normalizeWebEmailIdentifier(identifier), password)),
      );
      return;
    }
    if (
      (step === "signup" || step === "forgot") &&
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailAddress(email))
    ) {
      setError(c.invalidEmail);
      return;
    }
    if (
      (step === "signup" || step === "reset" || (step === "code" && needsPassword)) &&
      !password.trim()
    ) {
      setError(c.required);
      return;
    }
    if (
      (step === "signup" || step === "reset" || (step === "code" && needsPassword)) &&
      newWebPasswordProblem(password)
    ) {
      setError(c.weakPassword);
      return;
    }
    if ((step === "code" || step === "reset") && codeDigits(code).length !== 6) {
      setError(c.codeRequired);
      return;
    }
    await run(async () => {
      if (step === "signup") await send("signup");
      else if (step === "forgot") await send("reset");
      else if (step === "code")
        complete(
          await verifyWebEmailSignup(
            { email, code: codeDigits(code), password, lang },
            { afterTimeout: afterTimeout.current },
          ),
        );
      else
        complete(
          await verifyWebEmailReset(
            { email, code: codeDigits(code), newPassword: password, lang },
            { afterTimeout: afterTimeout.current },
          ),
        );
    });
  }

  const codeStep = step === "code" || step === "reset";
  const passwordStep =
    step === "signin" ||
    step === "signup" ||
    step === "reset" ||
    (step === "code" && needsPassword);
  const title =
    step === "signin"
      ? c.signInTitle
      : step === "signup"
        ? c.signupTitle
        : step === "code"
          ? c.codeTitle
          : step === "forgot"
            ? c.forgotTitle
            : c.resetTitle;
  const body =
    step === "signin"
      ? c.signInBody
      : step === "signup"
        ? c.signupBody
        : step === "code"
          ? c.codeBody
          : step === "forgot"
            ? c.forgotBody
            : c.resetBody;
  return (
    <div className="web-email-auth">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="web-email-back"
        onClick={back}
        disabled={busy}
      >
        <span aria-hidden="true">{lang === "en" ? "←" : "→"}</span>
        {c.back}
      </Button>
      <h1 id="web-auth-heading" ref={heading} tabIndex={-1}>
        {title}
      </h1>
      <p className="web-auth-subtitle">
        {body}
        {codeStep && (
          <>
            {" "}
            <bdi dir="ltr">{email}</bdi>.
          </>
        )}
      </p>
      {step === "code" && <p className="web-email-hint">{c.signupCodeHelp}</p>}
      {step === "reset" && <p className="web-email-hint">{c.resetSessions}</p>}
      <form onSubmit={submit} className="web-email-form" noValidate>
        <fieldset disabled={busy}>
          {step === "signin" && (
            <label htmlFor="web-email-identifier">
              {c.identifier}
              <Input
                id="web-email-identifier"
                autoComplete="username"
                autoCapitalize="none"
                spellCheck={false}
                dir="ltr"
                value={identifier}
                onChange={(event) => {
                  setIdentifier(event.target.value);
                  clearMessage();
                }}
                required
              />
            </label>
          )}
          {(step === "signup" || step === "forgot") && (
            <label htmlFor="web-email-address">
              {c.email}
              <Input
                id="web-email-address"
                type="text"
                inputMode="email"
                autoComplete="email"
                autoCapitalize="none"
                spellCheck={false}
                dir="ltr"
                value={email}
                onChange={(event) => {
                  setEmail(event.target.value);
                  clearMessage();
                }}
                required
              />
            </label>
          )}
          {codeStep && (
            <div className="web-email-field">
              <label htmlFor="web-email-code">{c.code}</label>
              <Input
                id="web-email-code"
                className="web-email-code"
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                dir="ltr"
                value={code}
                onChange={(event) => {
                  setCode(codeDigits(event.target.value));
                  clearMessage();
                }}
                aria-describedby="web-email-code-hint"
                required
              />
              <small id="web-email-code-hint">{c.codeHint}</small>
            </div>
          )}
          {passwordStep && (
            <div className="web-email-field">
              <label htmlFor="web-email-password">
                {step === "signin" ? c.password : c.newPassword}
              </label>
              <div className="web-email-password" dir="ltr">
                <Input
                  id="web-email-password"
                  type={visiblePassword ? "text" : "password"}
                  autoComplete={step === "signin" ? "current-password" : "new-password"}
                  dir="ltr"
                  value={password}
                  onChange={(event) => {
                    setPassword(event.target.value);
                    clearMessage();
                  }}
                  aria-describedby={step === "signin" ? undefined : "web-email-password-hint"}
                  required
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => setVisiblePassword((value) => !value)}
                  aria-pressed={visiblePassword}
                >
                  {visiblePassword ? c.hidePassword : c.showPassword}
                </Button>
              </div>
              {step !== "signin" && (
                <small id="web-email-password-hint">
                  {step === "code" ? c.passwordAgain : c.passwordHint}
                </small>
              )}
            </div>
          )}
          {error && (
            <p className="web-auth-error" role="alert">
              {error}
            </p>
          )}
          {info && (
            <p className="web-email-info" role="status">
              {info}
            </p>
          )}
          {now < retryAt && (
            <p className="web-email-hint" role="status">
              {c.tryAgainIn.replace("{seconds}", String(countdown))}
            </p>
          )}
          <Button
            type="submit"
            variant="brand"
            className="h-11 w-full rounded-full"
            disabled={blocked}
          >
            {busy
              ? c.wait
              : step === "signin"
                ? c.signIn
                : step === "signup" || step === "forgot"
                  ? c.sendCode
                  : step === "code"
                    ? c.verifyAndSignIn
                    : c.resetAndSignIn}
          </Button>
        </fieldset>
      </form>
      <div className="web-email-actions">
        {step === "signin" && (
          <>
            <Button type="button" variant="link" disabled={busy} onClick={() => go("forgot")}>
              {c.forgotPassword}
            </Button>
            <Button type="button" variant="link" disabled={busy} onClick={() => go("signup")}>
              {c.noAccount}
            </Button>
          </>
        )}
        {step === "signup" && (
          <Button type="button" variant="link" disabled={busy} onClick={signInInstead}>
            {c.haveAccount}
          </Button>
        )}
        {codeStep && (
          <>
            <Button
              type="button"
              variant="link"
              disabled={blocked || countdown > 0}
              onClick={() => void run(() => send(step === "code" ? "signup" : "reset", true))}
            >
              {countdown > 0 ? c.resendIn.replace("{seconds}", String(countdown)) : c.resend}
            </Button>
            <Button type="button" variant="link" disabled={busy} onClick={back}>
              {c.changeEmail}
            </Button>
            {step === "code" && (
              <Button type="button" variant="link" disabled={busy} onClick={signInInstead}>
                {c.haveAccount}
              </Button>
            )}
          </>
        )}
        <Button
          type="button"
          variant="ghost"
          disabled={busy}
          className="w-full rounded-full"
          onClick={providers}
        >
          {c.providers}
        </Button>
      </div>
    </div>
  );
}
