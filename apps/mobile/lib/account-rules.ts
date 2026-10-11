// Kaata accounts (docs/kaata-accounts.md): the cheap rules the screens mirror
// for instant feedback, and the words for every refusal the server can give.
//
// The SERVER is authoritative for all of it. These checks only save a round
// trip on the obvious cases (an empty field, a 5-character password, a code
// with letters in it); whatever they let through is still judged there, and
// the server's own refusal is what the user then reads (accountRefusal below).
// Never make a mirror stricter than the contract: a password the server would
// accept must never be refused here.
//
// Pure: no React, no network, no storage. selftest:email-auth runs it as is.

import type { EmailAuthError } from "./auth";
import { toAsciiDigits } from "./digits";
import { t } from "./i18n";

type Key = Parameters<typeof t>[0];

// ---- codes (§4) ----

export const CODE_LENGTH = 6;

/** What the code field keeps of what was typed or pasted: Persian and
 * Arabic-Indic digits folded to ASCII, everything else (spaces, dashes) dropped,
 * at most six digits. */
export function normalizeCodeInput(raw: string): string {
  return toAsciiDigits(raw)
    .replace(/[^0-9]/g, "")
    .slice(0, CODE_LENGTH);
}

// ---- email addresses (§4) ----

/** The address as the server reads it: Persian digits folded, outer spaces trimmed. */
export function normalizeEmailInput(raw: string): string {
  return toAsciiDigits(raw).trim();
}

function domainOf(address: string): string {
  const at = address.lastIndexOf("@");
  return at < 0 ? "" : address.slice(at + 1).toLowerCase();
}

/** A Gmail mailbox, whose owner can sign in with Google instead of a password. */
export function isGmailAddress(raw: string): boolean {
  const domain = domainOf(normalizeEmailInput(raw));
  return domain === "gmail.com" || domain === "googlemail.com";
}

/** Apple's "Hide My Email" relay: its owner cannot read mail sent to it here. */
export function isAppleRelayAddress(raw: string): boolean {
  return domainOf(normalizeEmailInput(raw)) === "privaterelay.appleid.com";
}

export type EmailProblem = "empty" | "format" | "relay";

// net/mail's dot-atom, which is what the server's ParseAddress(s).Address == s
// accepts without quotes: runs of atext joined by single dots.
const LOCAL_PART = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/;
// A domain with at least one dot and no IP literal.
const DOMAIN = /^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/;

/** The obvious problems with a typed address; null leaves the rest to the server. */
export function emailProblem(raw: string): EmailProblem | null {
  const address = normalizeEmailInput(raw);
  if (!address) return "empty";
  const at = address.lastIndexOf("@");
  if (at <= 0 || address.indexOf("@") !== at || address.length > 254) return "format";
  const local = address.slice(0, at);
  if (local.length > 64 || !LOCAL_PART.test(local) || !DOMAIN.test(address.slice(at + 1))) {
    return "format";
  }
  return isAppleRelayAddress(address) ? "relay" : null;
}

// ---- passwords (§3) ----

export const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 128;
/** A password of digits only is allowed from this length. */
export const DIGITS_ONLY_MIN = 12;
/** A run this long of one repeated or consecutive character is a pattern. */
const RUN = 6;

// ZWNJ, ZWJ and every bidi control: invisible, and typed differently by
// different keyboards.
const INVISIBLES = /[\u200c\u200d\u200e\u200f\u061c\u202a-\u202e\u2066-\u2069]/g;

/**
 * Canonicalization norm_version 1, the server's own: NFKC, Persian and
 * Arabic-Indic digits to ASCII, Arabic yeh and alef maksura to Persian yeh,
 * Arabic kaf to Persian kaf, joiners and bidi controls removed, so the same
 * visible password reads the same from any keyboard. Used here only to JUDGE a
 * password; what is sent is what was typed, and the server canonicalizes it.
 */
export function canonicalPassword(raw: string): string {
  let s = raw;
  try {
    s = s.normalize("NFKC");
  } catch {
    // An engine without normalization data: judge the typed form.
  }
  return toAsciiDigits(s)
    .replace(/[\u064a\u0649]/g, "\u06cc")
    .replace(/\u0643/g, "\u06a9")
    .replace(INVISIBLES, "");
}

function hasRun(password: string): boolean {
  const points = Array.from(password.toLowerCase(), (c) => c.codePointAt(0) ?? 0);
  let same = 1;
  let up = 1;
  let down = 1;
  for (let i = 1; i < points.length; i++) {
    const step = points[i] - points[i - 1];
    same = step === 0 ? same + 1 : 1;
    up = step === 1 ? up + 1 : 1;
    down = step === -1 ? down + 1 : 1;
    if (same >= RUN || up >= RUN || down >= RUN) return true;
  }
  return false;
}

/** Live state of the rules shown under a new password. */
export type PasswordRules = { length: boolean; notOnlyDigits: boolean; noRuns: boolean };

