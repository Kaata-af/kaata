import Constants from "expo-constants";
import * as SecureStore from "expo-secure-store";
import { Platform } from "react-native";
import { GOOGLE_WEB_CLIENT_ID } from "../constants/env";
import { getBackendUrl } from "./api";
import {
  getActiveVaultId,
  getAppMetaInTx,
  getDb,
  refreshAccountIdCache,
  setAccountIdCache,
  setAppMetaInTx,
} from "./db-tx";
import { resetAllLocalData } from "./db";
import { appendAccountBound } from "./event-log";
import { ensureInstallId } from "./install-id";

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

export type SessionUser = {
  email?: string;
  name?: string;
  picture_url?: string;
  // Account-level phone (E.164) the shopkeeper saved on a prior device, echoed
  // back by /v1/auth/google so a reinstall can prefill it. Absent when none.
  phone?: string;
};

// Phase 4.1: thrown when the user dismisses the "different account on this
// phone?" dialog. Callers should swallow it the same way they swallow the
// Google-picker cancellation — the user explicitly chose to stay on the
// old account, so we keep the existing session untouched.
export class SignInCancelledByUserError extends Error {
  constructor() {
    super("sign_in_cancelled_by_user");
    this.name = "SignInCancelledByUserError";
  }
}

// Result of the "different Google account on this phone" prompt. Returned
// by the UI callback the caller of signInWithGoogle passes in.
//   - "keep"   — replace the binding, keep local ledger data
//   - "wipe"   — wipe local ledger first, then bind the new account
//   - "cancel" — abort the sign-in entirely, stay on the old account
export type DifferentAccountChoice = "keep" | "wipe" | "cancel";

export type DifferentAccountPromptArgs = {
  cachedEmail: string | null; // last-known display email for the old binding
  newEmail: string | null; // email of the account the user just picked
};

// 30 days in ms. Outside this window we silently swap the binding without
// prompting — the previous binding is plausibly abandoned.
const DIFFERENT_ACCOUNT_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

// Phase 4.1 "different account on this phone?" guard, shared by Google AND
// Apple sign-in (both providers' ID tokens are standard JWTs with a stable
// per-account `sub`; postSignInHousekeeping caches whichever provider's sub
// under app_meta.account_google_sub — the key name is historical). If a
// previous sub is cached AND the new sub differs AND the install was active
// within the last 30 days, ask the caller's prompt before the backend call:
//   - "keep"   → return; the sign-in proceeds and rebinds to the new account
//   - "wipe"   → resetAllLocalData() first (clears app_meta too), then return
//   - "cancel" → run onCancelCleanup (provider-specific, e.g. revoke the
//                Google picker selection), then throw
//                SignInCancelledByUserError for the caller to swallow
// Decoding the JWT locally is safe because we only read display info to
// drive UI — the backend still does full signature/aud verification. We DO
// NOT trust these claims for any state mutation.
async function guardDifferentAccount(
  idToken: string,
  onDifferentAccount?: (args: DifferentAccountPromptArgs) => Promise<DifferentAccountChoice>,
  onCancelCleanup?: () => Promise<void>,
): Promise<void> {
  if (!onDifferentAccount) return;
  const decoded = decodeIdTokenClaims(idToken);
  const newSub: string | null = typeof decoded?.sub === "string" ? decoded.sub : null;
  const newEmail: string | null = typeof decoded?.email === "string" ? decoded.email : null;
  if (!newSub) return;

  const db = await getDb();
  const cachedSub = await getAppMetaInTx(db, "account_google_sub");
  const lastSeenRaw = await getAppMetaInTx(db, "account_last_seen_at");
  const lastSeen = lastSeenRaw ? Number(lastSeenRaw) : NaN;
  const withinWindow =
    Number.isFinite(lastSeen) && Date.now() - lastSeen < DIFFERENT_ACCOUNT_WINDOW_MS;
  if (!cachedSub || cachedSub === newSub || !withinWindow) return;

  // Best-effort: pull the last-known email from SecureStore so the dialog
  // can render "old (a@x) vs new (b@y)". Stale is fine — it's for
  // recognition, not authorization.
  let cachedEmail: string | null = null;
  try {
    const cachedUser = await getSessionUser();
    cachedEmail = cachedUser?.email ?? null;
  } catch {
    // SecureStore can transiently fail; UI just shows "—" for the old
    // side. Never blocks the prompt.
  }

  const choice = await onDifferentAccount({ cachedEmail, newEmail });
  if (choice === "cancel") {
    if (onCancelCleanup) await onCancelCleanup();
    throw new SignInCancelledByUserError();
  }
  if (choice === "wipe") {
    // Wipe the local ledger BEFORE the backend call so the new sign-in
    // lands on a clean SQLite. resetAllLocalData clears app_meta too, so
    // cached account_google_sub / account_id / account_last_seen_at all go
    // with it — postSignInHousekeeping will repopulate them fresh.
    await resetAllLocalData();
  }
  // "keep" falls through. postSignInHousekeeping's setAppMetaInTx calls
  // will overwrite account_id / account_google_sub with the new account's
  // values, and appendAccountBound will emit a fresh account_bound event so
  // the server re-attributes any pre-existing events under the new binding.
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
  // Google sign-in is Android-only (iOS uses Sign in with Apple). Skip configure
  // on iOS: without an iOS-type OAuth client id / GoogleService-Info.plist it
  // rejects with "failed to determine clientID" and crashes the caller (B1).
  if (Platform.OS === "ios") return;
  const lib = loadGoogleSignin();
  if (!lib) return;
  lib.GoogleSignin.configure({
    webClientId: GOOGLE_WEB_CLIENT_ID,
    // Force showing the picker every time so a user with multiple Google
    // accounts can switch. Without this, sign-in re-uses the cached
    // account silently — surprising when they want to swap.
    offlineAccess: false,
  });
}

