import type { ReactNode } from "react";

export type NativeSearchSession = {
  id: string;
  ownerKey: string;
  contextKey: string;
  content: ReactNode;
  busy: boolean;
  closing: boolean;
  onDismiss: () => void;
  canDismiss: () => boolean;
};

// Only mounted owners can supply a search. A restored/deep-linked route never
// recovers another account's results or callbacks from persistent storage.
const sessions = new Map<string, NativeSearchSession>();
const listeners = new Set<() => void>();
const afterClose = new Map<string, { ownerKey: string; actions: (() => void)[] }>();
let nextSession = 0;
const emit = () => [...listeners].forEach((listener) => listener());

export function subscribeNativeSearch(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getNativeSearch(id: string) {
  return sessions.get(id) ?? null;
}

export function createNativeSearch(
  ownerKey: string,
  contextKey: string,
  onDismiss: () => void,
  canDismiss: () => boolean = () => true,
) {
  const id = `search-${++nextSession}`;
  sessions.set(id, {
    id,
    ownerKey,
    contextKey,
    onDismiss,
    canDismiss,
    content: null,
    busy: false,
    closing: false,
  });
  return id;
}

export function publishNativeSearch(id: string, content: ReactNode, busy: boolean) {
  const session = sessions.get(id);
  if (!session || session.closing) return;
  sessions.set(id, { ...session, content, busy });
  emit();
}

/** Native Back, swipe and the visible chevron all close the same opening once. */
export function closeNativeSearch(id: string, force = false, invalidate = false) {
  const session = sessions.get(id);
  if (!session || (!force && (session.busy || !session.canDismiss()))) return;
  if (session.closing) {
    if (invalidate && session.content !== null) {
      sessions.set(id, { ...session, content: null });
      emit();
    }
    return;
  }
  sessions.set(id, {
    ...session,
    closing: true,
    busy: false,
    content: invalidate ? null : session.content,
  });
  emit();
  session.onDismiss();
}

/** An old route's cleanup cannot dismiss a subsequently reopened search. */
export function removeNativeSearch(id: string) {
  const session = sessions.get(id);
  if (!session) return;
  sessions.delete(id);
  emit();
  if (!session.closing) session.onDismiss();
}

/** Queue navigation/another sheet until the owner's native entrance completes. */
export function afterNativeSearchClosed(contextKey: string, action: () => void): boolean {
  const session = [...sessions.values()].reverse().find((item) => item.contextKey === contextKey);
  if (!session) return false;
  const pending = afterClose.get(session.id) ?? { ownerKey: session.ownerKey, actions: [] };
  pending.actions.push(action);
  afterClose.set(session.id, pending);
  return true;
}

export function completeNativeSearchClose(ownerKey: string) {
  const pending = [...afterClose.entries()].filter(([, item]) => item.ownerKey === ownerKey);
  pending.forEach(([id]) => afterClose.delete(id));
  pending.forEach(([, item]) => item.actions.forEach((action) => action()));
}

export function cancelNativeSearchClose(ownerKey: string) {
  for (const [id, pending] of afterClose) {
    if (pending.ownerKey === ownerKey) afterClose.delete(id);
  }
}

/** A targeted removal keeps any destination already opened above search. */
export function nativeSearchPopAction(stackKey: string, routeKey: string) {
  return { type: "POP", target: stackKey, source: routeKey, payload: { count: 1 } };
}