export function passwordRules(raw: string): PasswordRules {
  const password = canonicalPassword(raw);
  const length = Array.from(password).length;
  return {
    length: length >= PASSWORD_MIN && length <= PASSWORD_MAX,
    notOnlyDigits: length > 0 && (!/^[0-9]+$/.test(password) || length >= DIGITS_ONLY_MIN),
    noRuns: length > 0 && !hasRun(password),
  };
}

/** The structural reasons the server refuses a NEW password with (§3). */
export type PasswordProblem = "too_short" | "too_long" | "whitespace" | "pattern";

/** The first structural problem of a new password, or null. The server checks
 * the rest itself: common passwords and personal details. */
export function newPasswordProblem(raw: string): PasswordProblem | null {
  const password = canonicalPassword(raw);
  const length = Array.from(password).length;
  if (length < PASSWORD_MIN) return "too_short";
  if (length > PASSWORD_MAX) return "too_long";
  if (password !== password.trim()) return "whitespace";
  const rules = passwordRules(raw);
  return rules.notOnlyDigits && rules.noRuns ? null : "pattern";
}

// ---- usernames (§6.10) ----

/** Never part of a username: they would let an account pass for Kaata itself. */
export const RESERVED_USERNAME_PARTS = [
  "kaata",
  "admin",
  "support",
  "help",
  "official",
  "verified",
  "staff",
  "team",
  "security",
  "moderator",
  "system",
  "root",
] as const;

/** The stored form: trimmed, lowercased, digits folded. */
export function normalizeUsernameInput(raw: string): string {
  return toAsciiDigits(raw).trim().toLowerCase();
}

export type UsernameProblem = "format" | "reserved";

export function usernameProblem(raw: string): UsernameProblem | null {
  const name = normalizeUsernameInput(raw);
  if (!/^[a-z][a-z0-9_.]{2,29}$/.test(name) || name.includes("..") || name.endsWith(".")) {
    return "format";
  }
  return RESERVED_USERNAME_PARTS.some((part) => name.includes(part)) ? "reserved" : null;
}

/** The sign-in identifier as sent: an email address or a username, trimmed and
 * digits folded (the server lowercases a username itself). A username typed as
 * a handle ("@ali_shop": exactly one "@", and first) loses the "@", as on the
 * server, so it is never mistaken for an email address here. */
export function normalizeIdentifierInput(raw: string): string {
  const id = toAsciiDigits(raw).trim();
  return id.startsWith("@") && id.indexOf("@", 1) === -1 ? id.slice(1).trim() : id;
}

// ---- account names (§6.11) ----

export const NAME_MIN = 2;
export const NAME_MAX = 60;

// Invisible characters the server strips before it counts: zero-width marks
// and bidi controls.
const NAME_INVISIBLES = /[\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff\u061c]/g;

/** A name as an email account keeps it: NFC, whitespace runs collapsed, trimmed. */
export function normalizeAccountName(raw: string): string {
  let s = raw;
  try {
    s = s.normalize("NFC");
  } catch {
    // An engine without normalization data: the typed form.
  }
  return s.replace(/\s+/g, " ").trim();
}

/** The server's rule for an account's name: 2 to 60 visible characters. */
export function accountNameProblem(raw: string): "invalid" | null {
  const visible = Array.from(normalizeAccountName(raw).replace(NAME_INVISIBLES, "")).length;
  return visible >= NAME_MIN && visible <= NAME_MAX ? null : "invalid";
}

/**
 * The phone's own name made fit for an AUTOMATIC send (nobody is there to read
 * a refusal): the server's whitespace rule, then at most 60 characters, cut at
 * the last word boundary within them (a hard cut when there is none). Null
 * when fewer than 2 characters remain: such a name is never sent.
 */
export function fitAccountName(raw: string): string | null {
  const name = normalizeAccountName(raw);
  const chars = Array.from(name);
  let fitted = name;
  if (chars.length > NAME_MAX) {
    const head = chars.slice(0, NAME_MAX).join("");
    // The 61st character a space: the first 60 end on a whole word.
    const space = chars[NAME_MAX] === " " ? head.length : head.lastIndexOf(" ");
    fitted = (space > 0 ? head.slice(0, space) : head).trim();
  }
  return accountNameProblem(fitted) ? null : fitted;
}

/**
 * Whether the account's name is ours to set (§6.11: only an account without a
 * Google or Apple identity; theirs is named by the provider, and the server
 * answers provider_name). Decided from the ACCOUNT's providers (GET
 * /v1/account/me): an email session may well be a Google account that added a
 * password. Only while the providers are unknown does the session decide.
 */
export function accountNameIsOurs(
  providers: readonly string[] | null,
  sessionKind: "provider" | "email" | null,
): boolean {
  if (providers) return !providers.includes("google") && !providers.includes("apple");
  return sessionKind === "email";
}

// ---- waits ----

/** "42 seconds", "5 minutes", "2 hours", in the app language. */
export function waitText(seconds: number): string {
  const s = Math.max(1, Math.ceil(seconds));
  if (s < 60) return t("auth.wait.seconds", { n: s });
  const minutes = Math.ceil(s / 60);
  if (minutes < 60) {
    return minutes === 1 ? t("auth.wait.minute") : t("auth.wait.minutes", { n: minutes });
  }
  const hours = Math.ceil(minutes / 60);
  return hours === 1 ? t("auth.wait.hour") : t("auth.wait.hours", { n: hours });
}