// One interactive Google sign-in attempt → its ID token (or null if the result
// carried none). The library wraps the payload under `data` on newer versions
// and inline on older ones, so we read defensively.
async function signInForIdToken(lib: GoogleSigninModule): Promise<string | null> {
  const result = await lib.GoogleSignin.signIn();
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
  onDifferentAccount?: (args: DifferentAccountPromptArgs) => Promise<DifferentAccountChoice>,
): Promise<SessionUser> {
  const lib = loadGoogleSignin();
  if (!lib) {
    throw new Error(
      "Google sign-in needs a dev client or production APK — it can't run in Expo Go.",
    );
  }

  await lib.GoogleSignin.hasPlayServices({ showPlayServicesUpdateDialog: true });

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
    throw new Error("Google returned no ID token; check OAuth client config.");
  }

  // ---- Phase 4.1: "different Google account on this phone" detection ----
  // Shared with Apple sign-in; see guardDifferentAccount. On cancel, also
  // revoke the Google selection locally so the next sign-in re-prompts the
  // picker instead of silently reusing the just-picked account.
  await guardDifferentAccount(idToken, onDifferentAccount, async () => {
    try {
      await lib.GoogleSignin.signOut();
    } catch {
      // already signed out / never signed in — fine
    }
  });
  // -----------------------------------------------------------------------

  const installId = await ensureInstallId();
  const baseUrl = await getBackendUrl();

  // Phase 2: if the local install already minted its default vault locally
  // (the common case after migration 007 ran), include the registration block
  // so /v1/auth/google + POST /v1/vaults collapse into a single round-trip.
  // Mid-onboarding installs (auth before profile) have no vault yet; we omit
  // the field and follow up with POST /v1/vaults after onboarding/profile.
  const pendingVaultRegistration = await loadPendingVaultRegistration();

  // Timeout the backend round-trip so a cold/slow server fails fast (with a
  // retryable error) instead of hanging the sign-in screen indefinitely.
  const authController = new AbortController();
  const authTimer = setTimeout(() => authController.abort(), 20_000);
  let res: Response;
  try {
    res = await fetch(`${baseUrl}/v1/auth/google`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        install_id: installId,
        id_token: idToken,
        pending_vault_registration: pendingVaultRegistration,
      }),
      signal: authController.signal,
    });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error("Sign-in timed out — check your connection and try again.");
    }
    throw err;
  } finally {
    clearTimeout(authTimer);
  }
  if (!res.ok) {
    let detail = "";
    try {
      const body = await res.json();
      detail = body?.error ?? "";
    } catch {
      // ignore parse failures; we still want to throw something useful
    }
    throw new Error(`Backend rejected sign-in (${res.status}): ${detail}`);
  }
  const body = (await res.json()) as AuthResponse;
  return applyAuthResponse(body);
}

// Backend response shape shared by /v1/auth/google and /v1/auth/apple.
type AuthResponse = {
  session_jwt: string;
  account_id?: string;
  default_vault_id?: string | null;
  user: SessionUser & { sub?: string };
};

