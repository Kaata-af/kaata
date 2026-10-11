import Constants from "expo-constants";
import * as SecureStore from "expo-secure-store";
import { Platform } from "react-native";
import { GOOGLE_IOS_CLIENT_ID, GOOGLE_WEB_CLIENT_ID } from "../constants/env";
import { getBackendUrl } from "./api";
import {
  getAccountIdSync,
  getActiveVaultId,
  getAppMetaInTx,
  getDb,
  refreshAccountIdCache,
  setAccountIdCache,
  setAppMetaInTx,
  setInstallIdCache,
  setLocalSelfUserIdCache,
} from "./db-tx";
import { initDb, resetAllLocalData } from "./db";
import { resolveAccountIdCandidates } from "./effective-account";
import { appendAccountBound } from "./event-log";
import { clearInstallRetired, ensureInstallId, markInstallRetired } from "./install-id";
import { normalizePhone } from "./phone";
import type { DeletionCleanupBaseline } from "./account-deletion-backup";

// `import type` is erased at compile time — it does NOT execute a runtime
// `require()` of the module — so it's safe to pull types from google-signin
// even though the native module is missing in Expo Go.
import type { GoogleSignin as GoogleSigninType } from "@react-native-google-signin/google-signin";

// Expo Go does NOT include @react-native-google-signin/google-signin in its
// shipped native modules. Even the `import` statement of that package
// triggers TurboModuleRegistry.getEnforcing('RNGoogleSignin') at top level,
// which throws and breaks every screen that transitively imports this file.
//
// We detect the Expo Go runtime first, then LAZY-load the lib via require()
// only when we're not in Expo Go. That way the file is safe to import
// anywhere and Settings / onboarding-mode can render in Expo Go even though
// the sign-in buttons don't actually work there.
const IS_EXPO_GO = Constants.executionEnvironment === "storeClient";

// google-signin's status codes for the "user cancelled" case. Hardcoded so
// we don't have to load the module just to check an error code.
const SIGN_IN_CANCELLED_CODE = "SIGN_IN_CANCELLED";

type GoogleSigninModule = {
  GoogleSignin: typeof GoogleSigninType;
  isErrorWithCode: (err: unknown) => err is { code: string };
  statusCodes: { SIGN_IN_CANCELLED: string };
};

// Lazy-loaded once. null until the first non-Expo-Go consumer asks for it.
let _gsi: GoogleSigninModule | null = null;
function loadGoogleSignin(): GoogleSigninModule | null {
  if (IS_EXPO_GO) return null;
  if (_gsi) return _gsi;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  _gsi = require("@react-native-google-signin/google-signin") as GoogleSigninModule;
  return _gsi;
}

// Session lives in SecureStore (encrypted-at-rest keystore on Android,
// Keychain on iOS). NEVER store the session JWT in AsyncStorage / SQLite /
// app_meta — those are unencrypted on disk. SecureStore is the only place
// the JWT belongs.
const SESSION_KEY = "kaata.session.jwt";
const USER_KEY = "kaata.session.user";
const DELETION_CONFIRMATION_KEY = "kaata.account.deletion-confirmation";
const DELETION_ATTEMPT_KEY = "kaata.account.deletion-attempt";
const DELETION_BASELINE_KEY = "kaata.account.deletion-baseline";
let sessionBindingVersion = 0;
let sessionMutationTail: Promise<void> = Promise.resolve();

// Installing a new account and clearing a deleted account must not interleave
// across native SecureStore/SQLite awaits. A sign-in can finish after navigation.
async function mutateLocalSession<T>(work: () => Promise<T>): Promise<T> {
  const previous = sessionMutationTail;
  let release!: () => void;
  sessionMutationTail = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    return await work();
  } finally {
    release();
  }
}

/** Opaque to callers: capture before network work; never log or persist it. */
export type SessionSnapshot = Readonly<{
  bindingVersion: number;
  jwt: string | null;
  accountId: string | null;
}>;

export class SessionChangedError extends Error {
  constructor() {
    super("session_changed");
    this.name = "SessionChangedError";
  }
}

export function captureCurrentSession(): Promise<SessionSnapshot> {
  return mutateLocalSession(async () => ({
    bindingVersion: sessionBindingVersion,
    jwt: await SecureStore.getItemAsync(SESSION_KEY),
    accountId: getAccountIdSync(),
  }));
}

/** Serialize only short local cache work with sign-in/sign-out/deletion.
 * Never put a request or another session helper inside this callback. */
export function applyForCurrentSession<T>(
  snapshot: SessionSnapshot,
  work: () => Promise<T>,
): Promise<T> {
  return mutateLocalSession(async () => {
    const jwt = await SecureStore.getItemAsync(SESSION_KEY);
    if (
      !snapshot.jwt ||
      snapshot.bindingVersion !== sessionBindingVersion ||
      snapshot.jwt !== jwt ||
      snapshot.accountId !== getAccountIdSync()
    ) {
      throw new SessionChangedError();
    }
    return work();
  });
}

// Local-only operations need the same binding guard before any account exists.
// Never use this helper as authorization for a server request.
export function applyForUnchangedLocalSession<T>(
  snapshot: SessionSnapshot,
  work: () => Promise<T>,
): Promise<T> {
  return mutateLocalSession(async () => {
    const jwt = await SecureStore.getItemAsync(SESSION_KEY);
    if (
      snapshot.bindingVersion !== sessionBindingVersion ||
      snapshot.jwt !== jwt ||
      snapshot.accountId !== getAccountIdSync()
    )
      throw new SessionChangedError();
    return work();
  });
}

export type SessionUser = {
  email?: string;
  name?: string;
  picture_url?: string;
  // Account-level phone (E.164) the shopkeeper saved on a prior device, echoed
  // back by /v1/auth/google so a reinstall can prefill it. Absent when none.
  phone?: string;
  // Kaata accounts (docs/kaata-accounts.md §6): the optional private sign-in
  // handle, and whether the account has a Kaata password. Every provider's
  // sign-in reply carries has_password; username is omitted when none.
  username?: string;
  has_password?: boolean;
};

// Phase 4.1: thrown when the user dismisses the "different account on this
// phone?" dialog, and when they back out of Google's chooser (see
// signInForIdToken). isCancellation() is true for it, so callers swallow it
// like any other cancellation: the user chose not to sign in, and the existing
// session stays untouched.
export class SignInCancelledByUserError extends Error {
  constructor() {
    super("sign_in_cancelled_by_user");
    this.name = "SignInCancelledByUserError";
  }
}

/**
 * A sign-in failure that knows WHY it failed.
 *
 * The screens used to collapse every failure into "Sign-in didn't work. Try
 * again." with the real cause going to a console.warn no user or operator can
 * read — so a shopkeeper standing in front of you with a failing phone gave
 * you nothing to act on. `stage` says which leg broke and `detail` carries the
 * HTTP status / native code, both of which the UI renders as a short suffix
 * the user can read aloud over WhatsApp.
 */
export type SignInStage =
  | "play_services" // Google Play Services missing or too old (Android)
  | "no_id_token" // Google returned no credential
  | "timeout" // our backend didn't answer in time
  | "network" // couldn't reach our backend at all
  | "server" // backend answered with an error
  // The Google/Apple token or the emailed code went stale while the user read
  // the "different account?" question: sign in again (refused before any wipe).
  | "token_expired"
  | "unknown";

export class SignInFailedError extends Error {
  readonly stage: SignInStage;
  readonly detail: string;
  constructor(stage: SignInStage, message: string, detail = "") {
    super(message);
    this.name = "SignInFailedError";
    this.stage = stage;
    this.detail = detail;
  }
  /** Short, readable tag for the UI + crash report, e.g. "server 503". */
  get code(): string {
    return this.detail ? `${this.stage} ${this.detail}` : this.stage;
  }
}

/**
 * HTTP 410 from /v1/auth/google, /v1/auth/apple or /v1/check-in: this phone's
 * install_id was RETIRED. Deleting an account retires every installation whose
 * LAST signed-in account it was (a server sign-out keeps the link; a later
 * sign-in to another account moves it), and from then on the server refuses
 * that id for check-in and for sign-in to ANY account. 410
 * means nothing else on those endpoints. Retrying can never work, so the
 * screens explain it and offer resetRetiredInstall instead of "try again".
 *
 * It stays a SignInFailedError ("server 410") so code that only knows the base
 * class still treats it as a server answer; check for this subclass first. It
 * is never permission to erase anything: only the user's explicit confirmation
 * of the reset is.
 */
export class InstallRetiredError extends SignInFailedError {
  constructor(message = "This installation belongs to a deleted account.") {
    super("server", message, "410");
    this.name = "InstallRetiredError";
  }
}

// Result of the "different account on this phone?" prompt. Returned by the
// UI callback every sign-in function takes.
//   - "keep"   — sign in anyway and rebind, keeping the local ledger data
//   - "wipe"   — erase the local ledger first, then sign in on a clean phone
//   - "cancel" — abort the sign-in entirely, stay on the old account
export type DifferentAccountChoice = "keep" | "wipe" | "cancel";

export type DifferentAccountPromptArgs = {
  cachedEmail: string | null; // last-known display email for the old binding
  newEmail: string | null; // the account being signed in to, as the server names it
};

export type DifferentAccountPrompt = (
  args: DifferentAccountPromptArgs,
) => Promise<DifferentAccountChoice>;

// 30 days in ms. Outside this window we silently swap the binding without
// prompting — the previous binding is plausibly abandoned.
const DIFFERENT_ACCOUNT_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

// The old binding's display email for the prompt. Written at every sign-in and
// deliberately NOT cleared by sign-out: the prompt matters most after someone
// signed out and a different person signs in on the same phone.
const ACCOUNT_DISPLAY_EMAIL_KEY = "account_display_email";

// True when this phone holds any kaata or person: the local ledger a sign-in to
// another account would rebind. A fresh install has neither until onboarding's
// kaata step (or a restore) creates them. A read that fails counts as "holds
// data", so the prompt errs on the side of asking.
async function hasLocalLedgerData(): Promise<boolean> {
  try {
    const db = await getDb();
    const row = await db.getFirstAsync<{ found: number }>(
      `SELECT (EXISTS (SELECT 1 FROM vaults) OR EXISTS (SELECT 1 FROM users)) AS found`,
    );
    return !!row?.found;
  } catch {
    return true;
  }
}

// "Different account on this phone?" (docs/kaata-accounts.md §6, §7). The
// SERVER decides, for every provider, before it writes anything: a sign-in that
// names the phone's current binding in current_account_id is refused with 409
// different_account when it resolves to another account, unless allow_switch is
// set. This is the binding that sign-in names: app_meta account_id, but only
// while the phone holds local data and the binding was active within the last
// 30 days (the check-in heartbeat keeps account_last_seen_at fresh). Null means
// there is nothing to protect, so the sign-in proceeds without asking.
//
// It replaced a client-side comparison of the provider's `sub` claims, which
// could not see an email account (no third-party token) and could not tell a
// Google and an Apple identity of the SAME account apart.
async function bindingToProtect(): Promise<string | null> {
  const db = await getDb();
  const accountId = await getAppMetaInTx(db, "account_id");
  if (!accountId) return null;
  const lastSeen = Number(await getAppMetaInTx(db, "account_last_seen_at"));
  if (!Number.isFinite(lastSeen) || Date.now() - lastSeen >= DIFFERENT_ACCOUNT_WINDOW_MS) {
    return null;
  }
  return (await hasLocalLedgerData()) ? accountId : null;
}

// Best-effort, for recognition only: "—" in the dialog is fine.
async function bindingDisplayEmail(): Promise<string | null> {
  try {
    const stored = await getAppMetaInTx(await getDb(), ACCOUNT_DISPLAY_EMAIL_KEY);
    if (stored) return stored;
  } catch {
    // fall back to the stored session user below
  }
  try {
    return (await getSessionUser())?.email ?? null;
  } catch {
    return null;
  }
}

// Where one sign-in stands on the different-account question. Carried into a
// follow-up request of the SAME sign-in (the email flows' password fallback) so
// the user is never asked twice.
type SwitchState = {
  // current_account_id to send, or null (nothing to protect, or wiped).
  protect: string | null;
  // The user chose "keep": the server may rebind.
  allowSwitch: boolean;
};

async function initialSwitchState(prompt?: DifferentAccountPrompt): Promise<SwitchState> {
  // Without a prompt there is nobody to ask, so nothing is protected: the same
  // outcome as before the server decided (no callback, no question).
  return { protect: prompt ? await bindingToProtect() : null, allowSwitch: false };
}

type Exchange = {
  res: Response;
  body: Record<string, unknown> | null;
  installId: string;
  // True when the request was sent twice (the first timed out or broke).
  retried: boolean;
  state: SwitchState;
};

// One sign-in request with the different-account loop around it, for every
// provider. `payload` is built per attempt because "start fresh" wipes the
// phone: the next attempt needs the fresh install id and a vault registration
// computed from the (now empty) ledger.
//   - 409 different_account → ask. "keep" resends with allow_switch; "wipe"
//     erases the local ledger (wipeLocalPhone) and resends without
//     current_account_id under the fresh install id; "cancel" runs
//     onCancelCleanup and throws SignInCancelledByUserError.
// Google resends its ID token and Apple its identity token: the server has
// written nothing, so both are still unused.
async function signInExchange(args: {
  url: string;
  payload: () => Promise<Record<string, unknown>> | Record<string, unknown>;
  onDifferentAccount?: DifferentAccountPrompt;
  onCancelCleanup?: () => Promise<void>;
  /**
   * Runs after a "keep" or "start fresh" answer, BEFORE anything acts on it
   * (the wipe, the resend). Throws when the credential the resend would carry
   * has gone stale while the user read the question (see requireLiveToken).
   */
  beforeSwitch?: (choice: "keep" | "wipe") => Promise<void> | void;
  state?: SwitchState;
}): Promise<Exchange> {
  const state = args.state ?? (await initialSwitchState(args.onDifferentAccount));
  for (;;) {
    const installId = await ensureInstallId();
    const { res, retried } = await postAuthTracked(args.url, {
      install_id: installId,
      ...(await args.payload()),
      ...(state.protect ? { current_account_id: state.protect } : {}),
      ...(state.allowSwitch ? { allow_switch: true } : {}),
    });
    const body = await readBody(res);
    if (
      res.status === 409 &&
      body?.error_code === "different_account" &&
      args.onDifferentAccount &&
      state.protect &&
      !state.allowSwitch
    ) {
      const newEmail = typeof body.email === "string" && body.email ? body.email : null;
      const choice = await args.onDifferentAccount({
        cachedEmail: await bindingDisplayEmail(),
        newEmail,
      });
      if (choice === "cancel") {
        if (args.onCancelCleanup) await args.onCancelCleanup();
        throw new SignInCancelledByUserError();
      }
      if (args.beforeSwitch) await args.beforeSwitch(choice);
      if (choice === "wipe") {
        // The local ledger goes BEFORE the new sign-in, so the new account
        // lands on a clean phone. The wipe drops app_meta too; the sign-in's
        // housekeeping repopulates it.
        await mutateLocalSession(() => wipeLocalPhone({ keepAppleName: true }));
        state.protect = null;
      } else {
        // "keep": postSignInHousekeeping overwrites account_id with the new
        // account, and appendAccountBound emits a fresh account_bound event so
        // the server re-attributes the existing events under the new binding.
        state.allowSwitch = true;
      }
      continue;
    }
    return { res, body, installId, retried, state };
  }
}

