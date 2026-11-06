import {
  getWebSession,
  isSameWebSession,
  updateWebSessionProfile,
  type WebSession,
} from "./web-auth";
import { getWebProfile, saveWebProfile, type WebProfile } from "./web-profile";

type ProfileValues = { name: string; phone: string };
type Dependencies = {
  read: (signal: AbortSignal) => Promise<WebProfile>;
  write: (values: ProfileValues, signal: AbortSignal) => Promise<WebProfile>;
  current: () => WebSession | null;
  apply: (session: WebSession, profile: WebProfile) => boolean;
};
export type WebProfileState = {
  profile: WebProfile | null;
  loading: boolean;
  failed: boolean;
  admitted: boolean;
};

// Setup and the later profile editor share one request owner. Admission lasts
// for this account session, so refreshing or editing a profile cannot unmount
// the ledger and discard a customer's in-progress entry.
export function createWebProfileFlow(
  session: WebSession,
  deps: Dependencies = {
    read: getWebProfile,
    write: saveWebProfile,
    current: getWebSession,
    apply: updateWebSessionProfile,
  },
) {
  let state: WebProfileState = { profile: null, loading: true, failed: false, admitted: false };
  const listeners = new Set<() => void>();
  let version = 0;
  let stopped = false;
  let reading: AbortController | null = null;
  let writing: AbortController | null = null;

  function publish(next: WebProfileState) {
    state = next;
    for (const listener of listeners) listener();
  }
  function current(expectedVersion: number, controller: AbortController) {
    return (
      !stopped &&
      !controller.signal.aborted &&
      version === expectedVersion &&
      isSameWebSession(deps.current(), session)
    );
  }
  function accept(profile: WebProfile) {
    if (!deps.apply(session, profile)) return false;
    publish({
      profile,
      loading: false,
      failed: false,
      admitted: state.admitted || !profile.needs_setup,
    });
    return true;
  }
  async function load() {
    if (stopped || writing || !isSameWebSession(deps.current(), session)) return;
    reading?.abort();
    const controller = new AbortController();
    reading = controller;
    const expectedVersion = ++version;
    publish({ ...state, loading: true, failed: false });
    try {
      const profile = await deps.read(controller.signal);
      if (current(expectedVersion, controller)) accept(profile);
    } catch {
      if (current(expectedVersion, controller)) publish({ ...state, loading: false, failed: true });
    } finally {
      if (reading === controller) reading = null;
    }
  }
  async function save(values: ProfileValues) {
    if (stopped || !isSameWebSession(deps.current(), session)) return null;
    reading?.abort();
    writing?.abort();
    const controller = new AbortController();
    writing = controller;
    const expectedVersion = ++version;
    try {
      const profile = await deps.write(values, controller.signal);
      return current(expectedVersion, controller) && accept(profile) ? profile : null;
    } finally {
      if (writing === controller) writing = null;
    }
  }
  return {
    session,
    getState: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    start() {
      stopped = false;
      void load();
    },
    stop() {
      stopped = true;
      ++version;
      reading?.abort();
      writing?.abort();
      reading = writing = null;
    },
    load,
    save,
    recover() {
      if (!reading && !writing && (!state.profile || state.failed)) void load();
    },
  };
}

export type WebProfileFlow = ReturnType<typeof createWebProfileFlow>;