// Shared post-/v1/auth-response handling for Google AND Apple sign-in: persist
// the session + user, run the once-per-install housekeeping (vault mirror seed,
// account_bound emission), reconcile the account phone, and register the mesh
// device key. Extracted so both providers land the user in an identical
// signed-in state. All housekeeping is best-effort — a transient failure must
// not deny the already-authenticated user their session.
async function applyAuthResponse(body: AuthResponse): Promise<SessionUser> {
  await SecureStore.setItemAsync(SESSION_KEY, body.session_jwt);
  await SecureStore.setItemAsync(USER_KEY, JSON.stringify(body.user ?? {}));

  try {
    await postSignInHousekeeping({
      accountId: body.account_id ?? null,
      defaultVaultId: body.default_vault_id ?? null,
      providerSub: body.user?.sub ?? null,
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

// Sign in with Apple (iOS only; App Store guideline 4.8). Gets an Apple identity
// token via the native module, posts it to /v1/auth/apple, and lands the user
// in the same signed-in state as Google via applyAuthResponse. Takes the same
// optional "different account on this phone?" prompt as signInWithGoogle —
// pass it anywhere an existing binding could be rebound (post-onboarding
// sign-in); onboarding may omit it (fresh install, nothing to rebind).
// expo-apple-authentication is imported lazily so this file stays safe to
// import on Android / Expo Go where the native module is absent. Requires
// expo-apple-authentication installed + a native rebuild + Sign in with Apple
// enabled in the Apple Developer account for bundle af.kaata.app.
export async function signInWithApple(
  onDifferentAccount?: (args: DifferentAccountPromptArgs) => Promise<DifferentAccountChoice>,
): Promise<SessionUser> {
  if (Platform.OS !== "ios") {
    throw new Error("Sign in with Apple is only available on iOS");
  }
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

  // One-shot-name insurance: if anything below fails (guard cancel, timeout,
  // 5xx, offline), a retry's signInAsync resolves WITHOUT a name — Apple
  // never re-sends it, so an unstashed name is lost forever and the account
  // stays nameless (the backend's non-empty-wins COALESCE can't restore what
  // never arrived). Stash it BEFORE anything can throw, keyed to the Apple
  // user id (credential.user == the token's sub) so a stale stash from Apple
  // ID A is never sent as the name of a different Apple ID B; fall back to a
  // sub-matching stash on retries, clear only after a confirmed 200.
  // NOTE: getDb() is called fresh at every use site here (never held in a
  // local) because the guard's "wipe" choice runs resetAllLocalData(), which
  // CLOSES the handle — a captured db would throw on every later call.
  const APPLE_NAME_STASH_KEY = "apple_pending_display_name";
  if (freshName) {
    await setAppMetaInTx(
      await getDb(),
      APPLE_NAME_STASH_KEY,
      JSON.stringify({ sub: credential.user, name: freshName }),
    );
  }

  // "Different account on this phone?" guard — same semantics as Google
  // (keep / wipe / cancel; throws SignInCancelledByUserError on cancel).
  // Apple has no picker to revoke on cancel, so no cleanup callback.
  await guardDifferentAccount(idToken, onDifferentAccount);

  let displayName = freshName;
  if (!displayName) {
    try {
      const raw = await getAppMetaInTx(await getDb(), APPLE_NAME_STASH_KEY);
      if (raw) {
        const stash = JSON.parse(raw) as { sub?: string; name?: string };
        if (stash.sub === credential.user && stash.name) displayName = stash.name;
      }
    } catch {
      // Malformed / legacy stash — treat as absent rather than fail sign-in.
    }
  }

  const installId = await ensureInstallId();
  const baseUrl = await getBackendUrl();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  let res: Response;
  try {
    res = await fetch(`${baseUrl}/v1/auth/apple`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        install_id: installId,
        identity_token: idToken,
        display_name: displayName || undefined,
      }),
      signal: controller.signal,
    });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error("Sign-in timed out — check your connection and try again.");
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    let detail = "";
    try {
      const b = await res.json();
      detail = b?.error ?? "";
    } catch {
      // ignore parse failures
    }
    throw new Error(`Backend rejected sign-in (${res.status}): ${detail}`);
  }
  const body = (await res.json()) as AuthResponse;
  // The name reached the backend — drop the one-shot stash.
  await setAppMetaInTx(await getDb(), APPLE_NAME_STASH_KEY, "");
  return applyAuthResponse(body);
}

// ---------- Phase 2 helpers ----------

// Loads the local default vault if it hasn't been registered with the server
// yet, so the sign-in round-trip can carry the registration block. Returns
// undefined when there's no local vault (mid-onboarding) or when the vault
// is already known to the server (registered_with_server_at IS NOT NULL).
async function loadPendingVaultRegistration(): Promise<
  { id: string; name: string; currency: string; created_at_ms: number } | undefined
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
  }>(
    `SELECT id, name, currency, created_at, registered_with_server_at
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
  if (providerSub) {
    await setAppMetaInTx(db, "account_google_sub", providerSub);
  }
  await setAppMetaInTx(db, "account_last_seen_at", String(now));

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
    // SEC H3: revoke any stale owner rows that belonged to a prior
    // Google account on this vault (the "Keep & Link" path leaves
    // the local SQLite intact, so a previously-bound account_id row
    // still sits in vault_members_mirror as a non-revoked owner —
    // and any "who is in this vault?" query would surface them as
    // a phantom co-owner). Scoped to this vault so we don't touch
    // other vaults the user genuinely co-owns under different
    // accounts (multi-account future). Idempotent: if the user
    // is signing back in to the SAME account, this UPDATE is a no-op.
    await db.runAsync(
      `UPDATE vault_members_mirror
          SET revoked_at = ?
        WHERE vault_id = ?
          AND account_id != ?
          AND revoked_at IS NULL`,
      now,
      vaultId,
      accountId,
    );
    // Seed (or refresh) the owner row in vault_members_mirror. Idempotent
    // via INSERT OR REPLACE on the (vault_id, account_id) PK.
    await db.runAsync(
      `INSERT OR REPLACE INTO vault_members_mirror
         (vault_id, account_id, role, accepted_at, revoked_at)
       VALUES (?, ?, 'owner', ?, NULL)`,
      vaultId,
      accountId,
      now,
    );
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
}

// ---------- account-level phone (BUG-1: phone survives reinstall) ----------

// Persist the shopkeeper's own phone at the ACCOUNT level on the server so it
// round-trips to a reinstalled device (the local users.phone_e164 is device-
// local and never event-sourced). Signed-in only + best-effort: a local-only
// user keeps the phone on-device and this no-ops; a network failure is swallowed
// (the value is already saved locally; a later edit / sign-in re-pushes it).
// Pass null/"" to clear the stored phone.
export async function updateAccountPhone(phone: string | null): Promise<void> {
  const jwt = await SecureStore.getItemAsync(SESSION_KEY);
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
  try {
    const db = await getDb();
    await db.runAsync(
      "UPDATE users SET phone_e164 = ?, updated_at = ? WHERE is_local_self = 1 AND phone_e164 IS NULL",
      phone,
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
}

// Permanently deletes the signed-in account server-side (DELETE /v1/account),
// then wipes ALL local state — the account, session, mesh key cache, and the
// on-device ledger. Play + Apple require an in-app deletion path.
//
// The server delete must succeed FIRST: if it fails (network down, 5xx) we
// throw and leave local data intact so the user can retry, rather than wiping
// their only ledger copy while the server copy survives. A 401 means the
// credential is already gone (a prior delete landed) — treat as success.
export async function deleteAccount(): Promise<void> {
  const jwt = await SecureStore.getItemAsync(SESSION_KEY);
  if (jwt) {
    const baseUrl = await getBackendUrl();
    const res = await fetch(`${baseUrl}/v1/account`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${jwt}` },
    });
    if (!res.ok && res.status !== 401) {
      throw new Error(`account_delete_failed:${res.status}`);
    }
  }
  // Server-side gone (or was never signed in) — drop the Google session, the
  // mesh key cache, the stored JWT, and every local table.
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
  await SecureStore.deleteItemAsync(SESSION_KEY);
  await SecureStore.deleteItemAsync(USER_KEY);
  setAccountIdCache(null);
  await resetAllLocalData();
}