/** A resend countdown, "0:42". Latin digits, like every number in the app. */
export function countdownText(seconds: number): string {
  const s = Math.max(0, Math.ceil(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

// ---- refusals (§6) ----

/** Where a refusal belongs on a form. */
export type RefusalField =
  | "email"
  | "newPassword"
  | "currentPassword"
  | "code"
  | "username"
  | "name"
  | "form";

export type Refusal = { reason: string; field: RefusalField; text: string };

const PASSWORD_REASONS = new Set([
  "too_short",
  "too_long",
  "whitespace",
  "common",
  "personal",
  "pattern",
]);

function isRefusal(err: unknown): err is EmailAuthError {
  return (
    err instanceof Error &&
    err.name === "EmailAuthError" &&
    typeof (err as Partial<EmailAuthError>).reason === "string"
  );
}

function withWait(err: EmailAuthError, plain: Key, timed: Key): string {
  const wait = err.extra?.retryAfterS;
  return typeof wait === "number" && wait > 0 ? t(timed, { time: waitText(wait) }) : t(plain);
}

/**
 * The server's named refusal (an EmailAuthError) as the words a form shows and
 * the field they belong under; null for anything else (a timeout, an outage, a
 * retired install), which the caller words the way every sign-in failure is
 * worded. Covers every error_code of docs/kaata-accounts.md §6.
 */
export function accountRefusal(err: unknown): Refusal | null {
  if (!isRefusal(err)) return null;
  const reason = err.reason;
  const detail = err.extra?.reason ?? "";
  const at = (field: RefusalField, text: string): Refusal => ({ reason, field, text });
  switch (reason) {
    case "invalid_email":
      return at(
        "email",
        t(
          detail === "relay"
            ? "auth.error.email.relay"
            : detail === "disposable"
              ? "auth.error.email.disposable"
              : "auth.error.email.format",
        ),
      );
    case "email_required":
      return at("email", t("auth.error.email.required"));
    case "email_in_use":
      return at("email", t("auth.error.email.inUse"));
    case "email_fixed":
      return at("email", t("auth.error.emailFixed"));
    case "provider_session_required":
      return at("form", t("auth.error.providerSessionRequired"));
    case "weak_password":
      return at(
        "newPassword",
        t(
          PASSWORD_REASONS.has(detail)
            ? (`auth.error.password.${detail}` as Key)
            : "auth.error.password.weak",
        ),
      );
    case "invalid_code_format":
      return at("code", t("auth.email.codeRequired"));
    case "invalid_code":
      return at("code", t("auth.error.code.invalid"));
    case "account_exists":
      return at("form", t("auth.error.accountExists"));
    case "invalid_credentials":
      return at("form", t("auth.error.invalidCredentials"));
    case "wrong_password":
      return at("currentPassword", t("auth.error.wrongPassword"));
    case "no_password":
      return at("form", t("auth.error.noPassword"));
    case "password_exists":
      return at("form", t("auth.error.passwordExists"));
    case "invalid_username":
      return at(
        "username",
        t(detail === "reserved" ? "auth.error.username.reserved" : "auth.error.username.format"),
      );
    case "username_taken":
      return at("username", t("auth.error.username.taken"));
    case "invalid_name":
      return at("name", t("auth.error.name.invalid"));
    case "provider_name":
      return at("name", t("auth.error.name.provider"));
    case "too_many_attempts":
      return at(
        "form",
        withWait(err, "auth.error.tooManyAttempts", "auth.error.tooManyAttempts.wait"),
      );
    case "too_many_requests":
      return at("form", withWait(err, "auth.error.tooManyEmails", "auth.error.tooManyEmails.wait"));
    case "rate_limited":
      return at("form", withWait(err, "auth.error.rateLimited", "auth.error.rateLimited.wait"));
    case "email_unavailable":
      return at("form", t("auth.error.emailUnavailable"));
    case "busy":
      return at("form", t("auth.error.busy"));
    case "account_disabled":
      return at("form", t("auth.error.accountDisabled"));
    case "account_deletion_expired":
      return at("form", t("auth.error.accountDeletionExpired"));
    case "session_expired":
      return at("form", t("auth.error.sessionExpired"));
    default:
      return null;
  }
}

/**
 * The words for any failure on a signed-in account screen: the refusal's own
 * words when the server named one, "couldn't reach Kaata" for a timeout or a
 * dropped connection, else a short retry line with the failure's code
 * (e.g. "server 500"), which is what support asks for.
 */
export function accountFailureText(err: unknown): string {
  const refusal = accountRefusal(err);
  if (refusal) return refusal.text;
  const failure = err as { stage?: unknown; code?: unknown } | null;
  if (failure?.stage === "timeout" || failure?.stage === "network") {
    return t("account.signin.network");
  }
  return typeof failure?.stage === "string" && typeof failure.code === "string"
    ? `${t("account.signin.error")} (${failure.code})`
    : t("account.signin.error");
}
