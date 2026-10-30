import {
  createWebAuthNonce,
  signInWithApple,
  validateWebAppleStartURL,
  WebApiError,
  type WebSession,
} from "./web-auth";

const PENDING_KEY = "kaata_web_apple_pending_v1";
const NAME_KEY = "kaata_web_apple_name_v1";
const MAX_AGE = 10 * 60_000;
const VALID_RANDOM = /^[A-Za-z0-9_-]{32,128}$/;

export type WebAppleCallback =
  | { status: "none" | "cancelled" }
  | { status: "error"; code: string }
  | { status: "ready"; complete: () => Promise<WebSession> };

type Pending = { state: string; nonce: string; createdAt: number };
type NameCache = { subject: string; name: string; createdAt: number };

type AppleEnvironment = {
  storage: () => Pick<Storage, "getItem" | "setItem" | "removeItem">;
  url: () => string;
  replaceURL: (url: string) => void;
  navigate: (url: string) => void;
  now: () => number;
  random: () => string;
  signIn: typeof signInWithApple;
};

function validAge(createdAt: unknown, now: number): createdAt is number {
  return (
    typeof createdAt === "number" &&
    Number.isFinite(createdAt) &&
    createdAt <= now &&
    now - createdAt <= MAX_AGE
  );
}

function appleSubject(token: string): string | null {
  if (token.length > 20_000 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token))
    return null;
  try {
    const payload = token.split(".")[1].replaceAll("-", "+").replaceAll("_", "/");
    const claims = JSON.parse(atob(payload.padEnd(Math.ceil(payload.length / 4) * 4, "=")));
    return typeof claims?.sub === "string" && claims.sub.length > 0 && claims.sub.length <= 255
      ? claims.sub
      : null;
  } catch {
    return null;
  }
}

function appleName(raw: string | null): string {
  if (raw === null) return "";
  if (raw.length > 4_000) throw new Error("Invalid Apple name");
  const user = JSON.parse(raw);
  if (!user || typeof user !== "object" || Array.isArray(user))
    throw new Error("Invalid Apple name");
  if (user.name === undefined) return "";
  if (!user.name || typeof user.name !== "object" || Array.isArray(user.name))
    throw new Error("Invalid Apple name");
  const parts = [user.name.firstName, user.name.lastName];
  if (parts.some((part) => part !== undefined && typeof part !== "string"))
    throw new Error("Invalid Apple name");
  return parts
    .filter(Boolean)
    .join(" ")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
}

