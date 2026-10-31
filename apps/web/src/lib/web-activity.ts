import {
  getWebSession,
  refreshWebSession,
  WEB_SESSION_EVENT,
  webRequest,
  type WebSession,
} from "./web-auth";

const INTERVAL_MS = 60_000;

export type WebActivityDependencies = {
  now: () => number;
  visible: () => boolean;
  online: () => boolean;
  getSession: () => WebSession | null;
  request: (locale: string, signal: AbortSignal) => Promise<unknown>;
  refreshSession: (expected: WebSession, token: string) => boolean;
  subscribe: (changed: () => void) => () => void;
  setTimer: (callback: () => void, delay: number) => unknown;
  clearTimer: (timer: unknown) => void;
};

/** Presence follows the visible workspace, independently of browser auth IDs. */
export function createWebActivity({
  session,
  locale,
  dependencies = {},
}: {
  session: WebSession;
  locale: () => string;
  dependencies?: Partial<WebActivityDependencies>;
}): { stop(): void } {
  const deps: WebActivityDependencies = {
    now: () => performance.now(),
    visible: () => document.visibilityState === "visible",
    online: () => navigator.onLine,
    getSession: getWebSession,
    request: (language, signal) =>
      webRequest("/v1/account/web-activity", {
        method: "POST",
        body: JSON.stringify({ locale: language }),
        signal,
      }),
    refreshSession: refreshWebSession,
    subscribe: (changed) => {
      document.addEventListener("visibilitychange", changed);
      window.addEventListener("online", changed);
      window.addEventListener("offline", changed);
      window.addEventListener(WEB_SESSION_EVENT, changed);
      return () => {
        document.removeEventListener("visibilitychange", changed);
        window.removeEventListener("online", changed);
        window.removeEventListener("offline", changed);
        window.removeEventListener(WEB_SESSION_EVENT, changed);
      };
    },
    setTimer: (callback, delay) => window.setTimeout(callback, delay),
    clearTimer: (timer) => window.clearTimeout(timer as number),
    ...dependencies,
  };
  const { account_id: account, install_id: install, session_jwt: token } = session;
  let stopped = false;
  let lastStarted: number | null = null;
  let timer: unknown;
  let running: AbortController | undefined;
  let unsubscribe: (() => void) | undefined;

  function stop() {
    if (stopped) return;
    stopped = true;
    if (timer !== undefined) deps.clearTimer(timer);
    timer = undefined;
    running?.abort();
    unsubscribe?.();
    unsubscribe = undefined;
  }

  function current() {
    if (stopped) return false;
    const value = deps.getSession();
    if (
      !value ||
      value.account_id !== account ||
      value.install_id !== install ||
      value.session_jwt !== token
    ) {
      stop();
      return false;
    }
    return true;
  }

  function schedule() {
    if (timer !== undefined) deps.clearTimer(timer);
    timer = undefined;
    if (!current() || !deps.visible() || !deps.online() || running) return;
    const delay = lastStarted === null ? 0 : Math.max(0, lastStarted + INTERVAL_MS - deps.now());
    timer = deps.setTimer(() => {
      timer = undefined;
      void send();
    }, delay);
  }

  async function send() {
    if (!current() || !deps.visible() || !deps.online() || running) return;
    const expected = deps.getSession();
    if (!expected) return;
    const controller = new AbortController();
    running = controller;
    lastStarted = deps.now();
    try {
      const result = await deps.request(locale(), controller.signal);
      if (
        current() &&
        result &&
        typeof result === "object" &&
        "session_jwt_refresh" in result &&
        typeof result.session_jwt_refresh === "string"
      ) {
        // A slow heartbeat must not revive a signed-out session or overwrite
        // another login. The auth layer validates the exact captured token.
        deps.refreshSession(expected, result.session_jwt_refresh);
      }
    } catch {
      // Presence is best-effort. It never blocks or interrupts ledger work.
    } finally {
      running = undefined;
      schedule();
    }
  }

  unsubscribe = deps.subscribe(schedule);
  schedule();
  return { stop };
}
