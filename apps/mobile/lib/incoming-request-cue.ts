import { AppState } from "react-native";
import { playForegroundNotificationCue } from "./foreground-notification-cue";
import { claimNotificationDelivery } from "./notification-delivery";
import { notificationEventKey, notifyNotificationInboxChanged } from "./notification-events";
import { getSessionAccountIdSync } from "./db-tx";
import { notificationAllowed } from "./notification-policy";
import {
  notificationOwnerScope,
  notificationPolicyForContact,
  notificationPreferencesRevision,
} from "./notification-preferences";

export type IncomingRequestSnapshot = { ids: ReadonlySet<string>; newestAt: number };
type IncomingRequest = { id: string; created_at_ms?: number; invited_at?: number; read?: boolean };
const createdAt = (row: IncomingRequest) => row.created_at_ms ?? row.invited_at ?? 0;

/** Compare successful, continuous foreground polls. The first read on a
 * screen or after resume establishes the baseline without replaying old notices. */
export function observeIncomingRequests(
  previous: IncomingRequestSnapshot | null,
  rows: readonly IncomingRequest[],
  kind: "friend_request" | "connection_result" | "people_request" | "vault_member_request",
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
    (row) => !row.read && !previous.ids.has(row.id) && createdAt(row) >= previous.newestAt,
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
    .then(async (policy) => {
      const allowed = () => current() && notificationAllowed(policy, kind);
      if (allowed()) {
        const eventKind =
          kind === "friend_request"
            ? "friend_requested"
            : kind === "people_request"
              ? "shared_invite_requested"
              : kind === "vault_member_request"
                ? "vault_invite_requested"
                : kind;
        const key =
          notificationEventKey(owner, { kind: eventKind, source_id: fresh.id }) ??
          `${owner}:${kind}:${fresh.id}`;
        const account = getSessionAccountIdSync();
        if (account && policy.foreground) {
          // The app-wide observer owns banner delivery (and its Expo Go /
          // permission-denied cue fallback). Do not steal its receipt here.
          notifyNotificationInboxChanged(account, "local");
          return;
        }
        if (account && (await claimNotificationDelivery(account, key, allowed)))
          playForegroundNotificationCue(policy, allowed, key);
      }
    })
    .catch(() => undefined);
  return next;
}
