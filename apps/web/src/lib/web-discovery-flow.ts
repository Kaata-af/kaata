import { getWebSession, isSameWebSession, type WebSession } from "./web-auth";
import { getWebDiscovery, setWebDiscovery } from "./web-discovery";

type Dependencies = {
  current: () => WebSession | null;
  online: () => boolean;
  read: (signal: AbortSignal) => Promise<boolean>;
  write: (enabled: boolean, signal: AbortSignal) => Promise<boolean>;
};
export type WebDiscoveryState = {
  enabled: boolean | null;
  loading: boolean;
  saving: boolean;
  error: "load" | "save" | null;
};

/** Owns only account visibility, independently of the profile's unsaved draft. */
export function createWebDiscoveryFlow(session: WebSession, overrides: Partial<Dependencies> = {}) {
  const deps: Dependencies = {
    current: getWebSession,
    online: () => navigator.onLine,
    read: (signal) => getWebDiscovery(session, signal),
    write: (enabled, signal) => setWebDiscovery(session, enabled, signal),
    ...overrides,
  };
  let state: WebDiscoveryState = { enabled: null, loading: true, saving: false, error: null };
  let stopped = false;
  let version = 0;
  let request: AbortController | null = null;
  const listeners = new Set<() => void>();
  function publish(next: WebDiscoveryState) {
    state = next;
    for (const listener of listeners) listener();
  }
  function current(expected: number, controller: AbortController) {
    return (
      !stopped &&
      version === expected &&
      !controller.signal.aborted &&
      isSameWebSession(deps.current(), session)
    );
  }
  async function load() {
    if (stopped || request || !deps.online() || !isSameWebSession(deps.current(), session)) return;
    const controller = new AbortController();
    request = controller;
    const expected = ++version;
    publish({ enabled: null, loading: true, saving: false, error: null });
    try {
      const enabled = await deps.read(controller.signal);
      if (current(expected, controller))
        publish({ enabled, loading: false, saving: false, error: null });
    } catch {
      if (current(expected, controller))
        publish({ enabled: null, loading: false, saving: false, error: "load" });
    } finally {
      if (request === controller) request = null;
    }
  }
  async function save(enabled: boolean) {
    if (
      stopped ||
      request ||
      !deps.online() ||
      state.enabled === null ||
      state.enabled === enabled ||
      !isSameWebSession(deps.current(), session)
    )
      return;
    const controller = new AbortController();
    request = controller;
    const expected = ++version;
    publish({ ...state, saving: true, error: null });
    try {
      const saved = await deps.write(enabled, controller.signal);
      if (current(expected, controller))
        publish({ enabled: saved, loading: false, saving: false, error: null });
    } catch {
      // The server may have saved it before the response was lost. Do not show
      // the previous value as confirmed and never replay this mutation.
      if (current(expected, controller))
        publish({ enabled: null, loading: false, saving: false, error: "save" });
    } finally {
      if (request === controller) request = null;
    }
  }
  return {
    getState: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    start() {
      stopped = false;
      if (deps.online()) void load();
      else publish({ enabled: null, loading: false, saving: false, error: null });
    },
    stop() {
      stopped = true;
      ++version;
      request?.abort();
      request = null;
    },
    recover() {
      if (state.enabled === null || state.error) void load();
    },
    load,
    save,
  };
}
