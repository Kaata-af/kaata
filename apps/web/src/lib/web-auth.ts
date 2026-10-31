import { BACKEND_URL } from "../env";
import {
  readWebBrowserValue,
  removeLegacyWebTabValue,
  writeWebBrowserValue,
} from "./web-browser-storage";

export const WEB_SESSION_EVENT = "kaata:web-session-changed";
const SESSION_KEY = "kaata_web_session_v2";
const LEGACY_SESSION_KEY = "kaata_web_session_v1";

export type WebSession = {
  session_jwt: string;
  account_id: string;
  default_vault_id: string | null;
  install_id: string;
  deletion_cancelled?: boolean;
  user: {
    name?: string;
    email?: string;
    username?: string;
    phone?: string;
    has_password: boolean;
  };
};

type SignInResult = Omit<WebSession, "install_id">;
let memorySession: WebSession | null | undefined;
let authenticationGeneration = 0;
const observedWindows = new WeakSet<Window>();

type WebSessionClaims = {
  exp?: number;
  account_id?: string;
  install_id?: string;
  provider?: string;
  provider_sub?: string;
  ep?: number;
};

function sessionClaims(token: string): WebSessionClaims | null {
  try {
    const payload = token.split(".")[1];
    if (!payload) return null;
    const normalized = payload.replaceAll("-", "+").replaceAll("_", "/");
    const claims: unknown = JSON.parse(
      atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=")),
    );
    return claims && typeof claims === "object" ? (claims as WebSessionClaims) : null;
  } catch {
    return null;
  }
}

// A rolling renewal changes only token dates/signature. A new sign-in has a
// new browser install; credential revocation/rebinding also changes its epoch.
export function isSameWebSession(
  current: WebSession | null | undefined,
  expected: WebSession | null | undefined,
): boolean {
  if (
    !current ||
    !expected ||
    current.account_id !== expected.account_id ||
    current.install_id !== expected.install_id
  )
    return false;
  if (current.session_jwt === expected.session_jwt) return true;
  const a = sessionClaims(current.session_jwt);
  const b = sessionClaims(expected.session_jwt);
  return !!(
    a &&
    b &&
    a.account_id === current.account_id &&
    b.account_id === expected.account_id &&
    a.install_id === current.install_id &&
    b.install_id === expected.install_id &&
    a.provider === b.provider &&
    a.provider_sub === b.provider_sub &&
    (a.ep ?? 0) === (b.ep ?? 0)
  );
}

// This only checks the local cache's shape/expiry. Every request is authorized
// by the server, which verifies the signature and the current credential epoch.
export function parseWebSession(raw: string | null, now = Date.now()): WebSession | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as WebSession;
    if (
      !value ||
      typeof value.session_jwt !== "string" ||
      typeof value.account_id !== "string" ||
      !value.account_id ||
      typeof value.install_id !== "string" ||
      !value.install_id ||
      !value.user ||
      typeof value.user !== "object" ||
      typeof value.user.has_password !== "boolean" ||
      ["name", "email", "username", "phone"].some((key) => {
        const field = (value.user as Record<string, unknown>)[key];
        return field !== undefined && typeof field !== "string";
      }) ||
      !(value.default_vault_id === null || typeof value.default_vault_id === "string")
    )
      return null;
    const claims = sessionClaims(value.session_jwt);
    if (
      !claims ||
      typeof claims.exp !== "number" ||
      !Number.isFinite(claims.exp) ||
      claims.exp * 1000 <= now ||
      claims.account_id !== value.account_id ||
      claims.install_id !== value.install_id
    )
      return null;
    return value;
  } catch {
    return null;
  }
}

export function getWebSession(): WebSession | null {
  observeSessionChanges();
  try {
    const raw = readWebBrowserValue(SESSION_KEY);
    // The explicit "null" tombstone prevents another tab's older, tab-only
    // session from restoring a credential after a browser-wide sign-out.
    if (raw === null) {
      const legacy = parseWebSession(window.sessionStorage.getItem(LEGACY_SESSION_KEY));
      if (legacy) {
        // Preserve the registered device key and exact pending event IDs when
        // upgrading an already signed-in tab to durable browser storage.
        memorySession = legacy;
        for (const key of ["kaata_web_signing_v1", "kaata_web_pending_v1"]) {
          const previous = window.sessionStorage.getItem(key);
          if (!previous) continue;
          let value: { installID?: string; accountID?: string } | null;
          try {
            value = JSON.parse(previous);
          } catch {
            continue;
          }
          if (
            value?.installID === legacy.install_id &&
            (key !== "kaata_web_pending_v1" || value.accountID === legacy.account_id)
          )
            writeWebBrowserValue(key, previous);
        }
        writeWebBrowserValue(SESSION_KEY, JSON.stringify(legacy));
      } else memorySession = null;
    } else memorySession = parseWebSession(raw);
    window.sessionStorage.removeItem(LEGACY_SESSION_KEY);
    for (const key of ["kaata_web_signing_v1", "kaata_web_pending_v1"])
      removeLegacyWebTabValue(key);
  } catch {
    // A browser that disables all storage can still use its current in-memory
    // session. Expiry remains enforced even when a tab stays open overnight.
  }
  return memorySession ? parseWebSession(JSON.stringify(memorySession)) : null;
}

