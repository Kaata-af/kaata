import {
  createContext,
  useContext,
  useLayoutEffect,
  useRef,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import type { ProfileSettingsProps } from "../components/ProfileSettingsSheet";

type Source = {
  owner: object;
  ready: boolean;
  props: ProfileSettingsProps;
  onPresent?: () => void;
};

/** A mounted Home owns its live actions. Routes never keep a serialized copy. */
export function createProfileSettingsStore() {
  let source: Source | null = null;
  const listeners = new Set<() => void>();
  return {
    getSnapshot: () => source,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    publish(owner: object, ready: boolean, props: ProfileSettingsProps, onPresent?: () => void) {
      source = { owner, ready, props, onPresent };
      listeners.forEach((listener) => listener());
    },
    clear(owner: object) {
      if (source?.owner !== owner) return;
      source = null;
      listeners.forEach((listener) => listener());
    },
  };
}

const Context = createContext<ReturnType<typeof createProfileSettingsStore> | null>(null);

export function ProfileSettingsProvider({ children }: { children: ReactNode }) {
  const store = useRef<ReturnType<typeof createProfileSettingsStore> | null>(null);
  if (!store.current) store.current = createProfileSettingsStore();
  return <Context.Provider value={store.current}>{children}</Context.Provider>;
}

export function useProfileSettingsStore() {
  const store = useContext(Context);
  if (!store) throw new Error("ProfileSettingsProvider is missing");
  return store;
}

export function useProfileSettingsSource() {
  const store = useProfileSettingsStore();
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}

export function ProfileSettingsSource({
  ready,
  onPresent,
  ...props
}: ProfileSettingsProps & { ready: boolean; onPresent?: () => void }) {
  const store = useProfileSettingsStore();
  const owner = useRef({}).current;
  // Publishing does not update Home or the provider, avoiding render feedback.
  useLayoutEffect(() => {
    store.publish(owner, ready, props, onPresent);
  });
  useLayoutEffect(() => () => store.clear(owner), [store, owner]);
  return null;
}
