import { randomUUID } from "expo-crypto";

type ReminderContext = {
  reminderId: string;
  personId: string;
  vaultId: string;
  ownerScope: string;
  fingerprint?: string;
};
type PendingPing = ReminderContext & { expiresAt: number };
const pending = new Map<string, PendingPing>();
const seen = new Set<string>();
const MAX_PENDING = 32;
const MAX_SEEN = 128;
const INTENT_LIFETIME_MS = 10 * 60 * 1000;

/** Native notification routing creates these after resolving private state.
 * A URL/route flag alone never authorizes automatically preparing a statement. */
export function queueReminderPing(
  action: ReminderContext & { notificationKey: string },
): string | null {
  if (!action.notificationKey || seen.has(action.notificationKey)) return null;
  seen.add(action.notificationKey);
  while (seen.size > MAX_SEEN) seen.delete(seen.values().next().value!);
  for (const [key, ping] of pending) if (ping.expiresAt <= Date.now()) pending.delete(key);
  while (pending.size >= MAX_PENDING) pending.delete(pending.keys().next().value!);
  const key = randomUUID();
  pending.set(key, { ...action, expiresAt: Date.now() + INTENT_LIFETIME_MS });
  return key;
}

export function hasReminderPing(key: string, context: ReminderContext): boolean {
  const ping = pending.get(key);
  if (!ping) return false;
  if (ping.expiresAt <= Date.now()) {
    pending.delete(key);
    return false;
  }
  return (
    ping.reminderId === context.reminderId &&
    ping.personId === context.personId &&
    ping.vaultId === context.vaultId &&
    ping.ownerScope === context.ownerScope
  );
}

/** Claim before starting native UI; a completion, repaint or return from
 * WhatsApp cannot prepare a second draft for the same notification tap. */
export function consumeReminderPing(key: string, context: ReminderContext): boolean {
  if (!hasReminderPing(key, context)) return false;
  const ping = pending.get(key)!;
  if (ping.fingerprint != null && ping.fingerprint !== context.fingerprint) {
    pending.delete(key);
    return false;
  }
  pending.delete(key);
  return true;
}

export function discardReminderPing(key: string | undefined): void {
  if (key) pending.delete(key);
}
