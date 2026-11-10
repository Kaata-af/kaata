export type PeopleSearchChange = { accountId: string; vaultId?: string };

const listeners = new Set<(change: PeopleSearchChange) => void>();

/** Explicit account/contact mutations invalidate only matching directory results. */
export function onPeopleSearchChanged(listener: (change: PeopleSearchChange) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function notifyPeopleSearchChanged(change: PeopleSearchChange): void {
  for (const listener of [...listeners]) {
    try {
      listener(change);
    } catch {
      // A directory observer must never turn a saved mutation into a failure.
    }
  }
}