function observeSessionChanges() {
  if (
    typeof window === "undefined" ||
    observedWindows.has(window) ||
    typeof window.addEventListener !== "function"
  )
    return;
  observedWindows.add(window);
  window.addEventListener("storage", (event) => {
    if (event.key !== SESSION_KEY && event.key !== null) return;
    cancelPendingWebSignIn();
    getWebSession();
    window.dispatchEvent(new Event(WEB_SESSION_EVENT));
  });
}

function saveSession(session: WebSession | null) {
  memorySession = session;
  try {
    writeWebBrowserValue(SESSION_KEY, JSON.stringify(session));
    window.sessionStorage.removeItem(LEGACY_SESSION_KEY);
    for (const key of ["kaata_web_signing_v1", "kaata_web_pending_v1"])
      removeLegacyWebTabValue(key);
  } catch {
    // Storage can be unavailable in private browsing. The session still works
    // in memory and simply asks for sign-in again after a page reload.
  }
  if (typeof window !== "undefined") window.dispatchEvent(new Event(WEB_SESSION_EVENT));
}

function storedSessionValue(): string | null | undefined {
  try {
    return readWebBrowserValue(SESSION_KEY);
  } catch {
    return undefined;
  }
}

export function refreshWebSession(expected: WebSession, token: string): boolean {
  const current = getWebSession();
  // Neither a slow heartbeat nor a different tab may revive a signed-out
  // session or replace a newer sign-in/renewal.
  if (!current || current.session_jwt !== expected.session_jwt) return false;
  const renewed = parseWebSession(JSON.stringify({ ...current, session_jwt: token }));
  if (!renewed || !isSameWebSession(renewed, current)) return false;
  const oldExpiry = sessionClaims(current.session_jwt)?.exp;
  const newExpiry = sessionClaims(token)?.exp;
  if (typeof oldExpiry !== "number" || typeof newExpiry !== "number" || newExpiry <= oldExpiry)
    return false;
  saveSession(renewed);
  return true;
}

export function clearWebSession() {
  cancelPendingWebSignIn();
  saveSession(null);
}

export function cancelPendingWebSignIn() {
  authenticationGeneration++;
}

export class WebApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public code: string,
    public retryAfterSeconds?: number,
    public reason?: string,
  ) {
    super(message);
    this.name = "WebApiError";
  }
}

async function request<T>(path: string, init: RequestInit, authenticated: boolean): Promise<T> {
  // Keep bearer credentials away from arbitrary URLs, including protocol-relative URLs.
  if (!path.startsWith("/v1/") || path.includes("\\")) throw new Error("Invalid API path");
  const session = authenticated ? getWebSession() : null;
  if (authenticated && !session) {
    clearWebSession();
    throw new WebApiError("Your session has ended. Sign in again.", 401, "session_expired");
  }
  const controller = new AbortController();
  const abort = () => controller.abort(init.signal?.reason);
  if (init.signal?.aborted) abort();
  else init.signal?.addEventListener("abort", abort, { once: true });
  const timeout = setTimeout(() => controller.abort(), 25_000);
  try {
    const headers = new Headers(init.headers);
    headers.set("Accept", "application/json");
    if (init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
    if (session) headers.set("Authorization", `Bearer ${session.session_jwt}`);
    const response = await fetch(`${BACKEND_URL.replace(/\/$/, "")}${path}`, {
      ...init,
      headers,
      signal: controller.signal,
      credentials: "omit",
      cache: "no-store",
      redirect: "error",
    });
    const body = await response.json().catch(() => null);
    if (!response.ok) {
      // An old request must never clear a newer sign-in. Wrong public login
      // credentials and authorization refusals (403) also preserve the session.
      if (
        response.status === 401 &&
        session &&
        getWebSession()?.session_jwt === session.session_jwt
      ) {
        clearWebSession();
      }
      const retry = Number(body?.retry_after_s ?? response.headers.get("Retry-After"));
      throw new WebApiError(
        typeof body?.error === "string" ? body.error : "The request could not be completed.",
        response.status,
        typeof body?.error_code === "string"
          ? body.error_code
          : response.status === 401
            ? "session_expired"
            : "request_failed",
        Number.isFinite(retry) && retry > 0 ? retry : undefined,
        typeof body?.reason === "string" ? body.reason : undefined,
      );
    }
    if (body === null && response.status !== 204) {
      throw new WebApiError(
        "The server returned an unreadable response. Try again.",
        502,
        "invalid_response",
      );
    }
    return body as T;
  } catch (error) {
    if (error instanceof WebApiError || init.signal?.aborted) throw error;
    throw new WebApiError("Cannot reach Kaata. Check your connection and try again.", 0, "network");
  } finally {
    clearTimeout(timeout);
    init.signal?.removeEventListener("abort", abort);
  }
}

export function webRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  return request<T>(path, init, true);
}

