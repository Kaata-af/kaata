import Constants from "expo-constants";
import * as SecureStore from "expo-secure-store";
import { GOOGLE_WEB_CLIENT_ID } from "../constants/env";
import { getBackendUrl } from "./api";
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
};

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
export async function signInWithGoogle(): Promise<SessionUser> {
  const lib = loadGoogleSignin();
  if (!lib) {
    throw new Error(
      "Google sign-in needs a dev client or production APK — it can't run in Expo Go.",
    );
  }

  await lib.GoogleSignin.hasPlayServices({ showPlayServicesUpdateDialog: true });
  const result = await lib.GoogleSignin.signIn();

  // The library wraps the actual user payload under `data`. Older versions
  // returned the user inline; we read defensively.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const data: any = (result as any).data ?? result;
  const idToken: string | null | undefined = data.idToken;
  if (!idToken) {
    throw new Error("Google returned no ID token; check OAuth client config.");
  }

  const installId = await ensureInstallId();
  const baseUrl = await getBackendUrl();

  const res = await fetch(`${baseUrl}/v1/auth/google`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ install_id: installId, id_token: idToken }),
  });
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
  const body = (await res.json()) as { session_jwt: string; user: SessionUser };

  await SecureStore.setItemAsync(SESSION_KEY, body.session_jwt);
  await SecureStore.setItemAsync(USER_KEY, JSON.stringify(body.user ?? {}));
  return body.user ?? {};
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
}

// Dev-only: wipes the SecureStore session entries WITHOUT calling the
// backend signout endpoint. Used by the local-reset flow in Settings —
// the backend session will expire on its own, no need to round-trip.
export async function clearLocalSession(): Promise<void> {
  await SecureStore.deleteItemAsync(SESSION_KEY);
  await SecureStore.deleteItemAsync(USER_KEY);
}

// Returns the cached session JWT, or null if signed out. Cheap; reads
// SecureStore which is a synchronous-feeling async call.
export async function getSessionJWT(): Promise<string | null> {
  return SecureStore.getItemAsync(SESSION_KEY);
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

// Helper to recognize the "user cancelled the Google picker" case so
// callers can swallow it silently instead of showing an error toast.
// Uses the lazy-loaded module's isErrorWithCode + statusCodes when
// available; falls back to a string check in Expo Go.
export function isCancellation(err: unknown): boolean {
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
