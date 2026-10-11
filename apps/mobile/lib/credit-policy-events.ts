const listeners = new Set<(vaultId: string) => void>();
export function onCreditPoliciesChanged(fn: (vaultId: string) => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
export function emitCreditPoliciesChanged(vaultId: string): void {
  for (const fn of listeners) fn(vaultId);
}