// The "different account?" question waits on the user, who may read it for
// minutes. A Google or Apple ID token lives about an hour, an emailed code 15
// minutes: one that went stale meanwhile would be refused on the resend, and
// after "start fresh" that refusal would come AFTER the phone was erased. So
// the answer is checked first, and a stale credential is a coded failure that
// leaves everything as it was (the user simply signs in again).
const MIN_TOKEN_LIFE_MS = 60_000;
const MAX_CODE_AGE_FOR_SWITCH_MS = 14 * 60_000;

function staleCredential(): SignInFailedError {
  return new SignInFailedError("token_expired", "Sign-in took too long. Please sign in again.");
}

// A provider token with less than a minute left. The phone's clock is trusted
// only for ELAPSED time: many phones in Afghanistan run hours off (a wrong time
// zone, a hand-set clock), so the token's own life (exp - iat, both the
// provider's clock) minus the time since it arrived (`receivedAt`, the phone's)
// is what remains. Only a token without `iat` falls back to exp vs the phone's
// "now". A token without a readable `exp` is left to the server: it has just
// accepted it for the 409.
function requireLiveToken(idToken: string, receivedAt: number): void {
  const claims = decodeIdTokenClaims(idToken);
  const exp = claims?.exp;
  if (typeof exp !== "number" || !Number.isFinite(exp)) return;
  const iat = claims?.iat;
  const remainingMs =
    typeof iat === "number" && Number.isFinite(iat)
      ? (exp - iat) * 1000 - Math.max(0, Date.now() - receivedAt)
      : exp * 1000 - Date.now();
  if (remainingMs < MIN_TOKEN_LIFE_MS) throw staleCredential();
}

// An emailed code past 14 minutes (its pending step's sent_at). Unknown age:
// left to the server, which refuses a dead code without spending anything.
async function requireFreshCode(purpose: "signup" | "reset"): Promise<void> {
  // The OLDEST code the user might be typing (first_sent_at; an older build
  // stored only sent_at).
  let sentAt: number | null = null;
  try {
    const raw = await getAppMetaInTx(await getDb(), EMAIL_FLOW_PENDING_KEY);
    const parsed = raw
      ? (JSON.parse(raw) as { purpose?: unknown; sent_at?: unknown; first_sent_at?: unknown })
      : null;
    if (parsed?.purpose === purpose) {
      if (typeof parsed.first_sent_at === "number") sentAt = parsed.first_sent_at;
      else if (typeof parsed.sent_at === "number") sentAt = parsed.sent_at;
    }
  } catch {
    sentAt = null;
  }
  if (sentAt !== null && Date.now() - sentAt > MAX_CODE_AGE_FOR_SWITCH_MS) throw staleCredential();
}

// One-time configuration. Called from _layout.tsx on app start. The
// webClientId here is what tells Google sign-in to mint an ID token whose
// `aud` claim matches our backend's GOOGLE_WEB_CLIENT_ID env var — the
// backend will reject any other audience.
//
// Note: the Android client ID we configured in Google Cloud Console is
// matched automatically by Google Play Services via the package name +
// SHA-1 signing cert; we don't pass it here. If sign-in fails with
// DEVELOPER_ERROR, that's almost always a mismatch between the SHA-1 of
// the APK currently installed and what's registered on the Android
// OAuth client in Google Cloud Console.
//
// In Expo Go this is a no-op — the native module isn't there.
export function configureGoogleSignIn(): void {
  // iOS needs an iOS-type OAuth client id; without one, configure rejects
  // with "failed to determine clientID" and crashes the caller (B1). So on
  // iOS we configure ONLY when GOOGLE_IOS_CLIENT_ID is baked in — otherwise
  // skip, and isGoogleSignInAvailable() below keeps the button hidden.
  if (Platform.OS === "ios" && !GOOGLE_IOS_CLIENT_ID) return;
  const lib = loadGoogleSignin();
  if (!lib) return;
  lib.GoogleSignin.configure({
    // The WEB client id stays the token audience on BOTH platforms — it's
    // what the backend's GOOGLE_WEB_CLIENT_ID verifies against.
    webClientId: GOOGLE_WEB_CLIENT_ID,
    // iOS additionally needs its own client id (paired with the reversed
    // iosUrlScheme in app.json's google-signin plugin config).
    ...(Platform.OS === "ios" ? { iosClientId: GOOGLE_IOS_CLIENT_ID } : null),
    // Force showing the picker every time so a user with multiple Google
    // accounts can switch. Without this, sign-in re-uses the cached
    // account silently — surprising when they want to swap.
    offlineAccess: false,
  });
}

// Whether Google sign-in can work in THIS build: always on Android (the
// Play-Services client resolves from package name + SHA-1), on iOS only when
// the iOS client id was baked in. UI surfaces gate the Google button on this
// so an unconfigured build degrades to Apple-only instead of crashing.
export function isGoogleSignInAvailable(): boolean {
  return Platform.OS !== "ios" || GOOGLE_IOS_CLIENT_ID !== "";
}

// One interactive Google sign-in attempt → its ID token (or null if the result
// carried none). The library wraps the payload under `data` on newer versions
// and inline on older ones, so we read defensively.
//
// Backing out is NOT an error in google-signin 16: signIn() RESOLVES with
// { type: "cancelled", data: null }. Read as "no token", that used to send the
// user straight back into the chooser (the one-retry below) and, on a second
// back-out, onto "Sign-in didn't work. (no_id_token)" plus a crash report.
// That is what Google's reviewer saw on build 49 after leaving Android's
// add-account screen. A cancel is the user's answer; stop here, silently.
async function signInForIdToken(lib: GoogleSigninModule): Promise<string | null> {
  const result = await lib.GoogleSignin.signIn();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  if ((result as any)?.type === "cancelled") throw new SignInCancelledByUserError();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const data: any = (result as any).data ?? result;
  const tok: unknown = data?.idToken;
  return typeof tok === "string" && tok.length > 0 ? tok : null;
}

// SignIn opens Google's native sign-in sheet, gets an ID token, posts it
// to /v1/auth/google, and stores the resulting session JWT + display user
// in SecureStore. Returns the user profile for immediate display.
//
// Throws on:
//   - Expo Go runtime (native module missing — caller should show a hint
//     toast and tell the user to use a dev client / production APK)
//   - user cancelled (code SIGN_IN_CANCELLED — caller should swallow)
//   - Google Play Services unavailable
//   - DEVELOPER_ERROR (SHA-1 / package mismatch)
//   - backend rejected the token (Error with the backend's message)
export async function signInWithGoogle(
  onDifferentAccount?: DifferentAccountPrompt,
): Promise<SessionUser> {
  const lib = loadGoogleSignin();
  if (!lib) {
    throw new Error(
      "Google sign-in needs a dev client or production APK — it can't run in Expo Go.",
    );
  }

  // Old Android: this rejects with PLAY_SERVICES_NOT_AVAILABLE when Google
  // Play Services is missing or too old. The native side pops Google's own
  // update dialog, but the rejection used to surface as the same generic
  // "sign-in didn't work" — so the user saw two things at once and no
  // instruction. Name it, so the screen can tell them to update.
  try {
    await lib.GoogleSignin.hasPlayServices({ showPlayServicesUpdateDialog: true });
  } catch (err) {
    throw new SignInFailedError(
      "play_services",
      "This phone needs an up-to-date Google Play Services to sign in.",
      lib.isErrorWithCode(err) ? String(err.code) : "",
    );
  }

  // Clear any cached Google session BEFORE signing in. Two reasons:
  //   1. RELIABILITY (fixes "sign-in didn't work, try again"): a stale cached
  //      session sometimes makes signIn() resolve WITHOUT a fresh idToken (a
  //      silent re-auth), so the old code threw "no ID token" and the user had
  //      to retry. signOut() forces a fresh interactive sign-in that always
  //      mints a token.
  //   2. ACCOUNT SWITCHING: it shows the account picker every time, the intent
  //      the configure() comment states (offlineAccess:false alone doesn't do
  //      this).
  // signOut() never throws a cancellation, so the user-cancel path below is
  // unaffected. If the first attempt STILL yields no token (transient), we
  // sign out and try once more before giving up.
  try {
    await lib.GoogleSignin.signOut();
  } catch {
    // nothing cached — fine
  }
  let idToken = await signInForIdToken(lib);
  if (!idToken) {
    try {
      await lib.GoogleSignin.signOut();
    } catch {
      // ignore
    }
    idToken = await signInForIdToken(lib);
  }
  if (!idToken) {
    throw new SignInFailedError(
      "no_id_token",
      "Google didn't return a sign-in credential. Try again.",
    );
  }

  const token = idToken;
  // When the token arrived, on the phone's clock: only elapsed time is read
  // from it (see requireLiveToken).
  const receivedAt = Date.now();
  const baseUrl = await getBackendUrl();
  // The server asks "different account on this phone?" (signInExchange). On
  // cancel, also revoke the Google selection locally so the next sign-in
  // re-prompts the picker instead of silently reusing the just-picked account.
  const exchange = await signInExchange({
    url: `${baseUrl}/v1/auth/google`,
    // Phase 2: if the local install already minted its default vault locally
    // (the common case after migration 007 ran), include the registration
    // block so /v1/auth/google + POST /v1/vaults collapse into a single
    // round-trip. Mid-onboarding installs (auth before profile) have no vault
    // yet; the field is omitted and POST /v1/vaults follows after
    // onboarding/profile. Recomputed per attempt: "start fresh" empties the
    // ledger between attempts.
    payload: async () => ({
      id_token: token,
      pending_vault_registration: await loadPendingVaultRegistration(),
    }),
    onDifferentAccount,
    onCancelCleanup: async () => {
      try {
        await lib.GoogleSignin.signOut();
      } catch {
        // already signed out / never signed in — fine
      }
    },
    // The same ID token is sent again: it must still have a minute left.
    beforeSwitch: () => requireLiveToken(token, receivedAt),
  });
  return applyAuthResponse(await authResponseFrom(exchange));
}

// Slow-network budget for the ONE call that decides whether sign-in works.
// Was 20s with no retry, which is how a shopkeeper on a weak Afghan link got
// "Sign-in didn't work" while the server was still happily processing: the
// server's write timeout is 120s, so it could commit the account AFTER the
// phone had given up. 45s stays inside that window, and one retry covers a
// dropped first attempt. Retrying is safe because every sign-in endpoint is
// idempotent for the same credential: Google/Apple resolve the same subject,
// a password sign-in is just another attempt, and the email-code verifies
// replay a code this install already consumed (docs/kaata-accounts.md §6,
// "Retry safety"); the start endpoints are handled in emailCodeStart.
const AUTH_TIMEOUT_MS = 45_000;
const AUTH_ATTEMPTS = 2;

// POST with the timeout and one retry. `retried` says the request went out
// twice, so the first may have reached the server after all: the email flows
// read a refusal of the second attempt in that light.
async function postAuthTracked(
  url: string,
  payload: unknown,
): Promise<{ res: Response; retried: boolean }> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= AUTH_ATTEMPTS; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), AUTH_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      return { res, retried: attempt > 1 };
    } catch (err) {
      lastErr = err;
      // Retry once on a timeout or a transport failure; both are the
      // signature of a weak link rather than a rejected credential.
      if (attempt < AUTH_ATTEMPTS) continue;
      throw transportFailure(err);
    } finally {
      clearTimeout(timer);
    }
  }
  // Unreachable (the loop either returns or throws), but keeps TS honest.
  throw lastErr instanceof Error ? lastErr : new SignInFailedError("unknown", "Sign-in failed.");
}

function transportFailure(err: unknown): SignInFailedError {
  if (err instanceof Error && err.name === "AbortError") {
    return new SignInFailedError(
      "timeout",
      "Sign-in timed out — check your connection and try again.",
    );
  }
  return new SignInFailedError(
    "network",
    "Couldn't reach Kaata — check your connection and try again.",
    err instanceof Error ? err.message.slice(0, 60) : "",
  );
}