// An isolated flow also makes the redirect lifecycle testable without a browser
// or real provider credentials. Production uses the single page instance below.
export function createWebAppleFlow(environment: AppleEnvironment) {
  let cached: WebAppleCallback | undefined;
  let generation = 0;

  function start(startURL: string) {
    const url = new URL(validateWebAppleStartURL(startURL));
    const current = new URL(environment.url());
    if (
      current.protocol !== "https:" &&
      !(
        current.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(current.hostname)
      )
    ) {
      throw new WebApiError(
        "Apple sign-in is unavailable for this address.",
        400,
        "apple_callback_invalid",
      );
    }
    const pending: Pending = {
      state: environment.random(),
      nonce: environment.random(),
      createdAt: environment.now(),
    };
    if (!VALID_RANDOM.test(pending.state) || !VALID_RANDOM.test(pending.nonce))
      throw new Error("Secure sign-in is unavailable");
    try {
      environment.storage().setItem(PENDING_KEY, JSON.stringify(pending));
      // Some private-browser modes silently decline storage writes.
      if (environment.storage().getItem(PENDING_KEY) !== JSON.stringify(pending))
        throw new Error("Storage unavailable");
    } catch {
      throw new WebApiError(
        "Allow session storage to continue with Apple.",
        0,
        "apple_storage_unavailable",
      );
    }
    generation++;
    cached = undefined;
    url.searchParams.set("state", pending.state);
    url.searchParams.set("nonce", pending.nonce);
    // The server allowlists this origin and binds it into signed state. Return
    // to the initiating origin so its session storage remains available.
    url.searchParams.set("return_origin", current.origin);
    environment.navigate(url.href);
  }

  function consume(): WebAppleCallback {
    if (cached) return cached;
    const url = new URL(environment.url());
    const params = new URLSearchParams(url.hash.slice(1));
    if (!params.has("kaata_apple") && !params.has("identity_token"))
      return (cached = { status: "none" });

    // Remove credentials synchronously, before any SDK, fetch, or UI effect.
    environment.replaceURL(`${url.pathname}${url.search}`);
    const invalid = (code = "apple_callback_invalid"): WebAppleCallback =>
      (cached = { status: "error", code });
    let raw: string | null;
    try {
      raw = environment.storage().getItem(PENDING_KEY);
      environment.storage().removeItem(PENDING_KEY);
    } catch {
      return invalid("apple_storage_unavailable");
    }
    let pending: Pending;
    try {
      pending = JSON.parse(raw ?? "null") as Pending;
    } catch {
      return invalid();
    }
    if (
      url.hash.length > 32_000 ||
      [...params.keys()].some(
        (key) =>
          !["kaata_apple", "state", "identity_token", "user", "error"].includes(key) ||
          params.getAll(key).length !== 1,
      ) ||
      params.get("kaata_apple") !== "1" ||
      !pending ||
      typeof pending.state !== "string" ||
      typeof pending.nonce !== "string" ||
      !VALID_RANDOM.test(pending.state) ||
      !VALID_RANDOM.test(pending.nonce) ||
      params.get("state") !== pending.state
    )
      return invalid();
    if (!validAge(pending.createdAt, environment.now())) return invalid("apple_callback_expired");
    if (params.has("error")) {
      if (params.has("identity_token") || params.has("user")) return invalid();
      return (cached =
        params.get("error") === "user_cancelled_authorize"
          ? { status: "cancelled" }
          : { status: "error", code: "apple_sign_in_failed" });
    }
    let token = params.get("identity_token") ?? "";
    const subject = appleSubject(token);
    if (!subject) return invalid();
    let name: string;
    try {
      name = appleName(params.get("user"));
    } catch {
      return invalid();
    }
    // Apple sends a name only on initial consent. Keep that non-secret name
    // briefly across a failed exchange, bound to the same subject. This parsed
    // subject is only a display-name cache key; the API verifies identity.
    try {
      const previous = JSON.parse(
        environment.storage().getItem(NAME_KEY) ?? "null",
      ) as NameCache | null;
      if (
        !name &&
        previous?.subject === subject &&
        typeof previous.name === "string" &&
        validAge(previous.createdAt, environment.now())
      )
        name = previous.name.slice(0, 200);
      if (name)
        environment
          .storage()
          .setItem(NAME_KEY, JSON.stringify({ subject, name, createdAt: environment.now() }));
      else environment.storage().removeItem(NAME_KEY);
    } catch {
      // Optional name retention must not prevent identity verification.
    }
    const attempt = generation;
    let completion: Promise<WebSession> | undefined;
    const result: WebAppleCallback = {
      status: "ready",
      complete: () => {
        if (!completion)
          completion = Promise.resolve()
            .then(() => {
              if (attempt !== generation)
                throw new WebApiError("Restart Apple sign-in.", 400, "apple_callback_invalid");
              return environment.signIn(token, name, pending.nonce);
            })
            .then((session) => {
              try {
                environment.storage().removeItem(NAME_KEY);
              } catch {
                /* Optional cache. */
              }
              return session;
            })
            .finally(() => {
              token = "";
              // Existing result objects retain their one completion promise, but a
              // later mount after sign-out must never repeat the consumed login.
              if (cached === result) cached = { status: "none" };
            });
        return completion;
      },
    };
    return (cached = result);
  }

  return {
    start,
    consume,
    dismiss: () => {
      generation++;
      cached = { status: "none" };
    },
  };
}

const browserFlow = createWebAppleFlow({
  storage: () => window.sessionStorage,
  url: () => window.location.href,
  replaceURL: (url) => window.history.replaceState(window.history.state, "", url),
  navigate: (url) => window.location.assign(url),
  now: Date.now,
  random: createWebAuthNonce,
  signIn: signInWithApple,
});

export const startWebAppleSignIn = browserFlow.start;
export const consumeWebAppleCallback = browserFlow.consume;
export const dismissWebAppleCallback = browserFlow.dismiss;
