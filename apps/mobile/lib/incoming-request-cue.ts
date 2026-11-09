import { AppState } from "react-native";
import { playForegroundNotificationCue } from "./foreground-notification-cue";
import { notificationAllowed } from "./notification-policy";
import {
  notificationOwnerScope,
  notificationPolicyForContact,
  notificationPreferencesRevision,
} from "./notification-preferences";

export type IncomingRequestSnapshot = { ids: ReadonlySet<string>; newestAt: number };
type IncomingRequest = { id: string; created_at_ms?: number; invited_at?: number };
const createdAt = (row: IncomingRequest) => row.created_at_ms ?? row.invited_at ?? 0;

/** Compare successful, continuous foreground polls. The first read on a
 * screen or after resume establishes the baseline without replaying old requests. */
export function observeIncomingRequests(
  previous: IncomingRequestSnapshot | null,
  rows: readonly IncomingRequest[],
  kind: "friend_request" | "people_request" | "vault_member_request",
  isCurrent: () => boolean,
): IncomingRequestSnapshot | null {
  if (AppState.currentState !== "active" || !isCurrent()) return null;
  const next = {
    ids: new Set(rows.map((row) => row.id)),
    newestAt: rows.reduce(
      (newest, row) => Math.max(newest, createdAt(row)),
      previous?.newestAt ?? 0,
    ),
  };
  if (!previous) return next;
  // Removing a request can reveal an older one in a capped inbox response.
  const fresh = rows.find(
    (row) => !previous.ids.has(row.id) && createdAt(row) >= previous.newestAt,
  );
  if (!fresh) return next;

  const owner = notificationOwnerScope();
  const revision = notificationPreferencesRevision();
  const current = () =>
    AppState.currentState === "active" &&
    isCurrent() &&
    notificationOwnerScope() === owner &&
    notificationPreferencesRevision() === revision;
  void notificationPolicyForContact()
    .then((policy) => {
      const allowed = () => current() && notificationAllowed(policy, kind);
      if (allowed()) {
        playForegroundNotificationCue(policy, allowed, `${owner}:${kind}:${fresh.id}`);
      }
    })
    .catch(() => undefined);
  return next;
}
