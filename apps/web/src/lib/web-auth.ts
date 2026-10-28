import { BACKEND_URL } from "../env";

export const WEB_SESSION_EVENT = "kaata:web-session-changed";
const SESSION_KEY = "kaata_web_session_v1";

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
    const payload = value.session_jwt.split(".")[1];
    if (!payload) return null;
    const normalized = payload.replaceAll("-", "+").replaceAll("_", "/");
    const claims = JSON.parse(
      atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=")),
    ) as {
      exp?: number;
      account_id?: string;
      install_id?: string;
    };
    if (
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
  if (memorySession !== undefined) {
    // Expiry is checked on every access, including tabs left open overnight.
    return memorySession && parseWebSession(JSON.stringify(memorySession));
  }
  try {
    memorySession = parseWebSession(window.sessionStorage.getItem(SESSION_KEY));
    if (!memorySession) window.sessionStorage.removeItem(SESSION_KEY);
  } catch {
    memorySession = null;
  }
  return memorySession;
}

function saveSession(session: WebSession | null) {
  memorySession = session;
  try {
    if (session) window.sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
    else window.sessionStorage.removeItem(SESSION_KEY);
  } catch {
    // Storage can be unavailable in private browsing. The session still works
    // in memory and simply asks for sign-in again after a page reload.
  }
  if (typeof window !== "undefined") window.dispatchEvent(new Event(WEB_SESSION_EVENT));
}

export function clearWebSession() {
  saveSession(null);
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

async function authenticate(path: string, body: Record<string, string>): Promise<WebSession> {
  // A fresh identity per login protects the phone and other browser tabs from
  // rebinding. In particular, duplicated tabs may have copied sessionStorage.
  const installID = crypto.randomUUID();
  const result = await request<SignInResult>(
    path,
    {
      method: "POST",
      body: JSON.stringify({ ...body, install_id: installID, platform: "web" }),
    },
    false,
  );
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

export function signInWithPassword(identifier: string, password: string) {
  return authenticate("/v1/auth/email/signin", { identifier: identifier.trim(), password });
}

export function signInWithGoogle(idToken: string) {
  return authenticate("/v1/auth/google", { id_token: idToken });
}

export function startEmailCode(mode: "signup" | "reset", email: string, lang: string) {
  return request<{ status: string; resend_after_s: number }>(
    `/v1/auth/email/${mode}/start`,
    {
      method: "POST",
      body: JSON.stringify({ email: email.trim(), lang }),
    },
    false,
  );
}

export function verifyEmailCode(
  mode: "signup" | "reset",
  email: string,
  code: string,
  password: string,
  lang: string,
) {
  return authenticate(`/v1/auth/email/${mode}/verify`, {
    email: email.trim(),
    code,
    [mode === "reset" ? "new_password" : "password"]: password,
    lang,
  });
}

export async function signOut(): Promise<void> {
  try {
    await webRequest("/v1/auth/signout", { method: "POST" });
  } catch (error) {
    // A revoked/expired credential is already signed out. Other errors leave
    // the session available to retry; never claim server revocation offline.
    if (!(error instanceof WebApiError && error.status === 401)) throw error;
  }
  clearWebSession();
}