export type WebAuthProviders = {
  google: { client_id: string } | null;
  apple: { start_url: string } | null;
};

export function createWebAuthNonce(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

export function validateWebAppleStartURL(value: string): string {
  try {
    const url = new URL(value);
    const backend = new URL(BACKEND_URL);
    if (
      url.origin !== backend.origin ||
      url.pathname !== "/v1/auth/apple/browser/start" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      (url.protocol !== "https:" &&
        !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))
    )
      throw new Error("Invalid Apple endpoint");
    return url.href;
  } catch {
    throw new WebApiError(
      "Apple sign-in is unavailable. Try again later.",
      502,
      "invalid_response",
    );
  }
}

export async function loadWebAuthProviders(signal?: AbortSignal): Promise<WebAuthProviders> {
  const result = await request<unknown>("/v1/auth/providers", { signal }, false);
  if (!result || typeof result !== "object") {
    throw new WebApiError("Sign-in options could not be loaded.", 502, "invalid_response");
  }
  const { google, apple } = result as Record<string, unknown>;
  const clientID =
    google && typeof google === "object"
      ? (google as Record<string, unknown>).client_id
      : undefined;
  const startURL =
    apple && typeof apple === "object" ? (apple as Record<string, unknown>).start_url : undefined;
  if (
    !(
      google === null ||
      (typeof clientID === "string" &&
        clientID.length <= 255 &&
        /^[\w.-]+\.apps\.googleusercontent\.com$/.test(clientID))
    ) ||
    !(apple === null || typeof startURL === "string")
  ) {
    throw new WebApiError("Sign-in options could not be loaded.", 502, "invalid_response");
  }
  return {
    google: google === null ? null : { client_id: clientID as string },
    apple: apple === null ? null : { start_url: validateWebAppleStartURL(startURL as string) },
  };
}

async function authenticate(path: string, body: Record<string, string>): Promise<WebSession> {
  observeSessionChanges();
  getWebSession();
  const previousSession = storedSessionValue();
  const generation = ++authenticationGeneration;
  // A fresh identity per explicit login protects the phone and any previous
  // browser credential from rebinding. Reopening shares the saved identity.
  const installID = crypto.randomUUID();
  const result = await request<SignInResult>(
    path,
    {
      method: "POST",
      body: JSON.stringify({ ...body, install_id: installID, platform: "web" }),
    },
    false,
  );
  if (generation !== authenticationGeneration || storedSessionValue() !== previousSession) {
    throw new WebApiError("This sign-in attempt has ended.", 409, "signin_cancelled");
  }
  const session = parseWebSession(JSON.stringify({ ...result, install_id: installID }));
  if (!session)
    throw new WebApiError(
      "The sign-in response was incomplete. Try again.",
      502,
      "invalid_response",
    );
  saveSession(session);
  return session;
}

function validateProviderNonce(nonce: string) {
  if (!/^[A-Za-z0-9_-]{32,128}$/.test(nonce)) {
    throw new WebApiError("Restart sign-in and try again.", 400, "invalid_nonce");
  }
}

export async function signInWithGoogle(idToken: string, nonce: string) {
  validateProviderNonce(nonce);
  return authenticate("/v1/auth/google", { id_token: idToken, nonce });
}

export async function signInWithApple(identityToken: string, displayName: string, nonce: string) {
  validateProviderNonce(nonce);
  return authenticate("/v1/auth/apple", {
    identity_token: identityToken,
    display_name: displayName,
    nonce,
  });
}

export async function signOut(): Promise<void> {
  const session = getWebSession();
  try {
    await webRequest("/v1/auth/signout", { method: "POST" });
  } catch (error) {
    // A revoked/expired credential is already signed out. Other errors leave
    // the session available to retry; never claim server revocation offline.
    if (!(error instanceof WebApiError && error.status === 401)) throw error;
  }
  if (isSameWebSession(getWebSession(), session)) clearWebSession();
}