// Dev-only: wipes the SecureStore session entries WITHOUT calling the
// backend signout endpoint. Used by the local-reset flow in Settings —
// the backend session will expire on its own, no need to round-trip.
export async function clearLocalSession(): Promise<void> {
  await SecureStore.deleteItemAsync(SESSION_KEY);
  await SecureStore.deleteItemAsync(USER_KEY);
  setAccountIdCache(null);
  try {
    const mesh = await import("./mesh/device-key");
    mesh.clearDeviceKey();
  } catch {
    /* */
  }
}

// Returns the cached session JWT, or null if signed out. Cheap; reads
// SecureStore which is a synchronous-feeling async call.
export async function getSessionJWT(): Promise<string | null> {
  return SecureStore.getItemAsync(SESSION_KEY);
}

// Silently overwrites the stored session JWT. Called from app-meta-context's
// applyCheckIn() when the backend opts to refresh — keeps actively-used
// installs on a rolling 30-day window forever without re-sign-in.
export async function rotateSessionJWT(newJwt: string): Promise<void> {
  if (!newJwt) return;
  await SecureStore.setItemAsync(SESSION_KEY, newJwt);
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

// Phase 4.1: decode the payload of a Google ID token (a standard JWT)
// without verifying its signature. Safe ONLY for reading display info to
// drive pre-backend UI (e.g. the "different account?" prompt). NEVER use
// these claims for authorization — the backend re-verifies the token
// against Google's JWKS and the configured `aud`.
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