// The JSON object a response carries, or null (empty, not JSON, not an object:
// a captive portal or a proxy error page). Read ONCE: a body cannot be re-read.
async function readBody(res: Response): Promise<Record<string, unknown> | null> {
  try {
    const body: unknown = await res.json();
    return typeof body === "object" && body !== null ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

// The longest wait a throttle can name: the per-address windows run up to a
// day. Anything larger is not a duration at all.
const MAX_RETRY_AFTER_S = 86_400;

// Seconds until a throttle lets the next request through: the body's
// retry_after_s (the per-address and sign-in throttles), else the Retry-After
// header the per-IP limiter (httprate) sets on its bare 429s. The backend sends
// that header in SECONDS, never as an HTTP date. A value past a day is a Unix
// timestamp (an older limiter stamped its reset time there) and is ignored
// rather than read as "try again in 56 years".
function retryAfterSeconds(
  body: Record<string, unknown> | null,
  headers: Headers | undefined,
): number | undefined {
  const fromBody = body?.retry_after_s;
  if (
    typeof fromBody === "number" &&
    Number.isFinite(fromBody) &&
    fromBody >= 0 &&
    fromBody <= MAX_RETRY_AFTER_S
  ) {
    return Math.ceil(fromBody);
  }
  const raw = headers?.get?.("Retry-After")?.trim();
  if (!raw || !/^\d+$/.test(raw)) return undefined;
  const seconds = Number(raw);
  return seconds <= MAX_RETRY_AFTER_S ? seconds : undefined;
}

// The server's named refusal as an EmailAuthError, or null when it named none.
// A bare 429 (no error_code) is the per-IP limiter: "rate_limited".
function apiRefusal(
  status: number,
  body: Record<string, unknown> | null,
  headers: Headers | undefined,
): EmailAuthError | null {
  const code = typeof body?.error_code === "string" ? body.error_code : "";
  const extra: EmailAuthErrorExtra = {};
  if (typeof body?.reason === "string" && body.reason) extra.reason = body.reason;
  if (typeof body?.email === "string" && body.email) extra.email = body.email;
  if (typeof body?.limit === "string" && body.limit) extra.limit = body.limit;
  const retryAfterS = retryAfterSeconds(body, headers);
  if (retryAfterS !== undefined) extra.retryAfterS = retryAfterS;
  if (code) return new EmailAuthError(code, status, extra);
  if (status === 429) return new EmailAuthError("rate_limited", 429, extra);
  return null;
}

// A sign-in reply → the session to install, or the typed failure. `installId`
// is the id the request was sent for, so a 410 (or a success that clears an
// earlier one) is recorded against exactly that installation.
async function authResponseFrom(exchange: {
  res: Response;
  body: Record<string, unknown> | null;
  installId: string;
}): Promise<AuthResponse> {
  const { res, body, installId } = exchange;
  if (!res.ok) {
    // Non-JSON body (captive portal, proxy error page): the status alone still
    // tells the operator what happened.
    const detail = typeof body?.error === "string" ? body.error : "";
    if (res.status === 410) {
      // Retired install (see InstallRetiredError): remember it for Account's
      // notice, as check-in does. Best-effort — the thrown error is what the
      // screen acts on, and a failed write must not turn into "try again".
      try {
        await markInstallRetired(installId);
      } catch (err) {
        console.warn("[auth] could not record the retired install", err);
      }
      throw new InstallRetiredError(detail || undefined);
    }
    const refusal = apiRefusal(res.status, body, res.headers);
    if (refusal) throw refusal;
    throw new SignInFailedError(
      "server",
      detail || "Kaata couldn't complete sign-in. Try again.",
      String(res.status),
    );
  }
  if (!body) {
    // A 200 whose body isn't JSON means something between us rewrote the
    // response — captive portals do this. Previously an unguarded throw.
    throw new SignInFailedError(
      "server",
      "Kaata got an unreadable reply. Try again.",
      "200-badbody",
    );
  }
  // A session issued for this install_id means the server accepts it, so a
  // 410 recorded for it earlier must not keep Account's reset notice up
  // (clearInstallRetired). Best-effort: the sign-in itself has succeeded.
  if (typeof body.session_jwt === "string" && body.session_jwt !== "") {
    try {
      await clearInstallRetired(installId);
    } catch (err) {
      console.warn("[auth] could not clear the retired-install flag", err);
    }
  }
  return body as AuthResponse;
}

// Backend response shape shared by every sign-in endpoint: /v1/auth/google,
// /v1/auth/apple and the /v1/auth/email/* flows. user.sub is the provider's
// subject; an email session omits it (docs/kaata-accounts.md §6).
type AuthResponse = {
  session_jwt: string;
  account_id?: string;
  default_vault_id?: string | null;
  deletion_cancelled?: boolean;
  user: SessionUser & { sub?: string };
};

// Shared post-/v1/auth-response handling for every sign-in (Google, Apple and
// email): persist the session + user, run the once-per-install housekeeping
// (vault mirror seed, account_bound emission), reconcile the account phone, and
// register the mesh device key. Extracted so every provider lands the user in
// an identical signed-in state. All housekeeping is best-effort — a transient failure must
// not deny the already-authenticated user their session.
function applyAuthResponse(body: AuthResponse): Promise<SessionUser> {
  return mutateLocalSession(() => installAuthResponse(body));
}

async function installAuthResponse(body: AuthResponse): Promise<SessionUser> {
  sessionBindingVersion++;
  // A receipt from an earlier identity must never erase this new account's
  // records later, even after this session signs out.
  await SecureStore.deleteItemAsync(DELETION_CONFIRMATION_KEY);
  await SecureStore.deleteItemAsync(DELETION_ATTEMPT_KEY);
  await SecureStore.deleteItemAsync(DELETION_BASELINE_KEY);
  await SecureStore.setItemAsync(SESSION_KEY, body.session_jwt);
  await SecureStore.setItemAsync(USER_KEY, JSON.stringify(body.user ?? {}));
  // Account-scoped, non-secret hint for the returning account's restore flow.
  if (body.deletion_cancelled && body.account_id) {
    try {
      await setAppMetaInTx(await getDb(), "account_deletion_cancelled", body.account_id);
    } catch (err) {
      console.warn("[auth] could not save the account recovery hint", err);
    }
  }
  await setAppMetaInTx(await getDb(), "account_deletion_cleanup_blocked", "").catch(() => {});
  // Every sign-in, whatever the provider, ends a pending email code step: it
  // belonged to the flow (or the account) this sign-in replaces.
  await clearEmailFlowPending();

  try {
    await postSignInHousekeeping({
      accountId: body.account_id ?? null,
      defaultVaultId: body.default_vault_id ?? null,
      providerSub: body.user?.sub ?? null,
      email: body.user?.email ?? null,
    });
  } catch (err) {
    console.warn("[auth] post-sign-in housekeeping failed", err);
  }

  try {
    await reconcileAccountPhone(body.user?.phone ?? null);
  } catch (err) {
    console.warn("[auth] account phone reconcile failed", err);
  }

  // Lazy mesh import: loading lib/mesh wires SHA-512 into @noble/ed25519, a cost
  // we don't want on every screen that transitively imports auth.ts.
  void (async () => {
    try {
      const mesh = await import("./mesh");
      await mesh.registerDeviceKey();
    } catch (err) {
      console.warn("[auth] mesh.registerDeviceKey failed", err);
    }
  })();

  return body.user ?? {};
}

// Sign in with Apple — BOTH platforms (App Store guideline 4.8 on iOS; the
// Apple web OAuth flow on Android). Token acquisition differs per platform,
// then both funnel into the same completion path (name stash → guard →
// POST /v1/auth/apple → applyAuthResponse):
//   - iOS: the native module (expo-apple-authentication), token audience =
//     the app's bundle id.
//   - Android: a browser auth session through the backend trampoline
//     (/v1/auth/apple/web/start → appleid.apple.com → callback → kaata://
//     deep link carrying the identity token), token audience = the Apple
//     SERVICES ID. Requires APPLE_SERVICES_ID configured on the backend —
//     when it isn't, this throws with a clear message before opening any UI.
// Takes the same optional "different account on this phone?" prompt as
// signInWithGoogle. Native/browser modules are imported lazily so this file
// stays safe to import in Expo Go.
export async function signInWithApple(
  onDifferentAccount?: DifferentAccountPrompt,
): Promise<SessionUser> {
  const acquired =
    Platform.OS === "ios" ? await acquireAppleTokenNative() : await acquireAppleTokenWeb();
  return completeAppleSignIn(acquired, onDifferentAccount);
}

// The (token, first-auth name, apple sub) triple both acquisition paths
// produce. appleSub keys the one-shot name stash so a stale stash from Apple
// ID A is never attached to Apple ID B.
// receivedAt: when the token arrived, on the phone's clock (requireLiveToken).
type AcquiredAppleToken = {
  idToken: string;
  freshName: string;
  appleSub: string;
  receivedAt: number;
};

// app_meta key of the one-shot Apple name stash: JSON {sub, name}, "" once a
// sign-in has delivered it. See completeAppleSignIn; resetRetiredInstall
// carries it across its wipe.
const APPLE_NAME_STASH_KEY = "apple_pending_display_name";

// iOS: native Sign in with Apple sheet.
async function acquireAppleTokenNative(): Promise<AcquiredAppleToken> {
  const AppleAuthentication = await import("expo-apple-authentication");
  const credential = await AppleAuthentication.signInAsync({
    requestedScopes: [
      AppleAuthentication.AppleAuthenticationScope.FULL_NAME,
      AppleAuthentication.AppleAuthenticationScope.EMAIL,
    ],
  });
  const idToken = credential.identityToken;
  if (!idToken) {
    throw new Error("Apple did not return an identity token");
  }
  // Apple returns the name ONLY on the first authorization for this Apple ID.
  const fn = credential.fullName;
  const freshName = [fn?.givenName, fn?.familyName].filter(Boolean).join(" ").trim();
  return { idToken, freshName, appleSub: credential.user, receivedAt: Date.now() };
}

// Android: Apple's web OAuth via the backend trampoline + a browser auth
// session. The app mints the `state` nonce and refuses any callback carrying
// a different one (the trampoline relays it opaquely).
async function acquireAppleTokenWeb(): Promise<AcquiredAppleToken> {
  const baseUrl = await getBackendUrl();

  // Pre-flight: a redirect (302) means the backend has APPLE_SERVICES_ID
  // configured; 404 means the flow is off — fail HERE with a clear error
  // instead of opening a browser onto a JSON error page.
  const probe = await fetch(`${baseUrl}/v1/auth/apple/web/start?state=probe`, {
    redirect: "manual",
  });
  // RN fetch reports a manual-mode redirect as an opaque 0/302 depending on
  // the platform; anything that is NOT an explicit error status counts as
  // configured.
  if (probe.status === 404 || probe.status === 400) {
    throw new Error("Sign in with Apple isn't set up on this server yet.");
  }

  const Crypto = await import("expo-crypto");
  const stateBytes = await Crypto.getRandomBytesAsync(16);
  const state = Array.from(stateBytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  const WebBrowser = await import("expo-web-browser");
  const result = await WebBrowser.openAuthSessionAsync(
    `${baseUrl}/v1/auth/apple/web/start?state=${state}`,
    "kaata://apple-auth",
  );
  if (result.type !== "success") {
    // Closed the browser sheet / backed out — same shape the native module
    // throws so isCancellation() treats both alike.
    throw { code: "ERR_REQUEST_CANCELED", message: "apple web sign-in dismissed" };
  }

  // kaata://apple-auth#id_token=...&state=...&user=...  (fragment payload —
  // never logged server-side). Parse manually: URL() on custom schemes is
  // inconsistent across JS engines.
  const fragment = result.url.split("#")[1] ?? "";
  const params = new URLSearchParams(fragment);
  const errCode = params.get("error");
  if (errCode === "user_cancelled_authorize") {
    throw { code: "ERR_REQUEST_CANCELED", message: "apple web sign-in cancelled" };
  }
  if (errCode) {
    throw new Error(`Apple sign-in failed: ${errCode}`);
  }
  if (params.get("state") !== state) {
    // A callback we did not initiate — refuse outright.
    throw new Error("Apple sign-in state mismatch — please try again.");
  }
  const idToken = params.get("id_token") ?? "";
  if (!idToken) {
    throw new Error("Apple did not return an identity token");
  }

  // First-authorization-only name JSON, relayed verbatim by the trampoline.
  let freshName = "";
  const rawUser = params.get("user");
  if (rawUser) {
    try {
      const u = JSON.parse(rawUser) as { name?: { firstName?: string; lastName?: string } };
      freshName = [u.name?.firstName, u.name?.lastName].filter(Boolean).join(" ").trim();
    } catch {
      // Malformed relay — proceed nameless rather than fail the sign-in.
    }
  }

  // The web flow has no credential.user field — the token's own sub claim
  // is the same value (display-only stash key; the backend re-verifies).
  const claims = decodeIdTokenClaims(idToken);
  const appleSub = typeof claims?.sub === "string" ? claims.sub : "";
  return { idToken, freshName, appleSub, receivedAt: Date.now() };
}

// Shared completion for both acquisition paths: one-shot name stash →
// POST /v1/auth/apple (with the server's different-account question) →
// applyAuthResponse.
async function completeAppleSignIn(
  acquired: AcquiredAppleToken,
  onDifferentAccount?: DifferentAccountPrompt,
): Promise<SessionUser> {
  const { idToken, freshName, appleSub, receivedAt } = acquired;

  // One-shot-name insurance: if anything below fails (a cancelled switch, timeout,
  // 5xx, offline), a retry's signInAsync resolves WITHOUT a name — Apple
  // never re-sends it, so an unstashed name is lost forever and the account
  // stays nameless (the backend's non-empty-wins COALESCE can't restore what
  // never arrived). Stash it BEFORE anything can throw, keyed to the Apple
  // user id (appleSub == the token's sub) so a stale stash from Apple ID A is
  // never sent as the name of a different Apple ID B; fall back to a
  // sub-matching stash on retries, clear only after a confirmed 200.
  // NOTE: getDb() is called fresh at every use site here (never held in a
  // local) because a "start fresh" answer to the different-account question
  // runs wipeLocalPhone, whose resetAllLocalData() CLOSES the handle — a
  // captured db would throw on every later call.
  if (freshName) {
    await setAppMetaInTx(
      await getDb(),
      APPLE_NAME_STASH_KEY,
      JSON.stringify({ sub: appleSub, name: freshName }),
    );
  }

  let displayName = freshName;
  if (!displayName) {
    try {
      const raw = await getAppMetaInTx(await getDb(), APPLE_NAME_STASH_KEY);
      if (raw) {
        const stash = JSON.parse(raw) as { sub?: string; name?: string };
        if (stash.sub === appleSub && stash.name) displayName = stash.name;
      }
    } catch {
      // Malformed / legacy stash — treat as absent rather than fail sign-in.
    }
  }

  const baseUrl = await getBackendUrl();
  // Same slow-network budget, single retry, typed failures and
  // different-account question (keep / wipe / cancel) as Google. Apple has no
  // picker to revoke on cancel, so no cleanup callback. A "start fresh" wipe
  // keeps the name stash (wipeLocalPhone), and displayName is already in hand.
  const exchange = await signInExchange({
    url: `${baseUrl}/v1/auth/apple`,
    payload: () => ({ identity_token: idToken, display_name: displayName || undefined }),
    onDifferentAccount,
    beforeSwitch: () => requireLiveToken(idToken, receivedAt),
  });
  const body = await authResponseFrom(exchange);
  // The name reached the backend — drop the one-shot stash. Best-effort: a
  // local SQLite hiccup here must not fail a sign-in the server has already
  // accepted (worst case the sub-keyed stash lingers until the next success).
  try {
    await setAppMetaInTx(await getDb(), APPLE_NAME_STASH_KEY, "");
  } catch {
    /* best-effort */
  }
  return applyAuthResponse(body);
}

// ---------- Kaata accounts: email + password (docs/kaata-accounts.md) ----------
//
// Kaata's own accounts, next to Google and Apple: an email address proven by an
// emailed 6-digit code, and a password. Every flow here lands in the same
// signed-in state as Google and Apple (applyAuthResponse), asks the same
// server-side "different account on this phone?" question (signInExchange) and
// maps the same 410 to InstallRetiredError. The server is authoritative for
// every rule; the screens only mirror the cheap ones (lib/account-rules.ts).
//
// Nothing the user typed is ever logged or put into an error: refusals are
// EmailAuthError, whose message is the server's reason code and nothing else.

/** Details a refusal carries besides its code (see apiRefusal). */
export type EmailAuthErrorExtra = {
  /** The response's own sub-reason, e.g. weak_password's "too_short". */
  reason?: string;
  /** Seconds until a throttle lets the next request through. */
  retryAfterS?: number;
  /**
   * too_many_requests: the per-address mail window that refused ("minute",
   * "hour" or "day"). See emailCodeStart for the one case it changes.
   */
  limit?: string;
  /** different_account: the display email of the account being signed in to. */
  email?: string;
};

/**
 * A refusal the Kaata server named with an error_code (invalid_code,
 * weak_password, invalid_credentials, too_many_attempts, …), or a bare 429 from
 * the per-IP limiter ("rate_limited"). `reason` is that code and `status` the
 * HTTP status. The message is the reason ONLY, so a crash report or a console
 * line can never carry an address, a username or a password.
 *
 * It stays a SignInFailedError ("server <status>"), so code that only knows the
 * base class still renders it as a coded server answer.
 */
export class EmailAuthError extends SignInFailedError {
  readonly reason: string;
  readonly status: number;
  readonly extra: EmailAuthErrorExtra;
  constructor(reason: string, status: number, extra: EmailAuthErrorExtra = {}) {
    super("server", reason, String(status));
    this.name = "EmailAuthError";
    this.reason = reason;
    this.status = status;
    this.extra = extra;
  }
}

/** A code request's answer: always "sent", whether or not an account exists. */
export type EmailCodeSent = { resendAfterS: number };

export type EmailFlowPurpose = "signup" | "reset" | "setup";

/** How long an emailed code lives (the server's TTL, §4). */
export const EMAIL_CODE_TTL_MS = 15 * 60 * 1000;
const DEFAULT_RESEND_AFTER_S = 60;

// app_meta: the code step to reopen when the phone killed the app while the
// user read their email. JSON {purpose, email, sent_at}: never a password, never
// a code. Cleared on success, on cancel ("Change email") and after the TTL.
const EMAIL_FLOW_PENDING_KEY = "email_flow_pending";

export type EmailFlowPending = {
  purpose: EmailFlowPurpose;
  email: string;
  sentAt: number;
  /** A set-password step's account (app_meta account_id at the start); null otherwise. */
  accountId: string | null;
};

/** The code step still worth reopening, or null (cleared when expired or unreadable). */
export async function readEmailFlowPending(): Promise<EmailFlowPending | null> {
  let raw: string | null;
  try {
    raw = await getAppMetaInTx(await getDb(), EMAIL_FLOW_PENDING_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  type Stored = { purpose?: unknown; email?: unknown; sent_at?: unknown; account_id?: unknown };
  let parsed: Stored | null = null;
  try {
    parsed = JSON.parse(raw) as Stored | null;
  } catch {
    parsed = null;
  }
  const purpose = parsed?.purpose;
  const sentAt = typeof parsed?.sent_at === "number" ? parsed.sent_at : NaN;
  // abs(): a clock set back must not keep a step open forever either.
  const live = Number.isFinite(sentAt) && Math.abs(Date.now() - sentAt) < EMAIL_CODE_TTL_MS;
  if (
    live &&
    (purpose === "signup" || purpose === "reset" || purpose === "setup") &&
    typeof parsed?.email === "string"
  ) {
    const accountId =
      typeof parsed.account_id === "string" && parsed.account_id ? parsed.account_id : null;
    return { purpose, email: parsed.email, sentAt, accountId };
  }
  await clearEmailFlowPending();
  return null;
}

/**
 * A set-password code step to reopen, for the account signed in NOW only. A
 * setup step started by another account on this phone (or by an older build,
 * which stored no account) is forgotten instead: its code was mailed for that
 * account, and the screen would offer it to the wrong one.
 */
export async function readSetupFlowPending(): Promise<EmailFlowPending | null> {
  const pending = await readEmailFlowPending();
  if (!pending || pending.purpose !== "setup") return null;
  let current: string | null = null;
  try {
    current = await getAppMetaInTx(await getDb(), "account_id");
  } catch {
    current = null;
  }
  if (current && pending.accountId === current) return pending;
  await clearEmailFlowPending();
  return null;
}

export async function clearEmailFlowPending(): Promise<void> {
  try {
    await setAppMetaInTx(await getDb(), EMAIL_FLOW_PENDING_KEY, "");
  } catch (err) {
    console.warn("[auth] could not clear the pending email step", err);
  }
}

// Verify accepts any of the newest 3 live codes for an address (§4), so the
// code the user types may be older than the newest send. `sends` keeps the
// newest 3 send times still inside the 15-minute TTL for this purpose and
// address (a new purpose or address starts over), and `first_sent_at`, the
// oldest of them, is what requireFreshCode judges. `sent_at` stays the newest:
// the resend countdown and the reopened step read it.
const CODES_ACCEPTED = 3;

async function rememberEmailFlowPending(
  purpose: EmailFlowPurpose,
  email: string,
  accountId: string | null = null,
): Promise<void> {
  try {
    const db = await getDb();
    const now = Date.now();
    let earlier: number[] = [];
    try {
      const raw = await getAppMetaInTx(db, EMAIL_FLOW_PENDING_KEY);
      const prior = raw
        ? (JSON.parse(raw) as { purpose?: unknown; email?: unknown; sends?: unknown })
        : null;
      if (prior?.purpose === purpose && prior.email === email && Array.isArray(prior.sends)) {
        earlier = prior.sends.filter(
          (t): t is number =>
            typeof t === "number" && Number.isFinite(t) && Math.abs(now - t) < EMAIL_CODE_TTL_MS,
        );
      }
    } catch {
      earlier = [];
    }
    const sends = [...earlier, now].sort((a, b) => a - b).slice(-CODES_ACCEPTED);
    await setAppMetaInTx(
      db,
      EMAIL_FLOW_PENDING_KEY,
      JSON.stringify({
        purpose,
        email,
        sent_at: now,
        first_sent_at: sends[0],
        sends,
        ...(accountId ? { account_id: accountId } : {}),
      }),
    );
  } catch (err) {
    // Only the reopen-after-a-kill convenience is lost; the code was sent.
    console.warn("[auth] could not remember the pending email step", err);
  }
}

function resendAfter(body: Record<string, unknown> | null): number {
  const v = body?.resend_after_s;
  return typeof v === "number" && Number.isFinite(v) && v >= 0
    ? Math.ceil(v)
    : DEFAULT_RESEND_AFTER_S;
}

const stringOrNull = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

// signup/start and reset/start. Both answer "sent" for every valid address
// (principle 2): a taken or unknown address is told apart only by what lands in
// its inbox. One refusal reads differently: the per-address throttle's MINUTE
// window answering a RETRIED request. The throttle counts requests, so the
// first attempt, whose reply was lost, is what used up the minute: its mail is
// on the way, and that is a "sent". The hour and day windows, and every refusal
// of a request sent once, are real refusals for the screen to show.
async function emailCodeStart(
  path: string,
  purpose: "signup" | "reset",
  email: string,
  lang: string,
): Promise<EmailCodeSent> {
  const address = email.trim();
  const baseUrl = await getBackendUrl();
  const { res, retried } = await postAuthTracked(`${baseUrl}${path}`, { email: address, lang });
  const body = await readBody(res);
  if (!res.ok) {
    const refusal = apiRefusal(res.status, body, res.headers);
    if (retried && refusal?.reason === "too_many_requests" && refusal.extra.limit === "minute") {
      await rememberEmailFlowPending(purpose, address);
      return { resendAfterS: refusal.extra.retryAfterS ?? DEFAULT_RESEND_AFTER_S };
    }
    if (refusal) throw refusal;
    throw new SignInFailedError(
      "server",
      stringOrNull(body?.error) ?? "Kaata couldn't send the code. Try again.",
      String(res.status),
    );
  }
  await rememberEmailFlowPending(purpose, address);
  return { resendAfterS: resendAfter(body) };
}

/** Send a sign-up code to `email` (or, for a taken address, an "already have an account" notice). */
export function emailSignUpStart(email: string, lang: string): Promise<EmailCodeSent> {
  return emailCodeStart("/v1/auth/email/signup/start", "signup", email, lang);
}

/** Send a reset code to an account that has a password (others get a notice or nothing). */
export function emailResetStart(email: string, lang: string): Promise<EmailCodeSent> {
  return emailCodeStart("/v1/auth/email/reset/start", "reset", email, lang);
}

export type EmailSignInOptions = {
  onDifferentAccount?: DifferentAccountPrompt;
  /**
   * The previous attempt at this same step failed on the network, so it may
   * have reached the server: a spent code or an existing account can be our
   * own earlier success (see emailVerify).
   */
  afterTimeout?: boolean;
};

/** Create the account (create-only), then sign in. */
export function emailSignUpVerify(
  args: { email: string; code: string; password: string; lang: string },
  opts: EmailSignInOptions = {},
): Promise<SessionUser> {
  const email = args.email.trim();
  return emailVerify(
    "/v1/auth/email/signup/verify",
    "signup",
    { email, code: args.code, password: args.password, lang: args.lang },
    { email, password: args.password },
    opts,
  );
}

/** Replace the password (every other session of the account ends), then sign in. */
export function emailResetVerify(
  args: { email: string; code: string; newPassword: string; lang: string },
  opts: EmailSignInOptions = {},
): Promise<SessionUser> {
  const email = args.email.trim();
  return emailVerify(
    "/v1/auth/email/reset/verify",
    "reset",
    // lang: the security notice ("your password was reset") speaks the app's language.
    { email, code: args.code, new_password: args.newPassword, lang: args.lang },
    { email, password: args.newPassword },
    opts,
  );
}

/** Email address or username, and the Kaata password. */
export function emailSignIn(
  identifier: string,
  password: string,
  opts: EmailSignInOptions = {},
): Promise<SessionUser> {
  return emailSignInWith(identifier, password, opts.onDifferentAccount);
}

async function emailSignInWith(
  identifier: string,
  password: string,
  onDifferentAccount?: DifferentAccountPrompt,
  state?: SwitchState,
): Promise<SessionUser> {
  const baseUrl = await getBackendUrl();
  const exchange = await signInExchange({
    url: `${baseUrl}/v1/auth/email/signin`,
    // The server trims the password, so a pasted one with a stray space works.
    payload: () => ({ identifier: identifier.trim(), password }),
    onDifferentAccount,
    state,
  });
  return installEmailSession(await authResponseFrom(exchange));
}

// The verifies' retry fallback (§7 "Retry safety"): when the request may
// already have gone through (it was sent twice, or the previous attempt at this
// step timed out), invalid_code (the code is spent) or account_exists (the
// account was made) can be OUR earlier success whose reply never arrived. A
// password sign-in with the same email and password settles it before any
// error is shown, carrying the answer to the different-account question so it
// is not asked twice. If that is refused as well, the original refusal stands.
async function emailVerify(
  path: string,
  purpose: "signup" | "reset",
  payload: Record<string, unknown>,
  fallback: { email: string; password: string },
  opts: EmailSignInOptions,
): Promise<SessionUser> {
  const baseUrl = await getBackendUrl();
  const exchange = await signInExchange({
    url: `${baseUrl}${path}`,
    payload: () => payload,
    onDifferentAccount: opts.onDifferentAccount,
    // "Start fresh" resends the same code after erasing the phone: a code that
    // is about to die would be refused only AFTER the erase. ("Keep" erases
    // nothing; a dead code there is just the server's invalid_code.)
    beforeSwitch: async (choice) => {
      if (choice === "wipe") await requireFreshCode(purpose);
    },
  });
  let body: AuthResponse;
  try {
    body = await authResponseFrom(exchange);
  } catch (err) {
    const mayHaveLanded = exchange.retried || opts.afterTimeout === true;
    if (
      mayHaveLanded &&
      err instanceof EmailAuthError &&
      (err.reason === "invalid_code" || err.reason === "account_exists")
    ) {
      try {
        return await emailSignInWith(
          fallback.email,
          fallback.password,
          opts.onDifferentAccount,
          exchange.state,
        );
      } catch (fallbackErr) {
        if (fallbackErr instanceof EmailAuthError && fallbackErr.reason === "invalid_credentials") {
          throw err;
        }
        throw fallbackErr;
      }
    }
    throw err;
  }
  return installEmailSession(body);
}

// installAuthResponse has already ended any pending code step (every sign-in does).
async function installEmailSession(body: AuthResponse): Promise<SessionUser> {
  const user = await applyAuthResponse(body);
  await noteAccountName(user);
  return user;
}

// ---- the account's own name (§6.11) ----
//
// Shared tallies, reviews, settlements and pushes use the explicit display
// name before accounts.name; an email account starts without either. After an email
// sign-in whose account has no name, this app_meta flag is "1" until the server
// has one: the local self name goes at once when the phone has it, the
// onboarding name when it arrives (onboarding/profile), and check-in retries a
// send that failed. "invalid" means the phone's name cannot be the account's
// (fewer than 2 characters, or refused as invalid_name): nothing is sent, and
// Account shows the name error until a valid save settles it. Any new sign-in
// clears the flag first (postSignInHousekeeping).
const ACCOUNT_NAME_PENDING_KEY = "account_name_pending";
const ACCOUNT_DISPLAY_NAME_PENDING_KEY = "account_display_name_pending";
let displayNameTail: Promise<void> = Promise.resolve();

async function pendingDisplayName(): Promise<{
  account_id: string;
  name: string;
  raw: string;
} | null> {
  const raw = await getAppMetaInTx(await getDb(), ACCOUNT_DISPLAY_NAME_PENDING_KEY);
  if (!raw) return null;
  try {
    const queued = JSON.parse(raw) as { account_id?: unknown; name?: unknown };
    if (queued.account_id === getAccountIdSync() && typeof queued.name === "string") {
      return { account_id: queued.account_id as string, name: queued.name, raw };
    }
  } catch {
    /* invalid or another account's intent is never sent */
  }
  return null;
}

/** Explicit Kaata display-name edit, independent of Google/Apple identity. */
export async function saveAccountDisplayName(
  name: string,
  expectedSession?: SessionSnapshot,
): Promise<EmailAuthError | null> {
  return sendAccountDisplayName(name, undefined, expectedSession);
}

async function sendAccountDisplayName(
  name: string,
  retryOf?: string,
  expectedSession?: SessionSnapshot,
): Promise<EmailAuthError | null> {
  const session = expectedSession ?? (await captureCurrentSession());
  if (!session.accountId || !session.jwt) return new EmailAuthError("session_expired", 401);
  const previous = displayNameTail;
  let release!: () => void;
  displayNameTail = new Promise<void>((done) => {
    release = done;
  });
  await previous;
  const queued = { account_id: session.accountId, name: name.trim() };
  const raw = JSON.stringify(queued);
  const settlePending = async () =>
    applyForCurrentSession(session, async () => {
      const db = await getDb();
      if ((await getAppMetaInTx(db, ACCOUNT_DISPLAY_NAME_PENDING_KEY)) === raw) {
        await setAppMetaInTx(db, ACCOUNT_DISPLAY_NAME_PENDING_KEY, "");
      }
    });
  try {
    await applyForCurrentSession(session, async () => {
      const db = await getDb();
      // A check-in may have read an older queued edit while a newer save was
      // in flight. Once it reaches this serialized tail, retry only that intent.
      if (
        retryOf !== undefined &&
        (await getAppMetaInTx(db, ACCOUNT_DISPLAY_NAME_PENDING_KEY)) !== retryOf
      ) {
        throw new DisplayNameRetrySupersededError();
      }
      await setAppMetaInTx(db, ACCOUNT_DISPLAY_NAME_PENDING_KEY, raw);
    });
    try {
      const body = await accountRequest(
        "PUT",
        "/v1/account/display-name",
        { name: queued.name },
        session.jwt,
      );
      await settlePending();
      await applyForCurrentSession(session, async () => {
        await setAccountNameState("");
        const cached = await SecureStore.getItemAsync(USER_KEY);
        if (!cached) return;
        try {
          const user = JSON.parse(cached) as SessionUser;
          await SecureStore.setItemAsync(
            USER_KEY,
            JSON.stringify({ ...user, name: stringOrNull(body.name) ?? queued.name }),
          );
        } catch {
          /* cosmetics only; the server remains authoritative */
        }
      });
      return null;
    } catch (err) {
      if (err instanceof SessionChangedError) return new EmailAuthError("session_expired", 401);
      if (err instanceof EmailAuthError) {
        if (err.status >= 500) {
          await applyForCurrentSession(session, async () => {});
          return null;
        }
        if (err.status === 401 || err.status === 429) return err;
        await settlePending();
        if (err.reason === "invalid_name") {
          await applyForCurrentSession(session, () => setAccountNameState("invalid"));
        }
        return err;
      }
      // An older server cannot perform this edit. Show a failure, never Saved
      // or a queued success that would silently disappear on the old endpoint.
      if (
        err instanceof SignInFailedError &&
        err.stage === "server" &&
        Number(err.detail) >= 400 &&
        Number(err.detail) < 500
      ) {
        await settlePending();
        return new EmailAuthError("unavailable", Number(err.detail));
      }
      // Offline/5xx: retain the exact chosen name and account, not whichever
      // local self name happens to exist when check-in next retries.
      await applyForCurrentSession(session, async () => {});
      return null;
    }
  } catch (err) {
    if (err instanceof DisplayNameRetrySupersededError) return null;
    if (err instanceof SessionChangedError) return new EmailAuthError("session_expired", 401);
    return new EmailAuthError("unavailable", 503);
  } finally {
    release();
  }
}

class DisplayNameRetrySupersededError extends Error {}

async function noteAccountName(user: SessionUser): Promise<void> {
  const named = !!user.name?.trim();
  try {
    await setAppMetaInTx(await getDb(), ACCOUNT_NAME_PENDING_KEY, named ? "" : "1");
  } catch (err) {
    console.warn("[auth] could not record the account name state", err);
    return;
  }
  // Fire and forget: the sign-in has succeeded, and a slow link must not hold
  // the screen. The flag keeps the name for a retry.
  if (!named) void syncPendingAccountNameFromSelf();
}

// The phone's own name for the shopkeeper, or null: none yet (a fresh install
// before onboarding's profile step) or the restore-time placeholder ("You"),
// which must never become an account's name.
async function localSelfName(): Promise<string | null> {
  try {
    const db = await getDb();
    const row = await db.getFirstAsync<{ display_name: string | null }>(
      "SELECT display_name FROM users WHERE is_local_self = 1 LIMIT 1",
    );
    const name = row?.display_name?.trim();
    if (!name) return null;
    // Lazy: lib/i18n is not one of this module's static imports.
    const { isPlaceholderSelfName } = await import("./i18n");
    return isPlaceholderSelfName(name) ? null : name;
  } catch {
    return null;
  }
}

// Writes the account-name state: "" settled, "1" owed, "invalid" (the phone's
// name breaks the server's rule: nothing is sent until the user fixes it in
// Account, which shows the error when it opens).
async function setAccountNameState(state: "" | "1" | "invalid"): Promise<void> {
  try {
    await setAppMetaInTx(await getDb(), ACCOUNT_NAME_PENDING_KEY, state);
  } catch {
    // Lost only the retry or the notice; the phone keeps the name either way.
  }
}

async function accountNameOwed(): Promise<boolean> {
  try {
    return (await getAppMetaInTx(await getDb(), ACCOUNT_NAME_PENDING_KEY)) === "1";
  } catch {
    return false;
  }
}

/**
 * Where the account's name stands: "settled"; "owed" (an email account still
 * without a name on the server, check-in retries it); or "invalid" (the
 * phone's name cannot be the account's: Account shows the name error when it
 * opens, and a valid save there settles it).
 */
export async function accountNameState(): Promise<"settled" | "owed" | "invalid"> {
  try {
    if (await pendingDisplayName()) return "owed";
    const raw = await getAppMetaInTx(await getDb(), ACCOUNT_NAME_PENDING_KEY);
    return raw === "1" ? "owed" : raw === "invalid" ? "invalid" : "settled";
  } catch {
    return "settled";
  }
}

// Sends the account's name and settles its state by the outcome. Sent:
// settled. provider_name (a Google or Apple identity names this account):
// settled, there is nothing to send. invalid_name: "invalid", so Account asks
// for a better name instead of the account staying nameless in silence. An
// EXPLICIT send that never reached the server (offline, 5xx): owed, so
// check-in sends the phone's own name, which the explicit edit has just set.
// Never throws.
async function sendAccountName(
  name: string,
  explicit: boolean,
): Promise<{ sent: boolean; refusal: EmailAuthError | null }> {
  try {
    await setAccountName(name);
  } catch (err) {
    if (err instanceof EmailAuthError) {
      if (err.reason === "provider_name") await setAccountNameState("");
      else if (err.reason === "invalid_name") await setAccountNameState("invalid");
      return { sent: false, refusal: err };
    }
    if (explicit) await setAccountNameState("1");
    return { sent: false, refusal: null };
  }
  await setAccountNameState("");
  return { sent: true, refusal: null };
}

/**
 * Send `name` as the signed-in account's name. Without `force`, only while an
 * email sign-in left the account nameless (the owed state); `force` sends it
 * whatever the state (every Continue on the onboarding name step when the name
 * is ours to set). Never throws: true when the server has the name.
 */
export async function syncAccountName(
  name: string,
  opts: { force?: boolean } = {},
): Promise<boolean> {
  const trimmed = name.trim();
  if (!trimmed) return false;
  if (!opts.force && !(await accountNameOwed())) return false;
  return (await sendAccountName(trimmed, opts.force === true)).sent;
}

/**
 * Account settings' explicit name edit, when the name is ours to set: sent
 * now, and the server's refusal (invalid_name, session_expired…) returned for
 * the screen to show instead of "Saved". provider_name is not a failure: the
 * account's Google or Apple identity names it, the phone's edit stands, and
 * the state settles. Null: sent, settled, or queued for check-in because the
 * server could not be reached. Never throws.
 */
export async function saveAccountName(name: string): Promise<EmailAuthError | null> {
  const trimmed = name.trim();
  if (!trimmed) return null;
  const { refusal } = await sendAccountName(trimmed, true);
  return refusal && refusal.reason !== "provider_name" ? refusal : null;
}

/**
 * Check-in's and sign-in's retry: the phone's own name, while the account has
 * none. AUTOMATIC, so it is first fitted to the server's rule (whitespace
 * collapsed; over 60 characters, cut at the last word boundary). A name that
 * cannot fit (fewer than 2 characters) is never sent: the state turns
 * "invalid" and Account asks the user for a better one.
 */
export async function syncPendingAccountNameFromSelf(): Promise<void> {
  try {
    const display = await pendingDisplayName();
    if (display) {
      const session = await captureCurrentSession();
      if (session.accountId !== display.account_id) return;
      await sendAccountDisplayName(display.name, display.raw, session);
      return;
    }
    if (!(await accountNameOwed())) return;
    const name = await localSelfName();
    if (!name) return;
    // Lazy: lib/account-rules is not one of this module's static imports.
    const { fitAccountName } = await import("./account-rules");
    const fitted = fitAccountName(name);
    if (!fitted) {
      await setAccountNameState("invalid");
      return;
    }
    await syncAccountName(fitted);
  } catch (err) {
    console.warn("[auth] pending account name sync failed", err);
  }
}

// ---- signed-in account endpoints (/v1/account/*) ----

const ACCOUNT_REQUEST_TIMEOUT_MS = 30_000;

// One request to a signed-in /v1/account/* endpoint. Sent ONCE, never retried:
// a password change sent twice is answered wrong_password the second time, and
// a setup code twice invalid_code. A 401 here always means the session ended
// (wrong passwords are 403), so it is "session_expired" whatever its body says.
async function accountRequest(
  method: "GET" | "POST" | "PUT" | "DELETE",
  path: string,
  payload?: unknown,
  pinnedJwt?: string,
): Promise<Record<string, unknown>> {
  const jwt = pinnedJwt ?? (await SecureStore.getItemAsync(SESSION_KEY));
  if (!jwt) throw new EmailAuthError("session_expired", 401);
  const baseUrl = await getBackendUrl();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ACCOUNT_REQUEST_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${jwt}`,
        ...(payload === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
      signal: controller.signal,
    });
  } catch (err) {
    throw transportFailure(err);
  } finally {
    clearTimeout(timer);
  }
  const body = await readBody(res);
  if (res.status === 401) throw new EmailAuthError("session_expired", 401);
  if (!res.ok) {
    const refusal = apiRefusal(res.status, body, res.headers);
    if (refusal) throw refusal;
    throw new SignInFailedError(
      "server",
      stringOrNull(body?.error) ?? "Kaata couldn't complete that. Try again.",
      String(res.status),
    );
  }
  return body ?? {};
}

/** GET /v1/account/me: how the signed-in account signs in. */
export type AccountMe = {
  /** The account's display email. */
  email: string;
  /** The proven password sign-in address, null without a password. */
  loginEmail: string | null;
  username: string | null;
  hasPassword: boolean;
  /** "google", "apple", "email". */
  providers: string[];
  name: string | null;
  /**
   * Where a first-password code goes: the account's own address, fixed (§6.7).
   * Null when the user must name one (an Apple relay address nobody can read).
   */
  setupEmail: string | null;
};

export async function fetchAccountMe(expectedSession?: SessionSnapshot): Promise<AccountMe> {
  if (expectedSession) await applyForCurrentSession(expectedSession, async () => {});
  const body = await accountRequest(
    "GET",
    "/v1/account/me",
    undefined,
    expectedSession?.jwt ?? undefined,
  );
  return {
    email: stringOrNull(body.email) ?? "",
    loginEmail: stringOrNull(body.login_email),
    username: stringOrNull(body.username),
    hasPassword: body.has_password === true,
    providers: Array.isArray(body.providers)
      ? body.providers.filter((p): p is string => typeof p === "string")
      : [],
    name: stringOrNull(body.name),
    setupEmail: stringOrNull(body.setup_email),
  };
}

/**
 * First password for a Google/Apple account: a code to `email`, or to the
 * account's own email when null (refused with email_required for an Apple
 * relay address). When the account's own address is usable the code always
 * goes there, and naming another one is 409 email_fixed. The pending step
 * remembers the account, so another account on this phone never reopens it.
 */
export async function passwordSetupStart(
  email: string | null,
  lang: string,
): Promise<EmailCodeSent> {
  const address = email?.trim() || null;
  const body = await accountRequest(
    "POST",
    "/v1/account/password/setup/start",
    address ? { email: address, lang } : { lang },
  );
  let accountId: string | null = null;
  try {
    accountId = await getAppMetaInTx(await getDb(), "account_id");
  } catch {
    accountId = null;
  }
  await rememberEmailFlowPending("setup", address ?? "", accountId);
  return { resendAfterS: resendAfter(body) };
}

/** The code and the first password. No new session: this one stays signed in. */
export async function passwordSetupVerify(
  code: string,
  newPassword: string,
  lang: string,
): Promise<{ loginEmail: string | null }> {
  const body = await accountRequest("POST", "/v1/account/password/setup/verify", {
    code,
    new_password: newPassword,
    lang,
  });
  await clearEmailFlowPending();
  return { loginEmail: stringOrNull(body.login_email) };
}

/**
 * Change the password. Every OTHER phone signed in to the account is signed
 * out; this session stays (so a repeat after a lost reply still
 * authenticates), and the reply's session_jwt, a re-signed token of the same
 * session, is stored in place of the current one. A reply without one leaves
 * the current token alone. Sent once; the server answers a repeat the same way.
 */
export async function changePassword(
  currentPassword: string,
  newPassword: string,
  lang: string,
): Promise<void> {
  const binding = sessionBindingVersion;
  const body = await accountRequest("PUT", "/v1/account/password", {
    current_password: currentPassword,
    new_password: newPassword,
    lang,
  });
  const fresh = stringOrNull(body.session_jwt);
  if (fresh) await adoptSessionJWT(binding, fresh);
}

// Store a session token the server re-signed for THIS session (a password
// change) exactly where every sign-in keeps it. Only while the session that
// asked is still the phone's: a sign-out, a wipe or another sign-in since then
// owns the store, and an old reply must neither resurrect a session nor
// replace a newer one. The account, its user record and every cache keyed on
// them stay as they are: the account did not change.
async function adoptSessionJWT(binding: number, fresh: string): Promise<void> {
  await mutateLocalSession(async () => {
    if (binding !== sessionBindingVersion) return;
    if (!(await SecureStore.getItemAsync(SESSION_KEY))) return;
    await SecureStore.setItemAsync(SESSION_KEY, fresh);
  });
}

/**
 * Remove the account's Kaata password (DELETE /v1/account/password), which
 * also drops its email sign-in identity, its username and every email-password
 * session. Only a Google or Apple session may (403 provider_session_required
 * from an email session): whoever removes it controls the provider sign-in.
 */
export async function removePassword(lang: string): Promise<void> {
  // lang: the "password sign-in removed" notice speaks the app's language.
  await accountRequest("DELETE", `/v1/account/password?lang=${encodeURIComponent(lang)}`);
}

/**
 * How the CURRENT session signed in: "provider" (Google or Apple, whose sign-in
 * reply named the provider's subject), "email" (an email session has none), or
 * null when signed out.
 */
export async function currentSessionKind(): Promise<"provider" | "email" | null> {
  if (!(await SecureStore.getItemAsync(SESSION_KEY))) return null;
  try {
    const raw = await SecureStore.getItemAsync(USER_KEY);
    const user = raw ? (JSON.parse(raw) as { sub?: unknown }) : null;
    return typeof user?.sub === "string" && user.sub ? "provider" : "email";
  } catch {
    return "email";
  }
}

/** Set the private sign-in username; "" removes it. Returns the stored (canonical) one. */
export async function setUsername(username: string): Promise<string | null> {
  const body = await accountRequest("PUT", "/v1/account/username", { username: username.trim() });
  return stringOrNull(body.username);
}

/** PUT /v1/account/name, for accounts with no Google or Apple identity. */
export async function setAccountName(name: string): Promise<string> {
  const trimmed = name.trim();
  const body = await accountRequest("PUT", "/v1/account/name", { name: trimmed });
  return stringOrNull(body.name) ?? trimmed;
}

// ---------- Phase 2 helpers ----------

// Loads the local default vault if it hasn't been registered with the server
// yet, so the sign-in round-trip can carry the registration block. Returns
// undefined when there's no local vault (mid-onboarding) or when the vault
// is already known to the server (registered_with_server_at IS NOT NULL).
//
// The TRUST ANCHOR must travel with it. This block is the only way a kaata
// that already existed on the phone before sign-in reaches the server, and
// until 2026-09 it carried no anchor — so those vaults landed server-side
// with vault_trust_anchor_pubkey NULL, which switches the backend's whole
// membership-chain path off and makes a joiner's own admission event be
// refused forever by the legacy owner-only role matrix. Symptom: an invite
// link works, the recipient accepts and sees success, and the owner's
// Members list never grows — on the FIRST kaata only, because every later
// one is registered by createVaultOnServer, which always sends the anchor.
// healMissingServerAnchors (lib/sync/reconcile.ts) repairs the vaults that
// are already in that state.
async function loadPendingVaultRegistration(): Promise<
  | {
      id: string;
      name: string;
      currency: string;
      created_at_ms: number;
      vault_trust_anchor_pubkey?: string;
    }
  | undefined
> {
  const vaultId = await getActiveVaultId();
  if (!vaultId) return undefined;
  const db = await getDb();
  const row = await db.getFirstAsync<{
    id: string;
    name: string;
    currency: string;
    created_at: number;
    registered_with_server_at: number | null;
    vault_trust_anchor_pubkey: string | null;
  }>(
    `SELECT id, name, currency, created_at, registered_with_server_at,
            vault_trust_anchor_pubkey
     FROM vaults WHERE id = ? LIMIT 1`,
    vaultId,
  );
  if (!row) return undefined;
  if (row.registered_with_server_at != null) return undefined;
  return {
    id: row.id,
    name: row.name,
    currency: row.currency || "AFN",
    created_at_ms: row.created_at,
    // Omitted rather than null when absent: a genuinely anchor-less vault
    // (legacy / server-anchored) must stay that way, and the backend treats
    // a missing field and a malformed one identically.
    ...(row.vault_trust_anchor_pubkey
      ? { vault_trust_anchor_pubkey: row.vault_trust_anchor_pubkey }
      : {}),
  };
}

// Runs after a successful /v1/auth/google round-trip. Owns:
//   - stamping the active vault's account_id + registered_with_server_at,
//   - seeding vault_members_mirror with the owner row,
//   - emitting the once-per-install account_bound event.
// Idempotent under repeat sign-ins on the same account.
async function postSignInHousekeeping(args: {
  accountId: string | null;
  defaultVaultId: string | null;
  providerSub: string | null;
  email: string | null;
}): Promise<void> {
  // Local const so TypeScript narrows through the async closure below.
  // Without this, args.accountId regains `string | null` typing inside
  // withTransactionAsync's callback and the SET clauses fail to typecheck.
  const accountId = args.accountId;
  if (!accountId) return; // backend without Phase 2 fields — local-only continues
  // Prime the cache immediately so any event_log appends fired after this
  // call stamp actor_account_id correctly. Without this, the FIRST event
  // appended after sign-in (e.g. the account_bound emission below) would
  // still carry actor_account_id=null because event-log's getAccountIdSync
  // reads from this cache, which was only set when the next app launch
  // primed it from app_meta.
  setAccountIdCache(accountId);
  const providerSub = args.providerSub;
  const db = await getDb();
  const now = Date.now();

  // Capture the PREVIOUSLY-bound account id BEFORE the unconditional
  // app_meta.account_id overwrite below — it scopes the SEC-H3 stale-owner
  // revoke inside the vault transaction. Reading it after the overwrite
  // would always yield the NEW account and the revoke would never fire.
  const priorAccountId = await getAppMetaInTx(db, "account_id");

  // Persist the account binding to app_meta UNCONDITIONALLY — BEFORE the
  // no-vault early-return below. This is load-bearing, not just display:
  //   - AutoSync mounts the sync scheduler off app_meta.account_id, so without
  //     this an onboarding "continue with Google" user (who has no vault yet)
  //     never starts syncing → "Not backed up yet" forever and nothing backs up.
  //   - onboarding/restore.tsx gates its restore probe on app_meta.account_id, so
  //     a null value makes a returning user's restore silently skip → their
  //     kaatas come back EMPTY.
  //   - _layout.tsx reprimes the in-memory cache from app_meta on every launch,
  //     so the in-memory-only setAccountIdCache (above) is lost on relaunch.
  // The old code wrote it ONLY inside the vault-bound transaction below, which a
  // no-vault onboarding sign-in never reaches. account_id is valid regardless of
  // whether a local vault exists yet. [bug fix 2026-06-23]
  await setAppMetaInTx(db, "account_id", accountId);
  // The account's canonical kaata as the server sees it (its oldest owned one).
  // A fresh install restores every kaata in the listing, newest first, and
  // recoverAllVaults opens this one rather than whichever came back first: a
  // shared account (the store-review one) can hold kaatas other people made.
  await setAppMetaInTx(db, "signin_default_vault_id", args.defaultVaultId ?? "");
  // The provider's subject for THIS session (the key name is historical: Apple
  // writes it too). An email session has none, so a previous Google/Apple sub
  // is cleared rather than left to describe another identity. Only the restore
  // reads it (seeding users.google_sub); "different account on this phone?"
  // is the server's question now, keyed on account_id.
  await setAppMetaInTx(db, "account_google_sub", providerSub ?? "");
  // The old side of that question's dialog. Sign-out keeps it on purpose.
  await setAppMetaInTx(db, "account_display_email", args.email ?? "");
  // A new binding owes no name until an email sign-in says so (noteAccountName
  // runs after this housekeeping).
  await setAppMetaInTx(db, "account_name_pending", "");
  await setAppMetaInTx(db, "account_last_seen_at", String(now));

  // SEC H3 (rescoped): revoke the PREVIOUSLY-bound account's mirror rows —
  // this install's own superseded identity after a Keep&Link account switch,
  // which would otherwise linger as a phantom co-owner (blocking the owner
  // upsert below, corrupting last-owner counting, and showing a ghost in
  // Members). Three deliberate properties, each fixing a hole the review
  // caught in narrower drafts:
  //   - ALL vaults, not just the active one: the prior identity is stale on
  //     every vault of this install, and this runs only once (the very next
  //     sign-in overwrites app_meta.account_id, so a missed vault would
  //     never heal).
  //   - BEFORE the no-vault early-return: an account switch with no active
  //     vault (all archived / mid-onboarding) must still revoke.
  //   - Never touches other REAL members' rows — that was the original
  //     blanket `account_id != ?` bug, which locally revoked legitimately
  //     invited members (owner's phone) or the true owner (member's phone)
  //     on every re-sign-in.
  // Multi-account trade-off (documented): if one human deliberately uses
  // two accounts on one phone, the prior account's memberships go locally
  // revoked at switch time — same as the old behavior for the active vault,
  // and the server-side membership is untouched.
  if (priorAccountId && priorAccountId !== accountId) {
    await db.runAsync(
      `UPDATE vault_members_mirror
          SET revoked_at = ?
        WHERE account_id = ?
          AND revoked_at IS NULL`,
      now,
      priorAccountId,
    );
  }

  const vaultId = args.defaultVaultId ?? (await getActiveVaultId());
  if (!vaultId) return; // mid-onboarding: no local vault yet — vault binding deferred

  // Only mark the vault server-registered when the backend CONFIRMED it — i.e.
  // it returned a default_vault_id (the vault it registered via the pending
  // block, or the account's existing canonical vault). When defaultVaultId is
  // null, the backend did NOT register a vault for us this round (e.g. we sent
  // no pending block because the active vault was already flagged, or it was a
  // mid-onboarding sign-in), so stamping registered_with_server_at here would
  // be a LIE that permanently locks the vault out of the reconcile safety net
  // (reconcile only retries vaults where the flag IS NULL). Leave it NULL and
  // let reconcileVaultRegistrations do the real POST + stamp. account_id is
  // always safe to bind.
  const regStamp = args.defaultVaultId != null ? now : null;

  await db.withTransactionAsync(async () => {
    // Bind the vault to this account; stamp registered ONLY when confirmed
    // (regStamp != null). COALESCE(..., null) leaves an existing value as-is and
    // sets nothing when not confirmed — never clobbers, never lies.
    await db.runAsync(
      `UPDATE vaults
          SET account_id                = ?,
              registered_with_server_at = COALESCE(registered_with_server_at, ?),
              updated_at                = ?
        WHERE id = ?`,
      accountId,
      regStamp,
      now,
      vaultId,
    );
    // Seed (or refresh) the owner row in vault_members_mirror — but ONLY on
    // a vault this account actually OWNS. A JOINED kaata (someone else's
    // vault that happens to be active at sign-in time) has a foreign active
    // owner row; INSERT OR REPLACE-ing ourselves as 'owner' there would both
    // fabricate an owner seat we don't hold AND clobber our real
    // editor/viewer row (the PK is (vault_id, account_id)). Ownership signal:
    // the server confirmed this vault as the account's canonical owned vault
    // (defaultVaultId), OR no active owner row outside this device's own
    // identities exists (the pre-sign-in solo vault being adopted).
    // (The prior-account phantom revoke already ran, above the vault gate,
    // so a Keep&Link switch doesn't leave the old account's row counting as
    // a foreign owner here.)
    const myIds = await resolveAccountIdCandidates(accountId);
    const serverConfirmedOwned = args.defaultVaultId != null && args.defaultVaultId === vaultId;
    let owned = serverConfirmedOwned;
    if (!owned) {
      const ph = myIds.map(() => "?").join(",");
      const foreignOwner = await db.getFirstAsync<{ one: number }>(
        `SELECT 1 AS one FROM vault_members_mirror
          WHERE vault_id = ? AND role = 'owner' AND revoked_at IS NULL
            ${myIds.length > 0 ? `AND account_id NOT IN (${ph})` : ""}
          LIMIT 1`,
        vaultId,
        ...myIds,
      );
      owned = foreignOwner == null;
    }
    if (owned) {
      // Collapse this install's own SUPERSEDED identities (the device-key
      // sentinel a pre-sign-in vault keyed its owner row by) before seeding
      // the signed-in owner row. Without this the vault permanently holds
      // TWO active owner rows for the same person — Members shows "(You)"
      // twice, transfer demotes only one of them, and last-owner counting
      // treats the sibling row as "another owner" (letting the sole real
      // owner leave). The old blanket revoke did this collapse implicitly;
      // the rescoped revoke must do it explicitly, scoped to our own ids.
      const staleSelfIds = myIds.filter((id) => id !== accountId);
      if (staleSelfIds.length > 0) {
        const stalePh = staleSelfIds.map(() => "?").join(",");
        await db.runAsync(
          `UPDATE vault_members_mirror
              SET revoked_at = ?
            WHERE vault_id = ?
              AND account_id IN (${stalePh})
              AND revoked_at IS NULL`,
          now,
          vaultId,
          ...staleSelfIds,
        );
      }
      // Upsert (NOT INSERT OR REPLACE): REPLACE deletes the old row first,
      // which silently NULLed a stored display_name on every re-sign-in —
      // degrading what peers inherit when genesis backfill recycles the
      // mirror's name into re-emitted admission events.
      await db.runAsync(
        `INSERT INTO vault_members_mirror
           (vault_id, account_id, role, accepted_at, revoked_at)
         VALUES (?, ?, 'owner', ?, NULL)
         ON CONFLICT(vault_id, account_id) DO UPDATE SET
           role        = 'owner',
           accepted_at = COALESCE(vault_members_mirror.accepted_at, excluded.accepted_at),
           revoked_at  = NULL`,
        vaultId,
        accountId,
        now,
      );
    }
    // Stamp account_id on the local-self user so projection queries can
    // tell which physical person owns this vault. Skipped on a fresh
    // install where local_self doesn't exist yet (onboarding/profile
    // will create it; the next sign-in will populate this field).
    await db.runAsync(
      `UPDATE users
          SET account_id = ?,
              google_sub = COALESCE(google_sub, ?),
              updated_at = ?
        WHERE is_local_self = 1`,
      accountId,
      providerSub,
      now,
    );
    // account_id / account_google_sub / account_last_seen_at are already
    // persisted unconditionally above (before the vault gate), so they're not
    // re-written here. account_bound_at is the first-bind marker — keep it in
    // the vault-bound tx since it pairs with the appendAccountBound emission.
    const boundAt = await getAppMetaInTx(db, "account_bound_at");
    if (!boundAt) {
      await setAppMetaInTx(db, "account_bound_at", String(now));
    }
  });

  // Emit account_bound on first ever sign-in for this install. Idempotent
  // at the local layer — appendAccountBound dedupes against the existing
  // event_log row.
  try {
    // ORDER BY HLC (pms, l, did) NOT appended_at: appended_at is the
    // local Date.now() at write time, which can drift backwards under
    // NTP correction. HLC is the canonical total ordering across the
    // system, so the retroactive cutoff must be the HLC-latest event,
    // otherwise a clock-anomaly write would land OUTSIDE the
    // re-attribution window even though it's causally before sign-in.
    const last = await db.getFirstAsync<{ event_id: string }>(
      `SELECT event_id FROM event_log
        WHERE vault_id = ?
        ORDER BY hlc_physical_ms DESC, hlc_logical DESC, hlc_device_id DESC
        LIMIT 1`,
      vaultId,
    );
    const localSelf = await db.getFirstAsync<{ id: string }>(
      "SELECT id FROM users WHERE is_local_self = 1 LIMIT 1",
    );
    if (localSelf?.id) {
      await appendAccountBound({
        fromUserId: localSelf.id,
        accountId,
        // Synthetic zero-UUID when the log is empty — backend interprets
        // that as "no retroactive re-stamping needed."
        retroactiveThroughEventId: last?.event_id ?? "00000000-0000-0000-0000-000000000000",
        vaultId,
      });
    }
  } catch (err) {
    // Best-effort: the next sign-in will retry (idempotent dedupe), and
    // missing the event only degrades backend ACL re-attribution — never
    // blocks the user.
    console.warn("[auth] appendAccountBound failed", err);
  }

  // Mutual tabs (docs/mutual-tab-design.md §4.6): pull the account's tab
  // bindings so a phone that linked contacts while signed OUT and now signs
  // in, or a reinstalled phone whose kaatas were already on disk, gets its
  // tab_links back without waiting for the loop's next sweep. Lazy import:
  // lib/tabs/api.ts imports getSessionJWT from this module, and a static edge
  // back would make the two evaluate in a cycle. Fire-and-forget — sign-in
  // must never wait on /v1/tabs/mine, and reconcile never throws.
  void import("./tabs/sync")
    .then(({ reconcileTabsFromServer }) => reconcileTabsFromServer())
    .catch((err) => console.warn("[auth] tab reconcile after sign-in failed", err));
}

// ---------- account-level phone (BUG-1: phone survives reinstall) ----------

// Persist the shopkeeper's own phone at the ACCOUNT level on the server so it
// round-trips to a reinstalled device (the local users.phone_e164 is device-
// local and never event-sourced). Signed-in only + best-effort: a local-only
// user keeps the phone on-device and this no-ops; a network failure is swallowed
// (the value is already saved locally; a later edit / sign-in re-pushes it).
// Pass null/"" to clear the stored phone.
export async function updateAccountPhone(
  phone: string | null,
  expectedSession?: SessionSnapshot,
): Promise<void> {
  const jwt = expectedSession ? expectedSession.jwt : await SecureStore.getItemAsync(SESSION_KEY);
  if (!jwt) return;
  try {
    const baseUrl = await getBackendUrl();
    await fetch(`${baseUrl}/v1/account/phone`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${jwt}`,
      },
      body: JSON.stringify({ phone: phone ?? "" }),
    });
  } catch {
    // network failure — local value stands; re-pushed on the next save / sign-in
  }
}

// Adopt a backed-up account phone onto the local self row, but ONLY when the
// self has no phone yet (never clobber a device-local edit). Best-effort: the
// users.phone_e164 UNIQUE constraint can throw if a contact already holds the
// number — swallow it. Exported so the RESTORE flow can call it AFTER
// recoverAllVaults has (re)created the self row: on a reinstall the sign-in-time
// reconcile below runs BEFORE that row exists, and the restored self comes back
// without a phone (the self phone is device-local, never event-sourced).
export async function adoptAccountPhoneToSelf(phone: string | null): Promise<void> {
  if (!phone || phone.length === 0) return;
  // The server stores account phones verbatim (no Go-side validation — by
  // design, it's display identity and never an ACL key), so re-normalize on
  // the way IN. Otherwise a value written by some other client lands straight
  // in the canonical identity column on every fresh install.
  //
  // Only INTERNATIONAL forms are accepted: a national-format server value
  // carries no country context, and guessing would re-home a diaspora user's
  // number — a German "0176 1234567" would become +931761234567 under the AF
  // default. Dropping it is safe; the phone is optional and re-enterable in
  // Account.
  const trimmedPhone = phone.trim();
  const normalized =
    trimmedPhone.startsWith("+") || trimmedPhone.startsWith("00")
      ? normalizePhone(trimmedPhone)
      : null;
  if (!normalized) return;
  try {
    const db = await getDb();
    await db.runAsync(
      "UPDATE users SET phone_e164 = ?, updated_at = ? WHERE is_local_self = 1 AND phone_e164 IS NULL",
      normalized,
      Date.now(),
    );
  } catch (err) {
    // UNIQUE collision with a contact's number, or transient — leave the self
    // phone NULL; the user can re-enter it in Account. Never blocks sign-in.
    console.warn("[auth] adoptAccountPhoneToSelf failed", err);
  }
}

// Reconcile the device-local self phone against the account-level phone returned
// at sign-in. Two directions, both best-effort:
//   - server HAS a phone, local self has NONE  → adopt it onto the local self row
//     (covers an already-onboarded device whose self row exists but has no phone)
//   - local self HAS a phone, server has NONE  → back it up to the account
//     (covers an EXISTING user signing in for the first time)
// When there's no local self row yet (fresh install, pre-onboarding) this no-ops;
// the onboarding profile screen prefills from onboarding_pending_phone, and the
// restore flow calls adoptAccountPhoneToSelf after rebuilding the self row.
// DIVERGENCE: when BOTH sides hold DIFFERENT phones (changed on another device)
// neither branch fires — we keep the local value and don't clobber either side.
// That's intentional: an explicit edit in Account/onboarding ALWAYS re-pushes via
// updateAccountPhone, so this sign-in reconcile only fills the "never backed up /
// never restored" gap rather than fighting an explicit edit.
async function reconcileAccountPhone(serverPhone: string | null): Promise<void> {
  const db = await getDb();
  const self = await db.getFirstAsync<{ phone_e164: string | null }>(
    "SELECT phone_e164 FROM users WHERE is_local_self = 1 LIMIT 1",
  );
  if (!self) return; // no self row yet — onboarding_pending_phone covers prefill
  const localPhone = self.phone_e164 ?? null;
  const serverHas = !!serverPhone && serverPhone.length > 0;
  if (serverHas && !localPhone) {
    await adoptAccountPhoneToSelf(serverPhone);
  } else if (localPhone && !serverHas) {
    await updateAccountPhone(localPhone);
  }
}

// SignOut hits /v1/auth/signout (so the backend deletes the credential
// row), then clears the local SecureStore entries. The backend call is
// best-effort: if the network is down or the session JWT has already
// expired, we still wipe local state because the user has clearly
// expressed intent to be signed out.
export async function signOut(): Promise<void> {
  const bindingVersion = sessionBindingVersion;
  const jwt = await SecureStore.getItemAsync(SESSION_KEY);
  if (jwt) {
    try {
      const baseUrl = await getBackendUrl();
      await fetch(`${baseUrl}/v1/auth/signout`, {
        method: "POST",
        headers: { Authorization: `Bearer ${jwt}` },
      });
    } catch {
      // network failure — don't block the local wipe
    }
  }
  await mutateLocalSession(async () => {
    // A newer sign-in may have finished while sign-out was on the network.
    if (
      bindingVersion !== sessionBindingVersion ||
      (await SecureStore.getItemAsync(SESSION_KEY)) !== jwt
    )
      return;
    sessionBindingVersion++;
    // Revoke locally too so the next signInWithGoogle prompts the picker.
    // Skipped in Expo Go (native module not available — signed-in state is
    // impossible to enter there anyway).
    const lib = loadGoogleSignin();
    if (lib) {
      try {
        await lib.GoogleSignin.signOut();
      } catch {
        // already signed out / never signed in — fine
      }
    }
    await SecureStore.deleteItemAsync(SESSION_KEY);
    await SecureStore.deleteItemAsync(USER_KEY);
    // A pending code step (a set-password code above all) belonged to the
    // session that just ended.
    await clearEmailFlowPending();
    // Drop the cached account_id so any further event appends in this session
    // stamp actor_account_id=null (matching the post-sign-out reality).
    setAccountIdCache(null);
    // Phase 5: drop the in-memory mesh device privkey cache so a subsequent
    // sign-in (or app-state hand-off) doesn't accidentally hold the previous
    // session's loaded copy. Dynamic import avoids pulling the mesh module
    // into the bundle when auth is touched on a local-only install.
    try {
      const mesh = await import("./mesh/device-key");
      mesh.clearDeviceKey();
    } catch {
      /* mesh module not available in this build — fine */
    }
  });
}

// Schedules the signed-in account's 30-day deletion (DELETE /v1/account), revokes
// sessions immediately, then clears saved local state after confirmation and a
// final financial-write guard. Returning sign-in cancels and restores cloud data.
// Play + Apple require an in-app deletion path.
//
// The server delete must succeed FIRST: if it fails (network down, 5xx) we
// throw and leave local data intact so the user can retry, rather than wiping
// their only ledger copy while the server copy survives. A missing/expired
// session is not deletion confirmation and must never trigger the local wipe.
export async function deleteAccount(): Promise<void> {
  const { requestAccountDeletion, completeAccountDeletion, requireAccountDeletionGrace } =
    await import("./account-deletion");
  const recovery = await accountDeletionRecovery(requestAccountDeletion);
  const deletionBinding = sessionBindingVersion;
  // Lost-response retries must still reach the receipt-only DELETE endpoint:
  // their session is already revoked and ordinary backup/policy reads refuse it.
  const attempt = await recovery.readAttempt(),
    confirmation = await recovery.readConfirmation();
  const sameProof =
    recovery.jwt === null
      ? !!(attempt || confirmation)
      : attempt === recovery.jwt || confirmation === recovery.jwt;
  if (!sameProof) {
    const { captureDeletionCleanupBaseline, prepareAccountDeletionBackup } =
      await import("./account-deletion-backup");
    const baseline = await captureDeletionCleanupBaseline();
    await requireAccountDeletionGrace(recovery.jwt, await getBackendUrl());
    await prepareAccountDeletionBackup();
    if (
      deletionBinding !== sessionBindingVersion ||
      (await SecureStore.getItemAsync(SESSION_KEY)) !== recovery.jwt
    )
      throw new Error("account_delete_session_changed");
    await recovery.saveCleanupBaseline(baseline);
  }
  await completeAccountDeletion(recovery);
}

async function accountDeletionRecovery(
  confirm: (jwt: string | null, baseUrl: string) => Promise<void>,
) {
  const bindingVersion = sessionBindingVersion;
  const jwt = await SecureStore.getItemAsync(SESSION_KEY);
  let capturedAttempt = await SecureStore.getItemAsync(DELETION_ATTEMPT_KEY);
  let capturedConfirmation = await SecureStore.getItemAsync(DELETION_CONFIRMATION_KEY);
  let capturedBaseline = await SecureStore.getItemAsync(DELETION_BASELINE_KEY);
  const clearOwnedKey = (key: string, captured: string | null) =>
    mutateLocalSession(async () => {
      const stored = await SecureStore.getItemAsync(key);
      if (stored && stored === captured) await SecureStore.deleteItemAsync(key);
    });
  return {
    jwt,
    readAttempt: async () => {
      capturedAttempt = await SecureStore.getItemAsync(DELETION_ATTEMPT_KEY);
      return capturedAttempt;
    },
    saveAttempt: (attemptJwt: string) =>
      mutateLocalSession(async () => {
        if (
          bindingVersion !== sessionBindingVersion ||
          (await SecureStore.getItemAsync(SESSION_KEY)) !== jwt
        )
          throw new Error("account_delete_session_changed");
        await SecureStore.setItemAsync(DELETION_ATTEMPT_KEY, attemptJwt);
        capturedAttempt = attemptJwt;
      }),
    clearAttempt: async () => {
      await clearOwnedKey(DELETION_ATTEMPT_KEY, capturedAttempt);
      await clearOwnedKey(DELETION_BASELINE_KEY, capturedBaseline);
    },
    saveCleanupBaseline: (baseline: DeletionCleanupBaseline) =>
      mutateLocalSession(async () => {
        if (
          bindingVersion !== sessionBindingVersion ||
          (await SecureStore.getItemAsync(SESSION_KEY)) !== jwt
        )
          throw new Error("account_delete_session_changed");
        capturedBaseline = JSON.stringify({ jwt, ...baseline });
        await SecureStore.setItemAsync(DELETION_BASELINE_KEY, capturedBaseline);
      }),
    readConfirmation: async () => {
      capturedConfirmation = await SecureStore.getItemAsync(DELETION_CONFIRMATION_KEY);
      return capturedConfirmation;
    },
    saveConfirmation: (confirmedJwt: string) =>
      mutateLocalSession(async () => {
        if (bindingVersion !== sessionBindingVersion)
          throw new Error("account_delete_session_changed");
        await SecureStore.setItemAsync(DELETION_CONFIRMATION_KEY, confirmedJwt);
        capturedConfirmation = confirmedJwt;
      }),
    clearConfirmation: () => clearOwnedKey(DELETION_CONFIRMATION_KEY, capturedConfirmation),
    confirmServer: async (session: string | null) => confirm(session, await getBackendUrl()),
    clearLocalData: () =>
      mutateLocalSession(async () => {
        const current = await SecureStore.getItemAsync(SESSION_KEY);
        if (bindingVersion !== sessionBindingVersion || (current !== null && current !== jwt)) {
          // A new sign-in superseded the old deletion flow while it was waiting.
          if (
            capturedConfirmation &&
            (await SecureStore.getItemAsync(DELETION_CONFIRMATION_KEY)) === capturedConfirmation
          )
            await SecureStore.deleteItemAsync(DELETION_CONFIRMATION_KEY);
          throw new Error("account_delete_session_changed");
        }
        const proof = capturedConfirmation ?? jwt ?? capturedAttempt;
        let baseline: DeletionCleanupBaseline | null = null;
        const raw = await SecureStore.getItemAsync(DELETION_BASELINE_KEY);
        if (raw) {
          try {
            const saved = JSON.parse(raw);
            if (
              saved.jwt === proof &&
              typeof saved.events === "string" &&
              typeof saved.tabs === "string"
            )
              baseline = { events: saved.events, tabs: saved.tabs };
          } catch {
            /* Unknown legacy proof fails closed for refused drafts. */
          }
        }
        try {
          await clearDeletedAccountLocally(baseline);
        } catch (error) {
          if (error instanceof Error && error.message === "account_delete_late_edits") {
            await setAppMetaInTx(await getDb(), "account_deletion_cleanup_blocked", "1");
          }
          throw error;
        }
      }),
  };
}

// Keep a retry available even if an interrupted cleanup already removed the JWT.
export async function hasPendingAccountDeletion(): Promise<boolean> {
  return (
    !!(await SecureStore.getItemAsync(DELETION_CONFIRMATION_KEY)) ||
    !!(await SecureStore.getItemAsync(DELETION_ATTEMPT_KEY))
  );
}

// Called before startup sync: only a server-confirmed deletion resumes
// automatically. Unconfirmed attempts remain available for an explicit retry.
export async function resumeConfirmedAccountDeletion(): Promise<void> {
  // Boot runs this on EVERY launch as a fatal step before the ledger opens.
  // Look for the receipt first: an absent SecureStore entry is answered
  // without a Keystore/keychain decrypt, so a session blob that cannot be
  // read (DecryptException) no longer locks a signed-in user out of the
  // whole app. Only a phone holding a confirmed deletion reads the session.
  if (!(await SecureStore.getItemAsync(DELETION_CONFIRMATION_KEY))) return;
  const { resumeConfirmedDeletion } = await import("./account-deletion");
  try {
    await resumeConfirmedDeletion(
      await accountDeletionRecovery(async () => {
        throw new Error("startup_must_not_request_deletion");
      }),
    );
  } catch (error) {
    // Newly created intent must remain accessible, not trap boot behind a
    // fatal retry of an intentionally refused local wipe. Keep the receipt;
    // signing in with the same identity cancels deletion and enables backup.
    if (!(error instanceof Error && error.message === "account_delete_late_edits")) throw error;
  }
}

// "Reset this phone" for a RETIRED installation (see InstallRetiredError): the
// local half of account deletion and nothing more. No request is made — the
// server already refuses this install_id, and it is the fresh install id minted
// after the wipe that it will accept again. Erases every local table, the Google
// and mesh key caches and the stored session, then clears both deletion keys: a
// leftover receipt would make the next launch's resumeConfirmedAccountDeletion
// erase the NEW ledger, and Account would keep offering a finished deletion.
// Destructive and unconditional, so its only callers are the explicit "Reset
// this phone" confirmations; a 401 or 410 on its own must never reach it.
//
// One thing survives: the Apple name stash (wipeLocalPhone's keepAppleName).
// Apple sends the name only on the FIRST authorization, and that is often the
// very sign-in that got the 410 leading here. Account deletion's wipe keeps
// nothing.
export function resetRetiredInstall(): Promise<void> {
  return mutateLocalSession(async () => {
    await wipeLocalPhone({ keepAppleName: true });
    await SecureStore.deleteItemAsync(DELETION_CONFIRMATION_KEY);
    await SecureStore.deleteItemAsync(DELETION_ATTEMPT_KEY);
    await SecureStore.deleteItemAsync(DELETION_BASELINE_KEY);
  });
}

// Account deletion's local half, after the server confirmed the deletion.
// Callers hold mutateLocalSession.
async function clearDeletedAccountLocally(baseline: DeletionCleanupBaseline | null): Promise<void> {
  await wipeLocalPhone({ keepAppleName: false, deletionBaseline: baseline });
}

// THE local wipe, shared by account deletion, resetRetiredInstall and "Switch,
// start fresh" on the different-account question (signInExchange): the Google
// and mesh key caches, every local table, an empty schema under a FRESH install
// id, then the stored session. Callers hold mutateLocalSession.
//
// keepAppleName carries the one-shot Apple name stash (APPLE_NAME_STASH_KEY, in
// app_meta) across the wipe. Apple sends the name only on the FIRST
// authorization, which may be the very sign-in in progress (a "start fresh"
// switch) or the one that got a 410 (a retired install); wiped with app_meta,
// the next Apple sign-in would make an account without a name, and the app has
// no way to add one later. The stash stays keyed to its Apple sub, so it is only
// ever sent for that Apple ID.
async function wipeLocalPhone(opts: {
  keepAppleName: boolean;
  deletionBaseline?: DeletionCleanupBaseline | null;
}): Promise<void> {
  // Invalidate every response captured before the wipe, even if it is
  // interrupted while SecureStore still contains the previous JWT.
  let databaseReset = false;
  if ("deletionBaseline" in opts) {
    const [{ applyEventMutex }, { assertAccountDeletionCleanupSafe }] = await Promise.all([
      import("./projection"),
      import("./account-deletion-backup"),
    ]);
    await applyEventMutex.runExclusive(async () => {
      await assertAccountDeletionCleanupSafe(opts.deletionBaseline ?? null);
      sessionBindingVersion++;
      setAccountIdCache(null);
      await resetAllLocalData();
      setLocalSelfUserIdCache(null);
      databaseReset = true;
    });
    // Migrations can acquire applyEventMutex themselves: rebuild only AFTER
    // dropping/closing the handle and releasing the financial writer lock.
  } else sessionBindingVersion++;
  let appleNameStash: string | null = null;
  if (opts.keepAppleName) {
    try {
      appleNameStash = await getAppMetaInTx(await getDb(), APPLE_NAME_STASH_KEY);
    } catch (err) {
      // Never blocks a wipe the user confirmed; the name is lost as before.
      console.warn("[auth] could not read the Apple name before the wipe", err);
    }
  }
  // Drop the Google session, the mesh key cache, the stored JWT, and every
  // local table.
  const lib = loadGoogleSignin();
  if (lib) {
    try {
      await lib.GoogleSignin.signOut();
    } catch {
      /* already signed out — fine */
    }
  }
  try {
    const mesh = await import("./mesh/device-key");
    mesh.clearDeviceKey();
  } catch {
    /* mesh module not available — fine */
  }
  setAccountIdCache(null);
  // resetAllLocalData drops EVERY table (schema_migrations included) and closes
  // the handle; without re-running migrations every later DB access hits "no
  // such table" until the next cold launch. Fresh install id first (migration
  // 006 requires it), then rebuild the schema.
  if (!databaseReset) await resetAllLocalData();
  setLocalSelfUserIdCache(null);
  const id = await ensureInstallId();
  setInstallIdCache(id);
  await initDb({ installId: id });
  if (appleNameStash) {
    try {
      // A fresh getDb(): the wipe closed the old handle, and initDb has
      // rebuilt app_meta for the new install id.
      await setAppMetaInTx(await getDb(), APPLE_NAME_STASH_KEY, appleNameStash);
    } catch (err) {
      // The phone is wiped either way; only the name is lost.
      console.warn("[auth] could not keep the Apple name across the wipe", err);
    }
  }
  await SecureStore.deleteItemAsync(USER_KEY);
  await SecureStore.deleteItemAsync(SESSION_KEY);
}

// Wipes the SecureStore session entries WITHOUT calling the backend signout
// endpoint: the sync scheduler's answer to a 401 (the session ended), and the
// local-reset flow in Settings. With `onlyIfJwt`, only while that token is
// still the stored one. Every sign-in (a password reset included) gives the
// install a fresh epoch, so a request that was already on its way with the
// previous token comes back 401; that must not sign out the session which
// replaced it.
export async function clearLocalSession(opts: { onlyIfJwt?: string | null } = {}): Promise<void> {
  await mutateLocalSession(async () => {
    if (opts.onlyIfJwt && (await SecureStore.getItemAsync(SESSION_KEY)) !== opts.onlyIfJwt) {
      return;
    }
    sessionBindingVersion++;
    await SecureStore.deleteItemAsync(SESSION_KEY);
    await SecureStore.deleteItemAsync(USER_KEY);
    setAccountIdCache(null);
    try {
      const mesh = await import("./mesh/device-key");
      mesh.clearDeviceKey();
    } catch {
      /* */
    }
  });
}

// Returns the cached session JWT, or null if signed out. Cheap; reads
// SecureStore which is a synchronous-feeling async call.
export async function getSessionJWT(): Promise<string | null> {
  return SecureStore.getItemAsync(SESSION_KEY);
}

// Silently overwrites the stored session JWT. Called from app-meta-context's
// applyCheckIn() when the backend opts to refresh — keeps actively-used
// installs on a rolling 30-day window forever without re-sign-in.
//
// Only for the session the check-in carried. A refresh keeps its session's
// claims, epoch included, so a stored token whose claims differ was stored
// AFTER the check-in left: a new sign-in (a fresh epoch, under which the
// refreshed token no longer authorizes). Overwriting it would sign the phone
// out, or worse act as the previous account. And a sign-out while the
// check-in was out leaves nothing to refresh: never resurrect it.
export async function rotateSessionJWT(newJwt: string): Promise<void> {
  if (!newJwt) return;
  await mutateLocalSession(async () => {
    const current = await SecureStore.getItemAsync(SESSION_KEY);
    if (!current || !sameSessionClaims(current, newJwt)) return;
    await SecureStore.setItemAsync(SESSION_KEY, newJwt);
  });
}

// The claims a check-in refresh copies from the token it renews. Tokens whose
// payload cannot be read are compared as before: not at all.
const SESSION_CLAIMS = ["account_id", "install_id", "provider", "provider_sub", "ep"] as const;

function sameSessionClaims(a: string, b: string): boolean {
  const x = decodeIdTokenClaims(a);
  const y = decodeIdTokenClaims(b);
  if (!x || !y) return true;
  return SESSION_CLAIMS.every((claim) => x[claim] === y[claim]);
}

// Returns the cached display profile from the last successful sign-in.
// Used by Settings to show "Signed in as ahmad@gmail.com".
export async function getSessionUser(): Promise<SessionUser | null> {
  const raw = await SecureStore.getItemAsync(USER_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as SessionUser;
  } catch {
    return null;
  }
}

// True iff a session JWT is stored. Doesn't verify the JWT itself — the
// JWT could be expired or have been signed-out server-side. Backend calls
// will fail with 401 if so; surface those.
export async function isSignedIn(): Promise<boolean> {
  return (await getSessionJWT()) !== null;
}

// Decode the payload of a provider ID token (a standard JWT) without verifying
// its signature. Safe ONLY for local bookkeeping before the backend call (the
// Apple web flow's name-stash key). NEVER use these claims for authorization —
// the backend re-verifies the token against the provider's keys and the
// configured `aud`.
//
// Returns null on any parse failure; callers should treat that as "no
// claims available" and skip whatever feature depends on them.
function decodeIdTokenClaims(idToken: string): Record<string, unknown> | null {
  const parts = idToken.split(".");
  if (parts.length !== 3) return null;
  try {
    // JWT uses base64url, not standard base64. Pad + swap chars before
    // decoding. atob is available in Hermes' standard JS globals.
    const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
    const json = typeof atob === "function" ? atob(padded) : "";
    if (!json) return null;
    const claims: unknown = JSON.parse(json);
    if (typeof claims !== "object" || claims === null) return null;
    return claims as Record<string, unknown>;
  } catch {
    return null;
  }
}

// Helper to recognize the "user cancelled the Google picker" case so
// callers can swallow it silently instead of showing an error toast.
// Uses the lazy-loaded module's isErrorWithCode + statusCodes when
// available; falls back to a string check in Expo Go.
export function isCancellation(err: unknown): boolean {
  // Backing out of Google's chooser (google-signin 16 resolves a cancel, see
  // signInForIdToken) or "Cancel" on the different-account prompt.
  if (err instanceof SignInCancelledByUserError) return true;
  // Sign in with Apple cancellation surfaces as ERR_REQUEST_CANCELED.
  if (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: unknown }).code === "ERR_REQUEST_CANCELED"
  ) {
    return true;
  }
  const lib = loadGoogleSignin();
  if (lib) {
    return lib.isErrorWithCode(err) && err.code === lib.statusCodes.SIGN_IN_CANCELLED;
  }
  // Expo Go path: we don't have the constants, but a cancellation can't
  // really happen here (we throw the "needs dev client" error before
  // anything user-cancellable runs). Belt + braces check anyway.
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: unknown }).code === SIGN_IN_CANCELLED_CODE
  );
}
